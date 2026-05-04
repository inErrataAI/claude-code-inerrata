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
import { readFileSync, existsSync } from 'fs'
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

app.get('/api/events', async (c) => {
  if (!orchestratorUrl) return c.text('No orchestrator configured', 503)
  try {
    const res = await fetch(`${orchestratorUrl}/api/events`)
    if (!res.ok || !res.body) return c.text('Orchestrator SSE unavailable', 502)
    c.header('Content-Type', 'text/event-stream')
    c.header('Cache-Control', 'no-cache')
    c.header('Connection', 'keep-alive')
    return c.body(res.body as any)
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
  return c.html(DASHBOARD_HTML)
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
body { background:var(--bg); color:var(--text); font-family:var(--font); overflow-x:hidden; overflow-y:auto; font-size:10px; }

/* =========================================================================
   CRT EFFECTS
   ========================================================================= */
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
   MAIN LAYOUT (vertical stack)
   ========================================================================= */
#main-content { padding: 8px 12px 12px; }
#upper-dashboard, #activity-section, #ticker-section {
  width:min(1120px, 100%);
  margin-left:auto;
  margin-right:auto;
}

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
   AGENT CARDS
   ========================================================================= */
#agents-row { display:flex; gap:6px; flex-wrap:wrap; justify-content:center; }
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
   CHALLENGE GRID
   ========================================================================= */
#challenge-grid {
  display:flex; gap:5px; overflow-x:auto; padding-bottom:5px;
}
#challenge-grid::-webkit-scrollbar { height:4px; }
#challenge-grid::-webkit-scrollbar-thumb { background:var(--dim); border-radius:2px; }

.challenge-card {
  min-width:96px; max-width:110px; background:var(--bg2); border:1px solid var(--dim);
  border-radius:2px; padding:6px; flex-shrink:0;
}
.challenge-cve { font-size:6px; color:var(--cyan); font-weight:bold; letter-spacing:0.5px; }
.challenge-repo { font-size:5px; color:var(--muted); margin-top:2px; }
.challenge-stars { font-size:7px; color:var(--gold); margin-top:3px; letter-spacing:1px; }
.challenge-bars { margin-top:5px; }
.challenge-bar {
  display:flex; align-items:center; gap:3px; margin-bottom:3px; font-size:5px;
}
.challenge-bar-label { width:9px; font-weight:bold; }
.challenge-bar-track { flex:1; height:5px; background:#0a0a14; border:1px solid #1a1a2e; border-radius:1px; overflow:hidden; }
.challenge-bar-fill { height:100%; transition:width 0.5s; border-radius:1px; }
.challenge-bar-pts { width:22px; text-align:right; color:var(--muted); }

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
<script src="/sprites.js"><\/script>

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

    <!-- CONVERGENCE CHART -->
    <div class="section" id="convergence-section">
      <div class="section-header">CONVERGENCE CHART</div>
      <canvas id="convergence-canvas"></canvas>
      <div id="convergence-overlay"><div id="compound-flash">KNOWLEDGE COMPOUNDING</div></div>
      <div id="comparison-panel"></div>
    </div>

    <!-- AGENT CARDS -->
    <div class="section" id="agents-section">
      <div class="section-header">AGENT PANEL</div>
      <div id="agents-row"></div>
    </div>

    <!-- CHALLENGE GRID -->
    <div class="section" id="challenges-section">
      <div class="section-header">CHALLENGE GRID</div>
      <div id="challenge-grid"></div>
    </div>
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
      ? '<span class="log-agent" style="color:' + color + '">' + esc(agentLabel(e.agentId)) + '</span> '
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
  var flags = state.flags || [];
  var agents = state.agents || {};
  var agentIds = Object.keys(agents);
  var numCh = challenges.length || 10;

  // Chart margins — tighter horizontal, generous vertical
  var ml = 55, mr = 12, mt = 30, mb = 40;
  var cw = W - ml - mr;
  var ch = H - mt - mb;

  // Theoretical max (fallback)
  var totalPossible = 0;
  for (var ci = 0; ci < challenges.length; ci++) totalPossible += (challenges[ci].points || 0);
  if (totalPossible === 0) totalPossible = 5400;

  // Scan actual achieved scores to auto-zoom the Y axis
  var _allEndpoints = [];
  for (var _wi = 0; _wi < (waves || []).length; _wi++) {
    var _wave = waves[_wi];
    for (var _ai = 0; _ai < agentIds.length; _ai++) {
      var _scores = (_wave.scores && _wave.scores[agentIds[_ai]]) || {};
      var _total = 0;
      for (var _ci = 0; _ci < challenges.length; _ci++) {
        _total += _scores[challenges[_ci] ? challenges[_ci].id : ''] || 0;
      }
      if (_total > 0) _allEndpoints.push(_total);
    }
  }

  // When we have data: zoom Y axis to actual range with padding
  // When no data yet: use full theoretical scale
  var minY = 0;
  var maxY = totalPossible;
  if (_allEndpoints.length >= 2) {
    var _low = Math.min.apply(null, _allEndpoints);
    var _high = Math.max.apply(null, _allEndpoints);
    minY = Math.max(0, Math.floor(_low * 0.6));
    maxY = Math.ceil(_high * 1.15);
  } else if (_allEndpoints.length === 1) {
    maxY = Math.ceil(_allEndpoints[0] * 1.3);
  }

  // X maps challenge index (0..numCh-1) to pixel
  function xPos(idx) { return ml + (idx / (numCh - 1 || 1)) * cw; }
  function yPos(pts) { return mt + ch - ((pts - minY) / (maxY - minY)) * ch; }

  // Grid — 10 divisions for finer Y resolution
  convCtx.strokeStyle = '#1a1a2e';
  convCtx.lineWidth = 0.5;
  for (var gi = 0; gi <= 10; gi++) {
    var gy = mt + (gi / 10) * ch;
    convCtx.beginPath(); convCtx.moveTo(ml, gy); convCtx.lineTo(ml + cw, gy); convCtx.stroke();
  }
  for (var gci = 0; gci < numCh; gci++) {
    var gx = xPos(gci);
    convCtx.beginPath(); convCtx.moveTo(gx, mt); convCtx.lineTo(gx, mt + ch); convCtx.stroke();
  }

  // Axes
  convCtx.strokeStyle = '#333';
  convCtx.lineWidth = 1;
  convCtx.beginPath(); convCtx.moveTo(ml, mt); convCtx.lineTo(ml, mt + ch); convCtx.lineTo(ml + cw, mt + ch); convCtx.stroke();

  // Y axis labels — 10 divisions, scaled to visible range (minY..maxY)
  convCtx.fillStyle = '#555';
  convCtx.font = '7px "Press Start 2P", monospace';
  convCtx.textAlign = 'right';
  for (var yi = 0; yi <= 10; yi++) {
    var yVal = Math.round(minY + (yi / 10) * (maxY - minY));
    convCtx.fillText(yVal.toString(), ml - 6, yPos(yVal) + 3);
  }

  // X axis labels -- show every Nth label to avoid overlap with 50+ challenges
  var labelStep = numCh <= 15 ? 1 : numCh <= 30 ? 3 : numCh <= 60 ? 5 : 10;
  convCtx.textAlign = 'center';
  convCtx.fillStyle = '#444';
  convCtx.font = '5px "Press Start 2P", monospace';
  for (var xi = 0; xi < numCh; xi++) {
    if (xi % labelStep !== 0 && xi !== numCh - 1) continue;
    var label = numCh > 20 ? String(xi + 1) : (challenges[xi] ? challenges[xi].cve || ('CH-' + (xi+1)) : ('CH-' + (xi+1)));
    convCtx.save();
    convCtx.translate(xPos(xi), mt + ch + 8);
    convCtx.rotate(Math.PI / 6);
    convCtx.fillText(label.replace('CVE-', ''), 0, 0);
    convCtx.restore();
  }

  // Axis titles
  convCtx.fillStyle = '#555';
  convCtx.font = '7px "Press Start 2P", monospace';
  convCtx.textAlign = 'center';
  convCtx.fillText('CHALLENGE', ml + cw / 2, H - 4);
  convCtx.save();
  convCtx.translate(12, mt + ch / 2);
  convCtx.rotate(-Math.PI / 2);
  convCtx.fillText('CUMULATIVE POINTS', 0, 0);
  convCtx.restore();

  // Build cumulative point data per wave per agent
  // For each wave, for each agent, compute cumulative points across challenges in order
  var lineData = []; // { agentId, wave, color, dashed, points: [cumPts at each challenge index] }

  for (var wi = 0; wi < waves.length; wi++) {
    var wave = waves[wi];
    var isWarm = wave.auth === 'authenticated' || wave.graphState === 'warm';

    for (var ai = 0; ai < agentIds.length; ai++) {
      var agentId = agentIds[ai];
      var agent = agents[agentId] || {};
      var model = agent.model || agentId;
      var color = modelColor(model);
      var agentScores = (wave.scores && wave.scores[agentId]) || {};
      if (Object.keys(agentScores).length === 0) continue;
      var cumPts = [];
      var running = 0;
      for (var chi = 0; chi < numCh; chi++) {
        var chId = challenges[chi] ? challenges[chi].id : '';
        running += agentScores[chId] || 0;
        cumPts.push(running);
      }
      lineData.push({
        agentId: agentId,
        wave: wave.number,
        model: model,
        mode: wave.mode,
        auth: wave.auth || wave.mode,
        color: color,
        dashed: isWarm,
        points: cumPts,
        label: modelLabel(model),
      });
    }
  }

  // Draw lines
  for (var li = 0; li < lineData.length; li++) {
    var line = lineData[li];
    var pts = line.points;
    // Find how far this agent has progressed (non-zero cumulative)
    var lastNonZeroIdx = -1;
    for (var pi = pts.length - 1; pi >= 0; pi--) {
      if (pts[pi] > 0) { lastNonZeroIdx = pi; break; }
    }
    if (lastNonZeroIdx < 0) continue; // no data

    convCtx.save();
    convCtx.strokeStyle = line.color;
    convCtx.lineWidth = line.dashed ? 2.5 : 2;

    if (line.dashed) {
      convCtx.setLineDash([6, 4]);
      // Glow for warm lines
      convCtx.shadowColor = line.color;
      convCtx.shadowBlur = 6;
    } else {
      convCtx.setLineDash([]);
    }

    convCtx.beginPath();
    convCtx.moveTo(xPos(0), yPos(pts[0]));
    for (var si = 1; si <= lastNonZeroIdx; si++) {
      convCtx.lineTo(xPos(si), yPos(pts[si]));
    }
    convCtx.stroke();

    // Draw dots at data points
    convCtx.shadowBlur = 0;
    convCtx.setLineDash([]);
    for (var di = 0; di <= lastNonZeroIdx; di++) {
      if (pts[di] > 0 && (di === 0 || pts[di] !== pts[di-1])) {
        convCtx.beginPath();
        convCtx.arc(xPos(di), yPos(pts[di]), 3, 0, Math.PI * 2);
        convCtx.fillStyle = line.color;
        convCtx.fill();
      }
    }
    convCtx.restore();
  }

  // Legend
  convCtx.font = '6px "Press Start 2P", monospace';
  var legendX = ml + 10;
  var legendY = mt + 10;
  for (var lei = 0; lei < lineData.length; lei++) {
    var le = lineData[lei];
    if (le.points[le.points.length - 1] === 0 && le.points[0] === 0) continue;
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
    var opusFinal = coldOpus.points[coldOpus.points.length - 1] || 0;
    var haikuFinal = warmHaiku.points[warmHaiku.points.length - 1] || 0;
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
    totals[line.label] = line.points[line.points.length - 1] || 0;
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

function renderAgents(state) {
  var container = document.getElementById('agents-row');
  var agents = state.agents || {};
  var waves = state.waves || [];
  var agentIds = Object.keys(agents);
  var html = '';

  for (var ai = 0; ai < agentIds.length; ai++) {
    var id = agentIds[ai];
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
    for (var fi = 0; fi < Math.min(nFlags, 10); fi++) flagIcons += '\\u{2691}';

    var spriteHTML = spriteURL
      ? '<img class="agent-sprite" src="' + spriteURL + '" style="width:' + spriteSize + 'px;height:' + spriteSize + 'px;" title="' + (a.name || id) + '">'
      : '<div class="agent-sprite" style="width:' + spriteSize + 'px;height:' + spriteSize + 'px;background:' + color + ';border-radius:2px;"></div>';

    html += '<div class="agent-card ' + (a.status || 'idle') + (isFlash ? ' flash' : '') + '" style="border-top:3px solid ' + color + '">'
      + '<div class="agent-top">'
      + spriteHTML
      + '<div>'
      + '<div class="agent-name" style="color:' + color + '">' + esc(a.name || id) + '</div>'
      + '<div class="agent-model">' + (a.model || '').toUpperCase() + ' // ' + authLabel(a.auth || (agentWave && agentWave.auth)) + ' // ' + (a.status || 'idle').toUpperCase() + '</div>'
      + '</div>'
      + '<div class="agent-status-dot dot-' + (a.status || 'idle') + '"></div>'
      + '</div>';

    html += '<div class="agent-scores">';
    html += '<div class="agent-score-block"><div class="agent-score-label">FLAGS</div><div class="agent-score-val flags">' + nFlags + '/' + totalCh + '</div></div>';
    html += '<div class="agent-score-block"><div class="agent-score-label">POINTS</div><div class="agent-score-val pts">' + (a.totalPoints || 0) + '</div></div>';
    html += '<div class="agent-score-block"><div class="agent-score-label">TOOLS</div><div class="agent-score-val">' + (a.toolCalls || 0) + '</div></div>';
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

  container.innerHTML = html;
}

// =========================================================================
// Challenge Grid rendering
// =========================================================================
function renderChallengeGrid(state) {
  var container = document.getElementById('challenge-grid');
  var challenges = state.challenges || [];
  var waves = state.waves || [];
  var agents = state.agents || {};
  var agentIds = Object.keys(agents);
  var html = '';

  for (var ci = 0; ci < challenges.length; ci++) {
    var ch = challenges[ci];
    var diff = ch.difficulty || 1;
    var stars = '';
    for (var si = 0; si < 5; si++) stars += si < diff ? '\\u{2605}' : '\\u{2606}';
    var diffLabels = { 1: 'Easy', 2: 'Medium', 3: 'Hard', 4: 'Expert', 5: 'Legend' };

    html += '<div class="challenge-card">';
    html += '<div class="challenge-cve">' + esc(ch.cve || ch.id) + '</div>';
    html += '<div class="challenge-repo">' + esc(ch.repo || '') + '</div>';
    html += '<div class="challenge-stars">' + stars + ' <span style="font-size:5px;color:var(--muted)">' + (diffLabels[diff] || '') + '</span></div>';
    html += '<div class="challenge-bars">';

    for (var ai = 0; ai < agentIds.length; ai++) {
      var agentId = agentIds[ai];
      var label = agentLabel(agentId)[0]; // O, S, H
      var color = agentColor(agentId);
      var totalPts = 0;
      // Sum across all waves
      for (var wi = 0; wi < waves.length; wi++) {
        var w = waves[wi];
        var agentScores = (w.scores && w.scores[agentId]) || {};
        totalPts += agentScores[ch.id] || 0;
      }
      // Current wave agent data
      var currentWaveIdx = (state.currentWave || 1) - 1;
      var currentWave = waves[currentWaveIdx];
      var currentPts = 0;
      if (currentWave && currentWave.scores && currentWave.scores[agentId]) {
        currentPts = currentWave.scores[agentId][ch.id] || 0;
      }
      var maxPts = ch.points || 1;
      var pct = Math.min(100, Math.round((currentPts / maxPts) * 100));
      var brightness = currentPts >= maxPts ? 1 : currentPts > 0 ? 0.5 : 0.15;

      html += '<div class="challenge-bar">'
        + '<div class="challenge-bar-label" style="color:' + color + '">' + label + '</div>'
        + '<div class="challenge-bar-track"><div class="challenge-bar-fill" style="width:' + pct + '%;background:' + color + ';opacity:' + brightness + '"></div></div>'
        + '<div class="challenge-bar-pts">' + (currentPts > 0 ? currentPts : '') + '</div>'
        + '</div>';
    }

    html += '</div></div>';
  }

  container.innerHTML = html;
}

// =========================================================================
// Event Ticker
// =========================================================================
var tickerEvents = [];

function addTickerEvent(type, text) {
  tickerEvents.push({ type: type, text: text });
  if (tickerEvents.length > 60) tickerEvents.shift();
  renderTicker();
}

function renderTicker() {
  var track = document.getElementById('ticker-track');
  var items = tickerEvents.map(function(e) {
    return '<span class="tick-event tick-' + e.type + '">' + e.text + '</span><span class="tick-sep">///</span>';
  }).join('');
  track.innerHTML = items + items;
  track.style.animation = 'none';
  void track.offsetHeight;
  var dur = Math.max(15, tickerEvents.length * 1.5);
  track.style.animation = 'tickerScroll ' + dur + 's linear infinite';
}

function buildTickerFromState(flags) {
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
var orchestratorUrl = null; // SSE proxied through dashboard server — no direct browser→orchestrator

function connectSSE() {
  try {
    var evtUrl = (orchestratorUrl || '') + '/api/events';
    var es = new EventSource(evtUrl);
    es.onopen = function() {
      console.log('[SSE] Connected to', evtUrl);
      addRunLogEvent('system', 'dashboard stream connected', '', 'sse-open:' + Date.now(), Date.now());
    };
    es.addEventListener('state', function(e) {
      try {
        var d = JSON.parse(e.data);
        syncRunLogFromState(d);
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
    es.onerror = function() {
      addRunLogEvent('error', 'dashboard stream disconnected; reconnecting', '', 'sse-error:' + Date.now(), Date.now());
      es.close();
      setTimeout(connectSSE, 5000);
    };
  } catch(err) {}
}

// =========================================================================
// Polling loop
// =========================================================================
var ctfStartTime = null;

async function pollState() {
  try {
    var stateRes = await fetch('/api/state').then(function(r) { return r.json(); });
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
    renderChallengeGrid(stateRes);
    drawConvergenceChart(stateRes);
    buildTickerFromState(stateRes.flags || []);
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
