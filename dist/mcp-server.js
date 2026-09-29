#!/usr/bin/env node
// MCP server -- design doc §10 "与 Claude Code 集成" and §16. Exposes the same
// two tools as episodic-memory (search, read) so it's a drop-in replacement from
// the Claude Code side: hooks.json and tool schemas don't need to change. The
// same server is what Codex launches through .mcp.json; both harnesses read the
// one store under ~/.config/starmemory.
//
// Cowork reaches it through the Claude desktop app instead (cli/desktop-install.mjs),
// and since a Cowork session leaves no transcript on this machine, the server
// also takes the record itself: `remember` (src/cowork.ts). `forget`
// (src/forget.ts) takes any session back out, whichever harness it came from.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { openStore, syncCursorKey } from './store.js';
import { VectorIndex } from './vector-index.js';
import { defaultArchiveRoot, readArchive, resolveArchivePath } from './archive.js';
import { formatResults, formatMultiConceptResults } from './format-results.js';
import { isTextIndexAvailable, openVersionedTextIndex } from './text-index.js';
import { search, searchMultipleConcepts } from './search.js';
import { LIMITS, RefusedError, SESSION_KEY_PATTERN, defaultCoworkRoot, describeRemember, remember } from './cowork.js';
import { defaultForgottenPath, describeForget, forget, readForgotten } from './forget.js';
import { sessionIdsOf } from './parser.js';
import { defaultTranscriptDirs } from './sync.js';
import { canStartSync, createSyncTrigger } from './sync-trigger.js';
import { HARNESSES } from './types.js';
const DB_PATH = process.env.STARMEMORY_DB_PATH ?? path.join(os.homedir(), '.config', 'starmemory', 'store.mdb');
const INDEX_PATH = process.env.STARMEMORY_INDEX_PATH ?? path.join(os.homedir(), '.config', 'starmemory', 'index.hnsw');
// The base path only: the schema version is appended (text -> text-v2), so
// builds with different schemas never share a directory (design doc §10).
const TEXT_INDEX_PATH = process.env.STARMEMORY_TEXT_INDEX_PATH ?? path.join(os.homedir(), '.config', 'starmemory', 'text');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const ARCHIVE_ROOT = defaultArchiveRoot();
const COWORK_ROOT = defaultCoworkRoot();
const FORGOTTEN_PATH = defaultForgottenPath();
/** Read on every call, not cached: another server process (Claude Code's, or
 * the desktop app's) may have forgotten a session since. */
const forgottenNow = () => readForgotten(FORGOTTEN_PATH);
/** A remembered entry is indexed, and a forgotten session deleted, by a
 * background sync, the same one the hook runs. */
const syncSoon = createSyncTrigger();
/** Said after remember or forget when this server's copy of starmemory is gone
 * (sync-trigger.ts, canStartSync), so the sync that finishes the job cannot
 * start. Nothing is lost: the next sync from anywhere does it. */
function syncOnHoldNote(what) {
    if (canStartSync())
        return '';
    return (`\nOn hold: ${what}. The copy of starmemory this server started from has been removed, as a plugin update does, ` +
        'so it cannot start a sync. The next sync does it: the next Claude Code session on this computer, or the next remember or forget once the Claude app has been restarted.');
}
/** Where `read` opens files: the archive, and the folders sync indexes (the
 * Cowork records among them). A Cowork session reaches this server from the
 * cloud, and what it reads there can steer it, so a path it passes is not
 * taken on trust to be one that search returned. */
const READ_ROOTS = [ARCHIVE_ROOT, ...defaultTranscriptDirs()];
const TRANSCRIPT_NAME = /\.jsonl(\.gz)?$/;
/** The file the system opens for `p`. The native call resolves each link as
 * the kernel does, before any `..` after it; fs.realpathSync would drop the
 * `..` first and so could name a different file than the one read. */
