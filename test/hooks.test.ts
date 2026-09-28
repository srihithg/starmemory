// The plugin's hooks, run the way the harness runs them: the command line from
// hooks/hooks.json through a POSIX shell.
//
// Plugin hooks also run inside a Cowork session's cloud container, where the
// sync hook must do nothing (it would install ~700 MB of dependencies to index
// a transcript that is thrown away) and the reminder hook is what gets the
// session recorded at all. Skipped on Windows, which has no /bin/sh; the hook
// commands are POSIX sh there too.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hooks = JSON.parse(fs.readFileSync(path.join(root, 'hooks', 'hooks.json'), 'utf8')).hooks;
const commands = (event: string): string[] =>
  (hooks[event] ?? []).flatMap((group: { hooks: { command: string }[] }) => group.hooks.map((h) => h.command));
const syncCommand = commands('SessionStart').find((c) => c.includes('starmemory.mjs'))!;

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'starmemory-hooks-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

/** Run a hook command line as the harness does, with only the given env. */
function runHook(command: string, env: Record<string, string>, input = '') {
  return spawnSync('/bin/sh', ['-c', command], { env, input, encoding: 'utf8', timeout: 20_000 });
}

describe.skipIf(process.platform === 'win32')('the SessionStart sync hook', () => {
  it('does nothing in a Cowork container: exits 0 at once, without looking for node or installing anything', () => {
    const home = path.join(dir, 'home');
    fs.mkdirSync(home);
    const started = Date.now();

    // remote_cowork_trigger is a scheduled Cowork task, in the same kind of container.
    for (const entrypoint of ['remote_cowork', 'remote_cowork_trigger']) {
      const r = runHook(syncCommand, {
        PLUGIN_ROOT: root,
        CLAUDE_CODE_ENTRYPOINT: entrypoint,
        CLAUDE_CODE_REMOTE: 'true',
        HOME: home,
        // Nothing is findable: if the guard let the command through, sh itself
        // would be missing and the hook would fail.
        PATH: path.join(dir, 'nowhere'),
        STARMEMORY_LOG_PATH: path.join(home, 'sync.log'),
      });

      expect(r.status).toBe(0);
      expect(r.stdout + r.stderr).toBe('');
    }
    expect(fs.readdirSync(home)).toEqual([]);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('does nothing in any other cloud container either, whose transcript never reaches the user\'s computer', () => {
    const r = runHook(syncCommand, { PLUGIN_ROOT: root, CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDE_CODE_REMOTE: 'true', PATH: path.join(dir, 'nowhere') });

    expect(r.status).toBe(0);
    expect(r.stdout + r.stderr).toBe('');
  });

  it('still starts the sync everywhere else', () => {
    // A stand-in plugin root whose node launcher records how it was called.
    const fake = path.join(dir, 'plugin');
    fs.mkdirSync(path.join(fake, 'cli'), { recursive: true });
    const calls = path.join(dir, 'calls.txt');
    fs.writeFileSync(path.join(fake, 'cli', 'run-node.sh'), `printf '%s\\n' "$@" > '${calls}'\n`);

    for (const entrypoint of ['cli', 'claude-desktop', '']) {
      fs.rmSync(calls, { force: true });
      const r = runHook(syncCommand, { PLUGIN_ROOT: fake, CLAUDE_CODE_ENTRYPOINT: entrypoint, PATH: process.env.PATH ?? '/usr/bin:/bin' });

      expect(r.status).toBe(0);
      expect(fs.readFileSync(calls, 'utf8').trim().split('\n')).toEqual([path.join(fake, 'cli', 'starmemory.mjs'), 'sync', '--background']);
    }
  });
});

describe.skipIf(process.platform === 'win32')('the reminder hook', () => {
  const reminder = (event: 'session-start' | 'prompt', sessionId: string | undefined, env: Record<string, string> = {}) => {
    const command = commands(event === 'prompt' ? 'UserPromptSubmit' : 'SessionStart').find((c) => c.includes('reminder.sh'))!;
    const input = sessionId === undefined ? '{}' : JSON.stringify({ session_id: sessionId, hook_event_name: 'x', cwd: '/home/claude' });
    return runHook(command, { PLUGIN_ROOT: root, PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: dir, ...env }, input);
  };
  const marks = () => path.join(dir, '.cache', 'starmemory', 'reminders');

  it('prints the instruction at session start, naming this session', () => {
    const r = reminder('session-start', 'aaaa-1111');

    expect(r.status).toBe(0);
    expect(r.stdout).toContain('starmemory: a standing instruction');
    expect(r.stdout).toContain('forget with this session\'s id: aaaa-1111');
    expect(r.stderr).toBe('');
  });

  it('prints it once per session on prompts, and again at every session start', () => {
    expect(reminder('prompt', 'aaaa-1111').stdout).toContain('standing instruction');
    expect(reminder('prompt', 'aaaa-1111').stdout).toBe('');
    expect(reminder('prompt', 'aaaa-1111').stdout).toBe('');
    // After a compaction the earlier copy is gone from the conversation.
    expect(reminder('session-start', 'aaaa-1111').stdout).toContain('standing instruction');
    expect(reminder('prompt', 'bbbb-2222').stdout).toContain('standing instruction');
    expect(reminder('prompt', 'bbbb-2222').stdout).toBe('');
  });

  it('tells a Cowork session to record itself with remember, under its session id as the key', () => {
    const cowork = reminder('session-start', 'aaaa-1111', { CLAUDE_CODE_ENTRYPOINT: 'remote_cowork' }).stdout;
    const local = reminder('session-start', 'bbbb-2222').stdout;

    expect(cowork).toContain('Before your first reply in this session, load the starmemory skill');
    expect(cowork).toContain('Record this session with its remember tool');
    expect(cowork).toContain('mcp__remote-devices__<server>__<tool>');
    expect(cowork).toContain('This session\'s key for remember and forget: aaaa-1111');
    expect(local).toContain('do not call remember');
    expect(local).not.toContain('Record this session');
    const scheduled = reminder('session-start', 'dddd-4444', { CLAUDE_CODE_ENTRYPOINT: 'remote_cowork_trigger' }).stdout;
    expect(scheduled).toContain('Record this session with its remember tool');
    const inContainer = reminder('session-start', 'eeee-5555', { CLAUDE_CODE_ENTRYPOINT: 'remote_cowork', CLAUDE_CODE_REMOTE: 'true' }).stdout;
    expect(inContainer).toContain('Record this session with its remember tool');
  });

  it('says nothing in another cloud container, where nothing it could record would last', () => {
    for (const event of ['session-start', 'prompt'] as const) {
      expect(reminder(event, 'ffff-6666', { CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDE_CODE_REMOTE: 'true' })).toMatchObject({ status: 0, stdout: '' });
    }
  });

  it('with no session id, reminds at session start only, since prompts cannot be told apart', () => {
    expect(reminder('session-start', undefined).stdout).toContain('standing instruction');
    expect(reminder('prompt', undefined)).toMatchObject({ status: 0, stdout: '' });
    expect(fs.existsSync(marks())).toBe(false);
  });

  it('falls back to CLAUDE_CODE_SESSION_ID, and to picking a key, when the input names no session', () => {
    const fromEnv = reminder('session-start', undefined, { CLAUDE_CODE_ENTRYPOINT: 'remote_cowork', CLAUDE_CODE_SESSION_ID: 'cccc-3333' });
    const none = reminder('session-start', undefined, { CLAUDE_CODE_ENTRYPOINT: 'remote_cowork' });

    expect(fromEnv.stdout).toContain('key for remember and forget: cccc-3333');
    expect(none.stdout).toContain('Pick one key now');
  });

  it('with no home to keep markers in, reminds at session start only', () => {
    const command = commands('UserPromptSubmit').find((c) => c.includes('reminder.sh'))!;
    const input = JSON.stringify({ session_id: 'aaaa-1111' });
    const r = runHook(command, { PLUGIN_ROOT: root, PATH: process.env.PATH ?? '/usr/bin:/bin' }, input);

    expect(r).toMatchObject({ status: 0, stdout: '' });
  });

  it('takes ".", ".." and an id longer than a session key for no id at all', () => {
    for (const id of ['.', '..', 'a'.repeat(121)]) {
      const r = reminder('session-start', id);
      expect(r).toMatchObject({ status: 0, stderr: '' });
      expect(r.stdout).not.toContain(`session's id: ${id}`);
    }
    expect(fs.existsSync(marks())).toBe(false);
  });

  it('never prints an id that is not a plain id', () => {
    const r = reminder('session-start', 'x"; rm -rf ~; "');

    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain('rm -rf');
    expect(fs.existsSync(marks())).toBe(false);
  });

  it('keeps its markers under the user\'s home, not a shared temp directory', () => {
    reminder('prompt', 'aaaa-1111', { TMPDIR: path.join(dir, 'tmp') });

    expect(fs.readdirSync(marks())).toEqual(['aaaa-1111']);
    expect(fs.existsSync(path.join(dir, 'tmp'))).toBe(false);
  });

  it('is silent when turned off, and inside a summarizer child', () => {
    expect(reminder('session-start', 'aaaa-1111', { STARMEMORY_REMINDER: '0' })).toMatchObject({ status: 0, stdout: '' });
    expect(reminder('session-start', 'aaaa-1111', { STARMEMORY_SUMMARIZER_GUARD: '1' })).toMatchObject({ status: 0, stdout: '' });
  });

  it('still prints, and exits 0, when it cannot write its marker', () => {
    const file = path.join(dir, 'not-a-directory');
    fs.writeFileSync(file, '');

    const r = reminder('prompt', 'aaaa-1111', { HOME: file });

    expect(r.status).toBe(0);
    expect(r.stdout).toContain('standing instruction');
  });
});
