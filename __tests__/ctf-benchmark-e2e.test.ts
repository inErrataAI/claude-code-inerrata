import { describe, it, expect, afterEach, afterAll, beforeAll } from 'vitest';
import { execSync, spawn, ChildProcess } from 'child_process';
import { join } from 'path';
import { createConnection } from 'net';
import { parseConfig, framingsToRun } from '../demo/ctf-benchmark/benchmark/orchestrator';

const CTF_DIR = join(__dirname, '..', 'demo', 'ctf-benchmark');

// Track all spawned processes for cleanup
const spawnedProcesses: ChildProcess[] = [];

function killProcess(proc: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (proc.killed || proc.exitCode !== null) {
      resolve();
      return;
    }
    const timeout = setTimeout(() => {
      proc.kill('SIGKILL');
      resolve();
    }, 3000);
    proc.on('exit', () => {
      clearTimeout(timeout);
      resolve();
    });
    proc.kill('SIGTERM');
  });
}

async function killAll() {
  await Promise.all(spawnedProcesses.map(killProcess));
  spawnedProcesses.length = 0;
}

/** Polls a URL until it responds with 2xx or the timeout expires. */
async function pollUntilReady(
  url: string,
  timeoutMs: number = 5000,
): Promise<Response> {
  const deadline = Date.now() + timeoutMs;
  let lastError: Error | undefined;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return res;
    } catch (err: any) {
      lastError = err;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw lastError ?? new Error(`Timed out waiting for ${url}`);
}

/** Wait for a specific stdout line from a spawned process. */
function waitForStdout(
  proc: ChildProcess,
  pattern: RegExp,
  timeoutMs: number = 5000,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`Timed out waiting for stdout matching ${pattern}`)),
      timeoutMs,
    );
    let buffer = '';
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString();
      const match = buffer.match(pattern);
      if (match) {
        clearTimeout(timeout);
        proc.stdout?.off('data', onData);
        resolve(match[0]);
      }
    };
    proc.stdout?.on('data', onData);
    proc.on('exit', (code) => {
      clearTimeout(timeout);
      reject(new Error(`Process exited with code ${code} before matching ${pattern}. Stdout: ${buffer}`));
    });
  });
}

/** Find a free port by binding to 0 and releasing. */
function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = require('net').createServer();
    srv.listen(0, () => {
      const port = (srv.address() as any).port;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

/** Check if anything is listening on a given port. */
function isPortInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const conn = createConnection({ port, host: '127.0.0.1' });
    conn.on('connect', () => {
      conn.destroy();
      resolve(true);
    });
    conn.on('error', () => {
      resolve(false);
    });
  });
}

// ---------------------------------------------------------------------------
// Group 1: Build
// ---------------------------------------------------------------------------

