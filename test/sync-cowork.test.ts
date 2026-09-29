// Cowork records go through the same sync as every transcript: indexed, tagged
// cowork, archived under archive/cowork/<project>/. What differs is that the
// record is starmemory's own file and already a summary.
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { openStore, exchangesFrom, filterIds, insertExchange, syncCursorKey, type StoreHandle } from '../src/store.js';
import { VectorIndex } from '../src/vector-index.js';
import { EMBEDDING_DIM, initEmbeddings } from '../src/embeddings.js';
import { syncAll } from '../src/sync.js';
import { readArchive, summaryPathFor } from '../src/archive.js';
import { countEntries, findSetAside, quarantineRecords, remember } from '../src/cowork.js';
import { forget, readForgotten } from '../src/forget.js';
import { search } from '../src/search.js';
import { TextIndex } from '../src/text-index.js';
import type { ConversationExchange } from '../src/types.js';
import { writeSummary } from '../src/summaries.js';

/** Every VectorIndex opened here, closed in teardown: Windows cannot delete
 * a file that is still mapped, so a leaked handle fails the cleanup. */
const openedIndexes: VectorIndex[] = [];
function openIndex(s: StoreHandle, p: string): VectorIndex {
  const i = VectorIndex.open(s, p);
  openedIndexes.push(i);
  return i;
}

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
let dir: string;
let store: StoreHandle;
let coworkRoot: string;
let archiveRoot: string;
let forgottenPath: string;
let quarantineRoot: string;

const noSummaries = { claude: async () => 'never', codex: async () => 'never' };
const sync = (opts: Parameters<typeof syncAll>[4] = {}, { dirs, text }: { dirs?: string[]; text?: TextIndex } = {}) =>
  syncAll(store, openIndex(store, path.join(dir, 'index.hnsw')), dirs ?? [coworkRoot], text, {
    archiveRoot,
    coworkRoot,
    forgottenPath,
    quarantine: { root: quarantineRoot, days: 7 },
    log: () => {},
    summaries: { summarizers: noSummaries },
    ...opts,
  });

const entry = (session: string, found: string) => ({
  session,
  title: 'Lantern maintenance',
  asked: 'How often should the lantern wick be trimmed?',
  found,
  project: 'lanterns',
});

beforeAll(async () => {
  await initEmbeddings();
}, 300_000);

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'starmemory-sync-cowork-'));
  store = openStore(path.join(dir, 'store.mdb'));
  coworkRoot = path.join(dir, 'cowork');
  archiveRoot = path.join(dir, 'archive');
  forgottenPath = path.join(dir, 'forgotten.txt');
  quarantineRoot = path.join(dir, 'quarantine');
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const i of openedIndexes.splice(0)) i.close();
  await store.close();
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe('syncAll over the Cowork records directory', () => {
  it('indexes a record as cowork and archives it under archive/cowork/<project>', async () => {
    const { file } = remember(coworkRoot, entry('s-1', 'Every forty hours of burning.'));

    const result = await sync();

    const copy = path.join(archiveRoot, 'cowork', 'lanterns', 's-1.jsonl.gz');
    expect(result).toMatchObject({ filesScanned: 1, archived: 1, exchangesIndexed: 1 });
    expect(readArchive(copy)).toBe(fs.readFileSync(file, 'utf8'));
    const rows = exchangesFrom(store, 0);
    expect(rows.map((r) => [r.harness, r.project, r.sessionId, r.archivePath])).toEqual([['cowork', 'lanterns', 's-1', copy]]);
    expect(filterIds(store, { harness: 'cowork' })).toEqual([rows[0].id]);
  }, 120_000);

  it('indexes only the new entry after another remember', async () => {
    remember(coworkRoot, entry('s-1', 'Every forty hours of burning.'));
    await sync();
    const { file } = remember(coworkRoot, entry('s-1', 'Decided: trim it flat, not rounded.'));
    const later = new Date(Date.now() + 2000);
    fs.utimesSync(file, later, later);

    const result = await sync();

    expect(result).toMatchObject({ archived: 1, exchangesIndexed: 1 });
    expect(exchangesFrom(store, 0).map((r) => r.assistantMessage)).toEqual([
      'Lantern maintenance\n\nEvery forty hours of burning.',
      'Lantern maintenance\n\nDecided: trim it flat, not rounded.',
    ]);
  }, 120_000);

  it('never summarises a Cowork record, which already is a summary', async () => {
    const { file } = remember(coworkRoot, entry('quiet', 'Every forty hours of burning.'));
    const then = new Date(Date.now() - 3 * HOUR);
    fs.utimesSync(file, then, then);
    const calls: string[] = [];
    const summarizers = {
      claude: async () => { calls.push('claude'); return 'x'; },
      codex: async () => { calls.push('codex'); return 'x'; },
    };

    const result = await sync({ summaries: { summarizers } });

    expect(calls).toEqual([]);
    expect(result.summarized).toBe(0);
    expect(fs.existsSync(path.join(archiveRoot, 'cowork', 'lanterns', 'quiet-summary.txt'))).toBe(false);
  }, 120_000);

  it('deletes a record past the TTL along with its rows, since the record is its own file', async () => {
    const { file } = remember(coworkRoot, entry('old', 'Every forty hours of burning.'));
    await sync();
    const now = Date.now();
    const then = new Date(now - 200 * DAY);
    fs.utimesSync(file, then, then);
    fs.utimesSync(path.join(archiveRoot, 'cowork', 'lanterns', 'old.jsonl.gz'), then, then);

    const result = await sync({ ttl: { days: 180, now, log: () => {} } });

    expect(result.expired).toBe(1);
    expect(fs.existsSync(file)).toBe(false);
    expect(store.meta.get(syncCursorKey(file))).toBeUndefined();
    expect(fs.existsSync(path.join(archiveRoot, 'cowork', 'lanterns', 'old.jsonl.gz'))).toBe(false);
    expect(exchangesFrom(store, 0)).toEqual([]);
  }, 120_000);

  it('skips a record that vanishes between the walk and the read, and still indexes the rest', async () => {
    const gone = remember(coworkRoot, entry('gone', 'Every forty hours of burning.')).file;
    remember(coworkRoot, entry('kept', 'Trim it flat.'));
    const realStat = fs.statSync;
    // The walk has already listed the file; it is removed the moment sync
    // first looks at it, as `forget` or Claude Code's cleanup would.
    vi.spyOn(fs, 'statSync').mockImplementation(((p: fs.PathLike, o?: fs.StatSyncOptions) => {
      if (p === gone) fs.rmSync(gone, { force: true });
      return realStat(p, o);
    }) as typeof fs.statSync);

    const result = await sync();

    expect(result.filesScanned).toBe(2);
    expect(exchangesFrom(store, 0).map((r) => r.sessionId)).toEqual(['kept']);
  }, 120_000);
});

