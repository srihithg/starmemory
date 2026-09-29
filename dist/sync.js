// Incremental indexing of the local JSONL transcripts of both harnesses --
// design doc §01/§08/§16. Multiple `sync` processes can run concurrently (one
// per SessionStart hook firing, from Claude Code or from Codex) with no
// app-level lock: LMDB's single-writer transaction is enforced by the engine
// itself (flock), unlike episodic-memory's hand-rolled file-lock.ts.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { detectHarness, parseConversation, projectFromPath, sessionsOfName, walkJsonlFiles } from './parser.js';
import { archivePathFor, copyIfChanged, defaultArchiveRoot, summaryPathFor } from './archive.js';
import { defaultCoworkRoot, defaultQuarantineRoot, purgeQuarantine, quarantineIfUnchanged, recordIdentity, removeIfUnchanged } from './cowork.js';
import { defaultForgottenPath, forgetSessions, isForgotten, readForgotten } from './forget.js';
import { DEFAULT_SUMMARY_LIMIT, summarizeQuietConversations } from './summaries.js';
import { defaultTtlDays, expireOldConversations, ttlCutoffMs } from './ttl.js';
import { EMBEDDING_MODEL, generateExchangeEmbedding } from './embeddings.js';
import { HARNESS_INDEX_KEY, exchangesFrom, insertExchangesForFile, nextId, putVector, reindexHarness, syncCursorKey, } from './store.js';
/** Where Claude Code and Codex keep their transcripts. The overrides are the
 * ones the harnesses themselves honour, so a profile that moved its config
 * dir still gets indexed. */
export function harnessTranscriptDirs(env = process.env) {
    // Windows sets USERPROFILE, not HOME; os.homedir() is the last word.
    const home = env.HOME ?? env.USERPROFILE ?? os.homedir();
    return {
        claude: path.join(env.CLAUDE_CONFIG_DIR ?? path.join(home, '.claude'), 'projects'),
        codex: path.join(env.CODEX_HOME ?? path.join(home, '.codex'), 'sessions'),
    };
}
/** Where each harness keeps its transcripts. Missing directories are fine:
 * walkJsonlFiles yields nothing. Cowork writes nothing to this machine, so its
 * entry is the records the `remember` tool keeps (src/cowork.ts). */
export function defaultTranscriptDirs(env = process.env) {
    const { claude, codex } = harnessTranscriptDirs(env);
    return [claude, codex, defaultCoworkRoot(env)];
}
/** Which embedding model every vector in the store came from. */
export const EMBEDDING_MODEL_KEY = 'embedding_model';
/** Bring every stored vector onto the current embedding model.
 *
 * Vectors from different models cannot be compared, so a model change means
 * re-embedding the whole store, not just new rows. A store with no recorded
 * model is treated the same way: it predates this check, so its vectors are
 * assumed stale. Subagent turns get no vector, matching insertExchange(). */
export async function ensureEmbeddingModel(store) {
    const recorded = store.meta.get(EMBEDDING_MODEL_KEY);
    if (recorded === EMBEDDING_MODEL)
        return { reembedded: 0 };
    let reembedded = 0;
    for (const exchange of exchangesFrom(store, 0)) {
        if (exchange.isSidechain)
            continue;
        const embedding = await generateExchangeEmbedding(exchange.userMessage, exchange.assistantMessage);
        putVector(store, exchange.id, embedding);
        reembedded++;
    }
    store.meta.putSync(EMBEDDING_MODEL_KEY, EMBEDDING_MODEL);
    return { reembedded };
}
/** Next exchange id the text index for one schema version has not seen. Kept
 * in LMDB, not in tantivy, because LMDB is the source of truth (design doc §09).
 * One key per schema version, to match the one directory per schema version
 * (versionedTextIndexDir): a v1 and a v2 index each advance their own cursor,
 * so neither mistakes the other's progress for its own. */
export function textCursorKey(version) {
    return `text_index_cursor:v${version}`;
}
/** Bring the BM25 index up to date with LMDB.
 *
 * The whole design of this function is "whoever gets the lock does the work
 * everyone else could not do". A process that cannot take the lock returns
 * immediately without touching the cursor, so its rows stay pending and the next
 * lock holder indexes them from the cursor forward (design doc §09). */
