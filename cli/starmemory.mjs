#!/usr/bin/env node
// CLI entry point, and the one the SessionStart hook calls.
//
// `--background` really backgrounds now. Claude Code waits for a SessionStart
// hook to exit, and a first sync with a real embedding model takes tens of
// seconds, so the hook process forks the work into a detached child and
// returns at once -- the same shape episodic-memory uses. The child writes to
// a log file instead of the hook's stdio, which Claude Code would otherwise
// capture into the session.
// A summarizer child (Claude Agent SDK or codex app-server) fires SessionStart,
// whose hook is this very command. Without this exit, sync would summarise,
// which starts a child, which runs sync... Keep in step with summarizerEnv()
// in src/summarizer-claude.ts. Checked before anything else, even the
// dependency install, so the child costs nothing.
if (process.env.STARMEMORY_SUMMARIZER_GUARD === '1') process.exit(0);

// Owner-only from the first file this writes, and in every process it starts,
// which inherits the mask: the log, the sync's store and archive
// (src/owner-only.ts).
process.umask(0o077);

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureReady, handOff } from './bootstrap.mjs';

const args = process.argv.slice(2);
const background = args.includes('--background');
const detached = args.includes('--detached');

// Registering with the Claude desktop app runs before the dependency install:
// it is plain node, and it is often the first thing run from a fresh copy
// (README, "Use it in Cowork"). It installs the dependencies itself, for the
// copy the app will start.
if (args[0] === 'desktop-install') {
  const { main } = await import('./desktop-install.mjs');
  process.exit(await main(args.slice(1)));
}

export function syncLogPath() {
  return process.env.STARMEMORY_LOG_PATH ?? path.join(os.homedir(), '.config', 'starmemory', 'sync.log');
}

/** Past this, sync.log moves to sync.log.1, replacing the one before, so the
 * two together stay near twice this. */
export const LOG_MAX_BYTES = 1024 * 1024;

function openLog(log) {
  fs.mkdirSync(path.dirname(log), { recursive: true, mode: 0o700 });
  const fd = fs.openSync(log, 'a', 0o600);
  try {
    fs.fchmodSync(fd, 0o600); // a log an earlier version made readable to all
  } catch {
    // a file system without modes, or not a file of this account's
  }
  return fd;
}

if (background && !detached) {
  const log = syncLogPath();
  let fd = openLog(log);
  try {
    if (fs.fstatSync(fd).size >= LOG_MAX_BYTES) {
      // Renamed while open, so the old log keeps the owner-only mode just set.
      fs.renameSync(log, `${log}.1`);
      const fresh = openLog(log);
      fs.closeSync(fd);
      fd = fresh;
    }
  } catch {
    // keep writing to the log as it is
  }
  fs.writeSync(fd, `[${new Date().toISOString()}] pid ${process.pid}: starting detached sync\n`);
  const child = spawn(
    process.execPath,
    [fileURLToPath(import.meta.url), ...args.filter((a) => a !== '--background'), '--detached'],
    // windowsHide: a detached child on Windows would otherwise open a console
    // window that flashes on every session start.
    { detached: true, stdio: ['ignore', fd, fd], windowsHide: true }
  );
  child.unref();
  process.exit(0);
}

// From here on we are either an interactive invocation or the detached child.
const quiet = detached;
if (!(await ensureReady({ quiet }))) {
  process.exit(quiet ? 0 : 1);
}

// The detached child's stdout is the log file, so it runs the plain command:
// the summary line ("Scanned N files, ...") is exactly what belongs in the log.
// `--detached` goes along, since a detached sync may wait where an interactive
// one should not (src/cli.ts). It also has no stdin to watch -- see handOff.
handOff('dist/cli.js', args, { watchStdin: !detached });
