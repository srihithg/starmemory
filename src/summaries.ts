// Summaries: a few sentences beside each archived conversation, for a person
// deciding whether to open it. Never indexed. Written only once a conversation
// has been quiet for QUIET_MS, so a session that runs for days is summarised
// whole rather than after its first two turns. Design doc archive-and-summaries §04.
import fs from 'node:fs';
import path from 'node:path';
import { archivePathFor, summaryPathFor } from './archive.js';
import { OWNER_ONLY_DIR, OWNER_ONLY_FILE } from './owner-only.js';
import { parseConversation } from './parser.js';
import { redactSecrets } from './redact.js';
import type { ConversationExchange, Harness, ParsedExchange } from './types.js';

export const QUIET_MS = 2 * 60 * 60 * 1000;
export const DEFAULT_SUMMARY_LIMIT = 10;
export const SUMMARY_DISPLAY_MAX_CHARS = 300;
export const ERROR_PREFIX = '[error]';

export type SummaryState =
  | { kind: 'missing' }
  | { kind: 'empty' }
  | { kind: 'error'; message: string }
  | { kind: 'valid'; text: string };

export function readSummaryState(summaryPath: string): SummaryState {
  let raw: string;
  try {
    raw = fs.readFileSync(summaryPath, 'utf8');
  } catch {
    return { kind: 'missing' };
  }
  const text = raw.trim();
  if (text === '') return { kind: 'empty' };
  if (text.startsWith(ERROR_PREFIX)) return { kind: 'error', message: text.slice(ERROR_PREFIX.length).trim() };
  return { kind: 'valid', text };
}

/** An empty `text` writes the empty sentinel: nothing here to summarise, do not ask again. */
export function writeSummary(summaryPath: string, text: string): void {
  fs.mkdirSync(path.dirname(summaryPath), { recursive: true, mode: OWNER_ONLY_DIR });
  const trimmed = text.trim();
  fs.writeFileSync(summaryPath, trimmed === '' ? '' : `${trimmed}\n`, { encoding: 'utf8', mode: OWNER_ONLY_FILE });
}

/** Retried on the next sync; the reason is kept so a person can see why. */
export function writeErrorSentinel(summaryPath: string, error: unknown): void {
  fs.mkdirSync(path.dirname(summaryPath), { recursive: true, mode: OWNER_ONLY_DIR });
  const message = error instanceof Error ? error.message : String(error);
  fs.writeFileSync(summaryPath, `${ERROR_PREFIX} ${message.split('\n')[0]}\n`, { encoding: 'utf8', mode: OWNER_ONLY_FILE });
}

export interface SummaryCandidate {
  archivePath: string;
  harness: Harness;
  project: string;
  sessionId?: string;
  /** Every id the transcript goes by (its file name, the ids its lines
   * record), for `skip`: one with no whole exchange has no sessionId. */
  sessions?: string[];
  sourceMtimeMs: number;
}

/** Quiet for long enough, not yet summarised (or the last try failed), newest
 * first, at most `limit`. Never a Cowork record: the model wrote it as a
 * summary already, and there is no session to resume, so summarising it again
 * would be a model call that says less than the record. */
export function selectForSummary(
  candidates: SummaryCandidate[],
  { now = Date.now(), quietMs = QUIET_MS, limit = DEFAULT_SUMMARY_LIMIT }: { now?: number; quietMs?: number; limit?: number } = {}
): SummaryCandidate[] {
  if (limit <= 0) return [];
  return candidates
    .filter((c) => c.harness !== 'cowork')
    .filter((c) => c.sourceMtimeMs <= now - quietMs)
    .filter((c) => {
      const state = readSummaryState(summaryPathFor(c.archivePath)).kind;
      return state === 'missing' || state === 'error';
    })
    .sort((a, b) => b.sourceMtimeMs - a.sourceMtimeMs)
    .slice(0, limit);
}

/** How far past each cut transcriptText redacts, so that a secret the cut
 * runs through is seen whole. Longer than any key or token it looks for. */
const REDACT_MARGIN_CHARS = 8_000;

/** The conversation as the text a summary is written from: what the person
 * typed and what the assistant wrote, and nothing a tool took in or gave back.
 * The parser keeps only text blocks, so tool calls and their results are out
 * already. Left out here are a user turn the harness injected (a task's
 * result, a command's output) and a subagent's turns, whose prompt and work
 * are a tool's input and output. Secrets are redacted (redact.ts). Over
 * `maxChars`, keep the opening and the ending: how it started and how it
 * ended is what a summary needs most. */
export function transcriptText(exchanges: ParsedExchange[], maxChars = 24_000): string {
  const full = exchanges
    .filter((e) => !e.isSidechain)
    .map((e) => (e.userIsInjected ? `Assistant: ${e.assistantMessage}` : `User: ${e.userMessage}\nAssistant: ${e.assistantMessage}`))
    .join('\n\n');
  if (full.length <= maxChars) {
    const redacted = redactSecrets(full);
    if (redacted.length <= maxChars) return redacted;
  }
  const half = Math.floor(maxChars / 2);
  const head = redactSecrets(full.slice(0, half + REDACT_MARGIN_CHARS)).slice(0, half);
  const tail = redactSecrets(full.slice(Math.max(0, full.length - half - REDACT_MARGIN_CHARS))).slice(-half);
  return `${head}\n[…]\n${tail}`;
}

