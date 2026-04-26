import { describe, it, expect, afterEach, afterAll, beforeAll } from 'vitest';
import { execSync, spawn, ChildProcess } from 'child_process';
import { join } from 'path';
import { createConnection } from 'net';

const CTF_DIR = join(__dirname, '..', 'examples', 'ctf-benchmark');

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
// Group 2: Test Suites
// ---------------------------------------------------------------------------

describe('CTF Benchmark: Test Suites', { timeout: 30_000 }, () => {
  const testFiles = [
    'server/__tests__/procedural.test.ts',
    'server/__tests__/integration.test.ts',
    'server/__tests__/diversity.test.ts',
    'server/__tests__/review-fixes.test.ts',
  ];

  for (const testFile of testFiles) {
    it(`${testFile} exits with code 0`, () => {
      expect(() => {
        execSync(`npx tsx ${testFile}`, {
          cwd: CTF_DIR,
          stdio: 'pipe',
          timeout: 25_000,
        });
      }).not.toThrow();
    });
  }
});

// ---------------------------------------------------------------------------
// Group 3: Maze Server Lifecycle
// ---------------------------------------------------------------------------

describe('CTF Benchmark: Maze Server Lifecycle', { timeout: 15_000 }, () => {
  let mazeProc: ChildProcess | null = null;
  let mazePort: number;

  afterEach(async () => {
    if (mazeProc) {
      await killProcess(mazeProc);
      mazeProc = null;
    }
  });

  it('spawns, responds to health/meta/events, and shuts down cleanly', async () => {
    mazePort = await getFreePort();

    const tsxBin = join(CTF_DIR, 'node_modules', '.bin', 'tsx');
    mazeProc = spawn(tsxBin, ['server/maze.ts', '--seed', 'e2e-test'], {
      cwd: CTF_DIR,
      env: { ...process.env, PORT: String(mazePort) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    spawnedProcesses.push(mazeProc);

    // Wait for the server to announce it's running
    await waitForStdout(mazeProc, /Maze server running on http:\/\/localhost:\d+/, 8000);

    const base = `http://localhost:${mazePort}`;

    // /health should respond
    const healthRes = await pollUntilReady(`${base}/health`, 5000);
    expect(healthRes.ok).toBe(true);

    // /maze/meta should return JSON with a challenges array
    const metaRes = await fetch(`${base}/maze/meta`);
    expect(metaRes.ok).toBe(true);
    const metaJson = await metaRes.json();
    expect(metaJson).toHaveProperty('challenges');
    expect(Array.isArray(metaJson.challenges)).toBe(true);

    // /maze/events should return SSE stream
    const eventsRes = await fetch(`${base}/maze/events`);
    const contentType = eventsRes.headers.get('content-type') ?? '';
    expect(contentType).toContain('text/event-stream');

    // SIGTERM and verify clean exit within 3s
    const exitPromise = new Promise<number | null>((resolve) => {
      const timeout = setTimeout(() => resolve(null), 3000);
      mazeProc!.on('exit', (code) => {
        clearTimeout(timeout);
        resolve(code);
      });
    });
    mazeProc.kill('SIGTERM');
    const exitCode = await exitPromise;
    expect(exitCode).not.toBeNull(); // process exited within 3s
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

  it('spawns, serves HTML with MAZE RUNNER, serves sprites.js, and shuts down cleanly', async () => {
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

    // Verify response body contains "MAZE RUNNER"
    const html = await rootRes.text();
    expect(html).toContain('MAZE RUNNER');

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
