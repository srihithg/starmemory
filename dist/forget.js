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
// Codex session.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { archivePathFor, summaryPathFor } from './archive.js';
import { RefusedError, deleteRecords, sessionKeyProblem } from './cowork.js';
import { projectFromPath, walkJsonlFiles } from './parser.js';
import { filterIds, getExchange, syncCursorKey } from './store.js';
import { groupByFile, removeConversations } from './ttl.js';
import { HARNESSES } from './types.js';
/** STARMEMORY_FORGOTTEN_PATH, else ~/.config/starmemory/forgotten.txt. */
export function defaultForgottenPath(env = process.env) {
    return env.STARMEMORY_FORGOTTEN_PATH ?? path.join(os.homedir(), '.config', 'starmemory', 'forgotten.txt');
}
const HEADER = '# Sessions starmemory was asked to forget, one key per line. They are deleted from the memory and never indexed again.\n' +
    '# Deleting a line lets that session be indexed again from where it stopped, including what was written while it was forgotten.\n' +
    '# What the forget deleted stays deleted; the archive copy is made again from the transcript.\n';
/** Every forgotten session key. A missing file is an empty list. */
export function readForgotten(file) {
    let text;
    try {
        text = fs.readFileSync(file, 'utf8');
    }
    catch {
        return new Set();
    }
    return new Set(text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line !== '' && !line.startsWith('#')));
}
/** Appended, never rewritten: a short O_APPEND write lands whole, so two
 * processes forgetting at the same moment cannot lose each other's line. A
 * file edited by hand can end without a newline, and appending straight onto
 * its last line would fuse two keys into one that matches neither, so the key
 * then starts on a line of its own. */
export function addForgotten(file, session) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const fd = fs.openSync(file, 'a+');
    try {
        const { size } = fs.fstatSync(fd);
        let lead = size === 0 ? HEADER : '';
        if (size > 0) {
            const last = Buffer.alloc(1);
            fs.readSync(fd, last, 0, 1, size - 1);
            if (last[0] !== 0x0a)
                lead = '\n';
        }
        fs.writeSync(fd, `${lead}${session}\n`);
    }
    finally {
        fs.closeSync(fd);
    }
}
function storedRows(store, session) {
    const rows = [];
    for (const id of filterIds(store, { sessionId: session }) ?? []) {
        const row = getExchange(store, id);
        if (row)
            rows.push(row);
    }
    return rows;
}
function listDir(dir) {
    try {
        return fs.readdirSync(dir);
    }
    catch {
        return [];
    }
}
/** A Codex rollout of `session`, `rollout-<time>-<session>` then `suffix`,
 * matched whole, so a key that is only the tail of another session's id
 * matches nothing. */
function rolloutName(session, suffix) {
    const escape = (text) => text.replace(/\./g, '\\.');
    return new RegExp(`^rollout-\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}-${escape(session)}${escape(suffix)}$`);
}
/** Archive copies of `session` found by their names, for the ones no row
 * points at: a copy taken before the conversation had a whole exchange, whose
 * source may be gone. Claude Code and Cowork name a transcript after its
 * session; a Codex rollout ends in it (rolloutName). */
function copiesByName(archiveRoot, session, harnesses = HARNESSES) {
    const rollout = rolloutName(session, '.jsonl.gz');
    const found = [];
    for (const harness of harnesses) {
        const harnessDir = path.join(archiveRoot, harness);
        for (const project of listDir(harnessDir)) {
            const dir = path.join(harnessDir, project);
            if (harness === 'codex') {
                for (const name of listDir(dir))
                    if (rollout.test(name))
                        found.push(path.join(dir, name));
            }
            else if (fs.existsSync(path.join(dir, `${session}.jsonl.gz`))) {
                found.push(path.join(dir, `${session}.jsonl.gz`));
            }
        }
    }
    return found;
}
/** An archive copy and its summary. True when there was a copy. */
function removeCopy(copy) {
    const existed = fs.existsSync(copy);
    for (const file of [copy, summaryPathFor(copy)])
        fs.rmSync(file, { force: true });
    return existed;
}
/** Whether `session` is one Claude Code or Codex keeps: rows of theirs in the
 * store, an archive copy under their harness, or their transcript of it,
 * matched by name as the archive copies are. A Claude Code session's
 * transcript is <project>/<session>.jsonl, and its subagents' are in a
 * <project>/<session>/ folder. */
