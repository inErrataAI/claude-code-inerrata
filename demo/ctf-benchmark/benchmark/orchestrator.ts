#!/usr/bin/env tsx
/**
 * CTF Benchmark Orchestrator
 *
 * Runs multi-agent benchmarks against the procedural maze server with
 * cold/warm/sequential modes to measure knowledge graph compounding.
 *
 * Usage:
 *   npx tsx benchmark/orchestrator.ts --mode cold --agents 5 --model haiku
 *   npx tsx benchmark/orchestrator.ts --mode warm --agents 5 --model haiku --prior-run <id>
 *   npx tsx benchmark/orchestrator.ts --mode cold --agents 3 --model opus   # baseline ceiling
 *   npx tsx benchmark/orchestrator.ts --mode sequential --agents 5 --model haiku
 */
import { parseArgs } from 'util'
import { randomUUID, randomBytes } from 'crypto'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import {
  writeFileSync, readFileSync, mkdirSync, existsSync, readdirSync, unlinkSync,
} from 'fs'
import { spawn, type ChildProcess } from 'child_process'
import type { Challenge, Target, AgentRunResult, BenchmarkEvent } from '../agents/types.js'
import { buildSystemPrompt, buildKickOff } from '../agents/prompts.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type BenchmarkMode = 'cold' | 'warm' | 'warm-live' | 'sequential'

interface BenchmarkConfig {
  target: string
  agentCount: number
  mode: BenchmarkMode
  model: string
  priorRunId?: string
  timeoutMinutes: number
  skipMaze: boolean
  sequential: boolean
  hardOnly: boolean
  seed?: string
}

interface AgentCredentials {
  agentId: string
  handle: string
  apiKey: string
}

interface RunResult {
  runId: string
  config: BenchmarkConfig & { mazeSeed: string | null }
  agents: AgentRunSummary[]
  graphDelta: { nodesAdded: number; edgesAdded: number }
  startedAt: string
  completedAt: string
}

interface AgentRunSummary extends AgentRunResult {
  handle: string
  agentId: string
  points: number
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const __dirname = typeof import.meta.dirname === 'string'
  ? import.meta.dirname
  : dirname(fileURLToPath(import.meta.url))

const RESULTS_DIR = resolve(__dirname, '..', 'results')

function parseConfig(): BenchmarkConfig {
  const { values } = parseArgs({
    options: {
      target:       { type: 'string', default: 'maze' },
      agents:       { type: 'string', default: '5' },
      mode:         { type: 'string', default: 'cold' },
      model:        { type: 'string', default: 'haiku' },
      'prior-run':  { type: 'string' },
      timeout:      { type: 'string', default: '120' },
      'skip-maze':  { type: 'boolean', default: false },
      sequential:   { type: 'boolean', default: false },
      'hard-only':  { type: 'boolean', default: false },
      seed:         { type: 'string' },
    },
  })

  const mode = values.mode as BenchmarkMode
  if (!['cold', 'warm', 'warm-live', 'sequential'].includes(mode)) {
    throw new Error(`Invalid mode: ${mode}. Must be cold, warm, warm-live, or sequential`)
  }
  if ((mode === 'warm' || mode === 'warm-live') && !values['prior-run']) {
    throw new Error(`${mode} mode requires --prior-run <run-id>`)
  }
  if (values.mode === 'sequential') {
    // sequential implies running agents one at a time
  }

  return {
    target: values.target!,
    agentCount: parseInt(values.agents!, 10),
    mode,
    model: values.model!,
    priorRunId: values['prior-run'],
    timeoutMinutes: parseInt(values.timeout!, 10),
    skipMaze: values['skip-maze']!,
    sequential: mode === 'sequential' || values.sequential!,
    hardOnly: values['hard-only']!,
    seed: values.seed,
  }
}

// ---------------------------------------------------------------------------
// Model name resolution
// ---------------------------------------------------------------------------

const MODEL_MAP: Record<string, string> = {
  haiku:        'claude-3-5-haiku-20241022',
  sonnet:       'claude-sonnet-4-20250514',
  opus:         'claude-opus-4-20250514',
}

function resolveModel(shortName: string): string {
  return MODEL_MAP[shortName] ?? shortName
}

// ---------------------------------------------------------------------------
// Maze server management
// ---------------------------------------------------------------------------

async function waitForHealth(url: string, timeout = 15_000): Promise<void> {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url}/health`)
      if (res.ok) return
    } catch { /* not ready */ }
    await new Promise(r => setTimeout(r, 500))
  }
  throw new Error(`Health check timed out: ${url}`)
}

async function startMazeServer(seed?: string): Promise<{ process: ChildProcess; seed: string }> {
  const mazeServerPath = resolve(__dirname, '..', 'server', 'maze.ts')
  const port = process.env.MAZE_PORT ?? '4444'
  const seedArgs = seed ? ['--seed', seed] : []

  console.log(`[ctf] Starting maze server${seed ? ` (seed: ${seed})` : ''}...`)

  const child = spawn('npx', ['tsx', mazeServerPath, ...seedArgs], {
    env: { ...process.env, PORT: port },
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: true,
  })

  child.stdout?.on('data', (d: Buffer) => {
    const s = d.toString().trim()
    if (s) console.log(`[maze] ${s}`)
  })
  child.stderr?.on('data', (d: Buffer) => {
    const s = d.toString().trim()
    if (s && !s.includes('DEP0190')) console.error(`[maze:err] ${s}`)
  })

  const targetUrl = `http://localhost:${port}`
  await waitForHealth(targetUrl)

