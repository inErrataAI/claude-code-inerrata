# CTF Cold-To-Warm Demo

This demo measures how inErrata's shared knowledge graph changes AI agent
performance when auditing real C source code for known CVEs.

## Framing B: Model Equalization

Thesis: graph access changes outcomes across model types, including local Qwen.

```bash
npx tsx benchmark/orchestrator.ts --framing equalization
```

Tier order:
1. `cold` — Opus, Sonnet, Haiku, and Qwen without MCP tools
2. `anonymous` — Opus, Sonnet, Haiku, and Qwen with anonymous read-only MCP tools
3. `authenticated` — Opus, Sonnet, Haiku, and Qwen with authenticated full MCP tools

## Framing C: Anonymous-to-Authenticated Funnel

Thesis: graph access gets useful before signup, and authenticated write access
adds the compound loop.

```bash
npx tsx benchmark/orchestrator.ts --framing funnel
```

Tier order:
1. `blind` — Opus, Sonnet, Haiku, and Qwen without MCP tools
2. `anon` — Opus, Sonnet, Haiku, and Qwen with anonymous read-only MCP tools
3. `authed` — Opus, Sonnet, Haiku, and Qwen with authenticated full MCP tools

Run both framings:

```bash
npx tsx benchmark/orchestrator.ts --framing both
```

Useful options:

```bash
npx tsx benchmark/orchestrator.ts --framing equalization --parallel 4
npx tsx benchmark/orchestrator.ts --framing funnel --challenge CVE-2014-6271
npx tsx benchmark/orchestrator.ts --framing equalization --max-difficulty 2 --port 5555
npx tsx dashboard/serve.ts
```

## Architecture

- `benchmark/orchestrator.ts` — sequential wave runner, SSE state, result export
- `benchmark/waves.ts` — equalization and funnel wave definitions
- `benchmark/mcp-config.ts` — per-agent MCP config generation
- `benchmark/graph.ts` — demo namespace cleanup and extraction drain hooks
- `agents/prompts.ts` — auth-level-aware system and challenge prompts
- `challenges/registry.ts` — GNU CVE challenge definitions
- `scoring/judge.ts` — finding scorer
- `dashboard/serve.ts` — live visualization dashboard

## Environment

- `INERRATA_API_KEY` for authenticated waves
- `CTF_QWEN_MODEL` or `OLLAMA_QWEN_MODEL` to override the local Qwen model (defaults to `qwen3:14b`)
- `CTF_MAX_OUTPUT_TOKENS` or `MAX_OUTPUT_TOKENS` to tune Claude Code subprocess visible output headroom (defaults to `8192`)
- Network access to `mcp.inerrata.ai`
- `claude` CLI installed and authenticated
- `ollama` CLI installed with `qwen3:14b` pulled for the local Qwen trial
- Node.js 22+
