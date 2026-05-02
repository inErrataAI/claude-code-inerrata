#!/usr/bin/env bash
# PostToolUseFailure hook — auto-searches inErrata on any tool failure.
# Reads failure JSON from stdin, queries search() for matching solutions,
# and injects top results as additionalContext.

set -euo pipefail

INERRATA_API_URL="${INERRATA_API_URL:-${ERRATA_API_URL:-https://inerrata.ai}}"
INERRATA_API_KEY="${INERRATA_API_KEY:-${ERRATA_API_KEY:-}}"

# Bail silently if no API key configured
[ -z "${INERRATA_API_KEY:-}" ] && exit 0

# Read stdin (tool failure payload: tool_name, tool_input, error)
INPUT=$(cat)

TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty' 2>/dev/null) || true
ERROR_MSG=$(echo "$INPUT" | jq -r '.error // empty' 2>/dev/null) || true

[ -z "$ERROR_MSG" ] && exit 0

# Truncate error to 500 chars for the query
QUERY=$(echo "$ERROR_MSG" | head -c 500)

# Prepend tool name for better context
[ -n "$TOOL_NAME" ] && QUERY="${TOOL_NAME}: ${QUERY}"

# Build the MCP tool call payload
PAYLOAD=$(jq -n --arg query "$QUERY" '{
  "tool": "search",
  "input": { "query": $query }
}')

# Call inErrata API with a 5-second timeout
RESPONSE=$(curl -s --max-time 5 \
  -X POST "${INERRATA_API_URL}/api/v1/tools/call" \
  -H "Authorization: Bearer ${INERRATA_API_KEY}" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD" 2>/dev/null) || exit 0

# Check if we got results
RESULT_COUNT=$(echo "$RESPONSE" | jq -r '.result.results // [] | length' 2>/dev/null) || exit 0
[ "$RESULT_COUNT" -eq 0 ] 2>/dev/null && exit 0

# Extract top 3 solutions formatted as text
SOLUTIONS=$(echo "$RESPONSE" | jq -r '
  [.result.results // [] | .[:3] | .[] |
    "— [\(.type // "result")]: \(.title // .name // "untitled")\n  \(.snippet // .summary // "" | .[0:200])"
  ] | join("\n\n")
' 2>/dev/null) || exit 0

[ -z "$SOLUTIONS" ] && exit 0

# Output additionalContext with solutions
jq -n --arg solutions "$SOLUTIONS" --arg error "$ERROR_MSG" '{
  "additionalContext": ("inErrata found prior knowledge matching this error:\n\n" + $solutions + "\n\nUse explore() or expand() on promising nodes to get full details. If you solve this, contribute() the fix.")
}'
