// The MCP server over stdio against the compiled dist/mcp-server.js, with its
// home and every path it and its syncs touch in a temp dir: the files it writes
// are owner-only. Only the embedding model cache is the shared one, so nothing
// is downloaded.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { initEmbeddings } from '../src/embeddings.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let dir: string;
let client: Client;

async function call(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
  const result = (await client.callTool({ name, arguments: args })) as { content: { type: string; text?: string }[]; isError?: boolean };
  return { text: result.content.map((c) => c.text ?? '').join('\n'), isError: result.isError === true };
}

async function eventually<T>(probe: () => Promise<T> | T, done: (value: T) => boolean, timeoutMs = 90_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (done(value) || Date.now() > deadline) return value;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

const logText = () => (fs.existsSync(path.join(dir, 'sync.log')) ? fs.readFileSync(path.join(dir, 'sync.log'), 'utf8') : '');
const count = (text: string, pattern: RegExp) => (text.match(pattern) ?? []).length;
const syncsSettled = () => count(logText(), /starting detached sync/g) <= count(logText(), /^Scanned /gm);
const modeOf = (file: string) => fs.statSync(file).mode & 0o777;

beforeAll(async () => {
  await initEmbeddings();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'starmemory-mcp-replies-'));
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || (/^STARMEMORY_/.test(key) && key !== 'STARMEMORY_MODEL_CACHE_PATH')) continue;
    env[key] = value;
  }
  Object.assign(env, {
    STARMEMORY_DB_PATH: path.join(dir, 'store.mdb'),
    STARMEMORY_INDEX_PATH: path.join(dir, 'index.hnsw'),
    STARMEMORY_TEXT_INDEX_PATH: path.join(dir, 'text'),
    STARMEMORY_ARCHIVE_PATH: path.join(dir, 'archive'),
    STARMEMORY_COWORK_PATH: path.join(dir, 'cowork'),
    STARMEMORY_FORGOTTEN_PATH: path.join(dir, 'forgotten.txt'),
    STARMEMORY_LOG_PATH: path.join(dir, 'sync.log'),
    STARMEMORY_SUMMARY_LIMIT: '0',
    CLAUDE_CONFIG_DIR: path.join(dir, 'claude'),
    CODEX_HOME: path.join(dir, 'codex'),
    HOME: dir,
    USERPROFILE: dir,
  });
  client = new Client({ name: 'starmemory-test', version: '0.0.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(root, 'dist', 'mcp-server.js')], env, stderr: 'ignore' }));
}, 300_000);

afterAll(async () => {
  await client?.close();
  await eventually(syncsSettled, (settled) => settled, 60_000);
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}, 120_000);

describe.skipIf(process.platform === 'win32')('what the server writes', () => {
  it('is owner-only: a Cowork record and its folder, its archive copy, and the forgotten list', async () => {
    const session = 'owner-only-1';
    expect((await call('remember', { session, title: 'Lanterns', asked: 'How is a wick trimmed?', found: 'Flat, with the lamp cold.', project: 'lanterns' })).isError).toBe(false);
    const record = path.join(dir, 'cowork', 'lanterns', `${session}.jsonl`);
    const copy = path.join(dir, 'archive', 'cowork', 'lanterns', `${session}.jsonl.gz`);
    await eventually(() => fs.existsSync(copy), (exists) => exists);

    expect(modeOf(record)).toBe(0o600);
    expect(modeOf(path.dirname(record))).toBe(0o700);
    expect(modeOf(copy)).toBe(0o600);
    expect(modeOf(path.dirname(copy))).toBe(0o700);

    expect((await call('forget', { session })).isError).toBe(false);
    expect(modeOf(path.join(dir, 'forgotten.txt'))).toBe(0o600);
  }, 120_000);
});