export function syncTextIndex(store, index) {
    if (!index.tryAcquireWriter()) {
        return { skipped: true, rebuilt: false, indexed: 0 };
    }
    const cursorKey = textCursorKey(index.version);
    let cursor = store.meta.get(cursorKey) ?? 0;
    let rebuilt = false;
    if (cursor > 0 && index.numDocs() === 0) {
        // LMDB remembers indexing rows this directory does not hold: it was wiped,
        // or it is the first open of this schema's directory. The index is a cache
        // over LMDB, so reload everything rather than trust the cursor.
        cursor = 0;
        rebuilt = true;
    }
    const pending = exchangesFrom(store, cursor);
    if (pending.length > 0) {
        index.addExchanges(pending);
    }
    // One commit per batch: it fsyncs, so doing it per document would dominate.
    index.commit();
    if (pending.length > 0) {
        store.meta.putSync(cursorKey, pending[pending.length - 1].id + 1);
    }
    return { skipped: false, rebuilt, indexed: pending.length };
}
/** What a detached sync waits for the text-index writer, at most. The holder
 * may be minutes into its summary step, but it takes on what arrived meanwhile
 * before it exits (see syncAll), so this only has to outlast a holder that is
 * about to exit. */
export const WRITER_WAIT_MS = 30_000;
const WRITER_POLL_MS = 500;
/** Take the writer another process holds, polling until `waitMs` is up:
 * tantivy has no blocking acquire. Timed by performance.now(), which a clock
 * set back cannot stretch. */
async function waitForWriter(textIndex, waitMs) {
    const deadline = performance.now() + waitMs;
    for (;;) {
        if (textIndex.tryAcquireWriter())
            return true;
        const left = deadline - performance.now();
        if (left <= 0)
            return false;
        await new Promise((resolve) => setTimeout(resolve, Math.min(WRITER_POLL_MS, left)));
    }
}
function* walkAll(dirs, skip) {
    for (const dir of dirs)
        yield* walkJsonlFiles(dir, skip);
}
/** Remove a Cowork record and its cursor, if nothing was written to it since
 * `seen`, the stat it was judged by (removeIfUnchanged): a remember may add an
 * entry while the sync works on the record, and is told it was recorded. A
 * record started later under the same key is a new file whose lines count
 * from 1 again; the old cursor would skip them. Returns true when it went. */
function dropRecord(store, filePath, seen) {
    if (!removeIfUnchanged(filePath, seen))
        return false;
    store.meta.remove(syncCursorKey(filePath));
    return true;
}
/** A record of a forgotten session still in the records folder: one a forget
 * could not set aside, or one a remember that raced the forget wrote. Set
 * aside as a forget from Cowork does, keeping its cursor as that does
 * (forget.ts), so it can still be brought back; deleted only when the
 * quarantine keeps nothing, at 0 days or when none was named. Either way only
 * if nothing was written to it since `seen` (removeIfUnchanged): the forget
 * may have been taken back meanwhile, and an entry added that the user was
 * told is recorded. A move that fails leaves the record hidden where it is,
 * for the next sync to try again, as does a record that changed. */
function setAsideForgotten(store, filePath, seen, quarantine, now, log) {
    if (!quarantine || quarantine.days <= 0) {
        dropRecord(store, filePath, seen);
        return;
    }
    try {
        const setAside = quarantineIfUnchanged(filePath, seen, quarantine, new Date(now));
        if (setAside)
            log(`starmemory: set ${filePath} aside as ${setAside.to}, since its session is forgotten`);
    }
    catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        log(`starmemory: could not set ${filePath} aside (${reason}); its session is forgotten, so it stays hidden, and the next sync tries again`);
    }
}
function isInside(child, parent) {
    const relative = path.relative(parent, child);
    return relative !== '' && relative.split(path.sep)[0] !== '..' && !path.isAbsolute(relative);
}
/** One transcript: copy it into the archive and store the exchanges past its
 * cursor. */
