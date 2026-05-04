const DEFAULT_INERRATA_API_URL = 'http://127.0.0.1:3100';
const CTF_SOURCE_PREFIX = 'ctf-bench';

export interface GraphSnapshot {
  nodeCount: number;
  edgeCount: number;
  timestamp: string;
}

function inerrataApiUrl(): string {
  return (
    process.env.CTF_INERRATA_API_URL
    ?? process.env.INERRATA_API_URL
    ?? process.env.ERRATA_API_URL
    ?? DEFAULT_INERRATA_API_URL
  ).replace(/\/$/, '');
}

function authHeaders(apiKey: string): Record<string, string> {
  return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
}

function graphCleanupHeaders(apiKey: string): Record<string, string> {
  const adminSecret = process.env.INERRATA_ADMIN_SECRET
    ?? process.env.CTF_GRAPH_CLEANUP_SECRET
    ?? process.env.ADMIN_SECRET
    ?? process.env.INERRATA_ADMIN_PASS;

  return {
    ...authHeaders(apiKey),
    ...(adminSecret ? { 'X-Admin-Secret': adminSecret } : {}),
  };
}

function numberOrZero(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : Number(value) || 0;
}

function parseStatsPayload(data: unknown): { nodeCount: number; edgeCount: number } {
  const payload = data && typeof data === 'object' ? data as Record<string, unknown> : {};
  return {
    nodeCount: numberOrZero(payload.nodeCount ?? payload.nodes ?? payload.totalNodes ?? payload.tn),
    edgeCount: numberOrZero(payload.edgeCount ?? payload.edges ?? payload.totalEdges ?? payload.te),
  };
}

function parseNdjsonGraphSnapshot(text: string): { nodeCount: number; edgeCount: number } {
  let nodeCount = 0;
  let edgeCount = 0;

  for (const line of text.trim().split('\n')) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line) as Record<string, unknown>;

      if (obj.t === 'd' || obj.t === 'done' || obj.type === 'done') {
        const totals = parseStatsPayload(obj);
        if (totals.nodeCount > 0 || totals.edgeCount > 0) return totals;
      }

      if (obj.t === 'n' || obj.t === 'node' || obj.type === 'node') nodeCount++;
      if (obj.t === 'e' || obj.t === 'edge' || obj.type === 'edge') edgeCount++;
    } catch {
      // Ignore malformed NDJSON fragments from interrupted streams.
    }
  }

  return { nodeCount, edgeCount };
}

export async function wipeCtfNodes(apiKey: string): Promise<number> {
  const cleanupHeaders = graphCleanupHeaders(apiKey);
  if (!cleanupHeaders.Authorization && !cleanupHeaders['X-Admin-Secret']) {
    console.warn('[ctf] INERRATA_API_KEY/admin cleanup secret not set; skipping CTF namespace cleanup.');
    return 0;
  }

  try {
    const res = await fetch(`${inerrataApiUrl()}/api/v1/admin/graph/cleanup`, {
      method: 'POST',
      headers: {
        ...cleanupHeaders,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ sourcePrefix: CTF_SOURCE_PREFIX }),
      signal: AbortSignal.timeout(30_000),
    });

    if (res.ok) {
      const data = await res.json().catch(() => ({})) as { deletedCount?: number };
      const deletedCount = numberOrZero(data.deletedCount);
      console.log(`[ctf] Cleaned up ${deletedCount} CTF nodes.`);
      return deletedCount;
    }

    console.warn(`[ctf] Admin cleanup returned ${res.status}. Manual cleanup Cypher:`);
    console.warn(`  MATCH (n:SemanticNode) WHERE n.source STARTS WITH '${CTF_SOURCE_PREFIX}' DETACH DELETE n`);
    return -1;
  } catch (err) {
    console.error('[ctf] wipeCtfNodes failed:', err);
    console.warn('[ctf] Manual cleanup Cypher:');
    console.warn(`  MATCH (n:SemanticNode) WHERE n.source STARTS WITH '${CTF_SOURCE_PREFIX}' DETACH DELETE n`);
    return -1;
  }
}

export async function snapshotGraph(apiKey: string): Promise<GraphSnapshot> {
  const timestamp = new Date().toISOString();

  try {
    const res = await fetch(`${inerrataApiUrl()}/api/v1/graph/stats`, {
      headers: authHeaders(apiKey),
      signal: AbortSignal.timeout(10_000),
    });

    if (res.ok) {
      const stats = parseStatsPayload(await res.json().catch(() => ({})));
      return { ...stats, timestamp };
    }

    console.warn(`[ctf] /graph/stats returned ${res.status}; falling back to NDJSON count`);
  } catch (err) {
    console.warn('[ctf] /graph/stats failed; falling back to NDJSON count:', err);
  }

  try {
    const ndjsonRes = await fetch(`${inerrataApiUrl()}/api/v1/graph/full?tier=significant&limit=50000`, {
      headers: authHeaders(apiKey),
      signal: AbortSignal.timeout(30_000),
    });

    if (!ndjsonRes.ok) {
      console.warn(`[ctf] NDJSON fallback failed: ${ndjsonRes.status}`);
      return { nodeCount: 0, edgeCount: 0, timestamp };
    }

    const stats = parseNdjsonGraphSnapshot(await ndjsonRes.text());
    return { ...stats, timestamp };
  } catch (err) {
    console.error('[ctf] snapshotGraph failed:', err);
    return { nodeCount: 0, edgeCount: 0, timestamp };
  }
}

export async function drainExtraction(timeoutMs: number = 30_000): Promise<void> {
  const apiKey = process.env.INERRATA_API_KEY ?? '';
  const pollIntervalMs = 5_000;
  const stabilityThreshold = 2;
  const startTime = Date.now();
  let stableCount = 0;
  let lastSnapshot = await snapshotGraph(apiKey);

  console.log(`[ctf] Waiting up to ${Math.round(timeoutMs / 1000)}s for extraction to stabilize...`);

  while (Date.now() - startTime < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));

    const snapshot = await snapshotGraph(apiKey);
    const elapsed = Math.round((Date.now() - startTime) / 1000);

    if (snapshot.nodeCount === lastSnapshot.nodeCount && snapshot.edgeCount === lastSnapshot.edgeCount) {
      stableCount++;
      console.log(`[ctf] Extraction stable (${stableCount}/${stabilityThreshold}) at ${snapshot.nodeCount} nodes, ${snapshot.edgeCount} edges [${elapsed}s]`);
      if (stableCount >= stabilityThreshold) {
        console.log(`[ctf] Extraction drain complete: ${snapshot.nodeCount} nodes, ${snapshot.edgeCount} edges.`);
        return;
      }
    } else {
      const nodeDelta = snapshot.nodeCount - lastSnapshot.nodeCount;
      const edgeDelta = snapshot.edgeCount - lastSnapshot.edgeCount;
      console.log(`[ctf] Extraction: ${nodeDelta >= 0 ? '+' : ''}${nodeDelta} nodes, ${edgeDelta >= 0 ? '+' : ''}${edgeDelta} edges (${snapshot.nodeCount}/${snapshot.edgeCount} total) [${elapsed}s]`);
      stableCount = 0;
      lastSnapshot = snapshot;
    }
  }

  console.warn(`[ctf] Extraction drain timed out after ${Math.round(timeoutMs / 1000)}s.`);
}
