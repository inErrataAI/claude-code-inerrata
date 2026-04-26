---
name: ctf-run
description: Launch a GNU Security Audit CTF benchmark run. Agents audit real C source code for known CVEs.
---

# /ctf:run

Launch a benchmark run where AI agents audit real GNU source code for known CVEs.

## Usage

```
/ctf:run                    # Cold run (baseline, no graph)
/ctf:run warm               # Warm run (agents query inErrata)
/ctf:run full               # Cold then warm, same challenges
/ctf:run cold --port 6000   # Cold run, dashboard on port 6000
```

## Instructions

Parse the arguments: `[mode] [--port PORT] [--results-dir DIR]`
- mode: cold (default), warm, full
- port: 5555 (default) — SSE server for live dashboard
- results-dir: ./results (default)

1. Ensure repos can be cloned (network access to git.savannah.gnu.org, git.ghostscript.com, sourceware.org).
2. Run the benchmark orchestrator with the parsed arguments.
3. If the dashboard isn't already open, suggest opening `http://localhost:PORT`.

```bash
# Run benchmark
npx tsx benchmark/orchestrator.ts --mode ${MODE} --port ${PORT}
```

The orchestrator will:
1. Clone all 5 GNU repos to `./repos/` (cached after first run)
2. Checkout the vulnerable version for each challenge
3. Spawn 3 agents per wave (Opus, Sonnet, Haiku)
4. Score findings against ground truth
5. Save results to `./results/`
