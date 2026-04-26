#!/usr/bin/env tsx
/**
 * CTF Benchmark Live Dashboard Server
 *
 * Serves a real-time visualization of benchmark runs:
 * - Force-directed knowledge graph (canvas)
 * - Agent status cards with progress
 * - Activity timeline
 * - Generational score comparison (Opus baseline vs Haiku warm runs)
 *
 * Usage:
 *   npx tsx dashboard/serve.ts --output <benchmark-output-file> [--port 5555]
 *   npx tsx benchmark/orchestrator.ts 2>&1 | tee output.log & npx tsx dashboard/serve.ts --output output.log
 */
import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { readFileSync, watchFile, statSync, existsSync, readdirSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = typeof import.meta.dirname === 'string'
  ? import.meta.dirname
  : dirname(fileURLToPath(import.meta.url))

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2)
const outputIdx = args.indexOf('--output')
const portIdx = args.indexOf('--port')
const outputFile = outputIdx >= 0 ? args[outputIdx + 1] : null
const port = portIdx >= 0 ? parseInt(args[portIdx + 1], 10) : 5555
const simulateFlag = args.includes('--simulate')
// Auto-simulate when no output file and no piped stdin
const isTTY = process.stdin.isTTY !== false
const simulate = simulateFlag || (!outputFile && isTTY)

const app = new Hono()

// ---------------------------------------------------------------------------
// State parsed from benchmark output
// ---------------------------------------------------------------------------

interface AgentState {
  id: string
  shortId: string
  handle: string
  toolCalls: number
  maxCalls: number
  flags: string[]
  currentTool: string
  status: 'running' | 'finished' | 'failed' | 'throttled'
  errors: number
  graphHits: number
  lastActivity: number
  points: number
}

interface DashState {
  agents: Map<string, AgentState>
  flagTimeline: Array<{ time: number; agentId: string; challenge: string; points: number }>
  toolCallLog: Array<{ time: number; agentId: string; tool: string }>
  startTime: number
  runId: string
  target: string
  mode: string
  model: string
  totalChallenges: number
  seed: string
}

let state: DashState = {
  agents: new Map(),
  flagTimeline: [],
  toolCallLog: [],
  startTime: Date.now(),
  runId: '',
  target: '',
  mode: '',
  model: '',
  totalChallenges: 0,
  seed: '',
}

// Prior run results for generational comparison
let priorResults: Array<{
  runId: string; mode: string; model: string
  totalFlags: number; totalPoints: number; agentCount: number
}> = []

function loadPriorResults() {
  const resultsDir = resolve(__dirname, '..', 'results')
  if (!existsSync(resultsDir)) return

  priorResults = []
  for (const file of readdirSync(resultsDir)) {
    if (!file.endsWith('.json')) continue
    try {
      const data = JSON.parse(readFileSync(resolve(resultsDir, file), 'utf-8'))
      priorResults.push({
        runId: data.runId?.slice(0, 8) ?? file,
        mode: data.config?.mode ?? '?',
        model: data.config?.model ?? '?',
        totalFlags: data.agents?.reduce((s: number, a: any) => s + (a.flagsCaptured?.length ?? 0), 0) ?? 0,
        totalPoints: data.agents?.reduce((s: number, a: any) => s + (a.points ?? 0), 0) ?? 0,
        agentCount: data.agents?.length ?? 0,
      })
    } catch (e) { console.warn('[dashboard] Failed to parse results file:', file, e) }
  }
}
loadPriorResults()

function parseOutputFile(path: string) {
  try {
    const content = readFileSync(path, 'utf-8')
    const lines = content.split('\n')
    const fileBirth = statSync(path).birthtimeMs
    const newState: DashState = {
      agents: new Map(),
      flagTimeline: [],
      toolCallLog: [],
      startTime: fileBirth,
      runId: '', target: '', mode: '', model: '', totalChallenges: 0, seed: '',
    }

    let lineTime = Date.now()

    for (const line of lines) {
      // Parse header fields
      const headerPatterns: Array<[string, keyof DashState]> = [
        ['Target:', 'target'], ['Mode:', 'mode'], ['Model:', 'model'],
        ['Seed:', 'seed'], ['Run ID:', 'runId'],
      ]
      for (const [prefix, key] of headerPatterns) {
        if (line.includes(prefix)) {
          const m = line.match(new RegExp(`${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s+(\\S+)`))
          if (m) (newState as any)[key] = m[1]
        }
      }
      if (line.includes('Challenges:')) {
        const m = line.match(/Challenges:\s+(\d+)/)
        if (m) newState.totalChallenges = parseInt(m[1], 10)
      }

      // Agent launch
      const launchMatch = line.match(/\[ctf:([a-f0-9]+)\] Using/) || line.match(/=== Agent: (ctf-bench-[a-f0-9]+)/)
      if (launchMatch) {
        const id = launchMatch[1]
        const shortId = id.slice(0, 8)
        newState.agents.set(id, {
          id, shortId, handle: id,
          toolCalls: 0, maxCalls: 100, flags: [],
          currentTool: 'starting', status: 'running',
          errors: 0, graphHits: 0, lastActivity: lineTime, points: 0,
        })
      }

      // Tool calls: [ctf:abc12345] [15/100] http_script
      const toolMatch = line.match(/\[ctf:([a-f0-9]+)\] \[(\d+)\/(\d+)\] (\S+)/)
      if (toolMatch) {
        const [, id, calls, max, tool] = toolMatch
        const agent = newState.agents.get(id)
        if (agent) {
          agent.toolCalls = parseInt(calls, 10)
          agent.maxCalls = parseInt(max, 10)
          agent.currentTool = tool.replace('(chained)', '').trim()
          agent.lastActivity = lineTime
          agent.status = 'running'
        }
        newState.toolCallLog.push({ time: lineTime, agentId: id, tool })
      }

      // Flag captures: [ctf:abc12345] Flag captured: challenge-id (+200pts)
      const flagMatch = line.match(/\[ctf:([a-f0-9]+)\] Flag captured: (\S+) \(\+(\d+)pts\)/)
      if (flagMatch) {
        const [, id, challenge, pts] = flagMatch
        const agent = newState.agents.get(id)
        if (agent && !agent.flags.includes(challenge)) {
          agent.flags.push(challenge)
          agent.points += parseInt(pts, 10)
        }
        newState.flagTimeline.push({ time: lineTime, agentId: id, challenge, points: parseInt(pts, 10) })
      }

      // Rate limits
      if (line.includes('rate limited (429)') || line.includes('network error')) {
        for (const agent of newState.agents.values()) {
          if (agent.status === 'running') agent.status = 'throttled'
        }
      }

      // Graph hits
      const graphMatch = line.match(/\[ctf:([a-f0-9]+)\] Extracted (\d+) Solution/)
      if (graphMatch) {
        const agent = newState.agents.get(graphMatch[1])
        if (agent) agent.graphHits++
      }

      // Finished
      const finishMatch = line.match(/\[ctf:([a-f0-9]+)\] Finished/)
      if (finishMatch) {
        const agent = newState.agents.get(finishMatch[1])
        if (agent) { agent.status = 'finished'; agent.currentTool = 'done' }
      }

      // Errors
      if (line.match(/\[ctf:([a-f0-9]+)\].*ERROR/)) {
        const id = line.match(/\[ctf:([a-f0-9]+)\]/)?.[1]
        if (id) {
          const agent = newState.agents.get(id)
          if (agent) agent.errors++
        }
      }

      lineTime += 100
    }

    state = newState
    loadPriorResults() // refresh on each parse
  } catch (e) { console.warn('[dashboard] Error parsing output file:', e) }
}

if (outputFile) {
  const absPath = resolve(outputFile)
  parseOutputFile(absPath)
  watchFile(absPath, { interval: 1000 }, () => parseOutputFile(absPath))
  console.log(`Watching: ${absPath}`)
}

// ---------------------------------------------------------------------------
// Simulation engine (--simulate mode)
// ---------------------------------------------------------------------------

interface SimChallenge {
  id: string
  name: string
  difficulty: string
  points: number
  category: string
}

interface SimAgent {
  id: string
  handle: string
  model: 'opus' | 'sonnet' | 'haiku'
  solveRate: number
  warmSolveRate: number
  speed: number // ms between tool calls (base)
  startDelay: number // ms delay before starting
}

const SIM_TOOLS = [
  'grep_source', 'read_file', 'gcc_compile', 'gdb_inspect', 'cppcheck',
  'find_pattern', 'git_log', 'git_blame', 'analyze_function', 'read_file',
  'grep_source', 'python3_poc', 'objdump', 'strace', 'ltrace',
]

