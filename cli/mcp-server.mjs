#!/usr/bin/env node
// MCP entry point named by .claude-plugin/plugin.json. Ensures the plugin can
// actually run, then hands off to the compiled server.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureReady, handOff } from './bootstrap.mjs';

// Started by the Claude app's launcher, which desktop-install copies to
// ~/.config/starmemory/desktop/launch.mjs and imports this in its own process:
// serve the Cowork records only unless the user opted in, as the launcher
// does. Set here too, since a launcher copied by an older desktop-install
// does not, and it is never copied again while it keeps finding this plugin.
try {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? os.homedir();
  const launcher = path.join(home, '.config', 'starmemory', 'desktop', 'launch.mjs');
  if (fs.realpathSync(process.argv[1]) === fs.realpathSync(launcher)) process.env.STARMEMORY_SCOPE ??= 'cowork';
} catch {
  // no launcher there, or started without a script path: not the app's server
}

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
