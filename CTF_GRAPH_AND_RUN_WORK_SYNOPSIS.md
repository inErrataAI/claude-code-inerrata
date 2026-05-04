# CTF Graph Integration + Run Equalization Synopsis

Date: 2026-05-02
Branch: `feat/ctf-framing-waves`

## Summary

Implemented the updated CTF benchmark spec, including real graph snapshots,
namespace cleanup signaling, extraction drain polling, and bounded parallel
challenge execution.

## Implemented

- `demo/ctf-benchmark/benchmark/graph.ts`
  - Added `INERRATA_API_URL`, defaulting to `https://inerrata-production.up.railway.app`.
  - Implemented `snapshotGraph()` with `/api/v1/graph/stats` first, NDJSON graph stream fallback, and zero-count graceful degradation.
  - Implemented `wipeCtfNodes()` against `/api/v1/admin/graph/cleanup`, returning `-1` and logging manual Cypher when cleanup is unavailable.
  - Implemented `drainExtraction()` by polling graph snapshots until node/edge counts stabilize.

- `demo/ctf-benchmark/benchmark/orchestrator.ts`
  - Added `--parallel <N>` with default `4`.
  - Added local bounded concurrency for challenge-level execution within waves.
  - Preserved sequential agent execution inside each challenge job.
  - Kept `--parallel 1` as sequential behavior.
  - Added per-challenge git worktrees so concurrent challenge jobs do not race on repository checkouts.
  - Handled `wipeCtfNodes() === -1` with a warning and SSE notification.
  - Added `--help` output documenting `INERRATA_API_URL`.

- Dashboard/shared state
  - Added `activeChallenges?: string[]` to `AgentState`.
  - Updated dashboard rendering to show multiple active challenges during parallel runs.

- Tests and docs
  - Added `demo/ctf-benchmark/__tests__/graph.test.ts`.
  - Added `demo/ctf-benchmark/__tests__/orchestrator.test.ts`.
  - Included CTF benchmark tests in root `vitest.config.ts`.
  - Documented `INERRATA_API_URL` in `README.md` and `demo/ctf-benchmark/CLAUDE.md`.
  - Added Tailscale-friendly run scripts for the live scoreboard and dashboard.

## Verification

Passed:

```bash
npx vitest run demo/ctf-benchmark/__tests__/graph.test.ts demo/ctf-benchmark/__tests__/orchestrator.test.ts
```

```bash
cd demo/ctf-benchmark
npx tsc -p tsconfig.json --noEmit
```

```bash
npx tsx demo/ctf-benchmark/benchmark/orchestrator.ts --framing equalization --parallel 1 --help
```

```bash
npx vitest run
```

Full suite result: `10 passed`, `205 tests passed`.

## Current Worktree Notes

Modified tracked files:

- `README.md`
- `demo/ctf-benchmark/CLAUDE.md`
- `demo/ctf-benchmark/benchmark/graph.ts`
- `demo/ctf-benchmark/benchmark/orchestrator.ts`
- `demo/ctf-benchmark/benchmark/waves.ts`
- `demo/ctf-benchmark/dashboard/serve.ts`
- `demo/ctf-benchmark/shared/types.ts`
- `demo/ctf-benchmark/skills/ctf-run/SKILL.md`
- `vitest.config.ts`

New files:

- `CTF_GRAPH_AND_RUN_WORK_SYNOPSIS.md`
- `demo/ctf-benchmark/__tests__/graph.test.ts`
- `demo/ctf-benchmark/__tests__/orchestrator.test.ts`
- `demo/ctf-benchmark/.claude/settings.json`
- `demo/ctf-benchmark/scripts/run-dashboard-tailscale.sh`
- `demo/ctf-benchmark/scripts/run-scoreboard-tailscale.sh`

Pre-existing untracked items still present:

- `CODEX_CTF_GRAPH_AND_RUN_SPEC.md`
- `demo/ctf-benchmark/.claude/`
