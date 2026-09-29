// Cowork records: a Cowork session leaves no transcript on this machine, so the
// model writes one through `remember`. The record is a synthetic transcript in
// Claude Code's line shape behind one marker line, which is what lets the rest
// of the engine treat it like any other transcript.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import {
  DEFAULT_PROJECT,
  LIMITS,
  RefusedError,
  countEntries,
  defaultCoworkRoot,
  describeRemember,
  findRecords,
  projectSlug,
  remember,
  sessionKeyProblem,
} from '../src/cowork.js';
import { detectHarness, parseConversation } from '../src/parser.js';

let dir: string;
let root: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'starmemory-cowork-'));
  root = path.join(dir, 'cowork');
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const entry = (overrides: Partial<Parameters<typeof remember>[1]> = {}) => ({
  session: 'cowork-2026-09-28-76aa87a1',
  title: 'Cowork support for starmemory',
  asked: 'Can starmemory record Cowork sessions?',
  found: 'Yes, through a remember tool; the desktop app refused the name "cowork-episodic-memory".',
  project: 'starmemory',
  ...overrides,
});

const lines = (file: string) => fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));

describe('where records live', () => {
  it('defaults under ~/.config/starmemory unless STARMEMORY_COWORK_PATH says otherwise', () => {
    expect(defaultCoworkRoot({})).toBe(path.join(os.homedir(), '.config', 'starmemory', 'cowork'));
    expect(defaultCoworkRoot({ STARMEMORY_COWORK_PATH: '/elsewhere' })).toBe('/elsewhere');
  });
});

describe('a Cowork record', () => {
  it('starts with a line marking it as Cowork, then one user and one assistant line per entry', () => {
    const { file } = remember(root, entry(), { now: new Date('2026-09-28T10:00:00Z') });

    expect(file).toBe(path.join(root, 'starmemory', 'cowork-2026-09-28-76aa87a1.jsonl'));
    const [header, user, assistant] = lines(file);
    expect(header).toEqual({ type: 'cowork_session', version: 1, session: 'cowork-2026-09-28-76aa87a1', project: 'starmemory', createdAt: '2026-09-28T10:00:00.000Z' });
    expect(user).toMatchObject({ type: 'user', promptSource: 'typed', sessionId: 'cowork-2026-09-28-76aa87a1', message: { role: 'user', content: 'Can starmemory record Cowork sessions?' } });
    expect(assistant.message.content).toBe('Cowork support for starmemory\n\nYes, through a remember tool; the desktop app refused the name "cowork-episodic-memory".');
  });

  it('is detected as cowork, and so is its gzipped archive copy', async () => {
    const { file } = remember(root, entry());
    const copy = path.join(dir, 'copy.jsonl.gz');
    fs.writeFileSync(copy, zlib.gzipSync(fs.readFileSync(file)));

    expect(await detectHarness(file)).toBe('cowork');
    expect(await detectHarness(copy)).toBe('cowork');
  });

  it('parses into one exchange per entry, tagged cowork, keyed by the session, in the project of its folder', async () => {
    remember(root, entry());
    const { file } = remember(root, entry({ asked: 'What name did the app accept?', found: 'episode-archive' }));

    const exchanges = await parseConversation(file, 'starmemory', file);

    expect(exchanges.map((e) => [e.harness, e.project, e.sessionId, e.userMessage])).toEqual([
      ['cowork', 'starmemory', 'cowork-2026-09-28-76aa87a1', 'Can starmemory record Cowork sessions?'],
      ['cowork', 'starmemory', 'cowork-2026-09-28-76aa87a1', 'What name did the app accept?'],
    ]);
    expect(exchanges[1].assistantMessage).toBe('Cowork support for starmemory\n\nepisode-archive');
    expect(exchanges.map((e) => [e.lineStart, e.lineEnd])).toEqual([[2, 3], [4, 5]]);
    expect(exchanges.every((e) => e.userIsInjected === false)).toBe(true);
  });

  it('keeps text that looks like an injected block, because the model wrote it', async () => {
    const { file } = remember(root, entry({ asked: 'Why did <system-reminder> text end up in the notes?' }));

    const [exchange] = await parseConversation(file, 'starmemory', file);

    expect(exchange.userMessage).toBe('Why did <system-reminder> text end up in the notes?');
  });
});

