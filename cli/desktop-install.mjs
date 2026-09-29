// `starmemory desktop-install`: register this MCP server with the Claude
// desktop app, which is how Cowork reaches it.
//
// Cowork runs each session in a cloud container, and plugin MCP servers do not
// start there. What a Cowork session can reach are the local servers the
// desktop app on this computer runs from claude_desktop_config.json; they show
// up in the session as mcp__remote-devices__<name>__<tool>. `claude mcp add`
// configures Claude Code only, so it does not help.
//
// The config holds other servers' settings, credentials among them, so this
// changes only its own entry, backs the file up first, writes it whole or not
// at all, and prints server names and nothing else from it. The app can
// overwrite edits made while it is running, so this refuses to edit while it
// runs, unless --restart has it quit the app first and reopen it after.
//
// Plain node, node: imports only: this runs from a fresh plugin copy, before
// its dependencies are installed.
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { LAUNCH_CONFIG, MIN_NODE_MAJOR, marketplaceOf, resolvePluginRoot } from './desktop-launch.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Not "starmemory". The app refuses a local server whose name collides with
 * one it reserves for its own tools, and does not publish the list: it refused
 * "cowork-episodic-memory" and accepted "episode-archive". So the default
 * steers clear of "cowork", "claude" and "memory"; --name picks another. */
export const DEFAULT_SERVER_NAME = 'starmemserver';
const SERVER_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export const USAGE = `Usage: starmemory desktop-install [--name <name>] [--replace] [--restart] [--config <file>] [--no-prepare]

Registers starmemory's MCP server with the Claude desktop app, so Cowork sessions
can search, read, remember and forget.

  --name <name>   server name in the app (default: ${DEFAULT_SERVER_NAME}); pick another if the
                  app says the name collides with a reserved internal server name
  --replace       let --name take over an entry of that name that is not starmemory's
  --restart       quit the Claude app, make the change, and open it again (macOS)
  --config <file> edit this config file instead of the app's own
  --no-prepare    do not install starmemory's dependencies now; the first launch does`;

export class UsageError extends Error {}
export class InvalidConfigError extends Error {}

function homeOf(env) {
  return env.HOME ?? env.USERPROFILE ?? os.homedir();
}

/** Where the app keeps its config. Linux has no official app; ~/.config/Claude
 * is where the community builds look. */
export function desktopConfigPath(env = process.env, platform = process.platform) {
  const home = homeOf(env);
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
  if (platform === 'win32') return path.join(env.APPDATA ?? path.join(home, 'AppData', 'Roaming'), 'Claude', 'claude_desktop_config.json');
  return path.join(env.XDG_CONFIG_HOME ?? path.join(home, '.config'), 'Claude', 'claude_desktop_config.json');
}

/** Where the stable launcher lives, beside the rest of starmemory's data. */
export function launcherDir(env = process.env) {
  return path.join(homeOf(env), '.config', 'starmemory', 'desktop');
}

/** Claude Code's plugins folder, where the launcher looks for the newest copy. */
export function pluginsDirOf(env = process.env) {
  return path.join(env.CLAUDE_CONFIG_DIR ?? path.join(homeOf(env), '.claude'), 'plugins');
}

export function parseArgs(argv) {
  const opts = { name: DEFAULT_SERVER_NAME, restart: false, replace: false, prepare: true, config: undefined, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--name' || arg === '--config') {
      if (i + 1 >= argv.length) throw new UsageError(`${arg} needs a value`);
      opts[arg.slice(2)] = argv[++i];
    } else if (arg.startsWith('--name=')) opts.name = arg.slice('--name='.length);
    else if (arg.startsWith('--config=')) opts.config = arg.slice('--config='.length);
    else if (arg === '--restart') opts.restart = true;
    else if (arg === '--replace') opts.replace = true;
    else if (arg === '--no-prepare') opts.prepare = false;
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else throw new UsageError(`unknown option ${arg}`);
  }
  if (!SERVER_NAME.test(opts.name)) throw new UsageError('--name must be 1-64 letters, digits, "-" or "_", starting with a letter or digit');
  return opts;
}

/** The config as it is, or an empty one when there is none yet. Throws
 * InvalidConfigError, touching nothing, when it is not a JSON object. The
 * parser's own message is not passed on: it quotes the text around the error,
 * which can be part of a credential. */
