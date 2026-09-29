// Incremental indexing of the local JSONL transcripts of both harnesses --
// design doc §01/§08/§16. Multiple `sync` processes can run concurrently (one
// per SessionStart hook firing, from Claude Code or from Codex) with no
// app-level lock: LMDB's single-writer transaction is enforced by the engine
// itself (flock), unlike episodic-memory's hand-rolled file-lock.ts.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { detectHarness, parseConversation, projectFromPath, sessionIdsOf, walkJsonlFiles } from './parser.js';
import { archivePathFor, copyIfChanged, defaultArchiveRoot, summaryPathFor } from './archive.js';
import { defaultCoworkRoot } from './cowork.js';
import { defaultForgottenPath, forgetSessions, readForgotten } from './forget.js';
import { DEFAULT_SUMMARY_LIMIT, summarizeQuietConversations, type SummaryCandidate, type SummaryOptions } from './summaries.js';
import { defaultTtlDays, expireOldConversations, ttlCutoffMs } from './ttl.js';
import { EMBEDDING_MODEL, generateExchangeEmbedding } from './embeddings.js';
import {
  HARNESS_INDEX_KEY,
  exchangesFrom,
  insertExchangesForFile,
  nextId,
  putVector,
  reindexHarness,
  syncCursorKey,
  type StoreHandle,
} from './store.js';
import { VectorIndex } from './vector-index.js';
import { TextIndex } from './text-index.js';

/** Where Claude Code and Codex keep their transcripts. The overrides are the
 * ones the harnesses themselves honour, so a profile that moved its config
 * dir still gets indexed. */