describe('remember', () => {
  it('starts a record and appends to it, counting entries', () => {
    const first = remember(root, entry());
    const second = remember(root, entry({ found: 'Decided: records are synthetic transcripts.' }));

    expect(first).toMatchObject({ created: true, entries: 1, project: 'starmemory' });
    expect(second).toMatchObject({ created: false, entries: 2, file: first.file });
    expect(countEntries(first.file)).toBe(2);
    expect(lines(first.file).filter((l) => l.type === 'cowork_session')).toHaveLength(1);
  });

  it('keeps a session in the project of its first entry, so it stays one file', () => {
    const first = remember(root, entry({ project: 'starmemory' }));
    const second = remember(root, entry({ project: 'Something Else' }));

    expect(second.file).toBe(first.file);
    expect(second.ignoredProject).toBe('something-else');
    expect(findRecords(root, entry().session)).toEqual([first.file]);
    expect(describeRemember(second)).toContain('stays there rather than moving to "something-else"');
  });

  it('turns the project into a folder name, keeping letters of any script, and defaults to general', () => {
    expect(projectSlug('StarRocks BE / compaction')).toBe('starrocks-be-compaction');
    expect(projectSlug('数据库 调优')).toBe('数据库-调优');
    expect(projectSlug('../../etc')).toBe('etc');
    expect(projectSlug(undefined)).toBe(DEFAULT_PROJECT);
    expect(projectSlug('...')).toBe(DEFAULT_PROJECT);
    expect(projectSlug('NUL')).toBe(DEFAULT_PROJECT);
    expect(projectSlug('x'.repeat(200))).toHaveLength(LIMITS.project);
    expect(remember(root, entry({ project: undefined })).project).toBe(DEFAULT_PROJECT);
  });

  it('refuses a key that is not a safe file name, and writes nothing', () => {
    for (const session of ['', '../escape', 'a/b', 'a\\b', '.hidden', '-flag', 'has space', 'x'.repeat(121), 'con', 'LPT1.txt']) {
      expect(sessionKeyProblem(session)).toBeDefined();
      expect(() => remember(root, entry({ session }))).toThrow(RefusedError);
    }
    expect(sessionKeyProblem('76aa87a1-f393-5a8c-8ad3-79f63f504acc')).toBeUndefined();
    expect(fs.existsSync(root)).toBe(false);
  });

  it('refuses empty fields and a transcript pasted in as found', () => {
    expect(() => remember(root, entry({ title: '  ' }))).toThrow(/title must not be empty/);
    expect(() => remember(root, entry({ found: 'x'.repeat(LIMITS.found + 1) }))).toThrow(/summary, not the transcript/);
    expect(fs.existsSync(root)).toBe(false);
  });

  it('refuses a session the user asked to forget, and writes nothing', () => {
    expect(() => remember(root, entry(), { isForgotten: () => true })).toThrow(/asked to forget/);
    expect(fs.existsSync(root)).toBe(false);
  });

  it('removes its own write when the session was forgotten while it was writing', () => {
    let asked = 0;
    // First check passes, the second (after the write) sees the forget that
    // another process recorded in between.
    const isForgotten = () => asked++ > 0;

    expect(() => remember(root, entry(), { isForgotten })).toThrow(RefusedError);
    expect(findRecords(root, entry().session)).toEqual([]);
  });

  it('writes a whole record, header included, when the file vanished after it was found', () => {
    const { file } = remember(root, entry());
    let checks = 0;
    const isForgotten = () => {
      // The first check runs between the lookup and the write: the file goes
      // there, as it would if another process removed it at that moment.
      if (checks++ === 0) fs.rmSync(file, { force: true });
      return false;
    };

    const result = remember(root, entry({ found: 'second' }), { isForgotten });

    expect(result).toMatchObject({ file, created: true, entries: 1 });
    expect(lines(file).map((l) => l.type)).toEqual(['cowork_session', 'user', 'assistant']);
  });
});
