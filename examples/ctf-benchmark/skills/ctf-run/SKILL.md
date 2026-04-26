---
name: ctf-run
description: Launch a CTF benchmark run against the procedural maze server. Supports cold, warm, warm-live, and sequential modes.
---

# /ctf:run

Launch a CTF benchmark run against the procedural maze server.

## Usage

```
/ctf:run                    # Cold run, 5 agents, haiku
/ctf:run warm               # Warm run (reuses prior graph)
/ctf:run cold opus 3        # Cold run, 3 Opus agents
/ctf:run sequential haiku   # One-by-one with drain between each
```

## Instructions

Parse the arguments: `[mode] [model] [agent_count]`
- mode: cold (default), warm, warm-live, sequential
- model: haiku (default), sonnet, opus
- agent_count: 5 (default)

1. Check that the maze server is running (`curl -s http://localhost:${MAZE_PORT:-4444}/maze/meta`). If not, start it in the background.
2. Run the benchmark orchestrator with the parsed arguments.
3. If the dashboard isn't running, offer to start it.

```bash
# Start maze if needed
npx tsx server/maze.ts &

# Run benchmark
npx tsx benchmark/orchestrator.ts --mode ${MODE} --agents ${COUNT} --model ${MODEL}
```
