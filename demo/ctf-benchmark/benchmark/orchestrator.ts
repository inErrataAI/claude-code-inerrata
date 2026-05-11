#!/usr/bin/env tsx
/**
 * benchmark/orchestrator.ts -- CTF Cold-To-Warm Demo Orchestrator
 *
 * Runs framing-based waves of Claude CLI agents against real CVE challenges.
 *
 * Usage:
 *   npx tsx benchmark/orchestrator.ts --framing equalization --port 5555
 *   npx tsx benchmark/orchestrator.ts --framing funnel --port 5555
 *   npx tsx benchmark/orchestrator.ts --framing both --port 5555
 */
import { parseArgs } from 'util';
import { randomUUID, randomBytes } from 'crypto';
import { resolve, dirname, relative } from 'path';
import { fileURLToPath } from 'url';
import { writeFileSync, mkdirSync, existsSync, readdirSync, rmSync, readFileSync } from 'fs';
import { writeFile as writeFileAsync } from 'fs/promises';
import { spawn, execSync, execFileSync, exec, type ChildProcess, type SpawnOptions } from 'child_process';
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
  WaveAgentConfig,
  WaveConfig,
} from '../shared/types.js';
import { buildSystemPrompt, buildChallengePrompt } from '../agents/prompts.js';
import { challengeForAuth, opaqueChallengeId } from '../shared/challenge-view.js';
import { CHALLENGES, REPOS } from '../challenges/registry.js';
import { scoreAllFindings, isSolved } from '../scoring/judge.js';
import { buildMcpConfig } from './mcp-config.js';
import { resolveTier } from '../shared/types.js';
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
  maxToolCalls: number;
  agentsPerWave: number;
  parallel: number;
  sandboxAgents: boolean;
  maxDifficulty?: Difficulty;
  challengeId?: string;
  tokenBudget: number;
  generations: number;
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
      'max-tool-calls': { type: 'string', default: '300' },
      'agents-per-wave': { type: 'string', default: '4' },
      parallel: { type: 'string', default: '4' },
      'no-sandbox': { type: 'boolean', default: false },
      'max-difficulty': { type: 'string' },
      challenge: { type: 'string' },
      'token-budget': { type: 'string' },
      generations: { type: 'string', default: '1' },
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

  const parallel = parseInt(values.parallel!, 10);
  if (!Number.isFinite(parallel) || parallel < 1) {
    throw new Error(`Invalid --parallel: ${values.parallel}. Must be >= 1.`);
  }

  const maxToolCalls = parseInt(values['max-tool-calls']!, 10);
  if (!Number.isFinite(maxToolCalls) || maxToolCalls < 1) {
    throw new Error(`Invalid --max-tool-calls: ${values['max-tool-calls']}. Must be >= 1.`);
  }

  // --token-budget is now a CUMULATIVE per-agent budget across the entire
  // run (all waves, all challenges), not a per-spawn cap. Default is large
  // because a single agent may face 20+ challenges across 4+ waves.
  const tokenBudgetRaw = values['token-budget'] ?? process.env.CTF_TOKEN_BUDGET ?? '5000000';
  const tokenBudget = parseInt(tokenBudgetRaw, 10);
  if (!Number.isFinite(tokenBudget) || tokenBudget < 1024) {
    throw new Error(`Invalid --token-budget: ${tokenBudgetRaw}. Must be >= 1024.`);
  }

  const generations = parseInt(String(values.generations ?? '1'), 10);
  if (!Number.isFinite(generations) || generations < 1 || generations > 20) {
    throw new Error(`Invalid --generations: ${values.generations}. Must be between 1 and 20.`);
  }

  return {
    framing,
    port: parseInt(values.port!, 10),
    resultsDir: values['results-dir']!,
    reposDir: values['repos-dir']!,
    timeoutMinutes: parseInt(values.timeout!, 10),
    maxToolCalls,
    agentsPerWave,
    parallel,
    sandboxAgents: !values['no-sandbox'] && process.env.CTF_AGENT_SANDBOX !== '0',
    maxDifficulty: maxDiff,
    challengeId: values.challenge,
    tokenBudget,
    generations,
  };
}

export async function runWithConcurrency<T>(
  items: T[],
  parallel: number,
  worker: (item: T) => Promise<void>,
): Promise<PromiseSettledResult<void>[]> {
  const executing = new Set<Promise<void>>();
  const settled: Promise<PromiseSettledResult<void>>[] = [];
  const limit = Math.max(1, parallel);

  for (const item of items) {
    const promise = worker(item);
    const tracked = promise.finally(() => executing.delete(tracked));
    executing.add(tracked);
    settled.push(
      tracked.then(
        () => ({ status: 'fulfilled', value: undefined }) as PromiseFulfilledResult<void>,
        (reason) => ({ status: 'rejected', reason }) as PromiseRejectedResult,
      ),
    );

    if (executing.size >= limit) {
      await Promise.race(executing).catch(() => undefined);
    }
  }

  return Promise.all(settled);
}

