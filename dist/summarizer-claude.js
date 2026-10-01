// Summaries for Claude Code conversations, through the Claude Agent SDK.
//
// The model gets the conversation as text and can do nothing but answer. It is
// a fresh session every time, never the original one resumed: a resumed
// session comes back with every tool result in it and with the user's tools,
// settings, MCP servers, plugins and allow rules, so a hostile line in what was
// recorded could have those tools run with nobody watching. This one has no
// tools, loads no settings and no MCP server, gets one turn, and runs in an
// empty folder of its own rather than in the project. The text is the user's
// and the assistant's words only, with secrets redacted (summaries.ts,
// transcriptText).
//
// The SDK starts a Claude subprocess, and that subprocess fires SessionStart
// hooks, and our SessionStart hook runs sync, which summarises, which starts
// a Claude subprocess... episodic-memory saw hundreds of processes in seconds
// (their #87). Every child we start carries STARMEMORY_SUMMARIZER_GUARD and
// `starmemory sync` exits at once when it sees it (cli/starmemory.mjs).
// Anything new that spawns a Claude or Codex process must build its env with
// summarizerEnv(). Design doc archive-and-summaries §05, §06.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { SUMMARY_PROMPT, extractSummary } from './summaries.js';
export const SUMMARIZER_GUARD = 'STARMEMORY_SUMMARIZER_GUARD';
export function summarizerEnv(base = process.env) {
    return { ...base, [SUMMARIZER_GUARD]: '1' };
}
export function isReentrantSummarizerContext(env = process.env) {
    return env[SUMMARIZER_GUARD] === '1';
}
const SYSTEM_PROMPT = 'Write concise, factual summaries. Output only the summary: no preamble, no "Here is".';
/** What the summarizing session may do: answer once, and nothing else. No
 * built-in tool, no settings file (and so no allow rule, hook or plugin), no
 * MCP server, one turn, and a permission mode that refuses whatever was not
 * allowed beforehand, which is everything. persistSession: false keeps it from
 * writing a session file of its own, which the next sync would index. */
export const LOCKED_DOWN_OPTIONS = {
    tools: [],
    settingSources: [],
    mcpServers: {},
    strictMcpConfig: true,
    maxTurns: 1,
    permissionMode: 'dontAsk',
    persistSession: false,
};
class SdkResultError extends Error {
}
async function runQuery(query, prompt, options) {
    for await (const message of query({ prompt, options })) {
        const m = message;
        if (m.type !== 'result')
            continue;
        if (m.is_error)
            throw new SdkResultError(m.subtype ?? 'unknown SDK error');
        return typeof m.result === 'string' ? m.result : '';
    }
    return '';
}
/** The SDK reports some API errors as the result text rather than is_error. */
function isThinkingBudgetError(text) {
    return text.includes('API Error') && text.includes('thinking.budget_tokens');
}
/** One locked-down question with the transcript in it, and the fallback model
 * once when the primary hits a thinking-budget error. */
export async function summarizeWithClaude(input, deps = {}) {
    const query = deps.query ?? sdkQuery;
    const env = deps.env ?? process.env;
    const primary = env.STARMEMORY_SUMMARY_MODEL ?? 'haiku';
    const fallback = env.STARMEMORY_SUMMARY_MODEL_FALLBACK ?? 'sonnet';
    // No project's folder, so nothing in one (a CLAUDE.md, .mcp.json or
    // .claude/settings.json) has any say.
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'starmemory-summary-'));
    try {
        const options = { ...LOCKED_DOWN_OPTIONS, cwd, env: summarizerEnv(env), max_tokens: 1024, systemPrompt: SYSTEM_PROMPT };
        const attempt = async (model) => {
            const reply = await runQuery(query, `${SUMMARY_PROMPT}\n\n${input.transcript}`, { ...options, model });
            return isThinkingBudgetError(reply) ? reply : (extractSummary(reply) ?? reply.trim());
        };
        let text = await attempt(primary);
        if (isThinkingBudgetError(text))
            text = await attempt(fallback);
        if (isThinkingBudgetError(text))
            throw new Error(text.split('\n')[0]);
        return text.trim();
    }
    finally {
        // On Windows a child that is still exiting holds its working folder; an
        // empty one left in the temp folder is no reason to lose the summary.
        try {
            fs.rmSync(cwd, { recursive: true, force: true, maxRetries: 3 });
        }
        catch {
            // left for the system's temp cleanup
        }
    }
}
