// Forgetting a session, when the user asks in any words: "don't record this",
// "keep this off the record", "forget this conversation".
//
// The list of forgotten sessions is what everything goes by: `remember` refuses
// a session on it, `search` and `read` leave it out from that moment, and every
// sync deletes what is left of it (rows and vectors, text-index documents,
// archive copy, summary) and never indexes it again. Not all of it can go in
// the MCP server that took the request: removing text-index documents needs
// the index writer, which only a short-lived sync may hold (sync-trigger.ts).
// So `forget` puts the session on the list, removes what are plain files at
// once (the Cowork record, the archive copies, the summaries), and the caller
// starts a sync for the rows.
//
// A Claude Code or Codex session is forgotten the same way. Its transcript
// belongs to that harness and stays where it is; starmemory stops reading it.
//
// A server that serves Cowork records only (cowork.ts, Scope) takes a forget
// from a caller that may have been steered, so it refuses a Claude Code or
// Codex session, and sets a Cowork record aside for a few days rather than
// deleting it, so that a forget the user never asked for can be undone.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { archivePathFor, summaryPathFor } from './archive.js';
import {
  RefusedError,
  countEntries,
  deleteRecords,
  findRecords,
  findSetAside,
  quarantineRecord,
  sessionKeyProblem,
  setAsideExpiry,
  type Quarantine,
  type SetAside,
} from './cowork.js';
import { projectFromPath, sessionsOfName, walkJsonlFiles } from './parser.js';
import { exchangesFrom, syncCursorKey, type StoreHandle } from './store.js';
import type { TextIndex } from './text-index.js';
import { groupByFile, removeConversations, type RemoveResult } from './ttl.js';
import { HARNESSES, type ConversationExchange, type Harness } from './types.js';

/** STARMEMORY_FORGOTTEN_PATH, else ~/.config/starmemory/forgotten.txt. */
export function defaultForgottenPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.STARMEMORY_FORGOTTEN_PATH ?? path.join(os.homedir(), '.config', 'starmemory', 'forgotten.txt');
}

const HEADER =
  '# Sessions starmemory was asked to forget, one key per line. They are deleted from the memory and never indexed again.\n' +
  '# Deleting a line lets that session be indexed again from where it stopped, including what was written while it was forgotten.\n' +
  '# What the forget deleted stays deleted; the archive copy is made again from the transcript.\n';

/** Every forgotten session key. A missing file is an empty list. */
export function readForgotten(file: string): Set<string> {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return new Set();
  }
  return new Set(
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line !== '' && !line.startsWith('#'))
  );
}

/** Appended, never rewritten: a short O_APPEND write lands whole, so two
 * processes forgetting at the same moment cannot lose each other's line. A
 * file edited by hand can end without a newline, and appending straight onto
 * its last line would fuse two keys into one that matches neither, so the key
 * then starts on a line of its own. */
export function addForgotten(file: string, session: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const fd = fs.openSync(file, 'a+');
  try {
    const { size } = fs.fstatSync(fd);
    let lead = size === 0 ? HEADER : '';
    if (size > 0) {
      const last = Buffer.alloc(1);
      fs.readSync(fd, last, 0, 1, size - 1);
      if (last[0] !== 0x0a) lead = '\n';
    }
    fs.writeSync(fd, `${lead}${session}\n`);
  } finally {
    fs.closeSync(fd);
  }
}

/** Whether any of `sessions` is on the forgotten list: the one test that
 * search, read, the summaries and the sync's archiving, indexing and
 * deleting all go by. A row is judged by its own session and its file's name
 * (rowSessions), since a transcript named after one session can carry lines
 * of the session it was resumed from. A transcript or a copy, whose whole
 * text is what gets copied, summarised or read, is judged by its name and
 * every session its lines record (parser.ts, sessionIdsOf): a file holding a
 * forgotten session's turns is not shown, while another session's rows from
 * it are kept. */
export function isForgotten(sessions: Iterable<string | undefined>, list: ReadonlySet<string>): boolean {
  for (const session of sessions) if (session !== undefined && list.has(session)) return true;
  return false;
}

/** The sessions a stored row belongs to, for isForgotten. */
export function rowSessions(row: Pick<ConversationExchange, 'sessionId' | 'archivePath'>): (string | undefined)[] {
  return [row.sessionId, ...sessionsOfName(row.archivePath)];
}

/** Every stored row that belongs to a session on `list` (rowSessions). The
 * store indexes rows by session id but not by file, so this walks the rows,
 * and only when the list is not empty. */
export function forgottenRows(store: StoreHandle, list: ReadonlySet<string>): ConversationExchange[] {
  if (list.size === 0) return [];
  return exchangesFrom(store, 0).filter((row) => isForgotten(rowSessions(row), list));
}