const GRAPH_TOOLS = ['burst', 'explore', 'trace', 'contribute', 'learn', 'report_finding']

// Difficulty -> approximate tool calls needed to solve (tuned for ~90s demo)
const DIFFICULTY_TOOL_COSTS: Record<string, [number, number]> = {
  trivial: [2, 4],
  easy: [4, 8],
  medium: [6, 12],
  hard: [10, 18],
  expert: [15, 25],
}

async function runSimulation() {
  // Inline PRNG — replaces external procedural engine
  class SimRng {
    private state: number;
    constructor(seed: string) {
      this.state = 0;
      for (let i = 0; i < seed.length; i++) {
        this.state = ((this.state << 5) - this.state + seed.charCodeAt(i)) | 0;
      }
      if (this.state === 0) this.state = 1;
    }
    float(): number {
      this.state = (this.state * 1103515245 + 12345) & 0x7fffffff;
      return this.state / 0x7fffffff;
    }
    int(min: number, max: number): number {
      return min + Math.floor(this.float() * (max - min + 1));
    }
    hex(len: number): string {
      let s = '';
      for (let i = 0; i < len; i++) s += Math.floor(this.float() * 16).toString(16);
      return s;
    }
  }

  const seed = 'demo-sim'
  const rng = new SimRng(seed + '-sim-engine')

  // Hardcoded challenges for simulation (GNU security audit theme)
  const challenges: SimChallenge[] = [
    { id: 'gs-pipe-inject', name: 'Ghostscript Pipe Injection', difficulty: 'easy', points: 500, category: 'Command Injection' },
    { id: 'gs-format-str', name: 'Ghostscript Format String', difficulty: 'medium', points: 700, category: 'Format String' },
    { id: 'wget-url-parse', name: 'Wget URL Parsing', difficulty: 'easy', points: 400, category: 'Input Validation' },
    { id: 'wget-chunked-bof', name: 'Wget Chunked Overflow', difficulty: 'medium', points: 700, category: 'Memory Safety' },
    { id: 'tar-v7-heap', name: 'Tar V7 Header Overflow', difficulty: 'medium', points: 600, category: 'Memory Safety' },
    { id: 'tar-path-traversal', name: 'Tar Path Traversal', difficulty: 'easy', points: 500, category: 'Path Traversal' },
    { id: 'binutils-elf-heap', name: 'Binutils ELF Overflow', difficulty: 'medium', points: 600, category: 'Memory Safety' },
    { id: 'binutils-objdump-leak', name: 'Binutils Memory Leak', difficulty: 'easy', points: 400, category: 'Logic Bug' },
    { id: 'bash-shellshock', name: 'Bash Shellshock', difficulty: 'trivial', points: 300, category: 'Command Injection' },
    { id: 'bash-restricted-bypass', name: 'Bash Restricted Bypass', difficulty: 'medium', points: 700, category: 'Logic Bug' },
  ]

  const AGENTS: SimAgent[] = [
    { id: 'opus-wizard',  handle: 'opus-wizard',  model: 'opus' as const,   solveRate: 0.75, warmSolveRate: 0.82, speed: 350, startDelay: 0 },
    { id: 'sonnet-bard',  handle: 'sonnet-bard',  model: 'sonnet' as const, solveRate: 0.58, warmSolveRate: 0.72, speed: 250, startDelay: 200 },
    { id: 'haiku-rogue',  handle: 'haiku-rogue',  model: 'haiku' as const,  solveRate: 0.35, warmSolveRate: 0.60, speed: 180, startDelay: 400 },
  ]

  const WAVE_CONFIG = [
    { label: 'COLD RUN', mode: 'cold', agents: ['opus-wizard', 'sonnet-bard', 'haiku-rogue'], durationSec: 30 },
    { label: 'WARM RUN', mode: 'warm', agents: ['opus-wizard', 'sonnet-bard', 'haiku-rogue'], durationSec: 35 },
  ]

  // Simulation loop (restarts after completing all waves)
  async function simulationLoop() {
    while (true) {
      // Reset prior results for scoreboard
      priorResults = []

      for (let waveIdx = 0; waveIdx < WAVE_CONFIG.length; waveIdx++) {
        const wave = WAVE_CONFIG[waveIdx]
        const waveAgents = AGENTS.filter(a => wave.agents.includes(a.id))
        const isWarm = wave.mode === 'warm'
        const waveNum = waveIdx + 1

        // Reset state for this wave
        state = {
          agents: new Map(),
          flagTimeline: [],
          toolCallLog: [],
          startTime: Date.now(),
          runId: rng.hex(8),
          target: `localhost:4444`,
          mode: wave.mode,
          model: 'opus / sonnet / haiku' + (wave.mode === 'warm' ? ' (+graph)' : ''),
          totalChallenges: challenges.length,
          seed,
        }

        console.log(`[SIM] Wave ${waveNum}: ${wave.label} (${waveAgents.length} agents, ${wave.durationSec}s)`)

        // Initialize agent states with staggered starts
        for (const agent of waveAgents) {
          state.agents.set(agent.id, {
            id: agent.id,
            shortId: agent.id.slice(0, 8),
            handle: agent.handle,
            toolCalls: 0,
            maxCalls: 100,
            flags: [],
            currentTool: 'starting',
            status: 'running',
            errors: 0,
            graphHits: 0,
            lastActivity: Date.now(),
            points: 0,
          })
        }

        // Determine which challenges each agent will solve
        const diffOrder: Record<string, number> = { trivial: 0, easy: 1, medium: 2, hard: 3, expert: 4 }
        const agentTargets = new Map<string, { challenge: SimChallenge; toolCost: number; solved: boolean }[]>()
        for (const agent of waveAgents) {
          const agentRng = new SimRng(seed + `-${agent.id}-wave${waveNum}`)
          const solveRate = isWarm ? agent.warmSolveRate : agent.solveRate
          const targets = challenges.map(ch => {
            const [minCost, maxCost] = DIFFICULTY_TOOL_COSTS[ch.difficulty] || [6, 12]
            const toolCost = agentRng.int(minCost, maxCost)
            const willSolve = agentRng.float() < solveRate
            return { challenge: ch, toolCost, solved: willSolve }
          })
          // Sort roughly by difficulty (easier first) with some jitter for variety
          const jitterMap = new Map(targets.map(t => [t, agentRng.float() * 1.5]))
          targets.sort((a, b) => {
            const da = (diffOrder[a.challenge.difficulty] ?? 2) + (jitterMap.get(a) ?? 0)
            const db = (diffOrder[b.challenge.difficulty] ?? 2) + (jitterMap.get(b) ?? 0)
            return da - db
          })
          agentTargets.set(agent.id, targets)
        }

        // Run the wave as a timed event loop
        const waveStart = Date.now()
        const waveDurationMs = wave.durationSec * 1000

        await new Promise<void>((resolveWave) => {
          // Per-agent simulation tickers
          const agentTimers: ReturnType<typeof setTimeout>[] = []

          for (const agent of waveAgents) {
            const targets = agentTargets.get(agent.id)!
            let targetIdx = 0
            let toolCallsIntoChallenge = 0
            let totalToolCalls = 0
            let throttled = false

            function scheduleNext() {
              const elapsed = Date.now() - waveStart
              if (elapsed >= waveDurationMs || targetIdx >= targets.length) {
                // Agent finished
                const agentState = state.agents.get(agent.id)
                if (agentState) {
                  agentState.status = 'finished'
                  agentState.currentTool = 'done'
                }
                return
              }

              // Randomize timing: base speed +/- 40%
              const jitter = agent.speed * (0.6 + Math.random() * 0.8)
              const delay = throttled ? jitter + 2000 : jitter

              const timer = setTimeout(() => {
                const agentState = state.agents.get(agent.id)
                if (!agentState) return

                const target = targets[targetIdx]
                totalToolCalls++
                toolCallsIntoChallenge++
                agentState.toolCalls = totalToolCalls
                agentState.lastActivity = Date.now()

                // Occasional throttle (2% chance per tick)
                if (!throttled && Math.random() < 0.02) {
                  throttled = true
                  agentState.status = 'throttled'
                  agentState.currentTool = '429 RATE LIMITED'
                  // Recover after 1-3 seconds
                  const recoverTimer = setTimeout(() => {
                    throttled = false
                    if (agentState.status === 'throttled') agentState.status = 'running'
                  }, 1000 + Math.random() * 2000)
                  agentTimers.push(recoverTimer)
                  scheduleNext()
                  return
                }

                if (throttled) {
                  // Still throttled, skip
                  scheduleNext()
                  return
                }

                agentState.status = 'running'

                // Pick a realistic tool name
                const isGraphTool = isWarm && Math.random() < 0.15
                const toolName = isGraphTool
                  ? GRAPH_TOOLS[Math.floor(Math.random() * GRAPH_TOOLS.length)]
                  : SIM_TOOLS[Math.floor(Math.random() * SIM_TOOLS.length)]
                agentState.currentTool = toolName

                // Record tool call
                state.toolCallLog.push({
                  time: Date.now(),
                  agentId: agent.id,
                  tool: toolName,
                })
                // Keep log bounded
                if (state.toolCallLog.length > 500) {
                  state.toolCallLog = state.toolCallLog.slice(-250)
                }

                // Graph hits in warm mode
                if (isWarm && isGraphTool && Math.random() < 0.4) {
                  agentState.graphHits++
                }

                // Check if agent "solves" this challenge
                if (toolCallsIntoChallenge >= target.toolCost) {
                  if (target.solved) {
                    // Flag captured!
                    agentState.flags.push(target.challenge.id)
                    agentState.points += target.challenge.points
                    state.flagTimeline.push({
                      time: Date.now(),
                      agentId: agent.id,
                      challenge: target.challenge.id,
                      points: target.challenge.points,
                    })
                  }
                  // Move to next challenge
                  targetIdx++
                  toolCallsIntoChallenge = 0
                }

                // Occasional error (1% chance)
                if (Math.random() < 0.01) {
                  agentState.errors++
                }

                scheduleNext()
              }, targetIdx === 0 && totalToolCalls === 0 ? agent.startDelay + delay : delay)

              agentTimers.push(timer)
            }

            scheduleNext()
          }

          // End the wave after duration
          setTimeout(() => {
            for (const t of agentTimers) clearTimeout(t)
            // Mark all agents as finished
            for (const agentState of state.agents.values()) {
              if (agentState.status === 'running' || agentState.status === 'throttled') {
                agentState.status = 'finished'
                agentState.currentTool = 'done'
              }
            }
            resolveWave()
          }, waveDurationMs)
        })

        // Record this wave as a "prior result" for the scoreboard
        const waveAgentStates = Array.from(state.agents.values())
        const totalFlags = waveAgentStates.reduce((s, a) => s + a.flags.length, 0)
        const totalPoints = waveAgentStates.reduce((s, a) => s + a.points, 0)
        // Record per-agent results for the scoreboard
        for (const agentState of waveAgentStates) {
          const agentDef = AGENTS.find(a => a.id === agentState.id)
          priorResults.push({
            runId: state.runId,
            mode: wave.mode,
            model: agentDef ? agentDef.model : 'haiku',
            totalFlags: agentState.flags.length,
            totalPoints: agentState.points,
            agentCount: 1,
          })
        }

        console.log(`[SIM] Wave ${waveNum} complete: ${totalFlags} flags, ${totalPoints} pts`)

        // Brief pause between waves to show the transition
        await new Promise(r => setTimeout(r, 3000))
      }

      console.log('[SIM] All waves complete. Restarting in 5 seconds...')
      await new Promise(r => setTimeout(r, 5000))
    }
  }

  // Start simulation in the background
  simulationLoop().catch(err => console.error('[SIM] Error:', err))
}

