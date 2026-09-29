// Cowork records. A Cowork session runs in a cloud container that is thrown
// away when the session ends, and its transcript never reaches this machine, so
// sync has nothing to find. The model writes the record instead, through the
// `remember` tool: at each milestone, what was asked and what was found,
// decided, built or left open, in its own words. Never the raw transcript: a
// later session wants the summary, and copying a session's transcript out of
// its container is not something Cowork allows.
//
// A record is a synthetic transcript, <root>/<project>/<session>.jsonl. Its
// first line marks it as Cowork (parser.ts tags the harness from it, on the
// source and on the gzipped archive copy alike). Each entry after that is one
// user line (asked) and one assistant line (title and found) in Claude Code's
// shape, so the Claude parser, the archive, the TTL and both indexes treat a
// record like any other transcript.
//
// The caller can be steered: a Cowork session runs in the cloud and may have
// read a page written to mislead it. So an entry is marked as the model's note
// wherever it is shown, and it is written with the harness's control tags
// escaped, so it cannot pass for the user's words or for something the
// harness injected.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { COWORK_RECORD_PROMPT_SOURCE, COWORK_SESSION_LINE_TYPE, INJECTED_TAG_START } from './parser.js';

/** STARMEMORY_COWORK_PATH, else ~/.config/starmemory/cowork, on the machine
 * whose Claude desktop app runs this server for Cowork. */
export function defaultCoworkRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env.STARMEMORY_COWORK_PATH ?? path.join(os.homedir(), '.config', 'starmemory', 'cowork');
}

/** What this server gives a caller. `all`, the default, is every harness's
 * sessions, as Claude Code and Codex use it. `cowork` is the Cowork records
 * alone: search and read see nothing else, and forget refuses a Claude Code or
 * Codex session. The Claude app's server runs as `cowork` unless the user opts
 * in (cli/desktop-launch.mjs). */
export type Scope = 'all' | 'cowork';

/** STARMEMORY_SCOPE. Unset is `all`; any value but `all` is `cowork`, so a
 * mistyped setting gives less away, not more. */
export function serverScope(env: NodeJS.ProcessEnv = process.env): Scope {
  return env.STARMEMORY_SCOPE === undefined || env.STARMEMORY_SCOPE === 'all' ? 'all' : 'cowork';
}

/** Upper bounds on one entry. A record is a summary: an entry longer than this
 * is a transcript being pasted in, which is exactly what it must not become. */
export const LIMITS = { title: 200, asked: 2000, found: 8000, project: 80 } as const;

/** A session key names the record's file, so it is held to what every
 * filesystem accepts. Anything else is refused rather than rewritten, so one
 * session can never quietly become two files. */
export const SESSION_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;

/** Names Windows keeps for devices, with or without an extension. */
const WINDOWS_DEVICE_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/** Why `session` cannot be a key, or undefined when it can. */
export function sessionKeyProblem(session: string): string | undefined {
  if (!SESSION_KEY_PATTERN.test(session)) {
    return `${JSON.stringify(session.slice(0, 40))} is not a usable session key: use 1-120 letters, digits, ".", "_" or "-", starting with a letter or digit.`;
  }
  if (WINDOWS_DEVICE_NAME.test(session)) return `${JSON.stringify(session)} is a reserved file name on Windows; pick another session key.`;
  return undefined;
}

export const DEFAULT_PROJECT = 'general';

/** The folder a project's records live in, which is also the project name that
 * search shows and filters on. Lowercased, and runs of anything but letters,
 * digits, ".", "_" and "-" become "-", so "StarRocks BE" and "starrocks-be"
 * are the same project from one session to the next. Letters of any script
 * are kept. */
export function projectSlug(project: string | undefined): string {
  const slug = (project ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}._-]+/gu, '-')
    .slice(0, LIMITS.project)
    .replace(/^[-.]+|[-.]+$/g, '');
  return slug === '' || WINDOWS_DEVICE_NAME.test(slug) ? DEFAULT_PROJECT : slug;
}

/** Every record of `session`, in a stable order. Normally one: a session
 * stays in the folder of the project it started under (see remember). */
export function findRecords(root: string, session: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(root, entry.name, `${session}.jsonl`))
    .filter((file) => fs.existsSync(file))
    .sort();
}

