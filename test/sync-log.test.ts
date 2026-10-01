// sync.log, which the session-start hook's detached sync writes to. It names
// projects and sessions, so it is owner-only like everything else starmemory
// keeps. Run through a copy of cli/ whose dist/cli.js is a stand-in, so no real
// sync starts. Every path is in a temp dir.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let dir: string;
let copy: string;
let started: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'starmemory-sync-log-'));
  copy = path.join(dir, 'plugin');
  fs.cpSync(path.join(root, 'cli'), path.join(copy, 'cli'), { recursive: true });
  fs.copyFileSync(path.join(root, 'package.json'), path.join(copy, 'package.json'));
  fs.symlinkSync(path.join(root, 'node_modules'), path.join(copy, 'node_modules'));
  fs.symlinkSync(path.join(root, 'native'), path.join(copy, 'native'));
  started = path.join(dir, 'started');
  fs.mkdirSync(path.join(copy, 'dist'));
  fs.writeFileSync(path.join(copy, 'dist', 'cli.js'), `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(started)}, '');\n`);
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

/** `starmemory sync --background`, as the hook runs it, writing to `log`. */
function backgroundSync(log: string) {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined && key !== 'CLAUDE_PLUGIN_ROOT') env[key] = value;
  const r = spawnSync(process.execPath, [path.join(copy, 'cli', 'starmemory.mjs'), 'sync', '--background'], { env: { ...env, STARMEMORY_LOG_PATH: log }, encoding: 'utf8', timeout: 30_000 });
  return r;
}

async function waitFor(file: string): Promise<void> {
  for (let i = 0; i < 200 && !fs.existsSync(file); i++) await new Promise((resolve) => setTimeout(resolve, 50));
}

describe.skipIf(process.platform === 'win32')('sync.log', () => {
  it('is owner-only, in an owner-only folder, and an old log readable by all is closed', async () => {
    const log = path.join(dir, 'logs', 'sync.log');

    expect(backgroundSync(log).status).toBe(0);
    await waitFor(started);

    expect(fs.statSync(log).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(log)).mode & 0o777).toBe(0o700);

    fs.chmodSync(log, 0o644);
    fs.rmSync(started);
    expect(backgroundSync(log).status).toBe(0);
    await waitFor(started);

    expect(fs.statSync(log).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(log, 'utf8').match(/starting detached sync/g)).toHaveLength(2);
  }, 60_000);
});