export interface ForgetResult {
  session: string;
  /** Cowork record files removed at once, or set aside. */
  records: string[];
  /** Entries those records held. */
  entries: number;
  /** Where each record was set aside, when it was (see ForgetOptions.quarantine),
   * and until when. */
  setAside: SetAside[];
  /** How long a set-aside record is kept before a sync deletes it. */
  setAsideDays: number;
  /** Records that could not be set aside, and why. Hidden all the same, and
   * left where they are for the next sync to set aside (sync.ts). */
  notSetAside?: { records: string[]; reason: string };
  /** Records of this session an earlier forget set aside: where each is, the
   * record it was, when a sync may delete it where its name says, and whether
   * this forget deleted them (ForgetOptions.quarantineRoot). */
  earlier: { records: { from: string; to: string; expiresAt?: number }[]; entries: number; removed: boolean };
  /** The list the session was put on. */
  forgottenPath: string;
  /** Archive copies removed at once, with their summaries. */
  copies: string[];
  /** Exchanges still in the store: hidden from search from now on, deleted by
   * the next sync. */
  pendingRows: number;
  /** Which harnesses those exchanges came from. */
  pendingHarnesses: Harness[];
  /** The session was on the list already. */
  alreadyForgotten: boolean;
}

function listDir(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

/** Archive copies of `session` found by their names, for the ones no row
 * points at: a copy taken before the conversation had a whole exchange, whose
 * source may be gone. A copy is named after its transcript, so it counts
 * when its name says the session (parser.ts, sessionsOfName), as sync and
 * the rows go by: the whole name, or for a Codex rollout the id it ends in. */
function copiesByName(archiveRoot: string, session: string, harnesses: readonly Harness[] = HARNESSES): string[] {
  const key = new Set([session]);
  const found: string[] = [];
  for (const harness of harnesses) {
    const harnessDir = path.join(archiveRoot, harness);
    for (const project of listDir(harnessDir)) {
      const dir = path.join(harnessDir, project);
      for (const name of listDir(dir)) {
        if (name.endsWith('.jsonl.gz') && isForgotten(sessionsOfName(name), key)) found.push(path.join(dir, name));
      }
    }
  }
  return found;
}

/** An archive copy and its summary. True when there was a copy. */
function removeCopy(copy: string): boolean {
  const existed = fs.existsSync(copy);
  for (const file of [copy, summaryPathFor(copy)]) fs.rmSync(file, { force: true });
  return existed;
}

/** Where Claude Code and Codex keep their transcripts (sync.ts,
 * harnessTranscriptDirs). */
export interface HarnessDirs {
  claude: string;
  codex: string;
}

/** Whether `session` is one Claude Code or Codex keeps: rows of theirs in the
 * store, an archive copy under their harness, or their transcript of it,
 * matched by name as the archive copies are. Any transcript under their
 * folders counts, at any depth: sync forgets a transcript by what its file
 * name says (isForgotten), so a key naming a Codex rollout or a subagent's
 * agent-<id>.jsonl would otherwise forget it. A Claude Code session's
 * subagents are in a <project>/<session>/ folder, which counts too. */
function heldByAnotherHarness(
  session: string,
  { rows, archiveRoot, coworkRoot, dirs }: { rows: ConversationExchange[]; archiveRoot: string; coworkRoot: string; dirs: HarnessDirs }
): boolean {
  if (rows.some((row) => (row.harness ?? 'claude') !== 'cowork')) return true;
  if (copiesByName(archiveRoot, session, ['claude', 'codex']).length > 0) return true;
  for (const project of listDir(dirs.claude)) {
    if (fs.existsSync(path.join(dirs.claude, project, session))) return true;
  }
  const key = new Set([session]);
  for (const dir of [dirs.claude, dirs.codex]) {
    for (const file of walkJsonlFiles(dir, coworkRoot)) if (isForgotten(sessionsOfName(file), key)) return true;
  }
  return false;
}

export interface ForgetOptions {
  coworkRoot: string;
  forgottenPath: string;
  archiveRoot: string;
  store?: StoreHandle;
  /** Given on a server that serves Cowork records only: a session Claude Code
   * or Codex keeps is refused, and nothing is changed. */
  coworkOnly?: { dirs: HarnessDirs };
  /** Where a Cowork record is set aside instead of deleted, and for how many
   * days. Without it, or at 0 days, the record is deleted at once. What an
   * earlier forget set aside there stays for its time. */
  quarantine?: Quarantine;
  /** Given without `quarantine`, by a server that deletes what it forgets:
   * the quarantine, whose records of this session an earlier forget from
   * Cowork set aside. They are deleted with the rest. */
  quarantineRoot?: string;
  now?: Date;
}

/** Forget `session`: put it on the list, then remove its Cowork record, or set
 * it aside, and remove the archive copies and summaries kept of it. The caller
 * starts a sync, which deletes the rest. Throws RefusedError, changing nothing,
 * for a key that could not name a session, or on a Cowork-only server for a
 * Claude Code or Codex session. A key with nothing stored under it yet is
 * listed all the same, so remember refuses it from the first entry. A record
 * that cannot be set aside is reported (notSetAside), not thrown: the session
 * is listed by then. */
export function forget(
  session: string,
  { coworkRoot, forgottenPath, archiveRoot, store, coworkOnly, quarantine, quarantineRoot, now = new Date() }: ForgetOptions
): ForgetResult {
  const problem = sessionKeyProblem(session);
  if (problem) throw new RefusedError(problem);
  const rows = store ? forgottenRows(store, new Set([session])) : [];
  if (coworkOnly && heldByAnotherHarness(session, { rows, archiveRoot, coworkRoot, dirs: coworkOnly.dirs })) {
    throw new RefusedError(
      `Nothing was changed: ${session} is a Claude Code or Codex session on this computer, and this server serves Cowork records only, ` +
        'so it does not forget other sessions. The user can forget it from a Claude Code or Codex session on this computer.'
    );
  }
  // The list first. From that moment remember refuses the session and search
  // hides it, even if what follows fails, and a remember racing in another
  // process removes its own write (cowork.ts).
  const alreadyForgotten = readForgotten(forgottenPath).has(session);
  if (!alreadyForgotten) addForgotten(forgottenPath, session);
  const setAsideDays = quarantine?.days ?? 0;
  // Looked for before this forget sets anything aside.
  const earlierRoot = quarantine?.root ?? quarantineRoot;
  const earlierFiles = earlierRoot === undefined ? [] : findSetAside(earlierRoot, session);
  let files: string[];
  let entries = 0;
  const setAside: SetAside[] = [];
  let notSetAside: ForgetResult['notSetAside'];
  if (quarantine && setAsideDays > 0) {
    // The cursor stays. Brought back before the sync has deleted its rows, the
    // record is the same file, and the cursor is what keeps its entries from
    // being stored twice; the sync that deletes the rows removes it with them
    // (forgetSessions).
    files = findRecords(coworkRoot, session);
    for (const from of files) {
      try {
        const moved = quarantineRecord(from, quarantine, now);
        setAside.push(moved);
        // Counted once moved: a remember that had the record open may have
        // added one on the way.
        entries += countEntries(moved.to);
      } catch (error) {
        entries += countEntries(from);
        // Hidden all the same, since the session is listed; the next sync
        // finds it in the records folder and sets it aside (sync.ts).
        const reason = notSetAside?.reason ?? (error instanceof Error ? error.message : String(error));
        notSetAside = { records: [...(notSetAside?.records ?? []), from], reason };
      }
    }
  } else {
    ({ files, entries } = deleteRecords(coworkRoot, session));
    // A record started later under this key counts its lines from 1 again, and
    // the old cursor would skip them.
    for (const file of files) store?.meta.remove(syncCursorKey(file));
  }
  // A server that sets records aside leaves an earlier forget's for their
  // time; one that deletes what it forgets deletes them too.
  const earlier = {
    records: earlierFiles.map((to) => ({
      from: path.join(coworkRoot, path.basename(path.dirname(to)), `${session}.jsonl`),
      to,
      expiresAt: setAsideExpiry(path.basename(to)),
    })),
    entries: earlierFiles.reduce((sum, file) => sum + countEntries(file), 0),
    removed: !quarantine && earlierFiles.length > 0,
  };
  if (earlier.removed) {
    for (const { from, to } of earlier.records) {
      fs.rmSync(to, { force: true });
      store?.meta.remove(syncCursorKey(from));
    }
  }
  // Plain files need no index writer, and a copy holds the whole conversation,
  // so they go now rather than with the rows. Found through the rows, the
  // record and the names in the archive, since a copy taken before a whole
  // exchange was written has no row.
  const copies = new Set([
    ...files.map((file) => archivePathFor(archiveRoot, 'cowork', projectFromPath(file), file)),
    ...groupByFile(rows).map((g) => archivePathFor(archiveRoot, g.harness, g.project, g.archivePath)),
    ...copiesByName(archiveRoot, session),
  ]);
  return {
    session,
    records: files,
    entries,
    setAside,
    setAsideDays,
    ...(notSetAside ? { notSetAside } : {}),
    earlier,
    forgottenPath,
    copies: [...copies].filter(removeCopy),
    pendingRows: rows.length,
    pendingHarnesses: [...new Set(rows.map((r) => r.harness ?? 'claude'))],
    alreadyForgotten,
  };
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const utc = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

/** What the model is told, to pass on to the user in a sentence. */
export function describeForget(result: ForgetResult): string {
  const lines = [`Forgot session ${result.session}.`];
  const setAside = result.setAside.length > 0;
  if (setAside) {
    const until = utc(Math.min(...result.setAside.map((m) => m.expiresAt)));
    lines.push(
      `Set aside now: its Cowork record, ${plural(result.entries, 'entry', 'entries')}. It is hidden from search and read from this moment, ` +
        `and kept for ${plural(result.setAsideDays, 'day', 'days')}, until ${until} (${result.setAside.map((m) => m.to).join(', ')}), ` +
        'so that a forget the user did not mean can be undone. After that a sync deletes it for good.'
    );
    lines.push(
      `To undo it before then: delete the line ${result.session} from ${result.forgottenPath}, then move ` +
        `${result.setAside.map((m) => `${m.to} back to ${m.from}`).join(', and ')}.`
    );
  }
  const notSetAside = result.notSetAside;
  if (notSetAside) {
    lines.push(
      `Hidden now: its Cowork record (${notSetAside.records.join(', ')}) is hidden from search and read from this moment, ` +
        `but it could not be set aside yet: ${notSetAside.reason}. It stays where it is until the next sync, which tries again to set it aside.`
    );
    lines.push(`To undo it: delete the line ${result.session} from ${result.forgottenPath}.`);
  }
  const { earlier } = result;
  if (earlier.records.length > 0 && !earlier.removed) {
    const until = earlier.records.map((m) => m.expiresAt).filter((at) => at !== undefined);
    lines.push(
      `Still set aside by an earlier forget: its Cowork record (${earlier.records.map((m) => m.to).join(', ')}), ` +
        (until.length > 0 ? `kept until ${utc(Math.min(...until))}, when a sync deletes it for good.` : 'until a sync deletes it for good.')
    );
    lines.push(
      `To undo it before then: delete the line ${result.session} from ${result.forgottenPath}, then move ` +
        `${earlier.records.map((m) => `${m.to} back to ${m.from}`).join(', and ')}.`
    );
  }
  const handled = result.setAside.length + (notSetAside?.records.length ?? 0);
  const removed = [
    ...(result.records.length > handled ? [`its Cowork record, ${plural(result.entries, 'entry', 'entries')} (${result.records.join(', ')})`] : []),
    ...(earlier.removed
      ? [`its Cowork record that an earlier forget set aside, ${plural(earlier.entries, 'entry', 'entries')} (${earlier.records.map((m) => m.to).join(', ')})`]
      : []),
    ...(result.copies.length > 0 ? [`the archive ${result.copies.length === 1 ? 'copy' : 'copies'} starmemory kept of it, with any summary`] : []),
  ];
  if (removed.length > 0) lines.push(`Removed now: ${removed.join('; ')}.`);
  if (result.pendingRows > 0) {
    lines.push(
      `Hidden from search from now on: ${plural(result.pendingRows, 'indexed exchange', 'indexed exchanges')}. ` +
        'A background sync deletes them and their text-index entries, usually within a minute, or when a sync that is already running finishes.'
    );
  }
  if (removed.length === 0 && result.pendingRows === 0 && handled === 0 && earlier.records.length === 0) {
    lines.push(
      result.alreadyForgotten
        ? 'It had been forgotten already; nothing of it is stored.'
        : 'Nothing was stored under this key. If you meant this session, check that the key is the one from the starmemory start-up line.'
    );
  }
  lines.push('It is not recorded or indexed again: remember refuses it and sync skips it.');
  if (result.pendingHarnesses.some((h) => h !== 'cowork')) {
    lines.push('Its Claude Code or Codex transcript stays where that harness keeps it; starmemory no longer reads it.');
  }
  return lines.join('\n');
}

/** The sync step: delete every stored conversation of a forgotten session, the
 * same way the TTL deletes an expired one and under the same text-writer rule
 * (ttl.ts, removeConversations). A Claude Code or Codex transcript keeps its
 * cursor, so nothing of it is indexed again, even if another sync was about
 * to. A Cowork record's cursor goes, whoever stored the rows: forget() removed
 * the record, and one started later under the key counts its lines from 1. */
export function forgetSessions(
  store: StoreHandle,
  textIndex: TextIndex | undefined,
  sessions: ReadonlySet<string>,
  { archiveRoot, coworkRoot, log }: { archiveRoot: string; coworkRoot?: string; log?: (line: string) => void }
): RemoveResult {
  const rows = forgottenRows(store, sessions);
  return removeConversations(store, textIndex, groupByFile(rows), {
    archiveRoot,
    log,
    describe: (g) => `forgot ${g.archivePath} (${g.ids.length} exchanges), as the user asked`,
    onRemoved: (g) => {
      if (g.harness !== 'cowork' || coworkRoot === undefined) return;
      const record = path.join(coworkRoot, g.project, path.basename(g.archivePath).replace(/\.gz$/, ''));
      store.meta.remove(syncCursorKey(record));
    },
  });
}
