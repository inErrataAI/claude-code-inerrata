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
import { writeFileSync, mkdirSync, existsSync, readdirSync, rmSync } from 'fs';
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
      'max-tool-calls': { type: 'string', default: '35' },
      'agents-per-wave': { type: 'string', default: '4' },
      parallel: { type: 'string', default: '4' },
      'no-sandbox': { type: 'boolean', default: false },
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

  const parallel = parseInt(values.parallel!, 10);
  if (!Number.isFinite(parallel) || parallel < 1) {
    throw new Error(`Invalid --parallel: ${values.parallel}. Must be >= 1.`);
  }

  const maxToolCalls = parseInt(values['max-tool-calls']!, 10);
  if (!Number.isFinite(maxToolCalls) || maxToolCalls < 1) {
    throw new Error(`Invalid --max-tool-calls: ${values['max-tool-calls']}. Must be >= 1.`);
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
  const spawnOptions: SpawnOptions = {
    cwd: sandbox.cwd,
    env: {
      ...process.env,
      INERRATA_API_KEY: process.env.INERRATA_API_KEY ?? '',
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: process.env.CTF_MAX_OUTPUT_TOKENS
        ?? process.env.MAX_OUTPUT_TOKENS
        ?? process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS
        ?? '8192',
      CTF_WAVE_LABEL: opts.agent.waveLabel,
      CTF_CAN_CONTRIBUTE: opts.agent.canContribute ? 'true' : 'false',
      CTF_AGENT_SOURCE: `ctf-bench-${opts.wave.label}-${opts.agent.id}`,
      CTF_AGENT_SANDBOX: sandbox.enabled ? '1' : '0',
    },
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

  const command = 'claude';
  const args = commonClaudeArgs(true);

  return sandbox.enabled
    ? spawn(sandbox.command, [...sandbox.args, command, ...args], spawnOptions)
    : spawn(command, args, spawnOptions);
}

export function parseStreamJson(raw: string): {
  text: string;
  toolCalls: string[];
} {
  const assistantText: string[] = [];
  const resultText: string[] = [];
  const toolCalls: string[] = [];

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
      }
    } catch {
      resultText.push(line);
    }
  }

  const text = assistantText.length > 0 ? assistantText : resultText;
  return { text: text.join('\n'), toolCalls };
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

function ensureAgentState(agent: AgentConfig, wave: WaveConfig, challenge: Challenge): AgentState {
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

  if (opts.wave.auth === 'none' && opts.classified.graphHits > 0) {
    reasons.push('graph-tool-used-in-cold-wave');
  }

  if (opts.wave.auth === 'none' && opts.toolCalls.some(isExternalLookupTool)) {
    reasons.push('external-lookup-tool-used-in-cold-wave');
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
}): Promise<{ findings: ScoredFinding[]; graphQueries: number; graphContributions: number }> {
  const { agent, wave, challenge, repoPath, config, framingResultsDir } = opts;
  const agentState = ensureAgentState(agent, wave, challenge);
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

  if (existsSync(resolve(repoPath, '.git'))) {
    checkoutVersion(repoPath, challenge.affectedVersion);
  }

  const child = spawnAuditAgent({
    agent,
    wave: agentWave,
    systemPrompt: buildSystemPrompt(agentWave),
    challengePrompt: buildChallengePrompt(challenge, agentWave),
    repoPath,
    mcpConfigPath: opts.mcpConfigPath,
    sandboxAgents: config.sandboxAgents,
    maxToolCalls: config.maxToolCalls,
  });

  child.stderr?.on('data', (chunk: Buffer) => {
    const text = chunk.toString().trim();
    if (!text) return;
    broadcastSSE('tool_call', { agentId: agent.id, tool: 'audit', challengeId: publicChallengeId });
  });

  const { stdout, stderr, exitCode } = await collectProcessOutput(child, config.timeoutMinutes * 60_000);
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`[agent:${agent.name}] ${challenge.id} finished exit=${exitCode} in ${elapsed}s`);
  if (stderr.trim()) console.warn(`[agent:${agent.name}] stderr: ${stderr.trim().slice(0, 500)}`);

  writeFileSync(resolve(framingResultsDir, `${agent.id}-${publicChallengeId}.ndjson`), stdout);

  const parsed = parseStreamJson(stdout);
  writeFileSync(resolve(framingResultsDir, `${agent.id}-${publicChallengeId}.txt`), parsed.text);

  const classified = classifyToolCalls(parsed.toolCalls);
  agentState.toolCalls += parsed.toolCalls.length;
  agentState.graphHits += classified.graphHits;
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

  for (const toolName of parsed.toolCalls) {
    if (toolName.includes('inerrata')) {
      broadcastSSE('graph_hit', { agentId: agent.id, challengeId: publicChallengeId, tool: toolName });
    }
  }

  const rawFindings = parseFindings(parsed.text, agent.id, challenge);
  const scoredFindings = scoreAllFindings(rawFindings)
    .map(finding => applyRunDisqualification(finding, runDisqualifications));

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
      broadcastSSE(
        'flag_captured',
        wave.auth === 'none' ? { ...flagEvent, challengeId: publicChallengeId } : flagEvent,
      );
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

  checkoutVersion(opts.baseRepoPath, opts.challenge.affectedVersion);
  execFileSync('git', [
    '-C',
    opts.baseRepoPath,
    'archive',
    '--format=tar',
    '--output',
    archivePath,
    opts.challenge.affectedVersion,
  ], {
    stdio: 'pipe',
    timeout: 120_000,
  });
  execFileSync('tar', ['-xf', archivePath, '-C', repoPath], {
    stdio: 'pipe',
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
  wave: WaveConfig,
): string {
  if (wave.auth === 'none') {
    return prepareColdSourceWorkspace({
      baseRepoPath,
      reposDir,
      agentId,
      challenge,
    });
  }

  const repoPath = resolve(reposDir, '_agents', safePathSegment(agentId), safePathSegment(repoName));
  if (existsSync(resolve(repoPath, '.git'))) return repoPath;

  mkdirSync(dirname(repoPath), { recursive: true });
  execFileSync('git', ['-C', baseRepoPath, 'worktree', 'add', '--force', '--detach', repoPath], {
    stdio: 'pipe',
    timeout: 120_000,
  });
  return repoPath;
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

  const settled = await runWithConcurrency(agents, config.parallel, async (agent) => {
    for (const challenge of challenges) {
      const repoPath = repoPaths.get(challenge.repo);
      if (!repoPath) {
        console.warn(`[orchestrator] No repo path for ${challenge.repo}, skipping ${challenge.id}`);
        continue;
      }

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

      const bestScore = result.findings.reduce((max, finding) => Math.max(max, finding.scores.total), 0);
      waveRecord.scores[agent.id][challenge.id] = bestScore;
      if (result.findings.some(isSolved)) tracker.challengesSolved++;
    }
  });

  const failedAgents = settled.filter(result => result.status === 'rejected');
  if (failedAgents.length > 0) {
    console.warn(`[orchestrator] ${failedAgents.length} agent worker(s) failed in wave ${wave.label}.`);
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
    `# CTF Cold-To-Warm Demo Summary - ${result.framing}`,
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
  const selectedWaveConfigs = framingsToRun(config.framing).flatMap(framing => wavesForFraming(framing));
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
  console.log(`  Agent sandbox:  ${config.sandboxAgents ? 'enabled' : 'disabled'}`);
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
