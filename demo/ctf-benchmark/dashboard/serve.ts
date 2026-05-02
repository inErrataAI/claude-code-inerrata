#!/usr/bin/env tsx
/**
 * CTF Benchmark Live Dashboard Server
 *
 * Serves a real-time visualization of benchmark runs showing three AI agents
 * (Opus Wizard, Sonnet Bard, Haiku Rogue) hunting CVEs in GNU C source repos.
 *
 * Primary visualization: convergence chart showing how cheap models catch up
 * when given a knowledge graph (warm wave vs cold wave).
 *
 * Usage:
 *   npx tsx dashboard/serve.ts --output <benchmark-output-file> [--port 5555]
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
<title>GNU SECURITY AUDIT -- CTF BENCHMARK</title>
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

.section { margin-bottom: 10px; }
.section-header {
  font-size:7px; color:var(--pink); letter-spacing:2px; text-transform:uppercase;
  padding:4px 8px; background:rgba(10,10,15,0.85); border-bottom:1px solid var(--dim);
  margin-bottom:6px; display:flex; align-items:center; gap:8px;
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
  width:100%; height:55vh; min-height:350px; max-height:600px;
  display:block; background:var(--bg2); border:1px solid var(--dim); border-radius:2px;
}
#convergence-overlay {
  position:relative; margin-top:-40px; text-align:center; pointer-events:none; z-index:2;
  height:40px;
}
#compound-flash {
  font-size:11px; color:var(--neon); letter-spacing:2px;
  text-shadow:0 0 12px var(--neon), 0 0 24px rgba(0,255,136,0.4);
  opacity:0; transition: opacity 0.5s;
}
#compound-flash.visible { opacity:1; animation: flashPulse 1.5s ease-in-out infinite; }
@keyframes flashPulse {
  0%,100% { opacity:1; }
  50% { opacity:0.5; }
}
#comparison-panel {
  margin-top:6px; display:grid; grid-template-columns:repeat(auto-fit,minmax(180px,1fr)); gap:6px;
}
.wave-card {
  border:1px solid var(--dim); background:rgba(14,14,24,0.92); padding:8px; min-height:58px;
}
.wave-card .wave-title { font-size:7px; color:var(--cyan); margin-bottom:6px; }
.wave-card .wave-meta { font-size:6px; color:var(--muted); line-height:1.8; }
.wave-card .wave-score { font-size:12px; color:var(--gold); margin-top:4px; }
.auth-badge { color:var(--neon); }
.roi-card { border-color:var(--gold); }

/* =========================================================================
   AGENT CARDS
   ========================================================================= */
