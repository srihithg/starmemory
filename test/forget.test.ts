// "Don't record this", in any words, becomes `forget`. The list of forgotten
// sessions is what everything goes by: remember refuses a session on it, search
// hides it at once, and the next sync deletes what is left of it the way the
// TTL deletes an expired conversation.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStore, insertExchange, exchangesFrom, getVector, syncCursorKey, type StoreHandle } from '../src/store.js';
import { TextIndex } from '../src/text-index.js';
import { VectorIndex } from '../src/vector-index.js';
import { EMBEDDING_DIM } from '../src/embeddings.js';
import { archivePathFor, summaryPathFor } from '../src/archive.js';
import { writeSummary } from '../src/summaries.js';
import { search, searchMultipleConcepts } from '../src/search.js';
import { RefusedError, findRecords, remember } from '../src/cowork.js';
import {
  addForgotten,
  defaultForgottenPath,
  describeForget,
  forget,
  forgetSessions,
  readForgotten,
} from '../src/forget.js';
import type { Harness } from '../src/types.js';

let dir: string;
let store: StoreHandle;
let coworkRoot: string;
let forgottenPath: string;
let archiveRoot: string;
const openedIndexes: VectorIndex[] = [];

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'starmemory-forget-'));
  store = openStore(path.join(dir, 'store.mdb'));
  coworkRoot = path.join(dir, 'cowork');
  forgottenPath = path.join(dir, 'forgotten.txt');
  archiveRoot = path.join(dir, 'archive');
});
afterEach(async () => {
  for (const i of openedIndexes.splice(0)) i.close();
  await store.close();
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

function vec(i: number): Float32Array {
  const v = new Float32Array(EMBEDDING_DIM);
  v[i % EMBEDDING_DIM] = 1;
  return v;
}

/** A stored conversation with an archive copy and a summary, as sync leaves one. */
function conversation(session: string, harness: Harness = 'cowork', turns = 2) {
  const copy = archivePathFor(archiveRoot, harness, 'lanterns', `/src/lanterns/${session}.jsonl`);
  const ids: number[] = [];
  for (let t = 0; t < turns; t++) {
    ids.push(insertExchange(store, {
      harness, project: 'lanterns', sessionId: session, timestamp: '2026-09-28T10:00:00.000Z',
      userMessage: `${session} question ${t} about lantern wicks`, assistantMessage: `${session} answer ${t}`,
      archivePath: copy, lineStart: t * 2 + 2, lineEnd: t * 2 + 3, embeddingVersion: 1,
    }, vec(ids.length + (harness === 'cowork' ? 1 : 100))));
  }
  fs.mkdirSync(path.dirname(copy), { recursive: true });
  fs.writeFileSync(copy, 'gz bytes');
  writeSummary(summaryPathFor(copy), `${session} summary`);
  return { ids, copy, summary: summaryPathFor(copy) };
}

function textIndexWithAll(): TextIndex {
  const index = TextIndex.open(path.join(dir, 'text'));
  expect(index.tryAcquireWriter()).toBe(true);
  index.addExchanges(exchangesFrom(store, 0));
  index.commit();
  return index;
}

const entry = (session: string) => ({ session, title: 'Lanterns', asked: 'How to trim a wick?', found: 'Flat, every forty hours.', project: 'lanterns' });

describe('the forgotten list', () => {
  it('reads back what was added, ignoring its comments and blank lines', () => {
    addForgotten(forgottenPath, 'a');
    addForgotten(forgottenPath, 'b');
    fs.appendFileSync(forgottenPath, '\n  \n# a note\n');

    expect(readForgotten(forgottenPath)).toEqual(new Set(['a', 'b']));
    expect(fs.readFileSync(forgottenPath, 'utf8').startsWith('# ')).toBe(true);
  });

  it('starts a key on a line of its own when the file was left without a final newline', () => {
    addForgotten(forgottenPath, 'sess-a');
    // What deleting the last line in an editor can leave behind.
    fs.writeFileSync(forgottenPath, fs.readFileSync(forgottenPath, 'utf8').trimEnd());

    addForgotten(forgottenPath, 'sess-c');

    expect(readForgotten(forgottenPath)).toEqual(new Set(['sess-a', 'sess-c']));
  });

  it('reads a key an editor saved with a byte-order mark before it, which trim() drops', () => {
    fs.writeFileSync(forgottenPath, '\uFEFFsess-a\n');

    expect(readForgotten(forgottenPath)).toEqual(new Set(['sess-a']));
  });

  it('is empty when there is no file yet', () => {
    expect(readForgotten(path.join(dir, 'missing.txt'))).toEqual(new Set());
  });

  it('lives under ~/.config/starmemory unless STARMEMORY_FORGOTTEN_PATH says otherwise', () => {
    expect(defaultForgottenPath({})).toBe(path.join(os.homedir(), '.config', 'starmemory', 'forgotten.txt'));
    expect(defaultForgottenPath({ STARMEMORY_FORGOTTEN_PATH: '/x/f.txt' })).toBe('/x/f.txt');
  });
});

describe('forget', () => {
  it('removes the Cowork record at once and lists the session, so remember refuses it from then on', () => {
    remember(coworkRoot, entry('s-1'));
    const { file } = remember(coworkRoot, entry('s-1'));

    const result = forget('s-1', { coworkRoot, forgottenPath, archiveRoot });

    expect(result).toMatchObject({ records: [file], entries: 2, pendingRows: 0, alreadyForgotten: false });
    expect(fs.existsSync(file)).toBe(false);
    expect(readForgotten(forgottenPath).has('s-1')).toBe(true);
    const isForgotten = (s: string) => readForgotten(forgottenPath).has(s);
    expect(() => remember(coworkRoot, entry('s-1'), { isForgotten })).toThrow(RefusedError);
    expect(findRecords(coworkRoot, 's-1')).toEqual([]);
    expect(remember(coworkRoot, entry('s-2'), { isForgotten }).entries).toBe(1);
  });

  it('counts the indexed exchanges the sync still has to delete, and removes the archive copy and summary at once', () => {
    const { copy, summary } = conversation('s-1');
    const kept = conversation('s-2');

    const result = forget('s-1', { coworkRoot, forgottenPath, archiveRoot, store });

    expect(result).toMatchObject({ records: [], copies: [copy], pendingRows: 2, pendingHarnesses: ['cowork'] });
    expect(fs.existsSync(copy)).toBe(false);
    expect(fs.existsSync(summary)).toBe(false);
    expect(fs.existsSync(kept.copy)).toBe(true);
    expect(describeForget(result)).toContain('the archive copy starmemory kept of it');
    expect(describeForget(result)).toContain('Hidden from search from now on: 2 indexed exchanges.');
    expect(describeForget(result)).not.toContain('Claude Code or Codex transcript');
  });

  it('forgets a Claude Code session too, and says its transcript stays with Claude Code', () => {
    conversation('7f3c9a52-0000-4000-8000-000000000001', 'claude');

    const result = forget('7f3c9a52-0000-4000-8000-000000000001', { coworkRoot, forgottenPath, archiveRoot, store });

    expect(result.pendingHarnesses).toEqual(['claude']);
    expect(describeForget(result)).toContain('stays where that harness keeps it');
  });

  it('removes the archive copy of a record that never produced a row, found from the record itself', () => {
    const { file } = remember(coworkRoot, entry('s-1'));
    // A copy taken while the record held only its header: no exchange, so no row points at it.
    const copy = archivePathFor(archiveRoot, 'cowork', 'lanterns', file);
    fs.mkdirSync(path.dirname(copy), { recursive: true });
    fs.writeFileSync(copy, 'gz bytes');

    const result = forget('s-1', { coworkRoot, forgottenPath, archiveRoot, store });

    expect(result.copies).toEqual([copy]);
    expect(fs.existsSync(copy)).toBe(false);
  });

  it('takes a key that is only the tail of a Codex session\'s id for no session at all', () => {
    const id = '0199aaaa-bbbb-7ccc-8ddd-eeeeffff0002';
    const copy = path.join(archiveRoot, 'codex', 'lanterns', `rollout-2026-09-28T10-00-00-${id}.jsonl.gz`);
    fs.mkdirSync(path.dirname(copy), { recursive: true });
    fs.writeFileSync(copy, 'gz bytes');

    for (const tail of ['eeeeffff0002', '8ddd-eeeeffff0002']) {
      const result = forget(tail, { coworkRoot, forgottenPath, archiveRoot, store });
      expect(result.copies).toEqual([]);
      expect(describeForget(result)).toContain('Nothing was stored under this key');
    }
    expect(fs.existsSync(copy)).toBe(true);
    expect(forget(id, { coworkRoot, forgottenPath, archiveRoot, store }).copies).toEqual([copy]);
  });

  it('says so when nothing was stored under the key, in case it is the wrong one', () => {
    const result = forget('no-such-session', { coworkRoot, forgottenPath, archiveRoot, store });

    expect(describeForget(result)).toContain('Nothing was stored under this key');
    expect(describeForget(result)).toContain('start-up line');
  });

  it('lists a session once, however often it is forgotten', () => {
    forget('s-1', { coworkRoot, forgottenPath, archiveRoot });
    const again = forget('s-1', { coworkRoot, forgottenPath, archiveRoot });

    expect(again.alreadyForgotten).toBe(true);
    expect(fs.readFileSync(forgottenPath, 'utf8').match(/^s-1$/gm)).toHaveLength(1);
    expect(describeForget(again)).toContain('forgotten already');
  });

  it('refuses a key that could not name a session, and lists nothing', () => {
    expect(() => forget('../../etc/passwd', { coworkRoot, forgottenPath, archiveRoot })).toThrow(RefusedError);
    expect(fs.existsSync(forgottenPath)).toBe(false);
  });
});

describe('forget on a server that serves Cowork records only', () => {
  const dirs = () => ({ claude: path.join(dir, 'claude', 'projects'), codex: path.join(dir, 'codex', 'sessions') });
  const coworkOnly = () => ({ dirs: dirs() });
  const place = (file: string) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{}\n');
  };
  const refused = (session: string) => {
    expect(() => forget(session, { coworkRoot, forgottenPath, archiveRoot, store, coworkOnly: coworkOnly() })).toThrow(
      /is a Claude Code or Codex session on this computer, and this server serves Cowork records only/
    );
    expect(readForgotten(forgottenPath).has(session)).toBe(false);
  };

  it('refuses a session whose rows came from Claude Code or Codex, and changes nothing', () => {
    const claude = conversation('7f3c9a52-0000-4000-8000-000000000001', 'claude');
    conversation('0199aaaa-bbbb-7ccc-8ddd-eeeeffff0009', 'codex');

    refused('7f3c9a52-0000-4000-8000-000000000001');
    refused('0199aaaa-bbbb-7ccc-8ddd-eeeeffff0009');
    expect(fs.existsSync(claude.copy)).toBe(true);
    expect(fs.existsSync(claude.summary)).toBe(true);
    expect(exchangesFrom(store, 0)).toHaveLength(4);
  });

  it('refuses one found only by its archive copy, or by its transcript where Claude Code or Codex keeps it', () => {
    place(path.join(archiveRoot, 'claude', '-Users-me-lanterns', 'aaaaaaaa-0000-4000-8000-000000000001.jsonl.gz'));
    place(path.join(archiveRoot, 'codex', 'lanterns', 'rollout-2026-09-28T10-00-00-0199aaaa-bbbb-7ccc-8ddd-eeeeffff0001.jsonl.gz'));
    place(path.join(dirs().claude, '-Users-me-lanterns', 'bbbbbbbb-0000-4000-8000-000000000002.jsonl'));
    place(path.join(dirs().claude, '-Users-me-lanterns', 'cccccccc-0000-4000-8000-000000000003', 'subagents', 'agent-a1b2c3.jsonl'));
    place(path.join(dirs().codex, '2026', '09', '28', 'rollout-2026-09-28T10-00-00-0199aaaa-bbbb-7ccc-8ddd-eeeeffff0002.jsonl'));

    for (const session of [
      'aaaaaaaa-0000-4000-8000-000000000001',
      '0199aaaa-bbbb-7ccc-8ddd-eeeeffff0001',
      'bbbbbbbb-0000-4000-8000-000000000002',
      'cccccccc-0000-4000-8000-000000000003',
      '0199aaaa-bbbb-7ccc-8ddd-eeeeffff0002',
    ]) refused(session);
    expect(fs.existsSync(forgottenPath)).toBe(false);
  });

  it('refuses a key that is the whole file name of a transcript Claude Code or Codex keeps, at any depth', () => {
    const rollout = 'rollout-2026-09-28T10-00-00-0199aaaa-bbbb-7ccc-8ddd-eeeeffff0003';
    place(path.join(dirs().codex, '2026', '09', '28', `${rollout}.jsonl`));
    place(path.join(dirs().claude, '-Users-me-lanterns', 'dddddddd-0000-4000-8000-000000000004', 'subagents', 'agent-d4e5f6.jsonl'));
    // Found only by its archive copy, its rollout since gone.
    place(path.join(archiveRoot, 'codex', 'lanterns', 'rollout-2026-09-28T11-00-00-0199aaaa-bbbb-7ccc-8ddd-eeeeffff0004.jsonl.gz'));

    for (const session of [rollout, 'agent-d4e5f6', 'rollout-2026-09-28T11-00-00-0199aaaa-bbbb-7ccc-8ddd-eeeeffff0004']) refused(session);
    expect(fs.existsSync(forgottenPath)).toBe(false);
    // A Cowork key is still taken.
    expect(forget('cowork-2026-09-29-fresh001', { coworkRoot, forgottenPath, archiveRoot, store, coworkOnly: coworkOnly() }).alreadyForgotten).toBe(false);
  });

  it('takes a key that is only the tail of a Codex session\'s id for a Cowork key', () => {
    place(path.join(dirs().codex, '2026', '09', '28', 'rollout-2026-09-28T10-00-00-0199aaaa-bbbb-7ccc-8ddd-eeeeffff0002.jsonl'));

    expect(forget('eeeeffff0002', { coworkRoot, forgottenPath, archiveRoot, store, coworkOnly: coworkOnly() }).alreadyForgotten).toBe(false);
    expect(readForgotten(forgottenPath).has('eeeeffff0002')).toBe(true);
  });

  it('lists a key that has stored nothing yet, so remember refuses it from the first entry', () => {
    const session = 'cowork-2026-09-29-abcd1234';
    const result = forget(session, { coworkRoot, forgottenPath, archiveRoot, store, coworkOnly: coworkOnly() });

    expect(result).toMatchObject({ records: [], setAside: [], copies: [], pendingRows: 0 });
    expect(describeForget(result)).toContain('Nothing was stored under this key');
    expect(() => remember(coworkRoot, entry(session), { isForgotten: (s) => readForgotten(forgottenPath).has(s) })).toThrow(/asked to forget/);
    expect(findRecords(coworkRoot, session)).toEqual([]);
  });

  it('forgets a Cowork session that has rows and a record', () => {
    const { copy } = conversation('s-1');
    remember(coworkRoot, entry('s-1'));

    const result = forget('s-1', { coworkRoot, forgottenPath, archiveRoot, store, coworkOnly: coworkOnly() });

    expect(result).toMatchObject({ pendingRows: 2, pendingHarnesses: ['cowork'], entries: 1 });
    expect(fs.existsSync(copy)).toBe(false);
  });
});

describe('forget with a quarantine', () => {
  const quarantine = () => ({ root: path.join(dir, 'quarantine'), days: 7 });

  it('sets the record aside instead of deleting it, removes the archive copy at once, and says so', () => {
    remember(coworkRoot, entry('s-1'));
    const { file } = remember(coworkRoot, entry('s-1'));
    const copy = archivePathFor(archiveRoot, 'cowork', 'lanterns', file);
    fs.mkdirSync(path.dirname(copy), { recursive: true });
    fs.writeFileSync(copy, 'gz bytes');

    const result = forget('s-1', { coworkRoot, forgottenPath, archiveRoot, store, quarantine: quarantine() });

    expect(result).toMatchObject({ records: [file], entries: 2, copies: [copy], setAsideDays: 7 });
    expect(result.setAside).toHaveLength(1);
    const [{ from, to }] = result.setAside;
    expect(from).toBe(file);
    expect(fs.existsSync(file)).toBe(false);
    expect(fs.readFileSync(to, 'utf8')).toContain('How to trim a wick?');
    expect(fs.existsSync(copy)).toBe(false);
    expect(readForgotten(forgottenPath).has('s-1')).toBe(true);
    const said = describeForget(result);
    const until = new Date(result.setAside[0].expiresAt).toISOString().replace(/\.\d{3}Z$/, 'Z');
    expect(said).toContain(`Set aside now: its Cowork record, 2 entries. It is hidden from search and read from this moment, and kept for 7 days, until ${until} (${to})`);
    expect(said).toContain('so that a forget the user did not mean can be undone. After that a sync deletes it for good.');
    expect(said).toContain(`To undo it before then: delete the line s-1 from ${forgottenPath}, then move ${to} back to ${file}.`);
    expect(said).toContain('Removed now: the archive copy starmemory kept of it, with any summary.');
    expect(said).not.toContain('Removed now: its Cowork record');
    expect(said).not.toContain('Nothing was stored');
  });

  it('keeps the record\'s cursor, which the sync that deletes the rows removes with them', () => {
    const { file } = remember(coworkRoot, entry('s-1'));
    store.meta.putSync(syncCursorKey(file), 3);

    forget('s-1', { coworkRoot, forgottenPath, archiveRoot, store, quarantine: quarantine() });

    expect(store.meta.get(syncCursorKey(file))).toBe(3);
  });

  it('leaves a record it cannot set aside where it is, hidden, and says so rather than throwing', () => {
    const { file } = remember(coworkRoot, entry('s-1'));
    store.meta.putSync(syncCursorKey(file), 3);
    // A quarantine that cannot be made, on any platform: its parent is a file.
    fs.writeFileSync(path.join(dir, 'not-a-folder'), '');
    const unusable = { root: path.join(dir, 'not-a-folder', 'quarantine'), days: 7 };

    const result = forget('s-1', { coworkRoot, forgottenPath, archiveRoot, store, quarantine: unusable });

    expect(result).toMatchObject({ records: [file], entries: 1, setAside: [], notSetAside: { records: [file] } });
    expect(result.notSetAside?.reason).toMatch(/\S/);
    expect(fs.readFileSync(file, 'utf8')).toContain('How to trim a wick?');
    expect(readForgotten(forgottenPath).has('s-1')).toBe(true);
    expect(store.meta.get(syncCursorKey(file))).toBe(3);
    const said = describeForget(result);
    expect(said).toContain(`Hidden now: its Cowork record (${file}) is hidden from search and read from this moment, but it could not be set aside yet: ${result.notSetAside?.reason}.`);
    expect(said).toContain('It stays where it is until the next sync, which tries again to set it aside.');
    expect(said).toContain(`To undo it: delete the line s-1 from ${forgottenPath}.`);
    expect(said).not.toContain('Set aside now');
    expect(said).not.toContain('Removed now: its Cowork record');
    expect(said).not.toContain('Nothing was stored');
  });

  it('tells a second forget from Cowork the record is still set aside, and leaves it there', () => {
    remember(coworkRoot, entry('s-1'));
    const [first] = forget('s-1', { coworkRoot, forgottenPath, archiveRoot, store, quarantine: quarantine() }).setAside;

    const again = forget('s-1', { coworkRoot, forgottenPath, archiveRoot, store, quarantine: quarantine() });

    expect(again).toMatchObject({ alreadyForgotten: true, setAside: [], earlier: { records: [first], entries: 1, removed: false } });
    expect(fs.existsSync(first.to)).toBe(true);
    const said = describeForget(again);
    const until = new Date(first.expiresAt).toISOString().replace(/\.\d{3}Z$/, 'Z');
    expect(said).toContain(`Still set aside by an earlier forget: its Cowork record (${first.to}), kept until ${until}, when a sync deletes it for good.`);
    expect(said).toContain(`then move ${first.to} back to ${first.from}.`);
    expect(said).not.toContain('nothing of it is stored');
  });

  it('deletes what a forget from Cowork set aside when forgotten again from Claude Code or Codex, and says so', () => {
    remember(coworkRoot, entry('s-1'));
    remember(coworkRoot, entry('other'));
    const [first] = forget('s-1', { coworkRoot, forgottenPath, archiveRoot, store, quarantine: quarantine() }).setAside;
    const [kept] = forget('other', { coworkRoot, forgottenPath, archiveRoot, store, quarantine: quarantine() }).setAside;
    store.meta.putSync(syncCursorKey(first.from), 3);

    const again = forget('s-1', { coworkRoot, forgottenPath, archiveRoot, store, quarantineRoot: quarantine().root });

    expect(again).toMatchObject({ alreadyForgotten: true, earlier: { records: [first], entries: 1, removed: true } });
    expect(fs.existsSync(first.to)).toBe(false);
    expect(fs.existsSync(kept.to)).toBe(true);
    expect(store.meta.get(syncCursorKey(first.from))).toBeUndefined();
    const said = describeForget(again);
    expect(said).toContain(`Removed now: its Cowork record that an earlier forget set aside, 1 entry (${first.to}).`);
    expect(said).not.toContain('nothing of it is stored');
    expect(said).not.toContain('Still set aside');
    // Nothing is left, and the next one says so.
    expect(describeForget(forget('s-1', { coworkRoot, forgottenPath, archiveRoot, store, quarantineRoot: quarantine().root }))).toContain(
      'It had been forgotten already; nothing of it is stored.'
    );
  });

  it('deletes at once, as without one, when its days are 0', () => {
    const { file } = remember(coworkRoot, entry('s-1'));
    store.meta.putSync(syncCursorKey(file), 3);

    const result = forget('s-1', { coworkRoot, forgottenPath, archiveRoot, store, quarantine: { ...quarantine(), days: 0 } });

    expect(result).toMatchObject({ records: [file], setAside: [] });
    expect(fs.existsSync(file)).toBe(false);
    expect(fs.existsSync(quarantine().root)).toBe(false);
    expect(store.meta.get(syncCursorKey(file))).toBeUndefined();
    expect(describeForget(result)).toContain('Removed now: its Cowork record, 1 entry');
  });
});

describe('search after forget', () => {
  it('leaves the forgotten session out at once, before any sync has deleted it', async () => {
    conversation('forgotten');
    conversation('kept');
    const text = textIndexWithAll();
    const vectors = VectorIndex.open(store, path.join(dir, 'index.hnsw'));
    openedIndexes.push(vectors);
    forget('forgotten', { coworkRoot, forgottenPath, archiveRoot, store });
    const excludeSessions = readForgotten(forgottenPath);

    const withBm25 = await search(store, vectors, 'lantern wicks', { mode: 'text', excludeSessions }, text);
    const withSubstring = await search(store, vectors, 'lantern wicks', { mode: 'text', excludeSessions });

    for (const results of [withBm25, withSubstring]) {
      expect(results.map((r) => r.exchange.sessionId)).toEqual(['kept', 'kept']);
    }
  });

  it('still fills the limit when the forgotten session\'s rows rank first', async () => {
    const row = (session: string, userMessage: string, timestamp: string, axis: number) =>
      insertExchange(store, {
        harness: 'cowork', project: 'lanterns', sessionId: session, timestamp, userMessage, assistantMessage: 'noted',
        archivePath: archivePathFor(archiveRoot, 'cowork', 'lanterns', `/src/lanterns/${session}.jsonl`),
        lineStart: 2, lineEnd: 3, embeddingVersion: 1,
      }, vec(axis));
    row('kept', 'a long question about chimneys, oil, glass and also lantern wicks', '2026-09-01T10:00:00.000Z', 1);
    // Newer, shorter and more of them: they rank first by BM25 and by recency.
    for (let t = 0; t < 3; t++) row('forgotten', `lantern wicks ${t}`, `2026-09-28T10:00:0${t}.000Z`, 10 + t);
    const text = textIndexWithAll();
    const vectors = VectorIndex.open(store, path.join(dir, 'index.hnsw'));
    openedIndexes.push(vectors);
    forget('forgotten', { coworkRoot, forgottenPath, archiveRoot, store });
    const excludeSessions = readForgotten(forgottenPath);

    for (const textIndex of [text, undefined]) {
      const results = await search(store, vectors, 'lantern wicks', { mode: 'text', limit: 1, excludeSessions }, textIndex);
      expect(results.map((r) => r.exchange.sessionId)).toEqual(['kept']);
    }
  });

  it('leaves the forgotten session out of a multi-concept search too', async () => {
    // Two rows: each concept's vector search returns both, whatever the query.
    conversation('forgotten', 'cowork', 1);
    conversation('kept', 'cowork', 1);
    const vectors = VectorIndex.open(store, path.join(dir, 'index.hnsw'));
    openedIndexes.push(vectors);
    forget('forgotten', { coworkRoot, forgottenPath, archiveRoot, store });

    const results = await searchMultipleConcepts(store, vectors, ['lantern', 'wick'], { excludeSessions: readForgotten(forgottenPath) });

    expect(results.map((r) => r.exchange.sessionId)).toEqual(['kept']);
  }, 120_000);
});

describe('forgetSessions, the sync step', () => {
  it('deletes the rows, vectors, text documents, archive copy and summary of a forgotten session, and nothing else', () => {
    const gone = conversation('gone');
    const kept = conversation('kept');
    const text = textIndexWithAll();

    const result = forgetSessions(store, text, new Set(['gone', 'never-stored']), { archiveRoot, log: () => {} });

    expect(result).toEqual({ rows: 2, files: 1, skipped: false });
    expect(exchangesFrom(store, 0).map((e) => e.id)).toEqual(kept.ids);
    for (const id of gone.ids) expect(getVector(store, id, EMBEDDING_DIM)).toBeUndefined();
    expect(text.search('lantern', 10).map((h) => h.id).sort()).toEqual([...kept.ids].sort());
    expect(fs.existsSync(gone.copy)).toBe(false);
    expect(fs.existsSync(gone.summary)).toBe(false);
    expect(fs.existsSync(kept.copy)).toBe(true);
    expect(fs.existsSync(kept.summary)).toBe(true);
  });

  it('leaves everything to the next sync while another process holds the text writer', () => {
    const gone = conversation('gone');
    const holder = textIndexWithAll(); // keeps the writer lock for the rest of the test
    const mine = TextIndex.open(path.join(dir, 'text'));

    const result = forgetSessions(store, mine, new Set(['gone']), { archiveRoot, log: () => {} });

    expect(result).toEqual({ rows: 0, files: 0, skipped: true });
    expect(exchangesFrom(store, 0).map((e) => e.id)).toEqual(gone.ids);
    expect(fs.existsSync(gone.copy)).toBe(true);
    expect(holder.numDocs()).toBe(2);
  });

  it('still deletes the text-index documents when a copy cannot be removed', () => {
    // Rows pointing at a copy under an archive root since moved, where the
    // copy's path is something rmSync refuses: here a folder.
    const stale = path.join(dir, 'old-root', 'cowork', 'lanterns', 'stuck.jsonl.gz');
    fs.mkdirSync(stale, { recursive: true });
    fs.writeFileSync(path.join(stale, 'inside'), '');
    for (let t = 0; t < 2; t++) {
      insertExchange(store, {
        harness: 'cowork', project: 'lanterns', sessionId: 'stuck', timestamp: '2026-09-28T10:00:00.000Z',
        userMessage: `stuck question ${t} about lantern wicks`, assistantMessage: 'noted',
        archivePath: stale, lineStart: t * 2 + 2, lineEnd: t * 2 + 3, embeddingVersion: 1,
      }, vec(t + 50));
    }
    const text = textIndexWithAll();
    const said: string[] = [];

    const result = forgetSessions(store, text, new Set(['stuck']), { archiveRoot, log: (l) => said.push(l) });

    expect(result).toMatchObject({ rows: 2, skipped: false });
    expect(text.search('stuck', 10)).toEqual([]);
    expect(said.join('\n')).toContain(`could not remove ${stale}`);
  });

  it('does nothing, and takes no lock, when no forgotten session has rows', () => {
    conversation('kept');
    const holder = textIndexWithAll();

    expect(forgetSessions(store, TextIndex.open(path.join(dir, 'text')), new Set(['other']), { archiveRoot })).toEqual({ rows: 0, files: 0, skipped: false });
    expect(holder.numDocs()).toBe(2);
  });
});
