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
// without running desktop-install again. It looks only at copies of the plugin
// desktop-install ran from, starmemory@<marketplace>: another plugin that calls
// itself starmemory, with a higher version, is someone else's code.
//
// Self-contained and plain node, with node: imports only: it has to start
// whichever version is installed, before that version's dependencies exist.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** What desktop-install records beside this file: { root, pluginsDir, follow,
 * launcherVersion }, and with follow, { plugin: "starmemory@<marketplace>",
 * marketplace }. */
export const LAUNCH_CONFIG = 'launch.json';
/** This file's version, recorded in launch.json as launcherVersion. Raise it
 * with any change a launcher copied already should get: the MCP server of a
 * newer plugin, started by a launcher recorded with a lower one or none, copies
 * this file over it. */
export const LAUNCHER_VERSION = 1;
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

function realpathOf(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return undefined;
  }
}

/** Whether `dir`, through any link, is somewhere under `parent`. */
function isWithin(dir, parent) {
  const [child, base] = [realpathOf(dir), realpathOf(parent)];
  if (!child || !base) return false;
  const relative = path.relative(base, child);
  return relative !== '' && relative.split(path.sep)[0] !== '..' && !path.isAbsolute(relative);
}

/** [major, minor, patch, 1 for a release or 0 for a prerelease], so that
 * 0.4.0-beta.1 comes after 0.3.9 and before 0.4.0. */
function versionOf(dir) {
  const match = /^(\d+)\.(\d+)\.(\d+)(-[^+]+)?/.exec(String(readJson(path.join(dir, 'package.json'))?.version ?? ''));
  return match ? [Number(match[1]), Number(match[2]), Number(match[3]), match[4] ? 0 : 1] : [0, 0, 0, 0];
}

function installedAtMs(dir) {
  try {
    return fs.statSync(path.join(dir, 'package.json')).mtimeMs;
  } catch {
    return 0;
  }
}

/** Whether the copy can start without installing anything first, by the test
 * cli/bootstrap.mjs ensureReady applies: this platform's addon is there, and so
 * is each dependency's package.json. The dependencies are the copy's own, from
 * its package.json, since this file cannot import its install-check.mjs. */
export function isPrepared(dir) {
  const dependencies = Object.keys(readJson(path.join(dir, 'package.json'))?.dependencies ?? {});
  return (
    fs.existsSync(path.join(dir, 'native', `starmemory_native.${process.platform}-${process.arch}.node`)) &&
    dependencies.every((name) => fs.existsSync(path.join(dir, 'node_modules', ...name.split('/'), 'package.json')))
  );
}

/** The runnable copies, highest version first, the latest installed first on
 * a tie. */
export function newestFirst(dirs) {
  const byNewest = (a, b) => {
    const [va, vb] = [versionOf(a), versionOf(b)];
    for (let i = 0; i < va.length; i++) if (va[i] !== vb[i]) return vb[i] - va[i];
    return installedAtMs(b) - installedAtMs(a);
  };
  return [...new Set(dirs)].filter(isStarmemoryRoot).sort(byNewest);
}

/** A marketplace name that is one folder name and nothing else. */
function isMarketplaceName(name) {
  return typeof name === 'string' && name !== '' && name !== '.' && name !== '..' && !/[\\/]/.test(name);
}

/** The marketplace a copy at `root` was installed from, when it is one of
 * Claude Code's: <pluginsDir>/cache/<marketplace>/starmemory/<version>/ or
 * the marketplace's own clone, <pluginsDir>/marketplaces/<marketplace>/.
 * Otherwise undefined. */
export function marketplaceOf(root, pluginsDir) {
  // A root that is gone, an old version Claude Code has since removed, is
  // taken as written.
  const copy = realpathOf(root) ?? path.resolve(root);
  for (const plugins of new Set([realpathOf(pluginsDir), path.resolve(pluginsDir)])) {
    if (!plugins) continue;
    const parts = path.relative(plugins, copy).split(path.sep);
    const marketplace =
      parts.length === 4 && parts[0] === 'cache' && parts[2] === 'starmemory' ? parts[1]
      : parts.length === 2 && parts[0] === 'marketplaces' ? parts[1]
      : undefined;
    if (isMarketplaceName(marketplace)) return marketplace;
  }
  return undefined;
}

/** Every installPath Claude Code's installed_plugins.json records for
 * starmemory@<marketplace>. The file has had several shapes, so this finds that
 * key wherever it sits and takes each installPath under it. */
export function recordedInstallPaths(pluginsDir, marketplace) {
  const plugin = `starmemory@${marketplace}`;
  const found = [];
  const collect = (node) => {
    if (Array.isArray(node)) {
      node.forEach(collect);
    } else if (node && typeof node === 'object') {
      if (typeof node.installPath === 'string') found.push(node.installPath);
      Object.values(node).forEach(collect);
    }
  };
  const visit = (node) => {
    if (Array.isArray(node)) {
      node.forEach(visit);
    } else if (node && typeof node === 'object') {
      for (const [key, value] of Object.entries(node)) (key === plugin ? collect : visit)(value);
    }
  };
  visit(readJson(path.join(pluginsDir, 'installed_plugins.json')));
  return found;
}

/** <pluginsDir>/cache/<marketplace>/starmemory/<version>/, for when that record
 * cannot be read. */
export function cachedCopies(pluginsDir, marketplace) {
  const plugin = path.join(pluginsDir, 'cache', marketplace, 'starmemory');
  return listDir(plugin).map((version) => path.join(plugin, version));
}

/** The copy to start. With `follow`, the newest copy of starmemory from
 * `marketplace` that Claude Code has installed, as its record lists them, else
 * as its cache holds them, and only one really in that plugin's cache folder,
 * since a recorded path can point anywhere. A launch.json from before the
 * marketplace was recorded gets it from `root`. Without `follow`, or when no
 * installed copy is left, the copy desktop-install ran from. */
export function resolvePluginRoot({ root, pluginsDir, follow, marketplace }) {
  const from = follow && pluginsDir ? (marketplace ?? marketplaceOf(root, pluginsDir)) : undefined;
  if (isMarketplaceName(from)) {
    const cache = path.join(pluginsDir, 'cache', from, 'starmemory');
    // A prepared one first: just after an update the newest usually is not,
    // and the app's first launch would wait on npm install.
    const pick = (dirs) => {
      const copies = newestFirst(dirs.filter((dir) => isWithin(dir, cache)));
      return copies.find(isPrepared) ?? copies[0];
    };
    const installed = pick(recordedInstallPaths(pluginsDir, from)) ?? pick(cachedCopies(pluginsDir, from));
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
