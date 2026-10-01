#!/bin/sh
# Standing instruction for the model: use starmemory in this session.
#
# A skill loads only when the model decides a task needs it, and in Cowork a
# session is recorded only if the model writes the record, so waiting for it to
# think of memory loses the start of every session. This prints a short
# instruction instead: plain stdout from these two hook events becomes context,
# in Claude Code, in Cowork (which runs plugin hooks in its container) and in
# Codex.
#
# Two triggers, because neither covers every case alone:
#   session-start  SessionStart: startup, resume, clear, compact. Always prints,
#                  since a compacted conversation has lost the earlier copy.
#   prompt         UserPromptSubmit, every message. Prints only when this
#                  session has not had it yet: Cowork fires no SessionStart for
#                  a plugin that arrives in a session already open.
#
# Once per session is a marker file named after the session id, under the
# user's own home rather than a shared /tmp, where someone else could plant a
# link where a marker goes. Without a session id or a home there is no
# marker, so a prompt then prints nothing and session start alone reminds.
# POSIX sh and nothing else, so it costs nothing where the plugin's node
# dependencies are not installed, and every path exits 0: a failing hook would
# complain on every message. STARMEMORY_REMINDER=0 turns it off.
[ "${STARMEMORY_REMINDER:-1}" = "0" ] && exit 0
# A summarizer child is handed a conversation to summarise
# (src/summarizer-claude.ts), and an instruction to go and use tools would
# derail it.
[ "${STARMEMORY_SUMMARIZER_GUARD:-}" = "1" ] && exit 0

EVENT="${1:-session-start}"

# The hook input is one line of JSON on stdin; only the session id is needed.
# Anything but a plain id is ignored, since it is printed and used as a file
# name: the pattern is remember's session key pattern, so "." and ".." are out.
IN=""
[ -t 0 ] || IN=$(cat 2>/dev/null)
SID=$(printf '%s' "$IN" | sed -n 's/.*"session_id"[[:space:]]*:[[:space:]]*"\([A-Za-z0-9][A-Za-z0-9._-]\{0,119\}\)".*/\1/p' | head -n 1)
[ -n "$SID" ] || SID=$(printf '%s' "${CLAUDE_CODE_SESSION_ID:-}" | sed -n '/^[A-Za-z0-9][A-Za-z0-9._-]\{0,119\}$/p')

MARKS="${HOME:-}/.cache/starmemory/reminders"
[ -n "${HOME:-}" ] || MARKS=""
MARK=""
[ -n "$MARKS" ] && [ -n "$SID" ] && MARK="$MARKS/$SID"
if [ "$EVENT" = "prompt" ]; then
  [ -n "$MARK" ] || exit 0
  [ -f "$MARK" ] && exit 0
fi

PREAMBLE="starmemory: a standing instruction from the starmemory plugin. Follow it without being asked. A request in the user's own message wins for that message, and if the user has said to leave starmemory off, leave it off."

# remote_cowork, and remote_cowork_trigger for a scheduled Cowork task. Any
# other cloud container (CLAUDE_CODE_REMOTE, Claude Code on the web for one)
# is neither: its transcript never reaches the user's computer, and no server
# there can keep a record that outlasts it, so there is nothing to say.
case "${CLAUDE_CODE_ENTRYPOINT:-}" in
  remote_cowork*) COWORK=1 ;;
  *) COWORK="" ;;
esac
[ -z "$COWORK" ] && [ "${CLAUDE_CODE_REMOTE:-}" = "true" ] && exit 0

if [ -n "$COWORK" ]; then
  printf '%s\n\n' "$PREAMBLE"
  printf '%s\n\n' "Before your first reply in this session, load the starmemory skill and follow it. In short: search past sessions with its search tool before answering anything that may have come up before, and before saying you do not know. Record this session with its remember tool as it goes: a first entry as soon as the session has a subject, then one at each decision, finding or milestone. If the user asks not to record this session, call forget. The tools are search, read, remember and forget, which the Claude app serves as mcp__remote-devices__<server>__<tool>; when they are missing, the skill says how to offer the setup, once."
  if [ -n "$SID" ]; then
    printf 'This session'"'"'s key for remember and forget: %s\n' "$SID"
  else
    printf '%s\n' "No session id reached this hook. Pick one key now, cowork-<today's date>-<8 random letters or digits>, and use it for remember and forget for the whole session."
  fi
else
  printf '%s\n\n' "$PREAMBLE"
  printf '%s\n' "Past Claude Code, Codex and Cowork sessions are searchable with the starmemory search tool. Search before answering anything that may have come up before, such as \"last time\", \"we discussed\" or \"why did we\", and before saying you do not know. Load the starmemory skill the first time you need it, and follow it. This session is indexed on its own, so do not call remember."
  if [ -n "$SID" ]; then
    printf 'If the user asks not to record this session, call forget with this session'"'"'s id: %s\n' "$SID"
  else
    printf '%s\n' "If the user asks not to record this session, call forget with this session's id: the name of its transcript file, or for Codex the id that file name ends in."
  fi
fi

if [ -n "$MARK" ]; then
  mkdir -p "$MARKS" 2>/dev/null && : > "$MARK" 2>/dev/null
  # Markers are empty files. Clear out ones from sessions a fortnight gone.
  find "$MARKS" -type f -mtime +14 -exec rm -f {} + 2>/dev/null
fi
exit 0
