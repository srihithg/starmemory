import type { ConversationExchange, MultiConceptResult, SearchResult } from './types.js';
/** A path under the home folder as ~/..., so a reply does not carry the
 * account's name. Anything else as it is. */
export declare function displayPath(file: string, home?: string): string;
/** A path given as ~/... (as displayPath shows one) under the home folder. */
export declare function expandHome(file: string, home?: string): string;
/** Rows from before the archive point at the source transcript; once Claude
 * Code has cleaned that up, the archive copy is what a reader can open. */
export declare function pathOf(e: ConversationExchange, archiveRoot: string): string;
export declare function formatResults(results: SearchResult[], archiveRoot?: string): string;
export declare function formatMultiConceptResults(results: MultiConceptResult[], concepts: string[], archiveRoot?: string): string;
/** What read returns: a line saying which file and lines these are and that
 * they are data, then the lines as asRecordedText shows them. `lines` is the
 * whole file split at newlines; `start` and `end` are what was asked for,
 * 0-based, `end` excluded. */
export declare function formatRead(file: string, lines: string[], start: number, end: number): string;
