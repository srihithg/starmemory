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
// itself starmemory, with a higher version, is someone else's code. It never
// starts a copy older than the newest it has started, since an older copy can
// lack a fix the newer one has.
//
// Self-contained and plain node, with node: imports only: it has to start
// whichever version is installed, before that version's dependencies exist.
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** What desktop-install records beside this file: { root, pluginsDir, follow,
 * launcherVersion, minimumVersion }, and with follow, { plugin:
 * "starmemory@<marketplace>", marketplace }. minimumVersion is the oldest
 * version this may start: the version desktop-install ran from, raised to each
 * newer one this starts. */
export const LAUNCH_CONFIG = 'launch.json';
/** This file's version, recorded in launch.json as launcherVersion. Raise it
 * with every change. A copy replaces a launcher whose files differ from its own
 * (desktop-install.mjs, refreshLauncher), but older copies go by this number
 * and leave alone a launcher recorded with one at least their own. */
export const LAUNCHER_VERSION = 2;
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
 * 0.4.0-beta.1 comes after 0.3.9 and before 0.4.0. Anything that is not a
 * version is [0, 0, 0, 0], below every one. */
export function parseVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(-[^+]+)?/.exec(String(version ?? ''));
  return match ? [Number(match[1]), Number(match[2]), Number(match[3]), match[4] ? 0 : 1] : [0, 0, 0, 0];
}

/** The version a copy's package.json gives, as written. */
export function packageVersionOf(dir) {
  const version = readJson(path.join(dir, 'package.json'))?.version;
  return typeof version === 'string' ? version : undefined;
}

function versionOf(dir) {
  return parseVersion(packageVersionOf(dir));
}

/** Negative, zero or positive as version `a` is below, the same as or above `b`. */
export function compareVersions(a, b) {
  const [va, vb] = [parseVersion(a), parseVersion(b)];
  for (let i = 0; i < va.length; i++) if (va[i] !== vb[i]) return va[i] - vb[i];
  return 0;
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

/** The runnable copies, highest version first. Of copies with the same
 * version, a prepared one comes first, then the latest installed. */
export function newestFirst(dirs) {
  const copies = [...new Set(dirs)]
    .filter(isStarmemoryRoot)
    .map((dir) => ({ dir, version: versionOf(dir), prepared: isPrepared(dir), installedAt: installedAtMs(dir) }));
  const byNewest = (a, b) => {
    for (let i = 0; i < a.version.length; i++) if (a.version[i] !== b.version[i]) return b.version[i] - a.version[i];
    return Number(b.prepared) - Number(a.prepared) || b.installedAt - a.installedAt;
  };
  return copies.sort(byNewest).map((copy) => copy.dir);
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

/** The copies the launcher may start, newest first. With `follow`, the copies
 * of starmemory from `marketplace` that Claude Code has installed, as its
 * record lists them, else as its cache holds them, and only those really in
 * that plugin's cache folder, since a recorded path can point anywhere. A
 * launch.json from before the marketplace was recorded gets it from `root`.
 * Without `follow`, or when no installed copy is left, the copy
 * desktop-install ran from. */
export function startableCopies({ root, pluginsDir, follow, marketplace }) {
  const from = follow && pluginsDir ? (marketplace ?? marketplaceOf(root, pluginsDir)) : undefined;
  if (isMarketplaceName(from)) {
    const cache = path.join(pluginsDir, 'cache', from, 'starmemory');
    const within = (dirs) => newestFirst(dirs.filter((dir) => isWithin(dir, cache)));
    const recorded = within(recordedInstallPaths(pluginsDir, from));
    const installed = recorded.length > 0 ? recorded : within(cachedCopies(pluginsDir, from));
    if (installed.length > 0) return installed;
  }
  return isStarmemoryRoot(root) ? [root] : [];
}

/** The copy to start: the newest of startableCopies, and never one below
 * launch.minimumVersion. Prepared or not: just after an update the newest
 * usually is not, so the app's first launch waits on npm install, and an older
 * copy that is ready can lack a fix the newer one has. */
export function resolvePluginRoot(launch) {
  return startableCopies(launch).find((dir) => compareVersions(packageVersionOf(dir), launch?.minimumVersion) >= 0);
}

/** Raise launch.json's minimumVersion to the version of `root`, about to be
 * started, when that is higher. Written beside and renamed in, and never a
 * reason not to start: a launch.json that cannot be written keeps the floor it
 * had. */
export function recordStarted(dir, launch, root) {
  const version = packageVersionOf(root);
  if (version === undefined || compareVersions(version, launch.minimumVersion) <= 0) return false;
  const file = path.join(dir, LAUNCH_CONFIG);
  const temp = `${file}.starmemory-${randomBytes(8).toString('hex')}.tmp`;
  try {
    const fd = fs.openSync(temp, 'wx', 0o600);
    try {
      fs.writeFileSync(fd, `${JSON.stringify({ ...launch, minimumVersion: version }, null, 2)}\n`);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temp, file);
    return true;
  } catch {
    fs.rmSync(temp, { force: true });
    return false;
  }
}

function fail(message) {
  // stderr only: stdout is the MCP channel, and the app shows stderr in its log.
  process.stderr.write(`starmemory: ${message}\n`);
  process.exit(1);
}

async function main() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // Owner-only from the first file the server writes, its store, records and
  // archive (src/owner-only.ts): the server is started in this process.
  process.umask(0o077);
  if (Number(process.versions.node.split('.')[0]) < MIN_NODE_MAJOR) {
    fail(`needs Node ${MIN_NODE_MAJOR} or newer, but the Claude app started ${process.execPath} (${process.version}). Install a newer Node, then quit and reopen the app.`);
  }
  const launch = readJson(path.join(here, LAUNCH_CONFIG)) ?? {};
  const root = resolvePluginRoot(launch);
  if (!root && startableCopies(launch).length > 0) {
    fail(`every installed copy of starmemory is older than ${launch.minimumVersion}, the oldest version the Claude app may start. Update it in Claude Code (claude plugin update starmemory), or run desktop-install from the copy to start, then quit and reopen the Claude app.`);
  }
  if (!root) {
    fail('no installed copy of starmemory was found. Install it in Claude Code again (claude plugin install starmemory) or run desktop-install from a copy, then quit and reopen the Claude app.');
  }
  recordStarted(here, launch, root);
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