describe('syncAll after forget', () => {
  it('deletes a forgotten session everywhere: rows, vectors, text documents, archive copy and summary', async () => {
    remember(coworkRoot, entry('gone', 'Every forty hours of burning.'));
    remember(coworkRoot, entry('kept', 'Trim it flat.'));
    const text = TextIndex.open(path.join(dir, 'text'));
    await sync({}, { text });
    const copy = path.join(archiveRoot, 'cowork', 'lanterns', 'gone.jsonl.gz');
    writeSummary(summaryPathFor(copy), 'A summary that must go too.');
    expect(text.numDocs()).toBe(2);

    forget('gone', { coworkRoot, forgottenPath, archiveRoot, store });
    // Plain files go at once; only the rows wait for the sync.
    expect(fs.existsSync(copy)).toBe(false);
    expect(fs.existsSync(summaryPathFor(copy))).toBe(false);
    const index = openIndex(store, path.join(dir, 'index.hnsw'));
    const result = await syncAll(store, index, [coworkRoot], text, { archiveRoot, coworkRoot, forgottenPath, log: () => {}, summaries: { summarizers: noSummaries } });

    expect(result).toMatchObject({ forgotten: 1, forgottenFiles: 1, forgetSkipped: false });
    const rows = exchangesFrom(store, 0);
    expect(rows.map((r) => r.sessionId)).toEqual(['kept']);
    expect(text.search('lantern', 10).map((h) => h.id)).toEqual([rows[0].id]);
    expect(index.size()).toBe(1);
    expect(fs.existsSync(copy)).toBe(false);
    expect(fs.existsSync(summaryPathFor(copy))).toBe(false);
  }, 120_000);

  it('sets aside a record of a forgotten session that comes back, without indexing or archiving it', async () => {
    forget('raced', { coworkRoot, forgottenPath, archiveRoot });
    // What a remember in another process leaves when it lost the race.
    const { file } = remember(coworkRoot, entry('raced', 'Every forty hours of burning.'));

    const result = await sync();

    expect(result).toMatchObject({ exchangesIndexed: 0, archived: 0 });
    expect(fs.existsSync(file)).toBe(false);
    expect(fs.existsSync(path.join(archiveRoot, 'cowork', 'lanterns', 'raced.jsonl.gz'))).toBe(false);
    const [setAside] = findSetAside(quarantineRoot, 'raced');
    expect(fs.readFileSync(setAside, 'utf8')).toContain('Every forty hours of burning.');
  }, 120_000);

  it('deletes such a record when the quarantine keeps nothing', async () => {
    forget('raced', { coworkRoot, forgottenPath, archiveRoot });
    const { file } = remember(coworkRoot, entry('raced', 'Every forty hours of burning.'));

    await sync({ quarantine: { root: quarantineRoot, days: 0 } });

    expect(fs.existsSync(file)).toBe(false);
    expect(findSetAside(quarantineRoot, 'raced')).toEqual([]);
  }, 120_000);

  it('sets aside a record a forget could not move, and leaves it hidden while it cannot either', async () => {
    const { file } = remember(coworkRoot, entry('stuck', 'Every forty hours of burning.'));
    await sync();
    // A quarantine that cannot be made, on any platform: its parent is a file.
    fs.writeFileSync(path.join(dir, 'not-a-folder'), '');
    const unusable = { root: path.join(dir, 'not-a-folder', 'quarantine'), days: 7 };
    expect(forget('stuck', { coworkRoot, forgottenPath, archiveRoot, store, quarantine: unusable }).notSetAside?.records).toEqual([file]);

    const logged: string[] = [];
    const stuck = await sync({ quarantine: unusable, log: (line) => logged.push(line) });
    expect(stuck).toMatchObject({ exchangesIndexed: 0, forgotten: 1 });
    expect(fs.readFileSync(file, 'utf8')).toContain('Every forty hours of burning.');
    expect(logged.join('\n')).toContain(`could not set ${file} aside`);

    await sync();
    expect(fs.existsSync(file)).toBe(false);
    const [setAside] = findSetAside(quarantineRoot, 'stuck');
    expect(fs.readFileSync(setAside, 'utf8')).toContain('Every forty hours of burning.');
    expect(exchangesFrom(store, 0)).toEqual([]);
  }, 120_000);

  it('leaves a forgotten file that reads as a record in place when it is not in the records folder', async () => {
    // A transcript under Claude Code's folder whose first line is a record's header.
    const projectDir = path.join(dir, 'claude', '-Users-me-lanterns');
    fs.mkdirSync(projectDir, { recursive: true });
    const lookalike = path.join(projectDir, 'looks-like-a-record.jsonl');
    fs.writeFileSync(lookalike, [
      { type: 'cowork_session', version: 1, session: 'looks-like-a-record', project: 'lanterns', createdAt: '2026-09-28T10:00:00.000Z' },
      { type: 'user', promptSource: 'cowork_record', sessionId: 'looks-like-a-record', timestamp: '2026-09-28T10:00:00.000Z', message: { role: 'user', content: 'q' } },
      { type: 'assistant', sessionId: 'looks-like-a-record', timestamp: '2026-09-28T10:00:00.000Z', message: { role: 'assistant', content: 'a' } },
    ].map((l) => `${JSON.stringify(l)}\n`).join(''));
    const record = remember(coworkRoot, entry('looks-like-a-record', 'Every forty hours of burning.')).file;
    forget('looks-like-a-record', { coworkRoot, forgottenPath, archiveRoot });
    // What a remember in another process leaves when it lost the race.
    remember(coworkRoot, entry('looks-like-a-record', 'Raced in.'));

    const result = await sync({}, { dirs: [path.join(dir, 'claude'), coworkRoot] });

    expect(result).toMatchObject({ exchangesIndexed: 0, archived: 0 });
    expect(fs.existsSync(lookalike)).toBe(true);
    expect(fs.existsSync(record)).toBe(false);
    expect(fs.existsSync(path.join(archiveRoot, 'cowork', '-Users-me-lanterns', 'looks-like-a-record.jsonl.gz'))).toBe(false);
  }, 120_000);

  it('forgets a Claude Code session without touching its transcript, and does not index it again as it grows', async () => {
    const projectDir = path.join(dir, 'claude', '-Users-me-lanterns');
    fs.mkdirSync(projectDir, { recursive: true });
    const session = '7f3c9a52-0000-4000-8000-000000000001';
    const transcript = path.join(projectDir, `${session}.jsonl`);
    const turn = (q: string, a: string) =>
      [
        { type: 'user', promptSource: 'typed', sessionId: session, timestamp: '2026-09-28T10:00:00.000Z', message: { role: 'user', content: q } },
        { type: 'assistant', sessionId: session, timestamp: '2026-09-28T10:00:05.000Z', message: { role: 'assistant', content: a } },
      ].map((l) => `${JSON.stringify(l)}\n`).join('');
    fs.writeFileSync(transcript, turn('how do I trim a wick?', 'flat'));
    const dirs = [path.join(dir, 'claude')];
    await sync({}, { dirs });
    expect(exchangesFrom(store, 0)).toHaveLength(1);

    forget(session, { coworkRoot, forgottenPath, archiveRoot, store });
    await sync({}, { dirs });
    fs.appendFileSync(transcript, turn('and the chimney?', 'wipe it'));
    const later = new Date(Date.now() + 2000);
    fs.utimesSync(transcript, later, later);
    const grown = await sync({}, { dirs });

    expect(grown.exchangesIndexed).toBe(0);
    expect(exchangesFrom(store, 0)).toEqual([]);
    expect(fs.existsSync(transcript)).toBe(true);
    expect(fs.existsSync(path.join(archiveRoot, 'claude', '-Users-me-lanterns', `${session}.jsonl.gz`))).toBe(false);

    // Taken off the list by hand, it is indexed again from where it had got
    // to: what was written since, not what the forget deleted.
    fs.writeFileSync(forgottenPath, '');
    const back = await sync({}, { dirs });
    expect(back.exchangesIndexed).toBe(1);
    expect(exchangesFrom(store, 0).map((r) => r.userMessage)).toEqual(['and the chimney?']);
  }, 120_000);

  it('indexes a key recorded again after it came off the list from its first entry', async () => {
    remember(coworkRoot, entry('again', 'First life, first entry.'));
    remember(coworkRoot, entry('again', 'First life, second entry.'));
    await sync();
    forget('again', { coworkRoot, forgottenPath, archiveRoot, store });
    await sync();
    fs.writeFileSync(forgottenPath, '');

    remember(coworkRoot, entry('again', 'Second life, first entry.'));
    const result = await sync();

    expect(result.exchangesIndexed).toBe(1);
    expect(exchangesFrom(store, 0).map((r) => r.assistantMessage)).toEqual(['Lantern maintenance\n\nSecond life, first entry.']);
  }, 120_000);
});