function heldByAnotherHarness(session, { store, archiveRoot, dirs }) {
    if (store && storedRows(store, session).some((row) => (row.harness ?? 'claude') !== 'cowork'))
        return true;
    if (copiesByName(archiveRoot, session, ['claude', 'codex']).length > 0)
        return true;
    for (const project of listDir(dirs.claude)) {
        if (fs.existsSync(path.join(dirs.claude, project, `${session}.jsonl`)) || fs.existsSync(path.join(dirs.claude, project, session)))
            return true;
    }
    const rollout = rolloutName(session, '.jsonl');
    for (const file of walkJsonlFiles(dirs.codex))
        if (rollout.test(path.basename(file)))
            return true;
    return false;
}
/** Forget `session`: put it on the list, then remove its Cowork record and the
 * archive copies and summaries kept of it. The caller starts a sync, which
 * deletes the rest. Throws RefusedError, changing nothing, for a key that
 * could not name a session, or on a Cowork-only server for a Claude Code or
 * Codex session. A key with nothing stored under it yet is listed all the
 * same, so remember refuses it from the first entry. */
export function forget(session, { coworkRoot, forgottenPath, archiveRoot, store, coworkOnly }) {
    const problem = sessionKeyProblem(session);
    if (problem)
        throw new RefusedError(problem);
    if (coworkOnly && heldByAnotherHarness(session, { store, archiveRoot, dirs: coworkOnly.dirs })) {
        throw new RefusedError(`Nothing was changed: ${session} is a Claude Code or Codex session on this computer, and this server serves Cowork records only, ` +
            'so it does not forget other sessions. The user can forget it from a Claude Code or Codex session on this computer.');
    }
    // The list first. From that moment remember refuses the session and search
    // hides it, even if what follows fails, and a remember racing in another
    // process removes its own write (cowork.ts).
    const alreadyForgotten = readForgotten(forgottenPath).has(session);
    if (!alreadyForgotten)
        addForgotten(forgottenPath, session);
    const { files, entries } = deleteRecords(coworkRoot, session);
    // A record started later under this key counts its lines from 1 again, and
    // the old cursor would skip them.
    for (const file of files)
        store?.meta.remove(syncCursorKey(file));
    const rows = store ? storedRows(store, session) : [];
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
        copies: [...copies].filter(removeCopy),
        pendingRows: rows.length,
        pendingHarnesses: [...new Set(rows.map((r) => r.harness ?? 'claude'))],
        alreadyForgotten,
    };
}
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
/** What the model is told, to pass on to the user in a sentence. */
export function describeForget(result) {
    const lines = [`Forgot session ${result.session}.`];
    const removed = [
        ...(result.records.length > 0 ? [`its Cowork record, ${plural(result.entries, 'entry', 'entries')} (${result.records.join(', ')})`] : []),
        ...(result.copies.length > 0 ? [`the archive ${result.copies.length === 1 ? 'copy' : 'copies'} starmemory kept of it, with any summary`] : []),
    ];
    if (removed.length > 0)
        lines.push(`Removed now: ${removed.join('; ')}.`);
    if (result.pendingRows > 0) {
        lines.push(`Hidden from search from now on: ${plural(result.pendingRows, 'indexed exchange', 'indexed exchanges')}. ` +
            'A background sync deletes them and their text-index entries, usually within a minute, or when a sync that is already running finishes.');
    }
    if (removed.length === 0 && result.pendingRows === 0) {
        lines.push(result.alreadyForgotten
            ? 'It had been forgotten already; nothing of it is stored.'
            : 'Nothing was stored under this key. If you meant this session, check that the key is the one from the starmemory start-up line.');
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
export function forgetSessions(store, textIndex, sessions, { archiveRoot, coworkRoot, log }) {
    const rows = [...sessions].flatMap((session) => storedRows(store, session));
    return removeConversations(store, textIndex, groupByFile(rows), {
        archiveRoot,
        log,
        describe: (g) => `forgot ${g.archivePath} (${g.ids.length} exchanges), as the user asked`,
        onRemoved: (g) => {
            if (g.harness !== 'cowork' || coworkRoot === undefined)
                return;
            const record = path.join(coworkRoot, g.project, path.basename(g.archivePath).replace(/\.gz$/, ''));
            store.meta.remove(syncCursorKey(record));
        },
    });
}