export function harnessTranscriptDirs(env: NodeJS.ProcessEnv = process.env): { claude: string; codex: string } {
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
export function defaultTranscriptDirs(env: NodeJS.ProcessEnv = process.env): string[] {
  const { claude, codex } = harnessTranscriptDirs(env);
  return [claude, codex, defaultCoworkRoot(env)];
}

/** Which embedding model every vector in the store came from. */
export const EMBEDDING_MODEL_KEY = 'embedding_model';

export interface EmbeddingMigrationResult {
  /** Exchanges whose vector was recomputed with the current model. */
  reembedded: number;
}

/** Bring every stored vector onto the current embedding model.
 *
 * Vectors from different models cannot be compared, so a model change means
 * re-embedding the whole store, not just new rows. A store with no recorded
 * model is treated the same way: it predates this check, so its vectors are
 * assumed stale. Subagent turns get no vector, matching insertExchange(). */
export async function ensureEmbeddingModel(store: StoreHandle): Promise<EmbeddingMigrationResult> {
  const recorded = store.meta.get(EMBEDDING_MODEL_KEY) as string | undefined;
  if (recorded === EMBEDDING_MODEL) return { reembedded: 0 };

  let reembedded = 0;
  for (const exchange of exchangesFrom(store, 0)) {
    if (exchange.isSidechain) continue;
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
export function textCursorKey(version: number): string {
  return `text_index_cursor:v${version}`;
}

export interface TextSyncResult {
  /** Another process held the writer lock. Our rows are in LMDB and whoever
   * takes the lock next will index them, so this is not a failure. */
  skipped: boolean;
  /** The index had no documents although the cursor said rows were indexed:
   * its directory was wiped or is brand new, so every row was reloaded. */
  rebuilt: boolean;
  indexed: number;
}

/** Bring the BM25 index up to date with LMDB.
 *
 * The whole design of this function is "whoever gets the lock does the work
 * everyone else could not do". A process that cannot take the lock returns
 * immediately without touching the cursor, so its rows stay pending and the next
 * lock holder indexes them from the cursor forward (design doc §09). */
export function syncTextIndex(store: StoreHandle, index: TextIndex): TextSyncResult {
  if (!index.tryAcquireWriter()) {
    return { skipped: true, rebuilt: false, indexed: 0 };
  }

  const cursorKey = textCursorKey(index.version);
  let cursor = (store.meta.get(cursorKey) as number | undefined) ?? 0;
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

export interface SyncOptions {
  /** Where transcript copies live (design doc archive-and-summaries §03).
   * Tests point this at a temp dir; the default is ~/.config/starmemory/archive. */
  archiveRoot?: string;
  /** Summary step settings (design doc archive-and-summaries §04); tests inject
   * fake summarizers here. `limit` defaults to STARMEMORY_SUMMARY_LIMIT or 10. */
  summaries?: SummaryOptions;
  /** Expiry settings (design doc archive-and-summaries §13). `days` defaults to
   * STARMEMORY_TTL_DAYS or 180; 0 disables. `now` is for tests. */
  ttl?: { days?: number; now?: number; log?: (line: string) => void };
  /** The list of sessions the user asked to forget (src/forget.ts). Tests point
   * this at a temp file; the default is ~/.config/starmemory/forgotten.txt. */
  forgottenPath?: string;
  /** Where Cowork records live (src/cowork.ts). A record past the TTL is
   * starmemory's own file and is deleted with its rows. Defaults to
   * defaultCoworkRoot(). */
  coworkRoot?: string;
  /** How long this sync may wait for the text-index writer when another
   * process holds it and this one has deletions or new rows the index needs.
   * Tantivy keeps the writer until the process exits, so without waiting a
   * forget or a new entry would be left to some later sync, which in Cowork
   * can be days away. Only a sync running detached in the background waits,
   * since nobody waits on it; 0, the default, never waits (design doc §09). */
  writerWaitMs?: number;
  /** Where deletions are reported; stderr, which is sync.log, by default. */
  log?: (line: string) => void;
}

/** What a detached sync waits for the text-index writer, at most. The holder
 * may be minutes into its summary step, but it takes on what arrived meanwhile
 * before it exits (see syncAll), so this only has to outlast a holder that is
 * about to exit. */
export const WRITER_WAIT_MS = 30_000;
const WRITER_POLL_MS = 500;

/** Take the writer another process holds, polling until `waitMs` is up:
 * tantivy has no blocking acquire. */
async function waitForWriter(textIndex: TextIndex, waitMs: number): Promise<boolean> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    if (textIndex.tryAcquireWriter()) return true;
    const left = deadline - Date.now();
    if (left <= 0) return false;
    await new Promise((resolve) => setTimeout(resolve, Math.min(WRITER_POLL_MS, left)));
  }
}

export interface SyncResult {
  filesScanned: number;
  exchangesIndexed: number;
  /** Transcripts copied into the archive this run. */
  archived: number;
  /** Summary files written this run (including empty sentinels). */
  summarized: number;
  /** Summaries that failed and were left as error sentinels to retry. */
  summaryFailed: number;
  /** Rows removed because their conversation passed the TTL. */
  expired: number;
  /** Conversations (files) removed for the same reason. */
  expiredFiles: number;
  /** True when expiry was skipped because another process held the text writer. */
  expireSkipped: boolean;
  /** Rows removed because the user asked to forget their session. */
  forgotten: number;
  /** Conversations (files) removed for the same reason. */
  forgottenFiles: number;
  /** True when rows of forgotten sessions are still stored, left to the next
   * sync because another process held the text writer throughout. */
  forgetSkipped: boolean;
  /** Vectors recomputed because the embedding model changed (see ensureEmbeddingModel). */
  reembedded: number;
  /** Documents added to the BM25 index this run. */
  textIndexed: number;
  /** True when another process held the BM25 writer lock (design doc §09). */
  textSkipped: boolean;
}

function* walkAll(dirs: string[]): Generator<string> {
  for (const dir of dirs) yield* walkJsonlFiles(dir);
}

/** Remove a Cowork record and its cursor. A record started later under the same
 * key is a new file whose lines count from 1 again; the old cursor would skip
 * them. */
function dropRecord(store: StoreHandle, filePath: string): void {
  fs.rmSync(filePath, { force: true });
  store.meta.remove(syncCursorKey(filePath));
}

interface TranscriptOutcome {
  indexed: number;
  archived: boolean;
  /** Every transcript that was read; the summary step picks from these. */
  candidate?: SummaryCandidate;
}

function isInside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative !== '' && relative.split(path.sep)[0] !== '..' && !path.isAbsolute(relative);
}

/** One transcript: copy it into the archive and store the exchanges past its
 * cursor. */
async function syncTranscript(
  store: StoreHandle,
  filePath: string,
  {
    archiveRoot,
    coworkRoot,
    cutoff,
    forgotten,
    forgottenNow,
  }: { archiveRoot: string; coworkRoot: string; cutoff: number; forgotten: ReadonlySet<string>; forgottenNow: () => ReadonlySet<string> }
): Promise<TranscriptOutcome> {
  // Already past the TTL before we ever saw it: not copied, not indexed.
  // Only matters when Claude Code's own 30-day cleanup is turned off.
  if (fs.statSync(filePath).mtimeMs < cutoff) {
    // A Cowork record is starmemory's own file, so it leaves with its rows
    // (expireOldConversations). A harness's transcript is the harness's to
    // clean. Where the file lives says which it can be, so the old rollouts
    // Codex never deletes are not opened on every sync to find out.
    if (isInside(filePath, coworkRoot) && (await detectHarness(filePath)) === 'cowork') dropRecord(store, filePath);
    return { indexed: 0, archived: false };
  }
  const project = projectFromPath(filePath);
  // This read is only an optimisation, to avoid embedding rows another sync
  // has already stored. The authoritative check is inside the insert
  // transaction below, which re-reads the cursor under LMDB's write lock.
  const cursor = (store.meta.get(syncCursorKey(filePath)) as number | undefined) ?? 0;

  // Parse the source, then copy it into the archive and point every row at
  // the copy. The project comes from the parse, not the path: a Codex rollout
  // sits under a date directory, its project is the cwd in session_meta. The
  // cursor stays keyed by the source path: switching the key would make every
  // file look new on the first sync after this change and double every row.
  const parsed = await parseConversation(filePath, project, filePath);
  const harness = parsed[0]?.harness ?? (await detectHarness(filePath));
  const resolvedProject = parsed[0]?.project ?? project;
  const copy = archivePathFor(archiveRoot, harness, resolvedProject, filePath);
  // A session the user asked to forget is not copied or indexed again. Its
  // Cowork record is ours, so that goes too: it can come back when a remember
  // races the forget. A transcript a harness wrote is the harness's to keep,
  // and its cursor stays: taking the session off the list resumes indexing
  // from there, and what the forget deleted is not brought back, so nothing
  // is ever indexed twice. Whose it is: the file name, as forget and read also
  // go by, and the session its lines record, read from its first lines when
  // it has no exchange yet, since a Codex rollout is not named after its
  // session. A match on this sync's list, read when it started, is confirmed
  // on the list as it is now: the user may have taken the forget back since,
  // and written a new record.
  const sessions = [...new Set([path.basename(filePath, '.jsonl'), ...(parsed[0]?.sessionId ? [parsed[0].sessionId] : await sessionIdsOf(filePath))])];
  const leaveOut = (): TranscriptOutcome => {
    if (harness === 'cowork') dropRecord(store, filePath);
    for (const file of [copy, summaryPathFor(copy)]) fs.rmSync(file, { force: true });
    return { indexed: 0, archived: false };
  };
  const onListNow = () => {
    const list = forgottenNow();
    return sessions.some((s) => list.has(s));
  };
  if (sessions.some((s) => forgotten.has(s)) && onListNow()) return leaveOut();
  const archived = await copyIfChanged(filePath, copy);
  // A forget that landed while the copy was being made found no copy to
  // remove, and this sync's list predates it. Asked again once the copy is in.
  if (archived && onListNow()) return leaveOut();
  const exchanges = parsed.map((e) => ({ ...e, archivePath: copy }));
  const candidate: SummaryCandidate = {
    archivePath: copy,
    harness,
    project: resolvedProject,
    sessionId: exchanges[0]?.sessionId,
    sessions,
    sourceMtimeMs: fs.statSync(filePath).mtimeMs,
  };
  const newExchanges = exchanges.filter((e) => e.lineEnd > cursor);
  if (newExchanges.length === 0) return { indexed: 0, archived, candidate };

  const pending = [];
  for (const exchange of newExchanges) {
    // Subagent turns are never returned by vector search, so embedding them
    // would be paying the slowest part of sync for nothing.
    const embedding = exchange.isSidechain
      ? null
      : await generateExchangeEmbedding(exchange.userMessage, exchange.assistantMessage);
    pending.push({ exchange: { ...exchange, embeddingVersion: 1 }, embedding });
  }
  const { ids } = insertExchangesForFile(store, filePath, pending);
  return { indexed: ids.length, archived, candidate };
}

/** A transcript that was listed by the walk but is gone by the time it is
 * read. The walk is lazy, so this happens: Claude Code cleans up old sessions,
 * and a Cowork record goes the moment the user asks to forget it. */
function vanished(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

/** Scans every transcript of every harness, inserts exchanges past each file's
 * last-synced cursor, and rebuilds the vector index once at the end (design doc
 * §07: rebuilding from scratch is a sub-second operation at this scale, so
 * there's no need for incremental graph maintenance). */
export async function syncAll(
  store: StoreHandle,
  index: VectorIndex,
  transcriptsDirs: string | string[] = defaultTranscriptDirs(),
  textIndex?: TextIndex,
  options: SyncOptions = {}
): Promise<SyncResult> {
  let filesScanned = 0;
  let exchangesIndexed = 0;
  let archived = 0;
  const archiveRoot = options.archiveRoot ?? defaultArchiveRoot();
  const coworkRoot = options.coworkRoot ?? defaultCoworkRoot();
  const candidates: SummaryCandidate[] = [];
  const ttlDays = options.ttl?.days ?? defaultTtlDays();
  const now = options.ttl?.now ?? Date.now();
  const cutoff = ttlDays > 0 ? ttlCutoffMs(ttlDays, now) : Number.NEGATIVE_INFINITY;
  const forgottenPath = options.forgottenPath ?? defaultForgottenPath();
  const forgotten = readForgotten(forgottenPath);
  const log = options.log ?? ((line: string) => process.stderr.write(`${line}\n`));

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
  for (const filePath of walkAll(dirs)) {
    filesScanned++;
    let outcome: TranscriptOutcome;
    try {
      outcome = await syncTranscript(store, filePath, { archiveRoot, coworkRoot, cutoff, forgotten, forgottenNow: () => readForgotten(forgottenPath) });
    } catch (error) {
      // Nothing is left to index, and one missing file must not stop the rest.
      if (!vanished(error)) throw error;
      log(`starmemory: ${filePath} went away while it was being synced; skipped`);
      continue;
    }
    exchangesIndexed += outcome.indexed;
    if (outcome.archived) archived++;
    if (outcome.candidate) candidates.push(outcome.candidate);
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
  let builtAt: number | undefined;
  const rebuild = () => {
    builtAt = nextId(store);
    index.rebuild(store);
  };
  if (exchangesIndexed > 0 || migration.reembedded > 0 || expiry.rows > 0 || forgetting.rows > 0) rebuild();

  // Another process has the writer. Its rows are no worry, it indexes them
  // itself, but ours and our deletions would wait for whichever sync comes
  // next. A detached sync waits a little for the writer instead, after the
  // vector rebuild, so a new entry is found by meaning in the meantime.
  const writerWaitMs = options.writerWaitMs ?? 0;
  if (textIndex && writerWaitMs > 0 && (forgetting.skipped || expiry.skipped || (textSync?.skipped && exchangesIndexed > 0))) {
    log(`starmemory: another sync holds the text-index writer; waiting up to ${Math.round(writerWaitMs / 1000)} s for it`);
    const waitStarted = Date.now();
    if (await waitForWriter(textIndex, writerWaitMs)) {
      log(`starmemory: took the text-index writer after ${((Date.now() - waitStarted) / 1000).toFixed(1)} s`);
      let removed = 0;
      if (forgetting.skipped) removed += (forgetting = forgetNow()).rows;
      if (expiry.skipped) removed += (expiry = expire()).rows;
      if (removed > 0) rebuild();
      textSync = syncTextIndex(store, textIndex);
    } else {
      log('starmemory: the text-index writer stayed busy; this is left to the sync holding it, or a later one');
    }
  }

  // Last, and bounded: a few quiet conversations get a summary. Never blocks
  // indexing; a failure is a sentinel file and a log line. A session forgotten
  // while this runs is not sent to a model after all.
  const envLimit = Number(process.env.STARMEMORY_SUMMARY_LIMIT);
  const limit = options.summaries?.limit ?? (Number.isFinite(envLimit) && process.env.STARMEMORY_SUMMARY_LIMIT !== undefined ? envLimit : DEFAULT_SUMMARY_LIMIT);
  const summaries = await summarizeQuietConversations(candidates, {
    skip: (c) => {
      const now = readForgotten(forgottenPath);
      return [c.sessionId, ...(c.sessions ?? [])].some((s) => s !== undefined && now.has(s));
    },
    ...options.summaries,
    limit,
  });

  // What arrived while this sync ran: sessions forgotten meanwhile, rows other
  // syncs stored but could not index. They could not take the writer, since
  // tantivy keeps it until this process exits, so the work is ours. Cheap when
  // there is none: one lookup per forgotten session, and an empty text sync.
  // Both or neither: a writer freed between the two must not have this sync
  // index the rows of a session it could not delete. Rows another sync stored
  // after this one built its graph get a rebuild too: two syncs rebuilding at
  // once each name their own graph, and the later name wins even when its
  // graph is the older one.
  const late = forgetNow();
  const lateText = textIndex && !late.skipped ? syncTextIndex(store, textIndex) : undefined;
  if (late.rows > 0 || (builtAt !== undefined && nextId(store) > builtAt)) rebuild();

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
