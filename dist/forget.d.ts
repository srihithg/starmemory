import { type StoreHandle } from './store.js';
import type { TextIndex } from './text-index.js';
import { type RemoveResult } from './ttl.js';
import { type Harness } from './types.js';
/** STARMEMORY_FORGOTTEN_PATH, else ~/.config/starmemory/forgotten.txt. */
export declare function defaultForgottenPath(env?: NodeJS.ProcessEnv): string;
/** Every forgotten session key. A missing file is an empty list. */
export declare function readForgotten(file: string): Set<string>;
/** Appended, never rewritten: a short O_APPEND write lands whole, so two
 * processes forgetting at the same moment cannot lose each other's line. A
 * file edited by hand can end without a newline, and appending straight onto
 * its last line would fuse two keys into one that matches neither, so the key
 * then starts on a line of its own. */
export declare function addForgotten(file: string, session: string): void;
export interface ForgetResult {
    session: string;
    /** Cowork record files removed at once. */
    records: string[];
    /** Entries those records held. */
    entries: number;
    /** Archive copies removed at once, with their summaries. */
    copies: string[];
    /** Exchanges still in the store: hidden from search from now on, deleted by
     * the next sync. */
    pendingRows: number;
    /** Which harnesses those exchanges came from. */
    pendingHarnesses: Harness[];
    /** The session was on the list already. */
    alreadyForgotten: boolean;
}
/** Forget `session`: put it on the list, then remove its Cowork record and the
 * archive copies and summaries kept of it. The caller starts a sync, which
 * deletes the rest. Throws RefusedError for a key that could not name a
 * session. */
export declare function forget(session: string, { coworkRoot, forgottenPath, archiveRoot, store }: {
    coworkRoot: string;
    forgottenPath: string;
    archiveRoot: string;
    store?: StoreHandle;
}): ForgetResult;
/** What the model is told, to pass on to the user in a sentence. */
export declare function describeForget(result: ForgetResult): string;
/** The sync step: delete every stored conversation of a forgotten session, the
 * same way the TTL deletes an expired one and under the same text-writer rule
 * (ttl.ts, removeConversations). A Claude Code or Codex transcript keeps its
 * cursor, so nothing of it is indexed again, even if another sync was about
 * to. A Cowork record's cursor goes, whoever stored the rows: forget() removed
 * the record, and one started later under the key counts its lines from 1. */
export declare function forgetSessions(store: StoreHandle, textIndex: TextIndex | undefined, sessions: ReadonlySet<string>, { archiveRoot, coworkRoot, log }: {
    archiveRoot: string;
    coworkRoot?: string;
    log?: (line: string) => void;
}): RemoveResult;
