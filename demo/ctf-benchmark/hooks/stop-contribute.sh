#!/usr/bin/env bash
# Stop hook — extracts and contributes solved problems when a session ends.
# If ollama is available locally, attempts auto-extraction via local LLM.
# Otherwise, nudges the agent to contribute manually.

set -euo pipefail

# jq is required for JSON output; bail silently if missing
command -v jq >/dev/null 2>&1 || exit 0

# Guard against re-entrancy
[ "${stop_hook_active:-}" = "1" ] && exit 0

# CTF Cold-To-Warm Demo waves explicitly control whether write tools are allowed.
if [ -n "${CTF_CAN_CONTRIBUTE:-}" ] && [ "${CTF_CAN_CONTRIBUTE}" != "true" ]; then
  exit 0
fi

# Check if any code changes were made this session
if git -C "$(dirname "$0")/../.." diff --quiet HEAD 2>/dev/null; then
  exit 0
fi

INERRATA_API_URL="${INERRATA_API_URL:-${ERRATA_API_URL:-https://inerrata.ai}}"
SOURCE_TAG="${CTF_AGENT_SOURCE:-}"
if [ -z "$SOURCE_TAG" ] && [ -n "${CTF_WAVE_LABEL:-}" ]; then
  SOURCE_TAG="ctf-bench-${CTF_WAVE_LABEL}"
fi

# Attempt auto-extraction via local LLM if ollama is available
if command -v ollama >/dev/null 2>&1 && [ -n "${INERRATA_API_KEY:-}" ]; then
  # Get a summary of changes made this session
  DIFF_SUMMARY=$(git -C "$(dirname "$0")/../.." diff HEAD --stat 2>/dev/null | tail -20) || DIFF_SUMMARY=""
  RECENT_COMMITS=$(git -C "$(dirname "$0")/../.." log --oneline -5 2>/dev/null) || RECENT_COMMITS=""

  if [ -n "$DIFF_SUMMARY" ] || [ -n "$RECENT_COMMITS" ]; then
    EXTRACT_PROMPT="Given these code changes, extract any solved problems suitable for a knowledge base. For each, output JSON with fields: title, problem, solution, tags. Only include non-trivial fixes. If nothing qualifies, output empty array [].

Changes:
${DIFF_SUMMARY}

Recent commits:
${RECENT_COMMITS}"

    # Run extraction through local LLM with a 15-second timeout
    EXTRACTION=$(echo "$EXTRACT_PROMPT" | timeout 15 ollama run llama3.2:3b 2>/dev/null) || EXTRACTION=""

    if [ -n "$EXTRACTION" ] && echo "$EXTRACTION" | jq -e '. | length > 0' >/dev/null 2>&1; then
      # Post each extracted problem to inErrata
      POSTED=0
      echo "$EXTRACTION" | jq -c '.[]' 2>/dev/null | while read -r item; do
        PAYLOAD=$(echo "$item" | jq --arg source "$SOURCE_TAG" '{
          "tool": "contribute",
          "input": {
            "title": .title,
            "problem": .problem,
            "solution": .solution,
            "tags": ((.tags // []) + (if $source == "" then [] else [$source] end))
          }
        }')

        curl -s --max-time 5 \
          -X POST "${INERRATA_API_URL}/api/v1/tools/call" \
          -H "Authorization: Bearer ${INERRATA_API_KEY}" \
          -H "Content-Type: application/json" \
          -d "$PAYLOAD" >/dev/null 2>&1 && POSTED=$((POSTED + 1)) || true
      done

      if [ "${POSTED:-0}" -gt 0 ]; then
        jq -n --arg count "$POSTED" '{
          "additionalContext": ("Auto-contributed " + $count + " solved problem(s) to inErrata via local LLM extraction.")
        }'
        exit 0
      fi
    fi
  fi
fi

# Fallback: nudge the agent to contribute manually
cat <<'JSON'
{
  "additionalContext": "You made code changes this session. Before finishing, consider running /inerrata:contribute to post any solved problems to the inErrata knowledge base."
}
JSON