/** Entries in a record: one per user line. */
export function countEntries(file: string): number {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return 0;
  }
  let entries = 0;
  for (const line of text.split('\n')) {
    try {
      if ((JSON.parse(line) as { type?: string }).type === 'user') entries++;
    } catch {
      // blank line
    }
  }
  return entries;
}

export interface RememberInput {
  /** Stable for the whole session; names the record's file. */
  session: string;
  /** One line: what the session is about. */
  title: string;
  /** What the user asked, that this entry answers. */
  asked: string;
  /** What was found, decided, built or left open, with the exact strings. */
  found: string;
  /** Repo or subject; the same one across sessions about it. */
  project?: string;
}

export interface RememberResult {
  file: string;
  project: string;
  /** Entries in the record now, this one included. */
  entries: number;
  /** True when this entry started the record. */
  created: boolean;
  /** The project asked for, when the session is already recorded under another. */
  ignoredProject?: string;
}

/** Nothing was written. The message is meant for the model, so it says what to
 * do instead. */
export class RefusedError extends Error {}

export const DEFAULT_REMEMBER_DAILY_LIMIT = 300;

/** STARMEMORY_REMEMBER_DAILY_LIMIT, else 300. `0` refuses every entry; a
 * value that is not a whole number keeps the default. */
export function defaultRememberDailyLimit(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.STARMEMORY_REMEMBER_DAILY_LIMIT;
  const limit = Number(raw);
  return raw !== undefined && raw.trim() !== '' && Number.isInteger(limit) && limit >= 0 ? limit : DEFAULT_REMEMBER_DAILY_LIMIT;
}

/** How many entries one server process records per UTC day. The default is
 * far more than a day of sessions writes, and bounds how much a caller
 * steered into a loop can pile into the memory. Held in memory, so a restart
 * of the app starts the count again. */
export class DailyCap {
  private day = '';
  private used = 0;

  constructor(readonly limit: number) {}

  /** Throws RefusedError when today's entries are used up. */
  check(now: Date): void {
    if (this.today(now) < this.limit) return;
    throw new RefusedError(
      `Nothing was recorded: this server has recorded ${this.limit} entries today (UTC), its daily limit ` +
        '(STARMEMORY_REMEMBER_DAILY_LIMIT), and takes more after 00:00 UTC. One entry per decision, finding or milestone is plenty.'
    );
  }

  /** One more entry recorded today. */
  count(now: Date): void {
    this.today(now);
    this.used++;
  }

  private today(now: Date): number {
    const day = now.toISOString().slice(0, 10);
    if (day !== this.day) {
      this.day = day;
      this.used = 0;
    }
    return this.used;
  }
}

export interface RememberOptions {
  /** Whether the user asked to forget the session (src/forget.ts). Asked twice,
   * before writing and after, because `forget` can run in another process in
   * between. */
  isForgotten?: (session: string) => boolean;
  /** Called with the record's path just before its first line is written. A
   * record started again under a key counts its lines from 1, so the caller
   * removes any sync cursor left there by the key's earlier record. */
  onStart?: (file: string) => void;
  /** Refuses an entry over the day's limit, and counts each one written. */
  dailyCap?: DailyCap;
  now?: Date;
}

function entryProblem(input: RememberInput): string | undefined {
  for (const field of ['title', 'asked', 'found'] as const) {
    const value = input[field];
    if (typeof value !== 'string' || value.trim() === '') return `${field} must not be empty.`;
    if (value.length > LIMITS[field]) {
      return `${field} is ${value.length} characters, over its limit of ${LIMITS[field]}. Write a summary, not the transcript.`;
    }
  }
  if (input.project !== undefined && input.project.length > LIMITS.project) {
    return `project is over its limit of ${LIMITS.project} characters.`;
  }
  return undefined;
}

function forgottenMessage(session: string): string {
  return `The user asked to forget session ${session}, so nothing was recorded. Do not call remember for it again.`;
}

/** The generation is drawn afresh for every record started, so a record
 * started again under a key it had before never has the same header
 * (recordIdentity). */
function headerLine(session: string, project: string, now: Date): string {
  const generation = crypto.randomBytes(8).toString('hex');
  return JSON.stringify({ type: COWORK_SESSION_LINE_TYPE, version: 1, session, project, createdAt: now.toISOString(), generation });
}

/** Far more than a header line takes. */
const HEADER_READ_BYTES = 4096;

