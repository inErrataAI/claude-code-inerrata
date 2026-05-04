# Codex Task Spec: CTF Graph Integration + Equalization Run

**Repo:** `~/Repos/claude-code-inerrata`
**Branch:** `feat/ctf-framing-waves`
**Priority:** P1 — blocks meaningful benchmark results

---

## Context

The CTF Cold-To-Warm Demo orchestrator (`demo/ctf-benchmark/benchmark/orchestrator.ts`) calls three functions from `demo/ctf-benchmark/benchmark/graph.ts` to track knowledge graph state before/after waves. All three are currently **stubbed** -- they return zeros or sleep. This means:

- `graph-before.json` and `graph-after.json` both show `{ nodeCount: 0, edgeCount: 0 }` — misleading
- `wipeCtfNodes` logs but does nothing — no isolation between benchmark runs
- `drainExtraction` just sleeps — no actual confirmation that extraction completed

The orchestrator calls them at these points:
```
runFraming() {
  graphBefore = snapshotGraph(apiKey)        // before any waves
  for wave of selectedWaves:
    if equalization && wave.graphState === 'empty':
      wipeCtfNodes(apiKey)                   // before cold wave
    results = runWave(...)
    if wave.canContribute:
      drainExtraction(30_000)                // after contributing waves
  graphAfter = snapshotGraph(apiKey)         // after all waves
}
```

---

## Task 1: Implement `snapshotGraph()` — Real Graph Stats

**File:** `demo/ctf-benchmark/benchmark/graph.ts`

**Current:**
```typescript
export async function snapshotGraph(_apiKey: string): Promise<{
  nodeCount: number;
  edgeCount: number;
  timestamp: string;
}> {
  return { nodeCount: 0, edgeCount: 0, timestamp: new Date().toISOString() };
}
```

**Target:** Hit the inErrata production API to get real node/edge counts.

**Approach — Option A (preferred): Use the public graph stats endpoint**

The prod API is at `https://inerrata-production.up.railway.app`. Check if `/api/v1/graph/stats` or similar exists. If not, use the NDJSON stream endpoint (`/api/v1/graph/full?tier=significant&limit=1`) and parse the metadata line, OR use the admin stats endpoint if apiKey is provided.

**Approach — Option B: Count from NDJSON stream header**

The `/api/v1/graph/full` NDJSON stream may include a metadata/header line with total counts. Parse that.

**Approach — Option C: Direct Cypher via admin endpoint**

If an admin Cypher endpoint exists (check API routes), run:
```cypher
MATCH (n:SemanticNode) WITH count(n) AS nodes
MATCH ()-[r]->() WHERE type(r) IN ['RELATES_TO', 'CAUSED_BY', 'SOLVED_BY', ...]
RETURN nodes, count(r) AS edges
```

**Implementation:**
```typescript
const INERRATA_API = process.env.INERRATA_API_URL ?? 'https://inerrata-production.up.railway.app';

export async function snapshotGraph(apiKey: string): Promise<{
  nodeCount: number;
  edgeCount: number;
  timestamp: string;
}> {
  const timestamp = new Date().toISOString();

  try {
    // Try stats endpoint first
    const res = await fetch(`${INERRATA_API}/api/v1/graph/stats`, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      signal: AbortSignal.timeout(10_000),
    });

    if (res.ok) {
      const data = await res.json() as { nodeCount?: number; edgeCount?: number };
      return {
        nodeCount: data.nodeCount ?? 0,
        edgeCount: data.edgeCount ?? 0,
        timestamp,
      };
    }

    // Fallback: stream first few lines of NDJSON and count
    console.warn(`[ctf] /graph/stats returned ${res.status}; falling back to NDJSON count`);
    const ndjsonRes = await fetch(
      `${INERRATA_API}/api/v1/graph/full?tier=significant&limit=50000`,
      {
        headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
        signal: AbortSignal.timeout(30_000),
      },
    );

    if (!ndjsonRes.ok) {
      console.warn(`[ctf] NDJSON fallback failed: ${ndjsonRes.status}`);
      return { nodeCount: 0, edgeCount: 0, timestamp };
    }

    const text = await ndjsonRes.text();
    const lines = text.trim().split('\n').filter(Boolean);
    let nodes = 0, edges = 0;
    for (const line of lines) {
      try {
        const obj = JSON.parse(line);
        if (obj.t === 'n' || obj.type === 'node') nodes++;
        if (obj.t === 'e' || obj.type === 'edge') edges++;
      } catch { /* skip malformed */ }
    }

    return { nodeCount: nodes, edgeCount: edges, timestamp };
  } catch (err) {
    console.error('[ctf] snapshotGraph failed:', err);
    return { nodeCount: 0, edgeCount: 0, timestamp };
  }
}
```

