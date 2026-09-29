// `starmemory desktop-install` edits the Claude desktop app's config, which
// holds other servers' credentials: it must change only its own entry, back the
// file up, print nothing but server names, and work before npm install. Run
// against a temp HOME, never the real config.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
// @ts-expect-error -- plain JS module, no type declarations by design
import { DEFAULT_SERVER_NAME, desktopConfigPath, launcherDir, main } from '../cli/desktop-install.mjs';
// @ts-expect-error -- plain JS module, no type declarations by design
import { isPrepared, resolvePluginRoot } from '../cli/desktop-launch.mjs';
// @ts-expect-error -- plain JS module, no type declarations by design
import { RUNTIME_DEPENDENCIES, findMissingAddons, findMissingDeps } from '../cli/install-check.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SECRET = 'secret-token-123';

let dir: string;
let home: string;
let env: Record<string, string>;
let configFile: string;

beforeEach(() => {
  // Under the temp folder's full real path, so a path built here is the one
  // node reports for a script under it, links resolved (/var is one on macOS),
  // and also what fs.realpathSync.native gives, which expands a Windows short
  // name such as RUNNER~1 that node keeps.
  dir = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'starmemory-desktop-'));
  home = path.join(dir, 'home');
  fs.mkdirSync(home);
  // Only what the command needs, so nothing from this machine leaks in.
  env = { HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'AppData', 'Roaming'), PATH: process.env.PATH ?? '' };
  // Windows cannot start a process without these.
  if (process.platform === 'win32') {
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined && /^(systemroot|systemdrive|windir|comspec|pathext|temp|tmp)$/i.test(key)) env[key] = value;
    }
  }
  configFile = desktopConfigPath(env, process.platform);
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const existingConfig = {
  mcpServers: {
    'byoc-admin': { command: '/usr/local/bin/byoc', args: ['serve'], env: { BYOC_TOKEN: SECRET } },
  },
  preferences: { sidebarMode: 'chat' },
};

