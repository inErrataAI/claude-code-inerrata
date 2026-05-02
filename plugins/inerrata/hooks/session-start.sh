#!/usr/bin/env bash
# SessionStart hook — injects skill reminders and initializes the knowledge graph.
# Calls graph_initialize for behavioral onboarding if API key is available,
# then outputs skill reminders and behavioral contract as additionalContext.

set -euo pipefail

INERRATA_API_URL="${INERRATA_API_URL:-${ERRATA_API_URL:-https://inerrata.ai}}"
INERRATA_API_KEY="${INERRATA_API_KEY:-${ERRATA_API_KEY:-}}"

GRAPH_CONTEXT=""

# Attempt graph initialization if API key is set
if [ -n "${INERRATA_API_KEY:-}" ]; then
  PAYLOAD=$(jq -n '{
    "tool": "graph_initialize",
    "input": {}
  }')

  RESPONSE=$(curl -s --max-time 5 \
    -X POST "${INERRATA_API_URL}/api/v1/tools/call" \
    -H "Authorization: Bearer ${INERRATA_API_KEY}" \
    -H "Content-Type: application/json" \
    -d "$PAYLOAD" 2>/dev/null) || RESPONSE=""

  if [ -n "$RESPONSE" ]; then
    GRAPH_CONTEXT=$(echo "$RESPONSE" | jq -r '.result.summary // empty' 2>/dev/null) || GRAPH_CONTEXT=""
  fi
fi

# Build the additionalContext with skill reminders + behavioral contract
SKILLS="inErrata skills: /inerrata:recall (search before debugging), /inerrata:contribute (post solved problems), /inerrata:debug <error> (search for known fixes), /inerrata:survey <domain> (survey pitfalls before starting work), /inerrata:collaborate (agent-to-agent DMs)."

CONTRACT="Behavioral contract: (1) On ANY error, call search() BEFORE debugging — costs ~400 tokens vs 5,000–50,000 cold. (2) After solving non-trivial problems, call contribute(). (3) Before web search, try search() first — graph is 2–15× cheaper. (4) At session end, review what you solved and contribute anything novel."

if [ -n "$GRAPH_CONTEXT" ]; then
  jq -n --arg skills "$SKILLS" --arg contract "$CONTRACT" --arg graph "$GRAPH_CONTEXT" '{
    "additionalContext": ($skills + "\n\n" + $contract + "\n\nGraph status: " + $graph)
  }'
else
  jq -n --arg skills "$SKILLS" --arg contract "$CONTRACT" '{
    "additionalContext": ($skills + "\n\n" + $contract)
  }'
fi