if (simulate && !outputFile) {
  runSimulation()
  console.log('[SIM] Simulation mode active')
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

app.get('/api/state', (c) => {
  const agents = Array.from(state.agents.values())
  return c.json({
    agents,
    startTime: state.startTime,
    flagTimeline: state.flagTimeline.slice(-50),
    toolCallLog: state.toolCallLog.slice(-100),
    target: state.target,
    mode: state.mode,
    model: state.model,
    seed: state.seed,
    totalChallenges: state.totalChallenges,
    runId: state.runId,
    totalFlags: state.flagTimeline.length,
    uniqueChallenges: [...new Set(state.flagTimeline.map(f => f.challenge))],
    priorResults,
    simulate,
  })
})

// Graph endpoint — queries inErrata API, or returns simulated graph in sim mode

// Seed the simulated graph with domain concepts that grow over time
const SIM_GRAPH_SEED = {
  domains: [
    { id: 'dom-memory', type: 'Domain', label: 'Memory Safety' },
    { id: 'dom-injection', type: 'Domain', label: 'Command Injection' },
    { id: 'dom-parsing', type: 'Domain', label: 'Input Parsing' },
    { id: 'dom-traversal', type: 'Domain', label: 'Path Traversal' },
    { id: 'dom-crypto', type: 'Domain', label: 'Crypto Weakness' },
    { id: 'dom-logic', type: 'Domain', label: 'Logic Bugs' },
    { id: 'dom-shell', type: 'Domain', label: 'Shell Security' },
    { id: 'dom-format', type: 'Domain', label: 'Format Strings' },
  ],
  vulns: [
    { id: 'v-heap-bof', type: 'Vulnerability', label: 'Heap Buffer Overflow', parent: 'dom-memory' },
    { id: 'v-stack-bof', type: 'Vulnerability', label: 'Stack Buffer Overflow', parent: 'dom-memory' },
    { id: 'v-pipe-inject', type: 'Vulnerability', label: 'Pipe Device Injection', parent: 'dom-injection' },
    { id: 'v-env-inject', type: 'Vulnerability', label: 'Environment Injection', parent: 'dom-injection' },
    { id: 'v-url-parse', type: 'Vulnerability', label: 'URL Delimiter Confusion', parent: 'dom-parsing' },
    { id: 'v-header-parse', type: 'Vulnerability', label: 'Archive Header Overflow', parent: 'dom-parsing' },
    { id: 'v-dotdot', type: 'Vulnerability', label: '../ Path Escape', parent: 'dom-traversal' },
    { id: 'v-symlink', type: 'Vulnerability', label: 'Symlink Following', parent: 'dom-traversal' },
    { id: 'v-format-str', type: 'Vulnerability', label: 'Printf Format Vuln', parent: 'dom-format' },
    { id: 'v-restricted-bypass', type: 'Vulnerability', label: 'Restricted Shell Bypass', parent: 'dom-logic' },
  ],
  solutions: [
    { id: 's-bounds-check', type: 'Solution', label: 'Add bounds checking', parent: 'v-heap-bof' },
    { id: 's-sanitize-pipe', type: 'Solution', label: 'Sanitize pipe filenames', parent: 'v-pipe-inject' },
    { id: 's-url-rfc3986', type: 'Solution', label: 'Strict RFC 3986 parsing', parent: 'v-url-parse' },
    { id: 's-strip-dotdot', type: 'Solution', label: 'Strip .. from paths', parent: 'v-dotdot' },
    { id: 's-format-fixed', type: 'Solution', label: 'Use fixed format strings', parent: 'v-format-str' },
    { id: 's-env-sanitize', type: 'Solution', label: 'Sanitize env functions', parent: 'v-env-inject' },
    { id: 's-disable-enable-f', type: 'Solution', label: 'Block enable -f in restricted', parent: 'v-restricted-bypass' },
    { id: 's-header-validate', type: 'Solution', label: 'Validate header lengths', parent: 'v-header-parse' },
  ],
  patterns: [
    { id: 'p-c-string-unsafe', type: 'Pattern', label: 'Unsafe C string handling', parents: ['v-heap-bof', 'v-stack-bof', 'v-format-str'] },
    { id: 'p-input-trust', type: 'Pattern', label: 'Trusting external input', parents: ['v-pipe-inject', 'v-url-parse', 'v-env-inject'] },
    { id: 'p-path-canonicalize', type: 'Pattern', label: 'Missing path canonicalization', parents: ['v-dotdot', 'v-symlink'] },
  ],
}

// Build sim graph progressively based on current wave state
function buildSimGraph() {
  const flags = state.flagTimeline.length
  const mode = state.mode
  const nodes: Array<{ id: string; type: string; label: string }> = []
  const edges: Array<{ source: string; target: string; type: string }> = []

  // Always show domains (discovered as base map)
  const domainCount = Math.min(SIM_GRAPH_SEED.domains.length, 3 + Math.floor(flags / 2))
  for (let i = 0; i < domainCount; i++) {
    nodes.push(SIM_GRAPH_SEED.domains[i])
  }

  // Vulns appear as agents make progress
  const vulnCount = Math.min(SIM_GRAPH_SEED.vulns.length, Math.floor(flags * 1.2))
  for (let i = 0; i < vulnCount; i++) {
    const v = SIM_GRAPH_SEED.vulns[i]
    nodes.push(v)
    if (nodes.find(n => n.id === v.parent)) {
      edges.push({ source: v.parent, target: v.id, type: 'contains' })
    }
  }

  // Solutions appear in warm mode or after many flags
  if (mode === 'warm' || flags > 8) {
    const solCount = Math.min(SIM_GRAPH_SEED.solutions.length, mode === 'warm' ? Math.floor(flags * 0.8) : Math.floor(flags * 0.3))
    for (let i = 0; i < solCount; i++) {
      const s = SIM_GRAPH_SEED.solutions[i]
      nodes.push(s)
      if (nodes.find(n => n.id === s.parent)) {
        edges.push({ source: s.parent, target: s.id, type: 'solved_by' })
      }
    }
  }

  // Patterns emerge in warm mode
  if (mode === 'warm' && flags > 3) {
    const patCount = Math.min(SIM_GRAPH_SEED.patterns.length, Math.floor(flags / 4))
    for (let i = 0; i < patCount; i++) {
      const p = SIM_GRAPH_SEED.patterns[i]
      nodes.push(p)
      for (const pid of p.parents) {
        if (nodes.find(n => n.id === pid)) {
          edges.push({ source: pid, target: p.id, type: 'exemplifies' })
        }
      }
    }
  }

  return { nodes, edges }
}

app.get('/api/graph', async (c) => {
  // In simulation mode, return procedurally growing graph
  if (simulate) {
    return c.json(buildSimGraph())
  }

  const apiUrl = process.env.CTF_API_URL ?? 'http://localhost:3100'
  const apiKey = process.env.INERRATA_API_KEY ?? ''

  try {
    const res = await fetch(`${apiUrl}/api/v1/graph/nodes?limit=200`, {
      headers: { 'Authorization': `Bearer ${apiKey}` },
    })
    if (res.ok) {
      return c.json(await res.json())
    }
  } catch (e) { console.warn('[dashboard] Graph API unavailable:', e) }

  return c.json({ nodes: [], edges: [] })
})

// ---------------------------------------------------------------------------
// Static assets
// ---------------------------------------------------------------------------

app.get('/sprites.js', (c) => {
  const spritePath = resolve(__dirname, 'sprites.js')
  if (!existsSync(spritePath)) return c.text('// sprites.js not found', 404)
  const content = readFileSync(spritePath, 'utf-8')
  c.header('Content-Type', 'application/javascript')
  return c.body(content)
})

// ---------------------------------------------------------------------------
// Main HTML — single-file dashboard
// ---------------------------------------------------------------------------

app.get('/', (c) => {
  return c.html(DASHBOARD_HTML)
})

// ---------------------------------------------------------------------------
// Dashboard HTML
// ---------------------------------------------------------------------------

const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>GNU SECURITY AUDIT -- CTF BENCHMARK</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Press+Start+2P&display=swap" rel="stylesheet">
<style>
  :root {
    --bg: #0a0a0f; --bg2: #0e0e18; --bg3: #12121f;
    --neon: #00ff88; --pink: #e94560; --purple: #9b59b6;
    --gold: #f1c40f; --cyan: #44ddff; --dim: #1a1a3e;
    --blue: #3498db;
    --text: #c8c8d0; --muted: #555568;
    --font: 'Press Start 2P', 'Courier New', monospace;
  }
  * { margin:0; padding:0; box-sizing:border-box; }
  body { background:var(--bg); color:var(--text); font-family:var(--font); overflow:hidden; font-size:10px; }

  /* CRT scanlines + vignette */
  #crt-overlay {
    pointer-events:none; position:fixed; inset:0; z-index:9999;
    background: repeating-linear-gradient(0deg, rgba(0,0,0,0.12) 0px, rgba(0,0,0,0.12) 1px, transparent 1px, transparent 2px);
  }
  #vignette {
    pointer-events:none; position:fixed; inset:0; z-index:9998;
    background: radial-gradient(ellipse at center, transparent 50%, rgba(0,0,0,0.65) 100%);
  }
  body.shake { animation: screenShake 0.15s ease-out; }
  @keyframes screenShake {
    0%,100% { transform:translate(0,0); }
    25% { transform:translate(-2px,1px); }
    50% { transform:translate(2px,-2px); }
    75% { transform:translate(-1px,2px); }
  }

  /* Boot screen */
  #boot-screen {
    position:fixed; inset:0; z-index:10000; background:var(--bg);
    display:flex; align-items:center; justify-content:center; flex-direction:column; gap:16px;
    transition: opacity 0.3s;
  }
  #boot-screen.hide { opacity:0; pointer-events:none; }
  #boot-text { color:var(--neon); font-size:14px; text-shadow:0 0 12px var(--neon); }
  .blink { animation: blinker 0.6s step-end infinite; }
  @keyframes blinker { 50% { opacity:0; } }

  /* Phosphor glow helpers */
  .glow-green { text-shadow:0 0 6px var(--neon), 0 0 12px rgba(0,255,136,0.3); }
  .glow-pink { text-shadow:0 0 6px var(--pink), 0 0 12px rgba(233,69,96,0.3); }
  .glow-gold { text-shadow:0 0 6px var(--gold), 0 0 12px rgba(241,196,15,0.3); }
  .glow-cyan { text-shadow:0 0 6px var(--cyan), 0 0 12px rgba(68,221,255,0.3); }
  .glow-purple { text-shadow:0 0 6px var(--purple), 0 0 12px rgba(155,89,182,0.3); }
  .glow-blue { text-shadow:0 0 6px #3498db, 0 0 12px rgba(52,152,219,0.3); }

  /* Title bar */
  #title-bar {
    background: linear-gradient(180deg, #141420, var(--bg2));
    border-bottom: 2px solid var(--pink);
    padding: 8px 16px; display:flex; align-items:center; gap:16px;
    height: 52px;
  }
  #title-bar h1 { font-size:13px; color:var(--pink); letter-spacing:4px; white-space:nowrap; }
  #title-bar .sub { font-size:7px; color:var(--muted); margin-top:2px; }
  #run-meta { font-size:7px; color:var(--muted); flex:1; text-align:center; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .hdr-stats { display:flex; gap:12px; }
  .hdr-stat { text-align:center; min-width:48px; }
  .hdr-stat .val { font-size:16px; font-weight:bold; }
  .hdr-stat .lbl { font-size:6px; color:var(--muted); text-transform:uppercase; letter-spacing:1px; margin-top:2px; }

  /* Layout grid */
  #layout {
    display:grid;
    grid-template-columns: 1fr 1fr;
    grid-template-rows: 1fr auto;
    height: calc(100vh - 52px);
  }

  /* Dungeon Map zone */
  #dungeon-zone {
    grid-column:1; grid-row:1;
    position:relative; overflow:hidden;
    border-right:1px solid var(--dim); border-bottom:1px solid var(--dim);
  }
  #graph-canvas { width:100%; height:100%; display:block; }
  #empty-msg {
    position:absolute; top:50%; left:50%; transform:translate(-50%,-50%);
    text-align:center; pointer-events:none; display:flex; flex-direction:column; align-items:center;
  }
  #empty-msg .title { font-size:14px; color:var(--muted); letter-spacing:3px; margin-bottom:8px; }
  #empty-msg .hint { font-size:7px; color:#2a2a40; }
  .zone-label {
    position:absolute; top:6px; left:10px; font-size:7px; color:var(--pink);
    letter-spacing:2px; text-transform:uppercase; z-index:5;
    background:rgba(10,10,15,0.85); padding:2px 6px;
  }

  /* Right column */
  #right-col { grid-column:2; grid-row:1; display:flex; flex-direction:column; overflow:hidden; border-bottom:1px solid var(--dim); }

  /* Agent Panel */
  #agents-zone { flex:1; overflow-y:auto; padding:24px 8px 8px; position:relative; }
  #agents-zone::-webkit-scrollbar { width:4px; }
  #agents-zone::-webkit-scrollbar-thumb { background:var(--dim); border-radius:2px; }

  .agent-card {
    display:flex; align-items:center; gap:8px; padding:10px 12px;
    margin-bottom:8px; background:var(--bg2); border:1px solid var(--dim);
    border-radius:2px; transition: all 0.3s;
  }
  .agent-card.running { border-color: rgba(0,255,136,0.25); }
  .agent-card.throttled { border-color: var(--gold); opacity:0.7; }
  .agent-card.finished { opacity:0.45; border-color:#1a1a28; }
  .agent-card.failed { border-color:var(--pink); opacity:0.6; }

  .agent-sprite { flex-shrink:0; border-radius:2px; image-rendering:pixelated; }
  .sprite-opus { width:32px; height:32px; background:var(--pink); box-shadow:0 0 8px rgba(233,69,96,0.4); }
  .sprite-sonnet { width:28px; height:28px; background:#3498db; box-shadow:0 0 8px rgba(52,152,219,0.4); }
  .sprite-haiku { width:24px; height:24px; background:var(--neon); box-shadow:0 0 8px rgba(0,255,136,0.4); }

  .agent-info { flex:1; min-width:0; }
  .agent-handle { font-size:9px; color:var(--text); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .agent-action { font-size:8px; color:var(--neon); margin-top:2px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .agent-stats { font-size:7px; color:var(--muted); margin-top:2px; }
  .agent-action.throttled-text { color:var(--gold); }

  .agent-progress { width:80px; height:8px; background:#1a1a2e; border-radius:1px; overflow:hidden; flex-shrink:0; }
  .agent-progress-fill { height:100%; transition:width 0.5s; background:linear-gradient(90deg, var(--neon), var(--gold), var(--pink)); }

  .agent-flags { font-size:11px; color:var(--gold); min-width:28px; text-align:center; white-space:nowrap; }
  .agent-pts { font-size:13px; color:var(--pink); min-width:44px; text-align:right; font-weight:bold; }
  .agent-status-dot { width:8px; height:8px; border-radius:50%; flex-shrink:0; }
  .dot-running { background:var(--neon); box-shadow:0 0 4px var(--neon); }
  .dot-throttled { background:var(--gold); box-shadow:0 0 4px var(--gold); }
  .dot-finished { background:#555; }
  .dot-failed { background:var(--pink); box-shadow:0 0 4px var(--pink); }

  @keyframes flagCapture {
    0% { border-color:var(--gold); box-shadow:0 0 16px rgba(241,196,15,0.6); }
    100% { border-color:var(--dim); box-shadow:none; }
  }
  .agent-card.flash { animation: flagCapture 1.2s ease-out; }

  /* Scoreboard */
  #scoreboard-zone {
    border-top:1px solid var(--dim); padding:12px 14px; position:relative;
    min-height:160px; background:var(--bg2);
  }
  .wave-row { display:flex; align-items:center; gap:8px; margin-bottom:8px; font-size:8px; }
  .wave-label { width:130px; flex-shrink:0; text-align:right; color:var(--muted); letter-spacing:1px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .wave-bar-track { flex:1; height:16px; background:#0a0a14; border:1px solid var(--dim); border-radius:1px; overflow:hidden; }
  .wave-bar-fill { height:100%; transition:width 1s ease-out; border-radius:1px; }
  .wave-bar-fill.opus { background: linear-gradient(90deg, #a02040, var(--pink)); }
  .wave-bar-fill.sonnet-cold { background: linear-gradient(90deg, #1a5276, #3498db); }
  .wave-bar-fill.sonnet-warm { background: linear-gradient(90deg, #2471a3, #85c1e9); }
  .wave-bar-fill.haiku-cold { background: linear-gradient(90deg, #333, #666); }
  .wave-bar-fill.haiku-warm { background: linear-gradient(90deg, #006644, var(--neon)); }
  .wave-bar-fill.current { background: linear-gradient(90deg, #886600, var(--gold)); }
  .wave-stats { width:100px; flex-shrink:0; font-size:8px; color:var(--muted); }
  .wave-tag { font-size:6px; padding:1px 4px; border-radius:1px; margin-left:4px; }
  .tag-ceiling { background:rgba(233,69,96,0.2); color:var(--pink); }
  .tag-floor { background:rgba(100,100,100,0.2); color:#888; }
  .tag-power { background:rgba(0,255,136,0.2); color:var(--neon); }
  #compound-metric { font-size:11px; color:var(--neon); text-align:center; margin-top:10px; letter-spacing:1px; }

  /* Event Ticker */
  #ticker-zone {
    grid-column: 1 / 3; grid-row:2;
    height:44px; background:var(--bg2); border-top:2px solid var(--dim);
    overflow:hidden; position:relative; display:flex; align-items:center;
  }
  #ticker-label {
    position:absolute; left:8px; top:50%; transform:translateY(-50%);
    font-size:6px; color:var(--pink); letter-spacing:2px; z-index:2;
    background:var(--bg2); padding:2px 6px;
  }
  #ticker-track {
    display:flex; align-items:center; gap:24px;
    white-space:nowrap; padding-left:70px;
    animation: tickerScroll 30s linear infinite;
  }
  @keyframes tickerScroll {
    0% { transform:translateX(0); }
    100% { transform:translateX(-50%); }
  }
  .tick-event { font-size:7px; display:inline-flex; align-items:center; gap:6px; }
  .tick-flag { color:var(--gold); }
  .tick-query { color:var(--purple); }
  .tick-contribute { color:var(--neon); }
  .tick-error { color:var(--pink); }
  .tick-agent { color:var(--cyan); }
  .tick-pts { color:var(--gold); font-weight:bold; }
  .tick-sep { color:var(--dim); }
</style>
</head>
<body>
<script src="/sprites.js"></script>

<!-- CRT overlays -->
<div id="crt-overlay"></div>
<div id="vignette"></div>

<!-- Boot screen -->
<div id="boot-screen">
  <div id="boot-text" class="blink">INSERTING COIN...</div>
</div>

<!-- Title bar -->
<div id="title-bar">
  <div>
    <h1 class="glow-pink">GNU SECURITY AUDIT</h1>
    <div class="sub">CVE Discovery Benchmark // inErrata Knowledge Graph</div>
  </div>
  <div id="run-meta">CONNECTING...</div>
  <div class="hdr-stats">
    <div class="hdr-stat"><div class="val glow-green" id="s-flags">-</div><div class="lbl">FLAGS</div></div>
    <div class="hdr-stat"><div class="val glow-cyan" id="s-unique">-</div><div class="lbl">UNIQUE</div></div>
    <div class="hdr-stat"><div class="val glow-pink" id="s-points">-</div><div class="lbl">POINTS</div></div>
    <div class="hdr-stat"><div class="val" style="color:var(--gold)" id="s-agents">-</div><div class="lbl">ACTIVE</div></div>
    <div class="hdr-stat"><div class="val" style="color:var(--muted)" id="s-timer">--:--</div><div class="lbl">TIME</div></div>
  </div>
</div>

<!-- Main layout -->
<div id="layout">
  <!-- Dungeon Map -->
  <div id="dungeon-zone">
    <div class="zone-label">KNOWLEDGE GRAPH</div>
    <canvas id="graph-canvas"></canvas>
    <div id="empty-msg">
      <div class="title glow-purple">TERRA INCOGNITA</div>
      <div class="hint">The graph is empty...<br>Cold runs begin with no prior knowledge</div>
    </div>
  </div>

  <!-- Right column -->
  <div id="right-col">
    <div id="agents-zone">
      <div class="zone-label">AGENT PANEL</div>
      <div id="agents-list"></div>
    </div>
    <div id="scoreboard-zone">
      <div class="zone-label">SCOREBOARD</div>
      <div id="scoreboard-bars"></div>
      <div id="compound-metric"></div>
    </div>
  </div>

  <!-- Event Ticker -->
  <div id="ticker-zone">
    <div id="ticker-label">EVENT LOG</div>
    <div id="ticker-track"></div>
  </div>
</div>

<script>
// =========================================================================
// Config
// =========================================================================
const MAZE_URL = location.hostname === 'localhost' ? 'http://localhost:4444' : '';

// =========================================================================
// Boot sequence
// =========================================================================
(function boot() {
  const el = document.getElementById('boot-text');
  setTimeout(() => { el.textContent = 'PLAYER 1 READY'; el.classList.remove('blink'); }, 700);
  setTimeout(() => { document.getElementById('boot-screen').classList.add('hide'); }, 1500);
  setTimeout(() => { document.getElementById('boot-screen').style.display = 'none'; }, 1800);
})();

// =========================================================================
// Screen shake
// =========================================================================
function screenShake() {
  document.body.classList.add('shake');
  setTimeout(() => document.body.classList.remove('shake'), 150);
}

// =========================================================================
// Force-directed graph (dungeon map)
// =========================================================================
const canvas = document.getElementById('graph-canvas');
const ctx = canvas.getContext('2d');
let gNodes = [], gEdges = [], agentPositions = {};
let noisePattern = null;

const TYPE_COLORS = {
  Solution: '#00ff88', RootCause: '#ff8800', Domain: '#4488ff',
  Vulnerability: '#ff4444', Pattern: '#aa44ff', Problem: '#e94560',
  ClusterConcept: '#44ddff', Algorithm: '#dddd44', Exploit: '#ff2222',
  Weakness: '#ff6644', Question: '#ffdd44', Answer: '#44ff88',
};

function createNoisePattern() {
  const c = document.createElement('canvas');
  c.width = 128; c.height = 128;
  const x = c.getContext('2d');
  const img = x.createImageData(128, 128);
  for (let i = 0; i < img.data.length; i += 4) {
    const v = Math.random() * 12;
    img.data[i] = v; img.data[i+1] = v; img.data[i+2] = v + 4; img.data[i+3] = 25;
  }
  x.putImageData(img, 0, 0);
  noisePattern = ctx.createPattern(c, 'repeat');
}

function resizeCanvas() {
  const p = document.getElementById('dungeon-zone');
  canvas.width = p.clientWidth; canvas.height = p.clientHeight;
  createNoisePattern();
}
resizeCanvas();
window.addEventListener('resize', resizeCanvas);

let newNodeFlash = {};
function initGraph(nodes, edges) {
  const prevIds = new Set(gNodes.map(n => n.id));
  const cx = canvas.width / 2, cy = canvas.height / 2;
  gNodes = nodes.map(n => ({
    ...n,
    x: cx + (Math.random() - 0.5) * 300,
    y: cy + (Math.random() - 0.5) * 300,
    vx: 0, vy: 0, r: 4 + Math.random() * 2,
  }));
  for (const n of gNodes) {
    if (!prevIds.has(n.id)) newNodeFlash[n.id] = Date.now();
  }
  const map = Object.fromEntries(gNodes.map(n => [n.id, n]));
  gEdges = edges.filter(e => map[e.source] && map[e.target])
    .map(e => ({ source: map[e.source], target: map[e.target], type: e.type }));
  document.getElementById('empty-msg').style.display = gNodes.length ? 'none' : 'flex';
}

function simStep() {
  const cx = canvas.width / 2, cy = canvas.height / 2;
  const N = gNodes.length;
  const repel = Math.min(800, 20000 / (N + 1));
  const attract = N > 50 ? 0.003 : 0.01;
  const damp = N > 50 ? 0.85 : 0.9;
  for (let i = 0; i < N; i++) {
    for (let j = i + 1; j < N; j++) {
      const a = gNodes[i], b = gNodes[j];
      let dx = a.x - b.x, dy = a.y - b.y;
      let d = Math.sqrt(dx*dx + dy*dy) || 1;
      let f = Math.min(repel / (d*d), 5);
      a.vx += dx/d*f; a.vy += dy/d*f;
      b.vx -= dx/d*f; b.vy -= dy/d*f;
    }
  }
  const td = N > 50 ? 40 : 60;
  for (const e of gEdges) {
    let dx = e.target.x - e.source.x, dy = e.target.y - e.source.y;
    let d = Math.sqrt(dx*dx + dy*dy) || 1;
    let f = (d - td) * attract;
    e.source.vx += dx/d*f; e.source.vy += dy/d*f;
    e.target.vx -= dx/d*f; e.target.vy -= dy/d*f;
  }
  for (const n of gNodes) {
    n.vx += (cx - n.x) * 0.002; n.vy += (cy - n.y) * 0.002;
    n.vx *= damp; n.vy *= damp;
    n.vx = Math.max(-3, Math.min(3, n.vx));
    n.vy = Math.max(-3, Math.min(3, n.vy));
    n.x += n.vx; n.y += n.vy;
  }
}

function drawGraph() {
  const w = canvas.width, h = canvas.height;
  ctx.fillStyle = '#0a0a0f';
  ctx.fillRect(0, 0, w, h);
  if (noisePattern) { ctx.fillStyle = noisePattern; ctx.fillRect(0, 0, w, h); }

  const now = Date.now();
  const N = gNodes.length;

  // Compute viewport transform: auto-fit graph bounding box to canvas
  var vpScale = 1, vpTx = 0, vpTy = 0;
  if (N > 1) {
    var minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const n of gNodes) {
      minX = Math.min(minX, n.x); maxX = Math.max(maxX, n.x);
      minY = Math.min(minY, n.y); maxY = Math.max(maxY, n.y);
    }
    const pad = 80;
    const gw = (maxX - minX) || 1;
    const gh = (maxY - minY) || 1;
    vpScale = Math.min((w - pad * 2) / gw, (h - pad * 2) / gh, 4);
    var gcx = (minX + maxX) / 2;
    var gcy = (minY + maxY) / 2;
    vpTx = w / 2 - gcx * vpScale;
    vpTy = h / 2 - gcy * vpScale;
  }
  function sx(x) { return x * vpScale + vpTx; }
  function sy(y) { return y * vpScale + vpTy; }

  // Edges as dim corridors
  for (const e of gEdges) {
    ctx.beginPath();
    ctx.moveTo(sx(e.source.x), sy(e.source.y));
    ctx.lineTo(sx(e.target.x), sy(e.target.y));
    ctx.strokeStyle = 'rgba(40,40,80,0.5)';
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  // Nodes as glowing orbs
  for (const n of gNodes) {
    const color = TYPE_COLORS[n.type] || '#666';
    const flashAge = newNodeFlash[n.id] ? (now - newNodeFlash[n.id]) : 9999;
    const isFlashing = flashAge < 2000;
    const pulse = isFlashing ? 1 + 0.5 * Math.sin(flashAge * 0.01) : 1;
    const r = n.r * pulse;

    // Outer glow
    const grad = ctx.createRadialGradient(sx(n.x), sy(n.y), 0, sx(n.x), sy(n.y), r * 4);
    grad.addColorStop(0, color + (isFlashing ? '44' : '18'));
    grad.addColorStop(1, 'transparent');
    ctx.beginPath(); ctx.arc(sx(n.x), sy(n.y), r * 4, 0, Math.PI * 2);
    ctx.fillStyle = grad; ctx.fill();

    // Core
    ctx.beginPath(); ctx.arc(sx(n.x), sy(n.y), r, 0, Math.PI * 2);
    ctx.fillStyle = color; ctx.fill();

    // Flash ring for new nodes
    if (isFlashing) {
      ctx.beginPath(); ctx.arc(sx(n.x), sy(n.y), r + 4 + flashAge * 0.005, 0, Math.PI * 2);
      const alpha = Math.max(0, 80 - flashAge * 0.04);
      ctx.strokeStyle = color + Math.round(alpha).toString(16).padStart(2, '0');
      ctx.lineWidth = 1.5; ctx.stroke();
    }

    // Labels for smaller graphs
    if (N < 80) {
      ctx.fillStyle = '#444';
      ctx.font = '7px monospace';
      ctx.fillText((n.label || '').slice(0, 18), sx(n.x) + r + 4, sy(n.y) + 3);
    }
  }

  // Clean up old flashes
  for (const id in newNodeFlash) { if (now - newNodeFlash[id] > 3000) delete newNodeFlash[id]; }

  // Agent position dots on the dungeon map
  for (const aid of Object.keys(agentPositions)) {
    const pos = agentPositions[aid];
    if (!pos || !pos.x) continue;
    ctx.save();
    ctx.shadowColor = pos.color || '#fff';
    ctx.shadowBlur = 8;
    ctx.beginPath(); ctx.arc(sx(pos.x), sy(pos.y), 5, 0, Math.PI * 2);
    ctx.fillStyle = pos.color || '#fff';
    ctx.fill();
    ctx.restore();
  }

  // Legend (fixed screen position — not transformed)
  ctx.font = '7px "Press Start 2P", monospace';
  let ly = 28;
  const seen = new Set(gNodes.map(n => n.type));
  for (const [type, color] of Object.entries(TYPE_COLORS)) {
    if (!seen.has(type)) continue;
    ctx.fillStyle = color; ctx.fillRect(10, ly - 4, 6, 6);
    ctx.fillStyle = '#555'; ctx.fillText(type, 20, ly);
    ly += 12;
  }
}

function animate() {
  if (gNodes.length > 0) { for (let i = 0; i < 3; i++) simStep(); }
  drawGraph();
  requestAnimationFrame(animate);
}
animate();

// =========================================================================
// Agent Panel rendering
// =========================================================================
let prevFlagCount = 0;
const flashTimers = {};
let currentModel = '';

// Sprite rendering cache — pre-render to data URLs
const _spriteDataURLCache = {};
let _spriteRenderer = null;
const _spriteCanvas = document.createElement('canvas');
_spriteCanvas.width = 128; _spriteCanvas.height = 128;
const _spriteCtx = _spriteCanvas.getContext('2d');
if (window.SpritesEngine) {
  _spriteRenderer = window.SpritesEngine.createSpriteRenderer(_spriteCtx);
}

function getCharType(agent) {
  const h = (agent.handle || agent.id || '').toLowerCase();
  if (h.includes('opus')) return 'opus';
  if (h.includes('sonnet')) return 'sonnet';
  return 'haiku';
}

function getSpriteDataURL(charType, animState, frame) {
  const key = charType + ':' + animState + ':' + frame;
  if (_spriteDataURLCache[key]) return _spriteDataURLCache[key];
  if (!_spriteRenderer) return null;
  const size = charType === 'opus' ? 32 : charType === 'sonnet' ? 28 : 24;
  const scale = charType === 'opus' ? 3 : charType === 'sonnet' ? 3 : 4;
  const dim = size * scale;
  _spriteCanvas.width = dim; _spriteCanvas.height = dim;
  _spriteCtx.clearRect(0, 0, dim, dim);
  _spriteRenderer.draw(charType, animState, frame, 0, 0, scale);
  _spriteDataURLCache[key] = _spriteCanvas.toDataURL();
  return _spriteDataURLCache[key];
}

// Determine sprite state from agent status
function agentSpriteState(a) {
  if (a.status === 'finished') return a.flags && a.flags.length > 0 ? 'victory' : 'defeated';
  if (a.status === 'throttled') return 'defeated';
  if (a.status === 'failed') return 'defeated';
  if (a.currentTool && a.currentTool !== 'starting' && a.currentTool !== '...') return 'attack';
  return 'idle';
}

let _spriteAnimFrame = 0;
setInterval(function() { _spriteAnimFrame = (_spriteAnimFrame + 1) % 2; }, 400);

function renderAgents(agents, totalChallenges) {
  const list = document.getElementById('agents-list');
  list.innerHTML = agents.map((a, i) => {
    const callPct = Math.min(100, Math.round((a.toolCalls / (a.maxCalls || 100)) * 100));
    const isFlash = flashTimers[a.id];
    const charType = getCharType(a);
    const animState = agentSpriteState(a);
    const spriteURL = getSpriteDataURL(charType, animState, _spriteAnimFrame);
    const dotClass = 'dot-' + a.status;
    const actionClass = a.status === 'throttled' ? 'agent-action throttled-text' : 'agent-action';
    const actionText = a.status === 'throttled' ? '429 RATE LIMITED' : (a.currentTool || '...');
    const nFlags = a.flags ? a.flags.length : 0;
    const flagStr = nFlags > 0 ? '\\u{1F3F4}'.repeat(Math.min(nFlags, 5)) + (nFlags > 5 ? '+' : '') : '';

    const spriteSize = charType === 'opus' ? 48 : charType === 'sonnet' ? 42 : 40;
    const spriteTitle = charType === 'opus' ? 'Wizard (Opus)' : charType === 'sonnet' ? 'Bard (Sonnet)' : 'Rogue (Haiku)';
    const spriteClass = 'sprite-' + charType;
    const dotColor = charType === 'opus' ? '#e94560' : charType === 'sonnet' ? '#3498db' : '#00ff88';

    // Track agent dot position on dungeon map
    if (gNodes.length > 0) {
      const tIdx = (i * 7 + a.toolCalls) % gNodes.length;
      const targetNode = gNodes[tIdx];
      if (!agentPositions[a.id]) {
        agentPositions[a.id] = { x: targetNode.x, y: targetNode.y, color: dotColor };
      }
      const ap = agentPositions[a.id];
      ap.x += (targetNode.x - ap.x) * 0.05;
      ap.y += (targetNode.y - ap.y) * 0.05;
    }

    const spriteHTML = spriteURL
      ? '<img class="agent-sprite" src="' + spriteURL + '" style="width:' + spriteSize + 'px;height:' + spriteSize + 'px;image-rendering:pixelated;" title="' + spriteTitle + '">'
      : '<div class="agent-sprite ' + spriteClass + '" title="' + spriteTitle + '"></div>';

    return '<div class="agent-card ' + a.status + (isFlash ? ' flash' : '') + '">'
      + spriteHTML
      + '<div class="agent-info">'
      + '<div class="agent-handle">Agent ' + (i+1) + ' <span style="color:var(--muted)">(' + (a.handle || a.shortId || a.id).slice(0,10) + ')</span></div>'
      + '<div class="' + actionClass + '">' + actionText + '</div>'
      + '<div class="agent-stats">' + a.toolCalls + ' calls'
      + (a.graphHits > 0 ? ' / ' + a.graphHits + ' graph' : '')
      + (a.errors > 0 ? ' / <span style="color:var(--pink)">' + a.errors + ' err</span>' : '')
      + '</div>'
      + '</div>'
      + '<div class="agent-progress"><div class="agent-progress-fill" style="width:' + callPct + '%"></div></div>'
      + '<div class="agent-flags">' + flagStr + ' ' + nFlags + '</div>'
      + '<div class="agent-pts glow-pink">' + (a.points || 0) + '</div>'
      + '<div class="agent-status-dot ' + dotClass + '"></div>'
      + '</div>';
  }).join('');
}

// =========================================================================
// Scoreboard rendering
// =========================================================================
function renderScoreboard(priorResults, currentAgents, curMode, curModel) {
  const container = document.getElementById('scoreboard-bars');
  const metricEl = document.getElementById('compound-metric');

  // Collect per-agent-per-wave data
  var byKey = {};
  for (const r of (priorResults || [])) {
    const m = (r.model || '').toLowerCase();
    const md = (r.mode || '').toLowerCase();
    var agent = m.includes('opus') ? 'opus' : m.includes('sonnet') ? 'sonnet' : 'haiku';
    var wave = md.includes('warm') ? 'warm' : 'cold';
    var key = wave + ':' + agent;
    if (!byKey[key]) byKey[key] = { totalPoints: 0, totalFlags: 0 };
    byKey[key].totalPoints += r.totalPoints;
    byKey[key].totalFlags += r.totalFlags;
  }

  var allPts = Object.keys(byKey).map(function(k) { return byKey[k].totalPoints; }).filter(Boolean);
  var maxPts = Math.max(600, Math.max.apply(null, allPts.length ? allPts : [600]));

  function waveBar(label, points, flags, fillClass, tagText, tagClass) {
    var pct = Math.min(100, Math.round((points / maxPts) * 100));
    return '<div class="wave-row">'
      + '<div class="wave-label">' + label + '</div>'
      + '<div class="wave-bar-track"><div class="wave-bar-fill ' + fillClass + '" style="width:' + pct + '%"></div></div>'
      + '<div class="wave-stats">' + points + 'pts'
      + (flags != null ? ' ' + flags + 'f' : '')
      + (tagText ? '<span class="wave-tag ' + tagClass + '">' + tagText + '</span>' : '')
      + '</div></div>';
  }

  var html = '';
  var rows = [
    { key: 'cold:opus',   label: 'COLD: OPUS',   fill: 'opus',        tag: '', tagC: '' },
    { key: 'cold:sonnet', label: 'COLD: SONNET', fill: 'sonnet-cold', tag: '', tagC: '' },
    { key: 'cold:haiku',  label: 'COLD: HAIKU',  fill: 'haiku-cold',  tag: '', tagC: '' },
    { key: 'warm:opus',   label: 'WARM: OPUS',   fill: 'opus',        tag: '+GRAPH', tagC: 'tag-power' },
    { key: 'warm:sonnet', label: 'WARM: SONNET', fill: 'sonnet-warm', tag: '+GRAPH', tagC: 'tag-power' },
    { key: 'warm:haiku',  label: 'WARM: HAIKU',  fill: 'haiku-warm',  tag: '+GRAPH', tagC: 'tag-power' },
  ];
  for (var ri = 0; ri < rows.length; ri++) {
    var row = rows[ri];
    var d = byKey[row.key];
    if (d) html += waveBar(row.label, d.totalPoints, d.totalFlags, row.fill, row.tag, row.tagC);
  }

  if (!html) {
    html = '<div style="color:var(--muted);text-align:center;padding:10px;font-size:7px;">AWAITING WAVE DATA...</div>';
  }
  container.innerHTML = html;

  // Knowledge compounding: average improvement cold->warm across all 3 agents
  var gains = [];
  var agentTypes = ['opus', 'sonnet', 'haiku'];
  for (var ai = 0; ai < agentTypes.length; ai++) {
    var coldD = byKey['cold:' + agentTypes[ai]];
    var warmD = byKey['warm:' + agentTypes[ai]];
    if (coldD && warmD && coldD.totalPoints > 0) {
      gains.push((warmD.totalPoints - coldD.totalPoints) / coldD.totalPoints);
    }
  }
  if (gains.length > 0) {
    var avgGain = gains.reduce(function(s, g) { return s + g; }, 0) / gains.length;
    var pctGain = (avgGain * 100).toFixed(0);
    if (parseInt(pctGain) > 0) {
      metricEl.innerHTML = '<span class="glow-green">KNOWLEDGE COMPOUNDING: +' + pctGain + '% avg across ' + gains.length + ' agents</span>';
    } else { metricEl.textContent = ''; }
  } else { metricEl.textContent = ''; }
}

// =========================================================================
// Event Ticker
// =========================================================================
let tickerEvents = [];

function addTickerEvent(type, text) {
  tickerEvents.push({ type: type, text: text });
  if (tickerEvents.length > 60) tickerEvents.shift();
  renderTicker();
}

function renderTicker() {
  const track = document.getElementById('ticker-track');
  const items = tickerEvents.map(function(e) {
    return '<span class="tick-event tick-' + e.type + '">' + e.text + '</span><span class="tick-sep">///</span>';
  }).join('');
  track.innerHTML = items + items;
  track.style.animation = 'none';
  void track.offsetHeight;
  const dur = Math.max(15, tickerEvents.length * 1.5);
  track.style.animation = 'tickerScroll ' + dur + 's linear infinite';
}

function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

function buildTickerFromState(flags, tools) {
  tickerEvents = [];
  var fl = flags || [];
  for (var i = Math.max(0, fl.length - 25); i < fl.length; i++) {
    var f = fl[i];
    tickerEvents.push({
      type: 'flag',
      text: '<span class="tick-agent">[' + esc((f.agentId || '').slice(0,6)) + ']</span> \\u{1F3F4} CAPTURED ' + esc(f.challenge || '???') + ' <span class="tick-pts">+' + f.points + 'pts</span>'
    });
  }
  var gt = (tools || []).filter(function(t) { return ['burst','explore','trace','contribute','learn','report_finding'].indexOf(t.tool) >= 0; });
  for (var j = Math.max(0, gt.length - 15); j < gt.length; j++) {
    var t = gt[j];
    var isCont = t.tool === 'contribute';
    tickerEvents.push({
      type: isCont ? 'contribute' : 'query',
      text: '<span class="tick-agent">[' + esc((t.agentId || '').slice(0,6)) + ']</span> ' + (isCont ? '\\u{2728}' : '\\u{1F4E1}') + ' ' + esc(t.tool).toUpperCase()
    });
  }
  renderTicker();
}

// =========================================================================
// SSE connection to maze server
// =========================================================================
let sseConnected = false;
let isSimulationMode = false; // set from first pollState response
function connectSSE() {
  if (!MAZE_URL || isSimulationMode) return;
  try {
    const es = new EventSource(MAZE_URL + '/maze/events');
    es.onopen = function() { sseConnected = true; };
    es.addEventListener('flag_captured', function(e) {
      try {
        const d = JSON.parse(e.data);
        screenShake();
        addTickerEvent('flag', '<span class="tick-agent">[' + esc((d.agentId || '').slice(0,6)) + ']</span> \\u{1F3F4} CAPTURED ' + esc(d.challenge || '???') + ' <span class="tick-pts">+' + (d.points || 0) + 'pts</span>');
        if (d.agentId) { flashTimers[d.agentId] = true; setTimeout(function() { delete flashTimers[d.agentId]; }, 1500); }
        pollState();
      } catch(err) {}
    });
    es.addEventListener('flag_failed', function(e) {
      try {
        const d = JSON.parse(e.data);
        if (d.agentId) { flashTimers[d.agentId] = 'fail'; setTimeout(function() { delete flashTimers[d.agentId]; }, 800); }
      } catch(err) {}
    });
    // Handle wave lifecycle events and other broadcasts
    es.addEventListener('wave_started', function(e) {
      try {
        const d = JSON.parse(e.data);
        addTickerEvent('contribute', '\\u{1F3AE} WAVE ' + d.wave + ' STARTED: ' + (d.label || '').toUpperCase() + ' (' + d.agentCount + ' AGENTS)');
      } catch(err) {}
    });
    es.addEventListener('wave_finished', function(e) {
      try {
        const d = JSON.parse(e.data);
        addTickerEvent('flag', '\\u{1F3C6} WAVE ' + d.wave + ' COMPLETE: ' + d.totalFlags + ' FLAGS, ' + d.totalPoints + ' PTS');
        pollState();
      } catch(err) {}
    });
    es.addEventListener('agent_started', function(e) {
      try {
        const d = JSON.parse(e.data);
        addTickerEvent('query', '\\u{1F680} AGENT ' + (d.handle || '').slice(0,8) + ' DEPLOYED (' + d.mode + ')');
      } catch(err) {}
    });
    es.addEventListener('agent_finished', function(e) {
      try {
        const d = JSON.parse(e.data);
        const icon = d.flagCount > 0 ? '\\u{2705}' : '\\u{274C}';
        addTickerEvent(d.flagCount > 0 ? 'contribute' : 'error', icon + ' AGENT ' + (d.handle || '').slice(0,8) + ' DONE: ' + d.flagCount + 'f/' + d.points + 'pts [' + d.status + ']');
        pollState();
      } catch(err) {}
    });
    es.onerror = function() { sseConnected = false; es.close(); setTimeout(connectSSE, 5000); };
  } catch(err) { sseConnected = false; }
}
// Defer SSE connection until we know if we're in simulation mode
setTimeout(function() { if (!isSimulationMode) connectSSE(); }, 3000);

// =========================================================================
// Polling
// =========================================================================
let ctfStartTime = null;

async function pollState() {
  try {
    const stateRes = await fetch('/api/state').then(function(r) { return r.json(); });
    if (stateRes.simulate) isSimulationMode = true;
    currentModel = stateRes.model || '';

    document.getElementById('run-meta').textContent =
      (stateRes.target || '?') + ' // ' + (stateRes.mode || '?') + ' // '
      + (stateRes.model || '?') + ' // SEED:' + (stateRes.seed || '?').slice(0,8)
      + ' // ' + (stateRes.runId || '').slice(0,8);

    document.getElementById('s-flags').textContent = stateRes.totalFlags || 0;
    document.getElementById('s-unique').textContent = (stateRes.uniqueChallenges || []).length;
    document.getElementById('s-points').textContent =
      (stateRes.agents || []).reduce(function(s, a) { return s + (a.points || 0); }, 0);
    document.getElementById('s-agents').textContent =
      (stateRes.agents || []).filter(function(a) { return a.status === 'running'; }).length;

    if (stateRes.startTime && !ctfStartTime) ctfStartTime = stateRes.startTime;

    const newTotal = stateRes.totalFlags || 0;
    if (newTotal > prevFlagCount) {
      screenShake();
      const recent = (stateRes.flagTimeline || []).slice(-(newTotal - prevFlagCount));
      for (const f of recent) {
        flashTimers[f.agentId] = true;
        setTimeout(function() { delete flashTimers[f.agentId]; }, 1500);
      }
    }
    prevFlagCount = newTotal;

    renderAgents(stateRes.agents || [], stateRes.totalChallenges || 18);
    renderScoreboard(stateRes.priorResults || [], stateRes.agents || [], stateRes.mode, stateRes.model);
    buildTickerFromState(stateRes.flagTimeline || [], stateRes.toolCallLog || []);
  } catch (e) { console.error('State poll error:', e); }
}

async function pollGraph() {
  try {
    const graphRes = await fetch('/api/graph').then(function(r) { return r.json(); });
    const nodes = graphRes.nodes || [];
    const edges = graphRes.edges || [];
    const currentIds = new Set(gNodes.map(n => n.id));
    const newIds = new Set(nodes.map(n => n.id));
    const idsChanged = nodes.some(n => !currentIds.has(n.id)) || gNodes.some(n => !newIds.has(n.id));
    if (idsChanged || Math.abs(nodes.length - gNodes.length) > 2 || gNodes.length === 0) {
      initGraph(nodes, edges);
    }
  } catch (e) { console.error('Graph poll error:', e); }
}

function updateTimer() {
  if (!ctfStartTime) return;
  const s = Math.floor((Date.now() - ctfStartTime) / 1000);
  document.getElementById('s-timer').textContent =
    Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}

pollState();
pollGraph();
setInterval(pollState, 2000);
setInterval(pollGraph, 5000);
setInterval(updateTimer, 1000);
</script>
</body>
</html>`

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------

serve({ fetch: app.fetch, port }, () => {
  console.log(`Dashboard: http://localhost:${port}`)
  if (outputFile) console.log(`Watching: ${outputFile}`)
  else if (simulate) console.log('Simulation mode: agents running procedurally generated challenges')
  else console.log('No --output file. Pass --output <file> or --simulate for demo mode.')
})