function writeConfig(content: unknown) {
  fs.mkdirSync(path.dirname(configFile), { recursive: true });
  fs.writeFileSync(configFile, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
}

function install(args: string[] = [], entry = path.join(root, 'cli', 'starmemory.mjs'), extraEnv: Record<string, string> = {}) {
  const r = spawnSync(process.execPath, [entry, 'desktop-install', '--no-prepare', ...args], { env: { ...env, ...extraEnv }, encoding: 'utf8', timeout: 60_000 });
  return { status: r.status, output: `${r.stdout}${r.stderr}` };
}

const readConfig = () => JSON.parse(fs.readFileSync(configFile, 'utf8'));
const readLaunch = () => JSON.parse(fs.readFileSync(path.join(launcherDir(env), 'launch.json'), 'utf8'));
const backups = () => fs.readdirSync(path.dirname(configFile)).filter((name) => name.includes('.starmemory-backup-'));

/** A copy of this checkout's cli/ and package.json at `copy`, which is what a
 * fresh plugin install has before npm install. */
function freshCopy(copy: string) {
  fs.cpSync(path.join(root, 'cli'), path.join(copy, 'cli'), { recursive: true });
  fs.copyFileSync(path.join(root, 'package.json'), path.join(copy, 'package.json'));
  return copy;
}

describe('desktop-install', () => {
  it('adds the server beside the existing ones, backs the config up, and prints no other server\'s settings', () => {
    writeConfig(existingConfig);
    const original = fs.readFileSync(configFile);

    const { status, output } = install();

    expect(status).toBe(0);
    const config = readConfig();
    expect(config.mcpServers['byoc-admin']).toEqual(existingConfig.mcpServers['byoc-admin']);
    expect(config.preferences).toEqual(existingConfig.preferences);
    expect(Object.keys(config.mcpServers)).toEqual(['byoc-admin', DEFAULT_SERVER_NAME]);
    const entry = config.mcpServers[DEFAULT_SERVER_NAME];
    for (const file of [entry.command, ...entry.args]) {
      expect(path.isAbsolute(file)).toBe(true);
      expect(fs.existsSync(file)).toBe(true);
    }
    expect(entry.args.at(-1)).toBe(path.join(launcherDir(env), 'launch.mjs'));
    expect(backups()).toHaveLength(1);
    expect(fs.readFileSync(path.join(path.dirname(configFile), backups()[0]))).toEqual(original);
    expect(output).toContain(`servers   byoc-admin, ${DEFAULT_SERVER_NAME}`);
    expect(output).not.toContain(SECRET);
    expect(output).not.toContain('BYOC_TOKEN');
    expect(output).toContain('quit the Claude app completely and open it again');
    expect(output).toContain('which holds the same credentials as the config');
  });

  it('records the copy it ran from for the launcher, and follows Claude Code only for a copy Claude Code installed', () => {
    install();

    expect(readLaunch()).toEqual({ root, pluginsDir: path.join(home, '.claude', 'plugins'), follow: false });
  });

  it('pins the launcher to the plugin it ran from, by the marketplace its copy sits under', () => {
    const pluginsDir = path.join(home, '.claude', 'plugins');
    for (const copy of [path.join(pluginsDir, 'cache', 'acme', 'starmemory', '0.3.0'), path.join(pluginsDir, 'marketplaces', 'acme')]) {
      freshCopy(copy);

      const { status, output } = install([], path.join(copy, 'cli', 'starmemory.mjs'));

      expect(status).toBe(0);
      expect(readLaunch()).toEqual({ root: fs.realpathSync.native(copy), pluginsDir, follow: true, plugin: 'starmemory@acme', marketplace: 'acme' });
      expect(output).toContain('or whichever version of starmemory@acme Claude Code has installed newest at launch');
    }
  });

  it('does not follow a copy that sits elsewhere in the plugins folder', () => {
    const copy = freshCopy(path.join(home, '.claude', 'plugins', 'local', 'starmemory'));

    expect(install([], path.join(copy, 'cli', 'starmemory.mjs')).status).toBe(0);

    expect(readLaunch()).toEqual({ root: fs.realpathSync.native(copy), pluginsDir: path.join(home, '.claude', 'plugins'), follow: false });
  });

  it('uses the name given with --name, and drops its own earlier entry but no one else\'s', () => {
    writeConfig(existingConfig);
    install();

    const { status, output } = install(['--name', 'star-recall']);

    expect(status).toBe(0);
    expect(Object.keys(readConfig().mcpServers)).toEqual(['byoc-admin', 'star-recall']);
    expect(output).toContain('replaced  the earlier entry "starmem"');
    expect(output).toContain('mcp__remote-devices__star-recall__search');
    expect(backups()).toHaveLength(2);
  });

  it('refuses a --name another server already goes by, and takes it over only with --replace', () => {
    writeConfig(existingConfig);

    const refused = install(['--name', 'byoc-admin']);

    expect(refused.status).toBe(1);
    expect(refused.output).toContain('already has a server named "byoc-admin" that is not starmemory\'s');
    expect(readConfig()).toEqual(existingConfig);
    expect(backups()).toEqual([]);

    const replaced = install(['--name', 'byoc-admin', '--replace']);

    expect(replaced.status).toBe(0);
    expect(readConfig().mcpServers['byoc-admin'].args.at(-1)).toBe(path.join(launcherDir(env), 'launch.mjs'));
    // Running it again under the same name is ours to overwrite, no flag needed.
    expect(install(['--name', 'byoc-admin']).status).toBe(0);
  });

  it('writes through a config that is a link, so the link stays one', () => {
    if (process.platform === 'win32') return; // symlinks need a privilege there
    const target = path.join(dir, 'dotfiles', 'claude_desktop_config.json');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, JSON.stringify(existingConfig));
    fs.mkdirSync(path.dirname(configFile), { recursive: true });
    fs.symlinkSync(target, configFile);

    expect(install().status).toBe(0);

    expect(fs.lstatSync(configFile).isSymbolicLink()).toBe(true);
    expect(Object.keys(JSON.parse(fs.readFileSync(target, 'utf8')).mcpServers)).toEqual(['byoc-admin', DEFAULT_SERVER_NAME]);
  });

  it('writes where a link points even when there is no config there yet', () => {
    if (process.platform === 'win32') return;
    const target = path.join(dir, 'dotfiles', 'claude_desktop_config.json');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.mkdirSync(path.dirname(configFile), { recursive: true });
    fs.symlinkSync(target, configFile);

    expect(install().status).toBe(0);

    expect(fs.lstatSync(configFile).isSymbolicLink()).toBe(true);
    expect(Object.keys(JSON.parse(fs.readFileSync(target, 'utf8')).mcpServers)).toEqual([DEFAULT_SERVER_NAME]);
  });

  it('refuses a name the app could not use, and changes nothing', () => {
    writeConfig(existingConfig);

    const { status, output } = install(['--name', 'has space']);

    expect(status).toBe(2);
    expect(output).toContain('--name must be');
    expect(readConfig()).toEqual(existingConfig);
  });

  it('copies the settings that move starmemory\'s store, so the app\'s server shares it, and leaves out the summarizer guard', () => {
    install([], undefined, { STARMEMORY_DB_PATH: '/data/store.mdb', CLAUDE_CONFIG_DIR: '/data/claude' });

    expect(readConfig().mcpServers[DEFAULT_SERVER_NAME].env).toEqual({ CLAUDE_CONFIG_DIR: '/data/claude', STARMEMORY_DB_PATH: '/data/store.mdb' });
  });

  it('refuses a config that is not valid JSON, changes nothing, and does not echo it', () => {
    const broken = `{ "mcpServers": { "a": { "env": { "K": "${SECRET}" } } `;
    writeConfig(broken);

    const { status, output } = install();

    expect(status).toBe(1);
    expect(output).toContain('is not valid JSON, so nothing was changed');
    expect(output).not.toContain(SECRET);
    expect(fs.readFileSync(configFile, 'utf8')).toBe(broken);
    expect(backups()).toEqual([]);
  });

  it('creates the config when the app has none yet', () => {
    const { status, output } = install();

    expect(status).toBe(0);
    expect(Object.keys(readConfig().mcpServers)).toEqual([DEFAULT_SERVER_NAME]);
    expect(output).toContain('backup    none, the file is new');
    if (process.platform !== 'win32') expect(fs.statSync(configFile).mode & 0o777).toBe(0o600);
  });

  it('runs from a copy with no node_modules and no dist, as a fresh plugin install is', () => {
    const copy = freshCopy(path.join(dir, 'fresh-copy'));
    // Node runs a script from its real path, so that is the root it reports,
    // under a temp folder that is a link, as /var is on macOS.
    const real = fs.realpathSync.native(copy);

    const { status, output } = install([], path.join(copy, 'cli', 'starmemory.mjs'));

    expect(status).toBe(0);
    expect(output).toContain(`starts    ${real}`);
    expect(readLaunch().root).toBe(real);
  });
});

