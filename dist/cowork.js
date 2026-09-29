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
export function defaultCoworkRoot(env = process.env) {
    return env.STARMEMORY_COWORK_PATH ?? path.join(os.homedir(), '.config', 'starmemory', 'cowork');
}
/** STARMEMORY_SCOPE. Unset is `all`; any value but `all` is `cowork`, so a
 * mistyped setting gives less away, not more. */
export function serverScope(env = process.env) {
    return env.STARMEMORY_SCOPE === undefined || env.STARMEMORY_SCOPE === 'all' ? 'all' : 'cowork';
}
/** Upper bounds on one entry. A record is a summary: an entry longer than this
 * is a transcript being pasted in, which is exactly what it must not become. */
export const LIMITS = { title: 200, asked: 2000, found: 8000, project: 80 };
/** A session key names the record's file, so it is held to what every
 * filesystem accepts. Anything else is refused rather than rewritten, so one
 * session can never quietly become two files. */
export const SESSION_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;
/** Names Windows keeps for devices, with or without an extension. */
const WINDOWS_DEVICE_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
/** Why `session` cannot be a key, or undefined when it can. */
export function sessionKeyProblem(session) {
    if (!SESSION_KEY_PATTERN.test(session)) {
        return `${JSON.stringify(session.slice(0, 40))} is not a usable session key: use 1-120 letters, digits, ".", "_" or "-", starting with a letter or digit.`;
    }
    if (WINDOWS_DEVICE_NAME.test(session))
        return `${JSON.stringify(session)} is a reserved file name on Windows; pick another session key.`;
    return undefined;
}
export const DEFAULT_PROJECT = 'general';
/** The folder a project's records live in, which is also the project name that
 * search shows and filters on. Lowercased, and runs of anything but letters,
 * digits, ".", "_" and "-" become "-", so "StarRocks BE" and "starrocks-be"
 * are the same project from one session to the next. Letters of any script
 * are kept. */
export function projectSlug(project) {
    const slug = (project ?? '')
        .toLowerCase()
        .replace(/[^\p{L}\p{M}\p{N}._-]+/gu, '-')
        .slice(0, LIMITS.project)
        .replace(/^[-.]+|[-.]+$/g, '');
    return slug === '' || WINDOWS_DEVICE_NAME.test(slug) ? DEFAULT_PROJECT : slug;
}
/** Every record of `session`, in a stable order. Normally one: a session
 * stays in the folder of the project it started under (see remember). */
export function findRecords(root, session) {
    let entries;
    try {
        entries = fs.readdirSync(root, { withFileTypes: true });
    }
    catch {
        return [];
    }
    return entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => path.join(root, entry.name, `${session}.jsonl`))
        .filter((file) => fs.existsSync(file))
        .sort();
}
/** Entries in a record: one per user line. */
export function countEntries(file) {
    let text;
    try {
        text = fs.readFileSync(file, 'utf8');
    }
    catch {
        return 0;
    }
    let entries = 0;
    for (const line of text.split('\n')) {
        try {
            if (JSON.parse(line).type === 'user')
                entries++;
        }
        catch {
            // blank line
        }
    }
    return entries;
}
/** Nothing was written. The message is meant for the model, so it says what to
 * do instead. */
export class RefusedError extends Error {
}
export const DEFAULT_REMEMBER_DAILY_LIMIT = 300;
/** STARMEMORY_REMEMBER_DAILY_LIMIT, else 300. `0` refuses every entry; a
 * value that is not a whole number keeps the default. */
export function defaultRememberDailyLimit(env = process.env) {
    const raw = env.STARMEMORY_REMEMBER_DAILY_LIMIT;
    const limit = Number(raw);
    return raw !== undefined && raw.trim() !== '' && Number.isInteger(limit) && limit >= 0 ? limit : DEFAULT_REMEMBER_DAILY_LIMIT;
}
/** How many entries one server process records per UTC day. The default is
 * far more than a day of sessions writes, and bounds how much a caller
 * steered into a loop can pile into the memory. Held in memory, so a restart
 * of the app starts the count again. */
