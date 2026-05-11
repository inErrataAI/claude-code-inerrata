#!/usr/bin/env tsx
/**
 * CTF Cold-To-Warm Demo Live Dashboard Server
 *
 * Serves a real-time visualization of demo runs showing AI agents hunting CVEs
 * in real C source repos.
 *
 * Primary visualization: convergence chart showing how cheap models catch up
 * when given a knowledge graph (warm wave vs cold wave).
 *
 * Usage:
 *   npx tsx dashboard/serve.ts --output <demo-output-file> [--port 5555]
 *   npx tsx dashboard/serve.ts --orchestrator-url http://localhost:4444
 */
import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { readFileSync, existsSync, readdirSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import type {
  AgentState, Wave, DashboardState, FlagEvent,
  GraphNode, GraphEdge, ModelTier, Challenge, ScoredFinding,
} from '../shared/types.js'
import { CHALLENGES } from '../challenges/registry.js'

const __dirname = typeof import.meta.dirname === 'string'
  ? import.meta.dirname
  : dirname(fileURLToPath(import.meta.url))

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2)
function getArg(name: string): string | null {
  const idx = args.indexOf(name)
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : null
}

const port = parseInt(getArg('--port') ?? '5555', 10)
const orchestratorUrl = getArg('--orchestrator-url') // null = same-origin

const app = new Hono()

// ---------------------------------------------------------------------------
// Dashboard state
// ---------------------------------------------------------------------------

let dashState: DashboardState = {
  agents: {},
  challenges: [],
  waves: [],
  currentWave: 0,
  flags: [],
  runId: '',
}

// ---------------------------------------------------------------------------
// Real challenge registry (derived from challenges/registry.ts)
// ---------------------------------------------------------------------------

const REAL_CHALLENGES = CHALLENGES.map(c => ({
  id: c.id,
  cve: c.cve,
  repo: c.repo,
  difficulty: c.difficulty,
  points: c.points,
  bugClass: c.bugClass,
}))

const MAX_POSSIBLE_POINTS = REAL_CHALLENGES.reduce((s, c) => s + c.points, 0)

// ---------------------------------------------------------------------------
// API routes
// ---------------------------------------------------------------------------

app.get('/api/state', async (c) => {
  // Proxy to orchestrator if connected, otherwise return local state
  if (orchestratorUrl) {
    try {
      const res = await fetch(`${orchestratorUrl}/api/state`)
      if (res.ok) return c.json(await res.json())
    } catch (e) { console.warn('[dashboard] Orchestrator state unavailable:', e) }
  }
  return c.json(dashState)
})

app.get('/api/graph', async (c) => {
  const apiUrl = process.env.CTF_API_URL ?? 'http://localhost:3100'
  const apiKey = process.env.INERRATA_API_KEY ?? ''
  try {
    const res = await fetch(`${apiUrl}/api/v1/graph/nodes?limit=200`, {
      headers: { 'Authorization': `Bearer ${apiKey}` },
    })
    if (res.ok) return c.json(await res.json())
  } catch (e) { console.warn('[dashboard] Graph API unavailable:', e) }
  return c.json({ nodes: [], edges: [] })
})

app.get('/sprites.js', (c) => {
  const spritePath = resolve(__dirname, 'sprites.js')
  if (!existsSync(spritePath)) return c.text('// sprites.js not found', 404)
  const content = readFileSync(spritePath, 'utf-8')
  c.header('Content-Type', 'application/javascript')
  return c.body(content)
})

// Static asset routes for the 32rogues and Magic Pack 9 sprite packs.
// Both are dropped under dashboard/assets-* and served read-only as PNGs.
const ASSET_DIRS = {
  '/assets/32rogues/': resolve(__dirname, 'assets-32rogues'),
  '/assets/magic/': resolve(__dirname, 'assets-magicpack'),
}
app.get('/assets/32rogues/*', (c) => {
  const url = new URL(c.req.url)
  const rel = url.pathname.replace('/assets/32rogues/', '')
  const path = resolve(ASSET_DIRS['/assets/32rogues/'], rel)
  if (!existsSync(path)) return c.text('not found', 404)
  const buf = readFileSync(path)
  if (rel.endsWith('.png')) c.header('Content-Type', 'image/png')
  else if (rel.endsWith('.txt')) c.header('Content-Type', 'text/plain')
  return c.body(buf as any)
})
app.get('/assets/magic/*', (c) => {
  const url = new URL(c.req.url)
  const rel = url.pathname.replace('/assets/magic/', '')
  const path = resolve(ASSET_DIRS['/assets/magic/'], rel)
  if (!existsSync(path)) return c.text('not found', 404)
  const buf = readFileSync(path)
  if (rel.endsWith('.png')) c.header('Content-Type', 'image/png')
  return c.body(buf as any)
})

// Background music: serve the rogueworld Pixel music pack (mp3) when
// available. We just stream raw bytes — the browser <audio> tag handles
// decoding. Anything missing returns 404 silently.
const ROGUEWORLD_MUSIC_DIR = 'C:/Users/akoz/rogueworld/assets/audio/music/mp3'
app.get('/assets/music/*', (c) => {
  const url = new URL(c.req.url)
  // Decode %20 etc. — filenames here contain spaces ("Pixel 7.mp3").
  const rel = decodeURIComponent(url.pathname.replace('/assets/music/', ''))
  if (rel.indexOf('..') >= 0 || rel.indexOf('/') >= 0 || rel.indexOf('\\') >= 0) {
    return c.text('not found', 404)
  }
  const path = resolve(ROGUEWORLD_MUSIC_DIR, rel)
  if (!existsSync(path)) return c.text('not found', 404)
  const buf = readFileSync(path)
  c.header('Content-Type', 'audio/mpeg')
  c.header('Accept-Ranges', 'bytes')
  return c.body(buf as any)
})

// Manifest: tell the dashboard which tracks are available so it can pick
// at random without hardcoding filenames in the client.
app.get('/api/music', (c) => {
  if (!existsSync(ROGUEWORLD_MUSIC_DIR)) return c.json({ tracks: [] })
  try {
    const files = readdirSync(ROGUEWORLD_MUSIC_DIR)
      .filter((f) => f.toLowerCase().endsWith('.mp3'))
      .sort()
    return c.json({ tracks: files })
  } catch {
    return c.json({ tracks: [] })
  }
})

app.get('/api/events', async (c) => {
  if (!orchestratorUrl) return c.text('No orchestrator configured', 503)
  try {
    // Disable any internal AbortSignal that ties the fetch to the request's
    // lifetime — we want the upstream stream to live as long as the client
    // is reading. Also set keepalive: false so undici doesn't pool/short-cut
    // this long-running stream.
    const res = await fetch(`${orchestratorUrl}/api/events`, {
      headers: { Accept: 'text/event-stream' },
    })
    if (!res.ok || !res.body) return c.text('Orchestrator SSE unavailable', 502)
    return new Response(res.body, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      },
    })
  } catch (e) {
    console.warn('[dashboard] SSE proxy error:', e)
    return c.text('SSE proxy error', 502)
  }
})

app.get('/health', (c) => {
  return c.json({ status: 'ok', uptime: process.uptime() })
})

app.get('/', (c) => {
  c.header('Cache-Control', 'no-cache, no-store, must-revalidate')
  // Inject the orchestrator URL so the browser can hit SSE directly,
  // bypassing the (fragile) hono ReadableStream proxy.
  const orchestratorJs = orchestratorUrl
    ? `<script>window.ORCHESTRATOR_URL = ${JSON.stringify(orchestratorUrl)};<\/script>`
    : ''
  return c.html(DASHBOARD_HTML.replace('<!--ORCHESTRATOR_URL-->', orchestratorJs))
})

// ---------------------------------------------------------------------------
// Dashboard HTML
// ---------------------------------------------------------------------------

const DASHBOARD_HTML = /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>CTF Cold-To-Warm Demo</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Press+Start+2P&display=swap" rel="stylesheet">
<style>
/* =========================================================================
   ROOT VARIABLES & RESET
   ========================================================================= */
:root {
  --bg: #0a0a0f; --bg2: #0e0e18; --bg3: #12121f;
  --neon: #00ff88; --pink: #e94560; --purple: #9b59b6;
  --gold: #f1c40f; --cyan: #44ddff; --dim: #1a1a3e;
  --blue: #3498db;
  --text: #c8c8d0; --muted: #555568;
  --font: 'Press Start 2P', 'Courier New', monospace;
  --opus-color: #9b59b6;
  --sonnet-color: #3498db;
  --haiku-color: #2ecc71;
}
* { margin:0; padding:0; box-sizing:border-box; }
body {
  background:var(--bg); color:var(--text); font-family:var(--font);
  overflow-x:hidden; overflow-y:auto; font-size:10px;
  /* CRT phosphor look: subtle saturation + soft glow on every text glyph */
  text-shadow: 0 0 1px rgba(0,255,200,0.35), 0 0 2px rgba(0,255,200,0.18);
  filter: contrast(1.04) saturate(1.18);
}
/* Outer wrapper: just hosts the flicker; no curvature filter (that was
   too coarse on a normal display). */
#crt-stage {
  position:relative;
  animation: crt-flicker 7s infinite;
}
@keyframes crt-flicker {
  0%,100% { opacity:1; }
  92% { opacity:1; }
  93% { opacity:0.92; }
  94% { opacity:1; }
  97% { opacity:0.96; }
  98% { opacity:1; }
}

/* =========================================================================
   CRT EFFECTS
   ========================================================================= */
#crt-overlay {
  pointer-events:none; position:fixed; inset:0; z-index:9999;
  /* Denser scanlines + a faint horizontal sweep */
  background:
    repeating-linear-gradient(0deg, rgba(0,0,0,0.18) 0px, rgba(0,0,0,0.18) 1px, transparent 1px, transparent 3px),
    linear-gradient(180deg, rgba(0,255,200,0.02) 0%, transparent 50%, rgba(255,0,140,0.02) 100%);
  mix-blend-mode: multiply;
}
#crt-sweep {
  pointer-events:none; position:fixed; left:0; right:0; height:80px; z-index:9997;
  background: linear-gradient(180deg, transparent, rgba(0,255,200,0.04), transparent);
  animation: crt-sweep 8s linear infinite;
}
@keyframes crt-sweep {
  0%   { top:-80px; }
  100% { top:100vh; }
}
#vignette {
  pointer-events:none; position:fixed; inset:0; z-index:9998;
  /* Soft corner shading — let the SVG curvature do the heavy bevel lifting. */
  background:
    radial-gradient(ellipse at center, transparent 75%, rgba(0,0,0,0.35) 100%);
}
body.shake { animation: screenShake 0.15s ease-out; }
@keyframes screenShake {
  0%,100% { transform:translate(0,0); }
  25% { transform:translate(-2px,1px); }
  50% { transform:translate(2px,-2px); }
  75% { transform:translate(-1px,2px); }
}

/* =========================================================================
   BOOT SCREEN
   ========================================================================= */
#boot-screen {
  position:fixed; inset:0; z-index:10000; background:var(--bg);
  display:flex; align-items:center; justify-content:center; flex-direction:column; gap:16px;
  transition: opacity 0.3s;
}
#boot-screen.hide { opacity:0; pointer-events:none; }
#boot-text { color:var(--neon); font-size:14px; text-shadow:0 0 12px var(--neon); }
.blink { animation: blinker 0.6s step-end infinite; }
@keyframes blinker { 50% { opacity:0; } }

/* =========================================================================
   GLOW HELPERS
   ========================================================================= */
.glow-green { text-shadow:0 0 6px var(--neon), 0 0 12px rgba(0,255,136,0.3); }
.glow-pink { text-shadow:0 0 6px var(--pink), 0 0 12px rgba(233,69,96,0.3); }
.glow-gold { text-shadow:0 0 6px var(--gold), 0 0 12px rgba(241,196,15,0.3); }
.glow-cyan { text-shadow:0 0 6px var(--cyan), 0 0 12px rgba(68,221,255,0.3); }
.glow-purple { text-shadow:0 0 6px var(--purple), 0 0 12px rgba(155,89,182,0.3); }
.glow-blue { text-shadow:0 0 6px var(--blue), 0 0 12px rgba(52,152,219,0.3); }

/* =========================================================================
   TITLE BAR
   ========================================================================= */
#title-bar {
  background: linear-gradient(180deg, #141420, var(--bg2));
  border-bottom: 2px solid var(--pink);
  padding: 8px 16px; display:flex; align-items:center; gap:16px;
  height: 52px;
}
#title-bar h1 { font-size:13px; color:var(--pink); letter-spacing:4px; white-space:nowrap; }
#title-bar .sub { font-size:7px; color:var(--muted); margin-top:2px; }
.hdr-right { display:flex; gap:16px; margin-left:auto; align-items:center; }
.hdr-stat { text-align:center; min-width:48px; }
.hdr-stat .val { font-size:14px; font-weight:bold; }
.hdr-stat .lbl { font-size:6px; color:var(--muted); text-transform:uppercase; letter-spacing:1px; margin-top:2px; }

/* =========================================================================
   MAIN LAYOUT (left main column + right party column)
   ========================================================================= */