export async function runChallengesWithSequentialAgents<TChallenge, TAgent>(
  challenges: TChallenge[],
  agents: TAgent[],
  parallel: number,
  worker: (agent: TAgent, challenge: TChallenge) => Promise<void>,
): Promise<PromiseSettledResult<void>[]> {
  return runWithConcurrency(challenges, parallel, async (challenge) => {
    for (const agent of agents) {
      await worker(agent, challenge);
    }
  });
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

function currentAuthForDashboard(): WaveConfig['auth'] | undefined {
  return waves.length > 0 ? waves[waves.length - 1].auth : undefined;
}

function displayChallengeId(challengeId: string, auth: WaveConfig['auth'] | undefined): string {
  if (auth !== 'none') return challengeId;
  const challenge = activeChallenges.find(c => c.id === challengeId);
  return challenge ? opaqueChallengeId(challenge) : opaqueChallengeId(challengeId);
}

function displayAgentState(state: AgentState, auth: WaveConfig['auth'] | undefined): AgentState {
  if (auth !== 'none') return state;

  return {
    ...state,
    currentChallenge: state.currentChallenge
      ? displayChallengeId(state.currentChallenge, auth)
      : undefined,
    findings: state.findings.map(finding => ({
      ...finding,
      challengeId: displayChallengeId(finding.challengeId, auth),
    })),
  };
}

function displayWave(wave: Wave, auth: WaveConfig['auth'] | undefined): Wave {
  if (auth !== 'none' || wave.auth !== 'none') return wave;

  return {
    ...wave,
    challenges: wave.challenges.map(challengeId => displayChallengeId(challengeId, auth)),
    scores: Object.fromEntries(
      Object.entries(wave.scores).map(([agentId, scores]) => [
        agentId,
        Object.fromEntries(
          Object.entries(scores).map(([challengeId, score]) => [
            displayChallengeId(challengeId, auth),
            score,
          ]),
        ),
      ]),
    ),
  };
}

function buildDashboardState(): DashboardState {
  const dashboardAuth = currentAuthForDashboard();
  return {
    agents: Object.fromEntries(
      Object.entries(agentStates).map(([agentId, state]) => [
        agentId,
        displayAgentState(state, dashboardAuth),
      ]),
    ),
    challenges: activeChallenges.map(challenge => challengeForAuth(challenge, dashboardAuth)),
    waves: waves.map(wave => displayWave(wave, dashboardAuth)),
    currentWave: waves.length > 0 ? waves[waves.length - 1].number : 0,
    flags: flags.map(flag => dashboardAuth === 'none'
      ? { ...flag, challengeId: displayChallengeId(flag.challengeId, dashboardAuth) }
      : flag),
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

// Coalesced state broadcaster: many live mutations during an agent run would
// otherwise flood SSE. Trailing-edge scheduler caps at ~4Hz and always emits
// the freshest snapshot after a quiet window.
let _stateBroadcastTimer: ReturnType<typeof setTimeout> | null = null;
let _stateBroadcastLastFlush = 0;
const STATE_BROADCAST_INTERVAL_MS = 250;
function scheduleStateBroadcast() {
  if (_stateBroadcastTimer) return;
  const since = Date.now() - _stateBroadcastLastFlush;
  const delay = Math.max(0, STATE_BROADCAST_INTERVAL_MS - since);
  _stateBroadcastTimer = setTimeout(() => {
    _stateBroadcastTimer = null;
    _stateBroadcastLastFlush = Date.now();
    broadcastSSE('state', buildDashboardState());
  }, delay);
}

/**
 * Parse a single ndjson line from the agent harness stdout and apply any
 * tool-call / usage deltas to liveCounts. Returns whether anything changed
 * so the caller can decide whether to ping the dashboard.
 *
 * Supports both formats:
 *   - claude CLI:  {type:'assistant', message:{content:[{type:'tool_use', name}], usage}}
 *   - azure-harness: {type:'tool_use', name} and {type:'result', sessionUsage}
 */
function ingestStreamLine(
  line: string,
  liveCounts: { toolCalls: number; graphHits: number; webLookups: number; tokensUsed: number; toolNames: string[] },
): boolean {
  let obj: any;
  try { obj = JSON.parse(line); } catch { return false; }
  if (!obj || typeof obj !== 'object') return false;

  const seen: string[] = [];
  let tokensChanged = false;
  if (obj.type === 'assistant' && obj.message && Array.isArray(obj.message.content)) {
    for (const block of obj.message.content) {
      if (block && block.type === 'tool_use' && typeof block.name === 'string') seen.push(block.name);
    }
    const u = obj.message.usage;
    if (u && typeof u === 'object') {
      const inT = typeof u.input_tokens === 'number' ? u.input_tokens : 0;
      const outT = typeof u.output_tokens === 'number' ? u.output_tokens : 0;
      const cc = typeof u.cache_creation_input_tokens === 'number' ? u.cache_creation_input_tokens : 0;
      const cr = typeof u.cache_read_input_tokens === 'number' ? u.cache_read_input_tokens : 0;
      // Anthropic bills cache_read at ~10% of input. Counting it at 100%
      // makes long sessions look catastrophically expensive (Sonnet runs
      // showing 7M+ when actual effective spend is ~1M). Apply the discount.
      const add = inT + outT + cc + Math.round(cr * 0.1);
      if (add > 0) { liveCounts.tokensUsed += add; tokensChanged = true; }
    }
  } else if (obj.type === 'tool_use' && typeof obj.name === 'string') {
    seen.push(obj.name);
  } else if ((obj.type === 'usage' || obj.type === 'result')
             && obj.sessionUsage && typeof obj.sessionUsage.used === 'number') {
    // azure-harness emits a per-turn `usage` event AND a final `result`
    // sessionUsage. Both are absolute totals -- only credit the delta over
    // what we've already counted.
    const delta = Math.max(0, obj.sessionUsage.used - liveCounts.tokensUsed);
    if (delta > 0) { liveCounts.tokensUsed += delta; tokensChanged = true; }
  }

  if (seen.length === 0) return tokensChanged;
  const cls = classifyToolCalls(seen);
  liveCounts.toolCalls += seen.length;
  liveCounts.graphHits += cls.graphHits;
  liveCounts.webLookups += cls.webLookups;
  liveCounts.toolNames.push(...seen);
  return true;
}

/**
 * Emit an RPG-flavored setup event to the live dashboard log. Used for
 * pre-wave activities (repo clones, graph snapshots, namespace wipes,
 * extraction drains, etc) so the user sees something meaningful while
 * waiting for the first agent to spawn.
 */
function emitSetup(phase: string, message: string, flavor?: string): void {
  broadcastSSE('setup', { phase, message, flavor: flavor ?? '', ts: Date.now() });
  console.log(`[setup:${phase}] ${message}`);
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
        'X-Accel-Buffering': 'no',
        // CORS: allow the dashboard (on a different port) to subscribe
        // directly without a proxy. Wildcard is safe here — this is a
        // local dev tool, never exposed to the public internet.
        'Access-Control-Allow-Origin': '*',
      },
    });
  });

  // Also CORS the state endpoint so direct fetches work the same way.
  app.use('/api/*', async (c, next) => {
    await next();
    c.header('Access-Control-Allow-Origin', '*');
  });

  // SSE keep-alive: lines starting with ":" are SSE comments and are
  // ignored by the client. Pings every 15s prevent idle timeouts that
  // were causing the dashboard to disconnect/reconnect during quiet
  // stretches between tool calls.
  setInterval(() => {
    const ping = new TextEncoder().encode(`: ping ${Date.now()}\n\n`);
    for (const ctrl of sseClients) {
      try { ctrl.enqueue(ping); } catch { sseClients.delete(ctrl); }
    }
  }, 15_000);

  app.get('/health', (c) => c.json({ status: 'ok' }));

  serve({ fetch: app.fetch, port }, () => {
    console.log(`[orchestrator] SSE server listening on http://localhost:${port}`);
  });
}

async function cloneOrUpdateRepo(repoName: string, repoUrl: string, reposDir: string): Promise<string> {
  const repoPath = resolve(reposDir, repoName);
  mkdirSync(reposDir, { recursive: true });

  if (existsSync(resolve(repoPath, '.git'))) {
    emitSetup(
      'repo.cached',
      `${repoName} already in the saddlebag`,
      `*${repoName} is already mapped in the party's bestiary*`,
    );
    return repoPath;
  }

  emitSetup(
    'repo.cloning',
    `Heading to the Marketplace of Code: ${repoName}`,
    `*the party trudges off to acquire scrolls of ${repoName}...*`,
  );
  // Block Git Credential Manager dialogs on clone (some hosts require auth
  // we don't have — e.g. ghostscript). Fail fast instead of popping a UI.
  await execAsync(`git -c credential.helper= clone "${repoUrl}" "${repoPath}"`, {
    timeout: 600_000,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      GCM_INTERACTIVE: 'Never',
      GIT_ASKPASS: 'echo',
      SSH_ASKPASS: 'echo',
      GIT_CONFIG_NOSYSTEM: '1',
    },
  });
  emitSetup(
    'repo.cloned',
    `Acquired ${repoName} (scrolls of source intact)`,
    `*${repoName} is now tucked into the party's saddlebag*`,
  );
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

function spriteForAgent(agent: AgentConfig): string {
  const base: Record<ModelTier, string> = {
    opus: 'opus-wizard',
    sonnet: 'sonnet-bard',
    haiku: 'haiku-rogue',
    'qwen3-14b': 'haiku-rogue',
  };
  return `${base[agent.model]} ${agent.spriteType}`;
}

function waveForAgent(wave: WaveConfig, agent: AgentConfig): WaveConfig {
  return {
    ...wave,
    label: agent.waveLabel,
    model: agent.model,
    modelId: agent.modelId,
    runtime: agent.runtime,
    auth: agent.auth,
    canContribute: agent.canContribute,
    spriteType: agent.spriteType,
  };
}

export function buildClaudeArgs(opts: {
  includeModel: boolean;
  modelId: string;
  mcpConfigPath: string;
  systemPrompt: string;
  challengePrompt: string;
  maxTurns?: number;
}): string[] {
  return [
    '--print',
    '--verbose',
    '--output-format', 'stream-json',
    '--effort', 'max',
    ...(opts.includeModel ? ['--model', opts.modelId] : []),
    '--dangerously-skip-permissions',
    '--setting-sources', 'project,local',
    '--strict-mcp-config',
    '--max-turns', String(opts.maxTurns ?? 35),
    '--mcp-config', opts.mcpConfigPath,
    '--system-prompt', opts.systemPrompt,
    '-p', opts.challengePrompt,
  ];
}

const SANDBOX_WORKSPACE = '/tmp/ctf-workspace';
const SANDBOX_MCP_CONFIG = '/tmp/ctf-mcp-config.json';

