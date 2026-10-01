// cli/mcp-server.mjs, the MCP entry the plugin manifests name. Plugin MCP
// servers can start inside a cloud container, Claude Code on the web's or a
// Cowork session's, where a store is thrown away with the container. Run
// through a copy of cli/ whose bootstrap records that it was reached, in place
// of installing anything and starting the server.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let dir: string;
let copy: string;
let reached: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'starmemory-mcp-entry-'));
  copy = path.join(dir, 'plugin');
  fs.cpSync(path.join(root, 'cli'), path.join(copy, 'cli'), { recursive: true });
  fs.copyFileSync(path.join(root, 'package.json'), path.join(copy, 'package.json'));
  reached = path.join(dir, 'reached');
  fs.writeFileSync(
    path.join(copy, 'cli', 'bootstrap.mjs'),
    `import fs from 'node:fs';\nexport async function ensureReady() { fs.writeFileSync(${JSON.stringify(reached)}, ''); return true; }\nexport function handOff() {}\n`
  );
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

function start(env: Record<string, string>) {
  const home = path.join(dir, 'home');
  fs.mkdirSync(home, { recursive: true });
  return spawnSync(process.execPath, [path.join(copy, 'cli', 'mcp-server.mjs')], { env: { PATH: process.env.PATH ?? '', HOME: home, USERPROFILE: home, ...env }, input: '', encoding: 'utf8', timeout: 20_000 });
}

describe('the plugin\'s MCP server', () => {
  it('does not start in a cloud container, and says so in one line', () => {
    for (const env of [{ CLAUDE_CODE_REMOTE: 'true' }, { CLAUDE_CODE_ENTRYPOINT: 'remote_cowork' }, { CLAUDE_CODE_ENTRYPOINT: 'remote_cowork_trigger' }]) {
      const r = start(env);

      expect(r.status).toBe(0);
      expect(r.stdout).toBe('');
      expect(r.stderr.trim().split('\n')).toHaveLength(1);
      expect(r.stderr).toContain('not starting the MCP server in a cloud container');
      expect(fs.existsSync(reached)).toBe(false);
      expect(fs.readdirSync(path.join(dir, 'home'))).toEqual([]);
    }
  });

  it('starts everywhere else', () => {
    for (const env of [{}, { CLAUDE_CODE_ENTRYPOINT: 'cli' }, { CLAUDE_CODE_ENTRYPOINT: 'claude-desktop', CLAUDE_CODE_REMOTE: 'false' }]) {
      fs.rmSync(reached, { force: true });

      expect(start(env).status).toBe(0);
      expect(fs.existsSync(reached)).toBe(true);
    }
  });
});