export function readDesktopConfig(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return { exists: false, config: {} };
    throw error;
  }
  let config;
  try {
    config = JSON.parse(text);
  } catch {
    throw new InvalidConfigError(`${file} is not valid JSON, so nothing was changed. A missing or extra comma is the usual cause; the app opens the file from Settings, Developer, Edit Config.`);
  }
  const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  if (!isObject(config) || (config.mcpServers !== undefined && !isObject(config.mcpServers))) {
    throw new InvalidConfigError(`${file} does not have the shape the app writes (an object, with "mcpServers" an object), so nothing was changed.`);
  }
  return { exists: true, config };
}

/** How the app starts the server. The app does not use the shell's PATH, so the
 * command is absolute: /bin/sh running the node-finding shim, which looks in
 * Homebrew, nvm, fnm and the rest on each launch, so a node upgrade does not
 * break it. Windows has no sh; there the node running this is named directly.
 * Settings that change where starmemory keeps and finds things are copied from
 * this shell, so the app's server uses the same store as Claude Code's. */
export function serverEntry({ dir, env = process.env, platform = process.platform, nodePath = realNodePath() }) {
  const launcher = path.join(dir, 'launch.mjs');
  const entry = platform === 'win32' ? { command: nodePath, args: [launcher] } : { command: '/bin/sh', args: [path.join(dir, 'run-node.sh'), launcher] };
  const settings = Object.entries(env)
    .filter(([key, value]) => value !== undefined && (/^STARMEMORY_/.test(key) || key === 'CLAUDE_CONFIG_DIR' || key === 'CODEX_HOME'))
    // The summarizer's recursion guard would make every sync the server starts exit at once.
    .filter(([key]) => key !== 'STARMEMORY_SUMMARIZER_GUARD')
    .sort(([a], [b]) => a.localeCompare(b));
  return settings.length > 0 ? { ...entry, env: Object.fromEntries(settings) } : entry;
}

/** The node running this, through any link: a version manager's per-shell
 * path, fnm's on Windows for one, is gone once that shell closes. */
function realNodePath() {
  try {
    return fs.realpathSync(process.execPath);
  } catch {
    return process.execPath;
  }
}

/** Why `name` cannot be ours to write, or undefined: another server already
 * goes by it. Its entry, credentials and all, would be overwritten, with only
 * the backup left to get it back. An entry that runs our launcher is ours. */
export function nameTaken(config, name, launcher) {
  const existing = config.mcpServers?.[name];
  if (existing === undefined || (Array.isArray(existing?.args) && existing.args.includes(launcher))) return undefined;
  return `the config already has a server named "${name}" that is not starmemory's, so nothing was changed. Pick another --name, or add --replace to overwrite that entry.`;
}

/** The config with `entry` under `name`, every other server and setting as it
 * was, in the same order. An earlier entry of ours under another name, one that
 * runs the same launcher, goes: after a name collision, the refused entry
 * should not linger. */
export function withServer(config, name, entry, launcher) {
  const servers = { ...(config.mcpServers ?? {}) };
  const replaced = [];
  for (const [other, value] of Object.entries(servers)) {
    if (other !== name && Array.isArray(value?.args) && value.args.includes(launcher)) {
      delete servers[other];
      replaced.push(other);
    }
  }
  servers[name] = entry;
  return { config: { ...config, mcpServers: servers }, replaced };
}

/** What the launcher is told about the copy at `root`. When Claude Code
 * installed it, the launcher follows that plugin's later installs, and only
 * that plugin's: starmemory from the same marketplace. A checkout elsewhere is
 * used as it is. */
export function launchConfig({ root, pluginsDir }) {
  const marketplace = marketplaceOf(root, pluginsDir);
  if (!marketplace) return { root, pluginsDir, follow: false };
  return { root, pluginsDir, follow: true, plugin: `starmemory@${marketplace}`, marketplace };
}

/** Copy the launcher and the node-finding shim into `dir`, and record `launch`
 * beside them. Rewritten on every run, so running this again brings a newer
 * launcher along. */
export function installLauncher(dir, launch) {
  fs.mkdirSync(dir, { recursive: true });
  const launcher = path.join(dir, 'launch.mjs');
  fs.copyFileSync(path.join(here, 'desktop-launch.mjs'), launcher);
  fs.copyFileSync(path.join(here, 'run-node.sh'), path.join(dir, 'run-node.sh'));
  fs.writeFileSync(path.join(dir, LAUNCH_CONFIG), `${JSON.stringify(launch, null, 2)}\n`);
  return launcher;
}

