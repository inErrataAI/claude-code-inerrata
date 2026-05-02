export async function wipeCtfNodes(apiKey: string): Promise<number> {
  if (!apiKey) {
    console.warn('[ctf] INERRATA_API_KEY is not set; skipping CTF namespace cleanup.');
    return 0;
  }

  console.log('[ctf] CTF namespace cleanup requested for source prefix "ctf-bench".');
  console.log('[ctf] No public cleanup endpoint is available yet; use the admin Cypher cleanup pre-step if strict isolation is required.');
  return 0;
}

export async function snapshotGraph(_apiKey: string): Promise<{
  nodeCount: number;
  edgeCount: number;
  timestamp: string;
}> {
  return { nodeCount: 0, edgeCount: 0, timestamp: new Date().toISOString() };
}

export async function drainExtraction(timeoutMs: number = 30_000): Promise<void> {
  console.log(`[ctf] Waiting ${Math.round(timeoutMs / 1000)}s for extraction drain...`);
  await new Promise((resolve) => setTimeout(resolve, timeoutMs));
  console.log('[ctf] Extraction drain complete.');
}