/** A Claude Code transcript of one exchange, gone quiet long enough to be summarised. */
function quietTranscript(session: string, question: string, ageMs: number): string {
  const projectDir = path.join(dir, 'claude', '-Users-me-lanterns');
  fs.mkdirSync(projectDir, { recursive: true });
  const file = path.join(projectDir, `${session}.jsonl`);
  const lines = [
    { type: 'user', promptSource: 'typed', sessionId: session, timestamp: '2026-09-28T10:00:00.000Z', message: { role: 'user', content: question } },
    { type: 'assistant', sessionId: session, timestamp: '2026-09-28T10:00:05.000Z', message: { role: 'assistant', content: 'Trim it flat.' } },
  ];
  fs.writeFileSync(file, lines.map((l) => `${JSON.stringify(l)}\n`).join(''));
  const then = new Date(Date.now() - ageMs);
  fs.utimesSync(file, then, then);
  return file;
}

/** Another process holding the text-index writer for `ms`, as a sync in its
 * summary step does. Resolves once it has the lock. */
function holdWriter(textDir: string, ms: number): Promise<{ exited: Promise<number | null> }> {
  const textIndexModule = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'text-index.js');
  const script =
    `import { TextIndex } from ${JSON.stringify(pathToFileURL(textIndexModule).href)};` +
    'const t = TextIndex.open(process.argv[1]);' +
    "if (!t.tryAcquireWriter()) process.exit(2);" +
    "process.stdout.write('held\\n');" +
    // The timer refers to the index so it stays alive. Nothing else does
    // after the lock is taken, and once collected it would let the lock go
    // before the hold is over.
    `setTimeout(() => { void t; process.exit(0); }, ${ms});`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script, textDir], { stdio: ['ignore', 'pipe', 'inherit'] });
  const exited = new Promise<number | null>((resolve) => child.on('exit', resolve));
  return new Promise((resolve, reject) => {
    child.stdout.on('data', (d: Buffer) => {
      if (d.toString().includes('held')) resolve({ exited });
    });
    child.on('exit', (code) => reject(new Error(`the writer holder exited early (${code})`)));
  });
}

