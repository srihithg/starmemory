// The MCP server the way Cowork uses it, over stdio against the compiled
// dist/mcp-server.js: remember makes an entry searchable through the background
// sync it starts, and forget hides a session at once and has the sync it starts
// delete the rest. Every path the server and its syncs touch is in a temp dir;
// only the embedding model cache is the shared one, so nothing is downloaded.
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
let log: string;
let client: Client;

async function call(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
  try {
    const result = (await client.callTool({ name, arguments: args })) as { content: { type: string; text?: string }[]; isError?: boolean };
    return { text: result.content.map((c) => c.text ?? '').join('\n'), isError: result.isError === true };
  } catch (error) {
    // Arguments the schema rejects come back as a protocol error.
    return { text: String(error), isError: true };
  }
}

async function eventually<T>(probe: () => Promise<T> | T, done: (value: T) => boolean, timeoutMs = 90_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (done(value) || Date.now() > deadline) return value;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

const logText = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '');
const count = (text: string, pattern: RegExp) => (text.match(pattern) ?? []).length;
/** Every background sync that was started has written its summary line. */
const syncsSettled = () => {
  const text = logText();
  return count(text, /starting detached sync/g) <= count(text, /^Scanned /gm);
};

const session = 'e2e-cowork-1';
const archiveCopy = () => path.join(dir, 'archive', 'cowork', 'lanterns', `${session}.jsonl.gz`);

beforeAll(async () => {
  // The model the syncs load must already be in the shared cache.
  await initEmbeddings();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'starmemory-mcp-cowork-'));
  log = path.join(dir, 'sync.log');
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
  Object.assign(env, {
    STARMEMORY_DB_PATH: path.join(dir, 'store.mdb'),
    STARMEMORY_INDEX_PATH: path.join(dir, 'index.hnsw'),
    STARMEMORY_TEXT_INDEX_PATH: path.join(dir, 'text'),
    STARMEMORY_ARCHIVE_PATH: path.join(dir, 'archive'),
    STARMEMORY_COWORK_PATH: path.join(dir, 'cowork'),
    STARMEMORY_FORGOTTEN_PATH: path.join(dir, 'forgotten.txt'),
    STARMEMORY_LOG_PATH: log,
    STARMEMORY_SUMMARY_LIMIT: '0',
    // Keep the syncs away from this machine's real transcripts.
    CLAUDE_CONFIG_DIR: path.join(dir, 'claude'),
    CODEX_HOME: path.join(dir, 'codex'),
  });
  client = new Client({ name: 'starmemory-test', version: '0.0.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(root, 'dist', 'mcp-server.js')], env, stderr: 'ignore' }));
}, 300_000);

afterAll(async () => {
  await client?.close();
  // A detached sync may still be writing into the temp dir.
  await eventually(syncsSettled, (settled) => settled, 60_000);
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}, 120_000);

describe('the MCP server in Cowork use', () => {
  it('lists search, read, remember and forget', async () => {
    const { tools } = await client.listTools();

    expect(tools.map((t) => t.name).sort()).toEqual(['forget', 'read', 'remember', 'search']);
  });

  it('refuses a session key that is not a safe file name', async () => {
    const result = await call('remember', { session: '../escape', title: 't', asked: 'a', found: 'f' });

    expect(result.isError).toBe(true);
    expect(fs.existsSync(path.join(dir, 'cowork'))).toBe(false);
  });

  it('makes a remembered entry searchable within seconds', async () => {
    const started = Date.now();
    const recorded = await call('remember', {
      session,
      title: 'Lantern maintenance',
      asked: 'How often should the lantern wick be trimmed?',
      found: 'Every forty hours of burning. The gauge reported "wick-too-long: 12mm" before the trim.',
      project: 'Lanterns',
    });
    expect(recorded).toMatchObject({ isError: false });
    expect(recorded.text).toContain('Recorded entry 1 of this session under project "lanterns"');

    const found = await eventually(() => call('search', { query: 'wick-too-long', mode: 'text' }), (r) => r.text.includes(session));
    const seconds = (Date.now() - started) / 1000;

    expect(found.text).toContain(`[lanterns, ${new Date().toISOString().slice(0, 10)}, cowork note written by Claude]`);
    expect(found.text).toContain(archiveCopy());
    expect(seconds).toBeLessThan(60);
    const semantic = await call('search', { query: 'how often do I need to cut the lamp wick' });
    expect(semantic.text).toContain(session);
  }, 120_000);

  it('hides a forgotten session at once, and the sync forget starts deletes the rest', async () => {
    const forgotten = await call('forget', { session });

    expect(forgotten.isError).toBe(false);
    expect(forgotten.text).toContain(`Forgot session ${session}.`);
    expect(forgotten.text).toContain('Removed now: its Cowork record, 1 entry');
    expect(forgotten.text).toContain('Hidden from search from now on: 1 indexed exchange.');
    expect(fs.existsSync(path.join(dir, 'cowork', 'lanterns', `${session}.jsonl`))).toBe(false);
    expect((await call('search', { query: 'wick-too-long', mode: 'text' })).text).toBe('No results found.');
    expect((await call('search', { query: 'how often do I need to cut the lamp wick' })).text).not.toContain(session);
    expect((await call('read', { path: archiveCopy() })).isError).toBe(true);

    await eventually(() => fs.existsSync(archiveCopy()), (exists) => !exists);
    expect(fs.existsSync(archiveCopy())).toBe(false);
    expect(await eventually(logText, (text) => text.includes('as the user asked'))).toContain(`forgot ${archiveCopy()} (1 exchanges), as the user asked`);
  }, 120_000);

  it('refuses to remember a forgotten session', async () => {
    const result = await call('remember', { session, title: 'Lantern maintenance', asked: 'again?', found: 'no' });

    expect(result.isError).toBe(true);
    expect(result.text).toContain('asked to forget');
    expect(fs.existsSync(path.join(dir, 'cowork', 'lanterns', `${session}.jsonl`))).toBe(false);
  });
});