function stamp(date) {
  return date.toISOString().replace(/\.\d+Z$/, '').replace(/[-:]/g, '').replace('T', '-');
}

/** `<config>.starmemory-backup-<UTC time>`, never overwriting an earlier one. */
export function backupConfig(file, now = new Date()) {
  for (let n = 0; ; n++) {
    const backup = `${file}.starmemory-backup-${stamp(now)}${n === 0 ? '' : `-${n}`}`;
    try {
      fs.copyFileSync(file, backup, fs.constants.COPYFILE_EXCL);
      return backup;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  }
}

/** Written beside and renamed in, keeping the file's mode, so the app never
 * reads half a file. A config that is a link, into a dotfiles folder say, is
 * written where the link points, so the link stays one. The file beside it has
 * a name no one can guess, and is created new, never opened through a link or
 * a file already there. */
export function writeConfig(configPath, config, token = randomBytes(8).toString('hex')) {
  let file = configPath;
  try {
    file = fs.realpathSync(configPath);
  } catch {
    // No config yet, or a link to one not written yet: write where it points.
    try {
      if (fs.lstatSync(configPath).isSymbolicLink()) file = path.resolve(path.dirname(configPath), fs.readlinkSync(configPath));
    } catch {
      // nothing there at all
    }
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let mode = 0o600;
  try {
    mode = fs.statSync(file).mode & 0o777;
  } catch {
    // no config yet: 0600, since it will hold credentials sooner or later
  }
  const temp = `${file}.starmemory-${token}.tmp`;
  // Throws, touching nothing, when anything is at that name already.
  const fd = fs.openSync(temp, 'wx', mode);
  try {
    try {
      fs.writeFileSync(fd, `${JSON.stringify(config, null, 2)}\n`);
      try {
        fs.fchmodSync(fd, mode); // the umask can have narrowed it
      } catch {
        // a file system without modes
      }
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temp, file);
  } catch (error) {
    fs.rmSync(temp, { force: true });
    throw error;
  }
}

/** Claude Code started by the Claude app itself, in its Code tab or as its
 * local agent. Quitting the app from here would end the session asking. */
export function insideClaudeApp(env = process.env) {
  return ['claude-desktop', 'claude-desktop-3p', 'local-agent'].includes(env.CLAUDE_CODE_ENTRYPOINT ?? '');
}

/** Where the app's executable lives on Windows: the installer's
 * %LOCALAPPDATA%\AnthropicClaude, or WindowsApps for the Store build. Going by
 * the name alone would also match Claude Code's own claude.exe, since Windows
 * compares image names without case. */
const WINDOWS_APP_PROCESS =
  "@(Get-Process -Name Claude -ErrorAction SilentlyContinue | Where-Object { $_.Path -like '*\\AnthropicClaude\\*' -or $_.Path -like '*\\WindowsApps\\*Claude*' }).Count";

/** true or false, or undefined where this cannot tell. */
export function claudeAppRunning(platform = process.platform) {
  if (platform === 'darwin') {
    // -a: pgrep leaves out its own ancestors otherwise, and from a session the
    // app runs, the app is one of them.
    const r = spawnSync('pgrep', ['-a', '-x', 'Claude'], { stdio: 'ignore' });
    // 0 is a match and 1 none. Anything else is pgrep failing.
    return r.error || (r.status !== 0 && r.status !== 1) ? undefined : r.status === 0;
  }
  if (platform === 'win32') {
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_APP_PROCESS], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 20_000,
    });
    const count = Number.parseInt(r.stdout ?? '', 10);
    return r.error || r.status !== 0 || !Number.isFinite(count) ? undefined : count > 0;
  }
  return undefined;
}

/** Whether two paths name one file: through links, and without regard to case
 * where the file system ignores it by default, as on macOS and Windows. */
export function sameFile(a, b, platform = process.platform) {
  const real = (p) => {
    try {
      return fs.realpathSync.native(p);
    } catch {
      return path.resolve(p);
    }
  };
  const [x, y] = [real(a), real(b)];
  return platform === 'darwin' || platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y;
}

