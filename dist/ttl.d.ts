import { type StoreHandle } from './store.js';
import type { TextIndex } from './text-index.js';
import type { ConversationExchange, Harness } from './types.js';
export declare const DEFAULT_TTL_DAYS = 180;
/** `STARMEMORY_TTL_DAYS`; 0 (or a non-number) disables expiry. */
export declare function defaultTtlDays(env?: NodeJS.ProcessEnv): number;
export declare function ttlCutoffMs(ttlDays: number, now?: number): number;
export interface ExpireOptions {
    ttlDays?: number;
    now?: number;
    archiveRoot: string;
    log?: (line: string) => void;
}
export interface RemoveResult {
    /** Rows removed from the store. */
    rows: number;
    /** Conversations (archive files) removed. */
    files: number;
    /** True when another process held the text writer, so nothing was done this run. */
    skipped: boolean;
}
export type ExpireResult = RemoveResult;
/** One conversation's rows: everything stored from one transcript. */
export interface ConversationGroup {
    archivePath: string;
    harness: Harness;
    project: string;
    ids: number[];
    latestTimestampMs: number;
}
export declare function groupByFile(rows: ConversationExchange[]): ConversationGroup[];
/** Remove whole conversations everywhere: the rows and their vectors, their
 * text-index documents, the archive copy and its summary, so a search never
 * returns something that cannot be opened. Holds the text writer for the
 * duration when a text index is given; if another process has it, nothing is
 * removed this run and the next sync tries again. Shared by the TTL and by
 * forgetting a session (src/forget.ts). */
export declare function removeConversations(store: StoreHandle, textIndex: TextIndex | undefined, groups: ConversationGroup[], { archiveRoot, log, describe, onRemoved, }: {
    archiveRoot: string;
    log?: (line: string) => void;
    describe: (g: ConversationGroup) => string;
    onRemoved?: (g: ConversationGroup) => void;
}): RemoveResult;
/** Remove every conversation whose last activity is older than the TTL. */
export declare function expireOldConversations(store: StoreHandle, textIndex: TextIndex | undefined, { ttlDays, now, archiveRoot, log }: ExpireOptions): ExpireResult;
