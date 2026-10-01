// Summaries for Codex conversations, through `codex app-server` (JSON-RPC over
// stdio). Each one is a fresh ephemeral thread, read-only and asking for no
// approval, handed the conversation as text (summaries.ts, transcriptText).
// Never a fork of the original thread: a fork carries the whole thread, tool
// output included, and whatever a hostile line in it asks for. app-server runs
// in an empty folder of its own, so no project's AGENTS.md or files are in
// reach. Mirrors episodic-memory's client. Not yet verified against a real
// Codex on this machine: test/fixtures/fake-codex-app-server.mjs speaks the
// same subset. Design doc archive-and-summaries §05.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { SUMMARY_PROMPT, extractSummary } from './summaries.js';
import { summarizerEnv } from './summarizer-claude.js';
export const MIN_CODEX_VERSION = '0.130.0';
const { version: PLUGIN_VERSION } = createRequire(import.meta.url)('../package.json');
export function parseCodexVersion(output) {
    return output.match(/(\d+)\.(\d+)\.(\d+)/)?.[0];
}
export function versionAtLeast(version, minimum = MIN_CODEX_VERSION) {
    const a = version.split('.').map(Number);
    const b = minimum.split('.').map(Number);
    for (let i = 0; i < 3; i++)
        if (a[i] !== b[i])
            return a[i] > b[i];
    return true;
}
function command(bin) {
    const [cmd, ...args] = bin.split(' ');
    return { cmd, args };
}
function readOutput(cmd, args, env, cwd) {
    return new Promise((resolve, reject) => {
        const child = spawn(cmd, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '';
        child.stdout.on('data', (d) => (out += d));
        child.stderr.on('data', (d) => (out += d));
        child.on('error', (e) => reject(new Error(`codex not found: ${e.message}`)));
        child.on('exit', (code) => code === 0 ? resolve(out) : reject(new Error(`${cmd} ${args.join(' ')} exited ${code}: ${out.trim()}`)));
    });
}
export async function summarizeWithCodex(input, deps = {}) {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'starmemory-summary-'));
    try {
        return await summarizeIn(cwd, input, deps);
    }
    finally {
        removeFolder(cwd);
    }
}
/** On Windows a child that is still exiting holds its working folder; an
 * empty one left in the temp folder is no reason to lose the summary. */
function removeFolder(dir) {
    try {
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    }
    catch {
        // left for the system's temp cleanup
    }
}
async function summarizeIn(cwd, input, deps) {
    const env = summarizerEnv(deps.env ?? process.env);
    const bin = deps.bin ?? env.STARMEMORY_CODEX_BIN ?? 'codex';
    const configured = Number(env.STARMEMORY_CODEX_SUMMARY_TIMEOUT_MS);
    const timeoutMs = deps.timeoutMs ?? (configured > 0 ? configured : 120_000);
    const { cmd, args } = command(bin);
    const versionOut = await readOutput(cmd, [...args, '--version'], env, cwd);
    const version = parseCodexVersion(versionOut);
    if (!version || !versionAtLeast(version)) {
        throw new Error(`Codex summarization requires codex-cli >= ${MIN_CODEX_VERSION}; found ${version ?? (versionOut.trim() || '(no version)')}. Run codex update and retry.`);
    }
    return new Promise((resolve, reject) => {
        const child = spawn(cmd, [...args, 'app-server'], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
        const pending = new Map();
        let nextId = 1;
        let answer = '';
        let turnId;
        let stderr = '';
        let done = false;
        const rl = readline.createInterface({ input: child.stdout });
        const finish = (error, text = '') => {
            if (done)
                return;
            done = true;
            clearTimeout(timer);
            rl.close();
            if (!child.killed)
                child.kill('SIGTERM');
            if (error)
                reject(error);
            else
                resolve(text.trim());
        };
        const timer = setTimeout(() => finish(new Error(`Codex summarizer timed out after ${timeoutMs}ms ${stderr.trim()}`.trim())), timeoutMs);
        const send = (method, params) => new Promise((res, rej) => {
            const id = nextId++;
            pending.set(id, { method, resolve: res, reject: rej });
            child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
        });
        const notify = (method) => child.stdin.write(`${JSON.stringify({ method })}\n`);
        child.stderr.on('data', (d) => (stderr += d));
        child.on('error', (e) => finish(new Error(`codex not found: ${e.message}`)));
        child.on('exit', (code) => finish(new Error(code === 0
            ? 'Codex app-server exited before the summary turn completed'
            : `codex app-server exited ${code}: ${stderr.trim()}`)));
        rl.on('line', (line) => {
            if (!line.trim())
                return;
            let msg;
            try {
                msg = JSON.parse(line);
            }
            catch {
                finish(new Error(`Codex app-server emitted invalid JSON: ${line}`));
                return;
            }
            if (typeof msg.id === 'number' && pending.has(msg.id)) {
                const req = pending.get(msg.id);
                pending.delete(msg.id);
                if (msg.error)
                    req.reject(new Error(`${req.method} failed: ${JSON.stringify(msg.error)}`));
                else
                    req.resolve(msg.result);
                return;
            }
            const p = msg.params;
            if (msg.method === 'item/agentMessage/delta') {
                answer += p?.delta ?? '';
            }
            else if (msg.method === 'item/completed' && p?.item?.type === 'agentMessage') {
                answer = p.item.text ?? answer;
            }
            else if (msg.method === 'turn/completed' && (!turnId || p?.turn?.id === turnId)) {
                if (p?.turn?.status === 'completed')
                    finish(undefined, extractSummary(answer) ?? answer);
                else
                    finish(new Error(`Codex summarizer turn did not complete: ${p?.turn?.error?.message ?? p?.turn?.status}`));
            }
        });
        (async () => {
            try {
                await send('initialize', {
                    clientInfo: { name: 'starmemory', title: 'StarMemory', version: PLUGIN_VERSION },
                    capabilities: { experimentalApi: true },
                });
                notify('initialized');
                const fresh = (await send('thread/start', { ephemeral: true, sandbox: 'read-only', approvalPolicy: 'never' }));
                const threadId = fresh.thread?.id;
                if (!threadId)
                    throw new Error('codex app-server returned no thread id');
                const turn = (await send('turn/start', {
                    threadId,
                    input: [{ type: 'text', text: `${SUMMARY_PROMPT}\n\n${input.transcript}`, textElements: [] }],
                }));
                turnId = turn.turn?.id;
                if (!turnId)
                    throw new Error('turn/start returned no turn id');
            }
            catch (error) {
                finish(error instanceof Error ? error : new Error(String(error)));
            }
        })();
    });
}
