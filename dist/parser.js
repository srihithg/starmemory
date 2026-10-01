import { openArchive } from './archive.js';
import path from 'node:path';
import readline from 'node:readline';
/** How a person's own message is marked. This is a whitelist on purpose: a
 * blacklist of markers is always one Claude Code release behind, and some
 * injected kinds (slash-command echoes) carry no structural flag at all. */
const HUMAN_PROMPT_SOURCES = ['typed', 'queued'];
/** Only consulted for entries that carry no `promptSource` at all, which is how
 * older transcripts look. */
export const INJECTED_MARKERS = [
    '<task-notification>',
    '<command-name>',
    '<local-command',
    '<system-reminder>',
];
/** Tags inside a task notification that hold something a person would search for.
 * `result` is the big one: it carries the subagent's actual report, which is
 * often the most valuable text in the whole record, and `summary` says which
 * task it was. Everything else is identifiers, temp paths, token counts, or
 * `note`, which is the same fixed sentence on every notification explaining to
 * the model what a notification is. */
const NOTIFICATION_CONTENT_TAGS = ['summary', 'result'];
export function isInjectedUserTurn(entry, text) {
    if (entry.promptSource !== undefined) {
        return !HUMAN_PROMPT_SOURCES.includes(entry.promptSource);
    }
    if (entry.isMeta)
        return true;
    return INJECTED_MARKERS.some((marker) => text.includes(marker));
}
function innerText(text, tag) {
    const found = [];
    const pattern = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'g');
    for (const match of text.matchAll(pattern)) {
        const inner = match[1].trim();
        if (inner)
            found.push(inner);
    }
    return found;
}
/** The part of an injected block worth indexing. Returns '' when there is none,
 * which is the honest answer for a system reminder: it is an instruction to the
 * model, not something anyone would search for. */
export function payloadOfInjectedTurn(text) {
    if (text.includes('<task-notification>')) {
        // Strip the wrapper first, or its lazy closing tag swallows every inner tag.
        const body = text
            .replace(/^[\s\S]*?<task-notification>/, '')
            .replace(/<\/task-notification>[\s\S]*$/, '');
        return NOTIFICATION_CONTENT_TAGS.flatMap((tag) => innerText(body, tag)).join('\n\n');
    }
    const [command] = innerText(text, 'command-name');
    if (command) {
        const [args] = innerText(text, 'command-args');
        return args ? `${command} ${args}` : command;
    }
    const [stdout] = innerText(text, 'local-command-stdout');
    if (stdout)
        return stdout;
    return '';
}
function extractText(content) {
    if (typeof content === 'string')
        return content;
    return content
        .filter((block) => block.type === 'text' && block.text)
        .map((block) => block.text)
        .join('\n');
}
/** The line types only a Codex rollout has. A Claude Code transcript line has
 * `type: "user" | "assistant" | ...` and a `message`, never a `payload`. */
const CODEX_LINE_TYPES = new Set(['session_meta', 'turn_context', 'response_item', 'event_msg', 'compacted']);
/** The first line of every Cowork record, and the only thing that tells one
 * apart from a Claude Code transcript: the lines after it are the same shape. */
export const COWORK_SESSION_LINE_TYPE = 'cowork_session';
/** Reads the first parseable line and decides which format the file is in.
 * Unknown or empty files are read as Claude, the format that existed first.
 * Works on an archive copy too, since openArchive undoes the gzip. */
export async function detectHarness(filePath) {
    // Destroyed on the way out: readline's close leaves the file open, and a
    // sync calls this for every transcript it walks.
    const input = openArchive(filePath);
    const rl = readline.createInterface({ input, crlfDelay: Infinity });
    try {
        for await (const line of rl) {
            if (!line.trim())
                continue;
            try {
                const parsed = JSON.parse(line);
                if (parsed.type === COWORK_SESSION_LINE_TYPE)
                    return 'cowork';
                return parsed.payload && parsed.type && CODEX_LINE_TYPES.has(parsed.type) ? 'codex' : 'claude';
            }
            catch {
                continue;
            }
        }
    }
    finally {
        rl.close();
        input.destroy();
    }
    return 'claude';
}
/** How many lines from the top of a transcript say whose it is. */
const SESSION_ID_LINES = 50;
/** The session ids a transcript's lines record: the sessionId on Claude Code's
 * lines (in a subagent's file, the parent session's), a Cowork record's header,
 * and the session_meta a Codex rollout starts with, whose file name ends in the
 * id but does not equal it. */
