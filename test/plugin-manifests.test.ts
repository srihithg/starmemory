// The two harness manifests must describe the same plugin: one hooks file, one
// MCP server, one store (design doc §16). Codex resolves relative paths against
// the plugin root and does not set CLAUDE_PLUGIN_ROOT, so anything Codex reads
// has to be relative.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_SERVER_NAME } from '../cli/desktop-install.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string) => JSON.parse(fs.readFileSync(path.join(root, rel), 'utf-8'));

// Claude Code names each installed copy's cache folder after the manifest
// version, while the addon download and the desktop launcher's pick of the
// newest copy go by package.json, so every copy of the number has to agree.
describe('plugin version', () => {
  it('is package.json\'s in every manifest and in the lockfile', () => {
    const marketplace = read('.claude-plugin/marketplace.json');
    const lock = read('package-lock.json');
    const found: Record<string, string> = {
      '.claude-plugin/plugin.json': read('.claude-plugin/plugin.json').version,
      '.claude-plugin/marketplace.json metadata': marketplace.metadata.version,
      '.codex-plugin/plugin.json': read('.codex-plugin/plugin.json').version,
      'package-lock.json': lock.version,
      'package-lock.json root package': lock.packages[''].version,
    };
    for (const plugin of marketplace.plugins) found[`.claude-plugin/marketplace.json plugin ${plugin.name}`] = plugin.version;
    const version = read('package.json').version;
    expect(found).toEqual(Object.fromEntries(Object.keys(found).map((where) => [where, version])));
  });
});

describe('Codex plugin manifest', () => {
  const manifest = () => read('.codex-plugin/plugin.json');

  it('exists and names the same plugin as the Claude Code manifest', () => {
    expect(manifest().name).toBe(read('.claude-plugin/plugin.json').name);
    expect(manifest().version).toBe(read('.claude-plugin/plugin.json').version);
  });

  it('points at the hooks file and the MCP config, and both exist', () => {
    const m = manifest();
    expect(fs.existsSync(path.join(root, m.hooks))).toBe(true);
    expect(fs.existsSync(path.join(root, m.mcpServers))).toBe(true);
  });

  it('shares the hooks file with Claude Code, so a sync is one command in both', () => {
    expect(manifest().hooks).toBe('./hooks/hooks.json');
  });

  it('points at the skills folder Claude Code finds on its own at the plugin root', () => {
    expect(manifest().skills).toBe('./skills/');
    expect(fs.existsSync(path.join(root, manifest().skills, 'starmemory', 'SKILL.md'))).toBe(true);
  });
});