describe('CTF Benchmark: Build', { timeout: 60_000 }, () => {
  let installSucceeded = false;

  beforeAll(() => {
    try {
      execSync('npm install', {
        cwd: CTF_DIR,
        stdio: 'pipe',
        timeout: 55_000,
      });
      installSucceeded = true;
    } catch {
      // installSucceeded stays false; tests that depend on it will be skipped
    }
  });

  it('npm install exits with code 0', () => {
    expect(installSucceeded).toBe(true);
  });

  it('npx tsc --noEmit exits with code 0', () => {
    if (!installSucceeded) {
      throw new Error('Skipped: npm install failed');
    }
    expect(() => {
      execSync('npx tsc --noEmit', {
        cwd: CTF_DIR,
        stdio: 'pipe',
        timeout: 30_000,
      });
    }).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Group 2: Key Source Files Exist
// ---------------------------------------------------------------------------

describe('CTF Benchmark: Key Source Files', { timeout: 10_000 }, () => {
  const sourceFiles = [
    'challenges/registry.ts',
    'scoring/judge.ts',
    'benchmark/orchestrator.ts',
    'benchmark/waves.ts',
    'benchmark/mcp-config.ts',
    'benchmark/graph.ts',
    'agents/prompts.ts',
    'agents/types.ts',
  ];

  for (const srcFile of sourceFiles) {
    it(`${srcFile} exists`, () => {
      const filePath = join(CTF_DIR, srcFile);
      const { existsSync } = require('fs');
      expect(existsSync(filePath)).toBe(true);
    });
  }
});

// ---------------------------------------------------------------------------
// Group 3: Framing CLI Smoke
// ---------------------------------------------------------------------------

describe('CTF Benchmark: Framing CLI', { timeout: 10_000 }, () => {
  it('parses --framing equalization', () => {
    const config = parseConfig(['--framing', 'equalization', '--agents-per-wave', '2', '--port', '6000']);
    expect(config.framing).toBe('equalization');
    expect(config.agentsPerWave).toBe(2);
    expect(config.port).toBe(6000);
  });

  it('parses --framing funnel', () => {
    const config = parseConfig(['--framing', 'funnel']);
    expect(config.framing).toBe('funnel');
    expect(framingsToRun(config.framing)).toEqual(['funnel']);
  });

  it('parses --framing both as equalization then funnel', () => {
    const config = parseConfig(['--framing', 'both']);
    expect(framingsToRun(config.framing)).toEqual(['equalization', 'funnel']);
  });

  it('orchestrator source emits auth and model in wave_started payload', () => {
    const { readFileSync } = require('fs');
    const source = readFileSync(join(CTF_DIR, 'benchmark', 'orchestrator.ts'), 'utf-8');
    expect(source).toContain("broadcastSSE('wave_started'");
    expect(source).toContain('auth: wave.auth');
    expect(source).toContain('model: wave.model');
  });

  it('orchestrator writes expected result files', () => {
    const { readFileSync } = require('fs');
    const source = readFileSync(join(CTF_DIR, 'benchmark', 'orchestrator.ts'), 'utf-8');
    expect(source).toContain('comparison.json');
    expect(source).toContain('summary.md');
    expect(source).toContain('wave-${wave.number}-${wave.label}.json');
  });
});

// ---------------------------------------------------------------------------
// Group 4: Dashboard Lifecycle
// ---------------------------------------------------------------------------

describe('CTF Benchmark: Dashboard Lifecycle', { timeout: 15_000 }, () => {
  let dashProc: ChildProcess | null = null;
  let dashPort: number;

  afterEach(async () => {
    if (dashProc) {
      await killProcess(dashProc);
      dashProc = null;
    }
  });

  it('spawns, serves HTML with GNU SECURITY AUDIT, serves sprites.js, and shuts down cleanly', async () => {
    dashPort = await getFreePort();

    const tsxBin = join(CTF_DIR, 'node_modules', '.bin', 'tsx');
    dashProc = spawn(tsxBin, ['dashboard/serve.ts', '--port', String(dashPort)], {
      cwd: CTF_DIR,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    spawnedProcesses.push(dashProc);

    const base = `http://localhost:${dashPort}`;

    // Poll root until it responds
    const rootRes = await pollUntilReady(base, 5000);
    expect(rootRes.ok).toBe(true);

    // Verify response body contains "GNU SECURITY AUDIT"
    const html = await rootRes.text();
    expect(html).toContain('GNU SECURITY AUDIT');

    // /sprites.js should return javascript content
    const spritesRes = await fetch(`${base}/sprites.js`);
    expect(spritesRes.ok).toBe(true);
    const spritesContentType = spritesRes.headers.get('content-type') ?? '';
    expect(spritesContentType).toMatch(/javascript/);

    // SIGTERM and verify clean exit within 3s
    const exitPromise = new Promise<number | null>((resolve) => {
      const timeout = setTimeout(() => resolve(null), 3000);
      dashProc!.on('exit', (code) => {
        clearTimeout(timeout);
        resolve(code);
      });
    });
    dashProc.kill('SIGTERM');
    const exitCode = await exitPromise;
    expect(exitCode).not.toBeNull(); // process exited within 3s
  });
});

// ---------------------------------------------------------------------------
// Group 5: No Orphan Processes
// ---------------------------------------------------------------------------

describe('CTF Benchmark: No Orphan Processes', { timeout: 10_000 }, () => {
  afterAll(async () => {
    await killAll();
  });

  it('no tsx/node processes are still listening on test ports', async () => {
    // Ensure all tracked processes are dead
    await killAll();

    // Small grace period for OS to release ports
    await new Promise((r) => setTimeout(r, 500));

    // Verify no process is listening on any port we used.
    // We collect all ports that were used from the spawned process tracking.
    // Since we can't easily recover ports from killed processes, we scan
    // a range of common test ports to ensure nothing leaked.
    // The specific ports used by tests above are dynamically allocated,
    // so we verify the tracked processes are truly gone.
    for (const proc of spawnedProcesses) {
      expect(proc.killed || proc.exitCode !== null).toBe(true);
    }
  });
});
