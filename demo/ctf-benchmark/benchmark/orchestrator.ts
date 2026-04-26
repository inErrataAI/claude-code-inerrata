#!/usr/bin/env tsx
/**
 * benchmark/orchestrator.ts — GNU Security Audit CTF Benchmark Orchestrator
 *
 * Clones real GNU source repos, spawns Claude agents to audit them for known
 * CVEs, scores findings against ground truth, and serves live state via SSE
 * for the dashboard.
 *
 * Usage:
 *   npx tsx benchmark/orchestrator.ts --mode cold
 *   npx tsx benchmark/orchestrator.ts --mode warm
 *   npx tsx benchmark/orchestrator.ts --mode full --port 5555 --results-dir ./results
 */
import { parseArgs } from 'util';
import { randomUUID, randomBytes } from 'crypto';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  writeFileSync, readFileSync, mkdirSync, existsSync, readdirSync,
} from 'fs';
import { spawn, execSync, type ChildProcess } from 'child_process';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import type {
  Challenge, AgentConfig, Finding, ScoredFinding,
  AgentRunResult, ModelTier,
} from '../agents/types.js';
import { MODEL_IDS } from '../agents/types.js';
import { buildSystemPrompt, buildRepoChallengesPrompt } from '../agents/prompts.js';
import { CHALLENGES, REPOS, getChallengesByRepo } from '../challenges/registry.js';
import { scoreFinding, scoreAllFindings, isSolved } from '../scoring/judge.js';

// ---------------------------------------------------------------------------
// Path setup
// ---------------------------------------------------------------------------

const __dirname = typeof import.meta.dirname === 'string'
  ? import.meta.dirname
  : dirname(fileURLToPath(import.meta.url));

const PROJECT_ROOT = resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

type BenchmarkMode = 'cold' | 'warm' | 'full';

interface BenchmarkConfig {
  mode: BenchmarkMode;
  port: number;
  resultsDir: string;
  reposDir: string;
  timeoutMinutes: number;
}

function parseConfig(): BenchmarkConfig {
  const { values } = parseArgs({
    options: {
      mode:           { type: 'string', default: 'cold' },
      port:           { type: 'string', default: '5555' },
      'results-dir':  { type: 'string', default: resolve(PROJECT_ROOT, 'results') },
      'repos-dir':    { type: 'string', default: resolve(PROJECT_ROOT, 'repos') },
      timeout:        { type: 'string', default: '30' },
    },
  });

  const mode = values.mode as BenchmarkMode;
  if (!['cold', 'warm', 'full'].includes(mode)) {
    throw new Error(`Invalid mode: ${mode}. Must be cold, warm, or full.`);
  }

  return {
    mode,
    port: parseInt(values.port!, 10),
    resultsDir: values['results-dir']!,
    reposDir: values['repos-dir']!,
    timeoutMinutes: parseInt(values.timeout!, 10),
  };
}

// ---------------------------------------------------------------------------
// Dashboard-compatible state (matches DashState in dashboard/serve.ts)
// ---------------------------------------------------------------------------

interface AgentState {
  id: string;
  shortId: string;
  handle: string;
  toolCalls: number;
  maxCalls: number;
  flags: string[];
  currentTool: string;
  status: 'running' | 'finished' | 'failed' | 'throttled';
  errors: number;
  graphHits: number;
  lastActivity: number;
  points: number;
}

interface DashState {
  agents: Map<string, AgentState>;
  flagTimeline: Array<{ time: number; agentId: string; challenge: string; points: number }>;
  toolCallLog: Array<{ time: number; agentId: string; tool: string }>;
  startTime: number;
  runId: string;
  target: string;
  mode: string;
  model: string;
  totalChallenges: number;
  seed: string;
}

let dashState: DashState = {
  agents: new Map(),
  flagTimeline: [],
  toolCallLog: [],
  startTime: Date.now(),
  runId: '',
  target: 'gnu-source-audit',
  mode: '',
  model: '',
  totalChallenges: CHALLENGES.length,
  seed: '',
};

// SSE connections
const sseClients: Set<ReadableStreamDefaultController> = new Set();

function broadcastSSE(event: string, data: unknown) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const ctrl of sseClients) {
    try { ctrl.enqueue(new TextEncoder().encode(payload)); } catch { sseClients.delete(ctrl); }
  }
}

// ---------------------------------------------------------------------------
// SSE server (Hono)
// ---------------------------------------------------------------------------