**Key points:**
- MUST gracefully degrade (try stats → NDJSON fallback → return zeros)
- MUST use `AbortSignal.timeout()` — never hang
- Add `INERRATA_API_URL` env var, default to production Railway URL
- Return type stays the same — no interface changes needed

**Test:**
```typescript
// test: snapshotGraph returns real counts from prod (integration test, skip in CI)
// test: snapshotGraph returns zeros when API unreachable (mock fetch)
// test: snapshotGraph respects timeout (mock slow response)
```

---

## Task 2: Implement `wipeCtfNodes()` — Namespace Cleanup

**File:** `demo/ctf-benchmark/benchmark/graph.ts`

**Current:** Logs warning, returns 0.

**Target:** Delete nodes with `source` matching `ctf-bench*` prefix. This is needed for equalization framing wave 1 (graphState === 'empty') to start from a clean slate.

**Approach — Option A (preferred): Admin API endpoint**

If the API has an admin delete/cleanup endpoint, use it with the API key.

**Approach — Option B: Contribute endpoint with delete flag**

If there's a way to mark nodes for deletion via the contribution API.

**Approach — Option C: Document the manual step**

If no delete API exists yet, make the function:
1. Log exactly what Cypher needs to run manually
2. Return -1 (indicating "manual intervention needed")
3. Add a `--skip-wipe` CLI flag to orchestrator that skips this step

**Implementation (Option C as safe fallback):**
```typescript
export async function wipeCtfNodes(apiKey: string): Promise<number> {
  if (!apiKey) {
    console.warn('[ctf] INERRATA_API_KEY not set; skipping CTF namespace cleanup.');
    return 0;
  }

  const INERRATA_API = process.env.INERRATA_API_URL ?? 'https://inerrata-production.up.railway.app';

  // Try admin cleanup endpoint
  try {
    const res = await fetch(`${INERRATA_API}/api/v1/admin/graph/cleanup`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ sourcePrefix: 'ctf-bench' }),
      signal: AbortSignal.timeout(30_000),
    });

    if (res.ok) {
      const data = await res.json() as { deletedCount?: number };
      console.log(`[ctf] Cleaned up ${data.deletedCount ?? 0} CTF nodes.`);
      return data.deletedCount ?? 0;
    }

    // No admin endpoint available — log manual Cypher
    console.warn(`[ctf] Admin cleanup returned ${res.status}. Manual cleanup Cypher:`);
    console.warn(`  MATCH (n:SemanticNode) WHERE n.source STARTS WITH 'ctf-bench' DETACH DELETE n`);
    return -1;
  } catch (err) {
    console.error('[ctf] wipeCtfNodes failed:', err);
    console.warn('[ctf] Manual cleanup Cypher:');
    console.warn('  MATCH (n:SemanticNode) WHERE n.source STARTS WITH "ctf-bench" DETACH DELETE n');
    return -1;
  }
}
```

**Key points:**
- MUST NOT silently pretend cleanup happened
- Return -1 when manual intervention needed (orchestrator can check and warn)
- Log exact Cypher for manual execution