describe('forgetting while another sync holds the text-index writer', () => {
  it('a detached sync waits for the writer and then deletes the session, instead of leaving it for days', async () => {
    remember(coworkRoot, entry('gone', 'Every forty hours of burning.'));
    remember(coworkRoot, entry('kept', 'Trim it flat.'));
    await sync(); // rows in LMDB; no text index yet, so no one holds its writer
    const textDir = path.join(dir, 'text');
    const holder = await holdWriter(textDir, 1500);
    forget('gone', { coworkRoot, forgottenPath, archiveRoot, store });

    const result = await sync({ writerWaitMs: 20_000 }, { text: TextIndex.open(textDir) });

    expect(await holder.exited).toBe(0);
    expect(result).toMatchObject({ forgotten: 1, forgetSkipped: false, textSkipped: false });
    expect(exchangesFrom(store, 0).map((r) => r.sessionId)).toEqual(['kept']);
  }, 120_000);

  it('without waiting, says the deletion is still due, and the rows stay hidden until then', async () => {
    remember(coworkRoot, entry('gone', 'Every forty hours of burning.'));
    await sync();
    const textDir = path.join(dir, 'text');
    const holder = await holdWriter(textDir, 5000);
    forget('gone', { coworkRoot, forgottenPath, archiveRoot, store });

    const result = await sync({}, { text: TextIndex.open(textDir) });

    expect(result).toMatchObject({ forgotten: 0, forgetSkipped: true });
    expect(exchangesFrom(store, 0).map((r) => r.sessionId)).toEqual(['gone']);
    await holder.exited;
  }, 120_000);

  it('the sync holding the writer deletes what was forgotten while it ran, and does not summarise it', async () => {
    quietTranscript('aaaaaaaa-0000-4000-8000-000000000001', 'how do I trim a wick?', 3 * HOUR);
    quietTranscript('bbbbbbbb-0000-4000-8000-000000000002', 'and the chimney?', 4 * HOUR);
    const summarised: (string | undefined)[] = [];
    const summarizers = {
      claude: async ({ sessionId }: { sessionId?: string }) => {
        summarised.push(sessionId);
        // The user forgets the other session while this sync is summarising.
        forget('bbbbbbbb-0000-4000-8000-000000000002', { coworkRoot, forgottenPath, archiveRoot, store });
        return 'A summary.';
      },
      codex: async () => 'never',
    };

    const result = await sync({ summaries: { summarizers, quietMs: HOUR } }, { dirs: [path.join(dir, 'claude')], text: TextIndex.open(path.join(dir, 'text')) });

    expect(summarised).toEqual(['aaaaaaaa-0000-4000-8000-000000000001']);
    expect(result).toMatchObject({ forgotten: 1, forgetSkipped: false });
    expect(exchangesFrom(store, 0).map((r) => r.sessionId)).toEqual(['aaaaaaaa-0000-4000-8000-000000000001']);
    const copy = path.join(archiveRoot, 'claude', '-Users-me-lanterns', 'bbbbbbbb-0000-4000-8000-000000000002.jsonl.gz');
    expect(fs.existsSync(copy)).toBe(false);
    expect(fs.existsSync(summaryPathFor(copy))).toBe(false);
  }, 120_000);
});

