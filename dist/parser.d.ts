import type { Harness, ParsedExchange } from './types.js';
/** The promptSource of a Cowork record's user line. The model wrote it, as its
 * account of what the user asked, so it is kept as written like a typed prompt,
 * and the exchange is marked as a note (coworkNote) rather than taken for the
 * user's own words. Records written before this carry `typed`. */
export declare const COWORK_RECORD_PROMPT_SOURCE = "cowork_record";
/** The `<` of every opening or closing tag an injected block is made of: the
 * markers above, the tags inside them that payloadOfInjectedTurn reads, and
 * the other tags Claude Code wraps a hook's or a command's text in, a `!`
 * command's input and output and a `#` memory among them. Space after the
 * `<`, before or after a `/`, still counts. What a model writes into a Cowork
 * record has these escaped (src/cowork.ts), so a note can never pass for a
 * block the harness injected. */
export declare const INJECTED_TAG_START: RegExp;
export declare function isInjectedUserTurn(entry: {
    promptSource?: string;
    isMeta?: boolean;
}, text: string): boolean;
/** The part of an injected block worth indexing. Returns '' when there is none,
 * which is the honest answer for a system reminder: it is an instruction to the
 * model, not something anyone would search for. */
export declare function payloadOfInjectedTurn(text: string): string;
/** The first line of every Cowork record, and the only thing that tells one
 * apart from a Claude Code transcript: the lines after it are the same shape. */
export declare const COWORK_SESSION_LINE_TYPE = "cowork_session";
/** Reads the first parseable line and decides which format the file is in.
 * Unknown or empty files are read as Claude, the format that existed first.
 * Works on an archive copy too, since openArchive undoes the gzip. */
export declare function detectHarness(filePath: string): Promise<Harness>;
/** The sessions a transcript's or archive copy's file name says it holds:
 * the name itself, which is the session for Claude Code and Cowork, and for
 * a Codex rollout the id its name ends in. */
export declare function sessionsOfName(filePath: string): string[];
/** The sessions a transcript or archive copy belongs to, given its text:
 * what its name says (sessionsOfName) and every id any of its lines
 * records, so a session that joins a file late is found as well as the one
 * it starts with. */
export declare function sessionIdsOf(filePath: string, text: string): Set<string>;
/** `sessions`, when given, gets every session id the file's lines record
 * (sessionIdsOf), those of lines that make no exchange included, from the
 * same read. */
export declare function parseConversation(filePath: string, project: string, archivePath: string, sessions?: Set<string>): Promise<ParsedExchange[]>;
/** Every .jsonl file under `dir`, at any depth, leaving out the folder `skip`
 * and everything in it. A missing folder yields nothing. */
export declare function walkJsonlFiles(dir: string, skip?: string): Generator<string>;
/** Derives a project name the same way episodic-memory does: the JSONL file's
 * parent directory name (Claude Code's sanitized-cwd slug). */
export declare function projectFromPath(filePath: string): string;
