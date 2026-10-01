import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { summarizeWithCodex, parseCodexVersion, versionAtLeast } from '../src/summarizer-codex.js';
import { SUMMARY_PROMPT } from '../src/summaries.js';

const fake = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-codex-app-server.mjs');
const bin = `${process.execPath} ${fake}`;

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'starmemory-codex-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });

describe('version gate', () => {
  it('parses and compares', () => {
    expect(parseCodexVersion('codex-cli 0.131.2')).toBe('0.131.2');
    expect(versionAtLeast('0.131.2')).toBe(true);
    expect(versionAtLeast('0.129.9')).toBe(false);
    expect(versionAtLeast('1.0.0')).toBe(true);
  });
  it('refuses an old codex with a message that says what to do', async () => {
    await expect(summarizeWithCodex({ transcript: '' }, { bin, env: { FAKE_CODEX_VERSION: '0.120.0' } }))
      .rejects.toThrow(/requires codex-cli >= 0\.130\.0; found 0\.120\.0/);
  });
});

describe('summarizeWithCodex', () => {
  it('starts a fresh read-only thread with the transcript, never forking the original, in a folder of its own', async () => {
    const log = path.join(dir, 'requests.log');

    const text = await summarizeWithCodex({ transcript: 'User: hi\nAssistant: yo' }, { bin, env: { FAKE_CODEX_LOG: log } });

    expect(text).toBe('From transcript text.');
    const requests = fs.readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    expect(requests.map((r) => r.method)).toEqual(['initialize', 'initialized', 'thread/start', 'turn/start']);
    expect(requests[2].params).toEqual({ ephemeral: true, sandbox: 'read-only', approvalPolicy: 'never' });
    expect(requests[3].params.input[0].text).toBe(`${SUMMARY_PROMPT}\n\nUser: hi\nAssistant: yo`);
    const cwd = requests[0].cwd;
    expect(fs.realpathSync(path.dirname(cwd))).toBe(fs.realpathSync(os.tmpdir()));
    expect(cwd).not.toBe(process.cwd());
    expect(fs.existsSync(cwd)).toBe(false);
  });
  it('reports a failed turn', async () => {
    await expect(summarizeWithCodex({ transcript: '' }, { bin, env: { FAKE_CODEX_MODE: 'turn-fails' } }))
      .rejects.toThrow(/model unavailable/);
  });
  it('gives up after the timeout', async () => {
    await expect(summarizeWithCodex({ transcript: '' }, { bin, env: { FAKE_CODEX_MODE: 'hang' }, timeoutMs: 300 }))
      .rejects.toThrow(/timed out/);
  });
  it('reports a missing codex binary plainly', async () => {
    await expect(summarizeWithCodex({ transcript: '' }, { bin: path.join(path.dirname(fake), 'no-such-codex'), env: {} }))
      .rejects.toThrow(/codex not found/);
  });
});