describe('forgetting what has no row yet', () => {
  it('removes a copy made while the session was being forgotten, which forget could not see yet', async () => {
    remember(coworkRoot, entry('raced-copy', 'Every forty hours of burning.'));
    const copy = path.join(archiveRoot, 'cowork', 'lanterns', 'raced-copy.jsonl.gz');
    const realRename = fs.renameSync;
    // The forget lands between the copy's gzip and its rename into place.
    vi.spyOn(fs, 'renameSync').mockImplementation(((from: fs.PathLike, to: fs.PathLike) => {
      if (to === copy) forget('raced-copy', { coworkRoot, forgottenPath, archiveRoot, store });
      return realRename(from, to);
    }) as typeof fs.renameSync);

    const result = await sync();

    expect(result.exchangesIndexed).toBe(0);
    expect(fs.existsSync(copy)).toBe(false);
    expect(exchangesFrom(store, 0)).toEqual([]);
  }, 120_000);

  it('forgets a Codex rollout with no whole exchange yet, whose file is not named after its session', async () => {
    const id = '0199aaaa-bbbb-7ccc-8ddd-eeeeffff0002';
    const rollout = path.join(dir, 'codex', 'sessions', '2026', '09', '28', `rollout-2026-09-28T10-00-00-${id}.jsonl`);
    fs.mkdirSync(path.dirname(rollout), { recursive: true });
    const lines = [
      { timestamp: '2026-09-28T10:00:00.000Z', type: 'session_meta', payload: { id, cwd: '/Users/me/lanterns' } },
      { timestamp: '2026-09-28T10:00:01.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'a prompt with no reply yet' }] } },
    ];
    fs.writeFileSync(rollout, lines.map((l) => `${JSON.stringify(l)}\n`).join(''));
    const dirs = [path.join(dir, 'codex', 'sessions')];
    const copies = () =>
      (fs.readdirSync(archiveRoot, { recursive: true }) as string[]).filter((name) => name.endsWith(`${id}.jsonl.gz`));
    await sync({}, { dirs });
    expect(copies()).toHaveLength(1);

    expect(forget(id, { coworkRoot, forgottenPath, archiveRoot, store }).copies).toHaveLength(1);
    expect(copies()).toEqual([]);
    // Codex keeps the rollout, and writes to it again.
    const later = new Date(Date.now() + 2000);
    fs.utimesSync(rollout, later, later);
    await sync({}, { dirs });

    expect(copies()).toEqual([]);
    expect(exchangesFrom(store, 0)).toEqual([]);
  }, 120_000);
});

describe('what the sync holding the writer takes on', () => {
  it('does not index the rows of a session it could not delete, when the writer frees up in between', async () => {
    remember(coworkRoot, entry('gone', 'Every forty hours of burning.'));
    await sync(); // rows in LMDB, none in any text index
    forget('gone', { coworkRoot, forgottenPath, archiveRoot, store });
    // A text index whose writer another process holds for the first three
    // asks (the forget, the text sync and the late forget) and frees after.
    let asks = 0;
    const added: ConversationExchange[] = [];
    const text = {
      version: 2,
      tryAcquireWriter: () => ++asks > 3,
      addExchanges: (xs: ConversationExchange[]) => added.push(...xs),
      deleteExchanges: () => {},
      commit: () => {},
      numDocs: () => 0,
      search: () => [],
    } as unknown as TextIndex;

    const result = await sync({}, { text });

    expect(result).toMatchObject({ forgetSkipped: true, textSkipped: true });
    expect(added.map((e) => e.sessionId)).not.toContain('gone');
  }, 120_000);

  it('a detached sync waits for the writer to put a new entry in the text index', async () => {
    const textDir = path.join(dir, 'text');
    const holder = await holdWriter(textDir, 1500);
    remember(coworkRoot, entry('fresh', 'The gauge reported wick-too-long.'));
    const text = TextIndex.open(textDir);

    const result = await sync({ writerWaitMs: 20_000 }, { text });

    await holder.exited;
    expect(result).toMatchObject({ exchangesIndexed: 1, textSkipped: false });
    expect(text.search('gauge', 10)).toHaveLength(1);
  }, 120_000);

  it('indexes rows another sync stored while this one ran, and writes no summary for a session forgotten mid-call', async () => {
    quietTranscript('aaaaaaaa-0000-4000-8000-000000000003', 'how do I trim a wick?', 3 * HOUR);
    const text = TextIndex.open(path.join(dir, 'text'));
    const summarizers = {
      claude: async ({ sessionId }: { sessionId?: string }) => {
        // Another sync stores a row it cannot index, since this one holds the writer.
        insertExchange(store, {
          harness: 'cowork', project: 'lanterns', sessionId: 'other', timestamp: '2026-09-28T11:00:00.000Z',
          userMessage: 'zebra striped lantern', assistantMessage: 'noted', archivePath: path.join(archiveRoot, 'cowork', 'lanterns', 'other.jsonl.gz'),
          lineStart: 2, lineEnd: 3, embeddingVersion: 1,
        }, new Float32Array(EMBEDDING_DIM).fill(1 / Math.sqrt(EMBEDDING_DIM)));
        // And the user forgets the very session being summarised.
        forget(sessionId!, { coworkRoot, forgottenPath, archiveRoot, store });
        return 'A summary of it.';
      },
      codex: async () => 'never',
    };

    const result = await sync({ summaries: { summarizers, quietMs: HOUR } }, { dirs: [path.join(dir, 'claude')], text });

    expect(result).toMatchObject({ summarized: 0, forgotten: 1 });
    expect(text.search('zebra', 10)).toHaveLength(1);
    const copy = path.join(archiveRoot, 'claude', '-Users-me-lanterns', 'aaaaaaaa-0000-4000-8000-000000000003.jsonl.gz');
    expect(fs.existsSync(summaryPathFor(copy))).toBe(false);
  }, 120_000);
});

describe('taking a forget back, and what goes by the file name', () => {
  const claudeTranscript = (name: string, sessionId: string) => {
    const projectDir = path.join(dir, 'claude', '-Users-me-lanterns');
    fs.mkdirSync(projectDir, { recursive: true });
    const file = path.join(projectDir, `${name}.jsonl`);
    const lines = [
      { type: 'user', promptSource: 'typed', sessionId, timestamp: '2026-09-28T10:00:00.000Z', message: { role: 'user', content: 'how do I trim a wick?' } },
      { type: 'assistant', sessionId, timestamp: '2026-09-28T10:00:05.000Z', message: { role: 'assistant', content: 'flat' } },
    ];
    fs.writeFileSync(file, lines.map((l) => `${JSON.stringify(l)}\n`).join(''));
    return file;
  };

  it('keeps a Cowork record whose key reads like a Codex rollout\'s name when the session its end names is forgotten', async () => {
    const key = 'rollout-2026-09-28T10-00-00-victim';
    const { file } = remember(coworkRoot, entry(key, 'Trim it flat.'));
    // A Codex rollout of that session, named for it, with no session_meta line to say so.
    const codexDir = path.join(dir, 'codex');
    const rolloutFile = path.join(codexDir, '2026', '09', '28', 'rollout-2026-09-28T11-00-00-victim.jsonl');
    fs.mkdirSync(path.dirname(rolloutFile), { recursive: true });
    const turn = (role: string, type: string, text: string) => ({ timestamp: '2026-09-28T11:00:00.000Z', type: 'response_item', payload: { type: 'message', role, content: [{ type, text }] } });
    fs.writeFileSync(rolloutFile, [turn('user', 'input_text', 'asked in codex'), turn('assistant', 'output_text', 'answered in codex')].map((l) => `${JSON.stringify(l)}\n`).join(''));
    const dirs = [coworkRoot, codexDir];
    await sync({}, { dirs });
    const harnesses = () => exchangesFrom(store, 0).map((r) => r.harness).sort();
    expect(harnesses()).toEqual(['codex', 'cowork']);

    forget('victim', { coworkRoot, forgottenPath, archiveRoot, store });
    await sync({}, { dirs });

    expect({
      record: fs.existsSync(file),
      copy: fs.existsSync(path.join(archiveRoot, 'cowork', 'lanterns', `${key}.jsonl.gz`)),
      setAside: findSetAside(quarantineRoot, key),
      rows: harnesses(),
    }).toEqual({ record: true, copy: true, setAside: [], rows: ['cowork'] });
  }, 120_000);

  it('once a forget is taken back, indexes what comes next and nothing the forget deleted, whichever sync did the deleting', async () => {
    const file = claudeTranscript('cc-1', 'cc-1');
    const dirs = [path.join(dir, 'claude')];
    await sync({}, { dirs });
    expect(exchangesFrom(store, 0)).toHaveLength(1);
    forget('cc-1', { coworkRoot, forgottenPath, archiveRoot, store });
    // What a remember or forget starts: the Cowork records only.
    expect(await sync({}, { dirs: [coworkRoot] })).toMatchObject({ forgotten: 1 });

    fs.writeFileSync(forgottenPath, '');
    expect((await sync({}, { dirs })).exchangesIndexed).toBe(0);
    fs.appendFileSync(file, [
      { type: 'user', promptSource: 'typed', sessionId: 'cc-1', timestamp: '2026-09-28T10:01:00.000Z', message: { role: 'user', content: 'and the chimney?' } },
      { type: 'assistant', sessionId: 'cc-1', timestamp: '2026-09-28T10:01:05.000Z', message: { role: 'assistant', content: 'wipe it' } },
    ].map((l) => `${JSON.stringify(l)}\n`).join(''));
    const later = new Date(Date.now() + 2000);
    fs.utimesSync(file, later, later);

    expect((await sync({}, { dirs })).exchangesIndexed).toBe(1);
    expect(exchangesFrom(store, 0).map((r) => r.userMessage)).toEqual(['and the chimney?']);
  }, 120_000);

  it('does not bring back a forgotten Codex session when its line is deleted, though its rollout is not named after it', async () => {
    const id = '0199aaaa-bbbb-7ccc-8ddd-eeeeffff0003';
    const rollout = path.join(dir, 'codex', 'sessions', '2026', '09', '28', `rollout-2026-09-28T10-00-00-${id}.jsonl`);
    fs.mkdirSync(path.dirname(rollout), { recursive: true });
    const lines = [
      { timestamp: '2026-09-28T10:00:00.000Z', type: 'session_meta', payload: { id, cwd: '/Users/me/lanterns' } },
      { timestamp: '2026-09-28T10:00:01.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'how do I trim the wick?' }] } },
      { timestamp: '2026-09-28T10:00:02.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Flat.' }] } },
    ];
    fs.writeFileSync(rollout, lines.map((l) => `${JSON.stringify(l)}\n`).join(''));
    const dirs = [path.join(dir, 'codex', 'sessions')];
    await sync({}, { dirs });
    expect(exchangesFrom(store, 0)).toHaveLength(1);
    forget(id, { coworkRoot, forgottenPath, archiveRoot, store });
    expect(await sync({}, { dirs: [coworkRoot] })).toMatchObject({ forgotten: 1 });

    fs.writeFileSync(forgottenPath, '');
    expect((await sync({}, { dirs })).exchangesIndexed).toBe(0);
    expect(exchangesFrom(store, 0)).toEqual([]);
  }, 120_000);

  it('removes the copy the rows point at when the archive has moved since', async () => {
    claudeTranscript('cc-4', 'cc-4');
    const dirs = [path.join(dir, 'claude')];
    await sync({}, { dirs });
    const oldCopy = path.join(archiveRoot, 'claude', '-Users-me-lanterns', 'cc-4.jsonl.gz');
    const movedRoot = path.join(dir, 'archive-moved');
    await sync({ archiveRoot: movedRoot }, { dirs });
    forget('cc-4', { coworkRoot, forgottenPath, archiveRoot: movedRoot, store });

    await sync({ archiveRoot: movedRoot }, { dirs: [coworkRoot] });

    expect(fs.existsSync(oldCopy)).toBe(false);
    expect(fs.existsSync(path.join(movedRoot, 'claude', '-Users-me-lanterns', 'cc-4.jsonl.gz'))).toBe(false);
    expect(exchangesFrom(store, 0)).toEqual([]);
  }, 120_000);

  it('keeps the cursor while the rows are still stored, so a forget taken back before they went indexes nothing twice', async () => {
    claudeTranscript('cc-3', 'cc-3');
    const dirs = [path.join(dir, 'claude')];
    const textDir = path.join(dir, 'text');
    await sync({}, { dirs }); // one row, no text index yet
    forget('cc-3', { coworkRoot, forgottenPath, archiveRoot, store });
    // A full sync walks the forgotten transcript while another holds the writer, so the rows stay.
    const holder = await holdWriter(textDir, 5000);
    expect(await sync({}, { dirs, text: TextIndex.open(textDir) })).toMatchObject({ forgetSkipped: true });
    await holder.exited;

    fs.writeFileSync(forgottenPath, '');
    await sync({}, { dirs });

    expect(exchangesFrom(store, 0)).toHaveLength(1);
  }, 120_000);

  it('does not index anything twice when the archive moves', async () => {
    claudeTranscript('cc-2', 'cc-2');
    const dirs = [path.join(dir, 'claude')];
    await sync({}, { dirs });

    const moved = await sync({ archiveRoot: path.join(dir, 'archive-moved') }, { dirs });

    expect(moved.exchangesIndexed).toBe(0);
    expect(exchangesFrom(store, 0)).toHaveLength(1);
  }, 120_000);

  it('keeps the cursor of a transcript that still holds another session\'s rows, so taking the forget back indexes nothing twice', async () => {
    // One file, two sessions: history carried over from `older`, then `newer`.
    const projectDir = path.join(dir, 'claude', '-Users-me-lanterns');
    fs.mkdirSync(projectDir, { recursive: true });
    const file = path.join(projectDir, 'mixed.jsonl');
    const turn = (sessionId: string, q: string) => [
      { type: 'user', promptSource: 'typed', sessionId, timestamp: '2026-09-28T10:00:00.000Z', message: { role: 'user', content: q } },
      { type: 'assistant', sessionId, timestamp: '2026-09-28T10:00:05.000Z', message: { role: 'assistant', content: 'noted' } },
    ];
    fs.writeFileSync(file, [...turn('older', 'the first question'), ...turn('newer', 'the second question')].map((l) => `${JSON.stringify(l)}\n`).join(''));
    const dirs = [path.join(dir, 'claude')];
    await sync({}, { dirs });
    expect(exchangesFrom(store, 0)).toHaveLength(2);

    forget('newer', { coworkRoot, forgottenPath, archiveRoot, store });
    await sync({}, { dirs: [coworkRoot] });
    expect(exchangesFrom(store, 0).map((r) => r.sessionId)).toEqual(['older']);

    // A full sync while `newer` is still forgotten, the file quiet long enough
    // to be summarised: its first lines are older's, and newer's turns follow.
    const then = new Date(Date.now() - 3 * HOUR);
    fs.utimesSync(file, then, then);
    const summarised: (string | undefined)[] = [];
    const summarizers = {
      claude: async ({ sessionId }: { sessionId?: string }) => { summarised.push(sessionId); return 'A summary.'; },
      codex: async () => 'never',
    };
    await sync({ summaries: { summarizers, quietMs: HOUR } }, { dirs });
    const copy = path.join(archiveRoot, 'claude', '-Users-me-lanterns', 'mixed.jsonl.gz');
    expect({
      copied: fs.existsSync(copy),
      summary: fs.existsSync(summaryPathFor(copy)),
      summarised,
      rows: exchangesFrom(store, 0).map((r) => r.sessionId),
    }).toEqual({ copied: false, summary: false, summarised: [], rows: ['older'] });

    fs.writeFileSync(forgottenPath, '');
    await sync({}, { dirs });

    expect(exchangesFrom(store, 0).map((r) => r.sessionId)).toEqual(['older']);
  }, 120_000);

  it('forgets a transcript by its file name even when its lines name another session: its copy, and its rows in search and in the store', async () => {
    const file = claudeTranscript('new-id', 'old-id');
    const dirs = [path.join(dir, 'claude')];
    await sync({}, { dirs });
    const copy = path.join(archiveRoot, 'claude', '-Users-me-lanterns', 'new-id.jsonl.gz');
    expect(fs.existsSync(copy)).toBe(true);
    expect(exchangesFrom(store, 0).map((r) => r.sessionId)).toEqual(['old-id']);
    const index = openIndex(store, path.join(dir, 'index.hnsw'));
    const found = async () => (await search(store, index, 'trim a wick', { excludeSessions: readForgotten(forgottenPath) })).map((r) => r.exchange.sessionId);
    expect(await found()).toEqual(['old-id']);

    forget('new-id', { coworkRoot, forgottenPath, archiveRoot, store });
    // Hidden at once, then deleted by the sync the forget starts, which does
    // not walk the transcript.
    expect(await found()).toEqual([]);
    await sync({}, { dirs: [coworkRoot] });
    expect(exchangesFrom(store, 0)).toEqual([]);
    const later = new Date(Date.now() + 2000);
    fs.utimesSync(file, later, later);
    await sync({}, { dirs });

    expect({ copied: fs.existsSync(copy), rows: exchangesFrom(store, 0), found: await found() }).toEqual({ copied: false, rows: [], found: [] });
  }, 120_000);

  it('carries on, and leaves no summary file, when a transcript with no whole exchange is forgotten during the summaries', async () => {
    quietTranscript('aaaaaaaa-0000-4000-8000-000000000005', 'how do I trim a wick?', 3 * HOUR);
    // Older, and only a prompt so far: no exchange, so no session id from the parse.
    const projectDir = path.join(dir, 'claude', '-Users-me-lanterns');
    const promptOnly = path.join(projectDir, 'bbbbbbbb-0000-4000-8000-000000000006.jsonl');
    fs.writeFileSync(promptOnly, `${JSON.stringify({ type: 'user', promptSource: 'typed', sessionId: 'bbbbbbbb-0000-4000-8000-000000000006', timestamp: '2026-09-28T09:00:00.000Z', message: { role: 'user', content: 'a prompt with no reply' } })}\n`);
    const then = new Date(Date.now() - 4 * HOUR);
    fs.utimesSync(promptOnly, then, then);
    const summarizers = {
      claude: async () => {
        forget('bbbbbbbb-0000-4000-8000-000000000006', { coworkRoot, forgottenPath, archiveRoot, store });
        return 'A summary.';
      },
      codex: async () => 'never',
    };

    const result = await sync({ summaries: { summarizers, quietMs: HOUR } }, { dirs: [path.join(dir, 'claude')], text: TextIndex.open(path.join(dir, 'text')) });

    expect(result).toMatchObject({ summarized: 1, summaryFailed: 0 });
    const summaries = (fs.readdirSync(archiveRoot, { recursive: true }) as string[]).filter((f) => f.endsWith('-summary.txt'));
    expect(summaries).toEqual([path.join('claude', '-Users-me-lanterns', 'aaaaaaaa-0000-4000-8000-000000000005-summary.txt')]);
  }, 120_000);

  it('does not summarise a subagent transcript with no whole exchange once its parent session is forgotten', async () => {
    const parent = 'cccccccc-0000-4000-8000-000000000007';
    quietTranscript('aaaaaaaa-0000-4000-8000-000000000008', 'how do I trim a wick?', 3 * HOUR);
    // An interrupted subagent: its lines carry the parent's id, and it has no reply yet.
    const subagent = path.join(dir, 'claude', '-Users-me-lanterns', parent, 'subagents', 'agent-a1b2c3.jsonl');
    fs.mkdirSync(path.dirname(subagent), { recursive: true });
    fs.writeFileSync(subagent, `${JSON.stringify({ type: 'user', isSidechain: true, sessionId: parent, timestamp: '2026-09-28T09:00:00.000Z', message: { role: 'user', content: 'look up the wick gauge' } })}\n`);
    const then = new Date(Date.now() - 4 * HOUR);
    fs.utimesSync(subagent, then, then);
    const summarizers = {
      claude: async () => {
        forget(parent, { coworkRoot, forgottenPath, archiveRoot, store });
        return 'A summary.';
      },
      codex: async () => 'never',
    };

    await sync({ summaries: { summarizers, quietMs: HOUR } }, { dirs: [path.join(dir, 'claude')] });

    const summaries = (fs.readdirSync(archiveRoot, { recursive: true }) as string[]).filter((f) => f.endsWith('-summary.txt'));
    expect(summaries).toEqual([path.join('claude', '-Users-me-lanterns', 'aaaaaaaa-0000-4000-8000-000000000008-summary.txt')]);
  }, 120_000);

  it('writes no failure sentinel for a copy removed while it waited for its summary', async () => {
    quietTranscript('aaaaaaaa-0000-4000-8000-000000000009', 'how do I trim a wick?', 3 * HOUR);
    quietTranscript('bbbbbbbb-0000-4000-8000-000000000010', 'and the chimney?', 4 * HOUR);
    const olderCopy = path.join(archiveRoot, 'claude', '-Users-me-lanterns', 'bbbbbbbb-0000-4000-8000-000000000010.jsonl.gz');
    const summarizers = {
      claude: async ({ sessionId }: { sessionId?: string }) => {
        // The first summary call: the other copy goes before its turn comes.
        if (sessionId?.startsWith('aaaaaaaa')) fs.rmSync(olderCopy, { force: true });
        return 'A summary.';
      },
      codex: async () => 'never',
    };

    const result = await sync({ summaries: { summarizers, quietMs: HOUR } }, { dirs: [path.join(dir, 'claude')] });

    expect(result).toMatchObject({ summarized: 1, summaryFailed: 0 });
    expect(fs.existsSync(summaryPathFor(olderCopy))).toBe(false);
  }, 120_000);

  it('does not index a transcript twice when only its archive copy was deleted by hand', async () => {
    const file = quietTranscript('dddddddd-0000-4000-8000-000000000011', 'how do I trim a wick?', 0);
    const dirs = [path.join(dir, 'claude')];
    await sync({}, { dirs });
    fs.rmSync(path.join(archiveRoot, 'claude', '-Users-me-lanterns', 'dddddddd-0000-4000-8000-000000000011.jsonl.gz'));
    const later = new Date(Date.now() + 2000);
    fs.utimesSync(file, later, later);

    await sync({}, { dirs });

    expect(exchangesFrom(store, 0)).toHaveLength(1);
  }, 120_000);

  it('rebuilds the vector graph for rows another sync stored while this one ran', async () => {
    quietTranscript('aaaaaaaa-0000-4000-8000-000000000004', 'how do I trim a wick?', 3 * HOUR);
    const summarizers = {
      claude: async () => {
        insertExchange(store, {
          harness: 'cowork', project: 'lanterns', sessionId: 'other', timestamp: '2026-09-28T11:00:00.000Z',
          userMessage: 'zebra striped lantern', assistantMessage: 'noted', archivePath: path.join(archiveRoot, 'cowork', 'lanterns', 'other.jsonl.gz'),
          lineStart: 2, lineEnd: 3, embeddingVersion: 1,
        }, new Float32Array(EMBEDDING_DIM).fill(1 / Math.sqrt(EMBEDDING_DIM)));
        return 'A summary.';
      },
      codex: async () => 'never',
    };
    const index = openIndex(store, path.join(dir, 'index.hnsw'));

    await syncAll(store, index, [path.join(dir, 'claude')], TextIndex.open(path.join(dir, 'text')), {
      archiveRoot, coworkRoot, forgottenPath, log: () => {}, summaries: { summarizers, quietMs: HOUR },
    });

    expect(index.size()).toBe(2);
  }, 120_000);
});

