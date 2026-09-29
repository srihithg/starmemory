// Forgetting and taking a forget back while other syncs run. Two syncs in one
// process, held at the await points two processes would reach, stand in for
// two processes: parseConversation is gated per file.
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStore, exchangesFrom, syncCursorKey, type StoreHandle } from '../src/store.js';
import { VectorIndex } from '../src/vector-index.js';
import { initEmbeddings } from '../src/embeddings.js';
import { syncAll } from '../src/sync.js';
import { countEntries, findSetAside, remember } from '../src/cowork.js';
import { forget } from '../src/forget.js';

// A gate on the Nth parseConversation call for one file: holds one of two
// concurrent syncs after its cursor read, while the other copies and inserts.
// And one on the harness check of a file past the TTL: holds a sync between
// reading a record's age and deleting it.
const { gates, harnessGates } = vi.hoisted(() => ({
  gates: new Map<string, { calls: number; holdCall: number; hold: Promise<void> }>(),
  harnessGates: new Map<string, { hit: boolean; hold: Promise<void> }>(),
}));
vi.mock('../src/parser.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/parser.js')>();
  return {
    ...actual,
    parseConversation: async (filePath: string, project: string, archivePath: string, sessions?: Set<string>) => {
      const g = gates.get(filePath);
      if (g && ++g.calls === g.holdCall) await g.hold;
      return actual.parseConversation(filePath, project, archivePath, sessions);
    },
    detectHarness: async (filePath: string) => {
      const g = harnessGates.get(filePath);
      if (g && !g.hit) {
        g.hit = true;
        await g.hold;
      }
      return actual.detectHarness(filePath);
    },
  };
});

// A gate on the first embedding once armed: holds a sync between its parse
// and its insert, where a forget from another process can land.
const { embedGate } = vi.hoisted(() => ({ embedGate: { armed: false, hit: false, hold: Promise.resolve() as Promise<void> } }));
vi.mock('../src/embeddings.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/embeddings.js')>();
  return {
    ...actual,
    generateExchangeEmbedding: async (u: string, a: string) => {
      if (embedGate.armed && !embedGate.hit) {
        embedGate.hit = true;
        await embedGate.hold;
      }
      return actual.generateExchangeEmbedding(u, a);
    },
  };
});

const openedIndexes: VectorIndex[] = [];
function openIndex(s: StoreHandle, p: string): VectorIndex {
  const i = VectorIndex.open(s, p);
  openedIndexes.push(i);
  return i;
}

let dir: string;
let store: StoreHandle;
let coworkRoot: string;
let archiveRoot: string;
let forgottenPath: string;
let claudeDir: string;

const noSummaries = { claude: async () => 'never', codex: async () => 'never' };
const sync = (dirs: string[]) =>
  syncAll(store, openIndex(store, path.join(dir, 'index.hnsw')), dirs, undefined, {
    archiveRoot, coworkRoot, forgottenPath, log: () => {}, summaries: { summarizers: noSummaries },
  });

function claudeTranscript(name: string, exchanges: number, start = 0): string {
  const projectDir = path.join(claudeDir, '-Users-me-lanterns');
  fs.mkdirSync(projectDir, { recursive: true });
  const file = path.join(projectDir, `${name}.jsonl`);
  const lines: string[] = [];
  for (let i = start; i < start + exchanges; i++) {
    lines.push(JSON.stringify({ type: 'user', promptSource: 'typed', sessionId: name, timestamp: `2026-09-28T10:${String(i).padStart(2, '0')}:00.000Z`, message: { role: 'user', content: `question ${i} about wicks and lanterns` } }));
    lines.push(JSON.stringify({ type: 'assistant', sessionId: name, timestamp: `2026-09-28T10:${String(i).padStart(2, '0')}:05.000Z`, message: { role: 'assistant', content: `answer ${i}: trim it flat` } }));
  }
  fs.appendFileSync(file, lines.map((l) => `${l}\n`).join(''));
  const later = new Date(Date.now() + 2000 * (start + 1));
  fs.utimesSync(file, later, later);
  return file;
}

