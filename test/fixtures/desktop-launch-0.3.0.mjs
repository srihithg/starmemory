#!/usr/bin/env node
// The launcher the Claude desktop app runs for starmemory. `starmemory
// desktop-install` (cli/desktop-install.mjs) copies it into
// ~/.config/starmemory/desktop/, a folder that never moves, and names that copy
// in the app's config.
//
// The plugin's own folder does move: Claude Code installs each version under
// ~/.claude/plugins/cache/<marketplace>/starmemory/<version>/ and marks the one
// it replaced as orphaned. A config entry naming that folder would break at the
// first update. So on every launch this finds the newest copy Claude Code has
// installed and starts that copy's MCP server, and an update reaches Cowork
// without running desktop-install again.
//
// Self-contained and plain node, with node: imports only: it has to start
// whichever version is installed, before that version's dependencies exist.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** What desktop-install records beside this file: { root, pluginsDir, follow }. */
export const LAUNCH_CONFIG = 'launch.json';
export const MIN_NODE_MAJOR = 22;

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

function listDir(dir) {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

/** A folder holding a runnable starmemory that Claude Code has not orphaned. */
export function isStarmemoryRoot(dir) {
  return (
    typeof dir === 'string' &&
    readJson(path.join(dir, 'package.json'))?.name === 'starmemory' &&
    fs.existsSync(path.join(dir, 'cli', 'mcp-server.mjs')) &&
    !fs.existsSync(path.join(dir, '.orphaned_at'))
  );
}

function versionOf(dir) {
  const parts = String(readJson(path.join(dir, 'package.json'))?.version ?? '')
    .split('.')
    .slice(0, 3)
    .map((part) => Number.parseInt(part, 10));
  return parts.length === 3 && parts.every(Number.isFinite) ? parts : [0, 0, 0];
}

function installedAtMs(dir) {
  try {
    return fs.statSync(path.join(dir, 'package.json')).mtimeMs;
  } catch {
    return 0;
  }
}

/** The runnable copy with the highest version, the latest installed on a tie. */
export function newest(dirs) {
  const byNewest = (a, b) => {
    const [va, vb] = [versionOf(a), versionOf(b)];
    for (let i = 0; i < 3; i++) if (va[i] !== vb[i]) return vb[i] - va[i];
    return installedAtMs(b) - installedAtMs(a);
  };
  return [...new Set(dirs)].filter(isStarmemoryRoot).sort(byNewest)[0];
}

/** Every installPath in Claude Code's installed_plugins.json. Collected from
 * wherever they sit, not from one record shape: the file has had several. */
export function recordedInstallPaths(pluginsDir) {
  const found = [];
  const visit = (node) => {
    if (Array.isArray(node)) {
      node.forEach(visit);
    } else if (node && typeof node === 'object') {
      if (typeof node.installPath === 'string') found.push(node.installPath);
      Object.values(node).forEach(visit);
    }
  };
  visit(readJson(path.join(pluginsDir, 'installed_plugins.json')));
  return found;
}

/** <pluginsDir>/cache/<marketplace>/starmemory/<version>/, for when that record
 * cannot be read. */
export function cachedCopies(pluginsDir) {
  const cache = path.join(pluginsDir, 'cache');
  return listDir(cache).flatMap((marketplace) => {
    const plugin = path.join(cache, marketplace, 'starmemory');
    return listDir(plugin).map((version) => path.join(plugin, version));
  });
}

/** The copy to start. With `follow`, the newest one Claude Code has installed,
 * as its record lists them, else as its cache holds them. Without, or when no
 * installed copy is left, the copy desktop-install ran from. */
export function resolvePluginRoot({ root, pluginsDir, follow }) {
  if (follow && pluginsDir) {
    const installed = newest(recordedInstallPaths(pluginsDir)) ?? newest(cachedCopies(pluginsDir));
    if (installed) return installed;
  }
  return isStarmemoryRoot(root) ? root : undefined;
}

function fail(message) {
  // stderr only: stdout is the MCP channel, and the app shows stderr in its log.
  process.stderr.write(`starmemory: ${message}\n`);
  process.exit(1);
}

async function main() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  if (Number(process.versions.node.split('.')[0]) < MIN_NODE_MAJOR) {
    fail(`needs Node ${MIN_NODE_MAJOR} or newer, but the Claude app started ${process.execPath} (${process.version}). Install a newer Node, then quit and reopen the app.`);
  }
  const root = resolvePluginRoot(readJson(path.join(here, LAUNCH_CONFIG)) ?? {});
  if (!root) {
    fail('no installed copy of starmemory was found. Install it in Claude Code again (claude plugin install starmemory) or run desktop-install from a copy, then quit and reopen the Claude app.');
  }
  process.stderr.write(`starmemory: starting the MCP server from ${root}\n`);
  // In this process, not a child: cli/mcp-server.mjs installs what is missing
  // and hands off to dist/, forwarding signals and watching stdin as it does
  // for Claude Code.
  await import(pathToFileURL(path.join(root, 'cli', 'mcp-server.mjs')).href);
}

function isMainModule() {
  try {
    return process.argv[1] !== undefined && pathToFileURL(fs.realpathSync(process.argv[1])).href === import.meta.url;
  } catch {
    return false;
  }
}

if (isMainModule()) await main();
