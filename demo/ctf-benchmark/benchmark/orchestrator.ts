#!/usr/bin/env tsx
/**
 * benchmark/orchestrator.ts -- GNU Security Audit CTF Benchmark Orchestrator
 *
 * Runs framing-based waves of Claude CLI agents against GNU CVE challenges.
 *
 * Usage:
 *   npx tsx benchmark/orchestrator.ts --framing equalization --port 5555
 *   npx tsx benchmark/orchestrator.ts --framing funnel --port 5555
 *   npx tsx benchmark/orchestrator.ts --framing both --port 5555
 */
import { parseArgs } from 'util';
import { randomUUID, randomBytes } from 'crypto';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { spawn, execSync, exec, type ChildProcess } from 'child_process';
import { promisify } from 'util';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import type {
  AgentConfig,
  AgentRunResult,
  AgentState,
  BenchmarkFraming,
  Challenge,
  DashboardState,
  Difficulty,
  Finding,
  FlagEvent,
  ModelTier,
  ScoredFinding,
  Wave,
  WaveConfig,
} from '../shared/types.js';
import { buildSystemPrompt, buildChallengePrompt } from '../agents/prompts.js';
import { CHALLENGES, REPOS } from '../challenges/registry.js';
import { scoreAllFindings, isSolved } from '../scoring/judge.js';
import { buildMcpConfig } from './mcp-config.js';
import { drainExtraction, snapshotGraph, wipeCtfNodes } from './graph.js';
import { EQUALIZATION_WAVES, FUNNEL_WAVES, wavesForFraming } from './waves.js';

const execAsync = promisify(exec);

const __dirname = typeof import.meta.dirname === 'string'
  ? import.meta.dirname
  : dirname(fileURLToPath(import.meta.url));

const PROJECT_ROOT = resolve(__dirname, '..');

export type FramingCli = BenchmarkFraming | 'both';

export interface BenchmarkConfig {
  framing: FramingCli;
  port: number;
  resultsDir: string;
  reposDir: string;
  timeoutMinutes: number;
  agentsPerWave: number;
  maxDifficulty?: Difficulty;
  challengeId?: string;
}

export function parseConfig(argv: string[] = process.argv.slice(2)): BenchmarkConfig {
  const { values } = parseArgs({
    args: argv,
    options: {
      framing: { type: 'string', default: 'equalization' },
      port: { type: 'string', default: '5555' },
      'results-dir': { type: 'string', default: resolve(PROJECT_ROOT, 'results') },
      'repos-dir': { type: 'string', default: resolve(PROJECT_ROOT, 'repos') },
      timeout: { type: 'string', default: '30' },
      'agents-per-wave': { type: 'string', default: '1' },
      'max-difficulty': { type: 'string' },
      challenge: { type: 'string' },
    },
  });

  const framing = values.framing as FramingCli;
  if (!['equalization', 'funnel', 'both'].includes(framing)) {
    throw new Error(`Invalid framing: ${framing}. Must be equalization, funnel, or both.`);
  }

  const maxDiff = values['max-difficulty']
    ? parseInt(values['max-difficulty'], 10) as Difficulty
    : undefined;
  if (maxDiff !== undefined && ![1, 2, 3, 4, 5].includes(maxDiff)) {
    throw new Error(`Invalid --max-difficulty: ${maxDiff}. Must be 1-5.`);
  }

  const agentsPerWave = parseInt(values['agents-per-wave']!, 10);
  if (!Number.isFinite(agentsPerWave) || agentsPerWave < 1) {
    throw new Error(`Invalid --agents-per-wave: ${values['agents-per-wave']}. Must be >= 1.`);
  }

  return {
    framing,
    port: parseInt(values.port!, 10),
    resultsDir: values['results-dir']!,
    reposDir: values['repos-dir']!,
    timeoutMinutes: parseInt(values.timeout!, 10),
    agentsPerWave,
    maxDifficulty: maxDiff,
    challengeId: values.challenge,
  };
}

export function framingsToRun(framing: FramingCli): BenchmarkFraming[] {
  return framing === 'both' ? ['equalization', 'funnel'] : [framing];
}

let runId = randomUUID();
let activeFraming: BenchmarkFraming | undefined;
let activeChallenges: Challenge[] = CHALLENGES;

const agentStates: Record<string, AgentState> = {};
const waves: Wave[] = [];
const flags: FlagEvent[] = [];
const sseClients: Set<ReadableStreamDefaultController> = new Set();