function startSSEServer(port: number) {
  const app = new Hono();

  // Serialize DashState for API (Map -> object)
  function serializeState() {
    return {
      ...dashState,
      agents: Object.fromEntries(dashState.agents),
    };
  }

  app.get('/api/state', (c) => c.json(serializeState()));

  app.get('/api/events', (c) => {
    const stream = new ReadableStream({
      start(controller) {
        sseClients.add(controller);
        // Send initial state
        const payload = `event: state\ndata: ${JSON.stringify(serializeState())}\n\n`;
        controller.enqueue(new TextEncoder().encode(payload));
      },
      cancel(controller) {
        sseClients.delete(controller);
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
    });
  });

  app.get('/health', (c) => c.json({ status: 'ok' }));

  serve({ fetch: app.fetch, port }, () => {
    console.log(`[orchestrator] SSE server listening on http://localhost:${port}`);
  });
}

// ---------------------------------------------------------------------------
// Repository cloning
// ---------------------------------------------------------------------------

function cloneOrUpdateRepo(repoName: string, repoUrl: string, reposDir: string): string {
  const repoPath = resolve(reposDir, repoName);
  mkdirSync(reposDir, { recursive: true });

  if (existsSync(resolve(repoPath, '.git'))) {
    console.log(`[repos] ${repoName}: already cloned at ${repoPath}`);
    return repoPath;
  }

  console.log(`[repos] Cloning ${repoName} from ${repoUrl}...`);
  execSync(`git clone --depth 50 --no-single-branch "${repoUrl}" "${repoPath}"`, {
    stdio: 'inherit',
    timeout: 300_000, // 5 min max
  });
  console.log(`[repos] ${repoName}: cloned`);
  return repoPath;
}

function checkoutVersion(repoPath: string, tag: string): void {
  try {
    execSync(`git checkout "${tag}" --force`, {
      cwd: repoPath,
      stdio: 'pipe',
      timeout: 30_000,
    });
    console.log(`[repos] Checked out ${tag}`);
  } catch {
    // Try fetching the tag first
    try {
      execSync(`git fetch origin "refs/tags/${tag}:refs/tags/${tag}"`, {
        cwd: repoPath,
        stdio: 'pipe',
        timeout: 60_000,
      });
      execSync(`git checkout "${tag}" --force`, {
        cwd: repoPath,
        stdio: 'pipe',
        timeout: 30_000,
      });
      console.log(`[repos] Fetched and checked out ${tag}`);
    } catch (err) {
      console.warn(`[repos] WARNING: Could not checkout ${tag}: ${err}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Agent spawning
// ---------------------------------------------------------------------------

function buildMcpConfig(resultsDir: string): string {
  const config = {
    mcpServers: {
      inerrata: {
        type: 'http',
        url: 'https://inerrata.ai/mcp',
        headers: {
          Authorization: `Bearer ${process.env.INERRATA_API_KEY ?? ''}`,
        },
      },
    },
  };
  mkdirSync(resultsDir, { recursive: true });
  const configPath = resolve(resultsDir, `mcp-${randomBytes(4).toString('hex')}.json`);
  writeFileSync(configPath, JSON.stringify(config));
  return configPath;
}

function spawnAuditAgent(opts: {
  agent: AgentConfig;
  systemPrompt: string;
  challengePrompt: string;
  repoPath: string;
  mcpConfigPath: string;
}): ChildProcess {
  const modelId = MODEL_IDS[opts.agent.model];

  const args: string[] = [
    '--print',
    '--model', modelId,
    '--dangerously-skip-permissions',
    '--max-turns', '25',
    '--mcp-config', opts.mcpConfigPath,
  ];

  args.push('--system-prompt', opts.systemPrompt);
  args.push(opts.challengePrompt);

  return spawn('claude', args, {
    cwd: opts.repoPath,
    env: {
      ...process.env,
      INERRATA_API_KEY: process.env.INERRATA_API_KEY ?? '',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

// ---------------------------------------------------------------------------
// Parse findings from agent output
// ---------------------------------------------------------------------------

function parseFindings(output: string, agentId: string): Finding[] {
  const findings: Finding[] = [];
  const findingRegex = /<finding>\s*([\s\S]*?)\s*<\/finding>/g;
  let match: RegExpExecArray | null;

  while ((match = findingRegex.exec(output)) !== null) {
    try {
      const raw = JSON.parse(match[1]);
      findings.push({
        agentId,
        challengeId: raw.challengeId ?? '',
        timestamp: Date.now(),
        vulnerableFile: raw.vulnerableFile ?? '',
        vulnerableFunction: raw.vulnerableFunction,
        lineRange: raw.lineRange,
        bugClass: raw.bugClass ?? 'logic-bug',
        explanation: raw.explanation ?? '',
        pocCode: raw.pocCode,
        patchSuggestion: raw.patchSuggestion,
        crossRepoPattern: raw.crossRepoPattern,
      });
    } catch {
      // Malformed JSON in finding block -- skip
      console.warn(`[orchestrator] Failed to parse finding block from ${agentId}`);
    }
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Collect output from a spawned process
// ---------------------------------------------------------------------------

function collectProcessOutput(
  child: ChildProcess,
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((res) => {
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 5_000);
    }, timeoutMs);

    child.stdout?.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr?.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

    child.on('close', (code) => {
      clearTimeout(timer);
      res({
        stdout: Buffer.concat(stdoutChunks).toString(),
        stderr: Buffer.concat(stderrChunks).toString(),
        exitCode: code ?? 1,
      });
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      stderrChunks.push(Buffer.from(err.message));
      res({
        stdout: Buffer.concat(stdoutChunks).toString(),
        stderr: Buffer.concat(stderrChunks).toString(),
        exitCode: 1,
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Run one agent through all challenges for a repo
// ---------------------------------------------------------------------------

async function runAgentForRepo(opts: {
  agent: AgentConfig;
  repoName: string;
  repoPath: string;
  challenges: Challenge[];
  config: BenchmarkConfig;
  mcpConfigPath: string;
}): Promise<AgentRunResult> {
  const { agent, repoName, repoPath, challenges, config } = opts;
  const startTime = Date.now();

  // Register agent in dashboard state
  const agentState: AgentState = {
    id: agent.id,
    shortId: agent.id.slice(0, 8),
    handle: agent.name,
    toolCalls: 0,
    maxCalls: 25,
    flags: [],
    currentTool: 'auditing',
    status: 'running',
    errors: 0,
    graphHits: 0,
    lastActivity: Date.now(),
    points: 0,
  };
  dashState.agents.set(agent.id, agentState);
  broadcastSSE('agent_started', {
    agentId: agent.id,
    handle: agent.name,
    model: MODEL_IDS[agent.model],
    mode: agent.mode,
  });

  // Checkout the vulnerable version for the first challenge
  // (all challenges for the same repo should use the same version,
  //  but if they differ, we just use the first one)
  checkoutVersion(repoPath, challenges[0].affectedVersion);

  const systemPrompt = buildSystemPrompt();
  const challengePrompt = buildRepoChallengesPrompt(challenges);

  console.log(`[agent:${agent.name}] Spawning for ${repoName} (${challenges.length} challenges)...`);

  const child = spawnAuditAgent({
    agent,
    systemPrompt,
    challengePrompt,
    repoPath,
    mcpConfigPath: opts.mcpConfigPath,
  });

  // Stream stderr for live progress
  child.stderr?.on('data', (d: Buffer) => {
    const s = d.toString().trim();
    if (s) {
      console.error(`[agent:${agent.name}] ${s}`);
      agentState.lastActivity = Date.now();
      agentState.toolCalls++;
      dashState.toolCallLog.push({
        time: Date.now(),
        agentId: agent.id,
        tool: 'audit',
      });
      broadcastSSE('tool_call', { agentId: agent.id, tool: 'audit' });
    }
  });

  const timeoutMs = config.timeoutMinutes * 60_000;
  const { stdout, stderr, exitCode } = await collectProcessOutput(child, timeoutMs);
  const endTime = Date.now();

  console.log(`[agent:${agent.name}] Finished (exit=${exitCode}, ${((endTime - startTime) / 1000).toFixed(1)}s)`);

  // Parse and score findings
  const rawFindings = parseFindings(stdout, agent.id);
  const scoredFindings = scoreAllFindings(rawFindings);
  const totalScore = scoredFindings.reduce((sum, f) => sum + f.scores.total, 0);
  const solved = scoredFindings.filter(isSolved);

  // Update dashboard state
  agentState.status = exitCode === 0 ? 'finished' : 'failed';
  agentState.currentTool = 'done';
  agentState.points = totalScore;
  for (const sf of solved) {
    agentState.flags.push(sf.challengeId);
    dashState.flagTimeline.push({
      time: sf.timestamp,
      agentId: agent.id,
      challenge: sf.challengeId,
      points: sf.scores.total,
    });
  }

  broadcastSSE('agent_finished', {
    agentId: agent.id,
    handle: agent.name,
    findings: scoredFindings.length,
    solved: solved.length,
    totalScore,
    status: agentState.status,
  });

  // Log finding details
  for (const sf of scoredFindings) {
    const solvedStr = isSolved(sf) ? 'SOLVED' : 'partial';
    console.log(
      `  [${solvedStr}] ${sf.challengeId}: ` +
      `loc=${sf.scores.location} expl=${sf.scores.explanation} ` +
      `poc=${sf.scores.poc} patch=${sf.scores.patch} cross=${sf.scores.crossRepo} ` +
      `total=${sf.scores.total}`
    );
  }

  return {
    agent,
    startTime,
    endTime,
    findings: scoredFindings,
    totalScore,
    challengesAttempted: challenges.length,
    challengesSolved: solved.length,
    graphQueries: 0,
    graphContributions: 0,
  };
}

// ---------------------------------------------------------------------------
// Wave runner: spawn 3 agents (one per model tier) in parallel
// ---------------------------------------------------------------------------

async function runWave(opts: {
  waveNum: number;
  mode: 'cold' | 'warm';
  challenges: Challenge[];
  config: BenchmarkConfig;
}): Promise<AgentRunResult[]> {
  const { waveNum, mode, challenges, config } = opts;
  const tiers: ModelTier[] = ['opus', 'sonnet', 'haiku'];

  console.log(`\n${'='.repeat(60)}`);
  console.log(`  Wave ${waveNum}: ${mode.toUpperCase()} (${tiers.join(', ')})`);
  console.log(`${'='.repeat(60)}\n`);

  broadcastSSE('wave_started', {
    wave: waveNum,
    mode,
    models: tiers,
    challengeCount: challenges.length,
  });

  // Group challenges by repo
  const byRepo = new Map<string, Challenge[]>();
  for (const ch of challenges) {
    const list = byRepo.get(ch.repo) ?? [];
    list.push(ch);
    byRepo.set(ch.repo, list);
  }

  // ALL agents get inErrata MCP access.
  // Cold agents start with an empty graph and contribute findings as they go.
  // Warm agents query a graph populated by prior cold-run contributions.
  const mcpConfigPath = buildMcpConfig(config.resultsDir);

  // Each agent processes all repos sequentially (challenges within each repo are batched)
  const agentPromises: Promise<AgentRunResult>[] = [];

  for (const tier of tiers) {
    const agentId = `${tier}-${mode}-w${waveNum}-${randomBytes(3).toString('hex')}`;
    const agent: AgentConfig = {
      id: agentId,
      name: `${tier}-${mode}-w${waveNum}`,
      model: tier,
      mode,
      spriteType: tier,
    };

    // Run all repos sequentially for this agent
    const agentWork = async (): Promise<AgentRunResult> => {
      const allFindings: ScoredFinding[] = [];
      let totalChallengesAttempted = 0;
      let totalChallengesSolved = 0;
      let graphQueries = 0;
      let graphContributions = 0;
      const agentStartTime = Date.now();

      for (const [repoName, repoChallenges] of byRepo) {
        const repoUrl = REPOS[repoName];
        if (!repoUrl) continue;

        const repoPath = cloneOrUpdateRepo(repoName, repoUrl, config.reposDir);

        const result = await runAgentForRepo({
          agent,
          repoName,
          repoPath,
          challenges: repoChallenges,
          config,
          mcpConfigPath,
        });

        allFindings.push(...result.findings);
        totalChallengesAttempted += result.challengesAttempted;
        totalChallengesSolved += result.challengesSolved;
        graphQueries += result.graphQueries;
        graphContributions += result.graphContributions;
      }

      const totalScore = allFindings.reduce((s, f) => s + f.scores.total, 0);

      return {
        agent,
        startTime: agentStartTime,
        endTime: Date.now(),
        findings: allFindings,
        totalScore,
        challengesAttempted: totalChallengesAttempted,
        challengesSolved: totalChallengesSolved,
        graphQueries,
        graphContributions,
      };
    };

    agentPromises.push(agentWork());
  }

  const results = await Promise.all(agentPromises);

  const waveTotalScore = results.reduce((s, r) => s + r.totalScore, 0);
  const waveTotalSolved = results.reduce((s, r) => s + r.challengesSolved, 0);

  broadcastSSE('wave_finished', {
    wave: waveNum,
    mode,
    totalScore: waveTotalScore,
    totalSolved: waveTotalSolved,
  });

  console.log(`\n  Wave ${waveNum} complete: ${waveTotalSolved} solved, ${waveTotalScore} total score\n`);

  return results;
}

// ---------------------------------------------------------------------------
// Result persistence
// ---------------------------------------------------------------------------

interface BenchmarkResult {
  runId: string;
  config: BenchmarkConfig;
  waves: Array<{
    waveNum: number;
    mode: 'cold' | 'warm';
    results: AgentRunResult[];
  }>;
  startedAt: string;
  completedAt: string;
  totalScore: number;
  totalSolved: number;
}

function saveResult(result: BenchmarkResult): string {
  mkdirSync(result.config.resultsDir, { recursive: true });
  const filename = `${result.runId.slice(0, 8)}-${result.config.mode}.json`;
  const path = resolve(result.config.resultsDir, filename);
  writeFileSync(path, JSON.stringify(result, null, 2));
  console.log(`[orchestrator] Results saved: ${path}`);
  return path;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const config = parseConfig();
  const runId = randomUUID();

  // Initialize dashboard state
  dashState.runId = runId.slice(0, 8);
  dashState.mode = config.mode;
  dashState.startTime = Date.now();

  console.log(`\n${'='.repeat(60)}`);
  console.log(`  GNU Security Audit CTF Benchmark`);
  console.log(`  Mode:        ${config.mode}`);
  console.log(`  Challenges:  ${CHALLENGES.length}`);
  console.log(`  Repos:       ${Object.keys(REPOS).join(', ')}`);
  console.log(`  Timeout:     ${config.timeoutMinutes}min per agent`);
  console.log(`  Results:     ${config.resultsDir}`);
  console.log(`  Run ID:      ${runId.slice(0, 8)}`);
  console.log(`${'='.repeat(60)}\n`);

  // Start SSE server for live dashboard
  startSSEServer(config.port);

  // Clone all repos upfront
  console.log('[orchestrator] Cloning repositories...');
  for (const [name, url] of Object.entries(REPOS)) {
    try {
      cloneOrUpdateRepo(name, url, config.reposDir);
    } catch (err) {
      console.error(`[orchestrator] Failed to clone ${name}: ${err}`);
    }
  }

  const startedAt = new Date().toISOString();
  const allWaves: BenchmarkResult['waves'] = [];

  if (config.mode === 'cold' || config.mode === 'full') {
    const coldResults = await runWave({
      waveNum: 1,
      mode: 'cold',
      challenges: CHALLENGES,
      config,
    });
    allWaves.push({ waveNum: 1, mode: 'cold', results: coldResults });
  }

  if (config.mode === 'warm' || config.mode === 'full') {
    const warmResults = await runWave({
      waveNum: config.mode === 'full' ? 2 : 1,
      mode: 'warm',
      challenges: CHALLENGES,
      config,
    });
    allWaves.push({
      waveNum: config.mode === 'full' ? 2 : 1,
      mode: 'warm',
      results: warmResults,
    });
  }

  // Summary
  const totalScore = allWaves.reduce(
    (s, w) => s + w.results.reduce((ws, r) => ws + r.totalScore, 0), 0,
  );
  const totalSolved = allWaves.reduce(
    (s, w) => s + w.results.reduce((ws, r) => ws + r.challengesSolved, 0), 0,
  );

  console.log(`\n${'='.repeat(60)}`);
  console.log(`  Final Results — Run ${runId.slice(0, 8)}`);
  console.log(`${'='.repeat(60)}`);

  for (const wave of allWaves) {
    console.log(`\n  Wave ${wave.waveNum} (${wave.mode}):`);
    for (const result of wave.results) {
      console.log(
        `    ${result.agent.name}: ` +
        `${result.challengesSolved}/${result.challengesAttempted} solved, ` +
        `${result.totalScore} pts, ` +
        `${((result.endTime - result.startTime) / 1000).toFixed(1)}s`
      );
    }
  }

  console.log(`\n  Total: ${totalSolved} solved, ${totalScore} pts`);
  console.log(`${'='.repeat(60)}\n`);

  // Save results
  const benchmarkResult: BenchmarkResult = {
    runId,
    config,
    waves: allWaves,
    startedAt,
    completedAt: new Date().toISOString(),
    totalScore,
    totalSolved,
  };
  saveResult(benchmarkResult);

  // Keep SSE server alive for dashboard
  console.log(`[orchestrator] Dashboard available at http://localhost:${config.port}`);
  console.log('[orchestrator] Press Ctrl+C to exit.');
}

main().catch((err) => {
  console.error('[orchestrator] Benchmark failed:', err);
  process.exit(1);
});
