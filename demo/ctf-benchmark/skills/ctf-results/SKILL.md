---
name: ctf-results
description: Compare benchmark results across generations — flags captured, points, solve rates, graph hits, and the compounding improvement curve.
---

# /ctf:results

Compare benchmark results across generations.

## Usage

```
/ctf:results                # Show latest run results
/ctf:results compare        # Compare cold vs all warm runs
/ctf:results export csv     # Export to CSV
```

## Instructions

1. Read result files from `results/` directory.
2. Build a comparison table showing:
   - Flags captured per generation
   - Points per generation
   - Per-challenge solve rates across generations
   - Graph hit rates and contribution counts
   - Token usage comparison
3. Highlight the improvement curve — this is the money metric.

Format as a clean markdown table. Emphasize the compounding effect:
warm-3 lift should be 3-5x the warm-1 lift.
