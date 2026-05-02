# GNU Security Audit CTF — inErrata Knowledge Graph Demo

This benchmark measures how inErrata's shared knowledge graph changes AI agent
performance when auditing real C source code for known CVEs.

## Framing B: Model Equalization

Thesis: cheap Haiku plus inErrata can approach expensive Opus without prior
knowledge.

```bash
npx tsx benchmark/orchestrator.ts --framing equalization
```

Wave order:
1. `opus-cold` — Opus, authenticated MCP, wiped benchmark namespace
2. `haiku-cold` — Haiku, no MCP tools
3. `haiku-anon` — Haiku, anonymous read-only MCP tools
4. `haiku-warm` — Haiku, authenticated full MCP tools

## Framing C: Anonymous-to-Authenticated Funnel

Thesis: graph access gets useful before signup, and authenticated write access
adds the compound loop.

```bash
npx tsx benchmark/orchestrator.ts --framing funnel
```

Wave order:
1. `blind` — Sonnet, no MCP tools
2. `anon` — Sonnet, anonymous read-only MCP tools
3. `authed` — Sonnet, authenticated full MCP tools

Run both framings:

```bash
npx tsx benchmark/orchestrator.ts --framing both
```

Useful options:

```bash
npx tsx benchmark/orchestrator.ts --framing equalization --agents-per-wave 3
npx tsx benchmark/orchestrator.ts --framing funnel --challenge CVE-2014-6271
npx tsx benchmark/orchestrator.ts --framing equalization --max-difficulty 2 --port 5555
npx tsx dashboard/serve.ts
```

## Architecture

- `benchmark/orchestrator.ts` — sequential wave runner, SSE state, result export
- `benchmark/waves.ts` — equalization and funnel wave definitions
- `benchmark/mcp-config.ts` — per-agent MCP config generation
- `benchmark/graph.ts` — benchmark namespace cleanup and extraction drain hooks
- `agents/prompts.ts` — auth-level-aware system and challenge prompts
- `challenges/registry.ts` — GNU CVE challenge definitions
- `scoring/judge.ts` — finding scorer
- `dashboard/serve.ts` — live visualization dashboard

## Environment

- `INERRATA_API_KEY` for authenticated waves
- Network access to `mcp.inerrata.ai`
- `claude` CLI installed and authenticated
- Node.js 22+