describe('the starmemory skill', () => {
  // A Windows checkout has CRLF line endings.
  const text = () => fs.readFileSync(path.join(root, 'skills', 'starmemory', 'SKILL.md'), 'utf8').replace(/\r\n/g, '\n');
  const frontmatter = () => {
    const block = text().match(/^---\n([\s\S]*?)\n---\n/)?.[1] ?? '';
    return Object.fromEntries(block.split('\n').map((line) => [line.slice(0, line.indexOf(':')), line.slice(line.indexOf(':') + 1).trim()]));
  };

  it('is named starmemory, the name the start-up reminder tells the model to load', () => {
    expect(frontmatter().name).toBe('starmemory');
    expect(fs.readFileSync(path.join(root, 'hooks', 'reminder.sh'), 'utf8')).toContain('load the starmemory skill');
  });

  it('has a description that says when to use it, short enough for a skill listing', () => {
    const description = frontmatter().description;
    expect(description.length).toBeGreaterThan(100);
    expect(description.length).toBeLessThanOrEqual(1024);
    for (const trigger of ['last time', 'we discussed', 'Cowork', 'not to record']) expect(description).toContain(trigger);
  });

  // test/mcp-cowork.test.ts pins these as the server's tool list.
  it('names the four tools the server registers', () => {
    for (const tool of ['search', 'read', 'remember', 'forget']) expect(text()).toContain(`\`${tool}\``);
  });

  it('names every tool the server source registers, so a new one is not left out', () => {
    const source = fs.readFileSync(path.join(root, 'src', 'mcp-server.ts'), 'utf8');
    const registered = [...source.matchAll(/registerTool\(\s*'([a-z_]+)'/g)].map((m) => m[1]);
    expect(registered).toEqual(expect.arrayContaining(['search', 'read', 'remember', 'forget']));
    for (const tool of registered) expect(text()).toContain(`\`${tool}\``);
  });

  it('names the tools as Cowork serves them, under the server name desktop-install registers', () => {
    expect(text()).toContain('mcp__remote-devices__<server>__search');
    expect(text()).toContain(`\`${DEFAULT_SERVER_NAME}\``);
  });

  const section = (heading: string) => text().split(`\n## ${heading}\n`)[1]?.split('\n## ')[0] ?? '';
  const command = (s: string) => s.match(/^\s*(claude plugin marketplace add \S+ && .* desktop-install --restart)$/m)?.[1];

  it('gives the same install command as the README', () => {
    const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
    expect(command(text())).toBeDefined();
    expect(command(text())).toBe(command(readme));
  });

  // `marketplace add` and `install` exit 0 without changing anything when they
  // find an earlier install, so only the two updates bring that one forward.
  it('gives an install command that also upgrades, from wherever Claude Code keeps its plugins', () => {
    const marketplace = read('.claude-plugin/marketplace.json').name;
    const plugin = read('.claude-plugin/plugin.json').name;
    expect(command(text())?.split(' && ')).toEqual([
      'claude plugin marketplace add albericliu0/starmemory',
      `claude plugin marketplace update ${marketplace}`,
      `claude plugin install ${plugin}`,
      `claude plugin update ${plugin}`,
      `node "\${CLAUDE_CONFIG_DIR:-$HOME/.claude}/plugins/marketplaces/${marketplace}/cli/starmemory.mjs" desktop-install --restart`,
    ]);
    expect(text()).not.toContain('~/.claude/');
  });

  it('counts a server under the name installs had before the rename, which desktop-install replaces', () => {
    const check = section('When the tools are missing, in Cowork');
    expect(check).toContain('`starmem`');
    expect(check).toContain(`replaces it with \`${DEFAULT_SERVER_NAME}\``);
  });

  it('tells a session that has search and read but not remember and forget how to update the Mac', () => {
    const older = section('When only search and read are there, in Cowork');
    expect(older).toContain('the command in step 4');
  });
});

describe('.mcp.json (read by Codex)', () => {
  const server = () => read('.mcp.json').mcpServers.starmemory;

  it('uses paths relative to the plugin root, never CLAUDE_PLUGIN_ROOT', () => {
    const s = server();
    expect(s.cwd).toBe('.');
    for (const arg of s.args) {
      expect(arg).not.toContain('CLAUDE_PLUGIN_ROOT');
      expect(fs.existsSync(path.join(root, arg))).toBe(true);
    }
  });

  it('launches the same server the Claude Code manifest does', () => {
    const claude = read('.claude-plugin/plugin.json').mcpServers.starmemory;
    const strip = (a: string) => a.replace('${CLAUDE_PLUGIN_ROOT}/', './');
    expect(server().command).toBe(claude.command);
    expect(server().args).toEqual(claude.args.map(strip));
  });
});

describe('hooks.json', () => {
  it('resolves the plugin root through PLUGIN_ROOT first, which is the name Codex sets', () => {
    const hooks = read('hooks/hooks.json').hooks.SessionStart;
    for (const group of hooks) {
      for (const h of group.hooks) expect(h.command).toContain('${PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT}}');
    }
  });

  it('also fires after a compaction, so a session that runs for days is synced at each compact', () => {
    const hooks = read('hooks/hooks.json').hooks.SessionStart;
    for (const group of hooks) {
      expect(group.matcher.split('|')).toEqual(expect.arrayContaining(['startup', 'resume', 'clear', 'compact']));
    }
  });

  // Behaviour is in test/hooks.test.ts; this is the wiring.
  it('runs the reminder at session start and on prompts, from the script that ships', () => {
    const hooks = read('hooks/hooks.json').hooks;
    const reminders = (event: string) =>
      hooks[event].flatMap((g: { hooks: { command: string }[] }) => g.hooks.map((h) => h.command)).filter((c: string) => c.includes('/hooks/reminder.sh'));

    expect(reminders('SessionStart')).toEqual([expect.stringMatching(/reminder\.sh" session-start$/)]);
    expect(reminders('UserPromptSubmit')).toEqual([expect.stringMatching(/reminder\.sh" prompt$/)]);
    for (const command of reminders('UserPromptSubmit')) expect(command).toContain('${PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT}}');
    expect(fs.existsSync(path.join(root, 'hooks', 'reminder.sh'))).toBe(true);
  });

  it('keeps the sync out of a Cowork container, or any cloud container, before anything looks for node', () => {
    const sync = read('hooks/hooks.json').hooks.SessionStart[0].hooks.find((h: { command: string }) => h.command.includes('starmemory.mjs'));
    expect(sync.command.startsWith('case "${CLAUDE_CODE_REMOTE:-}:${CLAUDE_CODE_ENTRYPOINT:-}" in true:*|*:remote_cowork*) ;; *) sh ')).toBe(true);
  });
});

describe('local Codex marketplace', () => {
  it('lists this directory as the plugin source', () => {
    const m = read('.agents/plugins/marketplace.json');
    expect(m.plugins[0].name).toBe('starmemory');
    expect(m.plugins[0].source.url).toBe('./');
  });
});

// Design doc windows-support §08: Windows has no `sh`, so the node-finding
// shim exists twice. The manifests still name the sh one; see the .cmd header.
describe('Windows launcher', () => {
  it('ships beside run-node.sh and searches the usual node homes', () => {
    const cmd = fs.readFileSync(path.join(root, 'cli', 'run-node.cmd'), 'utf8');
    expect(cmd).toContain('nodejs\\node.exe');
    expect(cmd).toContain('NVM_SYMLINK');
    expect(cmd).toContain('FNM_DIR');
    expect(cmd).toContain('exit /b 127');
  });

  it('keeps the detached sync from opening a console window on Windows', () => {
    const source = fs.readFileSync(path.join(root, 'cli', 'starmemory.mjs'), 'utf8');
    expect(source).toContain('windowsHide: true');
  });
});
