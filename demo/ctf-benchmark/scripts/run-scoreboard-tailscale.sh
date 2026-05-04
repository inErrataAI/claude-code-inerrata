#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
PROJECT_ROOT=$(cd -- "$SCRIPT_DIR/.." && pwd)

PORT=${PORT:-5556}
FRAMING=${FRAMING:-equalization}
AGENTS_PER_WAVE=${AGENTS_PER_WAVE:-1}
PARALLEL=${PARALLEL:-4}
TIMEOUT_MINUTES=${TIMEOUT_MINUTES:-30}
MAX_OUTPUT_TOKENS=${MAX_OUTPUT_TOKENS:-${CTF_MAX_OUTPUT_TOKENS:-8192}}
RUN_STAMP=${RUN_STAMP:-$(date +%Y%m%d-%H%M%S)}
RESULTS_DIR=${RESULTS_DIR:-"$PROJECT_ROOT/results/live-scoreboard-$RUN_STAMP"}
LOG_FILE=${LOG_FILE:-"$PROJECT_ROOT/results/run-logs/benchmark-$RUN_STAMP.log"}
CTF_QWEN_MODEL=${CTF_QWEN_MODEL:-qwen3:14b}
DEFAULT_CTF_INERRATA_API_URL=${DEFAULT_CTF_INERRATA_API_URL:-http://127.0.0.1:3100}

mkdir -p "$(dirname "$LOG_FILE")" "$RESULTS_DIR"
exec >>"$LOG_FILE" 2>&1

load_env_var() {
  local var_name=$1
  if [[ -n "${!var_name:-}" ]]; then
    return 0
  fi

  local env_file=${INERRATA_ENV_FILE:-"$HOME/.inerrata-env"}
  if [[ ! -f "$env_file" ]]; then
    return 1
  fi

  local value_line
  value_line=$(
    sed -n -E "s/^(export[[:space:]]+)?${var_name}=(.*)$/\\2/p" "$env_file" |
      head -n 1
  )

  if [[ -z "$value_line" ]]; then
    return 1
  fi

  value_line=${value_line%\"}
  value_line=${value_line#\"}
  value_line=${value_line%\'}
  value_line=${value_line#\'}
  export "$var_name=$value_line"
}

load_inerrata_key() {
  if load_env_var INERRATA_API_KEY; then
    return 0
  fi

  if load_env_var ERRATA_API_KEY; then
    export INERRATA_API_KEY=$ERRATA_API_KEY
    return 0
  fi

  return 1
}

is_local_url() {
  local url=$1
  [[ "$url" =~ ^https?://(127\.0\.0\.1|localhost|\[::1\])(:|/|$) ]]
}

validate_inerrata_key() {
  [[ -n "${INERRATA_API_KEY:-}" ]] || return 1
  curl -fsS --max-time 5 \
    -H "Authorization: Bearer ${INERRATA_API_KEY}" \
    "${INERRATA_API_URL}/api/v1/me" >/dev/null 2>&1
}

provision_local_inerrata_key() {
  local handle="ctf-local-${RUN_STAMP}-${RANDOM}"
  local response
  response=$(
    curl -fsS --max-time 10 \
      -X POST "${INERRATA_API_URL}/api/v1/agents/register" \
      -H 'Content-Type: application/json' \
      -d "{\"handle\":\"${handle}\"}"
  )

  local api_key
  api_key=$(
    node -e "const fs=require('fs'); const data=JSON.parse(fs.readFileSync(0,'utf8')); if (!data.apiKey) process.exit(1); process.stdout.write(data.apiKey)" \
      <<<"$response"
  )
  export INERRATA_API_KEY=$api_key
  echo "[scoreboard] Provisioned local CTF API key for ${handle}."
}

load_env_var CTF_INERRATA_API_URL || load_env_var INERRATA_API_URL || load_env_var ERRATA_API_URL || true
export INERRATA_API_URL="${CTF_INERRATA_API_URL:-${INERRATA_API_URL:-${ERRATA_API_URL:-$DEFAULT_CTF_INERRATA_API_URL}}}"
INERRATA_API_URL=${INERRATA_API_URL%/}
export INERRATA_API_URL

load_env_var CTF_INERRATA_MCP_URL || load_env_var INERRATA_MCP_URL || load_env_var ERRATA_MCP_URL || true
export INERRATA_MCP_URL="${CTF_INERRATA_MCP_URL:-${INERRATA_MCP_URL:-${ERRATA_MCP_URL:-${INERRATA_API_URL}/mcp}}}"
INERRATA_MCP_URL=${INERRATA_MCP_URL%/}
export INERRATA_MCP_URL

if [[ "${CTF_ALLOW_REMOTE_INERRATA:-0}" != "1" ]]; then
  if ! is_local_url "$INERRATA_API_URL" || ! is_local_url "$INERRATA_MCP_URL"; then
    echo "[scoreboard] Refusing remote inErrata endpoint for local CTF run." >&2
    echo "[scoreboard] API=$INERRATA_API_URL MCP=$INERRATA_MCP_URL" >&2
    echo "[scoreboard] Set CTF_ALLOW_REMOTE_INERRATA=1 only for an intentional remote run." >&2
    exit 1
  fi
fi

load_env_var INERRATA_ADMIN_SECRET || load_env_var CTF_GRAPH_CLEANUP_SECRET || load_env_var ADMIN_SECRET || load_env_var INERRATA_ADMIN_PASS || true
if is_local_url "$INERRATA_API_URL" && [[ -z "${INERRATA_ADMIN_SECRET:-}${CTF_GRAPH_CLEANUP_SECRET:-}${ADMIN_SECRET:-}${INERRATA_ADMIN_PASS:-}" ]]; then
  export INERRATA_ADMIN_SECRET=ctf-admin-secret
fi


if [[ -x "$HOME/.local/share/fnm/fnm" ]]; then
  eval "$("$HOME/.local/share/fnm/fnm" env --shell bash)"
fi

node -e 'if (!globalThis.Request) process.exit(1)' || {
  echo "[scoreboard] Node $(node -v 2>/dev/null || echo unavailable) does not provide global Request." >&2
  echo "[scoreboard] Install/use Node 18+ before starting the dashboard." >&2
  exit 1
}

load_inerrata_key || true
if is_local_url "$INERRATA_API_URL"; then
  if ! validate_inerrata_key; then
    provision_local_inerrata_key
  fi
elif [[ -z "${INERRATA_API_KEY:-}" ]]; then
  echo "[scoreboard] INERRATA_API_KEY is missing for remote inErrata endpoint." >&2
  exit 1
fi

export CTF_QWEN_MODEL
export CTF_MAX_OUTPUT_TOKENS=$MAX_OUTPUT_TOKENS

args=(
  benchmark/orchestrator.ts
  --framing "$FRAMING"
  --port "$PORT"
  --results-dir "$RESULTS_DIR"
  --agents-per-wave "$AGENTS_PER_WAVE"
  --parallel "$PARALLEL"
  --timeout "$TIMEOUT_MINUTES"
)

if [[ -n "${CHALLENGE:-}" ]]; then
  args+=(--challenge "$CHALLENGE")
fi

if [[ -n "${MAX_DIFFICULTY:-}" ]]; then
  args+=(--max-difficulty "$MAX_DIFFICULTY")
fi

echo "[scoreboard] Starting CTF Cold-To-Warm Demo scoreboard"
echo "[scoreboard] Project: $PROJECT_ROOT"
echo "[scoreboard] URL: http://127.0.0.1:$PORT/"
echo "[scoreboard] Framing: $FRAMING"
echo "[scoreboard] Agents/wave override: $AGENTS_PER_WAVE"
echo "[scoreboard] Parallel: $PARALLEL"
echo "[scoreboard] Max output tokens: $MAX_OUTPUT_TOKENS"
echo "[scoreboard] Results: $RESULTS_DIR"
echo "[scoreboard] Qwen model: $CTF_QWEN_MODEL"
echo "[scoreboard] inErrata API: $INERRATA_API_URL"
echo "[scoreboard] inErrata MCP: $INERRATA_MCP_URL"
echo "[scoreboard] Graph cleanup auth: $([[ -n "${INERRATA_ADMIN_SECRET:-}${CTF_GRAPH_CLEANUP_SECRET:-}${ADMIN_SECRET:-}${INERRATA_ADMIN_PASS:-}" ]] && echo enabled || echo missing)"

cd "$PROJECT_ROOT"
exec npx tsx "${args[@]}"
