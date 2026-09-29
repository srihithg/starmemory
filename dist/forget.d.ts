import { type Quarantine, type SetAside } from './cowork.js';
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
    /** Cowork record files removed at once, or set aside. */
    records: string[];
    /** Entries those records held. */
    entries: number;
    /** Where each record was set aside, when it was (see ForgetOptions.quarantine),
     * and until when. */
    setAside: SetAside[];
    /** How long a set-aside record is kept before a sync deletes it. */
    setAsideDays: number;
    /** Records that could not be set aside, and why. Hidden all the same, and
     * left where they are for the next sync to set aside (sync.ts). */
    notSetAside?: {
        records: string[];
        reason: string;
    };
    /** Records of this session an earlier forget set aside: where each is, the
     * record it was, when a sync may delete it where its name says, and whether
     * this forget deleted them (ForgetOptions.quarantineRoot). */
    earlier: {
        records: {
            from: string;
            to: string;
            expiresAt?: number;
        }[];
        entries: number;
        removed: boolean;
    };
    /** The list the session was put on. */
    forgottenPath: string;
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
/** Where Claude Code and Codex keep their transcripts (sync.ts,
 * harnessTranscriptDirs). */
export interface HarnessDirs {
    claude: string;
    codex: string;
}
export interface ForgetOptions {
    coworkRoot: string;
    forgottenPath: string;
    archiveRoot: string;
    store?: StoreHandle;
    /** Given on a server that serves Cowork records only: a session Claude Code
     * or Codex keeps is refused, and nothing is changed. */
    coworkOnly?: {
        dirs: HarnessDirs;
    };
    /** Where a Cowork record is set aside instead of deleted, and for how many
     * days. Without it, or at 0 days, the record is deleted at once. What an
     * earlier forget set aside there stays for its time. */
    quarantine?: Quarantine;
    /** Given without `quarantine`, by a server that deletes what it forgets:
     * the quarantine, whose records of this session an earlier forget from
     * Cowork set aside. They are deleted with the rest. */
    quarantineRoot?: string;
    now?: Date;
}
/** Forget `session`: put it on the list, then remove its Cowork record, or set
 * it aside, and remove the archive copies and summaries kept of it. The caller
 * starts a sync, which deletes the rest. Throws RefusedError, changing nothing,
 * for a key that could not name a session, or on a Cowork-only server for a
 * Claude Code or Codex session. A key with nothing stored under it yet is
 * listed all the same, so remember refuses it from the first entry. A record
 * that cannot be set aside is reported (notSetAside), not thrown: the session
 * is listed by then. */
export declare function forget(session: string, { coworkRoot, forgottenPath, archiveRoot, store, coworkOnly, quarantine, quarantineRoot, now }: ForgetOptions): ForgetResult;
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
