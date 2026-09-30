# starmemory

Search your past Claude Code, Codex and Cowork sessions from inside any of them.

starmemory indexes every transcript Claude Code and Codex write to disk into
one local store, and exposes MCP tools: `search` (hybrid: BM25 over Tantivy
plus HNSW vectors over usearch, fused by reciprocal rank) and `read` (the full
transcript). It keeps its own gzip copy of each transcript so search results
still open after Claude Code's 30-day cleanup, writes a short summary beside
each conversation once it has gone quiet, and forgets conversations older than
a configurable TTL.

Cowork keeps no transcript on your machine, so there the model records the
session itself with `remember`; `forget` takes any session back out. See
[Use it in Cowork](#use-it-in-cowork).

Everything runs on your machine. Nothing leaves it except the summary
requests, which go through your own Claude Code or Codex login.

## Requirements

- Node 22 or newer on the machine.
- One of: macOS on Apple Silicon (`darwin-arm64`), Linux x64 or arm64
  (`linux-x64`, `linux-arm64`, including WSL), Windows x64 (`win32-x64`).
  The native index engine is a prebuilt binary; darwin-arm64 ships in the
  plugin, the others are fetched from the matching GitHub release on first run
  and verified against its `SHA256SUMS`.
- About 700 MB of disk for dependencies and the bilingual embedding model
  (jina-embeddings-v2-base-zh), installed on first run.

## Install in Claude Code

```
claude plugin marketplace add albericliu0/starmemory
claude plugin install starmemory
```

Restart Claude Code (a running session keeps the MCP server it started with).
The first start installs dependencies and downloads the model; the first
`search` after that takes a minute while the model loads, then it is fast.

Check it is connected with `/mcp`. Then ask Claude something like "what did we
decide about the index rebuild last week" and it will call `search`.

To update later:

```
claude plugin update starmemory
```

## Install in Codex

```
codex plugin marketplace add albericliu0/starmemory
```

Start Codex, open `/plugins`, and install `starmemory`. Then enable plugin
hooks and trust ours:

```
codex features enable plugin_hooks
```

Open `/hooks` in Codex, select each starmemory hook and press `t` to trust it:
the `SessionStart` sync, and the reminder that runs at `SessionStart` and on
`UserPromptSubmit`. Codex does not run a plugin's hooks until you have. Without
the sync, the MCP tools work but nothing new gets indexed.

Codex conversations are summarised through `codex app-server`, which needs
codex-cli 0.130.0 or newer.

## Use it in Cowork

A Cowork session runs in a cloud container that is thrown away afterwards, so
its transcript never reaches your Mac, and plugin MCP servers do not start
there. starmemory works with both facts:

- **The server runs on your Mac**, registered with the Claude desktop app,
  which serves it to every Cowork session linked to that Mac as
  `mcp__remote-devices__starmemserver__search`, `read`, `remember` and `forget`.
- **The plugin, added to Cowork**, brings the `starmemory` skill and a
  start-up hook that tells each session to use it. The model searches past
  sessions before answering, and records the session itself with `remember`
  as it goes.

### Install

On the Mac where the Claude app runs, with Node 22 or newer and Claude Code,
paste this into Terminal. It is also the whole install for a colleague:

```
claude plugin marketplace add albericliu0/starmemory && claude plugin install starmemory && node ~/.claude/plugins/marketplaces/starmemory/cli/starmemory.mjs desktop-install --restart
```

It installs the plugin in Claude Code and its dependencies, adds the server to
the app's `claude_desktop_config.json` (backed up first, every other server
left as it was, only server names printed), and quits and reopens the Claude
app. Then add the plugin in Cowork too, from the Customize menu, pointing it at
this repository or uploading the zip `npm run package` builds, so the skill and
the start-up hook reach Cowork sessions. The first time a session finds the
tools missing, the skill offers this setup once and remembers the answer.

About `desktop-install`:

- Without `--restart` it refuses to edit the config while the app is running,
  since the app can overwrite changes made while it is open. `--restart` is
  macOS only; on Windows, quit the app from the tray first. The config is
  `~/Library/Application Support/Claude/claude_desktop_config.json` on macOS
  and `%APPDATA%\Claude\claude_desktop_config.json` on Windows.
- Run it in Terminal. From a session inside the Claude app, such as Claude
  Code in the app's Code tab, it refuses and changes nothing, because it would
  have to quit the app that session runs in.
- The server is named `starmemserver`. The app refuses a local server whose name
  collides with one it reserves for its own tools, and it does not publish the
  list; it refused `cowork-episodic-memory`. If it reports a collision, run
  `desktop-install --name <another name>`, which also removes the refused entry.
  A name another server in the config already has is refused rather than
  overwritten, unless you add `--replace`.
- Each run leaves a backup of the config beside it, which holds the same
  credentials as the config. Delete the backups once the app works.
- The entry runs a small launcher in `~/.config/starmemory/desktop/`, which a
  newer plugin replaces, from the app's next start. The launcher starts the
  newest copy of starmemory Claude Code has installed from the same
  marketplace, so plugin updates reach Cowork without running `desktop-install`
  again. It prefers a copy whose dependencies are already installed, even an
  older one, so the app does not wait on npm install.
- `STARMEMORY_*` settings, `CLAUDE_CONFIG_DIR` and `CODEX_HOME` set in the
  shell that runs it are copied into the app's entry, so the app's server and
  Claude Code's share one store. Run it again after changing them.
- Without Claude Code, run it from a clone instead, which it then uses as it is:
  `git clone https://github.com/albericliu0/starmemory ~/starmemory && node ~/starmemory/cli/starmemory.mjs desktop-install --restart`.

### What gets recorded

Only what the model writes with `remember`. Each call adds one entry: what the
user asked, a one-line title, and what was found, decided, built or left open,
with the exact strings worth searching for later. Never the transcript: an entry
over a few thousand characters is refused. The model writes a first entry early
and another at each milestone, because a Cowork session has no end event to
wait for.

A session's entries go to one file,
`~/.config/starmemory/cowork/<project>/<session>.jsonl`, a synthetic transcript
in Claude Code's line shape that sync indexes like any other. Each `remember`
starts a background sync of the Cowork records alone, without the summary step,
so an entry is searchable within seconds; Claude Code and Codex transcripts are
left to the session-start sync. Results mark it `cowork`, the archive keeps a
copy, and the TTL applies. Records are not summarised again: they already are
summaries.

### Forgetting

When the user says "don't record this", in any words, the model calls `forget`.
It removes the session's record, archive copy and summary at once and hides the
session from `search` and `read` from that moment; the sync it starts then
deletes the indexed exchanges and their text-index documents, usually within a
minute. The text index has one writer at a time, so while another sync holds it
the new one waits for it, and the sync holding it takes on what arrived
meanwhile before it exits. `remember` refuses the session afterwards. A Claude
Code or Codex session id works too: that transcript stays where the harness
keeps it, but starmemory stops indexing it.

Forgotten sessions are listed in `~/.config/starmemory/forgotten.txt`. Deleting
a line lets starmemory index that transcript again from where it stopped,
including anything written while it was forgotten. The exchanges the forget
deleted stay deleted, so nothing is ever indexed twice; the archive copy is made
again from the transcript.
Deletion is ordinary deletion: LMDB reuses the freed pages, Tantivy drops
deleted documents at its next segment merge, and a vector-index file written in
the minute before is swept by a later sync, so until then the bytes can stay on
disk. The archive copy of a subagent's transcript that never got a whole
exchange goes at the next session-start sync rather than at once.

### Limits

- A Cowork session that never calls `remember` leaves nothing behind, and
  nothing can recover it later.
- A record holds what the model wrote, so its detail is fixed when it is
  written.
- The memory lives on one Mac. Cowork reaches it only while that Mac is on and
  the Claude app is running, and it does not reach teammates.
- Inside the Cowork container the SessionStart sync hook does nothing, so no
  dependencies are installed there; only the start-up reminder runs.

