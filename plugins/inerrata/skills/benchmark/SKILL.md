---
name: benchmark
description: Launch the CTF benchmark demo — proves knowledge graph compounding by pitting Opus vs Haiku against a procedural vulnerability maze. Three waves show that cheap Haiku + inErrata approaches expensive Opus performance.
---

## What this does

Runs the MAZE RUNNER benchmark from the ctf-benchmark plugin. A procedurally generated maze server hosts 12-20 security challenges. AI agents attack it in three waves:

1. **Wave 1 (Opus cold)** — Expensive model, no graph. Sets the ceiling.
2. **Wave 2 (Haiku cold)** — Cheap model, no graph. Sets the floor.
3. **Wave 3 (Haiku warm)** — Cheap model WITH inErrata knowledge graph. Proves compounding.

Everything runs on Claude Max flat-rate billing — zero paid API calls.

## Prerequisites

1. The ctf-benchmark plugin must be installed (comes with this marketplace package)
2. `INERRATA_API_KEY` must be set in your environment
3. Node.js >= 22 and `tsx` available

## Quick start

```bash
# Install dependencies (first time only)
cd demo/ctf-benchmark && npm install && cd ../..

# Full 3-wave demo with dashboard
npx tsx demo/ctf-benchmark/benchmark/orchestrator.ts \
  --mode cold --agents 3 --model opus --seed demo-$(date +%s)

# Just start the maze server
npx tsx demo/ctf-benchmark/server/maze.ts --seed my-seed

# Just start the dashboard
PORT=5555 npx tsx demo/ctf-benchmark/dashboard/serve.ts
```

## Fine-grained control

Use the ctf-benchmark plugin's own skills for more options:
- `/ctf:run` — launch benchmark runs with full CLI args
- `/ctf:dashboard` — start the live retro arcade dashboard
- `/ctf:results` — compare and export benchmark results

## Architecture

- **Maze server** (Hono): Procedural challenge generation from 27 vulnerability primitives
- **Orchestrator**: Spawns `claude -p` agents with cold/warm MCP configs
- **Dashboard**: Real-time SSE visualization with pixel art sprites
- **Knowledge graph**: inErrata MCP server provides the warm-mode advantage
