/** STARMEMORY_COWORK_PATH, else ~/.config/starmemory/cowork, on the machine
 * whose Claude desktop app runs this server for Cowork. */
export declare function defaultCoworkRoot(env?: NodeJS.ProcessEnv): string;
/** What this server gives a caller. `all`, the default, is every harness's
 * sessions, as Claude Code and Codex use it. `cowork` is the Cowork records
 * alone: search and read see nothing else, and forget refuses a Claude Code or
 * Codex session. The Claude app's server runs as `cowork` unless the user opts
 * in (cli/desktop-launch.mjs). */
export type Scope = 'all' | 'cowork';
/** STARMEMORY_SCOPE. Unset is `all`; any value but `all` is `cowork`, so a
 * mistyped setting gives less away, not more. */
export declare function serverScope(env?: NodeJS.ProcessEnv): Scope;
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
export declare const DEFAULT_REMEMBER_DAILY_LIMIT = 300;
/** STARMEMORY_REMEMBER_DAILY_LIMIT, else 300. `0` refuses every entry; a
 * value that is not a whole number keeps the default. */
export declare function defaultRememberDailyLimit(env?: NodeJS.ProcessEnv): number;
/** How many entries one server process records per UTC day. The default is
 * far more than a day of sessions writes, and bounds how much a caller
 * steered into a loop can pile into the memory. Held in memory, so a restart
 * of the app starts the count again. */
export declare class DailyCap {
    readonly limit: number;
    private day;
    private used;
    constructor(limit: number);
    /** Throws RefusedError when today's entries are used up. */
    check(now: Date): void;
    /** One more entry recorded today. */
    count(now: Date): void;
    private today;
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
    /** Refuses an entry over the day's limit, and counts each one written. */
    dailyCap?: DailyCap;
    now?: Date;
}
/** `text` with the `<` of each harness control tag (parser.ts,
 * INJECTED_TAG_START) written as `&lt;`: still readable, never a tag. Any
 * other `<`, as in `Array<T>` or `a < b`, is left alone. */
export declare function escapeControlTags(text: string): string;
/** Append one entry to `session`'s record, starting the record if needed.
 * Throws RefusedError, writing nothing, for a bad key, an empty or oversize
 * field, an entry over the daily limit, or a session the user asked to
 * forget. */
export declare function remember(root: string, input: RememberInput, { isForgotten, onStart, dailyCap, now }?: RememberOptions): RememberResult;
/** Remove every record of `session`. Returns the files removed and how many
 * entries they held. */
export declare function deleteRecords(root: string, session: string): {
    files: string[];
    entries: number;
};
/** STARMEMORY_QUARANTINE_PATH, else ~/.config/starmemory/quarantine: where a
 * forgotten Cowork record is set aside for a while, so a mistaken forget can
 * be undone (src/forget.ts). */
export declare function defaultQuarantineRoot(env?: NodeJS.ProcessEnv): string;
export declare const DEFAULT_QUARANTINE_DAYS = 7;
/** STARMEMORY_QUARANTINE_DAYS, else 7. `0` deletes a forgotten record at once.
 * A value that is not a number of days keeps the default: what a purge
 * deletes cannot be brought back. */
export declare function defaultQuarantineDays(env?: NodeJS.ProcessEnv): number;
export interface Quarantine {
    root: string;
    days: number;
}
/** How a set-aside record's name ends. Not `.jsonl`, so nothing that looks for
 * transcripts, sync's walk and `read` among them, takes one for a record. */
export declare const QUARANTINE_SUFFIX = ".jsonl.forgotten";
/** When a set-aside record may be deleted, read from its name
 * (quarantineRecord), or undefined for a name that does not carry one. */
export declare function setAsideExpiry(name: string): number | undefined;
export interface SetAside {
    from: string;
    to: string;
    /** When a sync may delete it, in ms since the epoch. */
    expiresAt: number;
}
/** Move one record, <root>/<project>/<session>.jsonl, into the quarantine, as
 * <quarantine>/<project>/<session>.<expiresAt>-<random>.jsonl.forgotten,
 * readable by the owner alone. The expiry goes in the name, so it is kept for
 * `quarantine.days` whichever process's sync purges it, with whatever days
 * that process was given. The random part keeps a later forget of the same key
 * from overwriting an earlier one, and the name from being guessed. Its mtime
 * becomes `now`. Throws, leaving the record where it was, when it cannot be
 * moved. */
export declare function quarantineRecord(from: string, quarantine: Quarantine, now?: Date): SetAside;
/** Move every record of `session` into the quarantine (quarantineRecord).
 * Returns each record's old and new path and how many entries they held. */
export declare function quarantineRecords(root: string, session: string, quarantine: Quarantine, now?: Date): {
    moved: SetAside[];
    entries: number;
};
/** What forgets set aside of `session` in the quarantine at `root`, found by
 * the names quarantineRecord gives them. The part after the key holds no ".",
 * so a key that only starts like this one matches none of them. */
export declare function findSetAside(root: string, session: string): string[];
/** Delete the set-aside records whose time is up: the expiry in the name, or
 * for a name without one, `days` after its mtime. Only files named as
 * quarantineRecord names them, and a project folder only once this emptied
 * it, so a quarantine path pointed at a folder that holds anything else
 * leaves the rest alone. Returns the files deleted. */
export declare function purgeQuarantine({ root, days }: Quarantine, now?: number): string[];
/** What the model is told after a remember. */
export declare function describeRemember(result: RememberResult): string;
