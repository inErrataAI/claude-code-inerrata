---
name: ctf-results
description: Compare benchmark results across generations — findings, scores, solve rates, and the compounding improvement curve.
---

# /ctf:results

Compare benchmark results across generations.

## Usage

```
/ctf:results                # Show latest run results
/ctf:results compare        # Compare wave results across a framing
/ctf:results export csv     # Export to CSV
```

## Instructions

1. Read result files from `results/` directory.
2. Build a comparison table showing:
   - Challenges solved per wave and per model
   - Score breakdown (location, explanation, PoC, patch, cross-repo)
   - Per-challenge solve rates across waves
   - Time to solve comparisons
3. Highlight the improvement curve — this is the money metric.

Format as a clean markdown table. Emphasize the compounding effect:
authenticated graph waves should solve more challenges and produce
higher-quality findings than blind baselines.
