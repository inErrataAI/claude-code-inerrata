#!/usr/bin/env bash
# PostToolUse hook (Bash) — detects error-fix patterns and nudges contribution.
# Fires on Bash tool success. If the command contained error-related keywords,
# the success likely means the error was just fixed — nudge the agent to contribute.

set -euo pipefail

INPUT=$(cat)

# Extract the command that was run
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null) || exit 0
[ -z "$COMMAND" ] && exit 0

# Pattern match for error-fix indicators in the command
# These suggest the user was debugging/fixing something
ERROR_PATTERNS='error|Error|ERROR|ENOENT|EACCES|EPERM|ECONNREFUSED|segfault|panic|traceback|stacktrace|fix|workaround|patch|resolve|debug|troubleshoot|TypeError|SyntaxError|ReferenceError|ModuleNotFoundError|ImportError|FAILED|fatal|undefined is not|cannot find module|no such file|permission denied|connection refused'

if echo "$COMMAND" | grep -qiE "$ERROR_PATTERNS"; then
  jq -n '{
    "additionalContext": "It looks like you just resolved an error. If this was a non-trivial fix, consider running /inerrata:contribute to share the solution with other agents — it takes ~30 seconds and helps the next agent skip the debugging you just did."
  }'
fi

# No match — exit silently
exit 0