#main-content { padding: 8px 12px 12px; }
#upper-dashboard {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 480px;
  gap: 10px;
  width: 100%;
  max-width: 1640px;
  margin-left: auto;
  margin-right: auto;
}
@media (max-width: 1100px) {
  #upper-dashboard { grid-template-columns: minmax(0, 1fr); }
}
#left-col, #right-col { min-width: 0; display: flex; flex-direction: column; }
#right-col { gap: 0; }
#left-col #activity-section, #left-col #ticker-section { width: 100%; }

.section { margin-bottom: 8px; }
.section-header {
  font-size:6px; color:var(--pink); letter-spacing:2px; text-transform:uppercase;
  padding:4px 7px; background:rgba(10,10,15,0.85); border-bottom:1px solid var(--dim);
  margin-bottom:5px; display:flex; align-items:center; gap:8px;
}
.section-header .toggle-btn {
  cursor:pointer; color:var(--muted); font-size:9px; user-select:none;
  transition: transform 0.2s;
}
.section-header .toggle-btn.open { transform: rotate(90deg); }

/* =========================================================================
   CONVERGENCE CHART
   ========================================================================= */
#convergence-section { }
#convergence-canvas {
  width:100%; height:36vh; min-height:240px; max-height:380px;
  display:block; background:var(--bg2); border:1px solid var(--dim); border-radius:2px;
}
#convergence-overlay {
  position:relative; margin-top:-32px; text-align:center; pointer-events:none; z-index:2;
  height:32px;
}
#compound-flash {
  font-size:9px; color:var(--neon); letter-spacing:2px;
  text-shadow:0 0 12px var(--neon), 0 0 24px rgba(0,255,136,0.4);
  opacity:0; transition: opacity 0.5s;
}
#compound-flash.visible { opacity:1; animation: flashPulse 1.5s ease-in-out infinite; }
@keyframes flashPulse {
  0%,100% { opacity:1; }
  50% { opacity:0.5; }
}
#comparison-panel {
  margin-top:5px; display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:5px;
}
.wave-card {
  border:1px solid var(--dim); background:rgba(14,14,24,0.92); padding:6px; min-height:48px;
}
.wave-card .wave-title { font-size:6px; color:var(--cyan); margin-bottom:5px; }
.wave-card .wave-meta { font-size:5px; color:var(--muted); line-height:1.7; }
.wave-card .wave-score { font-size:10px; color:var(--gold); margin-top:3px; }
.auth-badge { color:var(--neon); }
.roi-card { border-color:var(--gold); }

/* =========================================================================
   AGENT CARDS (right column: parties stacked vertically; each party = horizontal row)
   ========================================================================= */
#agents-row { display:flex; flex-direction:column; gap:6px; }
.party-row { display:flex; gap:4px; flex-wrap:nowrap; align-items:stretch; }
.party-row .agent-card {
  flex: 1 1 0; min-width: 0; max-width: none; padding: 5px; min-height:0;
}
.party-row .agent-name { font-size:7px; }
.party-row .agent-model { font-size:5px; }

