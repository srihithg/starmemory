// Time to live for a conversation: once nothing has been said in it for
// STARMEMORY_TTL_DAYS (180 by default), it leaves the memory for good. The
// rows and vector in LMDB, its documents in the text index, the archive copy
// and the summary all go together, so a search never returns something that
// cannot be opened. Design doc archive-and-summaries §13.
import fs from 'node:fs';
import { ARCHIVE_SUFFIX, archivePathFor, summaryPathFor } from './archive.js';
import { deleteExchanges, exchangesFrom } from './store.js';
export const DEFAULT_TTL_DAYS = 180;
const DAY_MS = 24 * 60 * 60 * 1000;
/** `STARMEMORY_TTL_DAYS`; 0 (or a non-number) disables expiry. */
export function defaultTtlDays(env = process.env) {
    if (env.STARMEMORY_TTL_DAYS === undefined)
        return DEFAULT_TTL_DAYS;
    const days = Number(env.STARMEMORY_TTL_DAYS);
    return Number.isFinite(days) && days > 0 ? days : 0;
}
export function ttlCutoffMs(ttlDays, now = Date.now()) {
    return now - ttlDays * DAY_MS;
}
/** When the conversation was last written to: the archive copy's mtime (kept
 * equal to the source's), or, for rows stored before the archive existed and
 * whose source is gone, the newest exchange timestamp. */
function lastActivityMs(group, archiveRoot) {
    const copy = archivePathFor(archiveRoot, group.harness, group.project, group.archivePath);
    for (const candidate of [copy, group.archivePath]) {
        try {
            return fs.statSync(candidate).mtimeMs;
        }
        catch {
            // try the next
        }
    }
    return group.latestTimestampMs;
}
export function groupByFile(rows) {
    const groups = new Map();
    for (const r of rows) {
        const g = groups.get(r.archivePath) ?? {
            archivePath: r.archivePath,
            harness: r.harness ?? 'claude',
            project: r.project,
            ids: [],
            latestTimestampMs: 0,
        };
        g.ids.push(r.id);
        g.latestTimestampMs = Math.max(g.latestTimestampMs, Date.parse(r.timestamp) || 0);
        groups.set(r.archivePath, g);
    }
    return [...groups.values()];
}
/** Remove whole conversations everywhere: the rows and their vectors, their
 * text-index documents, the archive copy and its summary, so a search never
 * returns something that cannot be opened. Holds the text writer for the
 * duration when a text index is given; if another process has it, nothing is
 * removed this run and the next sync tries again. Shared by the TTL and by
 * forgetting a session (src/forget.ts). */
export function removeConversations(store, textIndex, groups, { archiveRoot, log = () => { }, describe, onRemoved, }) {
    const result = { rows: 0, files: 0, skipped: false };
    if (groups.length === 0)
        return result;
    if (textIndex && !textIndex.tryAcquireWriter()) {
        result.skipped = true;
        return result;
    }
    try {
        for (const g of groups) {
            result.rows += deleteExchanges(store, g.ids);
            textIndex?.deleteExchanges(g.ids);
            const copy = archivePathFor(archiveRoot, g.harness, g.project, g.archivePath);
            // The copy the rows point at goes too, when it is not the one under the
            // current archive root (STARMEMORY_ARCHIVE_PATH moved). A `.gz` is always
            // a copy of ours; rows from before the archive point at the transcript,
            // which is never touched.
            const pointed = g.archivePath.endsWith(ARCHIVE_SUFFIX) ? [g.archivePath, summaryPathFor(g.archivePath)] : [];
            for (const file of new Set([copy, summaryPathFor(copy), ...pointed])) {
                try {
                    fs.rmSync(file, { force: true });
                }
                catch (error) {
                    // An old root on a disk now read-only, say. The rows are gone
                    // already, and their text-index documents must still go.
                    log(`starmemory: could not remove ${file}: ${error instanceof Error ? error.message : String(error)}`);
                }
            }
            onRemoved?.(g);
            result.files++;
            log(`starmemory: ${describe(g)}`);
        }
    }
    finally {
        // Whatever went wrong, the documents of the rows already deleted go too:
        // no later sync could find them, with no rows left to point at them.
        textIndex?.commit();
    }
    return result;
}
/** Remove every conversation whose last activity is older than the TTL. */
export function expireOldConversations(store, textIndex, { ttlDays = defaultTtlDays(), now = Date.now(), archiveRoot, log = () => { } }) {
    if (ttlDays <= 0)
        return { rows: 0, files: 0, skipped: false };
    const cutoff = ttlCutoffMs(ttlDays, now);
    const expired = groupByFile(exchangesFrom(store, 0)).filter((g) => lastActivityMs(g, archiveRoot) < cutoff);
    return removeConversations(store, textIndex, expired, {
        archiveRoot,
        log,
        describe: (g) => `expired ${g.archivePath} (${g.ids.length} exchanges, quiet for more than ${ttlDays} days)`,
    });
}
