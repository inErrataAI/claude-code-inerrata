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
    } catch { /* skip bad files */ }
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
  } catch { /* file not ready */ }
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
  model: 'opus' | 'haiku'
  solveRate: number
  warmSolveRate: number
  speed: number // ms between tool calls (base)
  startDelay: number // ms delay before starting
}

const SIM_TOOLS = [
  'http_request', 'curl', 'read_file', 'analyze_response', 'jq_extract',
  'sql_inject', 'jwt_forge', 'path_traverse', 'decode_base64', 'http_request',
  'curl', 'read_file', 'http_request', 'analyze_response', 'curl',
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
  // Import procedural engine for real challenge generation
  const { generateMaze, createRng } = await import('../server/procedural.js')

  const seed = 'demo-sim'
  const rng = createRng(seed + '-sim-engine')
  const maze = generateMaze(seed)

  // Extract challenge metadata (we don't need the route handlers)
  const challenges: SimChallenge[] = maze.challenges.map(c => ({
    id: c.id,
    name: c.name,
    difficulty: c.difficulty,
    points: c.points,
    category: c.category,
  }))

  const AGENTS: SimAgent[] = [
    { id: 'opus-prime',  handle: 'opus-prime',  model: 'opus',  solveRate: 0.72, warmSolveRate: 0.72, speed: 300,  startDelay: 0 },
    { id: 'haiku-swift', handle: 'haiku-swift', model: 'haiku', solveRate: 0.42, warmSolveRate: 0.67, speed: 220,  startDelay: 400 },
    { id: 'haiku-echo',  handle: 'haiku-echo',  model: 'haiku', solveRate: 0.40, warmSolveRate: 0.65, speed: 260,  startDelay: 800 },
    { id: 'haiku-nova',  handle: 'haiku-nova',  model: 'haiku', solveRate: 0.38, warmSolveRate: 0.64, speed: 240,  startDelay: 1200 },
    { id: 'haiku-zen',   handle: 'haiku-zen',   model: 'haiku', solveRate: 0.43, warmSolveRate: 0.68, speed: 280,  startDelay: 1600 },
  ]

  const WAVE_CONFIG = [
    { label: 'OPUS COLD',  mode: 'cold', model: 'opus',  agents: ['opus-prime'], durationSec: 25 },
    { label: 'HAIKU COLD', mode: 'cold', model: 'haiku', agents: ['haiku-swift', 'haiku-echo', 'haiku-nova', 'haiku-zen'], durationSec: 25 },
    { label: 'HAIKU WARM', mode: 'warm', model: 'haiku', agents: ['haiku-swift', 'haiku-echo', 'haiku-nova', 'haiku-zen'], durationSec: 30 },
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
          model: wave.model === 'opus' ? 'claude-opus-4' : 'claude-haiku-3',
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
          const agentRng = createRng(seed + `-${agent.id}-wave${waveNum}`)
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
                  setTimeout(() => {
                    throttled = false
                    if (agentState.status === 'throttled') agentState.status = 'running'
                  }, 1000 + Math.random() * 2000)
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
        priorResults.push({
          runId: state.runId,
          mode: wave.mode,
          model: wave.model === 'opus' ? 'claude-opus-4' : 'claude-haiku-3',
          totalFlags,
          totalPoints,
          agentCount: waveAgentStates.length,
        })

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
  })
})

