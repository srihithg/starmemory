// `remember` starts the same detached sync the SessionStart hook does, so an
// entry is searchable in seconds. Every sync loads the embedding model, so a
// burst of calls must not become a burst of processes.
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { CLI_ENTRY, canStartSync, createSyncTrigger, spawnBackgroundSync } from '../src/sync-trigger.js';
import { exchangesFrom, openStore } from '../src/store.js';
import { remember } from '../src/cowork.js';
import { initEmbeddings } from '../src/embeddings.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function harness() {
  let clock = 0;
  const timers: { at: number; run: () => void }[] = [];
  const started: number[] = [];
  const trigger = createSyncTrigger({
    intervalMs: 5000,
    now: () => clock,
    start: () => started.push(clock),
    setTimer: (run, ms) => {
      timers.push({ at: clock + ms, run });
      return {};
    },
  });
  /** Move the clock forward, firing each timer at the moment it is due. */
  const advance = (ms: number) => {
    const target = clock + ms;
    for (;;) {
      timers.sort((a, b) => a.at - b.at);
      if (timers.length === 0 || timers[0].at > target) break;
      const next = timers.shift()!;
      clock = next.at;
      next.run();
    }
    clock = target;
  };
  return { trigger, advance, started };
}

describe('createSyncTrigger', () => {
  it('starts a sync at once for the first request', () => {
    const { trigger, started } = harness();

    trigger();

    expect(started).toEqual([0]);
  });

  it('folds requests inside the interval into one sync at its end', () => {
    const { trigger, advance, started } = harness();

    trigger();
    advance(1000);
    trigger();
    advance(1000);
    trigger();
    advance(10_000);

    expect(started).toEqual([0, 5000]);
  });

  it('starts at once again once the interval has passed', () => {
    const { trigger, advance, started } = harness();

    trigger();
    advance(6000);
    trigger();

    expect(started).toEqual([0, 6000]);
  });
});

async function eventually(probe: () => boolean, timeoutMs = 20_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!probe() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
  return probe();
}

describe('the sync it starts', () => {
  it('is the CLI entry the hook runs', () => {
    expect(CLI_ENTRY).toBe(path.join(root, 'cli', 'starmemory.mjs'));
    expect(fs.existsSync(CLI_ENTRY)).toBe(true);
    expect(canStartSync()).toBe(true);
  });

  it('walks only the Cowork records, and runs without the summary step, which a burst of calls would repeat each time', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'starmemory-trigger-'));
    try {
      // A stand-in entry that records the arguments and setting it was started with.
      const entry = path.join(dir, 'entry.mjs');
      const seen = path.join(dir, 'seen.json');
      fs.writeFileSync(entry, `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(seen)}, JSON.stringify({ args: process.argv.slice(2), limit: process.env.STARMEMORY_SUMMARY_LIMIT }));\n`);

      expect(spawnBackgroundSync(entry)).toBe(true);

      expect(await eventually(() => fs.existsSync(seen))).toBe(true);
      expect(JSON.parse(fs.readFileSync(seen, 'utf8'))).toEqual({ args: ['sync', '--background', '--cowork-only'], limit: '0' });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it('reaches dist/cli.js as a detached Cowork-only sync, which is what lets it wait for the writer', async () => {
    if (process.platform === 'win32') return; // symlinked node_modules need a privilege there
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'starmemory-trigger-'));
    try {
      // A plugin copy whose dependencies are in place and whose dist/cli.js is a stand-in.
      const copy = path.join(dir, 'plugin');
      fs.cpSync(path.join(root, 'cli'), path.join(copy, 'cli'), { recursive: true });
      fs.copyFileSync(path.join(root, 'package.json'), path.join(copy, 'package.json'));
      fs.symlinkSync(path.join(root, 'node_modules'), path.join(copy, 'node_modules'));
      fs.symlinkSync(path.join(root, 'native'), path.join(copy, 'native'));
      const seen = path.join(dir, 'seen.json');
      fs.mkdirSync(path.join(copy, 'dist'));
      fs.writeFileSync(path.join(copy, 'dist', 'cli.js'), `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(seen)}, JSON.stringify(process.argv.slice(2)));\n`);
      const env = { ...process.env, STARMEMORY_LOG_PATH: path.join(dir, 'sync.log') };
      delete env.CLAUDE_PLUGIN_ROOT;
      const saved = process.env;
      process.env = env;
      try {
        expect(spawnBackgroundSync(path.join(copy, 'cli', 'starmemory.mjs'))).toBe(true);
      } finally {
        process.env = saved;
      }

      expect(await eventually(() => fs.existsSync(seen))).toBe(true);
      expect(JSON.parse(fs.readFileSync(seen, 'utf8'))).toEqual(['sync', '--cowork-only', '--detached']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }, 60_000);

  it('as a Cowork-only sync, indexes the records and leaves Claude Code transcripts for the session-start sync', async () => {
    await initEmbeddings();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'starmemory-trigger-'));
    try {
      const claude = path.join(dir, 'claude', 'projects', '-Users-me-lanterns');
      fs.mkdirSync(claude, { recursive: true });
      const turn = [
        { type: 'user', promptSource: 'typed', sessionId: 'cc-1', timestamp: '2026-09-28T10:00:00.000Z', message: { role: 'user', content: 'a Claude Code question' } },
        { type: 'assistant', sessionId: 'cc-1', timestamp: '2026-09-28T10:00:05.000Z', message: { role: 'assistant', content: 'an answer' } },
      ];
      fs.writeFileSync(path.join(claude, 'cc-1.jsonl'), turn.map((l) => `${JSON.stringify(l)}\n`).join(''));
      remember(path.join(dir, 'cowork'), { session: 'cw-1', title: 'Lanterns', asked: 'How to trim a wick?', found: 'Flat.', project: 'lanterns' });
      const env: Record<string, string> = {};
      for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
      Object.assign(env, {
        STARMEMORY_DB_PATH: path.join(dir, 'store.mdb'),
        STARMEMORY_INDEX_PATH: path.join(dir, 'index.hnsw'),
        STARMEMORY_TEXT_INDEX_PATH: path.join(dir, 'text'),
        STARMEMORY_ARCHIVE_PATH: path.join(dir, 'archive'),
        STARMEMORY_COWORK_PATH: path.join(dir, 'cowork'),
        STARMEMORY_FORGOTTEN_PATH: path.join(dir, 'forgotten.txt'),
        STARMEMORY_QUARANTINE_PATH: path.join(dir, 'quarantine'),
        STARMEMORY_SUMMARY_LIMIT: '0',
        CLAUDE_CONFIG_DIR: path.join(dir, 'claude'),
        CODEX_HOME: path.join(dir, 'codex'),
      });

      const r = spawnSync(process.execPath, [path.join(root, 'dist', 'cli.js'), 'sync', '--cowork-only'], { env, encoding: 'utf8', timeout: 120_000 });

      expect(r.status).toBe(0);
      const store = openStore(path.join(dir, 'store.mdb'));
      try {
        expect(exchangesFrom(store, 0).map((e) => e.sessionId)).toEqual(['cw-1']);
      } finally {
        await store.close();
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }, 180_000);

  it('starts nothing, and says so, once the copy it would run is gone', () => {
    const said = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const gone = path.join(os.tmpdir(), 'starmemory-no-such-copy', 'cli', 'starmemory.mjs');

      expect(canStartSync(gone)).toBe(false);
      expect(spawnBackgroundSync(gone)).toBe(false);
      expect(said.mock.calls.map((c) => String(c[0])).join('')).toContain('restart the Claude app');
    } finally {
      said.mockRestore();
    }
  });
});