---

## Task 3: Implement `drainExtraction()` — Poll for Completion

**File:** `demo/ctf-benchmark/benchmark/graph.ts`

**Current:** Just `setTimeout` — sleeps for `timeoutMs` regardless.

**Target:** Poll the API to detect when extraction pipeline has finished processing contributed knowledge.

**Approach — Option A (preferred): Poll graph stats**

Take a snapshot before, then poll until nodeCount stabilizes (no change for 5s).

**Approach — Option B: Poll extraction status endpoint**

If the API exposes extraction queue status, poll that.

**Approach — Option C: Smart sleep with logging**

If no polling mechanism exists, at least make the sleep adaptive:
- Take snapshot at start
- Sleep in 5s intervals, taking snapshots
- Log growth: `[ctf] Extraction: +12 nodes, +34 edges (15s elapsed)`
- Exit when stable or timeout reached

**Implementation (Option C — works without new API endpoints):**
```typescript
export async function drainExtraction(timeoutMs: number = 30_000): Promise<void> {
  const apiKey = process.env.INERRATA_API_KEY ?? '';
  const pollIntervalMs = 5_000;
  const stabilityThreshold = 2; // stable for 2 consecutive polls = done
  let stableCount = 0;
  let lastNodeCount = -1;
  const startTime = Date.now();

  console.log(`[ctf] Waiting up to ${Math.round(timeoutMs / 1000)}s for extraction to stabilize...`);

  while (Date.now() - startTime < timeoutMs) {
    await new Promise((r) => setTimeout(r, pollIntervalMs));

    const snapshot = await snapshotGraph(apiKey);
    const elapsed = Math.round((Date.now() - startTime) / 1000);

    if (snapshot.nodeCount === lastNodeCount) {
      stableCount++;
      console.log(`[ctf] Extraction stable (${stableCount}/${stabilityThreshold}) at ${snapshot.nodeCount} nodes [${elapsed}s]`);
      if (stableCount >= stabilityThreshold) {
        console.log(`[ctf] Extraction drain complete: ${snapshot.nodeCount} nodes, ${snapshot.edgeCount} edges.`);
        return;
      }
    } else {
      if (lastNodeCount >= 0) {
        const delta = snapshot.nodeCount - lastNodeCount;
        console.log(`[ctf] Extraction: +${delta} nodes (${snapshot.nodeCount} total) [${elapsed}s]`);
      }
      stableCount = 0;
      lastNodeCount = snapshot.nodeCount;
    }
  }

  console.warn(`[ctf] Extraction drain timed out after ${Math.round(timeoutMs / 1000)}s.`);
}
```

**Key points:**
- MUST poll, not just sleep
- Uses `snapshotGraph()` from Task 1 — that function must work first
- Logs progress so operator can see extraction happening in real time
- Exits early when stable — don't waste time sleeping after extraction finishes

---

## Task 4: Add `INERRATA_API_URL` Environment Variable

**File:** `demo/ctf-benchmark/benchmark/graph.ts` (already used above)

Also add to:
- `.env.example` (if exists) or `README.md` env section
- Document in orchestrator `--help` output if applicable

**Default value:** `https://inerrata-production.up.railway.app`

---

## Task 5: Update Orchestrator to Handle `wipeCtfNodes` Return Value

**File:** `demo/ctf-benchmark/benchmark/orchestrator.ts`

**Current:**
```typescript
if (framing === 'equalization' && wave.graphState === 'empty' && wave.number === 1) {
  await wipeCtfNodes(apiKey);
}
```

**Change to:**
```typescript
if (framing === 'equalization' && wave.graphState === 'empty' && wave.number === 1) {
  const wiped = await wipeCtfNodes(apiKey);
  if (wiped === -1) {
    console.warn('[orchestrator] ⚠️  CTF node cleanup requires manual Cypher (see above). Continuing with existing graph state.');
    broadcastSSE('warning', { message: 'CTF node cleanup skipped — manual Cypher required' });
  } else {
    console.log(`[orchestrator] Cleaned ${wiped} CTF nodes before cold wave.`);
  }
}
```