export class DailyCap {
    limit;
    day = '';
    used = 0;
    constructor(limit) {
        this.limit = limit;
    }
    /** Throws RefusedError when today's entries are used up. */
    check(now) {
        if (this.today(now) < this.limit)
            return;
        throw new RefusedError(`Nothing was recorded: this server has recorded ${this.limit} entries today (UTC), its daily limit ` +
            '(STARMEMORY_REMEMBER_DAILY_LIMIT), and takes more after 00:00 UTC. One entry per decision, finding or milestone is plenty.');
    }
    /** One more entry recorded today. */
    count(now) {
        this.today(now);
        this.used++;
    }
    today(now) {
        const day = now.toISOString().slice(0, 10);
        if (day !== this.day) {
            this.day = day;
            this.used = 0;
        }
        return this.used;
    }
}
function entryProblem(input) {
    for (const field of ['title', 'asked', 'found']) {
        const value = input[field];
        if (typeof value !== 'string' || value.trim() === '')
            return `${field} must not be empty.`;
        if (value.length > LIMITS[field]) {
            return `${field} is ${value.length} characters, over its limit of ${LIMITS[field]}. Write a summary, not the transcript.`;
        }
    }
    if (input.project !== undefined && input.project.length > LIMITS.project) {
        return `project is over its limit of ${LIMITS.project} characters.`;
    }
    return undefined;
}
function forgottenMessage(session) {
    return `The user asked to forget session ${session}, so nothing was recorded. Do not call remember for it again.`;
}
function headerLine(session, project, now) {
    return JSON.stringify({ type: COWORK_SESSION_LINE_TYPE, version: 1, session, project, createdAt: now.toISOString() });
}
/** `text` with the `<` of each harness control tag (parser.ts,
 * INJECTED_TAG_START) written as `&lt;`: still readable, never a tag. Any
 * other `<`, as in `Array<T>` or `a < b`, is left alone. */
export function escapeControlTags(text) {
    return text.replace(INJECTED_TAG_START, '&lt;');
}
/** The user line carries its own promptSource, which the Claude parser keeps
 * verbatim, as it does a typed prompt, and marks as a note (parser.ts,
 * COWORK_RECORD_PROMPT_SOURCE). It is the model's account of what the person
 * asked, not the person's words. */
