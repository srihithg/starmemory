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
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { COWORK_SESSION_LINE_TYPE } from './parser.js';
/** STARMEMORY_COWORK_PATH, else ~/.config/starmemory/cowork, on the machine
 * whose Claude desktop app runs this server for Cowork. */
export function defaultCoworkRoot(env = process.env) {
    return env.STARMEMORY_COWORK_PATH ?? path.join(os.homedir(), '.config', 'starmemory', 'cowork');
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
/** The user line carries promptSource "typed", which is how the Claude parser
 * knows to keep a user turn verbatim (parser.ts, HUMAN_PROMPT_SOURCES). It is
 * the model's account of what the person asked, never an injected block. */
function entryLines({ session, title, asked, found }, now) {
    const timestamp = now.toISOString();
    const user = { type: 'user', promptSource: 'typed', sessionId: session, timestamp, message: { role: 'user', content: asked.trim() } };
    const heading = title.replace(/\s+/g, ' ').trim();
    const assistant = { type: 'assistant', sessionId: session, timestamp, message: { role: 'assistant', content: `${heading}\n\n${found.trim()}` } };
    return `${JSON.stringify(user)}\n${JSON.stringify(assistant)}\n`;
}
/** Append one entry to `session`'s record, starting the record if needed.
 * Throws RefusedError, writing nothing, for a bad key, an empty or oversize
 * field, or a session the user asked to forget. */
export function remember(root, input, { isForgotten = () => false, onStart, now = new Date() } = {}) {
    const problem = sessionKeyProblem(input.session) ?? entryProblem(input);
    if (problem)
        throw new RefusedError(problem);
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