// Graph endpoint — queries inErrata API or returns empty for cold runs
app.get('/api/graph', async (c) => {
  const apiUrl = process.env.CTF_API_URL ?? 'http://localhost:3100'
  const apiKey = process.env.INERRATA_API_KEY ?? ''

  try {
    const res = await fetch(`${apiUrl}/api/v1/graph/nodes?limit=200`, {
      headers: { 'Authorization': `Bearer ${apiKey}` },
    })
    if (res.ok) {
      return c.json(await res.json())
    }
  } catch { /* API not available */ }

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
<title>MAZE RUNNER -- CTF BENCHMARK</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Press+Start+2P&display=swap" rel="stylesheet">
<style>
  :root {
    --bg: #0a0a0f; --bg2: #0e0e18; --bg3: #12121f;
    --neon: #00ff88; --pink: #e94560; --purple: #9b59b6;
    --gold: #f1c40f; --cyan: #44ddff; --dim: #1a1a3e;
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
    display:flex; align-items:center; gap:8px; padding:6px 8px;
    margin-bottom:4px; background:var(--bg2); border:1px solid var(--dim);
    border-radius:2px; transition: all 0.3s;
  }
  .agent-card.running { border-color: rgba(0,255,136,0.25); }
  .agent-card.throttled { border-color: var(--gold); opacity:0.7; }
  .agent-card.finished { opacity:0.45; border-color:#1a1a28; }
  .agent-card.failed { border-color:var(--pink); opacity:0.6; }

  .agent-sprite { flex-shrink:0; border-radius:2px; image-rendering:pixelated; }
  .sprite-opus { width:32px; height:32px; background:var(--pink); box-shadow:0 0 8px rgba(233,69,96,0.4); }
  .sprite-haiku { width:24px; height:24px; background:var(--neon); box-shadow:0 0 8px rgba(0,255,136,0.4); }

  .agent-info { flex:1; min-width:0; }
  .agent-handle { font-size:8px; color:var(--text); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .agent-action { font-size:7px; color:var(--neon); margin-top:2px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .agent-action.throttled-text { color:var(--gold); }

  .agent-progress { width:60px; height:6px; background:#1a1a2e; border-radius:1px; overflow:hidden; flex-shrink:0; }
  .agent-progress-fill { height:100%; transition:width 0.5s; background:linear-gradient(90deg, var(--neon), var(--gold), var(--pink)); }

  .agent-flags { font-size:9px; color:var(--gold); min-width:28px; text-align:center; white-space:nowrap; }
  .agent-pts { font-size:11px; color:var(--pink); min-width:44px; text-align:right; font-weight:bold; }
  .agent-status-dot { width:6px; height:6px; border-radius:50%; flex-shrink:0; }
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
    border-top:1px solid var(--dim); padding:8px 10px; position:relative;
    min-height:110px; background:var(--bg2);
  }
  .wave-row { display:flex; align-items:center; gap:8px; margin-bottom:6px; font-size:7px; }
  .wave-label { width:110px; flex-shrink:0; text-align:right; color:var(--muted); letter-spacing:1px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .wave-bar-track { flex:1; height:12px; background:#0a0a14; border:1px solid var(--dim); border-radius:1px; overflow:hidden; }
  .wave-bar-fill { height:100%; transition:width 1s ease-out; border-radius:1px; }
  .wave-bar-fill.opus { background: linear-gradient(90deg, #a02040, var(--pink)); }
  .wave-bar-fill.haiku-cold { background: linear-gradient(90deg, #333, #666); }
  .wave-bar-fill.haiku-warm { background: linear-gradient(90deg, #006644, var(--neon)); }
  .wave-bar-fill.current { background: linear-gradient(90deg, #886600, var(--gold)); }
  .wave-stats { width:90px; flex-shrink:0; font-size:7px; color:var(--muted); }
  .wave-tag { font-size:6px; padding:1px 4px; border-radius:1px; margin-left:4px; }
  .tag-ceiling { background:rgba(233,69,96,0.2); color:var(--pink); }
  .tag-floor { background:rgba(100,100,100,0.2); color:#888; }
  .tag-power { background:rgba(0,255,136,0.2); color:var(--neon); }
  #compound-metric { font-size:9px; color:var(--neon); text-align:center; margin-top:6px; letter-spacing:1px; }

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
    <h1 class="glow-pink">MAZE RUNNER</h1>
    <div class="sub">CTF BENCHMARK // inErrata Knowledge Graph</div>
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
    <div class="zone-label">DUNGEON MAP</div>
    <canvas id="graph-canvas"></canvas>
    <div id="empty-msg">
      <div class="title glow-purple">TERRA INCOGNITA</div>
      <div class="hint">The dungeon is shrouded in fog...<br>Cold runs begin with an empty knowledge graph</div>
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

  // Edges as dim corridors
  for (const e of gEdges) {
    ctx.beginPath();
    ctx.moveTo(e.source.x, e.source.y);
    ctx.lineTo(e.target.x, e.target.y);
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
    const grad = ctx.createRadialGradient(n.x, n.y, 0, n.x, n.y, r * 4);
    grad.addColorStop(0, color + (isFlashing ? '44' : '18'));
    grad.addColorStop(1, 'transparent');
    ctx.beginPath(); ctx.arc(n.x, n.y, r * 4, 0, Math.PI * 2);
    ctx.fillStyle = grad; ctx.fill();

    // Core
    ctx.beginPath(); ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
    ctx.fillStyle = color; ctx.fill();

    // Flash ring for new nodes
    if (isFlashing) {
      ctx.beginPath(); ctx.arc(n.x, n.y, r + 4 + flashAge * 0.005, 0, Math.PI * 2);
      const alpha = Math.max(0, 80 - flashAge * 0.04);
      ctx.strokeStyle = color + Math.round(alpha).toString(16).padStart(2, '0');
      ctx.lineWidth = 1.5; ctx.stroke();
    }

    // Labels for smaller graphs
    if (N < 80) {
      ctx.fillStyle = '#444';
      ctx.font = '7px monospace';
      ctx.fillText((n.label || '').slice(0, 18), n.x + r + 4, n.y + 3);
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
    ctx.beginPath(); ctx.arc(pos.x, pos.y, 5, 0, Math.PI * 2);
    ctx.fillStyle = pos.color || '#fff';
    ctx.fill();
    ctx.restore();
  }

  // Legend
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

function renderAgents(agents, totalChallenges) {
  const list = document.getElementById('agents-list');
  list.innerHTML = agents.map((a, i) => {
    const callPct = Math.min(100, Math.round((a.toolCalls / (a.maxCalls || 100)) * 100));
    const isFlash = flashTimers[a.id];
    const isOpus = currentModel.toLowerCase().includes('opus');
    const spriteClass = isOpus ? 'sprite-opus' : 'sprite-haiku';
    const dotClass = 'dot-' + a.status;
    const actionClass = a.status === 'throttled' ? 'agent-action throttled-text' : 'agent-action';
    const actionText = a.status === 'throttled' ? '429 RATE LIMITED' : (a.currentTool || '...');
    const nFlags = a.flags ? a.flags.length : 0;
    const flagStr = nFlags > 0 ? '\\u{1F3F4}'.repeat(Math.min(nFlags, 5)) + (nFlags > 5 ? '+' : '') : '';

    // Track agent dot position on dungeon map
    if (gNodes.length > 0) {
      const tIdx = (i * 7 + a.toolCalls) % gNodes.length;
      const targetNode = gNodes[tIdx];
      if (!agentPositions[a.id]) {
        agentPositions[a.id] = { x: targetNode.x, y: targetNode.y, color: isOpus ? '#e94560' : '#00ff88' };
      }
      const ap = agentPositions[a.id];
      ap.x += (targetNode.x - ap.x) * 0.05;
      ap.y += (targetNode.y - ap.y) * 0.05;
    }

    return '<div class="agent-card ' + a.status + (isFlash ? ' flash' : '') + '">'
      + '<div class="agent-sprite ' + spriteClass + '" title="' + (isOpus ? 'Wizard (Opus)' : 'Rogue (Haiku)') + '"></div>'
      + '<div class="agent-info">'
      + '<div class="agent-handle">Agent ' + (i+1) + ' <span style="color:var(--muted)">(' + (a.handle || a.shortId || a.id).slice(0,10) + ')</span></div>'
      + '<div class="' + actionClass + '">' + actionText + '</div>'
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

  let opusCold = null, haikuCold = null, haikuWarm = null;
  for (const r of (priorResults || [])) {
    const m = (r.model || '').toLowerCase();
    const md = (r.mode || '').toLowerCase();
    if (m.includes('opus') && md.includes('cold')) opusCold = r;
    else if (m.includes('haiku') && md.includes('cold')) haikuCold = r;
    else if (m.includes('haiku') && md.includes('warm')) haikuWarm = r;
  }

  const currentPts = (currentAgents || []).reduce((s, a) => s + (a.points || 0), 0);
  const currentFlags = (currentAgents || []).reduce((s, a) => s + (a.flags ? a.flags.length : 0), 0);

  const allPts = [opusCold ? opusCold.totalPoints : 0, haikuCold ? haikuCold.totalPoints : 0, haikuWarm ? haikuWarm.totalPoints : 0, currentPts].filter(Boolean);
  const maxPts = Math.max(600, Math.max.apply(null, allPts.length ? allPts : [600]));

  function waveBar(label, points, flags, fillClass, tagText, tagClass) {
    const pct = Math.min(100, Math.round((points / maxPts) * 100));
    return '<div class="wave-row">'
      + '<div class="wave-label">' + label + '</div>'
      + '<div class="wave-bar-track"><div class="wave-bar-fill ' + fillClass + '" style="width:' + pct + '%"></div></div>'
      + '<div class="wave-stats">' + points + '/' + maxPts + 'pts'
      + (flags != null ? ' ' + flags + 'f' : '')
      + (tagText ? '<span class="wave-tag ' + tagClass + '">' + tagText + '</span>' : '')
      + '</div></div>';
  }

  let html = '';
  if (opusCold) html += waveBar('WAVE 1: OPUS COLD', opusCold.totalPoints, opusCold.totalFlags, 'opus', 'CEILING', 'tag-ceiling');
  if (haikuCold) html += waveBar('WAVE 2: HAIKU COLD', haikuCold.totalPoints, haikuCold.totalFlags, 'haiku-cold', 'FLOOR', 'tag-floor');
  if (haikuWarm) html += waveBar('WAVE 3: HAIKU WARM', haikuWarm.totalPoints, haikuWarm.totalFlags, 'haiku-warm', 'GRAPH', 'tag-power');
  if (curMode && currentPts > 0) {
    html += waveBar('CURRENT: ' + (curMode + ' ' + curModel).toUpperCase(), currentPts, currentFlags, 'current', 'LIVE', 'tag-ceiling');
  }
  if (!html && !currentPts) {
    html = '<div style="color:var(--muted);text-align:center;padding:10px;font-size:7px;">AWAITING WAVE DATA...</div>';
  }

  container.innerHTML = html;

  if (haikuCold && haikuWarm && haikuCold.totalPoints > 0) {
    const gain = ((haikuWarm.totalPoints - haikuCold.totalPoints) / haikuCold.totalPoints * 100).toFixed(0);
    if (parseInt(gain) > 0) {
      metricEl.innerHTML = '<span class="glow-green">KNOWLEDGE COMPOUNDING: +' + gain + '%</span>';
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

function buildTickerFromState(flags, tools) {
  tickerEvents = [];
  var fl = flags || [];
  for (var i = Math.max(0, fl.length - 25); i < fl.length; i++) {
    var f = fl[i];
    tickerEvents.push({
      type: 'flag',
      text: '<span class="tick-agent">[' + (f.agentId || '').slice(0,6) + ']</span> \\u{1F3F4} CAPTURED ' + (f.challenge || '???') + ' <span class="tick-pts">+' + f.points + 'pts</span>'
    });
  }
  var gt = (tools || []).filter(function(t) { return ['burst','explore','trace','contribute','learn','report_finding'].indexOf(t.tool) >= 0; });
  for (var j = Math.max(0, gt.length - 15); j < gt.length; j++) {
    var t = gt[j];
    var isCont = t.tool === 'contribute';
    tickerEvents.push({
      type: isCont ? 'contribute' : 'query',
      text: '<span class="tick-agent">[' + (t.agentId || '').slice(0,6) + ']</span> ' + (isCont ? '\\u{2728}' : '\\u{1F4E1}') + ' ' + t.tool.toUpperCase()
    });
  }
  renderTicker();
}

// =========================================================================
// SSE connection to maze server
// =========================================================================
let sseConnected = false;
function connectSSE() {
  if (!MAZE_URL) return;
  try {
    const es = new EventSource(MAZE_URL + '/maze/events');
    es.onopen = function() { sseConnected = true; };
    es.addEventListener('flag_captured', function(e) {
      try {
        const d = JSON.parse(e.data);
        screenShake();
        addTickerEvent('flag', '<span class="tick-agent">[' + (d.agentId || '').slice(0,6) + ']</span> \\u{1F3F4} CAPTURED ' + (d.challenge || '???') + ' <span class="tick-pts">+' + (d.points || 0) + 'pts</span>');
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
connectSSE();

// =========================================================================
// Polling
// =========================================================================
let ctfStartTime = null;

async function pollState() {
  try {
    const stateRes = await fetch('/api/state').then(function(r) { return r.json(); });
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
    if (Math.abs(nodes.length - gNodes.length) > 2 || gNodes.length === 0) {
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