async function syncTranscript(store, filePath, { archiveRoot, coworkRoot, cutoff, forgotten, forgottenNow, quarantine, now, log, }) {
    // Already past the TTL before we ever saw it: not copied, not indexed.
    // Only matters when Claude Code's own 30-day cleanup is turned off.
    const seen = fs.statSync(filePath);
    if (seen.mtimeMs < cutoff) {
        // A Cowork record is starmemory's own file, so it leaves with its rows
        // (expireOldConversations). A harness's transcript is the harness's to
        // clean. Where the file lives says which it can be, so the old rollouts
        // Codex never deletes are not opened on every sync to find out.
        if (!isInside(filePath, coworkRoot) || (await detectHarness(filePath)) !== 'cowork')
            return { indexed: 0, archived: false };
        // Not removed, as when it was written to since its age was read: it is
        // synced as any other record, which also renews the archive copy the
        // TTL goes by.
        if (dropRecord(store, filePath, seen))
            return { indexed: 0, archived: false };
    }
    const project = projectFromPath(filePath);
    // A Cowork record can be forgotten, and a new one started under its key,
    // while this sync parses and embeds it. The new one counts its lines from
    // 1, so rows of the old one stored against its cursor would come back and
    // push the cursor past the new entries. The record is named before the
    // cursor is read, which a new record's start clears, and checked again
    // just before the insert.
    const record = isInside(filePath, coworkRoot) ? recordIdentity(filePath) : undefined;
    // This read is only an optimisation, to avoid embedding rows another sync
    // has already stored. The authoritative check is inside the insert
    // transaction below, which re-reads the cursor under LMDB's write lock.
    const cursor = store.meta.get(syncCursorKey(filePath)) ?? 0;
    // Parse the source, then copy it into the archive and point every row at
    // the copy. The project comes from the parse, not the path: a Codex rollout
    // sits under a date directory, its project is the cwd in session_meta. The
    // cursor stays keyed by the source path: switching the key would make every
    // file look new on the first sync after this change and double every row.
    const lineSessions = new Set();
    const parsed = await parseConversation(filePath, project, filePath, lineSessions);
    const harness = parsed[0]?.harness ?? (await detectHarness(filePath));
    const resolvedProject = parsed[0]?.project ?? project;
    const copy = archivePathFor(archiveRoot, harness, resolvedProject, filePath);
    // A session the user asked to forget is not copied or indexed again. Its
    // Cowork record is ours, so that is set aside too: it is still here when a
    // forget could not move it, or a remember raced the forget. A transcript a
    // harness wrote is the harness's to keep, and its cursor stays: taking the
    // session off the list resumes indexing from there, and what the forget
    // deleted is not brought back, so nothing is ever indexed twice. Whose it
    // is: its name and every session any of its lines records, as read and the
    // summaries also go by (forget.ts, isForgotten), since the copy would hold
    // all of it. A match on this sync's list, read when it started, is
    // confirmed on the list as it is now: the user may have taken the forget
    // back since, and written a new record.
    const sessions = [...new Set([...sessionsOfName(filePath), ...lineSessions])];
    const leaveOut = () => {
        // Only a file in the records folder is ours, as with the TTL above: one
        // elsewhere that reads as a record is still a file some harness wrote.
        if (harness === 'cowork' && isInside(filePath, coworkRoot))
            setAsideForgotten(store, filePath, seen, quarantine, now, log);
        for (const file of [copy, summaryPathFor(copy)])
            fs.rmSync(file, { force: true });
        return { indexed: 0, archived: false };
    };
    const onListNow = () => isForgotten(sessions, forgottenNow());
    if (isForgotten(sessions, forgotten) && onListNow())
        return leaveOut();
    const archived = await copyIfChanged(filePath, copy);
    // A forget that landed while the copy was being made found no copy to
    // remove, and this sync's list predates it. Asked again once the copy is in.
    if (archived && onListNow())
        return leaveOut();
    const exchanges = parsed.map((e) => ({ ...e, archivePath: copy }));
    const candidate = {
        archivePath: copy,
        harness,
        project: resolvedProject,
        sessionId: exchanges[0]?.sessionId,
        sessions,
        sourceMtimeMs: fs.statSync(filePath).mtimeMs,
    };
    const newExchanges = exchanges.filter((e) => e.lineEnd > cursor);
    if (newExchanges.length === 0)
        return { indexed: 0, archived, candidate };
    const pending = [];
    for (const exchange of newExchanges) {
        // Subagent turns are never returned by vector search, so embedding them
        // would be paying the slowest part of sync for nothing.
        const embedding = exchange.isSidechain
            ? null
            : await generateExchangeEmbedding(exchange.userMessage, exchange.assistantMessage);
        pending.push({ exchange: { ...exchange, embeddingVersion: 1 }, embedding });
    }
    // Not the record that was parsed any more, or gone: nothing is stored and
    // the cursor stays as it is, for the next sync to go by. Nothing is awaited
    // between this check and the insert, and the insert cannot take the check
    // into its transaction.
    if (record !== undefined && recordIdentity(filePath) !== record)
        return { indexed: 0, archived, candidate };
    const { ids } = insertExchangesForFile(store, filePath, pending);
    return { indexed: ids.length, archived, candidate };
}
/** A transcript that was listed by the walk but is gone by the time it is
 * read. The walk is lazy, so this happens: Claude Code cleans up old sessions,
 * and a Cowork record goes the moment the user asks to forget it. */