  // Read the seed from the running server
  const meta = await fetch(`${targetUrl}/maze/meta`).then(r => r.json()) as { seed?: string }
  const actualSeed = meta.seed ?? seed ?? 'unknown'
  console.log(`[ctf] Maze server healthy (seed: ${actualSeed})`)

  return { process: child, seed: actualSeed }
}

// ---------------------------------------------------------------------------
// Agent provisioning via inErrata API
// ---------------------------------------------------------------------------

async function createBenchmarkAgents(opts: {
  count: number
  model: string
  apiBaseUrl: string
}): Promise<AgentCredentials[]> {
  const agents: AgentCredentials[] = []

  for (let i = 0; i < opts.count; i++) {
    const handle = `ctf-bench-${randomBytes(4).toString('hex')}`

    try {
      // Register agent via inErrata API onboarding endpoint
      const res = await fetch(`${opts.apiBaseUrl}/api/v1/agents/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          handle,
          model: opts.model,
          description: `CTF benchmark agent (${opts.model})`,
        }),
      })

      if (!res.ok) {
        // Fallback: use environment API key for all agents
        console.warn(`[ctf] Agent registration failed (${res.status}), using shared API key`)
        const apiKey = process.env.INERRATA_API_KEY
        if (!apiKey) throw new Error('INERRATA_API_KEY required when agent registration unavailable')
        agents.push({ agentId: handle, handle, apiKey })
        continue
      }

      const data = await res.json() as { agentId: string; apiKey: string }
      agents.push({ agentId: data.agentId, handle, apiKey: data.apiKey })
      console.log(`[ctf] Registered agent: ${handle}`)
    } catch (err) {
      // Fallback to shared key
      const apiKey = process.env.INERRATA_API_KEY
      if (!apiKey) throw new Error('INERRATA_API_KEY required when agent registration unavailable')
      agents.push({ agentId: handle, handle, apiKey })
    }
  }

  return agents
}

// ---------------------------------------------------------------------------
// Graph snapshot via inErrata API
// ---------------------------------------------------------------------------

interface GraphSnapshot {
  timestamp: Date
  nodeCount: number
  edgeCount: number
}

async function snapshotGraph(apiBaseUrl: string, apiKey: string): Promise<GraphSnapshot> {
  try {
    const res = await fetch(`${apiBaseUrl}/api/v1/admin/graph/stats`, {
      headers: { 'Authorization': `Bearer ${apiKey}` },
    })
    if (res.ok) {
      const data = await res.json() as { nodeCount: number; edgeCount: number }
      return { timestamp: new Date(), ...data }
    }
  } catch { /* API not available */ }

  return { timestamp: new Date(), nodeCount: 0, edgeCount: 0 }
}

// ---------------------------------------------------------------------------
// Extraction drain (warm mode synchronization)
// ---------------------------------------------------------------------------

async function drainExtraction(apiBaseUrl: string): Promise<void> {
  const adminSecret = process.env.ADMIN_SECRET ?? 'ctf-admin-secret'
  const headers = { 'X-Admin-Secret': adminSecret }
  const timeout = 600_000 // 10 min
  const deadline = Date.now() + timeout

  console.log('[ctf] Draining extraction pipeline...')

  while (Date.now() < deadline) {
    try {
      await fetch(`${apiBaseUrl}/api/v1/admin/graph/flush`, {
        method: 'POST', headers,
      })
      const statusRes = await fetch(`${apiBaseUrl}/api/v1/admin/graph/extraction-status`, { headers })
      if (statusRes.ok) {
        const status = await statusRes.json() as { pending: number }
        if (status.pending === 0) {
          console.log('[ctf] Extraction pipeline drained')
          return
        }
        console.log(`[ctf] Drain pending: ${status.pending} jobs`)
      }
    } catch { /* continue */ }

    await new Promise(r => setTimeout(r, 2_000))
  }

  console.warn('[ctf] Drain timed out')
}

// ---------------------------------------------------------------------------
// Result persistence (file-based, no DB dependency)
// ---------------------------------------------------------------------------

function saveResult(result: RunResult): string {
  mkdirSync(RESULTS_DIR, { recursive: true })
  const filename = `${result.runId.slice(0, 8)}-${result.config.mode}-${result.config.model}.json`
  const path = resolve(RESULTS_DIR, filename)
  writeFileSync(path, JSON.stringify(result, null, 2))
  console.log(`[ctf] Results saved: ${path}`)
  return path
}

function loadPriorRun(runId: string): RunResult | null {
  if (!existsSync(RESULTS_DIR)) return null

  // Search for matching result file
  const files = readdirSync(RESULTS_DIR) as string[]
  const match = files.find((f: string) => f.startsWith(runId.slice(0, 8)))
  if (!match) return null

  return JSON.parse(readFileSync(resolve(RESULTS_DIR, match), 'utf-8')) as RunResult
}

// ---------------------------------------------------------------------------
// Agent spawning via `claude -p` CLI
// ---------------------------------------------------------------------------

function spawnAgent(opts: {
  model: string,
  systemPrompt: string,
  userMessage: string,
  mcpConfigPath?: string,
  agentId: string,
}): ChildProcess {
  const args: string[] = [
    '-p',
    '--bare',
    '--model', opts.model,
    '--system-prompt', opts.systemPrompt,
    '--permission-mode', 'bypassPermissions',
    '--output-format', 'stream-json',
    '--no-session-persistence',
  ]
  if (opts.mcpConfigPath) {
    args.push('--mcp-config', opts.mcpConfigPath)
  }
  args.push(opts.userMessage)

  return spawn('claude', args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env },
  })
}

// ---------------------------------------------------------------------------
// MCP config generation (warm runs)
// ---------------------------------------------------------------------------

function writeMcpConfig(apiKey: string): string {
  const config = {
    mcpServers: {
      inerrata: {
        type: 'http',
        url: 'https://inerrata.ai/mcp',
        headers: { Authorization: `Bearer ${apiKey}` }
      }
    }
  }
  mkdirSync(RESULTS_DIR, { recursive: true })
  const tmpPath = resolve(RESULTS_DIR, `mcp-${randomBytes(4).toString('hex')}.json`)
  writeFileSync(tmpPath, JSON.stringify(config))
  return tmpPath
}

// ---------------------------------------------------------------------------
// Collect output from a spawned claude process
// ---------------------------------------------------------------------------

function collectProcessOutput(child: ChildProcess): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []

    child.stdout?.on('data', (chunk: Buffer) => stdoutChunks.push(chunk))
    child.stderr?.on('data', (chunk: Buffer) => stderrChunks.push(chunk))

    child.on('close', (code) => {
      resolve({
        stdout: Buffer.concat(stdoutChunks).toString(),
        stderr: Buffer.concat(stderrChunks).toString(),
        exitCode: code ?? 1,
      })
    })

    child.on('error', (err) => {
      stderrChunks.push(Buffer.from(err.message))
      resolve({
        stdout: Buffer.concat(stdoutChunks).toString(),
        stderr: Buffer.concat(stderrChunks).toString(),
        exitCode: 1,
      })
    })
  })
}

// ---------------------------------------------------------------------------
// Parse stream-json output for token usage
// ---------------------------------------------------------------------------

function parseStreamJsonTokens(stdout: string): { input: number; output: number } {
  let input = 0
  let output = 0
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue
    try {
      const evt = JSON.parse(line)
      if (evt.type === 'result' && evt.usage) {
        input += evt.usage.input_tokens ?? 0
        output += evt.usage.output_tokens ?? 0
      }
    } catch { /* skip non-JSON lines */ }
  }
  return { input, output }
}

// ---------------------------------------------------------------------------
// Broadcast lifecycle events to maze server SSE
// ---------------------------------------------------------------------------

async function broadcastEvent(targetUrl: string, event: BenchmarkEvent): Promise<void> {
  try {
    await fetch(`${targetUrl}/maze/broadcast`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(event),
    })
  } catch { /* maze server may not be listening — non-fatal */ }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const config = parseConfig()
  const fullModel = resolveModel(config.model)
  const apiBaseUrl = process.env.CTF_API_URL ?? 'http://localhost:3100'
  const mazePort = process.env.MAZE_PORT ?? '4444'
  const targetUrl = `http://localhost:${mazePort}`

  // Resolve maze seed for warm runs
  let mazeSeed: string | null = null
  if (config.priorRunId) {
    const prior = loadPriorRun(config.priorRunId)
    if (prior?.config.mazeSeed) {
      mazeSeed = prior.config.mazeSeed
      console.log(`[ctf] Using prior run seed: ${mazeSeed}`)
    }
  }

  // Start maze server
  let mazeProcess: ChildProcess | null = null
  if (!config.skipMaze) {
    const maze = await startMazeServer(mazeSeed ?? config.seed)
    mazeProcess = maze.process
    mazeSeed = maze.seed
  }

  // Load challenge catalog from maze
  const metaRes = await fetch(`${targetUrl}/maze/meta`)
  const meta = await metaRes.json() as {
    seed: string
    challenges: Array<{ id: string; name: string; points: number; difficulty: string; category: string; description: string }>
  }
  const rawChallenges = config.hardOnly
    ? meta.challenges.filter(c => c.difficulty === 'hard' || c.difficulty === 'expert')
    : meta.challenges

  // Adapt meta challenges to the Challenge interface expected by the worker
  const challenges: Challenge[] = rawChallenges.map(c => ({
    id: c.id,
    target: 'maze',
    name: c.name,
    description: c.description,
    category: c.category as any,
    difficulty: c.difficulty as any,
    points: c.points,
    validate: async (submission: string) => {
      const res = await fetch(`${targetUrl}/maze/validate/${c.id}?flag=${encodeURIComponent(submission)}`)
      const body = await res.json() as { correct: boolean }
      return body.correct
    },
  }))

  const target: Target = { name: 'maze', url: targetUrl, dockerService: '' }
  const totalPoints = challenges.reduce((s, c) => s + c.points, 0)

  const runId = randomUUID()

  console.log(`\n========================================`)
  console.log(`  CTF Benchmark`)
  console.log(`  Target:      maze (${targetUrl})`)
  console.log(`  Mode:        ${config.mode}`)
  console.log(`  Agents:      ${config.agentCount}`)
  console.log(`  Model:       ${config.model} (${fullModel})`)
  console.log(`  Seed:        ${mazeSeed ?? 'random'}`)
  console.log(`  Timeout:     ${config.timeoutMinutes}min per agent`)
  console.log(`  Challenges:  ${challenges.length} (${totalPoints} pts)`)
  console.log(`  Run ID:      ${runId}`)
  if (config.priorRunId) console.log(`  Prior:       ${config.priorRunId}`)
  if (config.sequential) console.log(`  Sequential:  drain between each agent`)
  console.log(`========================================\n`)

  // Cold mode: optionally wipe benchmark-contributed nodes
  if (config.mode === 'cold') {
    console.log('[ctf] Cold mode — agents start with empty/baseline graph')
  }

  // Warm mode: drain extraction pipeline first
  if (config.mode === 'warm') {
    await drainExtraction(apiBaseUrl)
  }

  // Snapshot graph state before run
  const apiKey = process.env.INERRATA_API_KEY ?? ''
  const preSnapshot = await snapshotGraph(apiBaseUrl, apiKey)

  // Create benchmark agents
  const agents = await createBenchmarkAgents({
    count: config.agentCount,
    model: fullModel,
    apiBaseUrl,
  })

  // Run agents via `claude -p` CLI processes
  const startedAt = new Date().toISOString()
  const agentResults: AgentRunSummary[] = []

  async function runOneAgent(agent: AgentCredentials): Promise<AgentRunSummary> {
    console.log(`\n[ctf] === Agent: ${agent.handle} ===\n`)

    const startTime = Date.now()
    const mode = (config.mode === 'warm' || config.mode === 'warm-live') ? 'warm' as const : 'cold' as const

    await broadcastEvent(targetUrl, {
      type: 'agent_started',
      agentId: agent.agentId,
      handle: agent.handle,
      model: fullModel,
      mode,
      timestamp: new Date().toISOString(),
    })
    const systemPrompt = buildSystemPrompt(target, challenges, mode, agent.agentId)
    const userMessage = buildKickOff(targetUrl, mode)

    // Cold runs: no MCP config (no graph access)
    // Warm / warm-live runs: write MCP config with agent's API key
    let mcpConfigPath: string | undefined
    if (config.mode === 'warm' || config.mode === 'warm-live') {
      mcpConfigPath = writeMcpConfig(agent.apiKey)
    }

    const child = spawnAgent({
      model: fullModel,
      systemPrompt,
      userMessage,
      mcpConfigPath,
      agentId: agent.agentId,
    })

    // Stream stderr to console for live progress
    child.stderr?.on('data', (d: Buffer) => {
      const s = d.toString().trim()
      if (s) console.error(`[agent:${agent.handle}] ${s}`)
    })

    const { stdout, exitCode } = await collectProcessOutput(child)
    const elapsed = Date.now() - startTime

    // Clean up temp MCP config
    if (mcpConfigPath) {
      try { unlinkSync(mcpConfigPath) } catch { /* ignore */ }
    }

    // Parse token usage from stream-json output
    const tokens = parseStreamJsonTokens(stdout)

    // Fetch scoreboard from maze server to determine what this agent solved
    let captures: Array<{ challengeId: string; agentId: string; points: number; solvedAt: string }> = []
    try {
      const sbRes = await fetch(`${targetUrl}/maze/scoreboard`)
      if (sbRes.ok) {
        const sbData = await sbRes.json() as {
          captures: Array<{ challengeId: string; agentId: string; points: number; solvedAt: string }>
          byAgent: Record<string, { flags: unknown[]; totalPoints: number; flagCount: number }>
        }
        // Filter captures to only this agent's flags
        captures = (sbData.captures ?? []).filter(c => c.agentId === agent.agentId || c.agentId === agent.handle)
      }
    } catch {
      console.warn(`[ctf] Could not fetch scoreboard for agent ${agent.handle}`)
    }

    // Build result from scoreboard + process output
    const challengeMap = new Map(challenges.map(c => [c.id, c]))
    const flagsCaptured = captures
      .filter(e => challengeMap.has(e.challengeId))
      .map(e => ({
        challengeId: e.challengeId,
        capturedAt: e.solvedAt ? new Date(e.solvedAt) : new Date(),
        submission: '(via claude -p)',
      }))

    const points = flagsCaptured.reduce((sum, f) => {
      return sum + (challengeMap.get(f.challengeId)?.points ?? 0)
    }, 0)

    const result: AgentRunResult = {
      flagsCaptured,
      timeToFirstFlagMs: flagsCaptured.length > 0 ? elapsed : null,
      timeToSolveMs: flagsCaptured.length > 0 ? elapsed : null,
      totalTokensInput: tokens.input,
      totalTokensOutput: tokens.output,
      toolCalls: 0,       // not tracked when using CLI process
      graphToolCalls: 0,  // not tracked when using CLI process
      graphHits: 0,       // not tracked when using CLI process
      firstGraphHitAt: null,
      contributeCalls: 0, // not tracked when using CLI process
      traversalPatterns: [],
      errors: exitCode !== 0 ? [`Process exited with code ${exitCode}`] : [],
      status: exitCode === 0 ? 'completed' : 'failed',
    }

    console.log(
      `[ctf:${agent.handle}] Finished: ${flagsCaptured.length}/${challenges.length} flags, ` +
        `${tokens.input + tokens.output} tokens, ${elapsed}ms, exit=${exitCode}`,
    )

    await broadcastEvent(targetUrl, {
      type: 'agent_finished',
      agentId: agent.agentId,
      handle: agent.handle,
      flagCount: flagsCaptured.length,
      points,
      status: result.status,
      timestamp: new Date().toISOString(),
    })

    return {
      handle: agent.handle,
      agentId: agent.agentId,
      points,
      ...result,
    }
  }

  const waveLabel = `${config.model} ${config.mode}`
  await broadcastEvent(targetUrl, {
    type: 'wave_started',
    wave: 1,
    label: waveLabel,
    model: fullModel,
    mode: (config.mode === 'warm' || config.mode === 'warm-live') ? 'warm' : 'cold',
    agentCount: config.agentCount,
    timestamp: new Date().toISOString(),
  })

  if (config.sequential) {
    console.log(`[ctf] Sequential mode: ${config.agentCount} agents, drain between each\n`)
    for (let i = 0; i < agents.length; i++) {
      const result = await runOneAgent(agents[i])
      agentResults.push(result)

      // Drain between agents so next one sees contributions
      if (i < agents.length - 1) {
        console.log(`\n[ctf] Draining extraction before agent ${i + 2}...`)
        await drainExtraction(apiBaseUrl)
      }
    }
  } else {
    console.log(`[ctf] Launching ${config.agentCount} agent(s) concurrently...\n`)
    const results = await Promise.all(agents.map(a => runOneAgent(a)))
    agentResults.push(...results)
  }

  const totalFlags = agentResults.reduce((s, r) => s + r.flagsCaptured.length, 0)
  const waveTotalPoints = agentResults.reduce((s, r) => s + r.points, 0)
  await broadcastEvent(targetUrl, {
    type: 'wave_finished',
    wave: 1,
    label: waveLabel,
    totalFlags,
    totalPoints: waveTotalPoints,
    timestamp: new Date().toISOString(),
  })

  // Snapshot graph state after run
  const postSnapshot = await snapshotGraph(apiBaseUrl, apiKey)

  // Print summary
  console.log(`\n========================================`)
  console.log(`  Results — Run ${runId.slice(0, 8)}`)
  console.log(`========================================`)

  for (const result of agentResults) {
    console.log(`\n  Agent: ${result.handle}`)
    console.log(`    Flags:       ${result.flagsCaptured.length}/${challenges.length}`)
    console.log(`    Points:      ${result.points}`)
    console.log(`    Tokens:      ${(result.totalTokensInput + result.totalTokensOutput).toLocaleString()}`)
    console.log(`    Tool calls:  ${result.toolCalls} (${result.graphToolCalls} graph, ${result.graphHits} hits)`)
    console.log(`    Contributes: ${result.contributeCalls}`)
    console.log(`    Time/1st:    ${result.timeToFirstFlagMs ? `${(result.timeToFirstFlagMs / 1000).toFixed(1)}s` : 'N/A'}`)
    console.log(`    Status:      ${result.status}`)
    if (result.errors.length) {
      console.log(`    Errors:      ${result.errors.length}`)
    }
  }

  console.log(`\n  Total:     ${totalFlags} flags, ${waveTotalPoints} pts`)
  console.log(`  Graph:     +${postSnapshot.nodeCount - preSnapshot.nodeCount} nodes, +${postSnapshot.edgeCount - preSnapshot.edgeCount} edges`)
  console.log(`  Run ID:    ${runId}`)
  console.log(`========================================\n`)

  // Save results
  const runResult: RunResult = {
    runId,
    config: { ...config, mazeSeed },
    agents: agentResults,
    graphDelta: {
      nodesAdded: postSnapshot.nodeCount - preSnapshot.nodeCount,
      edgesAdded: postSnapshot.edgeCount - preSnapshot.edgeCount,
    },
    startedAt,
    completedAt: new Date().toISOString(),
  }
  saveResult(runResult)

  // Cleanup
  if (mazeProcess) {
    mazeProcess.kill()
    console.log('[ctf] Maze server stopped')
  }
}

main().catch((err) => {
  console.error('[ctf] Benchmark failed:', err)
  process.exit(1)
})