beforeAll(async () => { await initEmbeddings(); }, 300_000);

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'starmemory-forget-races-'));
  store = openStore(path.join(dir, 'store.mdb'));
  coworkRoot = path.join(dir, 'cowork');
  archiveRoot = path.join(dir, 'archive');
  forgottenPath = path.join(dir, 'forgotten.txt');
  claudeDir = path.join(dir, 'claude');
  gates.clear();
  harnessGates.clear();
  Object.assign(embedGate, { armed: false, hit: false, hold: Promise.resolve() });
});

afterEach(async () => {
  for (const i of openedIndexes.splice(0)) i.close();
  await store.close();
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe('two full syncs at once, after a forget is taken back', () => {
  it('store what was written since the forget once, and nothing it deleted', async () => {
    const s = 'cc-race';
    const file = claudeTranscript(s, 6);            // lines 1-12
    await sync([claudeDir]);                          // cursor 12, copy, six rows
    claudeTranscript(s, 1, 6);                        // lines 13-14 appended, not synced
    forget(s, { coworkRoot, forgottenPath, archiveRoot, store });
    await sync([coworkRoot]);                         // what forget starts: the rows go, the cursor stays
    expect(exchangesFrom(store, 0)).toHaveLength(0);
    expect(store.meta.get(syncCursorKey(file))).toBe(12);
    const copy = path.join(archiveRoot, 'claude', '-Users-me-lanterns', `${s}.jsonl.gz`);
    expect(fs.existsSync(copy)).toBe(false);
    fs.writeFileSync(forgottenPath, '');              // taken back

    let release!: () => void;
    gates.set(file, { calls: 0, holdCall: 2, hold: new Promise<void>((r) => { release = r; }) });
    const s1 = sync([claudeDir]);
    const s2 = sync([claudeDir]);                     // held in its parse while s1 copies and embeds
    while (!fs.existsSync(copy)) await new Promise((r) => setTimeout(r, 2));
    release();
    const [r1, r2] = await Promise.all([s1, s2]);
    await sync([claudeDir]);

    const rows = exchangesFrom(store, 0).map((r) => r.lineStart);
    expect({ rows, indexed: r1.exchangesIndexed + r2.exchangesIndexed, cursor: store.meta.get(syncCursorKey(file)) }).toEqual({ rows: [13], indexed: 1, cursor: 14 });
  }, 120_000);
});

describe('a Cowork record forgotten while the sync that indexes it runs', () => {
  it('can be recorded again under its key when the forget is taken back before that sync stores the rows', async () => {
    const entry = (found: string) => ({ session: 's-back2', title: 'Lanterns', asked: 'How often to trim?', found, project: 'lanterns' });
    // As the MCP server calls it: a record started again drops its key's cursor.
    const rem = (found: string) => remember(coworkRoot, entry(found), { onStart: (f) => store.meta.remove(syncCursorKey(f)) });
    rem('first');
    rem('second');
    let release!: () => void;
    embedGate.hold = new Promise<void>((r) => { release = r; });
    embedGate.armed = true;
    const s1 = sync([coworkRoot]);                    // what the remember started, held in its embedding
    while (!embedGate.hit) await new Promise((r) => setTimeout(r, 2));
    forget('s-back2', { coworkRoot, forgottenPath, archiveRoot, store });
    await sync([coworkRoot]);                         // what the forget started
    fs.writeFileSync(forgottenPath, '');              // taken back, before s1 has stored anything
    release();
    await s1;                                         // finds its record gone, and stores nothing

    const { file } = rem('third, after taking the forget back');
    await sync([coworkRoot]);

    expect({
      rows: exchangesFrom(store, 0).map((r) => r.assistantMessage),
      cursor: store.meta.get(syncCursorKey(file)),
    }).toEqual({ rows: ['Lanterns\n\nthird, after taking the forget back'], cursor: 3 });
  }, 120_000);

  it('stores nothing of the old record when a new one was started under its key before that sync stores the rows', async () => {
    const entry = (found: string) => ({ session: 's-new', title: 'Lanterns', asked: 'How often to trim?', found, project: 'lanterns' });
    const rem = (found: string) => remember(coworkRoot, entry(found), { onStart: (f) => store.meta.remove(syncCursorKey(f)) });
    rem('first');
    rem('second');                                    // lines 1-5
    let release!: () => void;
    embedGate.hold = new Promise<void>((r) => { release = r; });
    embedGate.armed = true;
    const s1 = sync([coworkRoot]);                    // held in its embedding of the old record
    while (!embedGate.hit) await new Promise((r) => setTimeout(r, 2));
    forget('s-new', { coworkRoot, forgottenPath, archiveRoot, store });
    await sync([coworkRoot]);
    fs.writeFileSync(forgottenPath, '');
    const { file } = rem('third, in the new record'); // lines 1-3 of a new record, its cursor dropped
    release();
    await s1;
    rem('fourth, in the new record');                 // lines 4-5
    await sync([coworkRoot]);

    expect({
      rows: exchangesFrom(store, 0).map((r) => r.assistantMessage),
      cursor: store.meta.get(syncCursorKey(file)),
    }).toEqual({ rows: ['Lanterns\n\nthird, in the new record', 'Lanterns\n\nfourth, in the new record'], cursor: 5 });
  }, 120_000);

  it('tells a record written before generations from a new one with the very same header line', async () => {
    const s = 's-old';
    const projectDir = path.join(coworkRoot, 'lanterns');
    fs.mkdirSync(projectDir, { recursive: true });
    const file = path.join(projectDir, `${s}.jsonl`);
    const header = { type: 'cowork_session', version: 1, session: s, project: 'lanterns', createdAt: '2026-09-28T10:00:00.000Z' };
    const record = (...found: string[]) => [header, ...found.flatMap((f) => [
      { type: 'user', promptSource: 'typed', sessionId: s, timestamp: '2026-09-28T10:00:00.000Z', message: { role: 'user', content: 'How often to trim?' } },
      { type: 'assistant', sessionId: s, timestamp: '2026-09-28T10:00:00.000Z', message: { role: 'assistant', content: `Lanterns\n\n${f}` } },
    ])].map((l) => `${JSON.stringify(l)}\n`).join('');
    fs.writeFileSync(file, record('first', 'second'));
    let release!: () => void;
    embedGate.hold = new Promise<void>((r) => { release = r; });
    embedGate.armed = true;
    const s1 = sync([coworkRoot]);
    while (!embedGate.hit) await new Promise((r) => setTimeout(r, 2));
    // Set aside, so the old file keeps its inode while the new one is written.
    forget(s, { coworkRoot, forgottenPath, archiveRoot, store, quarantine: { root: path.join(dir, 'quarantine'), days: 7 } });
    await sync([coworkRoot]);
    fs.writeFileSync(forgottenPath, '');
    fs.writeFileSync(file, record('third, in the new record'));
    release();
    await s1;
    await sync([coworkRoot]);

    expect(exchangesFrom(store, 0).map((r) => r.assistantMessage)).toEqual(['Lanterns\n\nthird, in the new record']);
  }, 120_000);

  it('can be recorded again under its key once the forget is taken back', async () => {
    const entry = (found: string) => ({ session: 's-race', title: 'Lanterns', asked: 'How often to trim?', found, project: 'lanterns' });
    remember(coworkRoot, entry('first'));
    const { file } = remember(coworkRoot, entry('second'));
    let release!: () => void;
    embedGate.hold = new Promise<void>((r) => { release = r; });
    embedGate.armed = true;
    const s1 = sync([coworkRoot]);                    // what the remember started, held in its embedding
    while (!embedGate.hit) await new Promise((r) => setTimeout(r, 2));
    forget('s-race', { coworkRoot, forgottenPath, archiveRoot, store });
    await sync([coworkRoot]);                         // what the forget started
    release();
    await s1;                                         // stores the rows after the forget, then its late pass deletes them
    expect(exchangesFrom(store, 0)).toEqual([]);

    fs.writeFileSync(forgottenPath, '');
    remember(coworkRoot, entry('third, after taking the forget back'));
    await sync([coworkRoot]);

    expect(fs.existsSync(file)).toBe(true);
    expect(exchangesFrom(store, 0).map((r) => r.assistantMessage)).toEqual(['Lanterns\n\nthird, after taking the forget back']);
  }, 120_000);
});

describe('a forget taken back while a sync that read the old list is still walking', () => {
  it('keeps the Cowork record the user wrote after taking the forget back', async () => {
    const entry = (found: string) => ({ session: 's-back', title: 'Lanterns', asked: 'How often to trim?', found, project: 'lanterns' });
    remember(coworkRoot, entry('first'));
    await sync([coworkRoot]);
    forget('s-back', { coworkRoot, forgottenPath, archiveRoot, store });
    await sync([coworkRoot]);
    expect(exchangesFrom(store, 0)).toHaveLength(0);
    claudeTranscript('busy', 8);                      // keeps the full sync embedding before it reaches the records

    const s1 = sync([claudeDir, coworkRoot]);         // reads forgotten.txt now: s-back is on it
    fs.writeFileSync(forgottenPath, '');              // taken back
    const { file } = remember(coworkRoot, entry('second'));
    await sync([coworkRoot]);                         // what remember starts
    expect(fs.existsSync(file)).toBe(true);
    expect(exchangesFrom(store, 0).filter((r) => r.sessionId === 's-back').map((r) => r.assistantMessage)).toEqual(['Lanterns\n\nsecond']);
    await s1;

    expect({
      record: fs.existsSync(file),
      rows: exchangesFrom(store, 0).filter((r) => r.sessionId === 's-back').length,
      cursor: store.meta.get(syncCursorKey(file)),
    }).toEqual({ record: true, rows: 1, cursor: 3 });
  }, 120_000);
});

describe('a Cowork record past the TTL, written to while the sync that found it old decides', () => {
  it('keeps the entry a remember added after its age was read, and indexes it', async () => {
    const entry = (found: string) => ({ session: 's-ttl', title: 'Lanterns', asked: 'How often to trim?', found, project: 'lanterns' });
    const { file } = remember(coworkRoot, entry('first'));
    await sync([coworkRoot]);
    const then = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000);
    fs.utimesSync(file, then, then);
    fs.utimesSync(path.join(archiveRoot, 'cowork', 'lanterns', 's-ttl.jsonl.gz'), then, then);
    let release!: () => void;
    const gate = { hit: false, hold: new Promise<void>((r) => { release = r; }) };
    harnessGates.set(file, gate);
    const s1 = sync([coworkRoot]);                    // past the TTL of 180 days, held before it deletes
    while (!gate.hit) await new Promise((r) => setTimeout(r, 2));
    remember(coworkRoot, entry('second, while the sync decided'));
    release();
    await s1;

    expect({
      entries: countEntries(file),
      rows: exchangesFrom(store, 0).map((r) => r.assistantMessage),
    }).toEqual({ entries: 2, rows: ['Lanterns\n\nfirst', 'Lanterns\n\nsecond, while the sync decided'] });
  }, 120_000);
});

describe('a forgotten Cowork record still in the records folder, written to while the sync that found it decides', () => {
  it('is put back rather than set aside with the entry, and set aside whole by the next sync', async () => {
    const s = 's-aside';
    const { file } = remember(coworkRoot, { session: s, title: 'Lanterns', asked: 'How often to trim?', found: 'first', project: 'lanterns' });
    fs.writeFileSync(forgottenPath, `${s}\n`);       // forgotten, as a forget that could not move it leaves it
    const quarantine = { root: path.join(dir, 'quarantine'), days: 7 };
    const syncAside = () =>
      syncAll(store, openIndex(store, path.join(dir, 'index.hnsw')), [coworkRoot], undefined, {
        archiveRoot, coworkRoot, forgottenPath, quarantine, log: () => {}, summaries: { summarizers: noSummaries },
      });
    let release!: () => void;
    const gate = { calls: 0, holdCall: 1, hold: new Promise<void>((r) => { release = r; }) };
    gates.set(file, gate);
    const s1 = syncAside();                           // held in its parse, the record's stat read
    while (gate.calls === 0) await new Promise((r) => setTimeout(r, 2));
    const [, user, assistant] = fs.readFileSync(file, 'utf8').split('\n');
    fs.appendFileSync(file, `${user}\n${assistant}\n`); // what a remember that had it open adds
    release();
    await s1;

    expect({ entries: countEntries(file), setAside: findSetAside(quarantine.root, s) }).toEqual({ entries: 2, setAside: [] });
    await syncAside();
    expect({ record: fs.existsSync(file), setAside: findSetAside(quarantine.root, s).map(countEntries) }).toEqual({ record: false, setAside: [2] });
  }, 120_000);
});