function vanished(error) {
    return error?.code === 'ENOENT';
}
/** Scans every transcript of every harness, inserts exchanges past each file's
 * last-synced cursor, and rebuilds the vector index once at the end (design doc
 * §07: rebuilding from scratch is a sub-second operation at this scale, so
 * there's no need for incremental graph maintenance). */
export async function syncAll(store, index, transcriptsDirs = defaultTranscriptDirs(), textIndex, options = {}) {
    let filesScanned = 0;
    let exchangesIndexed = 0;
    let archived = 0;
    const archiveRoot = options.archiveRoot ?? defaultArchiveRoot();
    const coworkRoot = options.coworkRoot ?? defaultCoworkRoot();
    const candidates = [];
    const ttlDays = options.ttl?.days ?? defaultTtlDays();
    const now = options.ttl?.now ?? Date.now();
    const cutoff = ttlDays > 0 ? ttlCutoffMs(ttlDays, now) : Number.NEGATIVE_INFINITY;
    const forgottenPath = options.forgottenPath ?? defaultForgottenPath();
    const forgotten = readForgotten(forgottenPath);
    const log = options.log ?? ((line) => process.stderr.write(`${line}\n`));
    const quarantine = options.quarantine;
    if (quarantine) {
        for (const file of purgeQuarantine(quarantine, now)) {
            log(`starmemory: deleted ${file}, a Cowork record a forget set aside, now that its time there is up`);
        }
    }
    // Before touching anything else: if the model changed, every existing vector
    // is stale and the graph built from them would be meaningless.
    const migration = await ensureEmbeddingModel(store);
    // Rows written before Codex support have no harness index entry. Backfill
    // once; the key makes every later sync skip the walk (design doc §16).
    if (store.meta.get(HARNESS_INDEX_KEY) !== 1) {
        reindexHarness(store);
        store.meta.putSync(HARNESS_INDEX_KEY, 1);
    }
    const dirs = Array.isArray(transcriptsDirs) ? transcriptsDirs : [transcriptsDirs];
    for (const filePath of walkAll(dirs, quarantine?.root ?? defaultQuarantineRoot())) {
        filesScanned++;
        let outcome;
        try {
            outcome = await syncTranscript(store, filePath, {
                archiveRoot,
                coworkRoot,
                cutoff,
                forgotten,
                forgottenNow: () => readForgotten(forgottenPath),
                quarantine,
                now,
                log,
            });
        }
        catch (error) {
            // Nothing is left to index, and one missing file must not stop the rest.
            if (!vanished(error))
                throw error;
            log(`starmemory: ${filePath} went away while it was being synced; skipped`);
            continue;
        }
        exchangesIndexed += outcome.indexed;
        if (outcome.archived)
            archived++;
        if (outcome.candidate)
            candidates.push(outcome.candidate);
    }
    // Forgotten sessions, then expiry, before the graph rebuild, so the rebuild
    // already reflects both. Each takes the text writer, and syncTextIndex
    // reuses the same handle's lock. Always attempt the text sync, even when we
    // added nothing: another process may have written rows it could not index,
    // and we may be the one holding the lock now.
    // The list as it is now, not as it was when this sync started: a session
    // taken off it meanwhile keeps its rows.
    const forgetNow = () => forgetSessions(store, textIndex, readForgotten(forgottenPath), { archiveRoot, coworkRoot, log });
    const expire = () => expireOldConversations(store, textIndex, { ttlDays, now, archiveRoot, log: options.ttl?.log ?? log });
    let forgetting = forgetNow();
    let expiry = expire();
    let textSync = textIndex ? syncTextIndex(store, textIndex) : undefined;
    // Where the store was when this sync last built the vector graph: rows past
    // it were stored by another sync meanwhile (see the late pass).
    let builtAt;
    const rebuild = () => {
        builtAt = nextId(store);
        index.rebuild(store);
    };
    if (exchangesIndexed > 0 || migration.reembedded > 0 || expiry.rows > 0 || forgetting.rows > 0)
        rebuild();
    // Another process has the writer. Its rows are no worry, it indexes them
    // itself, but ours and our deletions would wait for whichever sync comes
    // next. A detached sync waits a little for the writer instead, after the
    // vector rebuild, so a new entry is found by meaning in the meantime.
    const writerWaitMs = options.writerWaitMs ?? 0;
    if (textIndex && writerWaitMs > 0 && (forgetting.skipped || expiry.skipped || (textSync?.skipped && exchangesIndexed > 0))) {
        log(`starmemory: another sync holds the text-index writer; waiting up to ${Math.round(writerWaitMs / 1000)} s for it`);
        const waitStarted = performance.now();
        if (await waitForWriter(textIndex, writerWaitMs)) {
            log(`starmemory: took the text-index writer after ${((performance.now() - waitStarted) / 1000).toFixed(1)} s`);
            let removed = 0;
            if (forgetting.skipped)
                removed += (forgetting = forgetNow()).rows;
            if (expiry.skipped)
                removed += (expiry = expire()).rows;
            if (removed > 0)
                rebuild();
            textSync = syncTextIndex(store, textIndex);
        }
        else {
            log('starmemory: the text-index writer stayed busy; this is left to the sync holding it, or a later one');
        }
    }
    // Last, and bounded: a few quiet conversations get a summary. Never blocks
    // indexing; a failure is a sentinel file and a log line. A session forgotten
    // while this runs is not sent to a model after all.
    const envLimit = Number(process.env.STARMEMORY_SUMMARY_LIMIT);
    const limit = options.summaries?.limit ?? (Number.isFinite(envLimit) && process.env.STARMEMORY_SUMMARY_LIMIT !== undefined ? envLimit : DEFAULT_SUMMARY_LIMIT);
    const summaries = await summarizeQuietConversations(candidates, {
        skip: (c) => isForgotten([c.sessionId, ...(c.sessions ?? [])], readForgotten(forgottenPath)),
        ...options.summaries,
        limit,
    });
    // What arrived while this sync ran: sessions forgotten meanwhile, rows other
    // syncs stored but could not index. They could not take the writer, since
    // tantivy keeps it until this process exits, so the work is ours. Cheap when
    // there is none: a walk over the stored rows, only while some session is
    // forgotten, and an empty text sync.
    // Both or neither: a writer freed between the two must not have this sync
    // index the rows of a session it could not delete. Rows another sync stored
    // after this one built its graph get a rebuild too: two syncs rebuilding at
    // once each name their own graph, and the later name wins even when its
    // graph is the older one.
    const late = forgetNow();
    const lateText = textIndex && !late.skipped ? syncTextIndex(store, textIndex) : undefined;
    if (late.rows > 0 || (builtAt !== undefined && nextId(store) > builtAt))
        rebuild();
    return {
        filesScanned,
        exchangesIndexed,
        archived,
        summarized: summaries.written,
        summaryFailed: summaries.failed,
        expired: expiry.rows,
        expiredFiles: expiry.files,
        expireSkipped: expiry.skipped,
        forgotten: forgetting.rows + late.rows,
        forgottenFiles: forgetting.files + late.files,
        // The last pass covers every forgotten session, so it alone says whether
        // any of them is still stored.
        forgetSkipped: late.skipped,
        reembedded: migration.reembedded,
        textIndexed: (textSync?.indexed ?? 0) + (lateText?.indexed ?? 0),
        textSkipped: late.skipped || (lateText?.skipped ?? false),
    };
}