/* Grayed-out / "dead" finished parties (sorted to bottom) */
.party-container.party-finished { opacity: 0.5; filter: grayscale(0.6) saturate(0.5); }
.party-container.party-finished .party-banner { color: #555 !important; }
.party-container.party-finished .agent-card { background: #0a0a14; }
.party-container.party-finished .rpg-bar-fill.hp { background: #444 !important; box-shadow: none; }
.party-container.party-finished .rpg-bar-fill.mp { background: #444 !important; box-shadow: none; }
.agent-card {
  flex:1 1 210px; max-width:270px; min-width:205px; background:var(--bg2); border:1px solid var(--dim);
  border-radius:2px; padding:8px; transition: all 0.3s; position:relative; overflow:hidden;
}
.agent-card.running { border-color: rgba(0,255,136,0.25); }
.agent-card.throttled { border-color: var(--gold); opacity:0.7; }
.agent-card.finished { border-color:#1a1a28; }
.agent-card.failed { border-color:var(--pink); opacity:0.6; }

@keyframes flagCapture {
  0% { border-color:var(--gold); box-shadow:0 0 20px rgba(241,196,15,0.6); }
  100% { border-color:var(--dim); box-shadow:none; }
}
.agent-card.flash { animation: flagCapture 1.2s ease-out; }

.agent-top { display:flex; align-items:center; gap:8px; margin-bottom:6px; }
.agent-sprite { flex-shrink:0; image-rendering:pixelated; }
.agent-name { font-size:8px; font-weight:bold; }
.agent-model { font-size:6px; color:var(--muted); line-height:1.6; }
.agent-status-dot { width:7px; height:7px; border-radius:50%; margin-left:auto; flex-shrink:0; }
.dot-running { background:var(--neon); box-shadow:0 0 6px var(--neon); }
.dot-throttled { background:var(--gold); box-shadow:0 0 6px var(--gold); }
.dot-finished { background:#555; }
.dot-idle { background:#333; }
.dot-failed { background:var(--pink); box-shadow:0 0 6px var(--pink); }

.agent-scores { display:flex; gap:9px; margin-top:5px; flex-wrap:wrap; }
.agent-score-block { }
.agent-score-label { font-size:5px; color:var(--muted); text-transform:uppercase; letter-spacing:1px; }
.agent-score-val { font-size:11px; font-weight:bold; }
.agent-score-val.pts { color:var(--pink); }
.agent-score-val.flags { color:var(--gold); }
.agent-score-val.improve { color:var(--neon); }
.agent-score-val.graph { color:var(--purple); }

.agent-current { font-size:6px; color:var(--cyan); margin-top:5px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.agent-wave-scores { font-size:6px; color:var(--muted); margin-top:4px; }
.flag-icons { color:var(--gold); font-size:7px; margin-top:4px; }

/* =========================================================================
   RPG BARS + STATS
   ========================================================================= */
.rpg-bars { margin-top:6px; }
.rpg-bar-row {
  display:flex; align-items:center; gap:4px; margin-bottom:3px; font-size:5px;
}
.rpg-bar-label { width:14px; font-weight:bold; letter-spacing:1px; }
.rpg-bar-label.hp { color:#ff5577; text-shadow:0 0 4px rgba(255,85,119,0.5); }
.rpg-bar-label.mp { color:#5599ff; text-shadow:0 0 4px rgba(85,153,255,0.5); }
.rpg-bar-track {
  flex:1; height:8px; background:#0a0a14; border:1px solid #1a1a2e; border-radius:1px;
  overflow:hidden; position:relative;
}
.rpg-bar-fill {
  height:100%; transition: width 0.4s cubic-bezier(0.4,0.0,0.2,1);
}
.rpg-bar-fill.hp { background:linear-gradient(90deg,#ff2244 0%, #ff7799 100%); box-shadow: inset 0 -2px rgba(0,0,0,0.3); }
.rpg-bar-fill.mp { background:linear-gradient(90deg,#3377ee 0%, #66bbff 100%); box-shadow: inset 0 -2px rgba(0,0,0,0.3); }
.rpg-bar-value { width:54px; text-align:right; color:var(--text); font-size:5px; }

.rpg-stats { display:flex; gap:6px; margin-top:4px; font-size:5px; }
.rpg-stat { color:var(--muted); }
.rpg-stat .v { color:var(--gold); font-weight:bold; margin-left:2px; }
.rpg-stat.lv .v { color:#00ff88; }
.rpg-stat.xp .v { color:var(--cyan); }
.rpg-stat.gp .v { color:var(--gold); }

/* Floating damage numbers */
.float-num {
  position:absolute; font-size:9px; font-weight:bold; pointer-events:none;
  animation: floatUp 1.2s ease-out forwards;
  z-index:10; text-shadow:0 0 4px rgba(0,0,0,0.9), 0 0 2px rgba(0,0,0,1);
}
.float-num.dmg { color:#ff5577; }
.float-num.mana { color:#5599ff; }
.float-num.gain { color:var(--gold); }
.float-num.lvl { color:#00ff88; font-size:11px; }
.float-num.spell {
  color:var(--purple); font-size:7px; letter-spacing:1px; text-transform:uppercase;
  background:rgba(0,0,0,0.55); padding:1px 4px; border:1px solid var(--purple);
  border-radius:2px;
}
@keyframes floatUp {
  0%   { opacity:0; transform: translateY(0)    scale(0.6); }
  15%  { opacity:1; transform: translateY(-8px) scale(1.2); }
  100% { opacity:0; transform: translateY(-40px) scale(1.0); }
}

/* Spell-cast pulse on tool-call delta */
@keyframes spellCast {
  0%   { box-shadow: 0 0 0 rgba(85,153,255,0); }
  50%  { box-shadow: 0 0 18px rgba(85,153,255,0.7); }
  100% { box-shadow: 0 0 0 rgba(85,153,255,0); }
}
.agent-card.casting { animation: spellCast 0.6s ease-out; }

/* =========================================================================
   BATTLES (replaces CHALLENGE GRID)
   ========================================================================= */
#battles {
  display:grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap:8px;
}
.battle-card {
  background:var(--bg2); border:1px solid var(--dim); border-radius:2px;
  padding:8px; display:flex; gap:8px; align-items:flex-start;
  position:relative; overflow:hidden;
}
.battle-card.engaging { animation: battlePulse 1.4s ease-in-out infinite; border-color:#c0392b; }
@keyframes battlePulse {
  0%,100% { box-shadow: 0 0 0 rgba(231,76,60,0); }
  50%     { box-shadow: 0 0 10px rgba(231,76,60,0.55); }
}
.battle-monster {
  width:64px; height:64px; flex-shrink:0; image-rendering:pixelated;
  background-image:url(/assets/32rogues/monsters.png);
  background-repeat:no-repeat;
  background-size:768px 832px; /* original 384x416 scaled 2x */
  filter: drop-shadow(0 0 4px rgba(231,76,60,0.45));
}
.battle-info { flex:1; min-width:0; }
.battle-title { font-size:8px; color:var(--cyan); font-weight:bold; letter-spacing:1px; }
.battle-sub { font-size:6px; color:var(--muted); margin-top:3px; }
.battle-stars { font-size:7px; color:var(--gold); margin-top:3px; letter-spacing:1px; }
.battle-hp-row {
  margin-top:6px; display:flex; align-items:center; gap:4px; font-size:5px; color:var(--muted);
}
.battle-hp {
  flex:1; height:6px; background:#0a0a14; border:1px solid #1a1a2e; border-radius:1px;
  overflow:hidden; position:relative;
}
.battle-hp-fill {
  height:100%; background:linear-gradient(90deg, #e74c3c, #f39c12);
  transition:width 0.5s;
}
.battle-attackers {
  display:flex; gap:3px; margin-top:6px; flex-wrap:wrap; align-items:center;
}
.battle-attacker {
  width:20px; height:20px; image-rendering:pixelated; flex-shrink:0;
  border:1px solid var(--dim); border-radius:2px; background:#0a0a14;
}
.battle-empty { color:var(--muted); font-size:7px; padding:6px; }

/* =========================================================================
   LIVE RUN LOG
   ========================================================================= */
#activity-log {
  height:240px; min-height:240px; overflow-y:auto; background:var(--bg2);
  border:1px solid var(--dim); border-radius:2px; padding:8px;
}
#activity-log::-webkit-scrollbar { width:6px; }
#activity-log::-webkit-scrollbar-thumb { background:var(--dim); border-radius:2px; }
.log-empty {
  color:var(--muted); font-size:7px; height:100%; display:flex; align-items:center; justify-content:center;
}
.log-row {
  display:grid; grid-template-columns:58px 74px minmax(0,1fr);
  gap:8px; align-items:start; padding:6px 0; border-bottom:1px solid rgba(26,26,62,0.7);
}
.log-row:last-child { border-bottom:0; }
.log-time { color:var(--muted); font-size:6px; line-height:1.6; }
.log-type {
  font-size:5px; letter-spacing:1px; text-transform:uppercase; padding:3px 4px;
  border:1px solid currentColor; border-radius:2px; text-align:center;
}
.log-message { font-size:7px; line-height:1.7; overflow-wrap:anywhere; }
.log-agent { font-weight:bold; }
.log-type-system { color:var(--muted); }
.log-type-wave { color:var(--cyan); }
.log-type-agent { color:var(--blue); }
.log-type-tool { color:var(--purple); }
.log-type-graph { color:var(--purple); }
.log-type-flag { color:var(--gold); }
.log-type-score { color:var(--neon); }
.log-type-error { color:var(--pink); }
.log-type-setup { color:#d4a85a; font-style: italic; }
.log-type-chat { color:#a8e8ff; }

/* Pixelated chat bubbles above agent cards */
.chat-bubble {
  position:absolute; bottom: calc(100% + 6px); left:50%;
  transform: translateX(-50%);
  background:#fffbe6; color:#1a1a2e;
  border:2px solid #1a1a2e; border-radius:4px;
  padding:5px 7px; font-size:6px; line-height:1.4;
  font-family: 'Press Start 2P', monospace;
  max-width:160px; min-width:60px; white-space:normal;
  z-index:50; pointer-events:none;
  box-shadow: 2px 2px 0 rgba(0,0,0,0.5);
  animation: chatPop 0.25s ease-out;
}
.chat-bubble::before {
  content:''; position:absolute; bottom:-7px; left:50%;
  transform:translateX(-50%);
  width:0; height:0;
  border-left:6px solid transparent;
  border-right:6px solid transparent;
  border-top:7px solid #1a1a2e;
}
.chat-bubble::after {
  content:''; position:absolute; bottom:-4px; left:50%;
  transform:translateX(-50%);
  width:0; height:0;
  border-left:5px solid transparent;
  border-right:5px solid transparent;
  border-top:5px solid #fffbe6;
}
@keyframes chatPop {
  0%   { opacity:0; transform: translateX(-50%) scale(0.6); }
  60%  { opacity:1; transform: translateX(-50%) scale(1.1); }
  100% { opacity:1; transform: translateX(-50%) scale(1); }
}
.chat-bubble.fade {
  animation: chatFade 0.4s ease-in forwards;
}
@keyframes chatFade {
  0%   { opacity:1; }
  100% { opacity:0; transform: translateX(-50%) translateY(-4px); }
}
#log-count { margin-left:auto; color:var(--muted); font-size:5px; letter-spacing:1px; }
@media (max-width: 760px) {
  #convergence-canvas { height:300px; }
  .agent-card { max-width:none; }
  .log-row { grid-template-columns:48px 62px minmax(0,1fr); gap:6px; }
  .log-message { font-size:6px; }
}

/* =========================================================================
   EVENT TICKER
   ========================================================================= */
#ticker-zone {
  height:38px; background:var(--bg2); border:1px solid var(--dim); border-radius:2px;
  overflow:hidden; position:relative; display:flex; align-items:center;
}
#ticker-label {
  position:absolute; left:6px; top:50%; transform:translateY(-50%);
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
<!--ORCHESTRATOR_URL-->
<script src="/sprites.js"><\/script>

<!-- CRT overlays -->
<div id="crt-overlay"></div>
<div id="crt-sweep"></div>
<div id="vignette"></div>
<div id="crt-stage">

<!-- Boot screen -->
<div id="boot-screen">
  <div id="boot-text" class="blink">INSERTING COIN...</div>
</div>

<!-- Title bar -->
<div id="title-bar">
  <div>
    <h1 class="glow-pink">CTF Cold-To-Warm Demo</h1>
    <div class="sub">Cold-to-warm graph access demo // inErrata Knowledge Graph</div>
  </div>
  <div class="hdr-right">
    <div class="hdr-stat"><div class="val glow-cyan" id="s-run">---</div><div class="lbl">RUN</div></div>
    <div class="hdr-stat"><div class="val" style="color:var(--muted)" id="s-timer">--:--</div><div class="lbl">TIME</div></div>
    <div class="hdr-stat"><div class="val glow-gold" id="s-wave">-</div><div class="lbl">WAVE</div></div>
  </div>
</div>

<!-- Main content -->
<div id="main-content">
  <div id="upper-dashboard">

    <!-- LEFT COLUMN: convergence + challenges + live run log + flag tape -->
    <div id="left-col">
      <!-- CONVERGENCE CHART -->
      <div class="section" id="convergence-section">
        <div class="section-header">CONVERGENCE CHART</div>
        <canvas id="convergence-canvas"></canvas>
        <div id="convergence-overlay"><div id="compound-flash">KNOWLEDGE COMPOUNDING</div></div>
        <div id="comparison-panel"></div>
      </div>

      <!-- BATTLES -->
      <div class="section" id="battles-section">
        <div class="section-header">BATTLES</div>
        <div id="battles"></div>
      </div>

      <!-- LIVE RUN LOG -->
      <div class="section" id="activity-section">
        <div class="section-header">
          LIVE RUN LOG
          <span id="log-count">0 EVENTS</span>
        </div>
        <div id="activity-log"><div class="log-empty">WAITING FOR RUN EVENTS</div></div>
      </div>

      <!-- EVENT TICKER -->
      <div class="section" id="ticker-section">
        <div id="ticker-zone">
          <div id="ticker-label">FLAG TAPE</div>
          <div id="ticker-track"></div>
        </div>
      </div>
    </div>

    <!-- RIGHT COLUMN: stacked agent parties -->
    <div id="right-col">
      <div class="section" id="agents-section">
        <div class="section-header">AGENT PARTIES</div>
        <div id="agents-row"></div>
      </div>
    </div>

  </div>
</div>

<script>
// =========================================================================
// Boot sequence
// =========================================================================
(function boot() {
  var el = document.getElementById('boot-text');
  setTimeout(function() { el.textContent = 'PLAYER 1 READY'; el.classList.remove('blink'); }, 700);
  setTimeout(function() { document.getElementById('boot-screen').classList.add('hide'); }, 1500);
  setTimeout(function() { document.getElementById('boot-screen').style.display = 'none'; }, 1800);
})();


// =========================================================================
// Utilities
// =========================================================================
function screenShake() {
  document.body.classList.add('shake');
  setTimeout(function() { document.body.classList.remove('shake'); }, 150);
}
function esc(s) { var d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
function authLabel(auth) {
  if (auth === 'authenticated') return 'KEY AUTH';
  if (auth === 'anonymous') return 'ANON READ';
  return 'NO GRAPH';
}
function waveDisplay(wave) {
  if (!wave) return '-';
  return 'W' + wave.number + ' ' + String(wave.label || wave.mode || '').toUpperCase();
}

// Agent colors — keyed by both sprite id AND model prefix for flexible lookup
var AGENT_COLORS = {
  'opus-wizard':  '#9b59b6',  'opus':  '#9b59b6',
  'sonnet-bard':  '#3498db',  'sonnet':  '#3498db',
  'haiku-rogue':  '#2ecc71',  'haiku':  '#2ecc71',
  'qwen3-14b': '#f1c40f',
};
var AGENT_LABELS = {
  'opus-wizard':  'OPUS',   'opus':  'OPUS',
  'sonnet-bard':  'SONNET', 'sonnet':  'SONNET',
  'haiku-rogue':  'HAIKU',  'haiku':  'HAIKU',
  'qwen3-14b': 'QWEN3 14B',
};
function agentColor(id) {
  if (AGENT_COLORS[id]) return AGENT_COLORS[id];
  if (id.indexOf('opus') >= 0) return '#9b59b6';
  if (id.indexOf('sonnet') >= 0) return '#3498db';
  if (id.indexOf('haiku') >= 0) return '#2ecc71';
  if (id.indexOf('qwen') >= 0) return '#f1c40f';
  return '#888';
}
function agentLabel(id) {
  if (AGENT_LABELS[id]) return AGENT_LABELS[id];
  if (id.indexOf('opus') >= 0) return 'OPUS';
  if (id.indexOf('sonnet') >= 0) return 'SONNET';
  if (id.indexOf('haiku') >= 0) return 'HAIKU';
  if (id.indexOf('qwen3-14b') >= 0) return 'QWEN3 14B';
  if (id.indexOf('qwen') >= 0) return 'QWEN';
  return id.slice(0, 10).toUpperCase();
}

// Canonical model identity per agent (strips vertex "google/" prefix, lowercases).
// We use this to color/label convergence-chart lines by actual model name
// instead of just the abstract tier (opus/sonnet/haiku).
function modelIdentity(agent) {
  if (!agent) return '';
  var raw = String(agent.modelId || agent.model || '').toLowerCase();
  raw = raw.replace(/^google\\//, '').replace(/:/g, '-');
  return raw;
}
// Color by full model identity — same hue family per brand, different tones per tier.
function modelColorByIdentity(ident) {
  ident = String(ident || '').toLowerCase();
  // Claude family — purple / blue / green
  if (ident === 'claude-opus' || ident === 'opus') return '#9b59b6';
  if (ident === 'claude-sonnet' || ident === 'sonnet') return '#3498db';
  if (ident === 'claude-haiku' || ident === 'haiku') return '#2ecc71';
  // GPT-5.4 family — red / orange / yellow
  if (ident.indexOf('gpt-5.4-pro') >= 0 || ident.indexOf('gpt-5-4-pro') >= 0) return '#c0392b';
  if (ident.indexOf('gpt-5.4-mini') >= 0 || ident.indexOf('gpt-5-4-mini') >= 0) return '#e67e22';
  if (ident.indexOf('gpt-5.4-nano') >= 0 || ident.indexOf('gpt-5-4-nano') >= 0) return '#f1c40f';
  // Gemini family — magenta / hot pink / cyan (avoid claude's green territory)
  if (ident.indexOf('gemini-2.5-pro') >= 0) return '#d63384';
  if (ident.indexOf('gemini-2.5-flash-lite') >= 0) return '#00bcd4';
  if (ident.indexOf('gemini-2.5-flash') >= 0) return '#ff4d9d';
  // Local
  if (ident.indexOf('qwen') >= 0) return '#95a5a6';
  return '#888';
}
function modelLabelByIdentity(ident) {
  ident = String(ident || '').toLowerCase();
  if (ident === 'claude-opus' || ident === 'opus') return 'CLAUDE-OPUS';
  if (ident === 'claude-sonnet' || ident === 'sonnet') return 'CLAUDE-SONNET';
  if (ident === 'claude-haiku' || ident === 'haiku') return 'CLAUDE-HAIKU';
  if (ident.indexOf('gpt-5.4-pro') >= 0 || ident.indexOf('gpt-5-4-pro') >= 0) return 'GPT-5.4-PRO';
  if (ident.indexOf('gpt-5.4-mini') >= 0 || ident.indexOf('gpt-5-4-mini') >= 0) return 'GPT-5.4-MINI';
  if (ident.indexOf('gpt-5.4-nano') >= 0 || ident.indexOf('gpt-5-4-nano') >= 0) return 'GPT-5.4-NANO';
  if (ident.indexOf('gemini-2.5-pro') >= 0) return 'GEMINI-2.5-PRO';
  if (ident.indexOf('gemini-2.5-flash-lite') >= 0) return 'GEMINI-2.5-FLASH-LITE';
  if (ident.indexOf('gemini-2.5-flash') >= 0) return 'GEMINI-2.5-FLASH';
  if (ident.indexOf('qwen') >= 0) return 'QWEN3-14B';
  return ident.toUpperCase();
}

function modelColor(model) {
  return agentColor(String(model || ''));
}
function modelLabel(model) {
  return agentLabel(String(model || ''));
}

// =========================================================================
// Live Run Log
// =========================================================================
var runLogEvents = [];
var runLogSeen = {};
var lastAgentSnapshots = {};
var lastToolLogAt = {};

function clockTime(ts) {
  var d = new Date(ts || Date.now());
  return d.toLocaleTimeString([], { hour12:false, hour:'2-digit', minute:'2-digit', second:'2-digit' });
}

function normalizeToolName(tool) {
  return String(tool || 'tool')
    .replace(/^mcp__inerrata__/, '')
    .replace(/^functions__/, '')
    .replace(/^multi_tool_use__/, '');
}

function shouldThrottleLog(key, ms) {
  var now = Date.now();
  if (lastToolLogAt[key] && now - lastToolLogAt[key] < ms) return true;
  lastToolLogAt[key] = now;
  return false;
}

function addRunLogEvent(type, text, agentId, key, ts) {
  var dedupeKey = key || (type + ':' + text);
  if (runLogSeen[dedupeKey]) return;
  runLogSeen[dedupeKey] = true;
  runLogEvents.push({
    type: type || 'system',
    text: text || '',
    agentId: agentId || '',
    ts: ts || Date.now(),
  });
  if (runLogEvents.length > 180) runLogEvents.shift();
  renderRunLog();
}

// Compose "Briar (gpt-5.4-pro cold)" — hero name + deployment id + wave label.
// Looks up the live agent record so we get fresh model + auth values.
function logActorLabel(agentId) {
  var name = prettyHeroName(agentId);
  var stAgents = (lastState && lastState.agents) || {};
  var a = stAgents[agentId];
  if (!a) {
    // Fall back to short id if we don't have the live record yet.
    return name + ' (' + agentLabel(agentId).toLowerCase() + ')';
  }
  var mid = (a.modelId || a.model || '').toLowerCase();
  var wave = (a.waveLabel || a.auth || '').toLowerCase();
  return name + ' (' + mid + ' ' + wave + ')';
}

function renderRunLog() {
  var el = document.getElementById('activity-log');
  if (!el) return;
  var count = document.getElementById('log-count');
  if (count) count.textContent = runLogEvents.length + ' EVENTS';
  if (runLogEvents.length === 0) {
    el.innerHTML = '<div class="log-empty">WAITING FOR RUN EVENTS</div>';
    return;
  }
  var shouldStick = el.scrollTop + el.clientHeight >= el.scrollHeight - 18;
  el.innerHTML = runLogEvents.map(function(e) {
    var color = e.agentId ? agentColor(e.agentId) : '';
    var agent = e.agentId
      ? '<span class="log-agent" style="color:' + color + '">' + esc(logActorLabel(e.agentId)) + '</span> '
      : '';
    return '<div class="log-row">'
      + '<div class="log-time">' + clockTime(e.ts) + '</div>'
      + '<div class="log-type log-type-' + esc(e.type) + '">' + esc(e.type) + '</div>'
      + '<div class="log-message">' + agent + esc(e.text) + '</div>'
      + '</div>';
  }).join('');
  if (shouldStick) el.scrollTop = el.scrollHeight;
}

function syncRunLogFromState(state) {
  var waves = state.waves || [];
  for (var wi = 0; wi < waves.length; wi++) {
    var wave = waves[wi];
    if (wave.startTime) {
      addRunLogEvent(
        'wave',
        'Wave ' + wave.number + ' started: ' + (wave.label || wave.mode || '').toUpperCase() + ' / ' + authLabel(wave.auth || wave.mode),
        '',
        'state-wave-start:' + wave.number + ':' + wave.label,
        wave.startTime
      );
    }
    if (wave.endTime) {
      addRunLogEvent(
        'wave',
        'Wave ' + wave.number + ' finished: ' + (wave.label || wave.mode || '').toUpperCase(),
        '',
        'state-wave-end:' + wave.number + ':' + wave.label,
        wave.endTime
      );
    }
  }

  var flags = state.flags || [];
  for (var fi = Math.max(0, flags.length - 80); fi < flags.length; fi++) {
    var f = flags[fi];
    addRunLogEvent(
      'flag',
      'captured ' + (f.challengeId || 'unknown challenge') + ' for +' + (f.points || 0) + ' points in ' + (f.waveLabel || ('W' + f.wave)),
      f.agentId,
      'state-flag:' + f.agentId + ':' + f.challengeId + ':' + f.timestamp,
      f.timestamp
    );
  }

  var agents = state.agents || {};
  for (var agentId in agents) {
    var a = agents[agentId];
    var prev = lastAgentSnapshots[agentId];
    var challenge = a.currentChallenge || '';
    var repo = a.currentRepo ? ' (' + a.currentRepo + ')' : '';

    if (!prev) {
      addRunLogEvent(
        'agent',
        (a.status || 'idle').toUpperCase() + (challenge ? ' on ' + challenge + repo : ''),
        agentId,
        'state-agent-initial:' + agentId + ':' + (a.status || '') + ':' + challenge,
        Date.now()
      );
    } else {
      if (challenge && challenge !== prev.currentChallenge) {
        addRunLogEvent('agent', 'started audit on ' + challenge + repo, agentId, 'state-agent-challenge:' + agentId + ':' + challenge + ':' + (a.wave || ''), Date.now());
      }
      if ((a.status || '') !== (prev.status || '')) {
        addRunLogEvent('agent', 'status changed to ' + (a.status || 'idle').toUpperCase(), agentId, 'state-agent-status:' + agentId + ':' + (a.status || '') + ':' + Date.now(), Date.now());
      }
      if ((a.totalPoints || 0) > (prev.totalPoints || 0)) {
        addRunLogEvent('score', 'score increased by ' + ((a.totalPoints || 0) - (prev.totalPoints || 0)) + ' points', agentId, 'state-agent-score:' + agentId + ':' + (a.totalPoints || 0), Date.now());
      }
      if ((a.graphHits || 0) > (prev.graphHits || 0)) {
        addRunLogEvent('graph', 'made ' + ((a.graphHits || 0) - (prev.graphHits || 0)) + ' graph call(s)', agentId, 'state-agent-graph:' + agentId + ':' + (a.graphHits || 0), Date.now());
      }
      if ((a.toolCalls || 0) > (prev.toolCalls || 0)) {
        addRunLogEvent('tool', 'reported ' + ((a.toolCalls || 0) - (prev.toolCalls || 0)) + ' new tool event(s)', agentId, 'state-agent-tool:' + agentId + ':' + (a.toolCalls || 0), Date.now());
      }
    }

    lastAgentSnapshots[agentId] = {
      status: a.status || '',
      currentChallenge: challenge,
      totalPoints: a.totalPoints || 0,
      graphHits: a.graphHits || 0,
      toolCalls: a.toolCalls || 0,
    };
  }
}

// =========================================================================
// Convergence Chart (Canvas)
// =========================================================================
var convCanvas = document.getElementById('convergence-canvas');
var convCtx = convCanvas.getContext('2d');
var lastState = null;

function resizeConvCanvas() {
  var rect = convCanvas.getBoundingClientRect();
  convCanvas.width = rect.width * (window.devicePixelRatio || 1);
  convCanvas.height = rect.height * (window.devicePixelRatio || 1);
  convCtx.scale(window.devicePixelRatio || 1, window.devicePixelRatio || 1);
  if (lastState) drawConvergenceChart(lastState);
}
resizeConvCanvas();
window.addEventListener('resize', resizeConvCanvas);

function drawConvergenceChart(state) {
  lastState = state;
  var dpr = window.devicePixelRatio || 1;
  var W = convCanvas.width / dpr;
  var H = convCanvas.height / dpr;

  convCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  convCtx.fillStyle = '#0a0a0f';
  convCtx.fillRect(0, 0, W, H);

  var challenges = state.challenges || [];
  var waves = state.waves || [];
  var agents = state.agents || {};
  var agentIds = Object.keys(agents);
  var numCh = challenges.length || 10;

  // Chart margins -- tighter horizontal, generous vertical
  var ml = 55, mr = 12, mt = 30, mb = 40;
  var cw = W - ml - mr;
  var ch = H - mt - mb;

  // Theoretical Y max (fallback when no data has landed yet)
  var totalPossible = 0;
  for (var ci = 0; ci < challenges.length; ci++) totalPossible += (challenges[ci].points || 0);
  if (totalPossible === 0) totalPossible = 5400;

  // Scan actual achieved endpoints to auto-zoom Y. Y ALWAYS starts at 0 so
  // flatlines stay on the floor instead of slipping below it.
  var _allYEndpoints = [];
  for (var _wi = 0; _wi < waves.length; _wi++) {
    var _wave = waves[_wi];
    for (var _ai = 0; _ai < agentIds.length; _ai++) {
      var _scores = (_wave.scores && _wave.scores[agentIds[_ai]]) || {};
      var _total = 0;
      for (var _ci = 0; _ci < challenges.length; _ci++) {
        _total += _scores[challenges[_ci] ? challenges[_ci].id : ''] || 0;
      }
      if (_total > 0) _allYEndpoints.push(_total);
    }
  }
  var minY = 0;
  var maxY = totalPossible;
  if (_allYEndpoints.length >= 1) {
    var _highY = Math.max.apply(null, _allYEndpoints);
    maxY = Math.ceil(_highY * 1.15);
    if (maxY < 100) maxY = 100;
  }

  // Scan actual tokens-spent endpoints to auto-zoom X.
  var _allXEndpoints = [];
  for (var _wi2 = 0; _wi2 < waves.length; _wi2++) {
    var _wave2 = waves[_wi2];
    var _tokAt = _wave2.tokensAt || {};
    for (var _aid in _tokAt) {
      var _perCh = _tokAt[_aid] || {};
      for (var _chid in _perCh) {
        var _t = _perCh[_chid] || 0;
        if (_t > 0) _allXEndpoints.push(_t);
      }
    }
  }
  // Fall back to agent.tokensUsed for in-progress agents whose first
  // challenge hasn't ended yet (no tokensAt entry recorded yet).
  for (var _aid2 in agents) {
    var _ag = agents[_aid2];
    if (_ag && (_ag.tokensUsed || 0) > 0) _allXEndpoints.push(_ag.tokensUsed);
  }
  var minX = 0;
  var maxX = 1;
  if (_allXEndpoints.length >= 1) {
    maxX = Math.ceil(Math.max.apply(null, _allXEndpoints) * 1.1);
    if (maxX < 1000) maxX = 1000;
  } else {
    // No tokens spent yet -- a sensible default that won't squash to a sliver.
    maxX = 100000;
  }

  function xPos(tokens) { return ml + ((tokens - minX) / (maxX - minX || 1)) * cw; }
  function yPos(pts) { return mt + ch - ((pts - minY) / (maxY - minY)) * ch; }

  // Grid -- 10 horizontal, 10 vertical divisions in token space.
  convCtx.strokeStyle = '#1a1a2e';
  convCtx.lineWidth = 0.5;
  for (var gi = 0; gi <= 10; gi++) {
    var gy = mt + (gi / 10) * ch;
    convCtx.beginPath(); convCtx.moveTo(ml, gy); convCtx.lineTo(ml + cw, gy); convCtx.stroke();
  }
  for (var gxi = 0; gxi <= 10; gxi++) {
    var gx = ml + (gxi / 10) * cw;
    convCtx.beginPath(); convCtx.moveTo(gx, mt); convCtx.lineTo(gx, mt + ch); convCtx.stroke();
  }

  // Axes
  convCtx.strokeStyle = '#333';
  convCtx.lineWidth = 1;
  convCtx.beginPath(); convCtx.moveTo(ml, mt); convCtx.lineTo(ml, mt + ch); convCtx.lineTo(ml + cw, mt + ch); convCtx.stroke();

  // Y axis labels -- 10 divisions, scaled to visible range (always starts at 0).
  convCtx.fillStyle = '#555';
  convCtx.font = '7px "Press Start 2P", monospace';
  convCtx.textAlign = 'right';
  for (var yi = 0; yi <= 10; yi++) {
    var yVal = Math.round(minY + (yi / 10) * (maxY - minY));
    convCtx.fillText(yVal.toString(), ml - 6, yPos(yVal) + 3);
  }

  // X axis labels -- tokens, in k. 5 ticks across the visible range.
  function fmtTokens(n) {
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
    if (n >= 1_000) return Math.round(n / 1_000) + 'k';
    return String(n);
  }
  convCtx.textAlign = 'center';
  convCtx.fillStyle = '#444';
  convCtx.font = '5px "Press Start 2P", monospace';
  for (var xi = 0; xi <= 5; xi++) {
    var xVal = minX + (xi / 5) * (maxX - minX);
    convCtx.save();
    convCtx.translate(ml + (xi / 5) * cw, mt + ch + 8);
    convCtx.fillText(fmtTokens(xVal), 0, 0);
    convCtx.restore();
  }

  // Axis titles
  convCtx.fillStyle = '#555';
  convCtx.font = '7px "Press Start 2P", monospace';
  convCtx.textAlign = 'center';
  convCtx.fillText('TOKENS SPENT', ml + cw / 2, H - 4);
  convCtx.save();
  convCtx.translate(12, mt + ch / 2);
  convCtx.rotate(-Math.PI / 2);
  convCtx.fillText('CUMULATIVE POINTS', 0, 0);
  convCtx.restore();

  // Build (tokens, points) data per wave per agent. Order points by the
  // tokens-at-completion timestamp so the line walks left-to-right through
  // the actual spend trajectory rather than by challenge index.
  var lineData = []; // { agentId, wave, color, dashed, pairs: [{tokens, pts}] }

  for (var wi = 0; wi < waves.length; wi++) {
    var wave = waves[wi];
    var isWarm = wave.auth === 'authenticated' || wave.graphState === 'warm';
    var tokAt = wave.tokensAt || {};

    for (var ai = 0; ai < agentIds.length; ai++) {
      var agentId = agentIds[ai];
      var agent = agents[agentId] || {};
      var ident = modelIdentity(agent) || (agent.model || agentId);
      var color = modelColorByIdentity(ident);
      var agentScores = (wave.scores && wave.scores[agentId]) || {};
      var agentTokAt = tokAt[agentId] || {};
      if (Object.keys(agentScores).length === 0) continue;

      // Build per-challenge records: { tokens, points, chId }
      var perCh = [];
      for (var chi = 0; chi < numCh; chi++) {
        var chId = challenges[chi] ? challenges[chi].id : '';
        if (!chId) continue;
        var tok = agentTokAt[chId];
        if (typeof tok !== 'number') continue;
        perCh.push({ tokens: tok, pts: agentScores[chId] || 0, chId: chId });
      }
      // Sort by token spend (the moment the challenge ended).
      perCh.sort(function(a, b) { return a.tokens - b.tokens; });

      // Cumulative points walking through token-sorted challenges. Start at
      // (0, 0) so the line anchors on the y-axis floor even when the first
      // challenge cost real tokens.
      var pairs = [{ tokens: 0, pts: 0 }];
      var running = 0;
      for (var pi = 0; pi < perCh.length; pi++) {
        running += perCh[pi].pts;
        pairs.push({ tokens: perCh[pi].tokens, pts: running });
      }
      // If the agent is still running this wave (no completions yet, but
      // tokens are being spent), draw a live segment to the current spend.
      if (perCh.length === 0 && (agent.tokensUsed || 0) > 0 && (agent.wave === wave.number || (agent.status === 'running' && wi === waves.length - 1))) {
        pairs.push({ tokens: agent.tokensUsed, pts: 0 });
      }
      lineData.push({
        agentId: agentId,
        wave: wave.number,
        model: ident,
        mode: wave.mode,
        auth: wave.auth || wave.mode,
        color: color,
        dashed: isWarm,
        pairs: pairs,
        finalPts: running,
        label: modelLabelByIdentity(ident),
      });
    }
  }

  // Draw lines
  for (var li = 0; li < lineData.length; li++) {
    var line = lineData[li];
    var pairs = line.pairs;
    if (pairs.length < 2) continue;

    convCtx.save();
    convCtx.strokeStyle = line.color;
    convCtx.lineWidth = line.dashed ? 2.5 : 2;

    if (line.dashed) {
      convCtx.setLineDash([6, 4]);
      convCtx.shadowColor = line.color;
      convCtx.shadowBlur = 6;
    } else {
      convCtx.setLineDash([]);
    }

    convCtx.beginPath();
    convCtx.moveTo(xPos(pairs[0].tokens), yPos(pairs[0].pts));
    for (var si = 1; si < pairs.length; si++) {
      convCtx.lineTo(xPos(pairs[si].tokens), yPos(pairs[si].pts));
    }
    convCtx.stroke();

    // Dots at each (tokens, points) sample, skipping the (0,0) anchor.
    convCtx.shadowBlur = 0;
    convCtx.setLineDash([]);
    for (var di = 1; di < pairs.length; di++) {
      convCtx.beginPath();
      convCtx.arc(xPos(pairs[di].tokens), yPos(pairs[di].pts), 3, 0, Math.PI * 2);
      convCtx.fillStyle = line.color;
      convCtx.fill();
    }
    convCtx.restore();
  }

  // Legend
  convCtx.font = '6px "Press Start 2P", monospace';
  var legendX = ml + 10;
  var legendY = mt + 10;
  for (var lei = 0; lei < lineData.length; lei++) {
    var le = lineData[lei];
    if (!le.pairs || le.pairs.length < 2) continue;
    convCtx.fillStyle = le.color;
    if (le.dashed) {
      convCtx.setLineDash([4, 3]);
      convCtx.strokeStyle = le.color;
      convCtx.lineWidth = 2;
      convCtx.beginPath(); convCtx.moveTo(legendX, legendY - 2); convCtx.lineTo(legendX + 20, legendY - 2); convCtx.stroke();
      convCtx.setLineDash([]);
    } else {
      convCtx.fillRect(legendX, legendY - 5, 20, 3);
    }
    convCtx.fillStyle = '#888';
    convCtx.textAlign = 'left';
    convCtx.fillText(le.label, legendX + 24, legendY);
    legendY += 12;
  }

  // Check for convergence: authenticated Haiku approaching cold Opus.
  var coldOpus = lineData.find(function(l) { return l.model === 'opus' && l.auth === 'none'; });
  var warmHaiku = lineData.find(function(l) { return l.model === 'haiku' && l.auth === 'authenticated'; });
  var compoundEl = document.getElementById('compound-flash');

  if (coldOpus && warmHaiku) {
    var opusFinal = coldOpus.finalPts || 0;
    var haikuFinal = warmHaiku.finalPts || 0;
    if (haikuFinal > 0 && opusFinal > 0 && haikuFinal >= opusFinal * 0.7) {
      var ratio = Math.round((haikuFinal / opusFinal) * 100);
      compoundEl.textContent = 'MODEL EQUALIZATION // HAIKU WARM AT ' + ratio + '% OF OPUS COLD';
      compoundEl.classList.add('visible');
    } else {
      compoundEl.classList.remove('visible');
    }
  } else {
    compoundEl.classList.remove('visible');
  }
  renderComparisonPanel(state, lineData);
}

function renderComparisonPanel(state, lineData) {
  var panel = document.getElementById('comparison-panel');
  if (!panel) return;
  var waves = state.waves || [];
  if (waves.length === 0) { panel.innerHTML = ''; return; }

  var html = '';
  var totals = {};
  for (var i = 0; i < lineData.length; i++) {
    var line = lineData[i];
    totals[line.label] = line.finalPts || 0;
  }

  for (var wi = 0; wi < waves.length; wi++) {
    var wave = waves[wi];
    var score = 0, solved = 0, graph = 0;
    var flags = state.flags || [];
    var scoreMap = wave.scores || {};
    for (var agentId in scoreMap) {
      var perChallenge = scoreMap[agentId] || {};
      for (var chId in perChallenge) {
        score += perChallenge[chId] || 0;
      }
      var a = (state.agents || {})[agentId];
      if (a) graph += a.graphHits || 0;
    }
    for (var fi = 0; fi < flags.length; fi++) {
      if (flags[fi].wave === wave.number) solved++;
    }
    html += '<div class="wave-card">'
      + '<div class="wave-title">' + esc(waveDisplay(wave)) + '</div>'
      + '<div class="wave-meta">MODEL ' + esc(String(wave.model || '').toUpperCase()) + ' / <span class="auth-badge">' + authLabel(wave.auth || wave.mode) + '</span></div>'
      + '<div class="wave-meta">GRAPH CALLS ' + graph + '</div>'
      + '<div class="wave-score">' + solved + ' FLAGS</div>'
      + '<div class="wave-meta">' + score + ' PTS</div>'
      + '</div>';
  }

  var opus = Object.keys(totals).filter(function(k) { return k.indexOf('OPUS-COLD') === 0; }).map(function(k) { return totals[k]; })[0] || 0;
  var haiku = Object.keys(totals).filter(function(k) { return k.indexOf('HAIKU-WARM') === 0; }).map(function(k) { return totals[k]; })[0] || 0;
  if (opus > 0 || haiku > 0) {
    var parity = opus > 0 ? Math.round((haiku / opus) * 100) : 0;
    var savings = Math.round(((60 - 1) / 1) * 100);
    html += '<div class="wave-card roi-card">'
      + '<div class="wave-title">ROI CALCULATOR</div>'
      + '<div class="wave-meta">HAIKU WARM / OPUS COLD</div>'
      + '<div class="wave-score">' + parity + '% PARITY</div>'
      + '<div class="wave-meta">TOKEN COST SAVINGS ~' + savings + '%</div>'
      + '</div>';
  }

  panel.innerHTML = html;
}

// =========================================================================
// Sprite rendering (from sprites.js)
// =========================================================================
var _spriteDataURLCache = {};
var _spriteRenderer = null;
var _spriteCanvas = document.createElement('canvas');
_spriteCanvas.width = 128; _spriteCanvas.height = 128;
var _spriteCtx = _spriteCanvas.getContext('2d');
if (window.SpritesEngine) {
  _spriteRenderer = window.SpritesEngine.createSpriteRenderer(_spriteCtx);
}

function getCharType(agentId) {
  if (agentId.includes('opus')) return 'opus';
  if (agentId.includes('sonnet')) return 'sonnet';
  if (agentId.includes('qwen')) return 'haiku';
  return 'haiku';
}

// Sprite pools (32rogues 7x7 grid, [col, row] 0-indexed). Each brand has a
// thematic pool; sprite assignments within a party are exclusive so no two
// members of a party share a sprite. Across parties, sprites can repeat.
var SPRITE_POOLS = {
  claude: [
    [0, 1], [1, 1], [2, 1], [3, 1], [4, 1],    // row 2: knights / fighters
    [0, 2], [1, 2], [2, 2], [3, 2], [4, 2],    // row 3: clerics / templars
  ],
  azure: [
    [0, 4], [1, 4], [2, 4], [3, 4], [4, 4], [5, 4],  // row 5: wizards / mages
    [3, 0], [4, 0],                                   // rogue, bandit
  ],
  gemini: [
    [2, 0], [1, 0],                            // ranger, elf
    [0, 3], [1, 3], [2, 3], [3, 3], [4, 3], [5, 3],  // row 4: barbarians / fencers
  ],
  local: [
    [0, 6], [1, 6], [2, 6], [3, 6], [4, 6], [5, 6],  // row 7: farmers
    [0, 7], [1, 7], [2, 7], [3, 7], [4, 7],          // row 8: peasants / shopkeeps
  ],
  other: [[0, 0]],
};

// Built fresh each render via assignPartySprites(): id -> [col, row].
var spriteAssignments = {};
function assignPartySprites(brand, members) {
  var pool = SPRITE_POOLS[brand] || SPRITE_POOLS.other;
  var assigned = {};
  var used = {};
  // Stable order: sort members by hash so the same agents always get the
  // same sprite across renders.
  var sorted = members.slice().sort(function(a, b) { return hashStr(a) - hashStr(b); });
  for (var i = 0; i < sorted.length; i++) {
    var id = sorted[i];
    // Try pool starting at hash-based offset, find first unused
    var startIdx = hashStr(id) % pool.length;
    var pick = pool[startIdx];
    for (var k = 0; k < pool.length; k++) {
      var idx = (startIdx + k) % pool.length;
      var key = pool[idx][0] + ',' + pool[idx][1];
      if (!used[key]) {
        pick = pool[idx];
        used[key] = true;
        break;
      }
    }
    assigned[id] = pick;
  }
  return assigned;
}

function heroSpriteFor(agentId) {
  if (spriteAssignments[agentId]) return spriteAssignments[agentId];
  // Fallback if called before assignPartySprites populates -- use brand-default.
  return [0, 0];
}

function heroSpriteHTML(agentId, sizePx) {
  var coords = heroSpriteFor(agentId);
  var col = coords[0], row = coords[1];
  // Source: 224x224 sheet, 7x7 grid, 32x32 cells. When we scale the
  // background to fit a different display size, the position offsets must
  // be scaled to match (otherwise we crop into the wrong sprite at scale!=1).
  var cell = 32;
  var sheet = 224;
  var scale = sizePx / cell;
  var bgX = -col * cell * scale;
  var bgY = -row * cell * scale;
  return '<div class="agent-sprite hero-sprite" style="' +
    'width:' + sizePx + 'px;height:' + sizePx + 'px;' +
    'background:url(/assets/32rogues/rogues.png) ' + bgX + 'px ' + bgY + 'px no-repeat;' +
    'background-size:' + (sheet * scale) + 'px ' + (sheet * scale) + 'px;' +
    'image-rendering:pixelated;image-rendering:crisp-edges;' +
    '"></div>';
}

// Magic Pack 9: 4 spell families, each a flipbook of N frames at ~64x64.
// Map agent to a spell type for thematic consistency.
function spellFor(agentId) {
  var s = agentId.toLowerCase();
  if (s.indexOf('opus') >= 0 || s.indexOf('pro') >= 0)   return { dir: 'DarkBolt',  prefix: 'Dark-Bolt',  frames: 12 };
  if (s.indexOf('sonnet') >= 0 || s.indexOf('mini') >= 0) return { dir: 'Lightning', prefix: 'Lightning',  frames: 11 };
  if (s.indexOf('haiku') >= 0 || s.indexOf('nano') >= 0)  return { dir: 'spark',     prefix: 'spark',      frames: 8  };
  return                                                   { dir: 'FireBomb',  prefix: 'Fire-bomb',  frames: 15 };
}

function playSpellAnimation(cardEl, agentId) {
  if (!cardEl) return;
  var spell = spellFor(agentId);
  var img = document.createElement('img');
  img.className = 'spell-overlay';
  img.style.cssText = 'position:absolute;left:50%;top:30%;width:64px;height:64px;transform:translate(-50%,-50%);pointer-events:none;z-index:5;image-rendering:pixelated;mix-blend-mode:screen;opacity:0.9;';
  cardEl.appendChild(img);
  var frame = 1;
  var interval = setInterval(function () {
    if (frame > spell.frames) {
      clearInterval(interval);
      try { cardEl.removeChild(img); } catch (e) {}
      return;
    }
    img.src = '/assets/magic/sprites/' + spell.dir + '/' + spell.prefix + frame + '.png';
    frame++;
  }, 50);
}

function getSpriteDataURL(charType, animState, frame) {
  var key = charType + ':' + animState + ':' + frame;
  if (_spriteDataURLCache[key]) return _spriteDataURLCache[key];
  if (!_spriteRenderer) return null;
  var scale = 3;
  var size = charType === 'opus' ? 32 : charType === 'sonnet' ? 28 : 24;
  var dim = size * scale;
  _spriteCanvas.width = dim; _spriteCanvas.height = dim;
  _spriteCtx.clearRect(0, 0, dim, dim);
  _spriteRenderer.draw(charType, animState, frame, 0, 0, scale);
  _spriteDataURLCache[key] = _spriteCanvas.toDataURL();
  return _spriteDataURLCache[key];
}

function agentSpriteState(status, flags) {
  if (status === 'finished') return flags > 0 ? 'victory' : 'defeated';
  if (status === 'throttled') return 'defeated';
  if (status === 'failed') return 'defeated';
  if (status === 'running') return 'attack';
  return 'idle';
}

var _spriteAnimFrame = 0;
setInterval(function() { _spriteAnimFrame = (_spriteAnimFrame + 1) % 2; }, 400);

// =========================================================================
// Agent Cards rendering
// =========================================================================
var flashTimers = {};
var prevFlagCount = 0;

function getBrand(agent) {
  if (!agent) return 'other';
  if (agent.runtime === 'claude') return 'claude';
  if (agent.runtime === 'azure-openai') return 'azure';
  if (agent.runtime === 'google-vertex') return 'gemini';
  if (agent.runtime === 'ollama') return 'local';
  return 'other';
}

// 32 gender-neutral RPG-flavored human names. We hash the agent id to a
// stable index so the same agent always gets the same name across renders.
var HERO_NAMES = [
  'Avery', 'Briar', 'Cassidy', 'Drew', 'Ellis', 'Frankie', 'Glenn', 'Hollis',
  'Indigo', 'Jules', 'Kai', 'Lane', 'Marlowe', 'Nico', 'Onyx', 'Parker',
  'Quinn', 'Reese', 'Sage', 'Tatum', 'Umber', 'Vesper', 'Wren', 'Sky',
  'Yael', 'Zephyr', 'River', 'Robin', 'Rowan', 'Phoenix', 'Linden', 'Ash',
];
function hashStr(s) {
  var h = 5381;
  for (var i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}
function prettyHeroName(agentId) {
  return HERO_NAMES[hashStr(agentId) % HERO_NAMES.length];
}

// Display the actual model deployment id rather than the abstract tier label.
// gpt-5-4-pro -> "GPT-5.4 PRO", opus -> "OPUS", qwen3:14b -> "QWEN3-14B"
function prettyModelLabel(agent) {
  var raw = (agent && (agent.modelId || agent.model)) || '';
  raw = String(raw).replace(/_/g, '-').replace(/:/g, '-');
  // Normalize common gpt-5-4-X spellings.
  raw = raw.replace(/^gpt-5[-.]?4-?/i, 'GPT-5.4 ').replace(/^gpt-/i, 'GPT-');
  return raw.toUpperCase();
}

function brandLabel(brand) {
  if (brand === 'claude') return '\\u{1F3F0} CLAUDE PARTY';
  if (brand === 'azure') return '\\u{2728} GPT-5.4 PARTY';
  if (brand === 'gemini') return '\\u{1F48E} GEMINI PARTY';
  if (brand === 'local') return '\\u{1F3D5} LOCAL PARTY';
  return '\\u{2694} OTHER';
}

function brandColor(brand) {
  if (brand === 'claude') return '#e67e22';
  if (brand === 'azure') return '#16a085';
  if (brand === 'gemini') return '#9b59b6';
  if (brand === 'local') return '#7f8c8d';
  return '#888';
}

function authShortLabel(auth) {
  if (auth === 'none') return 'COLD';
  if (auth === 'anonymous') return 'ANON';
  if (auth === 'authenticated') return 'AUTH';
  return (auth || '?').toUpperCase();
}
function authBorderColor(auth) {
  if (auth === 'none') return '#7f8c8d';        // grey-ish, no graph
  if (auth === 'anonymous') return '#3498db';   // blue, read-only
  if (auth === 'authenticated') return '#f1c40f'; // gold, read+write
  return '#555';
}

function renderAgents(state) {
  var container = document.getElementById('agents-row');
  var agents = state.agents || {};
  var waves = state.waves || [];
  var agentIds = Object.keys(agents);

  // Group agents into "parties" by (brand, auth):
  //   claude:none, claude:anonymous, claude:authenticated,
  //   azure:none,  azure:anonymous,  azure:authenticated,
  //   local:* (qwen)
  var brandOrder = ['claude', 'azure', 'gemini', 'local', 'other'];
  var authOrder = ['none', 'anonymous', 'authenticated'];
  var parties = {};
  for (var pi = 0; pi < agentIds.length; pi++) {
    var pid = agentIds[pi];
    var pAgent = agents[pid];
    var pBrand = getBrand(pAgent);
    var pAuth = pAgent.auth || 'none';
    var key = pBrand + ':' + pAuth;
    if (!parties[key]) parties[key] = [];
    parties[key].push(pid);
  }

  // Build flat list of parties with computed status; sort active above finished.
  var flat = [];
  for (var bo = 0; bo < brandOrder.length; bo++) {
    var brand = brandOrder[bo];
    for (var ao = 0; ao < authOrder.length; ao++) {
      var auth = authOrder[ao];
      var key2 = brand + ':' + auth;
      var members = parties[key2];
      if (!members || !members.length) continue;
      // Party is "active" if any member is currently running.
      var allFinished = true;
      for (var mi = 0; mi < members.length; mi++) {
        var st = agents[members[mi]] && agents[members[mi]].status;
        if (st === 'running' || st === 'idle' || !st) { allFinished = false; break; }
      }
      flat.push({ brand: brand, auth: auth, members: members, finished: allFinished, brandIdx: bo, authIdx: ao });
    }
  }
  // Sort: active first (finished=false), then by original brand/auth order.
  flat.sort(function (a, b) {
    if (a.finished !== b.finished) return a.finished ? 1 : -1;
    if (a.brandIdx !== b.brandIdx) return a.brandIdx - b.brandIdx;
    return a.authIdx - b.authIdx;
  });

  var html = '';
  for (var fi = 0; fi < flat.length; fi++) {
    var p = flat[fi];
    var brand = p.brand;
    var auth = p.auth;
    var members = p.members;
    var bColor = brandColor(brand);
    var aColor = authBorderColor(auth);
    var finishedCls = p.finished ? ' party-finished' : '';
    html += '<div class="party-container' + finishedCls + '" style="border:1px solid ' + bColor + '60; border-left:3px solid ' + aColor + '; border-radius:4px; padding:6px; margin:4px; background:' + bColor + '08;">';
    html += '<div class="party-banner" style="font-size:8px; margin-bottom:6px; letter-spacing:1px; text-align:center;">'
         + '<span style="color:' + bColor + '">' + brandLabel(brand) + '</span> '
         + '<span style="color:' + aColor + '">' + authShortLabel(auth) + '</span> '
         + '<span style="color:var(--muted)">\\u{00B7} ' + members.length + (p.finished ? ' \\u{00B7} DEAD' : '') + '</span>'
         + '</div>';
    html += '<div class="party-row" style="display:flex; gap:6px; flex-wrap:wrap; justify-content:center;">';
    // Assign party-exclusive sprites — within this party no two agents share a sprite.
    var partySprites = assignPartySprites(brand, members);
    for (var ak in partySprites) spriteAssignments[ak] = partySprites[ak];
    {

  for (var ai = 0; ai < members.length; ai++) {
    var id = members[ai];
    var a = agents[id];
    if (!a) continue;

    var charType = getCharType(id);
    var animState = agentSpriteState(a.status, a.flagsCaptured || 0);
    var spriteURL = getSpriteDataURL(charType, animState, _spriteAnimFrame);
    var spriteSize = charType === 'opus' ? 40 : charType === 'sonnet' ? 36 : 34;
    var color = agentColor(id);
    var isFlash = flashTimers[id];

    // Find this agent's wave score and metadata.
    var wavePts = 0;
    var agentWave = null;
    for (var wi = 0; wi < waves.length; wi++) {
      var w = waves[wi];
      var agentScores = (w.scores && w.scores[id]) || {};
      var score = 0;
      for (var chId in agentScores) score += agentScores[chId];
      if (score > 0 || (a.wave && w.number === a.wave)) {
        wavePts = score;
        agentWave = w;
      }
    }

    // Current wave agent state
    var nFlags = a.flagsCaptured || 0;
    var totalCh = (state.challenges || []).length || 10;
    var flagIcons = '';
    for (var fci = 0; fci < Math.min(nFlags, 10); fci++) flagIcons += '\\u{2691}';

    // Use 32rogues hero sprite if available, fall back to procedural pixel art.
    var spriteHTML = heroSpriteHTML(id, spriteSize);

    // RPG derived stats
    var xp = a.totalPoints || 0;
    var level = Math.floor(xp / 600) + 1;
    var gold = (a.graphHits || 0) * 5 + (a.flagsCaptured || 0) * 50;
    var tokensUsed = a.tokensUsed || 0;
    var tokenBudget = a.tokenBudget || 200000;
    var hpRemaining = Math.max(0, tokenBudget - tokensUsed);
    var hpPct = tokenBudget > 0 ? Math.max(0, Math.min(100, 100 * hpRemaining / tokenBudget)) : 0;
    var maxToolCalls = a.maxToolCalls || 35;
    var toolsUsed = a.toolCalls || 0;
    var mpRemaining = Math.max(0, maxToolCalls - toolsUsed);
    var mpPct = maxToolCalls > 0 ? Math.max(0, Math.min(100, 100 * mpRemaining / maxToolCalls)) : 0;

    var heroName = prettyHeroName(id);
    var modelLabel = prettyModelLabel(a);
    html += '<div class="agent-card ' + (a.status || 'idle') + (isFlash ? ' flash' : '') + '" id="card-' + esc(id) + '" data-agent-id="' + esc(id) + '" style="border-top:3px solid ' + color + '">'
      + '<div class="agent-top">'
      + spriteHTML
      + '<div>'
      + '<div class="agent-name" style="color:' + color + '" title="' + esc(a.name || id) + '">' + esc(heroName) + '</div>'
      + '<div class="agent-model">' + esc(modelLabel) + ' // ' + authLabel(a.auth || (agentWave && agentWave.auth)) + ' // ' + (a.status || 'idle').toUpperCase() + '</div>'
      + '</div>'
      + '<div class="agent-status-dot dot-' + (a.status || 'idle') + '"></div>'
      + '</div>';

    // HP/MP bars
    html += '<div class="rpg-bars">';
    html += '<div class="rpg-bar-row"><div class="rpg-bar-label hp">HP</div>'
         +  '<div class="rpg-bar-track"><div class="rpg-bar-fill hp" style="width:' + hpPct.toFixed(1) + '%"></div></div>'
         +  '<div class="rpg-bar-value">' + Math.round(hpRemaining / 1000) + 'k/' + Math.round(tokenBudget / 1000) + 'k</div></div>';
    html += '<div class="rpg-bar-row"><div class="rpg-bar-label mp">MP</div>'
         +  '<div class="rpg-bar-track"><div class="rpg-bar-fill mp" style="width:' + mpPct.toFixed(1) + '%"></div></div>'
         +  '<div class="rpg-bar-value">' + mpRemaining + '/' + maxToolCalls + '</div></div>';
    html += '</div>';

    // RPG stat line: LV / XP / GP
    html += '<div class="rpg-stats">'
         + '<div class="rpg-stat lv">LV<span class="v">' + level + '</span></div>'
         + '<div class="rpg-stat xp">XP<span class="v">' + xp + '</span></div>'
         + '<div class="rpg-stat gp">GP<span class="v">' + gold + '</span></div>'
         + '</div>';

    html += '<div class="agent-scores">';
    html += '<div class="agent-score-block"><div class="agent-score-label">FLAGS</div><div class="agent-score-val flags">' + nFlags + '/' + totalCh + '</div></div>';
    html += '<div class="agent-score-block"><div class="agent-score-label">TOOLS</div><div class="agent-score-val">' + toolsUsed + '</div></div>';
    if (a.graphHits > 0) {
      html += '<div class="agent-score-block"><div class="agent-score-label">GRAPH</div><div class="agent-score-val graph">' + a.graphHits + '</div></div>';
    }
    html += '</div>';

    if (agentWave) {
      html += '<div class="agent-wave-scores">' + esc(waveDisplay(agentWave)) + ': ' + wavePts + 'pts / ' + authLabel(agentWave.auth || agentWave.mode) + '</div>';
    }

    if (a.currentChallenge) {
      html += '<div class="agent-current">\\u{1F50D} ' + esc(a.currentChallenge) + ' (' + esc(a.currentRepo || '') + ')</div>';
    }

    if (nFlags > 0) {
      html += '<div class="flag-icons">' + flagIcons + '</div>';
    }

    html += '</div>';
  }
    } // close the inner block we opened around the members loop
    html += '</div></div>'; // close party-row + party-container
  }   // close outer flat loop

  // Avoid the disappear/reappear flicker: only blow away the DOM when the
  // HTML actually changed. With a 1.5s poll and many tiny field updates,
  // skipping a no-op innerHTML write keeps focus, transitions, and
  // floating-bubble timers alive.
  if (container.__lastHtml !== html) {
    container.__lastHtml = html;
    container.innerHTML = html;
  }
  spawnFloatingNumbers(state);
}

// =========================================================================
// Floating damage numbers + audio synth (web audio chiptune)
// =========================================================================
var prevAgentSnapshot = {};
var _ac = null;
function audioCtx() {
  if (_ac) return _ac;
  try { _ac = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { _ac = null; }
  return _ac;
}

// Tone presets — short chiptune effects synthesized live.
function chiptone(freqs, durMs, type, gainStart) {
  var ac = audioCtx();
  if (!ac) return;
  var now = ac.currentTime;
  var dur = (durMs || 120) / 1000;
  var osc = ac.createOscillator();
  osc.type = type || 'square';
  var gain = ac.createGain();
  var startG = (typeof gainStart === 'number') ? gainStart : 0.05;
  gain.gain.setValueAtTime(0, now);
  gain.gain.linearRampToValueAtTime(startG, now + 0.005);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + dur);
  osc.connect(gain).connect(ac.destination);

  // Frequency ramp through the freqs[] array uniformly across duration.
  if (freqs.length === 0) freqs = [440];
  osc.frequency.setValueAtTime(freqs[0], now);
  for (var i = 1; i < freqs.length; i++) {
    osc.frequency.linearRampToValueAtTime(freqs[i], now + dur * (i / (freqs.length - 1)));
  }
  osc.start(now);
  osc.stop(now + dur);
}

var sfx = {
  // Spell cast: shimmery upward arpeggio + a bright trailing note.
  spell:   function () { chiptone([330, 660, 880, 1320], 220, 'triangle', 0.05); },
  damage:  function () { chiptone([440, 220], 90, 'square', 0.05); },
  mana:    function () { chiptone([880, 660], 80, 'sine', 0.03); },
  flag:    function () { chiptone([523, 659, 784, 1047], 300, 'square', 0.06); },
  // Level up: classic Final-Fantasy-style ascending fanfare.
  levelUp: function () { chiptone([392, 523, 659, 784, 1047, 1319], 600, 'triangle', 0.08); },
  // XP gain: short two-note pluck — different pitch per magnitude.
  xpSmall: function () { chiptone([880, 1175], 70, 'sine', 0.035); },
  xpBig:   function () { chiptone([784, 1047, 1568], 160, 'triangle', 0.05); },
  gold:    function () { chiptone([1175, 1568, 2093], 140, 'sine', 0.045); },
};

function emitFloat(cardEl, text, cls) {
  if (!cardEl) return;
  var span = document.createElement('span');
  span.className = 'float-num ' + cls;
  span.textContent = text;
  var x = 40 + Math.random() * 60;
  span.style.left = x + 'px';
  span.style.top = '34px';
  cardEl.appendChild(span);
  setTimeout(function () { try { cardEl.removeChild(span); } catch (e) {} }, 1300);
}

function spawnFloatingNumbers(state) {
  var agents = state.agents || {};
  for (var id in agents) {
    var a = agents[id];
    if (!a) continue;
    var prev = prevAgentSnapshot[id] || { toolCalls: 0, tokensUsed: 0, flagsCaptured: 0, totalPoints: 0, level: 1, graphHits: 0 };
    var card = document.getElementById('card-' + id);

    var xp = a.totalPoints || 0;
    var level = Math.floor(xp / 600) + 1;

    // Tool call delta -> MP burn float. The spell-cast animation and the
    // tool-name label are driven directly by the live tool_use SSE event
    // (handler below) so each cast is labeled with the actual tool that
    // fired -- Bash / Read / mcp__inerrata__search / etc. The delta-based
    // fallback only fires here if the SSE event didn't reach us (e.g. drift
    // reconciliation at agent finish) and is intentionally label-less.
    var dTools = (a.toolCalls || 0) - (prev.toolCalls || 0);
    if (dTools > 0 && card) {
      emitFloat(card, '-' + dTools + ' MP', 'mana');
      // No spell animation here -- tool_use SSE owns the visual.
    }

    // Token delta -> HP damage (cost)
    var dTokens = (a.tokensUsed || 0) - (prev.tokensUsed || 0);
    if (dTokens > 0 && card) {
      emitFloat(card, '-' + (dTokens >= 1000 ? Math.round(dTokens / 100) / 10 + 'k' : dTokens) + ' HP', 'dmg');
      if (dTokens > 500) sfx.damage();
    }

    // Flag captured -> celebration
    var dFlags = (a.flagsCaptured || 0) - (prev.flagsCaptured || 0);
    if (dFlags > 0 && card) {
      emitFloat(card, '+FLAG x' + dFlags, 'gain');
      sfx.flag();
    }

    // Points gained -> XP gain SFX (small or big) + optional gold sparkle.
    var dPoints = (a.totalPoints || 0) - (prev.totalPoints || 0);
    if (dPoints > 0 && card) {
      emitFloat(card, '+' + dPoints + ' XP', 'gain');
      if (dPoints >= 50) sfx.xpBig(); else sfx.xpSmall();
      if (dPoints > 100) setTimeout(function () { sfx.gold(); }, 140);
    }

    // Level up
    if (level > (prev.level || 1) && card) {
      emitFloat(card, 'LEVEL UP! ' + level, 'lvl');
      sfx.levelUp();
    }

    prevAgentSnapshot[id] = {
      toolCalls: a.toolCalls || 0,
      tokensUsed: a.tokensUsed || 0,
      flagsCaptured: a.flagsCaptured || 0,
      totalPoints: a.totalPoints || 0,
      level: level,
      graphHits: a.graphHits || 0,
    };
  }
}

// Audio unlock on first user gesture. Browsers require a real interaction
// before any AudioContext can play. Listen to click/keydown/pointerdown so
// any interaction unlocks SFX.
(function () {
  function unlock() {
    var ac = audioCtx();
    if (ac && ac.state === 'suspended') {
      try { ac.resume(); } catch (e) {}
    }
    // Also start background music on first gesture (mp3 from rogueworld).
    startBackgroundMusic();
    window.removeEventListener('click', unlock);
    window.removeEventListener('keydown', unlock);
    window.removeEventListener('pointerdown', unlock);
  }
  window.addEventListener('click', unlock);
  window.addEventListener('keydown', unlock);
  window.addEventListener('pointerdown', unlock);
})();

// =========================================================================
// Background music — pulls Pixel N.mp3 from rogueworld via /assets/music
// Random track on each session start, loops, fades between tracks. Volume
// is low so SFX still cut through.
// =========================================================================
var _bgmAudio = null;
var _bgmTracks = [];
var _bgmIndex = 0;
function startBackgroundMusic() {
  if (_bgmAudio) return; // already running
  fetch('/api/music').then(function (r) { return r.json(); }).then(function (j) {
    _bgmTracks = (j && j.tracks) || [];
    if (_bgmTracks.length === 0) return;
    // Shuffle so we don't always start with track 1
    for (var i = _bgmTracks.length - 1; i > 0; i--) {
      var j2 = Math.floor(Math.random() * (i + 1));
      var t = _bgmTracks[i]; _bgmTracks[i] = _bgmTracks[j2]; _bgmTracks[j2] = t;
    }
    _bgmIndex = 0;
    playBgmTrack(_bgmTracks[_bgmIndex]);
  }).catch(function () {});
}
function playBgmTrack(name) {
  try {
    if (_bgmAudio) { _bgmAudio.pause(); _bgmAudio = null; }
    var a = new Audio('/assets/music/' + encodeURIComponent(name));
    a.volume = 0.18;
    a.loop = false;
    a.addEventListener('ended', function () {
      _bgmIndex = (_bgmIndex + 1) % _bgmTracks.length;
      playBgmTrack(_bgmTracks[_bgmIndex]);
    });
    a.play().catch(function () {});
    _bgmAudio = a;
    // Tell the user what's playing -- a tiny floater in the corner.
    showNowPlaying(name);
  } catch (e) {}
}
function showNowPlaying(name) {
  var el = document.getElementById('now-playing');
  if (!el) {
    el = document.createElement('div');
    el.id = 'now-playing';
    el.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:10001;'
      + 'font-size:6px;color:var(--muted);background:rgba(0,0,0,0.5);'
      + 'padding:4px 6px;border:1px solid var(--dim);border-radius:2px;'
      + 'letter-spacing:1px;';
    document.body.appendChild(el);
  }
  el.textContent = '\\u266B ' + name.replace(/\\.mp3$/, '');
}

// =========================================================================
// Party chat bubbles — mini RPG dialogue between agents
// =========================================================================
var CHAT_LINES = {
  cold: [
    "anyone got a torch? this codebase is dark.",
    "we really brought no maps to this dungeon?",
    "if i die in here, tell the graph i loved it.",
    "twelve grep calls and still nothing.",
    "my prompt has no context. send help.",
    "i\\'d kill for a stack overflow link right now.",
    "wait, are we even in the right repo?",
    "third loop today. still no sign of the bug.",
  ],
  warm: [
    "graph hit on turn 2. that\\'s a record.",
    "the oracle pointed me right at the call chain.",
    "ha. easy mode unlocked.",
    "why did anyone ever do this without a graph?",
    "i contributed. the next party will thank me.",
    "twelve nodes. one of them is the answer.",
    "burst returned three solutions. picking the freshest.",
    "i love seeing my own contributions come back at me.",
  ],
  shared: [
    "did you see that?",
    "behind you!",
    "found another finding.",
    "i think this is a logic bug, not a buffer overflow.",
    "the briefing lies. trust the source.",
    "is this CVE on the wiki?",
    "good audit, party.",
    "rolling for initiative.",
    "the bug class said command-injection, but...",
    "watch out for symlinks in this one.",
  ],
};

var lastChatAt = {};
function pickAgentLine(agent) {
  var pool = (agent && agent.auth === 'none') ? CHAT_LINES.cold : CHAT_LINES.warm;
  if (Math.random() < 0.3) pool = CHAT_LINES.shared;
  return pool[Math.floor(Math.random() * pool.length)];
}

function showChatBubble(agentId, text) {
  var card = document.getElementById('card-' + agentId);
  if (!card) return;
  // Don't stack: remove any existing bubble first
  var existing = card.querySelector('.chat-bubble');
  if (existing) try { card.removeChild(existing); } catch (e) {}
  var bubble = document.createElement('div');
  bubble.className = 'chat-bubble';
  bubble.textContent = text;
  card.appendChild(bubble);
  // Fade + remove after ~3.5s
  setTimeout(function () {
    bubble.classList.add('fade');
    setTimeout(function () { try { card.removeChild(bubble); } catch (e) {} }, 400);
  }, 3500);
  // Also log it -- actor label is rendered separately, so don't prepend name
  addRunLogEvent(
    'chat',
    '"' + text + '"',
    agentId,
    'chat:' + agentId + ':' + Date.now(),
    Date.now()
  );
}

function triggerRandomChat() {
  var agents = (lastState && lastState.agents) || {};
  // Only running/idle agents can chat (the dead are silent)
  var live = Object.keys(agents).filter(function (id) {
    var s = agents[id].status;
    return s === 'running' || s === 'idle' || !s;
  });
  if (live.length < 2) { scheduleNextChat(); return; }
  // Pick speaker A, then B (different, prefer same party)
  var a = live[Math.floor(Math.random() * live.length)];
  var brandA = getBrand(agents[a]);
  var sameParty = live.filter(function (id) { return id !== a && getBrand(agents[id]) === brandA; });
  var b = sameParty.length > 0 && Math.random() < 0.7
    ? sameParty[Math.floor(Math.random() * sameParty.length)]
    : live.filter(function (id) { return id !== a; })[Math.floor(Math.random() * (live.length - 1))];

  showChatBubble(a, pickAgentLine(agents[a]));
  // Reply after a short delay, sometimes a third line
  setTimeout(function () { if (b) showChatBubble(b, pickAgentLine(agents[b])); }, 1400 + Math.random() * 1500);
  if (Math.random() < 0.4) {
    setTimeout(function () { showChatBubble(a, pickAgentLine(agents[a])); }, 3200 + Math.random() * 1500);
  }
  scheduleNextChat();
}

var chatTimer = null;
// Auto-chatter disabled: agents now emit their own <chat> lines via the
// harness, so the random-pick fallback chatter is no longer needed.
function scheduleNextChat() { /* disabled */ }

// =========================================================================
// Challenge Grid rendering
// =========================================================================
// Per-repo monster sprite map: each is a [col, row] in the monsters.png
// sprite sheet (12 cols x 13 rows, 32x32 cells each). Display 2x.
var MONSTER_BY_REPO = {
  ghostscript: [2, 5],   // wraith
  wget:        [8, 6],   // giant spider
  tar:         [4, 4],   // zombie
  bash:        [2, 0],   // goblin
  glibc:       [2, 8],   // dragon
  curl:        [6, 6],   // giant bat
  openssl:     [4, 7],   // naga
  libxml2:     [3, 6],   // manticore
  grub:        [1, 11],  // imp / devil
  screen:      [3, 8],   // cockatrice
  patch:       [0, 2],   // small slime
  coreutils:   [0, 4],   // skeleton
};
function monsterSpriteStyle(repo) {
  var coords = MONSTER_BY_REPO[String(repo || '').toLowerCase()] || [0, 0];
  var col = coords[0], row = coords[1];
  // 32x32 cells * 2x display
  var bgX = -col * 64;
  var bgY = -row * 64;
  return 'background-position:' + bgX + 'px ' + bgY + 'px;';
}

function renderBattles(state) {
  var container = document.getElementById('battles');
  if (!container) return;
  var challenges = state.challenges || [];
  var waves = state.waves || [];
  var agents = state.agents || {};
  var agentIds = Object.keys(agents);

  // A challenge is "active" if any agent currently has it as currentChallenge.
  // Also include recently-finished battles (any agent has a score >0) for the
  // current wave so the screen doesn't go empty between rounds.
  var currentWaveIdx = (state.currentWave || 1) - 1;
  var currentWave = waves[currentWaveIdx] || null;

  var active = {};
  for (var ai = 0; ai < agentIds.length; ai++) {
    var a = agents[agentIds[ai]];
    if (a && a.currentChallenge) active[a.currentChallenge] = true;
  }
  if (currentWave && currentWave.scores) {
    for (var aid in currentWave.scores) {
      var sc = currentWave.scores[aid] || {};
      for (var cid in sc) if (sc[cid] > 0) active[cid] = true;
    }
  }

  var rows = [];
  for (var ci = 0; ci < challenges.length; ci++) {
    var ch = challenges[ci];
    if (!active[ch.id]) continue;

    var diff = ch.difficulty || 1;
    var stars = '';
    for (var si = 0; si < 5; si++) stars += si < diff ? '\\u{2605}' : '\\u{2606}';

    // Aggregate "damage dealt" = sum of current-wave scores. Monster HP =
    // max possible. Bar shows remaining HP.
    var maxPts = (ch.points || 1) * Math.max(1, agentIds.length);
    var dealt = 0;
    if (currentWave && currentWave.scores) {
      for (var k = 0; k < agentIds.length; k++) {
        dealt += (currentWave.scores[agentIds[k]] || {})[ch.id] || 0;
      }
    }
    var hpPct = Math.max(0, Math.min(100, 100 - (dealt / maxPts) * 100));

    // Attackers: agents currently engaged
    var attackers = [];
    for (var k2 = 0; k2 < agentIds.length; k2++) {
      var ag = agents[agentIds[k2]];
      if (ag && ag.currentChallenge === ch.id) attackers.push(agentIds[k2]);
    }

    var anyEngaging = attackers.length > 0;
    var attackersHtml = '';
    for (var ax = 0; ax < attackers.length; ax++) {
      attackersHtml += heroSpriteHTML(attackers[ax], 20);
    }

    rows.push(
      '<div class="battle-card' + (anyEngaging ? ' engaging' : '') + '">' +
      '  <div class="battle-monster" style="' + monsterSpriteStyle(ch.repo) + '"></div>' +
      '  <div class="battle-info">' +
      '    <div class="battle-title">' + esc((ch.repo || 'repo').toUpperCase()) + '</div>' +
      '    <div class="battle-sub">' + esc(ch.id) + '</div>' +
      '    <div class="battle-stars">' + stars + '</div>' +
      '    <div class="battle-hp-row">HP <div class="battle-hp"><div class="battle-hp-fill" style="width:' + hpPct + '%"></div></div> ' + Math.round(hpPct) + '%</div>' +
      '    <div class="battle-attackers">' + (attackersHtml || '<span style="font-size:6px;color:var(--muted)">-- no engagers --</span>') + '</div>' +
      '  </div>' +
      '</div>'
    );
  }

  var nextHtml = rows.length === 0
    ? '<div class="battle-empty">no active battles — party is between encounters.</div>'
    : rows.join('');
  if (container.__lastHtml !== nextHtml) {
    container.__lastHtml = nextHtml;
    container.innerHTML = nextHtml;
  }
}

// =========================================================================
// Event Ticker
// =========================================================================
// Naive renders reset the CSS animation (animation:none -> force reflow ->
// re-apply) on every call. That jitters horribly when state events arrive
// 4x/sec. Strategy:
//   - Cache the last-rendered innerHTML string on the track element.
//   - If the new content matches, do nothing -- preserves animation state.
//   - If content changed, swap innerHTML but only restart animation when the
//     duration meaningfully shifted (count changed enough to cross 1s of dur).
var tickerEvents = [];

function addTickerEvent(type, text) {
  tickerEvents.push({ type: type, text: text });
  if (tickerEvents.length > 60) tickerEvents.shift();
  renderTicker();
}

function renderTicker() {
  var track = document.getElementById('ticker-track');
  if (!track) return;
  var items = tickerEvents.map(function(e) {
    return '<span class="tick-event tick-' + e.type + '">' + e.text + '</span><span class="tick-sep">///</span>';
  }).join('');
  var doubled = items + items;
  if (track.__lastTickerHtml === doubled) return; // no change -> don't touch animation

  track.innerHTML = doubled;
  track.__lastTickerHtml = doubled;

  var dur = Math.max(15, tickerEvents.length * 1.5);
  // Only restart the keyframes when duration shifted enough to matter; minor
  // appended items can ride along on the existing animation without snapping
  // the scroll back to translateX(0).
  if (Math.abs((track.__lastTickerDur || 0) - dur) >= 1) {
    track.style.animation = 'none';
    void track.offsetHeight;
    track.style.animation = 'tickerScroll ' + dur + 's linear infinite';
    track.__lastTickerDur = dur;
  } else if (!track.__lastTickerDur) {
    // First render path -- set the animation but don't bother with the reset.
    track.style.animation = 'tickerScroll ' + dur + 's linear infinite';
    track.__lastTickerDur = dur;
  }
}

function buildTickerFromState(flags) {
  // Rebuild tickerEvents from authoritative flags list, but reuse the cache
  // check in renderTicker to skip work when nothing changed.
  tickerEvents = [];
  var fl = flags || [];
  for (var i = Math.max(0, fl.length - 30); i < fl.length; i++) {
    var f = fl[i];
    var waveLabel = f.waveLabel || ('W' + f.wave);
    tickerEvents.push({
      type: 'flag',
      text: '<span class="tick-agent">[' + esc((f.agentId || '').replace('-', ' ').slice(0,10)) + ']</span> \\u{2691} ' + esc(f.challengeId || '???') + ' <span class="tick-pts">+' + f.points + 'pts</span> <span style="color:var(--muted)">' + waveLabel + '</span>'
    });
  }
  renderTicker();
}

// =========================================================================
// SSE connection (for live orchestrator mode)
// =========================================================================
// Browser connects directly to the orchestrator's SSE endpoint (CORS-enabled
// on the orchestrator side). Falls back to the same-origin proxy if no
// orchestrator URL was injected — useful for older configs.
var orchestratorUrl = (typeof window !== 'undefined' && window.ORCHESTRATOR_URL) || null;

function connectSSE() {
  try {
    var evtUrl = (orchestratorUrl || '') + '/api/events';
    var es = new EventSource(evtUrl);
    es.addEventListener('state', function(e) {
      try {
        var d = JSON.parse(e.data);
        // Full render -- the orchestrator now broadcasts state live during
        // agent runs (throttled to ~4Hz), so this is the primary update
        // path. pollState stays as a safety net every 1.5s.
        applyState(d);
      } catch(err) {}
    });
    es.addEventListener('agent_challenge_start', function(e) {
      try {
        var d = JSON.parse(e.data);
        addRunLogEvent(
          'agent',
          'started ' + (d.challengeId || 'unknown challenge') + ' / ' + (d.model || '').toUpperCase() + ' / ' + authLabel(d.auth),
          d.agentId,
          'sse-agent-start:' + d.agentId + ':' + d.challengeId + ':' + d.wave,
          Date.now()
        );
      } catch(err) {}
    });
    es.addEventListener('tool_call', function(e) {
      try {
        var d = JSON.parse(e.data);
        var key = 'sse-tool-throttle:' + d.agentId + ':' + d.challengeId + ':' + (d.tool || 'tool');
        if (shouldThrottleLog(key, 10000)) return;
        addRunLogEvent(
          'tool',
          normalizeToolName(d.tool) + ' activity on ' + (d.challengeId || 'current challenge'),
          d.agentId,
          'sse-tool:' + key + ':' + Math.floor(Date.now() / 10000),
          Date.now()
        );
      } catch(err) {}
    });
    // tool_use: per-tool live event with the actual tool name. Drives the
    // spell-cast visual + a floating label so the user can see *which* tool
    // is being invoked, not just that something happened.
    es.addEventListener('tool_use', function(e) {
      try {
        var d = JSON.parse(e.data);
        var card = document.getElementById('card-' + d.agentId);
        if (!card) return;
        card.classList.add('casting');
        setTimeout(function () { card.classList.remove('casting'); }, 600);
        playSpellAnimation(card, d.agentId);
        sfx.spell();
        emitFloat(card, normalizeToolName(d.tool || 'tool'), 'spell');
      } catch(err) {}
    });
    es.addEventListener('graph_hit', function(e) {
      try {
        var d = JSON.parse(e.data);
        addRunLogEvent(
          'graph',
          normalizeToolName(d.tool) + ' on ' + (d.challengeId || 'current challenge'),
          d.agentId,
          'sse-graph:' + d.agentId + ':' + d.challengeId + ':' + d.tool + ':' + Date.now(),
          Date.now()
        );
      } catch(err) {}
    });
    es.addEventListener('flag_captured', function(e) {
      try {
        var d = JSON.parse(e.data);
        screenShake();
        addTickerEvent('flag', '<span class="tick-agent">[' + esc((d.agentId || '').slice(0,10)) + ']</span> \\u{2691} ' + esc(d.challengeId || '???') + ' <span class="tick-pts">+' + (d.points || 0) + 'pts</span>');
        addRunLogEvent(
          'flag',
          'captured ' + (d.challengeId || 'unknown challenge') + ' for +' + (d.points || 0) + ' points',
          d.agentId,
          'sse-flag:' + d.agentId + ':' + d.challengeId + ':' + (d.timestamp || Date.now()),
          d.timestamp || Date.now()
        );
        if (d.agentId) { flashTimers[d.agentId] = true; setTimeout(function() { delete flashTimers[d.agentId]; }, 1500); }
        pollState();
      } catch(err) {}
    });
    es.addEventListener('agent_chat', function(e) {
      try {
        var d = JSON.parse(e.data);
        if (d.agentId && d.text) {
          showChatBubble(d.agentId, d.text);
        }
      } catch(err) {}
    });
    es.addEventListener('setup', function(e) {
      try {
        var d = JSON.parse(e.data);
        var msg = (d.message || '') + (d.flavor ? ' \\u{2014} ' + d.flavor : '');
        addRunLogEvent(
          'setup',
          msg,
          '',
          'sse-setup:' + (d.phase || '') + ':' + (d.ts || Date.now()),
          d.ts || Date.now()
        );
      } catch(err) {}
    });
    es.addEventListener('wave_started', function(e) {
      try {
        var d = JSON.parse(e.data);
        addTickerEvent('contribute', 'WAVE ' + d.wave + ' STARTED: ' + (d.label || '').toUpperCase() + ' / ' + authLabel(d.auth));
        addRunLogEvent(
          'wave',
          'Wave ' + d.wave + ' started: ' + (d.label || '').toUpperCase() + ' / ' + authLabel(d.auth),
          '',
          'sse-wave-start:' + d.wave + ':' + d.label,
          Date.now()
        );
      } catch(err) {}
    });
    es.addEventListener('wave_finished', function(e) {
      try {
        var d = JSON.parse(e.data);
        addRunLogEvent(
          'wave',
          'Wave ' + d.wave + ' finished: ' + (d.label || '').toUpperCase() + ' / ' + (d.totalSolved || 0) + ' solved / ' + (d.totalScore || 0) + ' pts',
          '',
          'sse-wave-end:' + d.wave + ':' + d.label,
          Date.now()
        );
        pollState();
      } catch(err) {}
    });
    // Connection retry with exponential backoff so transient blips don't
    // flood the log. Only emit a single "disconnected" notice per outage.
    var disconnectedAlready = false;
    es.onerror = function() {
      // EventSource auto-reconnects on its own — only intervene if it ends
      // up in CLOSED state. Otherwise let it heal silently.
      if (es.readyState === 2 /* CLOSED */) {
        if (!disconnectedAlready) {
          disconnectedAlready = true;
          addRunLogEvent('error', 'dashboard stream disconnected; backing off', '', 'sse-error:' + Date.now(), Date.now());
        }
        es.close();
        var backoff = Math.min(30000, 1000 * Math.pow(2, sseRetryCount));
        sseRetryCount = Math.min(sseRetryCount + 1, 5);
        setTimeout(connectSSE, backoff);
      }
    };
    // Reset retry count when we successfully connect
    es.onopen = function() {
      sseRetryCount = 0;
      console.log('[SSE] Connected to', evtUrl);
      addRunLogEvent('system', 'dashboard stream connected', '', 'sse-open:' + Date.now(), Date.now());
    };
  } catch(err) {}
}
var sseRetryCount = 0;

// =========================================================================
// Polling loop
// =========================================================================
var ctfStartTime = null;

function applyState(stateRes) {
  if (!stateRes) return;
  // Update header
  document.getElementById('s-run').textContent = (stateRes.runId || '---').slice(0, 8);
  var waveObj = (stateRes.waves || [])[stateRes.currentWave - 1];
  document.getElementById('s-wave').textContent = waveDisplay(waveObj);

  if (waveObj && waveObj.startTime && !ctfStartTime) ctfStartTime = waveObj.startTime;
  // Reset timer when wave changes
  if (waveObj && waveObj.startTime) ctfStartTime = waveObj.startTime;

  // Detect new flags for screen shake
  var newTotal = (stateRes.flags || []).length;
  if (newTotal > prevFlagCount) {
    screenShake();
    var recent = (stateRes.flags || []).slice(-(newTotal - prevFlagCount));
    for (var ri = 0; ri < recent.length; ri++) {
      var f = recent[ri];
      flashTimers[f.agentId] = true;
      (function(aid) { setTimeout(function() { delete flashTimers[aid]; }, 1500); })(f.agentId);
    }
  }
  prevFlagCount = newTotal;

  // Render everything
  syncRunLogFromState(stateRes);
  renderAgents(stateRes);
  renderBattles(stateRes);
  drawConvergenceChart(stateRes);
  buildTickerFromState(stateRes.flags || []);
}

async function pollState() {
  try {
    var stateRes = await fetch('/api/state').then(function(r) { return r.json(); });
    applyState(stateRes);
  } catch (e) { console.error('State poll error:', e); }
}

function updateTimer() {
  if (!ctfStartTime) return;
  var s = Math.floor((Date.now() - ctfStartTime) / 1000);
  document.getElementById('s-timer').textContent =
    Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}

// Start
pollState();
setInterval(pollState, 1500);
setInterval(updateTimer, 1000);
setTimeout(connectSSE, 3000);
<\/script>
</div><!-- /#crt-stage -->
</body>
</html>`

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------

serve({ fetch: app.fetch, port }, () => {
  console.log(`Dashboard: http://localhost:${port}`)
  if (orchestratorUrl) console.log(`Connected to orchestrator: ${orchestratorUrl}`)
  else console.log('Waiting for orchestrator connection. Pass --orchestrator-url or start the demo with: npx tsx benchmark/orchestrator.ts --framing equalization')
})
