// Time to live for a conversation: once nothing has been said in it for
// STARMEMORY_TTL_DAYS (180 by default), it leaves the memory for good. The
// rows and vector in LMDB, its documents in the text index, the archive copy
// and the summary all go together, so a search never returns something that
// cannot be opened. A copy no row points at, of a transcript that never had a
// whole exchange, goes by its own age, and a partial copy a crashed sync left
// goes after a day. Design doc archive-and-summaries §13.
import fs from 'node:fs';
import path from 'node:path';
import { ARCHIVE_SUFFIX, archivePathFor, summaryPathFor } from './archive.js';
import { deleteExchanges, exchangesFrom, type StoreHandle } from './store.js';
import type { TextIndex } from './text-index.js';
import type { ConversationExchange, Harness } from './types.js';

export const DEFAULT_TTL_DAYS = 180;
const DAY_MS = 24 * 60 * 60 * 1000;

/** `STARMEMORY_TTL_DAYS`; 0 (or a non-number) disables expiry. */
export function defaultTtlDays(env: NodeJS.ProcessEnv = process.env): number {
  if (env.STARMEMORY_TTL_DAYS === undefined) return DEFAULT_TTL_DAYS;
  const days = Number(env.STARMEMORY_TTL_DAYS);
  return Number.isFinite(days) && days > 0 ? days : 0;
}

export function ttlCutoffMs(ttlDays: number, now = Date.now()): number {
  return now - ttlDays * DAY_MS;
}

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

/** When the conversation was last written to: the archive copy's mtime (kept
 * equal to the source's), or, for rows stored before the archive existed and
 * whose source is gone, the newest exchange timestamp. */
function lastActivityMs(group: ConversationGroup, archiveRoot: string): number {
  const copy = archivePathFor(archiveRoot, group.harness, group.project, group.archivePath);
  for (const candidate of [copy, group.archivePath]) {
    try {
      return fs.statSync(candidate).mtimeMs;
    } catch {
      // try the next
    }
  }
  return group.latestTimestampMs;
}

export function groupByFile(rows: ConversationExchange[]): ConversationGroup[] {
  const groups = new Map<string, ConversationGroup>();
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
export function removeConversations(
  store: StoreHandle,
  textIndex: TextIndex | undefined,
  groups: ConversationGroup[],
  {
    archiveRoot,
    log = () => {},
    describe,
    onRemoved,
  }: { archiveRoot: string; log?: (line: string) => void; describe: (g: ConversationGroup) => string; onRemoved?: (g: ConversationGroup) => void }
): RemoveResult {
  const result: RemoveResult = { rows: 0, files: 0, skipped: false };
  if (groups.length === 0) return result;

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
        } catch (error) {
          // An old root on a disk now read-only, say. The rows are gone
          // already, and their text-index documents must still go.
          log(`starmemory: could not remove ${file}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      onRemoved?.(g);
      result.files++;
      log(`starmemory: ${describe(g)}`);
    }
  } finally {
    // Whatever went wrong, the documents of the rows already deleted go too:
    // no later sync could find them, with no rows left to point at them.
    textIndex?.commit();
  }
  return result;
}

/** The files in the archive's <harness>/<project>/ folders whose names
 * `wanted` picks. Only real folders and plain files: a link is never followed. */
function archiveFiles(archiveRoot: string, wanted: (name: string) => boolean): string[] {
  const entries = (dir: string): fs.Dirent[] => {
    try {
      return fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return [];
    }
  };
  const found: string[] = [];
  for (const harness of entries(archiveRoot).filter((e) => e.isDirectory())) {
    for (const project of entries(path.join(archiveRoot, harness.name)).filter((e) => e.isDirectory())) {
      const dir = path.join(archiveRoot, harness.name, project.name);
      for (const file of entries(dir)) if (file.isFile() && wanted(file.name)) found.push(path.join(dir, file.name));
    }
  }
  return found;
}

/** A copy copyIfChanged was writing when its sync stopped. */
const PARTIAL_COPY = /\.jsonl\.gz\.\d+\.\d+\.tmp$/;

/** Delete the partial copies a crashed sync left, once nothing has touched
 * them for a day. By the inode's change time, since copyIfChanged gives a
 * copy its source's mtime just before renaming it in. */
function sweepPartialCopies(archiveRoot: string, now: number, log: (line: string) => void): void {
  for (const partial of archiveFiles(archiveRoot, (name) => PARTIAL_COPY.test(name))) {
    try {
      const { ctimeMs, mtimeMs } = fs.lstatSync(partial);
      if (now - Math.max(ctimeMs, mtimeMs) < DAY_MS) continue;
      fs.rmSync(partial, { force: true });
      log(`starmemory: deleted ${partial}, a partial copy a sync left a day or more ago`);
    } catch {
      // gone already
    }
  }
}

/** Delete, with its summary, every archive copy that no row points at and
 * whose own mtime, the transcript's last write, is past the TTL: a transcript
 * that never had a whole exchange has no rows, so nothing else ever would. */
function expireUnreferencedCopies(
  groups: ConversationGroup[],
  { archiveRoot, cutoff, ttlDays, log }: { archiveRoot: string; cutoff: number; ttlDays: number; log: (line: string) => void }
): number {
  const referenced = new Set(groups.flatMap((g) => [g.archivePath, archivePathFor(archiveRoot, g.harness, g.project, g.archivePath)].map((p) => path.resolve(p))));
  let removed = 0;
  for (const copy of archiveFiles(archiveRoot, (name) => name.endsWith(`.jsonl${ARCHIVE_SUFFIX}`))) {
    if (referenced.has(path.resolve(copy))) continue;
    try {
      if (fs.lstatSync(copy).mtimeMs >= cutoff) continue;
      for (const file of [copy, summaryPathFor(copy)]) fs.rmSync(file, { force: true });
    } catch {
      continue;
    }
    removed++;
    log(`starmemory: expired ${copy} (no exchanges, quiet for more than ${ttlDays} days)`);
  }
  return removed;
}

/** Remove every conversation whose last activity is older than the TTL, and
 * the archive files nothing keeps: copies no row points at, past the TTL by
 * their own age, and partial copies a crashed sync left, whatever the TTL. */
export function expireOldConversations(
  store: StoreHandle,
  textIndex: TextIndex | undefined,
  { ttlDays = defaultTtlDays(), now = Date.now(), archiveRoot, log = () => {} }: ExpireOptions
): ExpireResult {
  sweepPartialCopies(archiveRoot, now, log);
  if (ttlDays <= 0) return { rows: 0, files: 0, skipped: false };
  const cutoff = ttlCutoffMs(ttlDays, now);
  const groups = groupByFile(exchangesFrom(store, 0));
  const expired = groups.filter((g) => lastActivityMs(g, archiveRoot) < cutoff);
  const result = removeConversations(store, textIndex, expired, {
    archiveRoot,
    log,
    describe: (g) => `expired ${g.archivePath} (${g.ids.length} exchanges, quiet for more than ${ttlDays} days)`,
  });
  // No text-index documents to go with these, so no writer is needed.
  result.files += expireUnreferencedCopies(groups, { archiveRoot, cutoff, ttlDays, log });
  return result;
}
