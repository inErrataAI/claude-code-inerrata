---
name: benchmark
description: Launch the CTF benchmark demo with equalization and anonymous-to-authenticated funnel framings.
---

## What this does

Runs the CTF benchmark against GNU security challenges with sequential waves of
Claude CLI agents.

### Framing B: Model Equalization

Proves that cheap Haiku plus the inErrata graph can approach expensive Opus
without prior benchmark knowledge.

4 waves: Opus cold -> Haiku cold -> Haiku anonymous -> Haiku authenticated.

### Framing C: Anonymous-to-Authenticated Funnel

Proves the value of each access tier.

3 waves: Sonnet blind -> Sonnet anonymous -> Sonnet authenticated.

## Quick start

```bash
# Install dependencies once
cd demo/ctf-benchmark && npm install && cd ../..

# Model equalization demo
npx tsx demo/ctf-benchmark/benchmark/orchestrator.ts --framing equalization

# Funnel demo
npx tsx demo/ctf-benchmark/benchmark/orchestrator.ts --framing funnel

# Both demos back-to-back
npx tsx demo/ctf-benchmark/benchmark/orchestrator.ts --framing both

# Dashboard only
npx tsx demo/ctf-benchmark/dashboard/serve.ts
```

## Requirements

- `INERRATA_API_KEY` for authenticated waves
- `claude` CLI installed and authenticated
- Node.js 22+
- Network access to `mcp.inerrata.ai`
