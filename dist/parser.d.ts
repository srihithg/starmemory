import type { Harness, ParsedExchange } from './types.js';
/** The promptSource of a Cowork record's user line. The model wrote it, as its
 * account of what the user asked, so it is kept as written like a typed prompt,
 * and the exchange is marked as a note (coworkNote) rather than taken for the
 * user's own words. Records written before this carry `typed`. */
export declare const COWORK_RECORD_PROMPT_SOURCE = "cowork_record";
/** The `<` of every opening or closing tag an injected block is made of: the
 * markers above and the tags inside them that payloadOfInjectedTurn reads.
 * What a model writes into a Cowork record has these escaped (src/cowork.ts),
 * so a note can never pass for a block the harness injected. */
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
/** The sessions a transcript or archive copy belongs to: its file name, which
 * is the id for Claude Code and Cowork, and the ids its first lines record
 * (sessionIdsInLines). `text`, when the caller has the file's text already. */
export declare function sessionIdsOf(filePath: string, text?: string): Promise<Set<string>>;
export declare function parseConversation(filePath: string, project: string, archivePath: string): Promise<ParsedExchange[]>;
/** Derives a project name the same way episodic-memory does: the JSONL file's
 * parent directory name (Claude Code's sanitized-cwd slug). */
export declare function projectFromPath(filePath: string): string;