---

## Task 6: Tests

**File:** `demo/ctf-benchmark/__tests__/graph.test.ts` (NEW)

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('graph.ts', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe('snapshotGraph', () => {
    it('returns zeros when API unreachable', async () => {
      global.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
      const { snapshotGraph } = await import('../benchmark/graph.js');
      const result = await snapshotGraph('test-key');
      expect(result.nodeCount).toBe(0);
      expect(result.edgeCount).toBe(0);
      expect(result.timestamp).toBeTruthy();
    });

    it('parses stats endpoint response', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ nodeCount: 26000, edgeCount: 80000 }),
      });
      const { snapshotGraph } = await import('../benchmark/graph.js');
      const result = await snapshotGraph('test-key');
      expect(result.nodeCount).toBe(26000);
      expect(result.edgeCount).toBe(80000);
    });
  });

  describe('wipeCtfNodes', () => {
    it('returns 0 when no API key', async () => {
      const { wipeCtfNodes } = await import('../benchmark/graph.js');
      const result = await wipeCtfNodes('');
      expect(result).toBe(0);
    });

    it('returns -1 when admin endpoint unavailable', async () => {
      global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 404 });
      const { wipeCtfNodes } = await import('../benchmark/graph.js');
      const result = await wipeCtfNodes('test-key');
      expect(result).toBe(-1);
    });
  });

  describe('drainExtraction', () => {
    it('exits early when graph is stable', async () => {
      // Mock snapshotGraph to return same count twice
      const mockSnapshot = { nodeCount: 100, edgeCount: 200, timestamp: '' };
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => mockSnapshot,
      });
      const { drainExtraction } = await import('../benchmark/graph.js');
      const start = Date.now();
      await drainExtraction(60_000);
      // Should exit after ~10s (2 stable polls × 5s interval), not 60s
      expect(Date.now() - start).toBeLessThan(20_000);
    });
  });
});
```

---

## Task 7: Parallel Challenge Execution Within Waves

**File:** `demo/ctf-benchmark/benchmark/orchestrator.ts`

**Problem:** Currently `runWave()` executes challenges sequentially — each agent finishes one challenge before moving to the next. With 66 challenges and multi-minute agent runs, a single wave can take hours.

**Target:** Run multiple challenges concurrently within each wave, controlled by a `--parallel` CLI flag.

**Current flow (sequential):**
```
for (const challenge of challenges) {
  for (const agent of agents) {
    await runAgent(agent, challenge, ...)  // blocks until done
  }
}
```

**New flow (concurrent with bounded parallelism):**
```typescript
// Use a local bounded-concurrency helper or p-limit.

// Add to parseConfig():
const { values } = parseArgs({
  options: {
    // ... existing options ...
    parallel: { type: 'string', default: '4' },
  },
});
// config.parallel = parseInt(values.parallel ?? '4', 10);