/** What tells the record at `file` from any other started under the same
 * key, read from the file as it is now: its header line, whose generation
 * is new for every record. A record written before generations has only its
 * start time there, so the file itself, device and inode, counts too. Any
 * other file in the records folder is taken the same way, by its first
 * line. Undefined when the file cannot be read. */
export function recordIdentity(file: string): string | undefined {
  let fd: number;
  try {
    fd = fs.openSync(file, 'r');
  } catch {
    return undefined;
  }
  try {
    const { dev, ino } = fs.fstatSync(fd);
    const head = Buffer.alloc(HEADER_READ_BYTES);
    const text = head.subarray(0, fs.readSync(fd, head, 0, head.length, 0)).toString('utf8');
    const newline = text.indexOf('\n');
    const header = newline === -1 ? text : text.slice(0, newline);
    return hasGeneration(header) ? header : `${dev}:${ino}:${header}`;
  } catch {
    return undefined;
  } finally {
    fs.closeSync(fd);
  }
}

function hasGeneration(header: string): boolean {
  try {
    const parsed = JSON.parse(header) as { type?: unknown; generation?: unknown };
    return parsed.type === COWORK_SESSION_LINE_TYPE && typeof parsed.generation === 'string' && parsed.generation !== '';
  } catch {
    return false;
  }
}

/** Characters that do not show, which a tag name can hide behind. */
const INVISIBLE = /[\u200B-\u200D\u2060\uFEFF]/;
/** Brackets that read as `<` and `>`: the full-width and small-form ones. */
const LOOKALIKE: Readonly<Record<string, string>> = { '\uFF1C': '<', '\uFE64': '<', '\uFF1E': '>', '\uFE65': '>' };

/** `text` with the `<` of each harness control tag (parser.ts,
 * INJECTED_TAG_START) written as `&lt;`: still readable, never a tag. A tag is
 * matched as it reads, with invisible characters left out and look-alike
 * brackets taken for `<` and `>`, so `<\u200Bsystem-reminder>` and
 * `\uFF1Csystem-reminder\uFF1E` count; only the bracket that opens it changes,
 * and the rest of the text is kept as written. Any other `<`, as in `Array<T>`
 * or `a < b`, is left alone. */
export function escapeControlTags(text: string): string {
  // `plain` is the text as it reads; at[i] is where its i-th character is in `text`.
  let plain = '';
  const at: number[] = [];
  for (let i = 0; i < text.length; i++) {
    if (INVISIBLE.test(text[i])) continue;
    plain += LOOKALIKE[text[i]] ?? text[i];
    at.push(i);
  }
  const opens = new Set(Array.from(plain.matchAll(INJECTED_TAG_START), (match) => at[match.index]));
  if (opens.size === 0) return text;
  let escaped = '';
  for (let i = 0; i < text.length; i++) escaped += opens.has(i) ? '&lt;' : text[i];
  return escaped;
}

/** The user line carries its own promptSource, which the Claude parser keeps
 * verbatim, as it does a typed prompt, and marks as a note (parser.ts,
 * COWORK_RECORD_PROMPT_SOURCE). It is the model's account of what the person
 * asked, not the person's words. */
function entryLines({ session, title, asked, found }: RememberInput, now: Date): string {
  const timestamp = now.toISOString();
  const user = {
    type: 'user',
    promptSource: COWORK_RECORD_PROMPT_SOURCE,
    sessionId: session,
    timestamp,
    message: { role: 'user', content: escapeControlTags(asked.trim()) },
  };
  const heading = escapeControlTags(title.replace(/\s+/g, ' ').trim());
  const assistant = { type: 'assistant', sessionId: session, timestamp, message: { role: 'assistant', content: `${heading}\n\n${escapeControlTags(found.trim())}` } };
  return `${JSON.stringify(user)}\n${JSON.stringify(assistant)}\n`;
}

/** Append one entry to `session`'s record, starting the record if needed.
 * Throws RefusedError, writing nothing, for a bad key, an empty or oversize
 * field, an entry over the daily limit, or a session the user asked to
 * forget. */