/** Asks for the summary inside <summary></summary>. A model handed a
 * conversation tends to answer it in character ("I'm ready to help. What
 * next?") rather than summarise it; the tags are how we tell a summary from
 * chatter, see extractSummary. */
export const SUMMARY_PROMPT =
  'Stop working on the task. Write a summary of this whole conversation for someone deciding whether to open it: ' +
  'two or three sentences, third person, plain language, saying what problem the user was working on and what was concluded or built. ' +
  'No preamble, no bullet points, no questions back. Output only the summary, wrapped exactly like this: <summary>...</summary>';

/** The text inside the first <summary> block, or undefined when there is none,
 * in which case the summarizers take the raw reply. */
export function extractSummary(reply: string): string | undefined {
  const m = reply.match(/<summary>([\s\S]*?)<\/summary>/i);
  const text = m?.[1].trim();
  return text ? text : undefined;
}

/** What the search result shows: a valid summary short enough to sit above the
 * snippet. Rows from before the archive point at the source file, so look the
 * summary up through the archive layout, not the stored path. */
export function summaryFor(exchange: ConversationExchange, archiveRoot: string): string | undefined {
  const copy = archivePathFor(archiveRoot, exchange.harness ?? 'claude', exchange.project, exchange.archivePath);
  const state = readSummaryState(summaryPathFor(copy));
  if (state.kind !== 'valid' || state.text.length >= SUMMARY_DISPLAY_MAX_CHARS) return undefined;
  return state.text;
}

// ---------------------------------------------------------------------------
// The step sync runs: pick, summarise through the harness the conversation came
// from, write the file or a sentinel.
// ---------------------------------------------------------------------------

/** Each is handed the conversation as text (transcriptText) and nothing more.
 * `sessionId` and `threadId` say which conversation it is, for the caller's
 * own bookkeeping: the summarizers starmemory uses never resume or fork it. */
export interface Summarizers {
  claude: (input: { sessionId?: string; transcript: string }) => Promise<string>;
  codex: (input: { threadId?: string; transcript: string }) => Promise<string>;
}

export interface SummaryOptions {
  limit?: number;
  now?: number;
  quietMs?: number;
  /** Injected by tests; the defaults are the real Agent SDK and codex app-server clients. */
  summarizers?: Summarizers;
  log?: (line: string) => void;
  /** Asked just before each summary: a conversation to leave alone after all,
   * such as one the user asked to forget since it was picked. */
  skip?: (candidate: SummaryCandidate) => boolean;
}

export interface SummaryRunResult {
  attempted: number;
  written: number;
  failed: number;
}

function defaultSummarizers(): Summarizers {
  // Dynamic imports keep the Agent SDK out of the MCP server's start-up path;
  // only sync ever summarises.
  return {
    claude: async ({ transcript }) => (await import('./summarizer-claude.js')).summarizeWithClaude({ transcript }),
    codex: async ({ transcript }) => (await import('./summarizer-codex.js')).summarizeWithCodex({ transcript }),
  };
}

export async function summarizeQuietConversations(
  candidates: SummaryCandidate[],
  opts: SummaryOptions = {}
): Promise<SummaryRunResult> {
  const summarizers = opts.summarizers ?? defaultSummarizers();
  const log = opts.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  const picked = selectForSummary(candidates, { now: opts.now, quietMs: opts.quietMs, limit: opts.limit });
  const result: SummaryRunResult = { attempted: picked.length, written: 0, failed: 0 };
  for (const c of picked) {
    if (opts.skip?.(c)) {
      result.attempted--;
      continue;
    }
    const summaryPath = summaryPathFor(c.archivePath);
    try {
      const exchanges = await parseConversation(c.archivePath, c.project, c.archivePath);
      if (exchanges.length === 0) {
        if (opts.skip?.(c)) continue;
        writeSummary(summaryPath, '');
        result.written++;
        continue;
      }
      const transcript = transcriptText(exchanges);
      // Nothing but turns transcriptText leaves out, a subagent's for one.
      if (transcript === '') {
        if (opts.skip?.(c)) continue;
        writeSummary(summaryPath, '');
        result.written++;
        continue;
      }
      const text =
        c.harness === 'codex'
          ? await summarizers.codex({ threadId: c.sessionId, transcript })
          : await summarizers.claude({ sessionId: c.sessionId, transcript });
      // Asked again: the model call takes a while, and a session forgotten in
      // the meantime must not get its summary written after all.
      if (opts.skip?.(c)) continue;
      writeSummary(summaryPath, text);
      result.written++;
    } catch (error) {
      // Forgotten while it was being read, its copy removed under it: there is
      // nothing to retry, and a sentinel would outlive the forget.
      if (opts.skip?.(c) || !fs.existsSync(c.archivePath)) continue;
      writeErrorSentinel(summaryPath, error);
      result.failed++;
      log(`starmemory: summary failed for ${c.archivePath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return result;
}
