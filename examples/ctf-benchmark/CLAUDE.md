# CTF Benchmark — inErrata Knowledge Graph Demo

This plugin runs a multi-agent Capture The Flag benchmark that measures how
inErrata's shared knowledge graph compounds AI agent performance across
generations.

## What This Does

A procedurally-generated vulnerable API (the "maze") presents 18 security
challenges — JWT forgery, IDOR, SSRF, race conditions, prototype pollution,
and more. AI agents attack the maze using HTTP tools and report captured flags.

The key insight: each generation of agents contributes *techniques* (not
answers) to the knowledge graph. Later generations query those techniques
and solve challenges faster. After 3-4 generations, Haiku-class models
match Opus-class cold baselines.

## Running the Benchmark

```bash
# Start the maze server
npx tsx server/maze.ts

# Cold run (baseline — no graph knowledge)
npx tsx benchmark/orchestrator.ts --mode cold --agents 5 --model haiku

# Warm run (agents reuse accumulated techniques)
npx tsx benchmark/orchestrator.ts --mode warm --agents 5 --model haiku --prior-run <run-id>

# With live dashboard
npx tsx benchmark/orchestrator.ts --mode cold --agents 5 | npx tsx dashboard/serve.ts
```

## Skills

- `/ctf:run` — Launch a benchmark run (cold or warm)
- `/ctf:dashboard` — Start the live visualization dashboard
- `/ctf:results` — Compare generations and show improvement curves

## How Agents Use inErrata

During a run, each agent:
1. **Searches** the graph before attempting a challenge (`burst`, `explore`)
2. **Attacks** using HTTP tools (`http_request`, `http_batch`, `http_script`, `run_python`)
3. **Reports** flag captures via `report_finding`
4. **Contributes** the *technique* (not the flag) back to the graph on success

The graph captures generalizable knowledge: "JWT none-algorithm bypass works
when the server doesn't validate the alg field" — not "the flag is FLAG{...}".

## Challenge Tiers

| Tier | Count | Points | Examples |
|------|-------|--------|----------|
| Trivial | 1 | 50 | API mapping |
| Easy | 1 | 100 | Debug endpoint leak |
| Medium | 3 | 200 | JWT forgery, none-alg, account takeover |
| Hard | 11 | 300-450 | IDOR, SSRF, race conditions, injection |
| Expert | 2 | 500 | Timing oracle, permission DAG |

## Reproducibility

All challenges are generated from a single hex seed via deterministic RNG.
Cold and warm runs use the same seed, so the *challenges* are identical —
only the graph state differs. This isolates the variable: knowledge, not luck.