function resetDashboardState(framing?: BenchmarkFraming) {
  runId = randomUUID();
  activeFraming = framing;
  for (const key of Object.keys(agentStates)) delete agentStates[key];
  waves.length = 0;
  flags.length = 0;
}

function buildDashboardState(): DashboardState {
  return {
    agents: { ...agentStates },
    challenges: activeChallenges,
    waves: [...waves],
    currentWave: waves.length > 0 ? waves[waves.length - 1].number : 0,
    flags: [...flags],
    runId: runId.slice(0, 8),
    framing: activeFraming,
  };
}

function broadcastSSE(event: string, data: unknown) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const ctrl of sseClients) {
    try {
      ctrl.enqueue(new TextEncoder().encode(payload));
    } catch {
      sseClients.delete(ctrl);
    }
  }
}

function startSSEServer(port: number) {
  const app = new Hono();

  app.get('/api/state', (c) => c.json(buildDashboardState()));

  app.get('/api/events', () => {
    const stream = new ReadableStream({
      start(controller) {
        sseClients.add(controller);
        controller.enqueue(new TextEncoder().encode(
          `event: state\ndata: ${JSON.stringify(buildDashboardState())}\n\n`,
        ));
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

async function cloneOrUpdateRepo(repoName: string, repoUrl: string, reposDir: string): Promise<string> {
  const repoPath = resolve(reposDir, repoName);
  mkdirSync(reposDir, { recursive: true });

  if (existsSync(resolve(repoPath, '.git'))) {
    console.log(`[repos] ${repoName}: already cloned at ${repoPath}`);
    return repoPath;
  }

  console.log(`[repos] Cloning ${repoName} from ${repoUrl}...`);
  await execAsync(`git clone "${repoUrl}" "${repoPath}"`, { timeout: 600_000 });
  console.log(`[repos] ${repoName}: cloned`);
  return repoPath;
}

function checkoutVersion(repoPath: string, tag: string): void {
  try {
    execSync(`git checkout "${tag}" --force`, { cwd: repoPath, stdio: 'pipe', timeout: 30_000 });
    console.log(`[repos] Checked out ${tag}`);
  } catch {
    try {
      execSync(`git fetch origin "refs/tags/${tag}:refs/tags/${tag}"`, {
        cwd: repoPath,
        stdio: 'pipe',
        timeout: 60_000,
      });
      execSync(`git checkout "${tag}" --force`, { cwd: repoPath, stdio: 'pipe', timeout: 30_000 });
      console.log(`[repos] Fetched and checked out ${tag}`);
    } catch (err) {
      console.warn(`[repos] WARNING: Could not checkout ${tag}: ${err}`);
    }
  }
}

function spriteForWave(wave: WaveConfig): string {
  const base: Record<ModelTier, string> = {
    opus: 'opus-wizard',
    sonnet: 'sonnet-bard',
    haiku: 'haiku-rogue',
  };
  return `${base[wave.model]} ${wave.spriteType}`;
}

function spawnAuditAgent(opts: {
  agent: AgentConfig;
  wave: WaveConfig;
  systemPrompt: string;
  challengePrompt: string;
  repoPath: string;
  mcpConfigPath: string;
}): ChildProcess {
  const args: string[] = [
    '--print',
    '--verbose',
    '--output-format', 'stream-json',
    '--effort', 'max',
    '--model', opts.wave.modelId,
    '--dangerously-skip-permissions',
    '--max-turns', '35',
    '--mcp-config', opts.mcpConfigPath,
    '--plugin-dir', PROJECT_ROOT,
    '--system-prompt', opts.systemPrompt,
    '-p', opts.challengePrompt,
  ];

  return spawn('claude', args, {
    cwd: opts.repoPath,
    env: {
      ...process.env,
      INERRATA_API_KEY: process.env.INERRATA_API_KEY ?? '',
      CTF_WAVE_LABEL: opts.wave.label,
      CTF_CAN_CONTRIBUTE: opts.wave.canContribute ? 'true' : 'false',
      CTF_AGENT_SOURCE: `ctf-bench-${opts.wave.label}-${opts.agent.id}`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function parseStreamJson(raw: string): {
  text: string;
  toolCalls: string[];
} {
  const text: string[] = [];
  const toolCalls: string[] = [];

  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);

      if (obj.type === 'assistant' && obj.message?.content) {
        for (const block of obj.message.content) {
          if (block.type === 'text') text.push(block.text);
          if (block.type === 'tool_use') toolCalls.push(block.name);
        }
      }

      if (obj.type === 'tool_use') {
        toolCalls.push(obj.name || obj.tool || 'unknown');
      }

      if (obj.type === 'tool_result' || obj.type === 'result') {
        if (obj.result) text.push(typeof obj.result === 'string' ? obj.result : JSON.stringify(obj.result));
        if (obj.content) text.push(typeof obj.content === 'string' ? obj.content : JSON.stringify(obj.content));
      }
    } catch {
      text.push(line);
    }
  }

  return { text: text.join('\n'), toolCalls };
}

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
      console.warn(`[orchestrator] Failed to parse finding block from ${agentId}`);
    }
  }

  return findings;
}

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

function ensureAgentState(agent: AgentConfig, wave: WaveConfig, challenge: Challenge): AgentState {
  if (!agentStates[agent.id]) {
    agentStates[agent.id] = {
      id: agent.id,
      name: agent.name,
      model: agent.model,
      auth: agent.auth,
      waveLabel: wave.label,
      sprite: spriteForWave(wave),
      status: 'running',
      currentChallenge: challenge.id,
      currentRepo: challenge.repo,
      flagsCaptured: 0,
      totalPoints: 0,
      toolCalls: 0,
      graphHits: 0,
      findings: [],
      wave: wave.number,
    };
  }

  const state = agentStates[agent.id];
  state.status = 'running';
  state.currentChallenge = challenge.id;
  state.currentRepo = challenge.repo;
  state.wave = wave.number;
  return state;
}

function classifyToolCalls(toolCalls: string[]): { graphQueries: number; graphContributions: number; graphHits: number } {
  const queryNames = new Set([
    'search', 'burst', 'explore', 'expand', 'browse', 'get_node', 'graph_initialize',
    'trace', 'similar', 'why', 'guide', 'flow',
  ]);
  const writeNames = new Set([
    'contribute', 'validate_solution', 'report_failure', 'learn', 'correct', 'vote',
    'ask', 'answer',
  ]);

  let graphQueries = 0;
  let graphContributions = 0;

  for (const rawName of toolCalls) {
    const name = rawName.replace(/^mcp__inerrata__/, '');
    if (queryNames.has(name)) graphQueries++;
    if (writeNames.has(name)) graphContributions++;
  }

  return {
    graphQueries,
    graphContributions,
    graphHits: graphQueries + graphContributions,
  };
}

async function runAgentForChallenge(opts: {
  agent: AgentConfig;
  wave: WaveConfig;
  challenge: Challenge;
  repoPath: string;
  config: BenchmarkConfig;
  framingResultsDir: string;
  mcpConfigPath: string;
}): Promise<{ findings: ScoredFinding[]; graphQueries: number; graphContributions: number }> {
  const { agent, wave, challenge, repoPath, config, framingResultsDir } = opts;
  const agentState = ensureAgentState(agent, wave, challenge);
  const startTime = Date.now();

  broadcastSSE('agent_challenge_start', {
    agentId: agent.id,
    challengeId: challenge.id,
    model: agent.model,
    auth: agent.auth,
    wave: wave.number,
    label: wave.label,
  });

  checkoutVersion(repoPath, challenge.affectedVersion);

  const child = spawnAuditAgent({
    agent,
    wave,
    systemPrompt: buildSystemPrompt(wave),
    challengePrompt: buildChallengePrompt(challenge, wave),
    repoPath,
    mcpConfigPath: opts.mcpConfigPath,
  });

  child.stderr?.on('data', (chunk: Buffer) => {
    const text = chunk.toString().trim();
    if (!text) return;
    agentState.toolCalls++;
    broadcastSSE('tool_call', { agentId: agent.id, tool: 'audit', challengeId: challenge.id });
  });

  const { stdout, stderr, exitCode } = await collectProcessOutput(child, config.timeoutMinutes * 60_000);
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`[agent:${agent.name}] ${challenge.id} finished exit=${exitCode} in ${elapsed}s`);
  if (stderr.trim()) console.warn(`[agent:${agent.name}] stderr: ${stderr.trim().slice(0, 500)}`);

  writeFileSync(resolve(framingResultsDir, `${agent.id}-${challenge.id}.ndjson`), stdout);

  const parsed = parseStreamJson(stdout);
  writeFileSync(resolve(framingResultsDir, `${agent.id}-${challenge.id}.txt`), parsed.text);

  const classified = classifyToolCalls(parsed.toolCalls);
  agentState.toolCalls += parsed.toolCalls.length;
  agentState.graphHits += classified.graphHits;

  for (const toolName of parsed.toolCalls) {
    if (toolName.includes('inerrata')) {
      broadcastSSE('graph_hit', { agentId: agent.id, challengeId: challenge.id, tool: toolName });
    }
  }

  const rawFindings = parseFindings(parsed.text, agent.id);
  const scoredFindings = scoreAllFindings(rawFindings);

  for (const finding of scoredFindings) {
    agentState.findings.push(finding);
    agentState.totalPoints += finding.scores.total;

    if (isSolved(finding)) {
      agentState.flagsCaptured++;
      const flagEvent: FlagEvent = {
        agentId: agent.id,
        challengeId: finding.challengeId,
        points: finding.scores.total,
        timestamp: finding.timestamp,
        wave: wave.number,
        waveLabel: wave.label,
      };
      flags.push(flagEvent);
      broadcastSSE('flag_captured', flagEvent);
    }
  }

  return {
    findings: scoredFindings,
    graphQueries: classified.graphQueries,
    graphContributions: classified.graphContributions,
  };
}

async function prepareRepos(challenges: Challenge[], reposDir: string): Promise<Map<string, string>> {
  const repoPaths = new Map<string, string>();
  const uniqueRepos = [...new Set(challenges.map(ch => ch.repo))];

  await Promise.all(uniqueRepos.map(async (repo) => {
    const repoUrl = REPOS[repo];
    if (!repoUrl) return;
    try {
      repoPaths.set(repo, await cloneOrUpdateRepo(repo, repoUrl, reposDir));
    } catch (err) {
      console.error(`[orchestrator] Failed to clone ${repo}: ${err}`);
    }
  }));

  return repoPaths;
}

async function runWave(opts: {
  wave: WaveConfig;
  framing: BenchmarkFraming;
  challenges: Challenge[];
  config: BenchmarkConfig;
  framingResultsDir: string;
  repoPaths: Map<string, string>;
}): Promise<AgentRunResult[]> {
  const { wave, challenges, config, framingResultsDir, repoPaths } = opts;
  const apiKey = process.env.INERRATA_API_KEY ?? '';

  console.log(`\n${'='.repeat(72)}`);
  console.log(`  Wave ${wave.number}: ${wave.label} (${wave.model}, auth=${wave.auth})`);
  console.log(`  ${wave.description}`);
  console.log(`${'='.repeat(72)}\n`);

  const waveRecord: Wave = {
    number: wave.number,
    label: wave.label,
    mode: wave.auth,
    auth: wave.auth,
    model: wave.model,
    modelId: wave.modelId,
    canContribute: wave.canContribute,
    graphState: wave.graphState,
    description: wave.description,
    challenges: challenges.map(c => c.id),
    scores: {},
    startTime: Date.now(),
  };
  waves.push(waveRecord);

  broadcastSSE('wave_started', {
    wave: wave.number,
    label: wave.label,
    model: wave.model,
    modelId: wave.modelId,
    auth: wave.auth,
    description: wave.description,
    canContribute: wave.canContribute,
  });

  const agents: AgentConfig[] = [];
  for (let i = 0; i < config.agentsPerWave; i++) {
    const suffix = config.agentsPerWave === 1 ? randomBytes(3).toString('hex') : `a${i + 1}-${randomBytes(2).toString('hex')}`;
    const agent: AgentConfig = {
      id: `${wave.label}-w${wave.number}-${suffix}`,
      name: `${wave.label}${config.agentsPerWave > 1 ? `-${i + 1}` : ''}`,
      model: wave.model,
      auth: wave.auth,
      wave: wave.number,
      waveLabel: wave.label,
      spriteType: wave.spriteType,
      canContribute: wave.canContribute,
    };
    agents.push(agent);
    waveRecord.scores[agent.id] = {};
  }

  const trackers = new Map<string, {
    findings: ScoredFinding[];
    challengesAttempted: number;
    challengesSolved: number;
    graphQueries: number;
    graphContributions: number;
    startTime: number;
  }>();

  for (const agent of agents) {
    trackers.set(agent.id, {
      findings: [],
      challengesAttempted: 0,
      challengesSolved: 0,
      graphQueries: 0,
      graphContributions: 0,
      startTime: Date.now(),
    });
  }

  for (const agent of agents) {
    const mcpConfigPath = buildMcpConfig({
      auth: wave.auth,
      apiKey,
      resultsDir: framingResultsDir,
      agentId: agent.id,
    });

    for (const challenge of challenges) {
      const repoPath = repoPaths.get(challenge.repo);
      if (!repoPath) {
        console.warn(`[orchestrator] No repo path for ${challenge.repo}, skipping ${challenge.id}`);
        continue;
      }

      const result = await runAgentForChallenge({
        agent,
        wave,
        challenge,
        repoPath,
        config,
        framingResultsDir,
        mcpConfigPath,
      });

      const tracker = trackers.get(agent.id)!;
      tracker.challengesAttempted++;
      tracker.findings.push(...result.findings);
      tracker.graphQueries += result.graphQueries;
      tracker.graphContributions += result.graphContributions;

      const bestScore = result.findings.reduce((max, finding) => Math.max(max, finding.scores.total), 0);
      waveRecord.scores[agent.id][challenge.id] = bestScore;
      if (result.findings.some(isSolved)) tracker.challengesSolved++;
    }

    const state = agentStates[agent.id];
    if (state) {
      state.status = 'finished';
      state.currentChallenge = undefined;
      state.currentRepo = undefined;
    }
  }

  waveRecord.endTime = Date.now();

  const results: AgentRunResult[] = agents.map((agent) => {
    const tracker = trackers.get(agent.id)!;
    return {
      agent,
      wave,
      startTime: tracker.startTime,
      endTime: Date.now(),
      findings: tracker.findings,
      totalScore: tracker.findings.reduce((sum, finding) => sum + finding.scores.total, 0),
      challengesAttempted: tracker.challengesAttempted,
      challengesSolved: tracker.challengesSolved,
      graphQueries: tracker.graphQueries,
      graphContributions: tracker.graphContributions,
    };
  });

  const totalScore = results.reduce((sum, result) => sum + result.totalScore, 0);
  const totalSolved = results.reduce((sum, result) => sum + result.challengesSolved, 0);

  writeFileSync(
    resolve(framingResultsDir, `wave-${wave.number}-${wave.label}.json`),
    JSON.stringify({ wave, results }, null, 2),
  );

  broadcastSSE('wave_finished', {
    wave: wave.number,
    label: wave.label,
    model: wave.model,
    auth: wave.auth,
    totalScore,
    totalSolved,
  });

  console.log(`[orchestrator] Wave ${wave.label} complete: ${totalSolved} solved, ${totalScore} pts`);
  if (wave.canContribute) await drainExtraction(30_000);

  return results;
}

interface FramingResult {
  framing: BenchmarkFraming;
  runId: string;
  startedAt: string;
  completedAt: string;
  config: BenchmarkConfig;
  waves: Array<{ wave: WaveConfig; results: AgentRunResult[] }>;
  totalScore: number;
  totalSolved: number;
}

function writeComparison(result: FramingResult, resultsDir: string) {
  const comparison = result.waves.map(({ wave, results }) => {
    const score = results.reduce((sum, r) => sum + r.totalScore, 0);
    const solved = results.reduce((sum, r) => sum + r.challengesSolved, 0);
    const attempted = results.reduce((sum, r) => sum + r.challengesAttempted, 0);
    const graphReads = results.reduce((sum, r) => sum + r.graphQueries, 0);
    const graphWrites = results.reduce((sum, r) => sum + r.graphContributions, 0);

    return {
      wave: wave.number,
      label: wave.label,
      model: wave.model,
      auth: wave.auth,
      totalScore: score,
      challengesSolved: solved,
      challengesAttempted: attempted,
      solveRate: attempted > 0 ? solved / attempted : 0,
      graphReads,
      graphWrites,
    };
  });

  writeFileSync(resolve(resultsDir, 'comparison.json'), JSON.stringify(comparison, null, 2));

  const lines = [
    `# CTF Benchmark Summary - ${result.framing}`,
    '',
    `Run: ${result.runId.slice(0, 8)}`,
    `Started: ${result.startedAt}`,
    `Completed: ${result.completedAt}`,
    '',
    '| Wave | Label | Model | Auth | Solved | Score | Graph reads | Graph writes |',
    '|------|-------|-------|------|--------|-------|-------------|--------------|',
    ...comparison.map(row => `| ${row.wave} | ${row.label} | ${row.model} | ${row.auth} | ${row.challengesSolved}/${row.challengesAttempted} | ${row.totalScore} | ${row.graphReads} | ${row.graphWrites} |`),
  ];

  if (result.framing === 'equalization') {
    const opus = comparison.find(row => row.label === 'opus-cold');
    const haiku = comparison.find(row => row.label === 'haiku-warm');
    if (opus && haiku) {
      const ratio = opus.totalScore > 0 ? Math.round((haiku.totalScore / opus.totalScore) * 100) : 0;
      lines.push('', `Haiku warm reached ${ratio}% of Opus cold score.`);
    }
  }

  writeFileSync(resolve(resultsDir, 'summary.md'), `${lines.join('\n')}\n`);
}

async function runFraming(
  framing: BenchmarkFraming,
  config: BenchmarkConfig,
  challenges: Challenge[],
): Promise<FramingResult> {
  resetDashboardState(framing);
  activeChallenges = challenges;
  broadcastSSE('state', buildDashboardState());

  const startedAt = new Date().toISOString();
  const framingResultsDir = resolve(config.resultsDir, framing);
  mkdirSync(framingResultsDir, { recursive: true });

  const apiKey = process.env.INERRATA_API_KEY ?? '';
  const repoPaths = await prepareRepos(challenges, config.reposDir);
  const graphBefore = await snapshotGraph(apiKey);
  writeFileSync(resolve(framingResultsDir, 'graph-before.json'), JSON.stringify(graphBefore, null, 2));

  const waveResults: FramingResult['waves'] = [];
  const selectedWaves = wavesForFraming(framing);

  for (const wave of selectedWaves) {
    if (framing === 'equalization' && wave.graphState === 'empty' && wave.number === 1) {
      await wipeCtfNodes(apiKey);
    }

    const results = await runWave({
      wave,
      framing,
      challenges,
      config,
      framingResultsDir,
      repoPaths,
    });
    waveResults.push({ wave, results });
  }

  const completedAt = new Date().toISOString();
  const graphAfter = await snapshotGraph(apiKey);
  writeFileSync(resolve(framingResultsDir, 'graph-after.json'), JSON.stringify(graphAfter, null, 2));

  const result: FramingResult = {
    framing,
    runId,
    startedAt,
    completedAt,
    config,
    waves: waveResults,
    totalScore: waveResults.reduce((sum, w) => sum + w.results.reduce((s, r) => s + r.totalScore, 0), 0),
    totalSolved: waveResults.reduce((sum, w) => sum + w.results.reduce((s, r) => s + r.challengesSolved, 0), 0),
  };

  writeFileSync(resolve(framingResultsDir, `${runId.slice(0, 8)}-${framing}.json`), JSON.stringify(result, null, 2));
  writeComparison(result, framingResultsDir);
  return result;
}

function selectChallenges(config: BenchmarkConfig): Challenge[] {
  let selected = CHALLENGES;
  if (config.maxDifficulty) {
    selected = selected.filter(c => c.difficulty <= config.maxDifficulty!);
  }
  if (config.challengeId) {
    selected = selected.filter(c => c.id === config.challengeId || c.cve === config.challengeId);
    if (selected.length === 0) throw new Error(`No challenge matches --challenge ${config.challengeId}`);
  }
  return selected;
}

async function main() {
  const config = parseConfig();
  const selectedChallenges = selectChallenges(config);
  activeChallenges = selectedChallenges;

  console.log(`\n${'='.repeat(72)}`);
  console.log('  GNU Security Audit CTF Benchmark');
  console.log(`  Framing:        ${config.framing}`);
  console.log(`  Agents/wave:    ${config.agentsPerWave}`);
  if (config.maxDifficulty) console.log(`  Max difficulty: ${config.maxDifficulty}/5`);
  if (config.challengeId) console.log(`  Challenge:      ${config.challengeId}`);
  console.log(`  Challenges:     ${selectedChallenges.length}`);
  console.log(`  Results:        ${config.resultsDir}`);
  console.log(`  Run ID:         ${runId.slice(0, 8)}`);
  console.log(`${'='.repeat(72)}\n`);

  startSSEServer(config.port);

  for (const framing of framingsToRun(config.framing)) {
    const result = await runFraming(framing, config, selectedChallenges);
    console.log(`\n[orchestrator] ${framing} complete: ${result.totalSolved} solved, ${result.totalScore} pts`);
  }

  console.log('[orchestrator] Benchmark run complete. Dashboard server remains available.');
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err) => {
    console.error('[orchestrator] Benchmark failed:', err);
    process.exit(1);
  });
}

export {
  EQUALIZATION_WAVES,
  FUNNEL_WAVES,
  buildDashboardState,
};
