import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
export declare const SUMMARIZER_GUARD = "STARMEMORY_SUMMARIZER_GUARD";
export declare function summarizerEnv(base?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
export declare function isReentrantSummarizerContext(env?: NodeJS.ProcessEnv): boolean;
export type QueryFn = typeof sdkQuery;
export interface ClaudeSummaryInput {
    /** The conversation as text (summaries.ts, transcriptText). */
    transcript: string;
}
/** What the summarizing session may do: answer once, and nothing else. No
 * built-in tool, no settings file (and so no allow rule, hook or plugin), no
 * MCP server, one turn, and a permission mode that refuses whatever was not
 * allowed beforehand, which is everything. persistSession: false keeps it from
 * writing a session file of its own, which the next sync would index. */
export declare const LOCKED_DOWN_OPTIONS: {
    readonly tools: readonly [];
    readonly settingSources: readonly [];
    readonly mcpServers: {};
    readonly strictMcpConfig: true;
    readonly maxTurns: 1;
    readonly permissionMode: "dontAsk";
    readonly persistSession: false;
};
/** One locked-down question with the transcript in it, and the fallback model
 * once when the primary hits a thinking-budget error. */
export declare function summarizeWithClaude(input: ClaudeSummaryInput, deps?: {
    query?: QueryFn;
    env?: NodeJS.ProcessEnv;
}): Promise<string>;