#agents-row { display:flex; gap:8px; flex-wrap:wrap; }
.agent-card {
  flex:1; min-width:240px; background:var(--bg2); border:1px solid var(--dim);
  border-radius:2px; padding:12px; transition: all 0.3s; position:relative; overflow:hidden;
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

.agent-top { display:flex; align-items:center; gap:10px; margin-bottom:8px; }
.agent-sprite { flex-shrink:0; image-rendering:pixelated; }
.agent-name { font-size:10px; font-weight:bold; }
.agent-model { font-size:7px; color:var(--muted); }
.agent-status-dot { width:8px; height:8px; border-radius:50%; margin-left:auto; flex-shrink:0; }
.dot-running { background:var(--neon); box-shadow:0 0 6px var(--neon); }
.dot-throttled { background:var(--gold); box-shadow:0 0 6px var(--gold); }
.dot-finished { background:#555; }
.dot-idle { background:#333; }
.dot-failed { background:var(--pink); box-shadow:0 0 6px var(--pink); }

.agent-scores { display:flex; gap:12px; margin-top:6px; flex-wrap:wrap; }
.agent-score-block { }
.agent-score-label { font-size:6px; color:var(--muted); text-transform:uppercase; letter-spacing:1px; }
.agent-score-val { font-size:14px; font-weight:bold; }
.agent-score-val.pts { color:var(--pink); }
.agent-score-val.flags { color:var(--gold); }
.agent-score-val.improve { color:var(--neon); }
.agent-score-val.graph { color:var(--purple); }

.agent-current { font-size:7px; color:var(--cyan); margin-top:6px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.agent-wave-scores { font-size:7px; color:var(--muted); margin-top:4px; }
.flag-icons { color:var(--gold); font-size:8px; margin-top:4px; }

/* =========================================================================
   CHALLENGE GRID
   ========================================================================= */
#challenge-grid {
  display:flex; gap:6px; overflow-x:auto; padding-bottom:6px;
}
#challenge-grid::-webkit-scrollbar { height:4px; }
#challenge-grid::-webkit-scrollbar-thumb { background:var(--dim); border-radius:2px; }

.challenge-card {
  min-width:120px; max-width:140px; background:var(--bg2); border:1px solid var(--dim);
  border-radius:2px; padding:8px; flex-shrink:0;
}
.challenge-cve { font-size:7px; color:var(--cyan); font-weight:bold; letter-spacing:0.5px; }
.challenge-repo { font-size:6px; color:var(--muted); margin-top:2px; }
.challenge-stars { font-size:8px; color:var(--gold); margin-top:3px; letter-spacing:1px; }
.challenge-bars { margin-top:6px; }
.challenge-bar {
  display:flex; align-items:center; gap:4px; margin-bottom:3px; font-size:6px;
}
.challenge-bar-label { width:10px; font-weight:bold; }
.challenge-bar-track { flex:1; height:6px; background:#0a0a14; border:1px solid #1a1a2e; border-radius:1px; overflow:hidden; }
.challenge-bar-fill { height:100%; transition:width 0.5s; border-radius:1px; }
.challenge-bar-pts { width:28px; text-align:right; color:var(--muted); }

/* =========================================================================
   KNOWLEDGE GRAPH (collapsible)
   ========================================================================= */
#graph-section .section-body { overflow:hidden; transition: max-height 0.4s ease; max-height:0; }
#graph-section .section-body.open { max-height:260px; }
#graph-canvas {
  width:100%; height:200px; display:block; background:var(--bg2);
  border:1px solid var(--dim); border-radius:2px;
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
    <h1 class="glow-pink">GNU SECURITY AUDIT CTF</h1>
    <div class="sub">CVE Discovery Benchmark // inErrata Knowledge Graph</div>
  </div>
  <div class="hdr-right">
    <div class="hdr-stat"><div class="val glow-cyan" id="s-run">---</div><div class="lbl">RUN</div></div>
    <div class="hdr-stat"><div class="val" style="color:var(--muted)" id="s-timer">--:--</div><div class="lbl">TIME</div></div>
    <div class="hdr-stat"><div class="val glow-gold" id="s-wave">-</div><div class="lbl">WAVE</div></div>
  </div>
</div>

<!-- Main content -->
<div id="main-content">

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

  <!-- KNOWLEDGE GRAPH (collapsible) -->
  <div class="section" id="graph-section">
    <div class="section-header">
      <span class="toggle-btn" id="graph-toggle">&#9654;</span>
      KNOWLEDGE GRAPH
    </div>
    <div class="section-body" id="graph-body">
      <canvas id="graph-canvas"></canvas>
    </div>
  </div>

  <!-- EVENT TICKER -->
  <div class="section" id="ticker-section">
    <div id="ticker-zone">
      <div id="ticker-label">EVENT LOG</div>
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
  return 'NO TOOLS';
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
};
var AGENT_LABELS = {
  'opus-wizard':  'OPUS',   'opus':  'OPUS',
  'sonnet-bard':  'SONNET', 'sonnet':  'SONNET',
  'haiku-rogue':  'HAIKU',  'haiku':  'HAIKU',
};
function agentColor(id) {
  if (AGENT_COLORS[id]) return AGENT_COLORS[id];
  if (id.startsWith('opus')) return '#9b59b6';
  if (id.startsWith('sonnet')) return '#3498db';
  if (id.startsWith('haiku')) return '#2ecc71';
  return '#888';
}
function agentLabel(id) {
  if (AGENT_LABELS[id]) return AGENT_LABELS[id];
  if (id.startsWith('opus')) return 'OPUS';
  if (id.startsWith('sonnet')) return 'SONNET';
  if (id.startsWith('haiku')) return 'HAIKU';
  return id.slice(0, 10).toUpperCase();
}

// =========================================================================
// Knowledge Graph (collapsible)
// =========================================================================
var graphOpen = false;
document.getElementById('graph-toggle').addEventListener('click', function() {
  graphOpen = !graphOpen;
  this.classList.toggle('open', graphOpen);
  document.getElementById('graph-body').classList.toggle('open', graphOpen);
});

var graphCanvas = document.getElementById('graph-canvas');
var graphCtx = graphCanvas.getContext('2d');
var gNodes = [], gEdges = [];
var noisePattern = null;

var TYPE_COLORS = {
  Solution: '#00ff88', RootCause: '#ff8800', Domain: '#4488ff',
  Vulnerability: '#ff4444', Pattern: '#aa44ff', Exploit: '#ff2222',
};

function createNoisePattern() {
  var c = document.createElement('canvas');
  c.width = 128; c.height = 128;
  var x = c.getContext('2d');
  var img = x.createImageData(128, 128);
  for (var i = 0; i < img.data.length; i += 4) {
    var v = Math.random() * 12;
    img.data[i] = v; img.data[i+1] = v; img.data[i+2] = v + 4; img.data[i+3] = 25;
  }
  x.putImageData(img, 0, 0);
  noisePattern = graphCtx.createPattern(c, 'repeat');
}

function resizeGraphCanvas() {
  var p = document.getElementById('graph-body');
  graphCanvas.width = p.clientWidth || 600;
  graphCanvas.height = 200;
  createNoisePattern();
}
resizeGraphCanvas();
window.addEventListener('resize', resizeGraphCanvas);

function initGraph(nodes, edges) {
  var cx = graphCanvas.width / 2, cy = graphCanvas.height / 2;
  gNodes = nodes.map(function(n) {
    return {
      id: n.id, type: n.type, label: n.label,
      x: cx + (Math.random() - 0.5) * 200,
      y: cy + (Math.random() - 0.5) * 100,
      vx: 0, vy: 0, r: 3 + Math.random() * 2,
    };
  });
  var map = {};
  gNodes.forEach(function(n) { map[n.id] = n; });
  gEdges = edges.filter(function(e) { return map[e.source] && map[e.target]; })
    .map(function(e) { return { source: map[e.source], target: map[e.target], type: e.type }; });
}

function graphSimStep() {
  var cx = graphCanvas.width / 2, cy = graphCanvas.height / 2;
  var N = gNodes.length;
  var repel = Math.min(400, 10000 / (N + 1));
  for (var i = 0; i < N; i++) {
    for (var j = i + 1; j < N; j++) {
      var a = gNodes[i], b = gNodes[j];
      var dx = a.x - b.x, dy = a.y - b.y;
      var d = Math.sqrt(dx*dx + dy*dy) || 1;
      var f = Math.min(repel / (d*d), 3);
      a.vx += dx/d*f; a.vy += dy/d*f;
      b.vx -= dx/d*f; b.vy -= dy/d*f;
    }
  }
  for (var ei = 0; ei < gEdges.length; ei++) {
    var e = gEdges[ei];
    var dx = e.target.x - e.source.x, dy = e.target.y - e.source.y;
    var d = Math.sqrt(dx*dx + dy*dy) || 1;
    var f = (d - 40) * 0.008;
    e.source.vx += dx/d*f; e.source.vy += dy/d*f;
    e.target.vx -= dx/d*f; e.target.vy -= dy/d*f;
  }
  for (var ni = 0; ni < N; ni++) {
    var n = gNodes[ni];
    n.vx += (cx - n.x) * 0.003; n.vy += (cy - n.y) * 0.003;
    n.vx *= 0.88; n.vy *= 0.88;
    n.x += n.vx; n.y += n.vy;
  }
}

function drawGraph() {
  var w = graphCanvas.width, h = graphCanvas.height;
  graphCtx.fillStyle = '#0a0a0f';
  graphCtx.fillRect(0, 0, w, h);
  if (noisePattern) { graphCtx.fillStyle = noisePattern; graphCtx.fillRect(0, 0, w, h); }

  // Edges
  for (var ei = 0; ei < gEdges.length; ei++) {
    var e = gEdges[ei];
    graphCtx.beginPath();
    graphCtx.moveTo(e.source.x, e.source.y);
    graphCtx.lineTo(e.target.x, e.target.y);
    graphCtx.strokeStyle = 'rgba(40,40,80,0.5)';
    graphCtx.lineWidth = 1;
    graphCtx.stroke();
  }

  // Nodes
  for (var ni = 0; ni < gNodes.length; ni++) {
    var n = gNodes[ni];
    var color = TYPE_COLORS[n.type] || '#666';
    // Glow
    var grad = graphCtx.createRadialGradient(n.x, n.y, 0, n.x, n.y, n.r * 3);
    grad.addColorStop(0, color + '22');
    grad.addColorStop(1, 'transparent');
    graphCtx.beginPath(); graphCtx.arc(n.x, n.y, n.r * 3, 0, Math.PI * 2);
    graphCtx.fillStyle = grad; graphCtx.fill();
    // Core
    graphCtx.beginPath(); graphCtx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
    graphCtx.fillStyle = color; graphCtx.fill();
    // Label
    if (gNodes.length < 60) {
      graphCtx.fillStyle = '#444';
      graphCtx.font = '6px monospace';
      graphCtx.fillText((n.label || '').slice(0, 16), n.x + n.r + 3, n.y + 2);
    }
  }

  // Legend
  graphCtx.font = '6px "Press Start 2P", monospace';
  var ly = 14;
  var seen = {};
  gNodes.forEach(function(n) { seen[n.type] = true; });
  for (var type in TYPE_COLORS) {
    if (!seen[type]) continue;
    graphCtx.fillStyle = TYPE_COLORS[type];
    graphCtx.fillRect(6, ly - 3, 5, 5);
    graphCtx.fillStyle = '#444';
    graphCtx.fillText(type, 14, ly);
    ly += 10;
  }
}

function animateGraph() {
  if (graphOpen && gNodes.length > 0) {
    for (var i = 0; i < 3; i++) graphSimStep();
    drawGraph();
  }
  requestAnimationFrame(animateGraph);
}
animateGraph();

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
      var color = agentColor(agentId);
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
        mode: wave.mode,
        label: wave.label || wave.mode,
        auth: wave.auth || wave.mode,
        color: color,
        dashed: isWarm,
        points: cumPts,
        label: (wave.label || agentLabel(agentId)).toUpperCase() + ' [' + authLabel(wave.auth || wave.mode) + ']',
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

  // Check for convergence: Haiku authenticated approaching Opus cold.
  var coldOpus = lineData.find(function(l) { return l.label.indexOf('OPUS-COLD') === 0; });
  var warmHaiku = lineData.find(function(l) { return l.label.indexOf('HAIKU-WARM') === 0; });
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
    var scoreMap = wave.scores || {};
    for (var agentId in scoreMap) {
      var perChallenge = scoreMap[agentId] || {};
      for (var chId in perChallenge) {
        score += perChallenge[chId] || 0;
        if ((perChallenge[chId] || 0) > 0) solved++;
      }
      var a = (state.agents || {})[agentId];
      if (a) graph += a.graphHits || 0;
    }
    html += '<div class="wave-card">'
      + '<div class="wave-title">' + esc(waveDisplay(wave)) + '</div>'
      + '<div class="wave-meta">MODEL ' + esc(String(wave.model || '').toUpperCase()) + ' / <span class="auth-badge">' + authLabel(wave.auth || wave.mode) + '</span></div>'
      + '<div class="wave-meta">GRAPH CALLS ' + graph + '</div>'
      + '<div class="wave-score">' + score + ' PTS</div>'
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
    var spriteSize = charType === 'opus' ? 48 : charType === 'sonnet' ? 44 : 40;
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
    html += '<div class="agent-score-block"><div class="agent-score-label">POINTS</div><div class="agent-score-val pts">' + (a.totalPoints || 0) + '</div></div>';
    html += '<div class="agent-score-block"><div class="agent-score-label">FLAGS</div><div class="agent-score-val flags">' + nFlags + '/' + totalCh + '</div></div>';
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
    es.onopen = function() { console.log('[SSE] Connected to', evtUrl); };
    es.addEventListener('flag_captured', function(e) {
      try {
        var d = JSON.parse(e.data);
        screenShake();
        addTickerEvent('flag', '<span class="tick-agent">[' + esc((d.agentId || '').slice(0,10)) + ']</span> \\u{2691} ' + esc(d.challengeId || '???') + ' <span class="tick-pts">+' + (d.points || 0) + 'pts</span>');
        if (d.agentId) { flashTimers[d.agentId] = true; setTimeout(function() { delete flashTimers[d.agentId]; }, 1500); }
        pollState();
      } catch(err) {}
    });
    es.addEventListener('wave_started', function(e) {
      try {
        var d = JSON.parse(e.data);
        addTickerEvent('contribute', 'WAVE ' + d.wave + ' STARTED: ' + (d.label || '').toUpperCase() + ' / ' + authLabel(d.auth));
      } catch(err) {}
    });
    es.addEventListener('wave_finished', function(e) {
      try { pollState(); } catch(err) {}
    });
    es.onerror = function() { es.close(); setTimeout(connectSSE, 5000); };
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
    renderAgents(stateRes);
    renderChallengeGrid(stateRes);
    drawConvergenceChart(stateRes);
    buildTickerFromState(stateRes.flags || []);
  } catch (e) { console.error('State poll error:', e); }
}

async function pollGraph() {
  try {
    var graphRes = await fetch('/api/graph').then(function(r) { return r.json(); });
    var nodes = graphRes.nodes || [];
    var edges = graphRes.edges || [];
    if (gNodes.length !== nodes.length || nodes.some(function(n) { return !gNodes.find(function(g) { return g.id === n.id; }); })) {
      initGraph(nodes, edges);
    }
  } catch (e) { console.error('Graph poll error:', e); }
}

function updateTimer() {
  if (!ctfStartTime) return;
  var s = Math.floor((Date.now() - ctfStartTime) / 1000);
  document.getElementById('s-timer').textContent =
    Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}

// Start
pollState();
pollGraph();
setInterval(pollState, 1500);
setInterval(pollGraph, 5000);
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
  else console.log('Waiting for orchestrator connection. Pass --orchestrator-url or start the benchmark with: npx tsx benchmark/orchestrator.ts --framing equalization')
})