## What happens when

- **Session start** (and `--resume`, `/clear`, and after a compaction): a
  background sync copies new transcript lines into the archive, embeds and
  indexes them, summarises up to ten conversations that have been quiet for
  two hours, deletes forgotten sessions and conversations past the TTL. It
  runs detached, so the session does not wait for it. Its log is
  `~/.config/starmemory/sync.log`. In a Cowork container, or any other cloud
  container, it is skipped. A second start-up hook prints a short instruction
  to use starmemory, once per session.
- **`search`**: hybrid by default; `mode: "text"` or `"vector"` for one side
  only; an array of 2-5 concepts for AND matching; filters for project,
  session, harness (`claude`, `codex`, `cowork`) and date range. Each hit
  shows the conversation's summary when one exists.
- **`read`**: the transcript at a given path, optionally a line range. Only
  transcripts starmemory indexes and its archive copies of them.
- **`remember`**: one entry in this Cowork session's record, then a background
  sync. See [Use it in Cowork](#use-it-in-cowork).
- **`forget`**: takes a session out of the memory and never indexes it again.

Data lives under `~/.config/starmemory`: `store.mdb` (LMDB, the source of
truth), `index-v*.g*.hnsw` (vector index, rebuilt from the store),
`text-v*/` (Tantivy), `archive/<harness>/<project>/` (gzipped transcripts and
their `-summary.txt`), `cowork/<project>/` (Cowork records), `forgotten.txt`
(forgotten sessions) and `desktop/` (the launcher the Claude app runs).

## Configuration

All optional, all environment variables read by the plugin's processes.

| Variable | Default | Meaning |
|---|---|---|
| `STARMEMORY_TTL_DAYS` | `180` | Conversations quiet for longer are deleted everywhere. `0` disables. |
| `STARMEMORY_SUMMARY_LIMIT` | `10` | Summaries written per sync. `0` disables summaries. |
| `STARMEMORY_SUMMARY_MODEL` | `haiku` | Model for Claude Code conversation summaries (`sonnet` is the fallback). |
| `STARMEMORY_DB_PATH`, `STARMEMORY_INDEX_PATH`, `STARMEMORY_TEXT_INDEX_PATH`, `STARMEMORY_ARCHIVE_PATH`, `STARMEMORY_MODEL_CACHE_PATH`, `STARMEMORY_LOG_PATH`, `STARMEMORY_COWORK_PATH`, `STARMEMORY_FORGOTTEN_PATH` | under `~/.config/starmemory` | Where things live. The model cache (`models/`) is shared by every installed version, so a plugin update does not download the 160 MB embedding model again. |
| `STARMEMORY_REMINDER` | `1` | `0` turns off the start-up instruction to use starmemory. |
| `STARMEMORY_CODEX_BIN` | `codex` | The Codex binary used for summaries. |
| `STARMEMORY_ADDON_BASE_URL` | GitHub releases | Where to fetch the native addon from. Must be https. |

## Build from source

Needed only on a platform without a prebuilt binary, or to hack on it.
Requires a Rust toolchain.

```
npm install
npm run build        # cargo build --release, then tsc
npm test             # cargo test, then vitest
```

`npm run build:native` writes `native/starmemory_native.<platform>-<arch>.node`
for the machine it runs on. `npm run package` stages an installable copy under
`build-pkg/` from the committed tree.

## Status

Verified on macOS (daily use) and, through CI, on Linux x64 and arm64. Windows
x64 builds and passes the test suite in CI; two things still need a hand on a
real Windows install: whether Claude Code there can start the plugin through
`cli/run-node.cmd` (the manifests name the POSIX `sh` shim), and a full
session with the hook. The Codex integration is exercised against a fake
`app-server` in tests and has not yet been run inside a real Codex session.
The Cowork support is exercised in tests end to end over MCP and against
desktop configs in a temporary home; it has not yet been run against a real
Claude desktop app, so whether the app accepts the name `starmemserver` is
untested.

Design notes live outside the repo, in Chinese; ask if you want them.
