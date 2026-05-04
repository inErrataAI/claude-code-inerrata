#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
PROJECT_ROOT=$(cd -- "$SCRIPT_DIR/.." && pwd)

PORT=${PORT:-5556}
FRAMING=${FRAMING:-equalization}
AGENTS_PER_WAVE=${AGENTS_PER_WAVE:-1}
PARALLEL=${PARALLEL:-4}
TIMEOUT_MINUTES=${TIMEOUT_MINUTES:-30}
RUN_STAMP=${RUN_STAMP:-$(date +%Y%m%d-%H%M%S)}
RESULTS_DIR=${RESULTS_DIR:-"$PROJECT_ROOT/results/live-scoreboard-$RUN_STAMP"}
LOG_FILE=${LOG_FILE:-"$PROJECT_ROOT/results/run-logs/benchmark-$RUN_STAMP.log"}
CTF_QWEN_MODEL=${CTF_QWEN_MODEL:-qwen2.5:14b}

mkdir -p "$(dirname "$LOG_FILE")" "$RESULTS_DIR"
exec >>"$LOG_FILE" 2>&1

load_inerrata_key() {
  if [[ -n "${INERRATA_API_KEY:-}" ]]; then
    return 0
  fi

  local env_file=${INERRATA_ENV_FILE:-"$HOME/.inerrata-env"}
  if [[ ! -f "$env_file" ]]; then
    return 1
  fi

  local key_line
  key_line=$(
    sed -n -E 's/^(export[[:space:]]+)?INERRATA_API_KEY=(.*)$/\2/p' "$env_file" |
      head -n 1
  )

  if [[ -z "$key_line" ]]; then
    return 1
  fi

  key_line=${key_line%\"}
  key_line=${key_line#\"}
  key_line=${key_line%\'}
  key_line=${key_line#\'}
  export INERRATA_API_KEY=$key_line
}

if ! load_inerrata_key; then
  echo "[scoreboard] INERRATA_API_KEY is missing. Export it or add it to ~/.inerrata-env." >&2
  exit 1
fi

export CTF_QWEN_MODEL

if [[ -x "$HOME/.local/share/fnm/fnm" ]]; then
  eval "$("$HOME/.local/share/fnm/fnm" env --shell bash)"
fi

node -e 'if (!globalThis.Request) process.exit(1)' || {
  echo "[scoreboard] Node $(node -v 2>/dev/null || echo unavailable) does not provide global Request." >&2
  echo "[scoreboard] Install/use Node 18+ before starting the dashboard." >&2
  exit 1
}

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
echo "[scoreboard] Results: $RESULTS_DIR"
echo "[scoreboard] Qwen model: $CTF_QWEN_MODEL"

cd "$PROJECT_ROOT"
exec npx tsx "${args[@]}"