function sessionIdsInLines(lines) {
    const ids = new Set();
    for (const line of lines) {
        let parsed;
        try {
            parsed = JSON.parse(line);
        }
        catch {
            continue;
        }
        const found = [
            parsed.sessionId,
            parsed.type === COWORK_SESSION_LINE_TYPE ? parsed.session : undefined,
            parsed.type === 'session_meta' ? parsed.payload?.id : undefined,
        ];
        for (const id of found)
            if (typeof id === 'string' && id !== '')
                ids.add(id);
    }
    return ids;
}
/** The sessions a transcript or archive copy belongs to: its file name, which
 * is the id for Claude Code and Cowork, and the ids its first lines record
 * (sessionIdsInLines). `text`, when the caller has the file's text already. */
export async function sessionIdsOf(filePath, text) {
    const name = path.basename(filePath).replace(/\.gz$/, '').replace(/\.jsonl$/, '');
    if (text !== undefined)
        return new Set([name, ...sessionIdsInLines(text.split('\n', SESSION_ID_LINES))]);
    const head = [];
    const input = openArchive(filePath);
    const rl = readline.createInterface({ input, crlfDelay: Infinity });
    try {
        for await (const line of rl) {
            head.push(line);
            if (head.length >= SESSION_ID_LINES)
                break;
        }
    }
    finally {
        rl.close();
        input.destroy();
    }
    return new Set([name, ...sessionIdsInLines(head)]);
}
export async function parseConversation(filePath, project, archivePath) {
    const harness = await detectHarness(filePath);
    if (harness === 'codex') {
        return parseCodexConversation(filePath, project, archivePath);
    }
    return parseClaudeConversation(filePath, project, archivePath, harness);
}
/** Codex message content is a list of typed blocks (`input_text`, `output_text`).
 * Anything carrying a `text` string counts; the block type names have changed
 * across Codex releases and none of them is worth filtering on. */
function codexText(content) {
    if (typeof content === 'string')
        return content;
    if (!Array.isArray(content))
        return '';
    return content
        .filter((b) => b && typeof b === 'object' && typeof b.text === 'string')
        .map((b) => b.text)
        .join('\n');
}
/** Codex rollouts. The project is the basename of the session's `cwd`, which is
 * the closest thing to Claude Code's per-project folder; the caller's guess
 * from the file path is only the fallback. Tool calls and reasoning blocks are
 * skipped: they are not what a person would search for. */