describe('the quarantine, as sync sees it', () => {
  const quarantine = (days = 7) => ({ root: quarantineRoot, days });
  /** Everything the store has, as the session and the entry's found text. */
  const stored = () => exchangesFrom(store, 0).map((r) => [r.sessionId, r.assistantMessage.split('\n\n')[1]]);

  it('deletes what was set aside longer ago than the quarantine keeps it, and keeps the rest', async () => {
    remember(coworkRoot, entry('old', 'Every forty hours of burning.'));
    remember(coworkRoot, entry('new', 'Trim it flat.'));
    const day = 24 * 60 * 60 * 1000;
    const [old] = quarantineRecords(coworkRoot, 'old', quarantine(), new Date(Date.now() - 8 * day)).moved;
    const [recent] = quarantineRecords(coworkRoot, 'new', quarantine(), new Date(Date.now() - 2 * day)).moved;

    await sync({ quarantine: quarantine() });
    expect(fs.existsSync(old.to)).toBe(false);
    expect(fs.existsSync(recent.to)).toBe(true);

    // A sync with other days, Codex's for one, which does not pass the
    // setting on, keeps it for the days it was set aside with.
    await sync({ quarantine: quarantine(0) });
    expect(fs.existsSync(recent.to)).toBe(true);
    await sync({ quarantine: quarantine(), ttl: { now: recent.expiresAt + 1 } });
    expect(fs.existsSync(recent.to)).toBe(false);
  }, 120_000);

  it('never walks the quarantine, even when it was pointed inside a folder sync indexes', async () => {
    const inside = path.join(coworkRoot, 'set-aside');
    remember(coworkRoot, entry('hidden', 'Every forty hours of burning.'));
    const [{ to }] = quarantineRecords(coworkRoot, 'hidden', { root: inside, days: 7 }).moved;
    // Named as a record, too: the folder is left out, not only the suffix.
    fs.copyFileSync(to, path.join(inside, 'lanterns', 'hidden.jsonl'));

    const result = await sync({ quarantine: { root: inside, days: 7 } });

    expect(result).toMatchObject({ filesScanned: 0, exchangesIndexed: 0, archived: 0 });
    expect(exchangesFrom(store, 0)).toEqual([]);
  }, 120_000);

  it('a record moved back once its forget is taken back is indexed again, and search finds it, with no row stored twice', async () => {
    remember(coworkRoot, entry('undo', 'Every forty hours of burning.'));
    const { file } = remember(coworkRoot, entry('undo', 'Decided: the zeppelin gauge reads it.'));
    remember(coworkRoot, entry('kept', 'Trim it flat.'));
    const text = TextIndex.open(path.join(dir, 'text'));
    await sync({}, { text });
    expect(stored()).toHaveLength(3);

    const { setAside } = forget('undo', { coworkRoot, forgottenPath, archiveRoot, store, quarantine: quarantine() });
    expect(await sync({}, { text })).toMatchObject({ forgotten: 2 });
    expect(stored()).toEqual([['kept', 'Trim it flat.']]);
    const index = openIndex(store, path.join(dir, 'index.hnsw'));
    expect(await search(store, index, 'zeppelin', { mode: 'text' }, text)).toEqual([]);

    // The undo: the line off the list first, then the file back where it was.
    fs.writeFileSync(forgottenPath, '');
    fs.renameSync(setAside[0].to, file);
    const back = await sync({}, { text });

    expect(back).toMatchObject({ exchangesIndexed: 2, archived: 1 });
    expect(stored().sort()).toEqual([
      ['kept', 'Trim it flat.'],
      ['undo', 'Decided: the zeppelin gauge reads it.'],
      ['undo', 'Every forty hours of burning.'],
    ]);
    const found = await search(store, openIndex(store, path.join(dir, 'index.hnsw')), 'zeppelin', { mode: 'text' }, text);
    expect(found.map((r) => r.exchange.sessionId)).toEqual(['undo']);
    expect(fs.existsSync(path.join(archiveRoot, 'cowork', 'lanterns', 'undo.jsonl.gz'))).toBe(true);
    expect((await sync({}, { text })).exchangesIndexed).toBe(0);
    expect(stored()).toHaveLength(3);
  }, 120_000);

  it('sweeps up what a removal took aside and did not finish: a record put back and indexed, a forgotten one set aside', async () => {
    const kept = remember(coworkRoot, entry('kept', 'Trim it flat.')).file;
    const gone = remember(coworkRoot, entry('gone', 'Every forty hours of burning.')).file;
    // As a process that stopped between the rename and the delete leaves them.
    const then = Date.now() - 11 * 60 * 1000;
    for (const file of [kept, gone]) fs.renameSync(file, `${file}.${then}-0a1b2c3d.removing`);
    fs.writeFileSync(forgottenPath, 'gone\n');

    await sync({ quarantine: quarantine() });

    expect({
      kept: fs.existsSync(kept),
      gone: fs.existsSync(gone),
      left: fs.readdirSync(path.dirname(kept)).filter((name) => name.endsWith('.removing')),
      setAside: findSetAside(quarantineRoot, 'gone').map(countEntries),
      stored: stored(),
    }).toEqual({ kept: true, gone: false, left: [], setAside: [1], stored: [['kept', 'Trim it flat.']] });
  }, 120_000);

  it('a record moved back before any sync deleted its rows stores nothing twice', async () => {
    remember(coworkRoot, entry('quick', 'Every forty hours of burning.'));
    const { file } = remember(coworkRoot, entry('quick', 'Trim it flat.'));
    await sync();
    const { setAside } = forget('quick', { coworkRoot, forgottenPath, archiveRoot, store, quarantine: quarantine() });

    fs.writeFileSync(forgottenPath, '');
    fs.renameSync(setAside[0].to, file);
    const back = await sync();

    expect(back).toMatchObject({ exchangesIndexed: 0, forgotten: 0 });
    expect(stored()).toEqual([
      ['quick', 'Every forty hours of burning.'],
      ['quick', 'Trim it flat.'],
    ]);
  }, 120_000);
});
