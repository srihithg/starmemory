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
import { remember } from '../src/cowork.js';
import { forget } from '../src/forget.js';

// A gate on the Nth parseConversation call for one file: holds one of two
// concurrent syncs after its cursor read, while the other copies and inserts.
const { gates } = vi.hoisted(() => ({ gates: new Map<string, { calls: number; holdCall: number; hold: Promise<void> }>() }));
vi.mock('../src/parser.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/parser.js')>();
  return {
    ...actual,
    parseConversation: async (filePath: string, project: string, archivePath: string) => {
      const g = gates.get(filePath);
      if (g && ++g.calls === g.holdCall) await g.hold;
      return actual.parseConversation(filePath, project, archivePath);
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
    await s1;                                         // stores the old record's rows, and a cursor at its end

    rem('third, after taking the forget back');
    await sync([coworkRoot]);

    expect(exchangesFrom(store, 0).map((r) => r.assistantMessage)).toContain('Lanterns\n\nthird, after taking the forget back');
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
