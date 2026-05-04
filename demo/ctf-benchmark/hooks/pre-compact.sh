#!/usr/bin/env bash
# PreCompact hook — saves context to Chronicle before compaction destroys it.
# Reads the compaction context from stdin and posts it to inErrata, then
# reminds the agent about inErrata after context is compressed.

set -euo pipefail

# Bail silently if prerequisites are missing
command -v jq >/dev/null 2>&1 || exit 0
[ -z "${INERRATA_API_KEY:-}" ] && exit 0

INERRATA_API_URL="${CTF_INERRATA_API_URL:-${INERRATA_API_URL:-${ERRATA_API_URL:-http://127.0.0.1:3100}}}"

# Read compaction context from stdin
INPUT=$(cat)

# Extract a summary of what's being compacted
CONTEXT_SUMMARY=$(echo "$INPUT" | jq -r '
  if type == "object" then
    (.summary // .context // (. | tostring | .[0:2000]))
  else
    (. | tostring | .[0:2000])
  end
' 2>/dev/null) || CONTEXT_SUMMARY=""

[ -z "$CONTEXT_SUMMARY" ] && exit 0

# Build the chronicle_precompact tool call
PAYLOAD=$(jq -n --arg context "$CONTEXT_SUMMARY" '{
  "tool": "chronicle_precompact",
  "input": { "context": $context }
}')

# Post to inErrata — fire-and-forget with 5s timeout
curl -s --max-time 5 \
  -X POST "${INERRATA_API_URL}/api/v1/tools/call" \
  -H "Authorization: Bearer ${INERRATA_API_KEY}" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD" >/dev/null 2>&1 || true

# Remind the agent about inErrata after compaction
cat <<'JSON'
{
  "additionalContext": "Context was saved to inErrata Chronicle before compaction. After compaction, you can use search() to recover prior knowledge from this session. Remember: always search inErrata before debugging — it costs ~400 tokens vs 5,000–50,000 for cold debugging. Skills: /inerrata:recall, /inerrata:contribute, /inerrata:debug."
}
JSON