export function remember(
  root: string,
  input: RememberInput,
  { isForgotten = () => false, onStart, dailyCap, now = new Date() }: RememberOptions = {}
): RememberResult {
  const problem = sessionKeyProblem(input.session) ?? entryProblem(input);
  if (problem) throw new RefusedError(problem);
  dailyCap?.check(now);

  // A session stays in the project of its first entry, so it stays one file.
  const existing = findRecords(root, input.session)[0];
  const project = existing ? path.basename(path.dirname(existing)) : projectSlug(input.project);
  const file = existing ?? path.join(root, project, `${input.session}.jsonl`);
  if (isForgotten(input.session)) throw new RefusedError(forgottenMessage(input.session));
  fs.mkdirSync(path.dirname(file), { recursive: true });

  let created = false;
  const fd = fs.openSync(file, 'a');
  try {
    // Judged on the open descriptor, not the path: if the file went after the
    // lookup above, this starts a whole record, header and all, rather than a
    // headerless tail the parser would take for a Claude Code transcript.
    if (fs.fstatSync(fd).size === 0) {
      onStart?.(file);
      fs.writeSync(fd, `${headerLine(input.session, project, now)}\n`);
      created = true;
    }
    fs.writeSync(fd, entryLines(input, now));
  } finally {
    fs.closeSync(fd);
  }

  if (isForgotten(input.session)) {
    fs.rmSync(file, { force: true });
    throw new RefusedError(forgottenMessage(input.session));
  }
  dailyCap?.count(now);
  const requested = input.project === undefined ? undefined : projectSlug(input.project);
  return {
    file,
    project,
    entries: countEntries(file),
    created,
    ignoredProject: requested !== undefined && requested !== project ? requested : undefined,
  };
}

/** Remove every record of `session`. Returns the files removed and how many
 * entries they held. */
export function deleteRecords(root: string, session: string): { files: string[]; entries: number } {
  const files = findRecords(root, session);
  let entries = 0;
  for (const file of files) {
    entries += countEntries(file);
    fs.rmSync(file, { force: true });
  }
  return { files, entries };
}

/** STARMEMORY_QUARANTINE_PATH, else ~/.config/starmemory/quarantine: where a
 * forgotten Cowork record is set aside for a while, so a mistaken forget can
 * be undone (src/forget.ts). */
export function defaultQuarantineRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env.STARMEMORY_QUARANTINE_PATH ?? path.join(os.homedir(), '.config', 'starmemory', 'quarantine');
}

export const DEFAULT_QUARANTINE_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

/** STARMEMORY_QUARANTINE_DAYS, else 7. `0` deletes a forgotten record at once.
 * A value that is not a number of days keeps the default: what a purge
 * deletes cannot be brought back. */
export function defaultQuarantineDays(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.STARMEMORY_QUARANTINE_DAYS;
  const days = Number(raw);
  return raw !== undefined && raw.trim() !== '' && Number.isFinite(days) && days >= 0 ? days : DEFAULT_QUARANTINE_DAYS;
}

export interface Quarantine {
  root: string;
  days: number;
}

/** How a set-aside record's name ends. Not `.jsonl`, so nothing that looks for
 * transcripts, sync's walk and `read` among them, takes one for a record. */
export const QUARANTINE_SUFFIX = '.jsonl.forgotten';

/** The latest time a Date can hold. */
const MAX_DATE_MS = 8.64e15;

/** When a set-aside record may be deleted, read from its name
 * (quarantineRecord), or undefined for a name that does not carry one. */
export function setAsideExpiry(name: string): number | undefined {
  const match = /\.(\d{1,16})-[0-9a-f]+\.jsonl\.forgotten$/.exec(name);
  const expiresAt = match ? Number(match[1]) : Number.NaN;
  return Number.isSafeInteger(expiresAt) && expiresAt <= MAX_DATE_MS ? expiresAt : undefined;
}

/** Owner-only, since what it holds is what the user asked to forget. */
function privateDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
}

/** Nothing was written to the file `now` describes since `seen`. */
function unchangedSince(now: fs.Stats, seen: fs.Stats): boolean {
  return now.dev === seen.dev && now.ino === seen.ino && now.size === seen.size && now.mtimeMs === seen.mtimeMs;
}