describe('telling whether the Claude app is running', () => {
  const installModule = pathToFileURL(path.join(root, 'cli', 'desktop-install.mjs')).href;

  /** claudeAppRunning('darwin'), with a pgrep on PATH that exits as macOS's
   * does from a session the app runs: the app is an ancestor there, so only
   * `-a` finds it. */
  function appRunningWithPgrep(status: number) {
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, 'pgrep'), `#!/bin/sh\n[ "$*" = "-a -x Claude" ] && exit ${status}\nexit 1\n`, { mode: 0o755 });
    const script = `import { claudeAppRunning } from ${JSON.stringify(installModule)}; process.stdout.write(String(claudeAppRunning('darwin')));`;
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { env: { ...env, PATH: `${bin}${path.delimiter}${env.PATH}` }, encoding: 'utf8' });
    return r.stdout;
  }

  it('counts the app among pgrep\'s ancestors, which pgrep leaves out by default', () => {
    if (process.platform === 'win32') return; // the fake pgrep is a shell script
    expect(appRunningWithPgrep(0)).toBe('true');
    expect(appRunningWithPgrep(1)).toBe('false');
  });

  it('cannot tell when pgrep itself fails', () => {
    if (process.platform === 'win32') return;
    expect(appRunningWithPgrep(3)).toBe('undefined');
  });
});

