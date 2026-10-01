// What starmemory keeps is readable by its owner alone: new files from the
// umask every entry point sets, and what an earlier version left readable to
// other accounts from a one-time pass at sync start. Modes mean nothing on
// Windows, so these run on POSIX only. Every path is in a temp dir.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStore } from '../src/store.js';
import { OWNER_ONLY_KEY, tightenOnce, tightenTree } from '../src/owner-only.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const modeOf = (p: string) => fs.lstatSync(p).mode & 0o7777;

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'starmemory-owner-only-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });

/** A file or folder with `mode` exactly, whatever the umask. */
function make(p: string, mode: number, content?: string): string {
  if (content === undefined) fs.mkdirSync(p, { recursive: true });
  else {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
  fs.chmodSync(p, mode);
  return p;
}

describe.skipIf(process.platform === 'win32')('tightenTree', () => {
  it('takes group and other permissions off every file and folder under it, keeping the owner\'s', () => {
    const data = make(path.join(dir, 'data'), 0o755);
    const copy = make(path.join(data, 'archive', 'claude', 'proj', 's1.jsonl.gz'), 0o644, 'gz');
    const script = make(path.join(data, 'desktop', 'run-node.sh'), 0o755, '#!/bin/sh\n');
    const readOnly = make(path.join(data, 'forgotten.txt'), 0o444, 's1\n');
    fs.chmodSync(path.join(data, 'archive', 'claude', 'proj'), 0o775);

    tightenTree(data);

    expect(modeOf(data)).toBe(0o700);
    expect(modeOf(path.join(data, 'archive', 'claude', 'proj'))).toBe(0o700);
    expect(modeOf(copy)).toBe(0o600);
    expect(modeOf(script)).toBe(0o700);
    expect(modeOf(readOnly)).toBe(0o400);
  });

  it('never follows a link, neither to a file nor to a folder', () => {
    const data = make(path.join(dir, 'data'), 0o755);
    const outsideFile = make(path.join(dir, 'elsewhere', 'notes.txt'), 0o644, 'mine');
    const outsideDir = make(path.join(dir, 'elsewhere', 'folder'), 0o755);
    const inside = make(path.join(outsideDir, 'inside.txt'), 0o644, 'mine');
    fs.symlinkSync(outsideFile, path.join(data, 'file-link'));
    fs.symlinkSync(outsideDir, path.join(data, 'folder-link'));

    tightenTree(data);
    tightenTree(path.join(data, 'folder-link'));

    expect(modeOf(outsideFile)).toBe(0o644);
    expect(modeOf(outsideDir)).toBe(0o755);
    expect(modeOf(inside)).toBe(0o644);
    expect(fs.lstatSync(path.join(data, 'file-link')).isSymbolicLink()).toBe(true);
  });

  it('is fine with a target that is missing', () => {
    expect(() => tightenTree(path.join(dir, 'missing'))).not.toThrow();
  });
});

describe.skipIf(process.platform === 'win32')('tightenOnce', () => {
  it('goes over the targets once per store, and leaves alone what is loosened after', async () => {
    const store = openStore(path.join(dir, 'store.mdb'));
    try {
      const record = make(path.join(dir, 'cowork', 'proj', 'k.jsonl'), 0o644, '{}\n');

      expect(tightenOnce(store, [path.join(dir, 'cowork'), undefined])).toBe(true);
      expect(modeOf(record)).toBe(0o600);
      expect(store.meta.get(OWNER_ONLY_KEY)).toBe(1);

      fs.chmodSync(record, 0o644);
      expect(tightenOnce(store, [path.join(dir, 'cowork')])).toBe(false);
      expect(modeOf(record)).toBe(0o644);
    } finally {
      await store.close();
    }
  });
});

describe.skipIf(process.platform === 'win32')('starmemory sync', () => {
  /** The CLI's sync with nothing from this machine's settings but the shared
   * model cache, and HOME in the temp dir, so it can touch no real store. */
  function sync(home: string, env: Record<string, string> = {}) {
    const base: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value === undefined || (/^STARMEMORY_/.test(key) && key !== 'STARMEMORY_MODEL_CACHE_PATH')) continue;
      if (['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'CLAUDE_PLUGIN_ROOT', 'XDG_CONFIG_HOME'].includes(key)) continue;
      base[key] = value;
    }
    Object.assign(base, { HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: path.join(home, '.claude'), CODEX_HOME: path.join(home, '.codex'), STARMEMORY_SUMMARY_LIMIT: '0' }, env);
    return spawnSync(process.execPath, [path.join(root, 'dist', 'cli.js'), 'sync'], { env: base, encoding: 'utf8', timeout: 180_000 });
  }

  it('makes everything it writes owner-only, and tightens what an earlier version left under ~/.config/starmemory', () => {
    const home = path.join(dir, 'home');
    const data = make(path.join(home, '.config', 'starmemory'), 0o755);
    const launcher = make(path.join(data, 'desktop', 'launch.json'), 0o644, '{}\n');
    const log = make(path.join(data, 'sync.log'), 0o644, 'old line\n');
    const oldCopy = make(path.join(data, 'archive', 'claude', 'old', 'old.jsonl.gz'), 0o644, 'gz');
    const outside = make(path.join(dir, 'elsewhere.txt'), 0o644, 'not starmemory\'s');
    fs.symlinkSync(outside, path.join(data, 'archive', 'claude', 'old', 'link.jsonl.gz'));
    const projects = path.join(home, '.claude', 'projects', '-Users-me-proj');
    fs.mkdirSync(projects, { recursive: true });
    const turn = [
      { type: 'user', promptSource: 'typed', sessionId: 's1', timestamp: '2026-09-28T10:00:00.000Z', message: { role: 'user', content: 'how is the wick trimmed?' } },
      { type: 'assistant', sessionId: 's1', timestamp: '2026-09-28T10:00:05.000Z', message: { role: 'assistant', content: 'Flat.' } },
    ];
    fs.writeFileSync(path.join(projects, 's1.jsonl'), turn.map((l) => `${JSON.stringify(l)}\n`).join(''));

    const r = sync(home);

    expect(r.status).toBe(0);
    for (const folder of [data, path.join(data, 'store.mdb'), path.join(data, 'archive', 'claude', '-Users-me-proj'), path.join(data, 'desktop')]) expect(modeOf(folder)).toBe(0o700);
    const copy = path.join(data, 'archive', 'claude', '-Users-me-proj', 's1.jsonl.gz');
    for (const file of [copy, launcher, log, oldCopy, ...fs.readdirSync(path.join(data, 'store.mdb')).map((f) => path.join(data, 'store.mdb', f))]) {
      expect(modeOf(file)).toBe(0o600);
    }
    const textDir = fs.readdirSync(data).find((name) => /^text-v\d+$/.test(name))!;
    expect(modeOf(path.join(data, textDir))).toBe(0o700);
    const vectors = fs.readdirSync(data).filter((name) => name.endsWith('.hnsw'));
    expect(vectors.length).toBeGreaterThan(0);
    for (const name of vectors) expect(modeOf(path.join(data, name))).toBe(0o600);
    expect(modeOf(outside)).toBe(0o644);
  }, 180_000);

  it('tightens only the places the settings name when the store is elsewhere', () => {
    const home = make(path.join(dir, 'home'), 0o755);
    const unrelated = make(path.join(home, '.config', 'starmemory', 'not-in-use.txt'), 0o644, 'x');
    const record = make(path.join(dir, 'cowork', 'proj', 'k.jsonl'), 0o644, `${JSON.stringify({ type: 'cowork_session', version: 1, session: 'k', project: 'proj', createdAt: '2026-09-28T10:00:00.000Z' })}\n`);
    const forgotten = make(path.join(dir, 'forgotten.txt'), 0o644, '# list\n');

    const r = sync(home, {
      STARMEMORY_DB_PATH: path.join(dir, 'store.mdb'),
      STARMEMORY_INDEX_PATH: path.join(dir, 'index.hnsw'),
      STARMEMORY_TEXT_INDEX_PATH: path.join(dir, 'text'),
      STARMEMORY_ARCHIVE_PATH: path.join(dir, 'archive'),
      STARMEMORY_COWORK_PATH: path.join(dir, 'cowork'),
      STARMEMORY_FORGOTTEN_PATH: forgotten,
    });

    expect(r.status).toBe(0);
    expect(modeOf(record)).toBe(0o600);
    expect(modeOf(path.join(dir, 'cowork', 'proj'))).toBe(0o700);
    expect(modeOf(forgotten)).toBe(0o600);
    expect(modeOf(path.join(dir, 'store.mdb'))).toBe(0o700);
    expect(modeOf(unrelated)).toBe(0o644);
    expect(modeOf(home)).toBe(0o755);
  }, 180_000);
});
