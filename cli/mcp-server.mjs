#!/usr/bin/env node
// Never in a cloud container, Claude Code on the web's or a Cowork session's:
// a store there goes when the container does, and a Cowork session reaches the
// one on the user's computer through the Claude app instead. Checked before
// anything else, so nothing is installed or started there.
if (process.env.CLAUDE_CODE_REMOTE === 'true' || (process.env.CLAUDE_CODE_ENTRYPOINT ?? '').startsWith('remote_cowork')) {
  process.stderr.write("starmemory: not starting the MCP server in a cloud container, whose store would be thrown away with it; Cowork reaches the one on the user's computer through the Claude app.\n");
  process.exit(0);
}

// MCP entry point named by .claude-plugin/plugin.json. Ensures the plugin can
// actually run, then hands off to the compiled server.
import { ensureReady, handOff } from './bootstrap.mjs';

if (!(await ensureReady())) {
  process.stderr.write('starmemory: not starting the MCP server (see above).\n');
  process.exit(1);
}

// Every launcher desktop-install has copied imports this file in its own
// process, and nothing but desktop-install copies one again: replace a
// launcher older than this copy's, for the app's next start.
try {
  const { refreshLauncher } = await import('./desktop-install.mjs');
  if (refreshLauncher()) process.stderr.write("starmemory: updated the Claude app's launcher, which it runs from its next start.\n");
} catch (error) {
  process.stderr.write(`starmemory: could not update the Claude app's launcher: ${error.message}\n`);
}

handOff('dist/mcp-server.js');