/** The config the app itself reads: the one under this account's own home,
 * whatever HOME says, since the app is started by the system and not from
 * this shell. */
export function appConfigPath(env = process.env, platform = process.platform) {
  let home;
  try {
    home = os.userInfo().homedir;
  } catch {
    home = os.homedir();
  }
  return path.resolve(desktopConfigPath({ ...env, HOME: home, USERPROFILE: home }, platform));
}

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function quitClaudeApp() {
  spawnSync('osascript', ['-e', 'quit app "Claude"'], { stdio: 'ignore' });
  for (let i = 0; i < 40; i++) {
    if (claudeAppRunning('darwin') === false) return true;
    sleepMs(500);
  }
  return false;
}

function openClaudeApp() {
  return spawnSync('open', ['-a', 'Claude'], { stdio: 'ignore' }).status === 0;
}

/** The node the app will get: the shim in `dir` run the way the app runs it,
 * with a bare PATH, asked for its version. */
export function nodeTheAppFinds(dir, { env = process.env, platform = process.platform } = {}) {
  if (platform === 'win32') return { version: process.version, path: process.execPath };
  const r = spawnSync('/bin/sh', [path.join(dir, 'run-node.sh'), '-e', 'process.stdout.write(process.version + " " + process.execPath)'], {
    env: { HOME: homeOf(env), PATH: '/usr/bin:/bin:/usr/sbin:/sbin' },
    encoding: 'utf8',
    timeout: 20_000,
  });
  if (r.status !== 0 || !r.stdout) return undefined;
  const [version, ...rest] = r.stdout.trim().split(' ');
  return { version, path: rest.join(' ') };
}

/** Install the copy's dependencies now, with that copy's own bootstrap, so the
 * app's first launch does not spend a minute in npm install. */
async function prepareCopy(root) {
  const { ensureReady } = await import(pathToFileURL(path.join(root, 'cli', 'bootstrap.mjs')).href);
  return ensureReady({ root });
}

function nodeLine(node) {
  if (!node) return `  node      not found the way the app looks for it. Install Node ${MIN_NODE_MAJOR} or newer with Homebrew, nvm or fnm.`;
  const major = Number(node.version.replace(/^v/, '').split('.')[0]);
  const warning = major < MIN_NODE_MAJOR ? `, too old: starmemory needs Node ${MIN_NODE_MAJOR} or newer` : '';
  return `  node      ${node.version} at ${node.path}${warning}`;
}