function realpathOf(p) {
    try {
        return fs.realpathSync.native(p);
    }
    catch {
        return undefined;
    }
}
/** A transcript's name, under one of READ_ROOTS. `file` is checked as written,
 * or resolved (realpathOf) on both sides when it is what will be read. */
function isReadable(filePath, { resolved }) {
    const file = resolved ? filePath : path.resolve(filePath);
    if (!TRANSCRIPT_NAME.test(file))
        return false;
    return READ_ROOTS.some((root) => {
        const base = resolved ? realpathOf(root) : path.resolve(root);
        if (!base)
            return false;
        const relative = path.relative(base, file);
        return relative !== '' && relative.split(path.sep)[0] !== '..' && !path.isAbsolute(relative);
    });
}
const store = openStore(DB_PATH);
const index = VectorIndex.open(store, INDEX_PATH);
// Read-only here: the MCP server never writes the index, sync does. Several
// server processes reading the same directory is fine, tantivy readers are
// snapshot-based and take no lock (design doc §09).
const textIndex = isTextIndexAvailable() ? openVersionedTextIndex(TEXT_INDEX_PATH) : undefined;
const { version: pluginVersion } = createRequire(import.meta.url)('../package.json');
const server = new McpServer({ name: 'starmemory', version: pluginVersion });
server.registerTool('search', {
    title: 'Search Memory',
    description: 'Search past Claude Code, Codex and Cowork sessions by semantic similarity, exact text, or both. ' +
        'Pass a single string for semantic search, or an array of 2-5 concepts for AND matching. ' +
        'All harnesses share one memory; set harness to search only one of them.',
    inputSchema: {
        query: z.union([z.string().min(2), z.array(z.string().min(2)).min(2).max(5)]),
        mode: z.enum(['vector', 'text', 'hybrid', 'both']).default('hybrid'),
        limit: z.number().int().min(1).max(50).default(10),
        after: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        before: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        project: z.string().min(1).optional(),
        sessionId: z.string().min(1).optional(),
        harness: z.enum(HARNESSES).optional(),
    },
}, async ({ query, mode, limit, after, before, project, sessionId, harness }) => {
    const excludeSessions = forgottenNow();
    const text = Array.isArray(query)
        ? formatMultiConceptResults(await searchMultipleConcepts(store, index, query, { limit, project, sessionId, harness, excludeSessions }), query)
        : formatResults(await search(store, index, query, { mode, limit, after, before, project, sessionId, harness, excludeSessions }, textIndex));
    return { content: [{ type: 'text', text }] };
});
server.registerTool('read', {
    title: 'Read Full Conversation',
    description: 'Read a full conversation transcript from its archive JSONL file.',
    inputSchema: {
        path: z.string().min(1),
        startLine: z.number().int().min(1).optional(),
        endLine: z.number().int().min(1).optional(),
    },
}, async ({ path: requested, startLine, endLine }) => {
    const refused = {
        content: [{ type: 'text', text: `starmemory reads only the transcripts it indexes and its archive copies of them, and ${requested} is neither.` }],
        isError: true,
    };
    if (!isReadable(requested, { resolved: false }))
        return refused;
    // A path from an older result may name a source transcript Claude Code has
    // since cleaned up; the archive keeps a copy under every harness.
    let filePath = requested;
    if (!fs.existsSync(filePath)) {
        const project = path.basename(path.dirname(requested));
        for (const harness of HARNESSES) {
            const candidate = resolveArchivePath(ARCHIVE_ROOT, requested, harness, project);
            if (candidate !== requested) {
                filePath = candidate;
                break;
            }
        }
    }
    if (!fs.existsSync(filePath)) {
        return {
            content: [{ type: 'text', text: `File not found: ${requested} (the original transcript was cleaned up and no archive copy exists)` }],
            isError: true,
        };
    }
    // What is checked is what is read: the resolved file, not the path as given.
    const real = realpathOf(filePath);
    if (!real || !isReadable(real, { resolved: true }))
        return refused;
    // Between a forget and the sync that deletes the rest, a path from an
    // earlier result, a Claude Code or Codex transcript among them, still
    // opens. It must not.
    const text = readArchive(real);
    const forgotten = forgottenNow();
    const sessions = [...(await sessionIdsOf(real, text)), ...(await sessionIdsOf(filePath, ''))];
    if (sessions.some((session) => forgotten.has(session))) {
        return { content: [{ type: 'text', text: 'The user asked to forget that session, so it is not shown.' }], isError: true };
    }
    const lines = text.split('\n');
    const start = (startLine ?? 1) - 1;
    const end = endLine ?? lines.length;
    return { content: [{ type: 'text', text: lines.slice(start, end).join('\n') }] };
});
server.registerTool('remember', {
    title: 'Remember This Session',
    description: 'Record this Cowork session as it goes, one entry per call. Cowork keeps no transcript on this machine, so this ' +
        'record is all a session leaves behind: write the first entry as soon as the session has a subject, then one at ' +
        'each decision, finding, dead end or milestone, and before anything long. Each call adds an entry; do not repeat ' +
        'earlier ones. Write a summary with the exact strings worth searching for later (error messages, file paths, ' +
        'versions, commands), never the transcript. Not for Claude Code or Codex, whose transcripts are indexed on their own.',
    inputSchema: {
        session: z
            .string()
            .regex(SESSION_KEY_PATTERN)
            .describe('This session\'s key, the same on every call: the session id from the starmemory start-up line.'),
        title: z.string().min(1).max(LIMITS.title).describe('One line: what this session is about.'),
        asked: z.string().min(1).max(LIMITS.asked).describe('What the user asked that this entry answers, in their words where possible.'),
        found: z
            .string()
            .min(1)
            .max(LIMITS.found)
            .describe('What was found, decided, built or left open since the last entry, with exact strings: errors, paths, versions, commands.'),
        project: z
            .string()
            .min(1)
            .max(LIMITS.project)
            .optional()
            .describe('The repo or subject, the same across sessions about it, e.g. "starmemory". Defaults to "general".'),
    },
}, async (input) => {
    try {
        const result = remember(COWORK_ROOT, input, {
            isForgotten: (session) => forgottenNow().has(session),
            onStart: (file) => store.meta.remove(syncCursorKey(file)),
        });
        syncSoon();
        return { content: [{ type: 'text', text: describeRemember(result) + syncOnHoldNote('indexing this entry, which is saved') }] };
    }
    catch (error) {
        if (error instanceof RefusedError)
            return { content: [{ type: 'text', text: error.message }], isError: true };
        throw error;
    }
});
server.registerTool('forget', {
    title: 'Forget a Session',
    description: 'Forget a session when the user asks not to record it, in any words ("don\'t record this", "keep this off the ' +
        'record", "forget this conversation"). Its Cowork record, archive copy and summary are removed at once and it ' +
        'leaves search results from that moment; a background sync then deletes its indexed exchanges and their ' +
        'text-index entries. remember refuses it afterwards. For a Claude Code or Codex session, pass that session\'s ' +
        'id: its transcript stays where the harness keeps it, but starmemory never indexes it again.',
    inputSchema: {
        session: z
            .string()
            .regex(SESSION_KEY_PATTERN)
            .describe('The session to forget: this session\'s key as used with remember, or a Claude Code or Codex session id.'),
    },
}, async ({ session }) => {
    try {
        const result = forget(session, { coworkRoot: COWORK_ROOT, forgottenPath: FORGOTTEN_PATH, archiveRoot: ARCHIVE_ROOT, store });
        syncSoon();
        const note = result.pendingRows > 0 ? syncOnHoldNote('deleting the indexed exchanges, which stay hidden until then') : '';
        return { content: [{ type: 'text', text: describeForget(result) + note }] };
    }
    catch (error) {
        if (error instanceof RefusedError)
            return { content: [{ type: 'text', text: error.message }], isError: true };
        throw error;
    }
});
const transport = new StdioServerTransport();
await server.connect(transport);
