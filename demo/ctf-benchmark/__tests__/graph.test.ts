import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { drainExtraction, snapshotGraph, wipeCtfNodes } from '../benchmark/graph.js';

function response(body: unknown, ok = true, status = ok ? 200 : 500) {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => typeof body === 'string' ? body : JSON.stringify(body),
  } as Response;
}

describe('CTF Cold-To-Warm Demo graph hooks', () => {
  const originalApiUrl = process.env.INERRATA_API_URL;
  const originalApiKey = process.env.INERRATA_API_KEY;

  beforeEach(() => {
    process.env.INERRATA_API_URL = 'https://example.test';
    process.env.INERRATA_API_KEY = 'test-key';
  });

  afterEach(() => {
    if (originalApiUrl === undefined) delete process.env.INERRATA_API_URL;
    else process.env.INERRATA_API_URL = originalApiUrl;
    if (originalApiKey === undefined) delete process.env.INERRATA_API_KEY;
    else process.env.INERRATA_API_KEY = originalApiKey;
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe('snapshotGraph', () => {
    it('parses stats endpoint response', async () => {
      const fetchMock = vi.fn().mockResolvedValue(response({ nodeCount: 26_000, edgeCount: 80_000 }));
      vi.stubGlobal('fetch', fetchMock);

      const result = await snapshotGraph('test-key');

      expect(result.nodeCount).toBe(26_000);
      expect(result.edgeCount).toBe(80_000);
      expect(result.timestamp).toBeTruthy();
      expect(fetchMock).toHaveBeenCalledWith(
        'https://example.test/api/v1/graph/stats',
        expect.objectContaining({
          headers: { Authorization: 'Bearer test-key' },
        }),
      );
    });

    it('falls back to NDJSON totals when stats endpoint is unavailable', async () => {
      const ndjson = [
        JSON.stringify({ t: 'n', d: { id: 'p1' } }),
        JSON.stringify({ t: 'e', d: { s: 'p1', g: 's1' } }),
        JSON.stringify({ t: 'd', tn: 26_100, te: 80_200 }),
      ].join('\n');
      vi.stubGlobal('fetch', vi.fn()
        .mockResolvedValueOnce(response({}, false, 404))
        .mockResolvedValueOnce(response(ndjson)));

      const result = await snapshotGraph('test-key');

      expect(result.nodeCount).toBe(26_100);
      expect(result.edgeCount).toBe(80_200);
    });

    it('returns zeros when API is unreachable', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));

      const result = await snapshotGraph('test-key');

      expect(result.nodeCount).toBe(0);
      expect(result.edgeCount).toBe(0);
      expect(result.timestamp).toBeTruthy();
    });
  });

  describe('wipeCtfNodes', () => {
    it('returns 0 when no API key is configured', async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);

      await expect(wipeCtfNodes('')).resolves.toBe(0);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('returns deleted count from admin cleanup endpoint', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({ deletedCount: 12 })));

      await expect(wipeCtfNodes('test-key')).resolves.toBe(12);
    });

    it('returns -1 when admin cleanup endpoint is unavailable', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({}, false, 404)));

      await expect(wipeCtfNodes('test-key')).resolves.toBe(-1);
    });
  });

  describe('drainExtraction', () => {
    it('exits early when graph counts stabilize', async () => {
      vi.useFakeTimers();
      const fetchMock = vi.fn().mockResolvedValue(response({ nodeCount: 100, edgeCount: 200 }));
      vi.stubGlobal('fetch', fetchMock);

      const drain = drainExtraction(60_000);
      await vi.advanceTimersByTimeAsync(10_000);
      await expect(drain).resolves.toBeUndefined();

      expect(fetchMock).toHaveBeenCalledTimes(3);
    });
  });
});
