import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { summarizeWithClaude, summarizerEnv, isReentrantSummarizerContext, SUMMARIZER_GUARD, type QueryFn } from '../src/summarizer-claude.js';

type Call = { prompt: string; options: Record<string, unknown> };
function fakeQuery(script: (call: Call, n: number) => AsyncGenerator<unknown>) {
  const calls: Call[] = [];
  const query = ((args: Call) => { calls.push(args); return script(args, calls.length); }) as unknown as QueryFn;
  return { query, calls };
}
async function* result(text: string) { yield { type: 'result', result: text, is_error: false }; }
const tagged = (text: string) => result(`<summary>${text}</summary>`);
async function* failure(subtype: string) { yield { type: 'result', is_error: true, subtype }; }

describe('the guard', () => {
  it('marks every child environment and is recognised back', () => {
    const env = summarizerEnv({ PATH: '/bin' });
    expect(env[SUMMARIZER_GUARD]).toBe('1');
    expect(env.PATH).toBe('/bin');
    expect(isReentrantSummarizerContext(env)).toBe(true);
    expect(isReentrantSummarizerContext({})).toBe(false);
  });
});

describe('summarizeWithClaude', () => {
  it('asks once, in a fresh session that can use no tool, load no settings or MCP server, or take a second turn', async () => {
    const { query, calls } = fakeQuery(() => tagged(' Fixed the flaky test. '));

    const text = await summarizeWithClaude({ transcript: 'User: hi\nAssistant: hello' }, { query, env: {} });

    expect(text).toBe('Fixed the flaky test.');
    expect(calls.length).toBe(1);
    const { options, prompt } = calls[0];
    expect(options).toMatchObject({ tools: [], settingSources: [], mcpServers: {}, strictMcpConfig: true, maxTurns: 1, permissionMode: 'dontAsk', persistSession: false });
    for (const key of ['resume', 'continue', 'forkSession', 'allowedTools', 'plugins', 'agents', 'additionalDirectories']) expect(options).not.toHaveProperty(key);
    expect((options.env as Record<string, string>)[SUMMARIZER_GUARD]).toBe('1');
    expect(prompt).toContain('User: hi\nAssistant: hello');
  });

  it('runs in an empty folder of its own, not the project, and removes it after', async () => {
    let seen: { cwd: string; entries: string[] } | undefined;
    const { query } = fakeQuery(async function* ({ options }) {
      const cwd = options.cwd as string;
      seen = { cwd, entries: fs.readdirSync(cwd) };
      yield* tagged('ok');
    });

    await summarizeWithClaude({ transcript: 'User: x' }, { query, env: {} });

    expect(seen!.entries).toEqual([]);
    expect(path.resolve(seen!.cwd)).not.toBe(path.resolve(process.cwd()));
    expect(fs.realpathSync(path.dirname(seen!.cwd))).toBe(fs.realpathSync(os.tmpdir()));
    expect(fs.existsSync(seen!.cwd)).toBe(false);
  });

  it('accepts an untagged reply, where there is no conversation to drift into', async () => {
    const { query } = fakeQuery(() => result('Plain summary.'));
    expect(await summarizeWithClaude({ transcript: 'User: x' }, { query, env: {} })).toBe('Plain summary.');
  });

  it('retries with the fallback model on a thinking budget error', async () => {
    const { query, calls } = fakeQuery((_, n) => (n === 1 ? result('API Error: thinking.budget_tokens too low') : result('ok')));
    const text = await summarizeWithClaude({ transcript: 'User: x' }, { query, env: {} });
    expect(text).toBe('ok');
    expect(calls[0].options.model).toBe('haiku');
    expect(calls[1].options.model).toBe('sonnet');
    expect(calls[1].options).toMatchObject({ tools: [], maxTurns: 1 });
  });

  it('throws when the call fails, so the caller writes an error sentinel, and still removes its folder', async () => {
    let cwd = '';
    const { query } = fakeQuery(async function* ({ options }) {
      cwd = options.cwd as string;
      yield* failure('not_logged_in');
    });
    await expect(summarizeWithClaude({ transcript: 'x' }, { query, env: {} })).rejects.toThrow(/not_logged_in/);
    expect(fs.existsSync(cwd)).toBe(false);
  });
});

describe('summarizeWithClaude through the Agent SDK', () => {
  const fakeClaude = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-claude.mjs');
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'starmemory-summarizer-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });

  it('gives the Claude executable no way to resume, use a tool, load settings or an MCP server, or run in the project', async () => {
    const log = path.join(dir, 'claude.log');
    const query = ((args: { prompt: string; options: Record<string, unknown> }) =>
      sdkQuery({ ...args, options: { ...args.options, pathToClaudeCodeExecutable: fakeClaude } } as Parameters<QueryFn>[0])) as unknown as QueryFn;
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;

    const text = await summarizeWithClaude({ transcript: 'User: why did the index rebuild?\nAssistant: A stale lock.' }, { query, env: { ...env, FAKE_CLAUDE_LOG: log } });

    expect(text).toBe('The user fixed a race.');
    const [run] = fs.readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    const flag = (name: string) => (run.argv as string[]).indexOf(name);
    expect(run.argv[flag('--tools') + 1]).toBe('');
    expect(run.argv).toContain('--setting-sources=');
    expect(run.argv).toContain('--strict-mcp-config');
    expect(run.argv[flag('--max-turns') + 1]).toBe('1');
    expect(run.argv[flag('--permission-mode') + 1]).toBe('dontAsk');
    expect(run.argv).toContain('--no-session-persistence');
    for (const name of ['--resume', '--continue', '--fork-session', '--mcp-config', '--allowedTools', '--plugin-dir']) expect(run.argv).not.toContain(name);
    expect(fs.realpathSync(path.dirname(run.cwd))).toBe(fs.realpathSync(os.tmpdir()));
    expect(run.cwd).not.toBe(process.cwd());
    expect(run.guard).toBe('1');
    expect(run.prompt).toContain('User: why did the index rebuild?');
  }, 30_000);
});
