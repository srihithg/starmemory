/** cli/starmemory.mjs. dist/ and src/ sit at the same depth, so this resolves
 * from either. */
export declare const CLI_ENTRY: string;
/** Whether this copy can still start a sync. A long-running server can outlive
 * its own files: a plugin update installs a new copy, and Claude Code later
 * removes the old one the server started from. */
export declare function canStartSync(entry?: string): boolean;
/** `starmemory sync --background --cowork-only`: the hook's detached sync,
 * whose output goes to sync.log, forked and left. Its stdio is ignored, never
 * inherited: the server's stdout is the MCP channel. It is here to index an
 * entry or carry out a forget, so it walks only the Cowork records, not every
 * Claude Code and Codex transcript (which sync parses whole each time, and a
 * Claude Code turn caught halfway would be stored twice), and it writes no
 * summaries, which a burst of calls would otherwise start a round of model
 * calls for each time. Deleting forgotten sessions covers the whole store
 * either way. The session-start sync does the rest. Returns false when this
 * copy is gone and nothing was started. */
export declare function spawnBackgroundSync(entry?: string): boolean;
export interface SyncTriggerOptions {
    start?: () => unknown;
    intervalMs?: number;
    /** Milliseconds on a clock that only moves forward; performance.now() by
     * default. With the wall clock, setting the time back an hour would hold
     * every sync for that hour. */
    now?: () => number;
    setTimer?: (callback: () => void, ms: number) => {
        unref?: () => void;
    };
}
/** At most one sync per interval. The first request starts one at once;
 * requests inside the interval share a single sync at its end. Every sync loads
 * the embedding model, so a burst of remember calls costs two syncs, not one
 * each. */
export declare function createSyncTrigger({ start, intervalMs, now, setTimer, }?: SyncTriggerOptions): () => void;