async function parseCodexConversation(filePath, fallbackProject, archivePath) {
    const exchanges = [];
    const rl = readline.createInterface({ input: openArchive(filePath), crlfDelay: Infinity });
    let lineNumber = 0;
    let project = fallbackProject;
    let sessionId;
    let gitBranch;
    let current = null;
    const finalize = () => {
        if (current && current.assistantMessages.length > 0) {
            exchanges.push({
                harness: 'codex',
                project,
                sessionId,
                gitBranch,
                timestamp: current.timestamp,
                userMessage: current.userMessage,
                userIsInjected: false,
                assistantMessage: current.assistantMessages.join('\n\n'),
                archivePath,
                lineStart: current.userLine,
                lineEnd: current.lastAssistantLine,
            });
        }
        current = null;
    };
    for await (const line of rl) {
        lineNumber++;
        if (!line.trim())
            continue;
        let parsed;
        try {
            parsed = JSON.parse(line);
        }
        catch {
            continue;
        }
        const payload = parsed.payload;
        if (!payload)
            continue;
        if (parsed.type === 'session_meta' || parsed.type === 'turn_context') {
            if (payload.cwd)
                project = path.basename(payload.cwd) || project;
            if (parsed.type === 'session_meta') {
                sessionId = payload.id ?? sessionId;
                gitBranch = payload.git?.branch ?? gitBranch;
            }
            continue;
        }
        if (parsed.type !== 'response_item' || payload.type !== 'message')
            continue;
        const text = codexText(payload.content);
        if (!text.trim())
            continue;
        const timestamp = parsed.timestamp ?? new Date().toISOString();
        if (payload.role === 'user') {
            finalize();
            current = {
                userMessage: text,
                userIsInjected: false,
                userLine: lineNumber,
                assistantMessages: [],
                lastAssistantLine: lineNumber,
                timestamp,
            };
        }
        else if (payload.role === 'assistant' && current) {
            current.assistantMessages.push(text);
            current.lastAssistantLine = lineNumber;
            current.timestamp = timestamp;
        }
    }
    finalize();
    return exchanges;
}
/** Claude Code transcripts, and Cowork records, which are written in the same
 * line shape (src/cowork.ts); `harness` is the only difference. The record's
 * cowork_session line has no `message`, so it is skipped like any other
 * bookkeeping line. */
async function parseClaudeConversation(filePath, project, archivePath, harness = 'claude') {
    const exchanges = [];
    const rl = readline.createInterface({
        input: openArchive(filePath),
        crlfDelay: Infinity,
    });
    let lineNumber = 0;
    let current = null;
    const finalize = () => {
        if (current && current.assistantMessages.length > 0) {
            exchanges.push({
                harness,
                project,
                sessionId: current.sessionId,
                gitBranch: current.gitBranch,
                timestamp: current.timestamp,
                userMessage: current.userMessage,
                userIsInjected: current.userIsInjected,
                assistantMessage: current.assistantMessages.join('\n\n'),
                archivePath,
                lineStart: current.userLine,
                lineEnd: current.lastAssistantLine,
                isSidechain: current.isSidechain,
            });
        }
    };
    for await (const line of rl) {
        lineNumber++;
        if (!line.trim())
            continue;
        let parsed;
        try {
            parsed = JSON.parse(line);
        }
        catch {
            continue; // malformed line, skip
        }
        if (parsed.type !== 'user' && parsed.type !== 'assistant')
            continue;
        if (!parsed.message)
            continue;
        // Claude's own compaction recap sits in a user-role entry. It is not what
        // the person said, and it repeats turns that are already in the file.
        if (parsed.isCompactSummary)
            continue;
        const text = extractText(parsed.message.content);
        if (!text.trim())
            continue;
        if (parsed.message.role === 'user') {
            finalize();
            const injected = isInjectedUserTurn(parsed, text);
            current = {
                // An injected block is kept only as its meaningful payload. Storing the
                // raw text would claim the user said something they never typed, and it
                // is what made search snippets unreadable.
                userMessage: injected ? payloadOfInjectedTurn(text) : text,
                userIsInjected: injected,
                userLine: lineNumber,
                assistantMessages: [],
                lastAssistantLine: lineNumber,
                timestamp: parsed.timestamp ?? new Date().toISOString(),
                isSidechain: parsed.isSidechain,
                sessionId: parsed.sessionId,
                gitBranch: parsed.gitBranch,
            };
        }
        else if (parsed.message.role === 'assistant' && current) {
            current.assistantMessages.push(text);
            current.lastAssistantLine = lineNumber;
            if (parsed.timestamp)
                current.timestamp = parsed.timestamp;
        }
    }
    finalize();
    return exchanges;
}
/** Derives a project name the same way episodic-memory does: the JSONL file's
 * parent directory name (Claude Code's sanitized-cwd slug). */
export function projectFromPath(filePath) {
    // path.basename(path.dirname()) rather than a split on '/', so a Windows
    // path yields its parent directory too.
    const parent = path.basename(path.dirname(filePath));
    return parent && parent !== '.' && parent !== path.sep ? parent : 'unknown';
}
