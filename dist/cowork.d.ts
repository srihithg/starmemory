/** STARMEMORY_COWORK_PATH, else ~/.config/starmemory/cowork, on the machine
 * whose Claude desktop app runs this server for Cowork. */
export declare function defaultCoworkRoot(env?: NodeJS.ProcessEnv): string;
/** Upper bounds on one entry. A record is a summary: an entry longer than this
 * is a transcript being pasted in, which is exactly what it must not become. */
export declare const LIMITS: {
    readonly title: 200;
    readonly asked: 2000;
    readonly found: 8000;
    readonly project: 80;
};
/** A session key names the record's file, so it is held to what every
 * filesystem accepts. Anything else is refused rather than rewritten, so one
 * session can never quietly become two files. */
export declare const SESSION_KEY_PATTERN: RegExp;
/** Why `session` cannot be a key, or undefined when it can. */
export declare function sessionKeyProblem(session: string): string | undefined;
export declare const DEFAULT_PROJECT = "general";
/** The folder a project's records live in, which is also the project name that
 * search shows and filters on. Lowercased, and runs of anything but letters,
 * digits, ".", "_" and "-" become "-", so "StarRocks BE" and "starrocks-be"
 * are the same project from one session to the next. Letters of any script
 * are kept. */
export declare function projectSlug(project: string | undefined): string;
/** Every record of `session`, in a stable order. Normally one: a session
 * stays in the folder of the project it started under (see remember). */
export declare function findRecords(root: string, session: string): string[];
/** Entries in a record: one per user line. */
export declare function countEntries(file: string): number;
export interface RememberInput {
    /** Stable for the whole session; names the record's file. */
    session: string;
    /** One line: what the session is about. */
    title: string;
    /** What the user asked, that this entry answers. */
    asked: string;
    /** What was found, decided, built or left open, with the exact strings. */
    found: string;
    /** Repo or subject; the same one across sessions about it. */
    project?: string;
}
export interface RememberResult {
    file: string;
    project: string;
    /** Entries in the record now, this one included. */
    entries: number;
    /** True when this entry started the record. */
    created: boolean;
    /** The project asked for, when the session is already recorded under another. */
    ignoredProject?: string;
}
/** Nothing was written. The message is meant for the model, so it says what to
 * do instead. */
export declare class RefusedError extends Error {
}
export interface RememberOptions {
    /** Whether the user asked to forget the session (src/forget.ts). Asked twice,
     * before writing and after, because `forget` can run in another process in
     * between. */
    isForgotten?: (session: string) => boolean;
    /** Called with the record's path just before its first line is written. A
     * record started again under a key counts its lines from 1, so the caller
     * removes any sync cursor left there by the key's earlier record. */
    onStart?: (file: string) => void;
    now?: Date;
}
/** Append one entry to `session`'s record, starting the record if needed.
 * Throws RefusedError, writing nothing, for a bad key, an empty or oversize
 * field, or a session the user asked to forget. */
export declare function remember(root: string, input: RememberInput, { isForgotten, onStart, now }?: RememberOptions): RememberResult;
/** Remove every record of `session`. Returns the files removed and how many
 * entries they held. */
export declare function deleteRecords(root: string, session: string): {
    files: string[];
    entries: number;
};
/** What the model is told after a remember. */
export declare function describeRemember(result: RememberResult): string;