async function runWave(params: RunWaveParams): Promise<AgentRunResult[]> {
  const { wave, challenges, config, ... } = params;
  const limit = pLimit(config.parallel);

  // Each "task" = one agent running one challenge
  const tasks: Array<() => Promise<void>> = [];

  for (const challenge of challenges) {
    for (const agent of agents) {
      tasks.push(() => limit(async () => {
        await runAgent(agent, challenge, wave, ...);
      }));
    }
  }

  // Run all with bounded concurrency
  await Promise.allSettled(tasks.map(t => t()));

  // ... collect results from trackers as before ...
}
```

**Key design decisions:**

1. **Bounded concurrency control** — `Promise.allSettled` alone would fire all at once. Use a local helper or `p-limit` to cap to N concurrent challenge jobs.

2. **SSE updates still work** — `broadcastSSE` is called from within `runAgent`, which is already per-challenge/per-agent. No changes needed for live dashboard updates.

3. **Default `--parallel 4`** — matches the four-model roster while still allowing `--parallel 1` for deterministic sequential runs.

4. **`--parallel 1` = current behavior** — backwards compatible. Sequential execution is just parallel=1.

5. **Challenge-level parallelism, not agent-level** — within a single challenge, agents still run sequentially (they may compete for the same repo directory). Between challenges, they run concurrently.

6. **Repo directory isolation** — currently `prepareRepos()` clones each repo once. With parallel execution, multiple agents may need the same repo simultaneously. Two options:
   - **Option A (simpler):** Clone per-agent — `repos/{repo}-{agentId}/`. More disk, zero contention.
   - **Option B (better):** Clone once, agents get read-only access. Agents don't modify repos (they analyze source), so shared access is safe.
   - Recommend **Option B** — verify agents don't write to repo dirs. If they do, switch to A.

7. **Dashboard state tracking** — `state.currentChallenge` becomes meaningless with parallel execution. Update to `state.activeChallenges: string[]` (array of currently-running challenge IDs). Dashboard already shows per-challenge cards, so this is mostly a state shape change.

**CLI addition:**
```
--parallel <N>    Number of concurrent challenge executions per wave (default: 3)
```

**Test:**
```typescript
describe('parallel execution', () => {
  it('respects --parallel flag', async () => {
    // Mock runAgent to track concurrent invocations
    let maxConcurrent = 0;
    let currentConcurrent = 0;

    const mockRunAgent = vi.fn(async () => {
      currentConcurrent++;
      maxConcurrent = Math.max(maxConcurrent, currentConcurrent);
      await new Promise(r => setTimeout(r, 50));
      currentConcurrent--;
    });

    // Run with parallel=2, 4 challenges
    await runWaveWithConcurrency(mockRunAgent, challenges.slice(0, 4), { parallel: 2 });

    expect(maxConcurrent).toBeLessThanOrEqual(2);
    expect(mockRunAgent).toHaveBeenCalledTimes(4);
  });

  it('parallel=1 runs sequentially', async () => {
    let maxConcurrent = 0;
    let currentConcurrent = 0;

    const mockRunAgent = vi.fn(async () => {
      currentConcurrent++;
      maxConcurrent = Math.max(maxConcurrent, currentConcurrent);
      await new Promise(r => setTimeout(r, 10));
      currentConcurrent--;
    });

    await runWaveWithConcurrency(mockRunAgent, challenges.slice(0, 3), { parallel: 1 });
    expect(maxConcurrent).toBe(1);
  });
});
```

---

## Execution Order

1. **Task 4** first (env var) — everything else depends on it
2. **Task 1** (snapshotGraph) — Task 3 depends on it
3. **Task 2** (wipeCtfNodes) — independent of Task 1
4. **Task 3** (drainExtraction) — depends on Task 1
5. **Task 5** (orchestrator update) — depends on Task 2
6. **Task 7** (parallel execution) — independent, can be done anytime after Task 4
7. **Task 6** (tests) — last, covers all including Task 7

## Dependency Note

The implemented branch uses a local bounded-concurrency helper, so no new runtime dependency is required.

## Validation

After all tasks:
```bash
# Unit tests
npx vitest run demo/ctf-benchmark/__tests__/graph.test.ts

# Integration smoke test (requires network)
INERRATA_API_KEY=<key> npx tsx -e "
  import { snapshotGraph } from './demo/ctf-benchmark/benchmark/graph.js';
  const s = await snapshotGraph(process.env.INERRATA_API_KEY!);
  console.log(s);
  if (s.nodeCount === 0) throw new Error('Expected real node count');
"

# Existing tests still pass
npx vitest run

# Verify parallel flag works
npx tsx demo/ctf-benchmark/benchmark/orchestrator.ts --framing equalization --parallel 1 --help
```