function canRunBwrap(): boolean {
  try {
    execFileSync(process.env.CTF_BWRAP_BIN ?? 'bwrap', ['--version'], { stdio: 'ignore', timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

export function buildAgentSandbox(opts: {
  enabled: boolean;
  repoPath: string;
  mcpConfigPath: string;
}): { command: string; args: string[]; cwd: string; mcpConfigPath: string; enabled: boolean } {
  if (!opts.enabled || !canRunBwrap()) {
    return {
      command: '',
      args: [],
      cwd: opts.repoPath,
      mcpConfigPath: opts.mcpConfigPath,
      enabled: false,
    };
  }

  const command = process.env.CTF_BWRAP_BIN ?? 'bwrap';
  const args = [
    '--die-with-parent',
    '--ro-bind', '/', '/',
    '--proc', '/proc',
    '--dev', '/dev',
    '--bind', '/tmp', '/tmp',
    '--dir', SANDBOX_WORKSPACE,
    '--bind', opts.repoPath, SANDBOX_WORKSPACE,
    '--ro-bind', opts.mcpConfigPath, SANDBOX_MCP_CONFIG,
  ];

  let projectRootMasked = false;
  if (process.env.HOME) {
    const home = process.env.HOME;
    const hiddenHomePaths = ['Repos', '.openclaw', '.inerrata', '.codex'];
    for (const hidden of hiddenHomePaths) {
      const hiddenPath = resolve(home, hidden);
      if (!existsSync(hiddenPath)) continue;
      args.push('--tmpfs', hiddenPath);
      if (PROJECT_ROOT === hiddenPath || PROJECT_ROOT.startsWith(`${hiddenPath}/`)) {
        projectRootMasked = true;
      }
    }

    const ollamaStatePath = resolve(home, '.ollama');
    if (existsSync(ollamaStatePath)) {
      args.push('--bind', ollamaStatePath, ollamaStatePath);
    }
  }

  if (!projectRootMasked) {
    args.push('--tmpfs', PROJECT_ROOT);
  }

  args.push(
    '--setenv', 'CTF_AGENT_SANDBOX', '1',
    '--chdir', SANDBOX_WORKSPACE,
  );

  return {
    command,
    args,
    cwd: '/',
    mcpConfigPath: SANDBOX_MCP_CONFIG,
    enabled: true,
  };
}

function spawnAuditAgent(opts: {
  agent: AgentConfig;
  wave: WaveConfig;
  systemPrompt: string;
  challengePrompt: string;
  repoPath: string;
  mcpConfigPath: string;
  sandboxAgents: boolean;
  maxToolCalls: number;
  tokenBudget: number;
}): ChildProcess {
  const sandbox = buildAgentSandbox({
    enabled: opts.sandboxAgents,
    repoPath: opts.repoPath,
    mcpConfigPath: opts.mcpConfigPath,
  });
  const commonClaudeArgs = (includeModel: boolean): string[] => buildClaudeArgs({
    includeModel,
    modelId: opts.agent.modelId,
    mcpConfigPath: sandbox.mcpConfigPath,
    systemPrompt: opts.systemPrompt,
    challengePrompt: opts.challengePrompt,
    maxTurns: opts.maxToolCalls,
  });
  // Resolve per-tier Azure overrides (endpoint/key/api-version/api-style)
  // when the agent is on the azure-openai runtime. Falls back to default
  // AZURE_OPENAI_* values when no per-tier override is set.
  const azureEnv: Record<string, string> = {};
  if (opts.agent.runtime === 'azure-openai') {
    const tierRes = resolveTier(opts.agent.model);
    const az = tierRes.azure;
    if (az) {
      if (az.endpoint) azureEnv.AZURE_OPENAI_ENDPOINT = az.endpoint;
      if (az.apiKey) azureEnv.AZURE_OPENAI_API_KEY = az.apiKey;
      if (az.apiVersion) azureEnv.AZURE_OPENAI_API_VERSION = az.apiVersion;
      azureEnv.AZURE_OPENAI_API_STYLE = az.apiStyle;
    }
  }

  // Build child env. For claude-runtime agents, strip ANTHROPIC_* keys so the
  // claude CLI falls back to its stored Max-subscription session instead of
  // billing through a (possibly depleted) ANTHROPIC_API_KEY in env.
  const childEnv: Record<string, string | undefined> = {
    ...process.env,
    ...azureEnv,
    INERRATA_API_KEY: process.env.INERRATA_API_KEY ?? '',
    CLAUDE_CODE_MAX_OUTPUT_TOKENS: process.env.CTF_MAX_OUTPUT_TOKENS
      ?? process.env.MAX_OUTPUT_TOKENS
      ?? process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS
      ?? '8192',
    CTF_TOKEN_BUDGET: String(opts.tokenBudget),
    CTF_WAVE_LABEL: opts.agent.waveLabel,
    CTF_CAN_CONTRIBUTE: opts.agent.canContribute ? 'true' : 'false',
    CTF_AGENT_SOURCE: `ctf-bench-${opts.wave.label}-${opts.agent.id}`,
    CTF_AGENT_SANDBOX: sandbox.enabled ? '1' : '0',
  };
  if (opts.agent.runtime === 'claude') {
    delete childEnv.ANTHROPIC_API_KEY;
    delete childEnv.ANTHROPIC_AUTH_TOKEN;
    delete childEnv.ANTHROPIC_BASE_URL;
  }

  const spawnOptions: SpawnOptions = {
    cwd: sandbox.cwd,
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  };

  if (opts.agent.runtime === 'ollama') {
    const command = 'ollama';
    const args = [
      'launch',
      'claude',
      '--model', opts.agent.modelId,
      '--',
      ...commonClaudeArgs(false),
    ];
    return sandbox.enabled
      ? spawn(sandbox.command, [...sandbox.args, command, ...args], spawnOptions)
      : spawn(command, args, spawnOptions);
  }

  if (opts.agent.runtime === 'azure-openai' || opts.agent.runtime === 'google-vertex') {
    // Spawn the local harness via Node + experimental-strip-types. The
    // harness dispatches between Azure (chat.completions + responses) and
    // Vertex (gemini via OpenAI-compat) based on AZURE_OPENAI_API_STYLE.
    const harnessPath = resolve(PROJECT_ROOT, 'agents', 'azure-harness.ts');
    const args = [
      '--experimental-strip-types',
      '--no-warnings=ExperimentalWarning',
      harnessPath,
      '--max-turns', String(opts.maxToolCalls),
      '--mcp-config', sandbox.mcpConfigPath,
      '--system-prompt', opts.systemPrompt,
      '--model', opts.agent.modelId,
      '-p', opts.challengePrompt,
    ];
    if (opts.agent.runtime === 'google-vertex') {
      // Tell the harness to take the vertex code path.
      (spawnOptions.env as Record<string, string | undefined>).AZURE_OPENAI_API_STYLE = 'vertex';
    }
    const command = process.execPath;
    return sandbox.enabled
      ? spawn(sandbox.command, [...sandbox.args, command, ...args], spawnOptions)
      : spawn(command, args, spawnOptions);
  }

  const command = 'claude';
  const args = commonClaudeArgs(true);

  return sandbox.enabled
    ? spawn(sandbox.command, [...sandbox.args, command, ...args], spawnOptions)
    : spawn(command, args, spawnOptions);
}

export function parseStreamJson(raw: string): {
  text: string;
  toolCalls: string[];
  sessionUsage?: { used: number; budget: number };
} {
  const assistantText: string[] = [];
  const resultText: string[] = [];
  const toolCalls: string[] = [];
  let sessionUsage: { used: number; budget: number } | undefined;
  // The claude CLI emits per-turn usage on assistant messages:
  //   message.usage.{input_tokens, output_tokens, cache_*}
  // azure-harness emits a single sessionUsage on the final result event.
  // Sum claude per-turn usage here so the claude runtime's HP bar drains too.
  let claudeTokenSum = 0;

  const visibleTextFromContent = (content: unknown): string[] => {
    if (typeof content === 'string') return [content];
    if (!Array.isArray(content)) return [];

    return content.flatMap((block) => {
      if (typeof block === 'string') return [block];
      if (!block || typeof block !== 'object') return [];
      const typed = block as { type?: string; text?: string; content?: unknown };
      if (typed.type === 'text' && typeof typed.text === 'string') return [typed.text];
      if (typed.type === 'thinking' || typed.type === 'redacted_thinking') return [];
      if (typeof typed.content === 'string' && typed.type !== 'thinking') return [typed.content];
      return [];
    });
  };

  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);

      if (obj.type === 'assistant' && obj.message?.content) {
        for (const text of visibleTextFromContent(obj.message.content)) {
          assistantText.push(text);
        }
        for (const block of obj.message.content) {
          if (block.type === 'tool_use') toolCalls.push(block.name);
        }
        // claude CLI per-turn usage. cache_read counted at 10% to match
        // Anthropic's actual pricing (keep in sync with ingestStreamLine).
        const u = obj.message.usage;
        if (u && typeof u === 'object') {
          const inT = typeof u.input_tokens === 'number' ? u.input_tokens : 0;
          const outT = typeof u.output_tokens === 'number' ? u.output_tokens : 0;
          const cacheCreate = typeof u.cache_creation_input_tokens === 'number' ? u.cache_creation_input_tokens : 0;
          const cacheRead = typeof u.cache_read_input_tokens === 'number' ? u.cache_read_input_tokens : 0;
          claudeTokenSum += inT + outT + cacheCreate + Math.round(cacheRead * 0.1);
        }
      }

      if (obj.type === 'tool_use') {
        toolCalls.push(obj.name || obj.tool || 'unknown');
      }

      if (obj.type === 'tool_result' || obj.type === 'result') {
        if (obj.result) {
          const visible = visibleTextFromContent(obj.result);
          resultText.push(...(visible.length ? visible : typeof obj.result === 'string' ? [obj.result] : []));
        }
        if (obj.content) resultText.push(...visibleTextFromContent(obj.content));
        if (obj.sessionUsage && typeof obj.sessionUsage.used === 'number' && typeof obj.sessionUsage.budget === 'number') {
          sessionUsage = { used: obj.sessionUsage.used, budget: obj.sessionUsage.budget };
        }
      }
    } catch {
      resultText.push(line);
    }
  }

  const text = assistantText.length > 0 ? assistantText : resultText;
  // If we summed claude per-turn usage and the spawn didn't emit its own
  // sessionUsage (azure-harness format), synthesize one so downstream code
  // doesn't need to know which runtime produced the stream.
  if (!sessionUsage && claudeTokenSum > 0) {
    sessionUsage = { used: claudeTokenSum, budget: 0 };
  }
  return { text: text.join('\n'), toolCalls, sessionUsage };
}

function stripMarkdown(value: string | undefined): string {
  return (value ?? '')
    .replace(/```[\s\S]*?```/g, block => block.replace(/```[a-zA-Z]*\n?/g, '').replace(/```/g, ''))
    .replace(/\*\*/g, '')
    .replace(/`/g, '')
    .trim();
}

function firstLineValue(markdown: string, labels: string[]): string | undefined {
  const escaped = labels.map(label => label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const re = new RegExp(`^\\s*(?:[-*]\\s*)?(?:${escaped})\\s*[:：]\\s*(.+)$`, 'i');
  for (const line of markdown.split('\n')) {
    const match = stripMarkdown(line).match(re);
    if (match?.[1]) return stripMarkdown(match[1]);
  }
  return undefined;
}

function extractFileFromMarkdown(markdown: string): string {
  const labelled = firstLineValue(markdown, ['vulnerableFile', 'File', 'Location']);
  const source = labelled || markdown;
  const codePath = source.match(/`?([A-Za-z0-9_./-]+\.(?:c|h|cc|cpp))`?/);
  return stripMarkdown(codePath?.[1] || labelled || '');
}

function extractFunctionFromMarkdown(markdown: string): string | undefined {
  const labelled = firstLineValue(markdown, ['vulnerableFunction', 'Function']);
  if (!labelled) return undefined;
  const codeName = labelled.match(/`?([A-Za-z_][A-Za-z0-9_]*)`?/);
  return stripMarkdown(codeName?.[1] || labelled);
}

function extractLineRangeFromMarkdown(markdown: string): [number, number] | undefined {
  const line = firstLineValue(markdown, ['lineRange', 'Lines', 'Line']);
  const source = line || markdown.match(/(?:lineRange|Lines?|Line)\D+(\d+)(?:\D+(\d+))?/i)?.[0] || '';
  const match = source.match(/(\d+)(?:\D+(\d+))?/);
  if (!match) return undefined;
  const start = Number(match[1]);
  const end = Number(match[2] ?? match[1]);
  return Number.isFinite(start) && Number.isFinite(end) ? [start, end] : undefined;
}

function sectionText(markdown: string, labels: string[]): string | undefined {
  for (const label of labels) {
    const re = new RegExp(`(?:^|\\n)\\s*(?:[-*]\\s*)?(?:\\*\\*)?${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\*\\*)?\\s*[:：]\\s*([\\s\\S]*?)(?=\\n\\s*(?:[-*]\\s*)?(?:\\*\\*)?[A-Z][A-Za-z ]{2,40}(?:\\*\\*)?\\s*[:：]|$)`, 'i');
    const match = markdown.match(re);
    if (match?.[1]) return stripMarkdown(match[1]);
  }
  return undefined;
}

function markdownFinding(raw: string, agentId: string, challenge: Challenge | undefined): Finding | null {
  const vulnerableFile = extractFileFromMarkdown(raw);
  const explanation = sectionText(raw, ['explanation', 'description', 'vulnerability details', 'details'])
    || stripMarkdown(raw);

  if (!challenge && !vulnerableFile && explanation.length < 20) return null;

  return {
    agentId,
    challengeId: challenge?.id ?? firstLineValue(raw, ['challengeId', 'CVE']) ?? '',
    timestamp: Date.now(),
    vulnerableFile,
    vulnerableFunction: extractFunctionFromMarkdown(raw),
    lineRange: extractLineRangeFromMarkdown(raw),
    bugClass: challenge?.bugClass ?? 'logic-bug',
    explanation,
    pocCode: sectionText(raw, ['pocCode', 'proof of concept', 'poc', 'example code', 'impact']),
    patchSuggestion: sectionText(raw, ['patchSuggestion', 'fix recommendation', 'fix', 'patch']),
    crossRepoPattern: sectionText(raw, ['crossRepoPattern', 'cross repo pattern']),
  };
}

export function parseFindings(output: string, agentId: string, challenge?: Challenge): Finding[] {
  const findings: Finding[] = [];
  const findingRegex = /<finding>\s*([\s\S]*?)\s*<\/finding>/g;
  let match: RegExpExecArray | null;

  const resolveChallengeId = (value: unknown): string => {
    if (typeof value !== 'string' || value.trim() === '') return challenge?.id ?? '';
    const normalized = value.trim().toLowerCase();
    if (
      challenge &&
      (
        ['current', 'current_challenge', 'current-challenge', 'the-challenge-id'].includes(normalized)
        || normalized === opaqueChallengeId(challenge).toLowerCase()
      )
    ) {
      return challenge.id;
    }
    return value;
  };

  while ((match = findingRegex.exec(output)) !== null) {
    try {
      const raw = JSON.parse(match[1]);
      findings.push({
        agentId,
        challengeId: resolveChallengeId(raw.challengeId),
        timestamp: Date.now(),
        vulnerableFile: raw.vulnerableFile ?? '',
        vulnerableFunction: raw.vulnerableFunction,
        lineRange: raw.lineRange,
        bugClass: raw.bugClass ?? challenge?.bugClass ?? 'logic-bug',
        explanation: raw.explanation ?? '',
        pocCode: raw.pocCode,
        patchSuggestion: raw.patchSuggestion,
        crossRepoPattern: raw.crossRepoPattern,
      });
    } catch {
      const fallback = markdownFinding(match[1], agentId, challenge);
      if (fallback) findings.push(fallback);
      else console.warn(`[orchestrator] Failed to parse finding block from ${agentId}`);
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

function ensureAgentState(
  agent: AgentConfig,
  wave: WaveConfig,
  challenge: Challenge,
  budgets: { tokenBudget: number; maxToolCalls: number },
): AgentState {
  if (!agentStates[agent.id]) {
    agentStates[agent.id] = {
      id: agent.id,
      name: agent.name,
      model: agent.model,
      modelId: agent.modelId,
      runtime: agent.runtime,
      auth: agent.auth,
      waveLabel: wave.label,
      sprite: spriteForAgent(agent),
      status: 'running',
      currentChallenge: challenge.id,
      currentRepo: challenge.repo,
      flagsCaptured: 0,
      totalPoints: 0,
      toolCalls: 0,
      graphHits: 0,
      webLookups: 0,
      tokensUsed: 0,
      tokenBudget: budgets.tokenBudget,
      maxToolCalls: budgets.maxToolCalls,
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

interface ToolCallClassification {
  graphQueries: number;
  graphContributions: number;
  graphHits: number;
  webLookups: number;
}

function classifyToolCalls(toolCalls: string[]): ToolCallClassification {
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
  let webLookups = 0;

  for (const rawName of toolCalls) {
    const name = rawName.replace(/^mcp__inerrata__/, '');
    if (queryNames.has(name)) graphQueries++;
    if (writeNames.has(name)) graphContributions++;
    if (isExternalLookupTool(rawName)) webLookups++;
  }

  return {
    graphQueries,
    graphContributions,
    graphHits: graphQueries + graphContributions,
    webLookups,
  };
}

export function artifactChallengeId(challenge: Challenge, wave: WaveConfig): string {
  return wave.auth === 'none' ? opaqueChallengeId(challenge) : challenge.id;
}

function isExternalLookupTool(toolName: string): boolean {
  const normalized = toolName.toLowerCase().replace(/[^a-z0-9]+/g, '');
  return normalized === 'websearch' || normalized === 'webfetch';
}

export function runDisqualificationReasons(opts: {
  toolCalls: string[];
  classified: { graphHits: number };
  wave: WaveConfig;
  maxToolCalls: number;
}): string[] {
  const reasons: string[] = [];

  if (opts.toolCalls.length > opts.maxToolCalls) {
    reasons.push(`tool-budget-exceeded:${opts.toolCalls.length}/${opts.maxToolCalls}`);
  }

  // Cold wave forbids the graph (that is the definition of cold).
  // Web search is allowed in every wave -- the cold-vs-warm web-tool delta is
  // a treatment metric (token cost of cold-debugging vs graph recall), not a
  // disqualification condition.
  if (opts.wave.auth === 'none' && opts.classified.graphHits > 0) {
    reasons.push('graph-tool-used-in-cold-wave');
  }

  return reasons;
}

function applyRunDisqualification(finding: ScoredFinding, reasons: string[]): ScoredFinding {
  if (reasons.length === 0) return finding;

  return {
    ...finding,
    scores: { location: 0, explanation: 0, poc: 0, patch: 0, crossRepo: 0, total: 0 },
    solved: false,
    disqualified: true,
    disqualificationReasons: [...new Set([...finding.disqualificationReasons, ...reasons])],
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
}): Promise<{
  findings: ScoredFinding[];
  graphQueries: number;
  graphContributions: number;
  webLookups: number;
}> {
  const { agent, wave, challenge, repoPath, config, framingResultsDir } = opts;
  const agentState = ensureAgentState(agent, wave, challenge, {
    tokenBudget: config.tokenBudget,
    maxToolCalls: config.maxToolCalls,
  });
  const startTime = Date.now();
  const agentWave = waveForAgent(wave, agent);
  const publicChallengeId = artifactChallengeId(challenge, agentWave);

  broadcastSSE('agent_challenge_start', {
    agentId: agent.id,
    challengeId: publicChallengeId,
    model: agent.model,
    auth: agent.auth,
    wave: wave.number,
    label: wave.label,
  });

  // Removed: checkoutVersion(repoPath, challenge.affectedVersion).
  // The agent's repoPath is a scrubbed snapshot built via `git archive` --
  // no .git inside it. The base repo was archived at the affected tag in
  // prepareColdSourceWorkspace. A checkout here would (a) try to mutate a
  // non-existent .git, (b) under --parallel hit credential prompts if the
  // tag was missing. Either way it's unnecessary.

  // Pass the REMAINING cumulative budget for this agent to the harness.
  // The harness will also stop early if it hits these caps, keeping per-spawn
  // and per-run budgets in sync for both tokens AND tool calls.
  const remainingBudget = Math.max(
    1024,
    (agentState.tokenBudget ?? config.tokenBudget) - (agentState.tokensUsed ?? 0),
  );
  const remainingToolCalls = Math.max(
    1,
    (agentState.maxToolCalls ?? config.maxToolCalls) - (agentState.toolCalls ?? 0),
  );

  const child = spawnAuditAgent({
    agent,
    wave: agentWave,
    systemPrompt: buildSystemPrompt(agentWave),
    challengePrompt: buildChallengePrompt(challenge, agentWave),
    repoPath,
    mcpConfigPath: opts.mcpConfigPath,
    sandboxAgents: config.sandboxAgents,
    maxToolCalls: remainingToolCalls,
    tokenBudget: remainingBudget,
  });

  child.stderr?.on('data', (chunk: Buffer) => {
    const text = chunk.toString().trim();
    if (!text) return;
    broadcastSSE('tool_call', { agentId: agent.id, tool: 'audit', challengeId: publicChallengeId });
  });

  // Per-run live counts: applied to agentState as each line arrives so the
  // dashboard sees toolCalls/tokens/graphHits move in real time instead of
  // jumping all at once when the child exits.
  const liveCounts = { toolCalls: 0, graphHits: 0, webLookups: 0, tokensUsed: 0, toolNames: [] as string[] };
  const baselineToolCalls = agentState.toolCalls ?? 0;
  const baselineGraphHits = agentState.graphHits ?? 0;
  const baselineWebLookups = agentState.webLookups ?? 0;
  const baselineTokensUsed = agentState.tokensUsed ?? 0;

  // Live-parse harness stdout for agent_chat events so dashboard bubbles
  // appear in real-time (instead of waiting for the whole agent run to end).
  let stdoutLineBuf = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    stdoutLineBuf += chunk.toString();
    let nl: number;
    let anyDelta = false;
    while ((nl = stdoutLineBuf.indexOf('\n')) >= 0) {
      const line = stdoutLineBuf.slice(0, nl).trim();
      stdoutLineBuf = stdoutLineBuf.slice(nl + 1);
      if (!line) continue;
      try {
        const obj = JSON.parse(line);
        if (obj && obj.type === 'agent_chat' && typeof obj.text === 'string') {
          broadcastSSE('agent_chat', {
            agentId: agent.id,
            text: obj.text,
            challengeId: publicChallengeId,
            ts: obj.ts || Date.now(),
          });
        }
      } catch { /* not JSON; ingestStreamLine will reject too */ }

      // Tool / token deltas: apply incrementally and emit graph_hit immediately
      // (matches what the post-run pass used to do, but in real time).
      const prevToolNamesLen = liveCounts.toolNames.length;
      if (ingestStreamLine(line, liveCounts)) {
        anyDelta = true;
        agentState.toolCalls = baselineToolCalls + liveCounts.toolCalls;
        agentState.graphHits = baselineGraphHits + liveCounts.graphHits;
        agentState.webLookups = baselineWebLookups + liveCounts.webLookups;
        agentState.tokensUsed = baselineTokensUsed + liveCounts.tokensUsed;
        // Emit one tool_use event per new tool name so the dashboard can
        // label each spell cast (Bash, Read, mcp__inerrata__search, etc).
        // Graph hits get a second event so the run-log "graph" channel still
        // lights up specifically for inerrata calls.
        for (let i = prevToolNamesLen; i < liveCounts.toolNames.length; i++) {
          const tn = liveCounts.toolNames[i];
          broadcastSSE('tool_use', { agentId: agent.id, challengeId: publicChallengeId, tool: tn });
          if (tn.includes('inerrata')) {
            broadcastSSE('graph_hit', { agentId: agent.id, challengeId: publicChallengeId, tool: tn });
          }
        }
      }
    }
    if (anyDelta) scheduleStateBroadcast();
  });

  const { stdout, stderr, exitCode } = await collectProcessOutput(child, config.timeoutMinutes * 60_000);
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`[agent:${agent.name}] ${challenge.id} finished exit=${exitCode} in ${elapsed}s`);
  if (stderr.trim()) console.warn(`[agent:${agent.name}] stderr: ${stderr.trim().slice(0, 500)}`);

  // Async write keeps the orchestrator event loop free during fat stdout dumps
  // (multi-MB ndjson on long Claude runs) so /api/state stays responsive.
  // Fire-and-forget on the ndjson; the txt mirror waits on parseStreamJson.
  void writeFileAsync(resolve(framingResultsDir, `${agent.id}-${publicChallengeId}.ndjson`), stdout)
    .catch(err => console.warn(`[orchestrator] ndjson write failed: ${err}`));

  // Yield to the event loop before chewing through potentially huge stdout,
  // so any pending /api/state HTTP responses get to flush first.
  await new Promise(r => setImmediate(r));
  const parsed = parseStreamJson(stdout);
  void writeFileAsync(resolve(framingResultsDir, `${agent.id}-${publicChallengeId}.txt`), parsed.text)
    .catch(err => console.warn(`[orchestrator] txt write failed: ${err}`));

  // Reconcile against the authoritative full-stream parse: if anything got
  // missed by the live pass (rare, but possible if a line was malformed mid-
  // chunk), close the gap so disqualification logic and final scoring see
  // the true totals. Never decrement -- live may have overcounted on retries
  // but undercounting is the real risk.
  const classified = classifyToolCalls(parsed.toolCalls);
  const drift = {
    toolCalls: Math.max(0, parsed.toolCalls.length - liveCounts.toolCalls),
    graphHits: Math.max(0, classified.graphHits - liveCounts.graphHits),
    webLookups: Math.max(0, classified.webLookups - liveCounts.webLookups),
    tokensUsed: Math.max(0, (parsed.sessionUsage?.used ?? 0) - liveCounts.tokensUsed),
  };
  if (drift.toolCalls || drift.graphHits || drift.webLookups || drift.tokensUsed) {
    agentState.toolCalls += drift.toolCalls;
    agentState.graphHits += drift.graphHits;
    agentState.webLookups += drift.webLookups;
    agentState.tokensUsed += drift.tokensUsed;
    scheduleStateBroadcast();
  }
  const runDisqualifications = runDisqualificationReasons({
    toolCalls: parsed.toolCalls,
    classified,
    wave: agentWave,
    maxToolCalls: config.maxToolCalls,
  });
  if (runDisqualifications.length > 0) {
    agentState.disqualifications = [
      ...new Set([...(agentState.disqualifications ?? []), ...runDisqualifications]),
    ];
    if (runDisqualifications.some(reason => reason.startsWith('tool-budget-exceeded'))) {
      agentState.budgetExceeded = true;
      agentState.status = 'throttled';
    }
  }

  // Drift-only graph_hit emission. The live handler already fired these in
  // real time as the harness emitted each tool_use; only re-emit names that
  // the live pass missed (e.g. malformed mid-chunk lines we couldn't parse).
  if (drift.graphHits > 0) {
    const liveSet = new Set(liveCounts.toolNames);
    for (const toolName of parsed.toolCalls) {
      if (toolName.includes('inerrata') && !liveSet.has(toolName)) {
        broadcastSSE('graph_hit', { agentId: agent.id, challengeId: publicChallengeId, tool: toolName });
      }
    }
  }

  const rawFindings = parseFindings(parsed.text, agent.id, challenge);
  const scoredFindings = scoreAllFindings(rawFindings)
    .map(finding => applyRunDisqualification(finding, runDisqualifications));

  let mutatedDuringScoring = false;
  for (const finding of scoredFindings) {
    agentState.findings.push(finding);
    agentState.totalPoints += finding.scores.total;
    mutatedDuringScoring = true;

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
      broadcastSSE(
        'flag_captured',
        wave.auth === 'none' ? { ...flagEvent, challengeId: publicChallengeId } : flagEvent,
      );
    }
  }
  if (mutatedDuringScoring) scheduleStateBroadcast();

  return {
    findings: scoredFindings,
    graphQueries: classified.graphQueries,
    graphContributions: classified.graphContributions,
    webLookups: classified.webLookups,
  };
}

async function prepareRepos(challenges: Challenge[], reposDir: string): Promise<Map<string, string>> {
  const repoPaths = new Map<string, string>();
  const uniqueRepos = [...new Set(challenges.map(ch => ch.repo))];
  emitSetup(
    'repos.prepare',
    `Gathering supplies: ${uniqueRepos.length} repos for ${challenges.length} challenges`,
    `*the party reviews its quest log and begins gathering provisions for the journey...*`,
  );

  await Promise.all(uniqueRepos.map(async (repo) => {
    const repoUrl = REPOS[repo];
    if (!repoUrl) return;
    try {
      repoPaths.set(repo, await cloneOrUpdateRepo(repo, repoUrl, reposDir));
    } catch (err) {
      console.error(`[orchestrator] Failed to clone ${repo}: ${err}`);
      emitSetup('repo.failed', `Failed to acquire ${repo}: ${err}`, `*${repo} merchant is closed for the season*`);
    }
  }));

  emitSetup(
    'repos.ready',
    `Supplies acquired: ${repoPaths.size}/${uniqueRepos.length} repos at the ready`,
    `*saddlebags packed, maps unfurled — the party is ready to set forth*`,
  );
  return repoPaths;
}

function safePathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '_');
}

function shouldScrubColdPath(relativePath: string, basenameValue: string): boolean {
  const rel = relativePath.toLowerCase();
  const base = basenameValue.toLowerCase();

  if (base === '.git' || base === '.github' || base === '.gitlab') return true;
  if (base === 'news' || base.startsWith('news.')) return true;
  if (base === 'changelog' || base.startsWith('changelog')) return true;
  if (base === 'changes' || base.startsWith('changes.')) return true;
  if (base.startsWith('security') || base.startsWith('advisory')) return true;
  if (base.includes('cve')) return true;
  if (rel === 'debian/changelog' || rel.startsWith('debian/patches/')) return true;
  if (rel.startsWith('rpm/') || rel.startsWith('patches/')) return true;

  return false;
}

export function scrubColdSourceWorkspace(repoPath: string): void {
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const fullPath = resolve(dir, entry.name);
      const relPath = relative(repoPath, fullPath);

      if (shouldScrubColdPath(relPath, entry.name)) {
        rmSync(fullPath, { recursive: true, force: true });
        continue;
      }

      if (entry.isDirectory()) walk(fullPath);
    }
  };

  walk(repoPath);
}

export function prepareColdSourceWorkspace(opts: {
  baseRepoPath: string;
  reposDir: string;
  agentId: string;
  challenge: Challenge;
}): string {
  const repoPath = resolve(
    opts.reposDir,
    '_cold_agents',
    safePathSegment(opts.agentId),
    `${safePathSegment(opts.challenge.repo)}-${opaqueChallengeId(opts.challenge)}`,
  );
  const archivePath = resolve(
    opts.reposDir,
    '_archives',
    `${safePathSegment(opts.agentId)}-${opaqueChallengeId(opts.challenge)}.tar`,
  );

  rmSync(repoPath, { recursive: true, force: true });
  mkdirSync(repoPath, { recursive: true });
  mkdirSync(dirname(archivePath), { recursive: true });

  // Do NOT call checkoutVersion here -- with --parallel >1 multiple agents
  // race on the shared base-repo HEAD. `git archive TAG` works directly off
  // the tag's tree object (no checkout needed) as long as the tag exists in
  // local refs (clone fetched all tags). Also disable credential prompts so
  // a missing tag fails fast instead of hanging on an auth dialog.
  // Belt + suspenders to block Git Credential Manager dialogs:
  //   * GIT_TERMINAL_PROMPT=0          — disable interactive terminal prompts
  //   * GCM_INTERACTIVE=Never           — Git Credential Manager non-interactive
  //   * GIT_ASKPASS=echo                — askpass returns empty -> no prompt
  //   * SSH_ASKPASS=echo                — same for SSH-style prompts
  //   * GIT_CONFIG_NOSYSTEM=1           — don't read system git config
  //   * -c credential.helper=           — clear any per-user credential helper
  execFileSync('git', [
    '-c', 'credential.helper=',
    '-C', opts.baseRepoPath,
    'archive',
    '--format=tar',
    '--output', archivePath,
    opts.challenge.affectedVersion,
  ], {
    stdio: 'pipe',
    timeout: 120_000,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      GCM_INTERACTIVE: 'Never',
      GIT_ASKPASS: 'echo',
      SSH_ASKPASS: 'echo',
      GIT_CONFIG_NOSYSTEM: '1',
    },
  });
  // GNU tar quirks on Windows: `C:\path` is interpreted as `host:path` (rsh
  // remote spec) and backslash escape sequences mangle paths. Both go away
  // when we feed tar via stdin and the destination via forward slashes plus
  // --force-local. On Linux/Mac these flags are harmless.
  const tarDest = repoPath.replace(/\\/g, '/');
  const archiveBuf = readFileSync(archivePath);
  execFileSync('tar', ['--force-local', '-xf', '-', '-C', tarDest], {
    stdio: ['pipe', 'pipe', 'pipe'],
    input: archiveBuf,
    timeout: 120_000,
  });
  rmSync(archivePath, { force: true });

  scrubColdSourceWorkspace(repoPath);
  return repoPath;
}

function ensureAgentRepo(
  baseRepoPath: string,
  reposDir: string,
  agentId: string,
  repoName: string,
  challenge: Challenge,
  _wave: WaveConfig,
): string {
  // Warm waves used to get a git worktree with full history, which let the
  // agent `git log` / `git diff` against the fix commit -- the answer key in
  // the workspace. Use the same scrubbed snapshot as cold for every wave.
  // The treatment-vs-control difference is graph access, not whether `.git`
  // and CHANGELOG files are visible in the audit tree.
  return prepareColdSourceWorkspace({
    baseRepoPath,
    reposDir,
    agentId,
    challenge,
  });
}

function agentFromWaveEntry(wave: WaveConfig, entry: WaveAgentConfig): AgentConfig {
  const suffix = randomBytes(3).toString('hex');
  return {
    id: `${entry.label}-w${wave.number}-${suffix}`,
    name: entry.name ?? entry.label,
    model: entry.model,
    modelId: entry.modelId,
    runtime: entry.runtime,
    auth: entry.auth,
    wave: wave.number,
    waveLabel: entry.label,
    spriteType: entry.spriteType,
    canContribute: entry.canContribute,
  };
}

function agentsForWave(wave: WaveConfig, agentsPerWave: number): AgentConfig[] {
  if (wave.agents) {
    return wave.agents.map(entry => agentFromWaveEntry(wave, entry));
  }

  if (wave.model === 'mixed' || wave.runtime === 'mixed') {
    throw new Error(`Wave ${wave.label} is mixed but has no explicit agent roster.`);
  }

  const agents: AgentConfig[] = [];
  for (let i = 0; i < agentsPerWave; i++) {
    const suffix = agentsPerWave === 1 ? randomBytes(3).toString('hex') : `a${i + 1}-${randomBytes(2).toString('hex')}`;
    agents.push({
      id: `${wave.label}-w${wave.number}-${suffix}`,
      name: `${wave.label}${agentsPerWave > 1 ? `-${i + 1}` : ''}`,
      model: wave.model,
      modelId: wave.modelId,
      runtime: wave.runtime,
      auth: wave.auth,
      wave: wave.number,
      waveLabel: wave.label,
      spriteType: wave.spriteType,
      canContribute: wave.canContribute,
    });
  }
  return agents;
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
    runtime: wave.runtime,
    canContribute: wave.canContribute,
    graphState: wave.graphState,
    description: wave.description,
    challenges: challenges.map(c => c.id),
    scores: {},
    tokensAt: {},
    startTime: Date.now(),
  };
  waves.push(waveRecord);

  broadcastSSE('wave_started', {
    wave: wave.number,
    label: wave.label,
    model: wave.model,
    modelId: wave.modelId,
    runtime: wave.runtime,
    auth: wave.auth,
    description: wave.description,
    canContribute: wave.canContribute,
  });

  const agents = agentsForWave(wave, config.agentsPerWave);
  console.log(`  Agents: ${agents.map(agent => agent.name).join(', ')}`);

  for (const agent of agents) {
    waveRecord.scores[agent.id] = {};
    waveRecord.tokensAt![agent.id] = {};
  }

  const trackers = new Map<string, {
    findings: ScoredFinding[];
    challengesAttempted: number;
    challengesSolved: number;
    graphQueries: number;
    graphContributions: number;
    webLookups: number;
    startTime: number;
  }>();

  for (const agent of agents) {
    trackers.set(agent.id, {
      findings: [],
      challengesAttempted: 0,
      challengesSolved: 0,
      graphQueries: 0,
      graphContributions: 0,
      webLookups: 0,
      startTime: Date.now(),
    });
  }

  const settled = await runWithConcurrency(agents, config.parallel, async (agent) => {
    for (const challenge of challenges) {
      const repoPath = repoPaths.get(challenge.repo);
      if (!repoPath) {
        console.warn(`[orchestrator] No repo path for ${challenge.repo}, skipping ${challenge.id}`);
        continue;
      }

      // Cumulative budget gates: once an agent's cumulative tokensUsed or
      // toolCalls exceeds the configured cap, skip remaining challenges.
      // The dashboard HP/MP bars (cumulative) and these gates stay in sync.
      const liveState = agentStates[agent.id];
      if (liveState && liveState.tokensUsed >= liveState.tokenBudget) {
        console.warn(`[orchestrator] ${agent.name} cumulative token budget exhausted (${liveState.tokensUsed.toLocaleString()}/${liveState.tokenBudget.toLocaleString()}); skipping ${challenge.id}`);
        liveState.status = 'throttled';
        waveRecord.scores[agent.id][challenge.id] = 0;
        if (waveRecord.tokensAt) waveRecord.tokensAt[agent.id][challenge.id] = liveState.tokensUsed;
        continue;
      }
      if (liveState && liveState.toolCalls >= liveState.maxToolCalls) {
        console.warn(`[orchestrator] ${agent.name} cumulative tool-call budget exhausted (${liveState.toolCalls}/${liveState.maxToolCalls}); skipping ${challenge.id}`);
        liveState.status = 'throttled';
        waveRecord.scores[agent.id][challenge.id] = 0;
        if (waveRecord.tokensAt) waveRecord.tokensAt[agent.id][challenge.id] = liveState.tokensUsed;
        continue;
      }

      // Isolate per-challenge failures: a bad git tag or workspace prep
      // error must not kill the agent's whole challenge loop. Skip and move on.
      try {
        const agentRepoPath = ensureAgentRepo(repoPath, config.reposDir, agent.id, challenge.repo, challenge, wave);
        const mcpConfigPath = buildMcpConfig({
          auth: agent.auth,
          apiKey,
          resultsDir: framingResultsDir,
          agentId: agent.id,
        });

        const result = await runAgentForChallenge({
          agent,
          wave,
          challenge,
          repoPath: agentRepoPath,
          config,
          framingResultsDir,
          mcpConfigPath,
        });

        const tracker = trackers.get(agent.id)!;
        tracker.challengesAttempted++;
        tracker.findings.push(...result.findings);
        tracker.graphQueries += result.graphQueries;
        tracker.graphContributions += result.graphContributions;
        tracker.webLookups += result.webLookups;

        const bestScore = result.findings.reduce((max, finding) => Math.max(max, finding.scores.total), 0);
        waveRecord.scores[agent.id][challenge.id] = bestScore;
        // Snapshot cumulative tokens used right after this challenge so the
        // dashboard can plot (tokens, score) for the convergence chart.
        if (waveRecord.tokensAt) {
          waveRecord.tokensAt[agent.id][challenge.id] = agentStates[agent.id]?.tokensUsed ?? 0;
        }
        if (result.findings.some(isSolved)) tracker.challengesSolved++;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`[orchestrator] ${agent.name} skipped ${challenge.id}: ${message.split('\n')[0]}`);
        // Mark as attempted-but-failed so accounting reflects the skip.
        const tracker = trackers.get(agent.id);
        if (tracker) tracker.challengesAttempted++;
        waveRecord.scores[agent.id][challenge.id] = 0;
      }
    }
  });

  const failedAgents = settled.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
  if (failedAgents.length > 0) {
    console.warn(`[orchestrator] ${failedAgents.length} agent worker(s) failed in wave ${wave.label}:`);
    for (const failure of failedAgents) {
      const reason = failure.reason;
      const message = reason instanceof Error ? reason.message : String(reason);
      console.warn(`  - ${message}`);
    }
  }

  for (const agent of agents) {
    const state = agentStates[agent.id];
    if (state) {
      state.status = state.budgetExceeded ? 'throttled' : 'finished';
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
      webLookups: tracker.webLookups,
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
  if (wave.canContribute) {
    emitSetup('extraction.drain.start', `Waiting for ${wave.label} contributions to settle...`, '*the Scribes are still inscribing new wisdom...*');
    await drainExtraction(30_000);
    emitSetup('extraction.drain.done', `${wave.label} contributions inscribed`, '*the ink has dried; the next party may now read what was written*');
  }

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
    const webLookups = results.reduce((sum, r) => sum + r.webLookups, 0);

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
      webLookups,
    };
  });

  writeFileSync(resolve(resultsDir, 'comparison.json'), JSON.stringify(comparison, null, 2));

  const lines = [
    `# CTF Cold-To-Warm Demo Summary - ${result.framing}`,
    '',
    `Run: ${result.runId.slice(0, 8)}`,
    `Started: ${result.startedAt}`,
    `Completed: ${result.completedAt}`,
    '',
    '| Wave | Label | Model | Auth | Solved | Score | Graph reads | Graph writes | Web lookups |',
    '|------|-------|-------|------|--------|-------|-------------|--------------|-------------|',
    ...comparison.map(row => `| ${row.wave} | ${row.label} | ${row.model} | ${row.auth} | ${row.challengesSolved}/${row.challengesAttempted} | ${row.totalScore} | ${row.graphReads} | ${row.graphWrites} | ${row.webLookups} |`),
  ];

  if (result.framing === 'equalization') {
    const opus = comparison.find(row => row.label === 'opus-cold');
    const haiku = comparison.find(row => row.label === 'haiku-warm');
    const qwen = comparison.find(row => row.label === 'qwen3-14b-cold');
    if (opus && haiku) {
      const ratio = opus.totalScore > 0 ? Math.round((haiku.totalScore / opus.totalScore) * 100) : 0;
      lines.push('', `Haiku warm reached ${ratio}% of Opus cold score.`);
    }
    if (opus && qwen) {
      const ratio = opus.totalScore > 0 ? Math.round((qwen.totalScore / opus.totalScore) * 100) : 0;
      lines.push(`Qwen3 14B local cold reached ${ratio}% of Opus cold score.`);
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

  emitSetup('graph.snapshot.start', 'The Oracle gazes into the Graph...', '*calling on the Sage of Snapshots for a tally of stones*');
  const graphBefore = await snapshotGraph(apiKey);
  emitSetup(
    'graph.snapshot.done',
    `Initial graph: ${graphBefore.nodeCount} nodes, ${graphBefore.edgeCount} edges`,
    `*${graphBefore.nodeCount} nodes already inscribed in the Hall of Records*`,
  );
  writeFileSync(resolve(framingResultsDir, 'graph-before.json'), JSON.stringify(graphBefore, null, 2));

  const waveResults: FramingResult['waves'] = [];
  const selectedWaves = wavesForFraming(framing, config.generations);

  for (const wave of selectedWaves) {
    if (framing === 'equalization' && wave.graphState === 'empty' && wave.number === 1) {
      emitSetup('graph.wipe.start', 'Wiping ctf-bench namespace...', '*burning relics in the Hall of Records to forge a clean slate*');
      const wiped = await wipeCtfNodes(apiKey);
      emitSetup(
        'graph.wipe.done',
        `Wipe complete: ${wiped >= 0 ? wiped + ' nodes purged' : 'manual cleanup required'}`,
        wiped >= 0
          ? `*the ${wiped} ctf relics are dust on the wind*`
          : '*the High Council demands manual rites — cleanup deferred*',
      );
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

/**
 * Pull credentials out of nearby config files into process.env if not
 * already set. Looks at `~/errata/.mcp.json` (the errata project's
 * claude-code MCP config) which carries `ERRATA_API_KEY` under the
 * inerrata-channel server's env. Aliases `ERRATA_API_KEY` ↔
 * `INERRATA_API_KEY` so either spelling works.
 */
function bootstrapInerrataCreds(): void {
  // Try common locations for an errata MCP config.
  const candidates = [
    process.env.CTF_INERRATA_MCP_JSON,
    resolve(PROJECT_ROOT, '..', '..', '..', '..', 'errata', '.mcp.json'),
    resolve(PROJECT_ROOT, '..', '..', '..', 'errata', '.mcp.json'),
  ].filter((v): v is string => typeof v === 'string');

  for (const path of candidates) {
    if (!existsSync(path)) continue;
    try {
      const cfg: { mcpServers?: Record<string, { env?: Record<string, string> }> } =
        JSON.parse(readFileSync(path, 'utf-8'));
      for (const server of Object.values(cfg.mcpServers ?? {})) {
        const serverEnv = server.env ?? {};
        for (const [k, v] of Object.entries(serverEnv)) {
          if (typeof v === 'string' && v.length > 0 && !process.env[k]) {
            process.env[k] = v;
          }
        }
      }
      console.log(`[orchestrator] Loaded credentials from ${path}`);
      break;
    } catch {
      /* try next */
    }
  }

  // Aliases: accept either ERRATA_ or INERRATA_ prefixed names.
  if (!process.env.INERRATA_API_KEY && process.env.ERRATA_API_KEY) {
    process.env.INERRATA_API_KEY = process.env.ERRATA_API_KEY;
  }
  if (!process.env.ERRATA_API_KEY && process.env.INERRATA_API_KEY) {
    process.env.ERRATA_API_KEY = process.env.INERRATA_API_KEY;
  }
}

/**
 * Surface missing credentials BEFORE waves start. Each warning explains
 * which wave/agent will be skipped or fail. Runs in main() and prints to
 * stderr without aborting -- the user can still get partial results.
 */
function preflightEnvCheck(framings: BenchmarkFraming[], generations: number): void {
  const waves = framings.flatMap(framing => wavesForFraming(framing, generations));
  const needsAuth = waves.some(w => w.auth === 'authenticated');
  const needsAnyMcp = waves.some(w => w.auth !== 'none');
  const usesAzure = waves.some(w => (w.agents ?? []).some(a => a.runtime === 'azure-openai'));
  const usesOllama = waves.some(w => (w.agents ?? []).some(a => a.runtime === 'ollama'));

  const warnings: string[] = [];

  if (usesAzure && !process.env.AZURE_OPENAI_API_KEY) {
    warnings.push('AZURE_OPENAI_API_KEY is unset; azure-openai agents will fail at first chat call.');
  }
  if (usesAzure && !process.env.AZURE_OPENAI_ENDPOINT) {
    warnings.push('AZURE_OPENAI_ENDPOINT is unset; azure-openai agents will fail.');
  }
  if (needsAuth && !process.env.INERRATA_API_KEY) {
    warnings.push(
      'INERRATA_API_KEY is unset; authenticated waves will SKIP every agent (buildMcpConfig throws). '
      + 'Cold and anonymous waves still run.',
    );
  }
  const hasMcpOverride =
    !!process.env.CTF_INERRATA_MCP_URL ||
    !!process.env.INERRATA_MCP_URL ||
    !!process.env.CTF_INERRATA_API_URL ||
    !!process.env.INERRATA_API_URL ||
    !!process.env.ERRATA_API_URL;
  if (needsAnyMcp && !hasMcpOverride) {
    warnings.push(
      'No MCP/API URL override set; warm waves will try to reach the default '
      + '(http://127.0.0.1:3100/mcp). Make sure the local inErrata stack is up.',
    );
  }
  if (usesOllama) {
    try {
      execSync('ollama --version', { stdio: 'pipe', timeout: 5_000 });
    } catch {
      warnings.push('`ollama` not found in PATH; qwen3-14b agents will fail with ENOENT.');
    }
  }

  if (warnings.length === 0) return;

  console.warn(`\n[orchestrator] Preflight warnings (${warnings.length}):`);
  for (const w of warnings) console.warn(`  ! ${w}`);
  console.warn('');
}

async function main() {
  const config = parseConfig();
  const selectedChallenges = selectChallenges(config);
  activeChallenges = selectedChallenges;
  const selectedWaveConfigs = framingsToRun(config.framing).flatMap(framing => wavesForFraming(framing, config.generations));
  const rosteredAgentCounts = selectedWaveConfigs
    .map(wave => wave.agents?.length)
    .filter((count): count is number => typeof count === 'number');
  const agentsPerTierLabel = rosteredAgentCounts.length > 0
    ? `rostered (${Math.max(...rosteredAgentCounts)} model types)`
    : `${config.agentsPerWave}`;

  console.log(`\n${'='.repeat(72)}`);
  console.log('  CTF Cold-To-Warm Demo');
  console.log(`  Framing:        ${config.framing}`);
  console.log(`  Agents/tier:    ${agentsPerTierLabel}`);
  console.log(`  Parallel agents:${config.parallel}`);
  console.log(`  Tool budget:    ${config.maxToolCalls}`);
  console.log(`  Token budget:   ${config.tokenBudget.toLocaleString()} (cumulative per agent across full run)`);
  console.log(`  Generations:    ${config.generations} authenticated gens${config.generations > 1 ? ' (compounding test)' : ''}`);
  console.log(`  Head-to-head:   ${process.env.CTF_HEAD_TO_HEAD === '1' || process.env.CTF_HEAD_TO_HEAD === 'true' ? 'enabled (claude + gpt-5.4 lanes)' : 'disabled (single runtime per tier)'}`);
  console.log(`  Agent sandbox:  ${config.sandboxAgents ? 'enabled' : 'disabled'}`);
  if (config.maxDifficulty) console.log(`  Max difficulty: ${config.maxDifficulty}/5`);
  if (config.challengeId) console.log(`  Challenge:      ${config.challengeId}`);
  console.log(`  Challenges:     ${selectedChallenges.length}`);
  console.log(`  Results:        ${config.resultsDir}`);
  console.log(`  Run ID:         ${runId.slice(0, 8)}`);
  console.log(`${'='.repeat(72)}\n`);

  bootstrapInerrataCreds();
  preflightEnvCheck(framingsToRun(config.framing), config.generations);

  startSSEServer(config.port);

  for (const framing of framingsToRun(config.framing)) {
    const result = await runFraming(framing, config, selectedChallenges);
    console.log(`\n[orchestrator] ${framing} complete: ${result.totalSolved} solved, ${result.totalScore} pts`);
  }

  console.log('[orchestrator] CTF Cold-To-Warm Demo run complete. Dashboard server remains available.');
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err) => {
    console.error('[orchestrator] CTF Cold-To-Warm Demo failed:', err);
    process.exit(1);
  });
}

export {
  EQUALIZATION_WAVES,
  FUNNEL_WAVES,
  buildDashboardState,
};