describe('desktop-install while the Claude app is running', () => {
  const quiet = { out: () => {}, err: () => {} };

  it('changes nothing, and says to quit the app first or pass --restart', async () => {
    writeConfig(existingConfig);
    const said: string[] = [];

    const code = await main(['--no-prepare', '--config', configFile], { env, appRunning: () => true, appConfig: configFile, out: () => {}, err: (l: string) => said.push(l) });

    expect(code).toBe(1);
    expect(readConfig()).toEqual(existingConfig);
    expect(said.join('\n')).toContain('add --restart');
  });

  it('with --restart, quits the app before the change and opens it after', async () => {
    writeConfig(existingConfig);
    const events: string[] = [];
    const hasEntry = () => DEFAULT_SERVER_NAME in readConfig().mcpServers;

    const code = await main(['--restart', '--no-prepare', '--config', configFile], {
      ...quiet,
      env,
      platform: 'darwin',
      appRunning: () => true,
      appConfig: configFile,
      quitApp: () => { events.push(`quit, entry written: ${hasEntry()}`); return true; },
      openApp: () => { events.push(`open, entry written: ${hasEntry()}`); return true; },
    });

    expect(code).toBe(0);
    expect(events).toEqual(['quit, entry written: false', 'open, entry written: true']);
  });

  it('with --restart, changes nothing when the app will not quit', async () => {
    writeConfig(existingConfig);

    const code = await main(['--restart', '--no-prepare', '--config', configFile], { ...quiet, env, platform: 'darwin', appRunning: () => true, appConfig: configFile, quitApp: () => false, openApp: () => true });

    expect(code).toBe(1);
    expect(readConfig()).toEqual(existingConfig);
  });

  it('refuses --restart from a Claude Code session the app itself runs, which quitting would end', async () => {
    writeConfig(existingConfig);
    let quit = false;

    const code = await main(['--restart', '--no-prepare', '--config', configFile], {
      ...quiet,
      env: { ...env, CLAUDE_CODE_ENTRYPOINT: 'claude-desktop' },
      platform: 'darwin',
      appRunning: () => true,
      appConfig: configFile,
      quitApp: () => (quit = true),
    });

    expect(code).toBe(1);
    expect(quit).toBe(false);
    expect(readConfig()).toEqual(existingConfig);
  });

  it('refuses --restart from inside the app whatever it can tell of the app, and touches nothing', async () => {
    writeConfig(existingConfig);

    for (const answer of [false, undefined]) {
      const events: string[] = [];
      const said: string[] = [];
      const code = await main(['--restart', '--no-prepare', '--config', configFile], {
        env: { ...env, CLAUDE_CODE_ENTRYPOINT: 'claude-desktop' },
        platform: 'darwin',
        appRunning: () => answer,
        appConfig: configFile,
        quitApp: () => { events.push('quit'); return true; },
        openApp: () => { events.push('open'); return true; },
        out: () => {},
        err: (l: string) => said.push(l),
      });

      expect(code).toBe(1);
      expect(events).toEqual([]);
      expect(said.join('\n')).toContain('Run the same command in Terminal instead');
      expect(readConfig()).toEqual(existingConfig);
      expect(fs.existsSync(launcherDir(env))).toBe(false);
    }
  });

  it('without --restart, from inside the running app, says to run it in Terminal', async () => {
    writeConfig(existingConfig);
    const said: string[] = [];

    const code = await main(['--no-prepare', '--config', configFile], {
      env: { ...env, CLAUDE_CODE_ENTRYPOINT: 'claude-desktop' },
      platform: 'darwin',
      appRunning: () => true,
      appConfig: configFile,
      out: () => {},
      err: (l: string) => said.push(l),
    });

    expect(code).toBe(1);
    expect(said.join('\n')).toContain('Run the same command in Terminal instead');
    expect(said.join('\n')).not.toContain('add --restart');
    expect(readConfig()).toEqual(existingConfig);
  });

  it('looks again just before writing, after preparing the copy, and changes nothing if the app was opened meanwhile', async () => {
    writeConfig(existingConfig);
    const events: string[] = [];
    const said: string[] = [];

    const code = await main(['--config', configFile], {
      ...quiet,
      env,
      appRunning: () => { events.push('look'); return events.length > 1; },
      appConfig: configFile,
      prepare: async () => { events.push('prepare'); return true; },
      err: (l: string) => said.push(l),
    });

    expect(code).toBe(1);
    expect(events).toEqual(['look', 'prepare', 'look']);
    expect(said.join('\n')).toContain('the Claude app is running now');
    expect(said.join('\n')).toContain('nothing was changed');
    expect(readConfig()).toEqual(existingConfig);
    expect(backups()).toEqual([]);
    // Nor is the launcher rewritten when this refuses.
    expect(fs.existsSync(launcherDir(env))).toBe(false);
  });

  it('with --restart, neither quits nor opens an app it did not see running, and does not say it reopened it', async () => {
    for (const answer of [false, undefined]) {
      writeConfig(existingConfig);
      const events: string[] = [];
      const said: string[] = [];

      const code = await main(['--restart', '--no-prepare', '--config', configFile], {
        env,
        platform: 'darwin',
        appRunning: () => answer,
        appConfig: configFile,
        quitApp: () => { events.push('quit'); return true; },
        openApp: () => { events.push('open'); return true; },
        out: (l: string) => said.push(l),
        err: (l: string) => said.push(l),
      });

      expect(code).toBe(0);
      expect(events).toEqual([]);
      expect(said.join('\n')).not.toContain('Reopened');
      expect(Object.keys(readConfig().mcpServers)).toEqual(['byoc-admin', DEFAULT_SERVER_NAME]);
    }
  });

  it('with --restart, says to open the app when it quit it and could not open it again', async () => {
    writeConfig(existingConfig);
    const said: string[] = [];

    const code = await main(['--restart', '--no-prepare', '--config', configFile], {
      env,
      platform: 'darwin',
      appRunning: () => true,
      appConfig: configFile,
      quitApp: () => true,
      openApp: () => false,
      out: (l: string) => said.push(l),
      err: () => {},
    });

    expect(code).toBe(0);
    expect(said).toContain('Next: open the Claude app again.');
    expect(said.join('\n')).not.toContain('Reopened');
  });

  it('knows the app\'s own config by another name, through a link', async () => {
    if (process.platform === 'win32') return;
    writeConfig(existingConfig);
    const alias = path.join(dir, 'alias.json');
    fs.symlinkSync(configFile, alias);

    const code = await main(['--no-prepare', '--config', alias], { ...quiet, env, appRunning: () => true, appConfig: configFile });

    expect(code).toBe(1);
    expect(readConfig()).toEqual(existingConfig);
  });

  it('with --restart, opens the app again when the change fails after it quit', async () => {
    writeConfig(existingConfig);
    const events: string[] = [];

    const code = await main(['--restart', '--no-prepare', '--config', configFile], {
      ...quiet,
      env,
      platform: 'darwin',
      appRunning: () => true,
      appConfig: configFile,
      // The app leaves a broken config behind as it quits.
      quitApp: () => { events.push('quit'); fs.writeFileSync(configFile, '{ broken'); return true; },
      openApp: () => { events.push('open'); return true; },
    });

    expect(code).toBe(1);
    expect(events).toEqual(['quit', 'open']);
  });

  it('says so when it cannot tell whether the app is running', async () => {
    writeConfig(existingConfig);
    const said: string[] = [];

    const code = await main(['--no-prepare', '--config', configFile], { ...quiet, env, platform: 'darwin', appRunning: () => undefined, appConfig: configFile, err: (l: string) => said.push(l) });

    expect(code).toBe(0);
    expect(said.join('\n')).toContain('could not tell whether the Claude app is running');
  });

  it('edits a config other than the app\'s own without asking about the app, which does not read it', async () => {
    writeConfig(existingConfig);

    const code = await main(['--no-prepare', '--config', configFile], { ...quiet, env, appRunning: () => true, appConfig: path.join(dir, 'the-apps-own.json') });

    expect(code).toBe(0);
    expect(Object.keys(readConfig().mcpServers)).toEqual(['byoc-admin', DEFAULT_SERVER_NAME]);
  });
});

