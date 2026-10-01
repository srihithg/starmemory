import type { ConversationExchange, Harness, ParsedExchange } from './types.js';
export declare const QUIET_MS: number;
export declare const DEFAULT_SUMMARY_LIMIT = 10;
export declare const SUMMARY_DISPLAY_MAX_CHARS = 300;
export declare const ERROR_PREFIX = "[error]";
export type SummaryState = {
    kind: 'missing';
} | {
    kind: 'empty';
} | {
    kind: 'error';
    message: string;
} | {
    kind: 'valid';
    text: string;
};
export declare function readSummaryState(summaryPath: string): SummaryState;
/** An empty `text` writes the empty sentinel: nothing here to summarise, do not ask again. */
export declare function writeSummary(summaryPath: string, text: string): void;
/** Retried on the next sync; the reason is kept so a person can see why. */
export declare function writeErrorSentinel(summaryPath: string, error: unknown): void;
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
export declare function selectForSummary(candidates: SummaryCandidate[], { now, quietMs, limit }?: {
    now?: number;
    quietMs?: number;
    limit?: number;
}): SummaryCandidate[];
/** The conversation as the text a summary is written from: what the person
 * typed and what the assistant wrote, and nothing a tool took in or gave back.
 * The parser keeps only text blocks, so tool calls and their results are out
 * already. Left out here are a user turn the harness injected (a task's
 * result, a command's output) and a subagent's turns, whose prompt and work
 * are a tool's input and output. Secrets are redacted (redact.ts). Over
 * `maxChars`, keep the opening and the ending: how it started and how it
 * ended is what a summary needs most. */
export declare function transcriptText(exchanges: ParsedExchange[], maxChars?: number): string;
/** Asks for the summary inside <summary></summary>. A model handed a
 * conversation tends to answer it in character ("I'm ready to help. What
 * next?") rather than summarise it; the tags are how we tell a summary from
 * chatter, see extractSummary. */
export declare const SUMMARY_PROMPT: string;
/** The text inside the first <summary> block, or undefined when there is none,
 * in which case the summarizers take the raw reply. */
export declare function extractSummary(reply: string): string | undefined;
/** What the search result shows: a valid summary short enough to sit above the
 * snippet. Rows from before the archive point at the source file, so look the
 * summary up through the archive layout, not the stored path. */
export declare function summaryFor(exchange: ConversationExchange, archiveRoot: string): string | undefined;
/** Each is handed the conversation as text (transcriptText) and nothing more.
 * `sessionId` and `threadId` say which conversation it is, for the caller's
 * own bookkeeping: the summarizers starmemory uses never resume or fork it. */
export interface Summarizers {
    claude: (input: {
        sessionId?: string;
        transcript: string;
    }) => Promise<string>;
    codex: (input: {
        threadId?: string;
        transcript: string;
    }) => Promise<string>;
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
export declare function summarizeQuietConversations(candidates: SummaryCandidate[], opts?: SummaryOptions): Promise<SummaryRunResult>;