export async function main(argv, deps = {}) {
  const {
    env = process.env,
    platform = process.platform,
    out = (line) => process.stdout.write(`${line}\n`),
    err = (line) => process.stderr.write(`${line}\n`),
    appRunning = () => claudeAppRunning(platform),
    appConfig = appConfigPath(env, platform),
    quitApp = quitClaudeApp,
    openApp = openClaudeApp,
    prepare = prepareCopy,
    now = new Date(),
  } = deps;

  let opts;
  try {
    opts = parseArgs(argv);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    err(`starmemory: ${error.message}`);
    err(USAGE);
    return 2;
  }
  if (opts.help) {
    out(USAGE);
    return 0;
  }

  const configFile = path.resolve(opts.config ?? desktopConfigPath(env, platform));
  const dir = launcherDir(env);
  const launcherPath = path.join(dir, 'launch.mjs');
  try {
    const taken = opts.replace ? undefined : nameTaken(readDesktopConfig(configFile).config, opts.name, launcherPath);
    if (taken) {
      err(`starmemory: ${taken}`);
      return 1;
    }
  } catch (error) {
    if (!(error instanceof InvalidConfigError)) throw error;
    err(`starmemory: ${error.message}`);
    return 1;
  }

  const inside = insideClaudeApp(env);
  const insideRefusal =
    "starmemory: this runs inside the Claude app. It changes the app's config only while the app is closed, and quitting the app would end this session, so nothing was changed. Run the same command in Terminal instead.";
  if (inside && opts.restart) {
    err(insideRefusal);
    return 1;
  }
  // Only the app's own config can be overwritten by the running app; a file
  // named with --config elsewhere, a test's for one, is not its to touch.
  const appsOwn = sameFile(configFile, appConfig, platform);
  const running = appsOwn ? appRunning() : false;
  if (running === undefined && (platform === 'darwin' || platform === 'win32')) {
    err(
      'starmemory: could not tell whether the Claude app is running' +
        (opts.restart ? ', so --restart is not applied' : '') +
        '. If it is, quit it and run this again: it can overwrite a config changed while it is open.'
    );
  }
  if (running && opts.restart && platform !== 'darwin') {
    err('starmemory: --restart works on macOS only. Quit the Claude app from the system tray, run this again without --restart, then open the app.');
    return 1;
  }
  if (running && !opts.restart) {
    if (inside) {
      err(insideRefusal);
      return 1;
    }
    err('starmemory: the Claude app is running, and it can overwrite changes made to its config while it is open, so nothing was changed.');
    err('Quit it (Cmd+Q on a Mac) and run this again, or add --restart to have this quit the app, make the change and open it again.');
    return 1;
  }

  const root = path.resolve(here, '..');
  const launch = launchConfig({ root, pluginsDir: pluginsDirOf(env) });
  const serverRoot = resolvePluginRoot(launch);
  // The shim beside this file, which is the one installLauncher copies.
  const node = nodeTheAppFinds(here, { env, platform });

  if (opts.prepare && serverRoot) {
    const ready = await prepare(serverRoot);
    if (!ready) err('starmemory: its dependencies could not be installed now (see above); the app\'s first launch tries again.');
  }

  let quit = false;
  if (running && opts.restart) {
    out('starmemory: quitting the Claude app...');
    if (!quitApp()) {
      err('starmemory: the Claude app did not quit, so nothing was changed. Quit it yourself and run this again.');
      return 1;
    }
    quit = true;
  }
  // Once this has quit the app, it opens it again on every way out, a
  // refusal or a failed write among them.
  let reopenTried = false;
  const reopen = () => {
    reopenTried = true;
    return openApp();
  };
  try {
    return finish();
  } finally {
    if (quit && !reopenTried) reopen();
  }

  function finish() {
    // Read again: the app may have written its config as it quit.
    let current;
    try {
      current = readDesktopConfig(configFile);
    } catch (error) {
      if (!(error instanceof InvalidConfigError)) throw error;
      err(`starmemory: ${error.message}`);
      return 1;
    }
    const taken = opts.replace ? undefined : nameTaken(current.config, opts.name, launcherPath);
    if (taken) {
      err(`starmemory: ${taken}`);
      return 1;
    }
    // The first look came before preparing the copy, which can take minutes.
    // Having quit the app itself, this saw it gone a moment ago.
    if (appsOwn && !quit && appRunning() === true) {
      err('starmemory: the Claude app is running now, and it can overwrite changes made to its config while it is open, so nothing was changed.');
      err(opts.restart ? 'Run this again.' : 'Quit it and run this again, or add --restart to have this quit the app, make the change and open it again.');
      return 1;
    }
    const launcher = installLauncher(dir, launch);
    const entry = serverEntry({ dir, env, platform });
    const { config, replaced } = withServer(current.config, opts.name, entry, launcher);
    const backup = current.exists ? backupConfig(configFile, now) : undefined;
    writeConfig(configFile, config);
    const reopened = quit ? reopen() : false;

    out(`starmemory: registered "${opts.name}" with the Claude desktop app.`);
    out(`  config    ${configFile}`);
    out(`  backup    ${backup ? `${backup}, which holds the same credentials as the config` : 'none, the file is new'}`);
    out(`  launcher  ${launcher}`);
    out(
      `  starts    ${serverRoot ?? 'nothing yet: no runnable copy was found'}` +
        (launch.follow ? `, or whichever version of ${launch.plugin} Claude Code has installed newest at launch` : '')
    );
    out(nodeLine(node));
    if (entry.env) out(`  settings  ${Object.keys(entry.env).join(', ')}, copied from this shell`);
    if (replaced.length > 0) out(`  replaced  the earlier entry ${replaced.map((n) => `"${n}"`).join(', ')}`);
    out(`  servers   ${Object.keys(config.mcpServers).join(', ')}`);
    out('');
    out(reopened ? 'Reopened the Claude app.' : quit ? 'Next: open the Claude app again.' : 'Next: quit the Claude app completely and open it again.');
    out(`Cowork sessions linked to this computer then have mcp__remote-devices__${opts.name}__search, read, remember and forget.`);
    out('If the app says the name collides with a reserved internal server name, run this again with --name <another name>.');
    return 0;
  }
}
