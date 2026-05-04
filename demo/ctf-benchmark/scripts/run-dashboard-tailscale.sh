#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
PROJECT_ROOT=$(cd -- "$SCRIPT_DIR/.." && pwd)

PORT=${PORT:-5558}
ORCHESTRATOR_URL=${ORCHESTRATOR_URL:-http://127.0.0.1:5556}
LOG_FILE=${LOG_FILE:-"$PROJECT_ROOT/results/run-logs/dashboard-$(date +%Y%m%d-%H%M%S).log"}

mkdir -p "$(dirname "$LOG_FILE")"
exec >>"$LOG_FILE" 2>&1

load_inerrata_key() {
  if [[ -n "${INERRATA_API_KEY:-}" ]]; then
    return 0
  fi

  local env_file=${INERRATA_ENV_FILE:-"$HOME/.inerrata-env"}
  if [[ ! -f "$env_file" ]]; then
    return 0
  fi

  local key_line
  key_line=$(
    sed -n -E 's/^(export[[:space:]]+)?INERRATA_API_KEY=(.*)$/\2/p' "$env_file" |
      head -n 1
  )

  if [[ -z "$key_line" ]]; then
    return 0
  fi

  key_line=${key_line%\"}
  key_line=${key_line#\"}
  key_line=${key_line%\'}
  key_line=${key_line#\'}
  export INERRATA_API_KEY=$key_line
}

load_inerrata_key

if [[ -x "$HOME/.local/share/fnm/fnm" ]]; then
  eval "$("$HOME/.local/share/fnm/fnm" env --shell bash)"
fi

node -e 'if (!globalThis.Request) process.exit(1)' || {
  echo "[dashboard] Node $(node -v 2>/dev/null || echo unavailable) does not provide global Request." >&2
  echo "[dashboard] Install/use Node 18+ before starting the dashboard." >&2
  exit 1
}

echo "[dashboard] Starting CTF Cold-To-Warm Demo dashboard"
echo "[dashboard] Project: $PROJECT_ROOT"
echo "[dashboard] URL: http://127.0.0.1:$PORT/"
echo "[dashboard] Orchestrator: $ORCHESTRATOR_URL"

cd "$PROJECT_ROOT"
exec npx tsx dashboard/serve.ts --port "$PORT" --orchestrator-url "$ORCHESTRATOR_URL"
