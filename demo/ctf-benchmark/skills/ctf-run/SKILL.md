---
name: ctf-run
description: Launch a CTF Cold-To-Warm Demo run with equalization or funnel framing.
---

# /ctf:run

Launch the CTF Cold-To-Warm Demo where Claude CLI agents audit C source for known
CVEs across sequential graph-access waves.

## Usage

```
/ctf:run                         # Model equalization framing
/ctf:run funnel                  # Anonymous-to-authenticated funnel
/ctf:run both                    # Run both framings
/ctf:run equalization --port 6000
```

## Instructions

Parse arguments: `[framing] [--port PORT] [--results-dir DIR] [--agents-per-wave N] [--parallel N]`
- framing: `equalization` default, `funnel`, or `both`
- port: `5555` default
- results-dir: `./results` default
- agents-per-wave: `1` default for legacy single-model waves; rostered tiers ignore it
- parallel: `4` default

```bash
npx tsx benchmark/orchestrator.ts --framing ${FRAMING} --port ${PORT} --agents-per-wave ${AGENTS_PER_WAVE} --parallel ${PARALLEL}
```

The orchestrator will:
1. Build per-agent MCP configs for no tools, anonymous read-only, or authenticated access.
2. Run graph-access tiers sequentially, with Opus, Sonnet, Haiku, and Qwen in each tier.
3. Score `<finding>` blocks against ground truth.
4. Save per-wave JSON, `comparison.json`, and `summary.md`.
5. Stream state to the dashboard.
