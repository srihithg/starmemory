// Starting a sync from a tool call. `remember` wants its entry searchable now,
// not at the next session start, which for Cowork never comes on this machine:
// Cowork's SessionStart hook runs in the cloud container, where it is skipped.
//
// The sync is the same detached process the hook starts, never work done in
// the MCP server itself. Indexing needs the text-index writer, and tantivy
// holds that until the handle is dropped, so a long-lived server that took it
// once would lock every later sync out of the BM25 index.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** cli/starmemory.mjs. dist/ and src/ sit at the same depth, so this resolves
 * from either. */
export const CLI_ENTRY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'cli', 'starmemory.mjs');

/** Whether this copy can still start a sync. A long-running server can outlive
 * its own files: a plugin update installs a new copy, and Claude Code later
 * removes the old one the server started from. */
export function canStartSync(entry: string = CLI_ENTRY): boolean {
  return fs.existsSync(entry);
}

/** `starmemory sync --background --cowork-only`: the hook's detached sync,
 * whose output goes to sync.log, forked and left. Its stdio is ignored, never
 * inherited: the server's stdout is the MCP channel. It is here to index an
 * entry or carry out a forget, so it walks only the Cowork records, not every
 * Claude Code and Codex transcript (which sync parses whole each time, and a
 * Claude Code turn caught halfway would be stored twice), and it writes no
 * summaries, which a burst of calls would otherwise start a round of model
 * calls for each time. Deleting forgotten sessions covers the whole store
 * either way. The session-start sync does the rest. Returns false when this
 * copy is gone and nothing was started. */
export function spawnBackgroundSync(entry: string = CLI_ENTRY): boolean {
  if (!canStartSync(entry)) {
    process.stderr.write(`starmemory: cannot start a background sync, ${entry} is gone; restart the Claude app to run the current copy\n`);
    return false;
  }
  const child = spawn(process.execPath, [entry, 'sync', '--background', '--cowork-only'], {
    stdio: 'ignore',
    windowsHide: true,
    env: { ...process.env, STARMEMORY_SUMMARY_LIMIT: '0' },
  });
  child.on('error', (error) => process.stderr.write(`starmemory: could not start a background sync: ${error.message}\n`));
  child.unref();
  return true;
}

export interface SyncTriggerOptions {
  start?: () => unknown;
  intervalMs?: number;
  /** Milliseconds on a clock that only moves forward; performance.now() by
   * default. With the wall clock, setting the time back an hour would hold
   * every sync for that hour. */
  now?: () => number;
  setTimer?: (callback: () => void, ms: number) => { unref?: () => void };
}

/** At most one sync per interval. The first request starts one at once;
 * requests inside the interval share a single sync at its end. Every sync loads
 * the embedding model, so a burst of remember calls costs two syncs, not one
 * each. */
export function createSyncTrigger({
  start = spawnBackgroundSync,
  intervalMs = 5000,
  now = () => performance.now(),
  setTimer = setTimeout,
}: SyncTriggerOptions = {}): () => void {
  let last = Number.NEGATIVE_INFINITY;
  let pending = false;
  return () => {
    if (pending) return;
    const wait = last + intervalMs - now();
    if (wait <= 0) {
      last = now();
      start();
      return;
    }
    pending = true;
    // unref: a server that is shutting down should not linger for this. The
    // entry is on disk, and the next sync, from any trigger, indexes it.
    setTimer(() => {
      pending = false;
      last = now();
      start();
    }, wait).unref?.();
  };
}