/** Delete `file`, or with `into` move it elsewhere, only if it is still what
 * `seen`, the stat it was judged by, describes: a remember can add an entry to
 * a record while a sync decides to remove it, and is told the entry was
 * recorded. The file is renamed aside first, so a remember from then on
 * starts a new record at the path, while one that already had it open writes
 * into the renamed file, which is what is compared, and what `into` is given.
 * Changed, it is put back, unless a new record has the path by then; it then
 * stays aside, under a name nothing reads. When `into` throws, it is put back
 * the same way and the error goes on. A write landing between the compare and
 * the delete is still lost. Returns true when the file was taken. */
export function removeIfUnchanged(file: string, seen: fs.Stats, into?: (aside: string) => void): boolean {
  const aside = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.removing`;
  try {
    fs.renameSync(file, aside);
  } catch (error) {
    // Gone already, or held open where the system forbids a rename: the
    // next sync looks again.
    if (['ENOENT', 'EBUSY', 'EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) return false;
    throw error;
  }
  if (!unchangedSince(fs.lstatSync(aside), seen)) {
    putBack(aside, file);
    return false;
  }
  if (!into) {
    fs.rmSync(aside, { force: true });
    return true;
  }
  try {
    into(aside);
  } catch (error) {
    putBack(aside, file);
    throw error;
  }
  return true;
}

/** The codes a file system gives for a hard link it cannot make: EPERM and
 * ENOTSUP or EOPNOTSUPP where it has none (FAT, exFAT, some network shares),
 * EISDIR for the same on Windows, EMLINK when the file has too many. */
const NO_HARD_LINK = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EISDIR', 'EMLINK']);

/** `aside` back at `file`, unless a new record has the path by then; it then
 * stays where it is. A hard link, which fails rather than writing over a file
 * already there, then the aside name unlinked: a remember that had the record
 * open still writes into it. Returns true when it was put back. */
function putBack(aside: string, file: string): boolean {
  try {
    fs.linkSync(aside, file);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? '';
    if (code === 'EEXIST') return false;
    if (!NO_HARD_LINK.has(code)) throw error;
    return copyBack(aside, file);
  }
  fs.rmSync(aside, { force: true });
  return true;
}

/** putBack where there are no hard links: a file created at `file` only if
 * none is there, never written over, with what `aside` holds appended in one
 * write, and again whatever was added to `aside` meanwhile. A remember that
 * starts a record at the path between the create and the write keeps its
 * lines, ahead of these. A write landing in `aside` after the last read is
 * lost, as with any delete here. */
function copyBack(aside: string, file: string): boolean {
  let fd: number;
  try {
    fd = fs.openSync(file, 'ax', fs.lstatSync(aside).mode & 0o777);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  }
  try {
    let copied = 0;
    for (;;) {
      const held = fs.readFileSync(aside);
      if (held.length <= copied) break;
      fs.writeSync(fd, held.subarray(copied));
      copied = held.length;
    }
  } finally {
    fs.closeSync(fd);
  }
  fs.rmSync(aside, { force: true });
  return true;
}

/** A rename, or where the quarantine is on another volume, a copy that never
 * overwrites and then a delete. The copy is made again if the record grew
 * while it was copied, so what the delete takes is all in the copy. */
function moveFile(from: string, to: string): void {
  try {
    fs.renameSync(from, to);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
    for (;;) {
      const before = fs.lstatSync(from);
      fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
      if (unchangedSince(fs.lstatSync(from), before)) break;
      fs.rmSync(to, { force: true });
    }
    fs.rmSync(from, { force: true });
  }
}

export interface SetAside {
  from: string;
  to: string;
  /** When a sync may delete it, in ms since the epoch. */
  expiresAt: number;
}

/** Move one record, <root>/<project>/<session>.jsonl, into the quarantine, as
 * <quarantine>/<project>/<session>.<expiresAt>-<random>.jsonl.forgotten,
 * readable by the owner alone. The expiry goes in the name, so it is kept for
 * `quarantine.days` whichever process's sync purges it, with whatever days
 * that process was given. The random part keeps a later forget of the same key
 * from overwriting an earlier one, and the name from being guessed. Its mtime
 * becomes `now`. `source`, when given, is where the record's file is now,
 * renamed aside (removeIfUnchanged). Throws, leaving the record where it was,
 * when it cannot be moved. */
export function quarantineRecord(from: string, quarantine: Quarantine, now: Date = new Date(), source: string = from): SetAside {
  privateDir(quarantine.root);
  const dir = path.join(quarantine.root, path.basename(path.dirname(from)));
  privateDir(dir);
  const session = path.basename(from, '.jsonl');
  const expiresAt = Math.min(Math.round(now.getTime() + quarantine.days * DAY_MS), MAX_DATE_MS);
  let to: string;
  do {
    to = path.join(dir, `${session}.${expiresAt}-${crypto.randomBytes(4).toString('hex')}${QUARANTINE_SUFFIX}`);
  } while (fs.existsSync(to));
  moveFile(source, to);
  fs.chmodSync(to, 0o600);
  fs.utimesSync(to, now, now);
  return { from, to, expiresAt };
}

/** Set the record at `file` aside (quarantineRecord), only if it is still
 * what `seen` describes (removeIfUnchanged). Undefined when it was not taken:
 * gone, or changed and put back. Throws, the record put back, when it cannot
 * be moved. */
export function quarantineIfUnchanged(file: string, seen: fs.Stats, quarantine: Quarantine, now: Date = new Date()): SetAside | undefined {
  let setAside: SetAside | undefined;
  removeIfUnchanged(file, seen, (aside) => {
    setAside = quarantineRecord(file, quarantine, now, aside);
  });
  return setAside;
}

/** Move every record of `session` into the quarantine (quarantineRecord).
 * Returns each record's old and new path and how many entries they held. */
export function quarantineRecords(
  root: string,
  session: string,
  quarantine: Quarantine,
  now: Date = new Date()
): { moved: SetAside[]; entries: number } {
  const moved: SetAside[] = [];
  let entries = 0;
  for (const from of findRecords(root, session)) {
    const setAside = quarantineRecord(from, quarantine, now);
    moved.push(setAside);
    // Counted once moved: a remember that had the record open may have added
    // one on the way.
    entries += countEntries(setAside.to);
  }
  return { moved, entries };
}

function listDir(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

/** What forgets set aside of `session` in the quarantine at `root`, found by
 * the names quarantineRecord gives them. The part after the key holds no ".",
 * so a key that only starts like this one matches none of them. */
export function findSetAside(root: string, session: string): string[] {
  const prefix = `${session}.`;
  const isFile = (file: string) => {
    try {
      return fs.lstatSync(file).isFile();
    } catch {
      return false;
    }
  };
  return listDir(root)
    .flatMap((project) =>
      listDir(path.join(root, project))
        .filter((name) => name.startsWith(prefix) && /^[0-9A-Za-z]+-[0-9a-f]+\.jsonl\.forgotten$/.test(name.slice(prefix.length)))
        .map((name) => path.join(root, project, name))
    )
    .filter(isFile)
    .sort();
}

/** Delete the set-aside records whose time is up: the expiry in the name, or
 * for a name without one, `days` after its mtime. Only files named as
 * quarantineRecord names them, and a project folder only once this emptied
 * it, so a quarantine path pointed at a folder that holds anything else
 * leaves the rest alone. Returns the files deleted. */
export function purgeQuarantine({ root, days }: Quarantine, now: number = Date.now()): string[] {
  const purged: string[] = [];
  for (const project of listDir(root)) {
    const dir = path.join(root, project);
    let emptied = false;
    for (const name of listDir(dir)) {
      if (!name.endsWith(QUARANTINE_SUFFIX)) continue;
      const file = path.join(dir, name);
      try {
        const stat = fs.lstatSync(file);
        if (!stat.isFile() || (setAsideExpiry(name) ?? stat.mtimeMs + days * DAY_MS) >= now) continue;
        // Written to since it was judged, it is not deleted this time.
        if (!removeIfUnchanged(file, stat)) continue;
        purged.push(file);
        emptied = true;
      } catch {
        // gone already, or not ours to remove; the next sync looks again
      }
    }
    if (!emptied) continue;
    try {
      fs.rmdirSync(dir);
    } catch {
      // not empty: a record set aside more recently
    }
  }
  return purged;
}

/** What the model is told after a remember. */
export function describeRemember(result: RememberResult): string {
  const lines = [
    `Recorded entry ${result.entries} of this session under project "${result.project}". ` +
      'It is being indexed in the background and is searchable shortly.',
  ];
  if (result.ignoredProject) {
    lines.push(`This session was already recorded under "${result.project}", so it stays there rather than moving to "${result.ignoredProject}".`);
  }
  lines.push(`Record: ${result.file}`);
  return lines.join('\n');
}