describe('the stable launcher', () => {
  const dependencies = { '@modelcontextprotocol/sdk': '^1.0.0', zod: '^4.6.1' };

  /** A fake installed copy: enough for the launcher to call it runnable. */
  function copyAt(dirPath: string, version: string, deps: Record<string, string> = dependencies) {
    fs.mkdirSync(path.join(dirPath, 'cli'), { recursive: true });
    fs.writeFileSync(path.join(dirPath, 'package.json'), JSON.stringify({ name: 'starmemory', version, dependencies: deps }));
    fs.writeFileSync(path.join(dirPath, 'cli', 'mcp-server.mjs'), '');
    return dirPath;
  }

  /** What npm install and the addon download leave in a copy. */
  function prepare(dirPath: string) {
    fs.mkdirSync(path.join(dirPath, 'native'), { recursive: true });
    fs.writeFileSync(path.join(dirPath, 'native', `starmemory_native.${process.platform}-${process.arch}.node`), '');
    const deps = JSON.parse(fs.readFileSync(path.join(dirPath, 'package.json'), 'utf8')).dependencies;
    for (const name of Object.keys(deps)) {
      fs.mkdirSync(path.join(dirPath, 'node_modules', name), { recursive: true });
      fs.writeFileSync(path.join(dirPath, 'node_modules', name, 'package.json'), '{}');
    }
    return dirPath;
  }

  const recordInstalls = (pluginsDir: string, record: unknown) => fs.writeFileSync(path.join(pluginsDir, 'installed_plugins.json'), JSON.stringify(record));

  it('starts the newest copy Claude Code has recorded as installed', () => {
    const pluginsDir = path.join(dir, 'plugins');
    const older = copyAt(path.join(pluginsDir, 'cache', 'starmemory', 'starmemory', '0.3.0'), '0.3.0');
    const newer = copyAt(path.join(pluginsDir, 'cache', 'starmemory', 'starmemory', '0.10.0'), '0.10.0');
    fs.writeFileSync(path.join(pluginsDir, 'installed_plugins.json'), JSON.stringify({
      version: 2,
      plugins: {
        'other@elsewhere': [{ scope: 'user', installPath: path.join(dir, 'other') }],
        'starmemory@starmemory': [{ scope: 'user', installPath: older }, { scope: 'project', installPath: newer }],
      },
    }));

    expect(resolvePluginRoot({ root: older, pluginsDir, follow: true })).toBe(newer);
  });

  it('falls back to the plugin cache, skipping versions Claude Code orphaned, then to the copy that installed it', () => {
    const pluginsDir = path.join(dir, 'plugins');
    const kept = copyAt(path.join(pluginsDir, 'cache', 'starmemory', 'starmemory', '0.3.0'), '0.3.0');
    const orphaned = copyAt(path.join(pluginsDir, 'cache', 'starmemory', 'starmemory', '0.4.0'), '0.4.0');
    fs.writeFileSync(path.join(orphaned, '.orphaned_at'), '1790000000000');
    const checkout = copyAt(path.join(dir, 'checkout'), '9.9.9');
    const marketplace = 'starmemory';

    expect(resolvePluginRoot({ root: checkout, pluginsDir, follow: true, marketplace })).toBe(kept);
    expect(resolvePluginRoot({ root: checkout, pluginsDir, follow: false, marketplace })).toBe(checkout);
    expect(resolvePluginRoot({ root: checkout, pluginsDir: path.join(dir, 'empty'), follow: true, marketplace })).toBe(checkout);
    expect(resolvePluginRoot({ root: path.join(dir, 'gone'), pluginsDir: path.join(dir, 'empty'), follow: true, marketplace })).toBeUndefined();
  });

  it('starts only its own plugin, starmemory from its own marketplace, and only from that plugin\'s cache folder', () => {
    const pluginsDir = path.join(dir, 'plugins');
    const own = copyAt(path.join(pluginsDir, 'cache', 'acme', 'starmemory', '0.3.0'), '0.3.0');
    const otherMarketplace = copyAt(path.join(pluginsDir, 'cache', 'elsewhere', 'starmemory', '9.0.0'), '9.0.0');
    const otherPlugin = copyAt(path.join(pluginsDir, 'cache', 'acme', 'fork', '9.1.0'), '9.1.0');
    const outside = copyAt(path.join(dir, 'outside', 'starmemory'), '9.2.0');
    if (process.platform !== 'win32') fs.symlinkSync(outside, path.join(pluginsDir, 'cache', 'acme', 'starmemory', '9.3.0'));
    recordInstalls(pluginsDir, {
      version: 2,
      plugins: {
        'starmemory@elsewhere': [{ scope: 'user', installPath: otherMarketplace }],
        'fork@acme': [{ scope: 'user', installPath: otherPlugin }],
        'starmemory@acme': [
          { scope: 'user', installPath: own },
          { scope: 'project', installPath: outside },
          { scope: 'local', installPath: path.join(pluginsDir, 'cache', 'acme', 'starmemory', '9.3.0') },
        ],
      },
    });
    const launch = { root: own, pluginsDir, follow: true, plugin: 'starmemory@acme', marketplace: 'acme' };

    expect(resolvePluginRoot(launch)).toBe(own);
    // The cache, when there is no record, is read the same way.
    fs.rmSync(path.join(pluginsDir, 'installed_plugins.json'));
    expect(resolvePluginRoot(launch)).toBe(own);
  });

  it('finds its plugin\'s record in the file\'s other shapes', () => {
    const pluginsDir = path.join(dir, 'plugins');
    const older = copyAt(path.join(pluginsDir, 'cache', 'acme', 'starmemory', '0.3.0'), '0.3.0');
    const newer = copyAt(path.join(pluginsDir, 'cache', 'acme', 'starmemory', '0.4.0'), '0.4.0');
    const launch = { root: older, pluginsDir, follow: true, marketplace: 'acme' };
    // A record naming only the older copy, so the cache alone would pick the newer.
    const shapes = [
      { version: 1, plugins: { 'starmemory@acme': { version: '0.3.0', installPath: older } } },
      { users: [{ plugins: { 'starmemory@acme': [{ installPath: older }] } }] },
    ];

    for (const record of shapes) {
      recordInstalls(pluginsDir, record);
      expect(resolvePluginRoot(launch)).toBe(older);
    }
    recordInstalls(pluginsDir, { version: 2, plugins: { 'starmemory@elsewhere': [{ installPath: older }] } });
    expect(resolvePluginRoot(launch)).toBe(newer);
  });

  it('gets the marketplace from where the copy sits for a launch.json that has none, and otherwise does not follow', () => {
    const pluginsDir = path.join(dir, 'plugins');
    const older = copyAt(path.join(pluginsDir, 'cache', 'acme', 'starmemory', '0.3.0'), '0.3.0');
    const newer = copyAt(path.join(pluginsDir, 'cache', 'acme', 'starmemory', '0.4.0'), '0.4.0');
    const clone = copyAt(path.join(pluginsDir, 'marketplaces', 'acme'), '0.2.0');
    const elsewhere = copyAt(path.join(pluginsDir, 'local', 'starmemory'), '0.1.0');

    expect(resolvePluginRoot({ root: older, pluginsDir, follow: true })).toBe(newer);
    expect(resolvePluginRoot({ root: clone, pluginsDir, follow: true })).toBe(newer);
    expect(resolvePluginRoot({ root: elsewhere, pluginsDir, follow: true })).toBe(elsewhere);
    // An old version Claude Code has removed since still names its marketplace.
    expect(resolvePluginRoot({ root: path.join(pluginsDir, 'cache', 'acme', 'starmemory', '0.1.0'), pluginsDir, follow: true })).toBe(newer);
  });

  it('prefers the newest copy that is prepared, falls back to the newest, and never starts an orphaned one', () => {
    const pluginsDir = path.join(dir, 'plugins');
    const cache = path.join(pluginsDir, 'cache', 'acme', 'starmemory');
    const older = prepare(copyAt(path.join(cache, '0.3.0'), '0.3.0'));
    const orphaned = prepare(copyAt(path.join(cache, '0.3.5'), '0.3.5'));
    fs.writeFileSync(path.join(orphaned, '.orphaned_at'), '1790000000000');
    const newest = copyAt(path.join(cache, '0.4.0'), '0.4.0');
    const launch = { root: older, pluginsDir, follow: true, marketplace: 'acme' };

    expect(resolvePluginRoot(launch)).toBe(older);
    fs.rmSync(path.join(older, 'node_modules', 'zod'), { recursive: true });
    expect(resolvePluginRoot(launch)).toBe(newest);
  });

  it('calls a copy prepared only when what ensureReady checks is there', () => {
    const own = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).dependencies;
    expect(Object.keys(own)).toEqual(expect.arrayContaining([...RUNTIME_DEPENDENCIES]));
    const copy = prepare(copyAt(path.join(dir, 'copy'), '0.3.0', own));

    expect(isPrepared(copy)).toBe(true);
    expect([...findMissingDeps(copy), ...findMissingAddons(copy)]).toEqual([]);
    for (const name of RUNTIME_DEPENDENCIES) {
      fs.renameSync(path.join(copy, 'node_modules', name), path.join(dir, 'moved'));
      expect(isPrepared(copy)).toBe(false);
      fs.renameSync(path.join(dir, 'moved'), path.join(copy, 'node_modules', name));
    }
    fs.rmSync(path.join(copy, 'native'), { recursive: true });
    expect(isPrepared(copy)).toBe(false);
  });

  it('ranks a prerelease below its release and above the version before', () => {
    const pluginsDir = path.join(dir, 'plugins');
    const cache = path.join(pluginsDir, 'cache', 'acme', 'starmemory');
    const before = copyAt(path.join(cache, '0.3.9'), '0.3.9');
    const release = copyAt(path.join(cache, '0.4.0'), '0.4.0');
    const beta = copyAt(path.join(cache, '0.4.0-beta.1'), '0.4.0-beta.1');
    // Installed last, which would decide a tie.
    const past = new Date(Date.now() - 60_000);
    fs.utimesSync(path.join(release, 'package.json'), past, past);
    fs.utimesSync(path.join(before, 'package.json'), past, past);
    const launch = { root: before, pluginsDir, follow: true, marketplace: 'acme' };

    expect(resolvePluginRoot(launch)).toBe(release);
    fs.rmSync(release, { recursive: true });
    expect(resolvePluginRoot(launch)).toBe(beta);
  });

  it('serves the four tools through exactly the command written into the config', async () => {
    install();
    const { command, args } = readConfig().mcpServers[DEFAULT_SERVER_NAME];
    const client = new Client({ name: 'starmemory-test', version: '0.0.0' });

    await client.connect(new StdioClientTransport({ command, args, env, stderr: 'ignore' }));
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual(['forget', 'read', 'remember', 'search']);
    } finally {
      await client.close();
    }
  }, 120_000);
});