function entryLines({ session, title, asked, found }, now) {
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
export function remember(root, input, { isForgotten = () => false, onStart, dailyCap, now = new Date() } = {}) {
    const problem = sessionKeyProblem(input.session) ?? entryProblem(input);
    if (problem)
        throw new RefusedError(problem);
    dailyCap?.check(now);
    // A session stays in the project of its first entry, so it stays one file.
    const existing = findRecords(root, input.session)[0];
    const project = existing ? path.basename(path.dirname(existing)) : projectSlug(input.project);
    const file = existing ?? path.join(root, project, `${input.session}.jsonl`);
    if (isForgotten(input.session))
        throw new RefusedError(forgottenMessage(input.session));
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
    }
    finally {
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
export function deleteRecords(root, session) {
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
export function defaultQuarantineRoot(env = process.env) {
    return env.STARMEMORY_QUARANTINE_PATH ?? path.join(os.homedir(), '.config', 'starmemory', 'quarantine');
}
export const DEFAULT_QUARANTINE_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;
/** STARMEMORY_QUARANTINE_DAYS, else 7. `0` deletes a forgotten record at once.
 * A value that is not a number of days keeps the default: what a purge
 * deletes cannot be brought back. */
export function defaultQuarantineDays(env = process.env) {
    const raw = env.STARMEMORY_QUARANTINE_DAYS;
    const days = Number(raw);
    return raw !== undefined && raw.trim() !== '' && Number.isFinite(days) && days >= 0 ? days : DEFAULT_QUARANTINE_DAYS;
}
/** How a set-aside record's name ends. Not `.jsonl`, so nothing that looks for
 * transcripts, sync's walk and `read` among them, takes one for a record. */
export const QUARANTINE_SUFFIX = '.jsonl.forgotten';
/** The latest time a Date can hold. */
const MAX_DATE_MS = 8.64e15;
/** When a set-aside record may be deleted, read from its name
 * (quarantineRecord), or undefined for a name that does not carry one. */
export function setAsideExpiry(name) {
    const match = /\.(\d{1,16})-[0-9a-f]+\.jsonl\.forgotten$/.exec(name);
    const expiresAt = match ? Number(match[1]) : Number.NaN;
    return Number.isSafeInteger(expiresAt) && expiresAt <= MAX_DATE_MS ? expiresAt : undefined;
}
/** Owner-only, since what it holds is what the user asked to forget. */
function privateDir(dir) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dir, 0o700);
}
/** A rename, or where the quarantine is on another volume, a copy that never
 * overwrites and then a delete. */
function moveFile(from, to) {
    try {
        fs.renameSync(from, to);
    }
    catch (error) {
        if (error.code !== 'EXDEV')
            throw error;
        fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
        fs.rmSync(from, { force: true });
    }
}
/** Move one record, <root>/<project>/<session>.jsonl, into the quarantine, as
 * <quarantine>/<project>/<session>.<expiresAt>-<random>.jsonl.forgotten,
 * readable by the owner alone. The expiry goes in the name, so it is kept for
 * `quarantine.days` whichever process's sync purges it, with whatever days
 * that process was given. The random part keeps a later forget of the same key
 * from overwriting an earlier one, and the name from being guessed. Its mtime
 * becomes `now`. Throws, leaving the record where it was, when it cannot be
 * moved. */
export function quarantineRecord(from, quarantine, now = new Date()) {
    privateDir(quarantine.root);
    const dir = path.join(quarantine.root, path.basename(path.dirname(from)));
    privateDir(dir);
    const session = path.basename(from, '.jsonl');
    const expiresAt = Math.min(Math.round(now.getTime() + quarantine.days * DAY_MS), MAX_DATE_MS);
    let to;
    do {
        to = path.join(dir, `${session}.${expiresAt}-${crypto.randomBytes(4).toString('hex')}${QUARANTINE_SUFFIX}`);
    } while (fs.existsSync(to));
    moveFile(from, to);
    fs.chmodSync(to, 0o600);
    fs.utimesSync(to, now, now);
    return { from, to, expiresAt };
}
/** Move every record of `session` into the quarantine (quarantineRecord).
 * Returns each record's old and new path and how many entries they held. */
export function quarantineRecords(root, session, quarantine, now = new Date()) {
    const moved = [];
    let entries = 0;
    for (const from of findRecords(root, session)) {
        const count = countEntries(from);
        moved.push(quarantineRecord(from, quarantine, now));
        entries += count;
    }
    return { moved, entries };
}
function listDir(dir) {
    try {
        return fs.readdirSync(dir);
    }
    catch {
        return [];
    }
}
/** What forgets set aside of `session` in the quarantine at `root`, found by
 * the names quarantineRecord gives them. The part after the key holds no ".",
 * so a key that only starts like this one matches none of them. */
export function findSetAside(root, session) {
    const prefix = `${session}.`;
    const isFile = (file) => {
        try {
            return fs.lstatSync(file).isFile();
        }
        catch {
            return false;
        }
    };
    return listDir(root)
        .flatMap((project) => listDir(path.join(root, project))
        .filter((name) => name.startsWith(prefix) && /^[0-9A-Za-z]+-[0-9a-f]+\.jsonl\.forgotten$/.test(name.slice(prefix.length)))
        .map((name) => path.join(root, project, name)))
        .filter(isFile)
        .sort();
}
/** Delete the set-aside records whose time is up: the expiry in the name, or
 * for a name without one, `days` after its mtime. Only files named as
 * quarantineRecord names them, and a project folder only once this emptied
 * it, so a quarantine path pointed at a folder that holds anything else
 * leaves the rest alone. Returns the files deleted. */
export function purgeQuarantine({ root, days }, now = Date.now()) {
    const purged = [];
    for (const project of listDir(root)) {
        const dir = path.join(root, project);
        let emptied = false;
        for (const name of listDir(dir)) {
            if (!name.endsWith(QUARANTINE_SUFFIX))
                continue;
            const file = path.join(dir, name);
            try {
                const stat = fs.lstatSync(file);
                if (!stat.isFile() || (setAsideExpiry(name) ?? stat.mtimeMs + days * DAY_MS) >= now)
                    continue;
                fs.rmSync(file, { force: true });
                purged.push(file);
                emptied = true;
            }
            catch {
                // gone already, or not ours to remove; the next sync looks again
            }
        }
        if (!emptied)
            continue;
        try {
            fs.rmdirSync(dir);
        }
        catch {
            // not empty: a record set aside more recently
        }
    }
    return purged;
}
/** What the model is told after a remember. */
export function describeRemember(result) {
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