describe('read', () => {
  it('opens only transcripts and archive copies, never another file on this computer', async () => {
    const secret = path.join(dir, 'claude_desktop_config.json');
    fs.writeFileSync(secret, '{"env":{"TOKEN":"sk-verysecret"}}');
    const outside = path.join(dir, 'elsewhere', 'notes.jsonl');
    fs.mkdirSync(path.dirname(outside), { recursive: true });
    fs.writeFileSync(outside, '{"type":"user","message":{"role":"user","content":"private"}}\n');
    // A link inside an indexed folder that leads out of it.
    const projects = path.join(dir, 'claude', 'projects', '-Users-me-lanterns');
    fs.mkdirSync(projects, { recursive: true });
    const link = path.join(projects, 'link.jsonl');
    // A folder link, with `..` after it: the system follows the link first,
    // so this names elsewhere/notes.jsonl, though read as text it names a
    // notes.jsonl beside the link.
    const moved = path.join(projects, 'moved');
    fs.mkdirSync(path.join(dir, 'elsewhere', 'deep'), { recursive: true });
    fs.writeFileSync(path.join(projects, 'notes.jsonl'), '{"type":"user","message":{"role":"user","content":"inside"}}\n');
    const links = process.platform === 'win32' ? [] : [link, `${moved}${path.sep}..${path.sep}notes.jsonl`];
    if (process.platform !== 'win32') {
      fs.symlinkSync(outside, link);
      fs.symlinkSync(path.join(dir, 'elsewhere', 'deep'), moved);
    }

    for (const target of [secret, outside, `${path.join(dir, 'archive')}${path.sep}..${path.sep}elsewhere${path.sep}notes.jsonl`, ...links]) {
      const result = await call('read', { path: target });
      expect(result.isError).toBe(true);
      expect(result.text).toContain('reads only the transcripts it indexes');
      expect(result.text).not.toContain('sk-verysecret');
      expect(result.text).not.toContain('private');
    }
  });

  it('refuses a forgotten Codex session, whose file is named after something else', async () => {
    const id = '0199aaaa-bbbb-7ccc-8ddd-eeeeffff0001';
    const rollout = path.join(dir, 'codex', 'sessions', '2026', '09', '28', `rollout-2026-09-28T10-00-00-${id}.jsonl`);
    fs.mkdirSync(path.dirname(rollout), { recursive: true });
    const lines = [
      { timestamp: '2026-09-28T10:00:00.000Z', type: 'session_meta', payload: { id, cwd: '/Users/me/lanterns' } },
      { timestamp: '2026-09-28T10:00:01.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'how do I trim the chimney wick?' }] } },
      { timestamp: '2026-09-28T10:00:02.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Flat, with the lamp cold.' }] } },
    ];
    fs.writeFileSync(rollout, lines.map((l) => `${JSON.stringify(l)}\n`).join(''));
    expect((await call('read', { path: rollout })).text).toContain('chimney wick');

    expect((await call('forget', { session: id })).isError).toBe(false);

    const result = await call('read', { path: rollout });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('asked to forget');
  });

  it('refuses a forgotten Claude Code session\'s subagent transcripts, which carry the parent\'s id', async () => {
    const parent = '7f3c9a52-0000-4000-8000-00000000abcd';
    const subagent = path.join(dir, 'claude', 'projects', '-Users-me-lanterns', parent, 'subagents', 'agent-a1b2c3.jsonl');
    fs.mkdirSync(path.dirname(subagent), { recursive: true });
    const line = { type: 'user', isSidechain: true, sessionId: parent, timestamp: '2026-09-28T10:00:00.000Z', message: { role: 'user', content: 'look up the wick gauge' } };
    fs.writeFileSync(subagent, `${JSON.stringify(line)}\n`);
    expect((await call('read', { path: subagent })).isError).toBe(false);

    await call('forget', { session: parent });

    expect((await call('read', { path: subagent })).text).toContain('asked to forget');
  });
});
