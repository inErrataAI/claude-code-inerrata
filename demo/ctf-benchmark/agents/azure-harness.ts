#!/usr/bin/env tsx
/**
 * agents/azure-harness.ts -- Azure OpenAI agent harness for the CTF benchmark.
 *
 * Spawned by the orchestrator as a subprocess for runtime='azure-openai' agents.
 * Mimics the relevant subset of the `claude` CLI interface so the orchestrator
 * can spawn it the same way and parse its output via parseStreamJson.
 *
 * CLI:
 *   tsx azure-harness.ts \
 *     --max-turns 35 \
 *     --mcp-config /path/to/.mcp.json \
 *     --system-prompt "..." \
 *     -p "user message" \
 *     --model gpt-5.4-nano
 *
 * Stream-json output (one JSON object per line, matches parseStreamJson):
 *   {"type":"assistant","message":{"content":[{"type":"text","text":"..."}]}}
 *   {"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{...}}]}}
 *   {"type":"tool_result","content":[{"type":"text","text":"..."}]}
 *   {"type":"result","content":[{"type":"text","text":"final"}]}
 *
 * Env (typically loaded from ../errata/.env):
 *   AZURE_OPENAI_API_KEY        required
 *   AZURE_OPENAI_ENDPOINT       required (e.g. https://errata.openai.azure.com/)
 *   AZURE_OPENAI_API_VERSION    optional (default 2024-10-21)
 */

import { parseArgs } from 'node:util';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { AzureOpenAI, OpenAI } from 'openai';
import { GoogleAuth } from 'google-auth-library';
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
  ChatCompletionMessageToolCall,
} from 'openai/resources/chat/completions';

// ---------------------------------------------------------------------------
// Env bootstrap -- try a few well-known locations for a `.env` with Azure creds.
// process.loadEnvFile is Node 21+. Silent if no candidate exists.
// ---------------------------------------------------------------------------

function loadEnv(): string | null {
  const here = typeof import.meta.dirname === 'string'
    ? import.meta.dirname
    : dirname(fileURLToPath(import.meta.url));
  const candidates = [
    process.env.CTF_ENV_FILE,
    resolve(process.cwd(), '.env'),
    resolve(here, '../../../.env'),
    resolve(here, '../../../../errata/.env'),
    resolve(here, '../../../../../errata/.env'),
  ].filter((v): v is string => typeof v === 'string');

  const loadEnvFile = (process as { loadEnvFile?: (p: string) => void }).loadEnvFile;
  if (!loadEnvFile) return null;

  for (const p of candidates) {
    try {
      if (existsSync(p)) {
        loadEnvFile(p);
        return p;
      }
    } catch {
      /* try next */
    }
  }
  return null;
}

loadEnv();

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

const { values } = parseArgs({
  options: {
    'max-turns': { type: 'string', default: '35' },
    'mcp-config': { type: 'string' },
    'system-prompt': { type: 'string' },
    p: { type: 'string', short: 'p' },
    model: { type: 'string' },
  },
  strict: false,
});

const maxTurns = Math.max(1, parseInt(String(values['max-turns'] ?? '35'), 10) || 35);
const systemPrompt = String(values['system-prompt'] ?? '');
const userPrompt = String(values.p ?? '');
const model = String(values.model ?? process.env.AZURE_OPENAI_DEPLOYMENT_HAIKU ?? 'gpt-5.4-nano');
const mcpConfigPath = typeof values['mcp-config'] === 'string' ? values['mcp-config'] : undefined;

// ---------------------------------------------------------------------------
// Stream-json emission (matches parseStreamJson in orchestrator.ts)
// ---------------------------------------------------------------------------

function emit(line: object): void {
  process.stdout.write(JSON.stringify(line) + '\n');
}

function emitText(text: string): void {
  if (!text) return;
  emit({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
}

function emitToolUse(name: string, input: unknown): void {
  emit({ type: 'assistant', message: { content: [{ type: 'tool_use', name, input }] } });
}

/**
 * Live token-usage breadcrumb. Emitted after each model turn so the
 * orchestrator can drain the HP bar in real time instead of waiting for the
 * final `result` event (which used to be the only place sessionUsage shipped).
 */
function emitUsage(used: number, budget: number): void {
  emit({ type: 'usage', sessionUsage: { used, budget } });
}

function emitToolResult(text: string): void {
  emit({ type: 'tool_result', content: [{ type: 'text', text }] });
}

/**
 * Parse any <chat>...</chat> blocks the model wrote in its assistant text
 * and emit them as cosmetic dashboard events. Keeps lines short for the
 * pixelated chat bubble. Returns the assistant text with chat blocks
 * stripped so they don't pollute the scoring path.
 */
function extractChatLines(text: string): { stripped: string; chats: string[] } {
  if (!text || text.indexOf('<chat>') < 0) return { stripped: text, chats: [] };
  const chats: string[] = [];
  const stripped = text.replace(/<chat>([\s\S]{1,200}?)<\/chat>/gi, (_, line) => {
    const trimmed = String(line).replace(/\s+/g, ' ').trim();
    if (trimmed) chats.push(trimmed.slice(0, 120));
    return '';
  }).replace(/\n{3,}/g, '\n\n');
  return { stripped, chats };
}

function emitAgentChat(line: string): void {
  emit({ type: 'agent_chat', text: line, ts: Date.now() });
}

// ---------------------------------------------------------------------------
// MCP HTTP client (StreamableHTTP transport, JSON-RPC over POST)
// ---------------------------------------------------------------------------

interface McpServer {
  name: string;
  url: string;
  headers: Record<string, string>;
  sessionId?: string;
  rpcId: number;
}

interface McpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

async function mcpRpc(server: McpServer, method: string, params?: unknown): Promise<{ result?: any; error?: { code: number; message: string } }> {
  server.rpcId += 1;
  const headers: Record<string, string> = {
    ...server.headers,
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  };
  if (server.sessionId) headers['Mcp-Session-Id'] = server.sessionId;

  const res = await fetch(server.url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', method, id: server.rpcId, params }),
  });

  const newSession = res.headers.get('mcp-session-id');
  if (newSession && !server.sessionId) server.sessionId = newSession;

  const ct = res.headers.get('content-type') ?? '';
  if (ct.includes('text/event-stream')) {
    const text = await res.text();
    const dataLine = text.split('\n').find(l => l.startsWith('data: '));
    if (!dataLine) throw new Error(`MCP ${method}: empty SSE response`);
    return JSON.parse(dataLine.slice(6));
  }
  if (!res.ok) {
    return { error: { code: res.status, message: await res.text() } };
  }
  return (await res.json()) as { result?: any; error?: { code: number; message: string } };
}

async function mcpNotify(server: McpServer, method: string, params?: unknown): Promise<void> {
  const headers: Record<string, string> = {
    ...server.headers,
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  };
  if (server.sessionId) headers['Mcp-Session-Id'] = server.sessionId;

  await fetch(server.url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', method, params }),
  });
}

async function mcpInitializeAndList(server: McpServer): Promise<McpTool[]> {
  const initRes = await mcpRpc(server, 'initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'ctf-azure-harness', version: '0.1' },
  });
  if (initRes.error) throw new Error(`MCP init failed: ${initRes.error.message}`);
  await mcpNotify(server, 'notifications/initialized');

  const listRes = await mcpRpc(server, 'tools/list');
  if (listRes.error) throw new Error(`MCP tools/list failed: ${listRes.error.message}`);
  const tools = (listRes.result as { tools?: McpTool[] } | undefined)?.tools ?? [];
  return tools;
}

async function mcpCallTool(server: McpServer, name: string, args: unknown): Promise<string> {
  try {
    const res = await mcpRpc(server, 'tools/call', { name, arguments: args ?? {} });
    if (res.error) return `Error from ${server.name}.${name}: ${res.error.message}`;
    const content = (res.result as { content?: Array<{ text?: string; type?: string }> } | undefined)?.content ?? [];
    return content.map(c => c.text ?? JSON.stringify(c)).join('\n') || '(empty result)';
  } catch (err) {
    return `Error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

// ---------------------------------------------------------------------------
// Built-in tools
// ---------------------------------------------------------------------------

const BUILTIN_TOOLS: ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'Bash',
      description:
        'Run a shell command in the current working directory. Use for navigation, grep, find, sed, cat, git, etc. Output truncated at 16 KiB.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The shell command to run.' },
          timeout_ms: { type: 'number', description: 'Optional timeout in ms (default 60000).' },
        },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'Read',
      description: 'Read a file with optional line offset and limit.',
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string' },
          offset: { type: 'number', description: 'Line number to start from (1-indexed).' },
          limit: { type: 'number', description: 'Max lines to read (default 2000).' },
        },
        required: ['file_path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'WebFetch',
      description:
        'Fetch a public URL and return its text content (HTML stripped to readable text). Use for CVE advisory pages (cve.mitre.org, nvd.nist.gov), vendor security bulletins, upstream commit/issue pages, language/library docs. Output truncated to ~15 KiB. Matches the WebFetch tool that Claude lanes already have, so all parties see the same surface.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'The http(s) URL to fetch.' },
          prompt: { type: 'string', description: 'Optional. Not used here; accepted for Claude-tool compatibility.' },
        },
        required: ['url'],
      },
    },
  },
];

// Ring buffer of recent commands to detect tight loops where the model keeps
// re-issuing identical shell calls (seen heavily on gemini-2-5-flash variants
// running 200+ near-duplicate greps). When a hit shows up, refuse with a
// short instruction so the model has to pick a different approach instead of
// burning the token budget.
const RECENT_BASH_RING = 3;
const recentBashCommands: string[] = [];

// On Windows, spawnSync({ shell: true }) launches cmd.exe, which doesn't
// understand POSIX pipelines, quoting, or tools like `grep`. If Git for
// Windows is installed, its bash.exe gives us a real shell. Probe once per
// process and cache the resolved path.
const WIN_BASH_PATH: string | null = (() => {
  if (process.platform !== 'win32') return null;
  const candidates = [
    process.env.CTF_BASH_PATH,
    'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files (x86)\\Git\\usr\\bin\\bash.exe',
  ].filter((v): v is string => typeof v === 'string' && v.length > 0);
  for (const p of candidates) {
    try { if (existsSync(p)) return p; } catch { /* keep looking */ }
  }
  return null;
})();

function runBash(args: Record<string, unknown>): string {
  const cmd = String(args.command ?? '').trim();
  const timeout = Math.max(1_000, Number(args.timeout_ms ?? 60_000) || 60_000);
  if (!cmd) return 'Error: empty command';

  // Duplicate guard: identical command in the last RECENT_BASH_RING calls.
  // Whitespace-normalized comparison so trivial reformatting still trips it.
  const norm = cmd.replace(/\s+/g, ' ');
  if (recentBashCommands.includes(norm)) {
    return `Error: this exact bash command was already run in the last ${RECENT_BASH_RING} turns and produced no new information. Try a different file, regex, or tool (Read, mcp__inerrata__search, WebSearch) instead of repeating it.`;
  }
  recentBashCommands.push(norm);
  if (recentBashCommands.length > RECENT_BASH_RING) recentBashCommands.shift();

  // Prefer real bash on Windows so POSIX pipelines / quoting work the same
  // way as on Linux. spawnSync(file, args) bypasses cmd.exe entirely.
  let result;
  if (WIN_BASH_PATH) {
    result = spawnSync(WIN_BASH_PATH, ['-c', cmd], {
      timeout,
      encoding: 'utf-8',
      maxBuffer: 16 * 1024 * 1024,
    });
  } else {
    result = spawnSync(cmd, {
      shell: true,
      timeout,
      encoding: 'utf-8',
      maxBuffer: 16 * 1024 * 1024,
    });
  }
  let out = '';
  if (result.stdout) out += result.stdout;
  if (result.stderr) out += (out ? '\n' : '') + result.stderr;
  if (result.error) out += `\n${result.error.message}`;
  if (result.status !== 0 && !out) out = `(exit ${result.status ?? 'unknown'})`;
  if (out.length > 16_000) out = `${out.slice(0, 16_000)}\n... [truncated, ${out.length - 16_000} more bytes]`;
  return out || `(exit ${result.status ?? 0})`;
}

function runRead(args: Record<string, unknown>): string {
  const fp = String(args.file_path ?? '');
  if (!fp) return 'Error: file_path required';
  if (!existsSync(fp)) return `Error: file not found: ${fp}`;
  try {
    const stat = statSync(fp);
    if (stat.size > 5_000_000) return `Error: file too large (${stat.size} bytes)`;
  } catch {
    return `Error: cannot stat ${fp}`;
  }
  const text = readFileSync(fp, 'utf-8');
  const lines = text.split('\n');
  const offset = Math.max(0, Math.floor(Number(args.offset ?? 1)) - 1);
  const limit = Math.max(1, Math.floor(Number(args.limit ?? 2000)));
  const slice = lines.slice(offset, offset + limit);
  let out = slice.map((l, i) => `${(offset + i + 1).toString().padStart(5)}\t${l}`).join('\n');
  if (out.length > 16_000) out = `${out.slice(0, 16_000)}\n... [truncated]`;
  return out || '(empty file)';
}

// ---------------------------------------------------------------------------
// WebFetch -- fetch a URL and return text content. Matches the shape of
// Claude's built-in WebFetch so all parties (Claude via CLI, GPT/Gemini via
// this harness) expose the same surface to the model. No search engine is
// wired in by design -- the agent picks URLs (CVE pages, NVD, vendor
// advisories) from context. Cap response at ~15 KiB.
// ---------------------------------------------------------------------------
async function runWebFetch(args: Record<string, unknown>): Promise<string> {
  const rawUrl = String(args.url ?? '').trim();
  if (!rawUrl) return 'Error: url required';
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return `Error: invalid url: ${rawUrl}`;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return `Error: only http(s) URLs are allowed, got ${url.protocol}`;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const res = await fetch(url.toString(), {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': 'ctf-bench-webfetch/1.0 (+https://inerrata.ai)',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    });
    const ct = res.headers.get('content-type') || '';
    let body = await res.text();
    // Strip HTML tags / scripts / styles for readability; preserve text only.
    if (/html|xml/i.test(ct) || /^<!doctype html|<html/i.test(body)) {
      body = body
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<!--[\s\S]*?-->/g, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/gi, "'")
        .replace(/[ \t]+/g, ' ')
        .replace(/\n[\s\n]+/g, '\n\n')
        .trim();
    }
    const header = `[${res.status} ${res.statusText}] ${url.toString()}\n`;
    let out = header + body;
    if (out.length > 15_000) out = out.slice(0, 15_000) + `\n... [truncated, ${out.length - 15_000} more bytes]`;
    return out || `(empty body, status ${res.status})`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `Error fetching ${url.toString()}: ${msg}`;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Azure OpenAI client
// ---------------------------------------------------------------------------

function azureClient(): AzureOpenAI {
  const apiKey = process.env.AZURE_OPENAI_API_KEY;
  const endpoint = process.env.AZURE_OPENAI_ENDPOINT;
  const apiVersion = process.env.AZURE_OPENAI_API_VERSION ?? '2024-10-21';
  if (!apiKey || !endpoint) {
    throw new Error(
      'Azure OpenAI requires AZURE_OPENAI_API_KEY and AZURE_OPENAI_ENDPOINT in env. ' +
        'Source ../errata/.env or pass via CTF_ENV_FILE.',
    );
  }
  return new AzureOpenAI({ apiKey, endpoint, apiVersion, deployment: model });
}

// ---------------------------------------------------------------------------
// Google Vertex AI client (Gemini via OpenAI-compat endpoint + service account)
// ---------------------------------------------------------------------------

const IS_VERTEX = !!process.env.VERTEX_SERVICE_ACCOUNT_PATH;
const VERTEX_PROJECT = process.env.VERTEX_PROJECT ?? '';
const VERTEX_LOCATION = process.env.VERTEX_LOCATION ?? 'us-central1';

let vertexAuth: GoogleAuth | null = null;
function getVertexAuth(): GoogleAuth {
  if (vertexAuth) return vertexAuth;
  vertexAuth = new GoogleAuth({
    keyFile: process.env.VERTEX_SERVICE_ACCOUNT_PATH,
    scopes: ['https://www.googleapis.com/auth/cloud-platform'],
  });
  return vertexAuth;
}

async function vertexAccessToken(): Promise<string> {
  const client = await getVertexAuth().getClient();
  const token = await client.getAccessToken();
  if (!token || !token.token) throw new Error('Vertex auth: failed to acquire access token');
  return token.token;
}

async function vertexClient(): Promise<OpenAI> {
  if (!VERTEX_PROJECT) throw new Error('VERTEX_PROJECT env var required for google-vertex runtime');
  const token = await vertexAccessToken();
  const baseURL = `https://${VERTEX_LOCATION}-aiplatform.googleapis.com/v1beta1/projects/${VERTEX_PROJECT}/locations/${VERTEX_LOCATION}/endpoints/openapi`;
  return new OpenAI({ apiKey: token, baseURL });
}

/**
 * Retry an async function with exponential backoff on 429/503 errors.
 * Gemini's free-tier rate limits make this essential.
 */
async function withGeminiRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {
  const maxAttempts = 6;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const status = (err as { status?: number }).status;
      const isRateLimited = status === 429 || status === 503 || /rate.?limit|quota|RESOURCE_EXHAUSTED|UNAVAILABLE/i.test(msg);
      if (!isRateLimited || attempt === maxAttempts) throw err;
      const baseMs = Math.min(60_000, 1000 * Math.pow(2, attempt - 1));
      const jitter = Math.floor(Math.random() * 1000);
      const delay = baseMs + jitter;
      process.stderr.write(`[azure-harness] ${label} rate-limited (attempt ${attempt}/${maxAttempts}); backing off ${Math.round(delay / 1000)}s\n`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw new Error(`unreachable`);
}

function mcpToolToOpenAITool(mcpTool: McpTool, fullName: string): ChatCompletionTool {
  const schema =
    mcpTool.inputSchema && typeof mcpTool.inputSchema === 'object'
      ? mcpTool.inputSchema
      : { type: 'object', properties: {} };
  return {
    type: 'function',
    function: {
      name: fullName,
      description: mcpTool.description ?? `MCP tool ${fullName}`,
      parameters: schema as Record<string, unknown>,
    },
  };
}

// ---------------------------------------------------------------------------
// Main ReAct loop
// ---------------------------------------------------------------------------

async function loadMcpTools(): Promise<{
  tools: ChatCompletionTool[];
  call: (name: string, args: Record<string, unknown>) => Promise<string>;
}> {
  const tools: ChatCompletionTool[] = [];
  const map = new Map<string, { server: McpServer; toolName: string }>();

  if (!mcpConfigPath || !existsSync(mcpConfigPath)) {
    return { tools, call: async () => 'Error: no MCP server configured' };
  }

  let cfg: { mcpServers?: Record<string, { type?: string; url?: string; headers?: Record<string, string> }> };
  try {
    cfg = JSON.parse(readFileSync(mcpConfigPath, 'utf-8'));
  } catch (err) {
    process.stderr.write(`[azure-harness] bad mcp config ${mcpConfigPath}: ${err}\n`);
    return { tools, call: async () => 'Error: bad MCP config' };
  }

  for (const [name, entry] of Object.entries(cfg.mcpServers ?? {})) {
    if (!entry || entry.type !== 'http' || !entry.url) continue;
    const server: McpServer = {
      name,
      url: entry.url,
      headers: entry.headers ?? {},
      rpcId: 0,
    };
    try {
      const mcpTools = await mcpInitializeAndList(server);
      for (const t of mcpTools) {
        const fullName = `mcp__${name}__${t.name}`;
        tools.push(mcpToolToOpenAITool(t, fullName));
        map.set(fullName, { server, toolName: t.name });
      }
    } catch (err) {
      process.stderr.write(`[azure-harness] MCP server ${name} init failed: ${err}\n`);
    }
  }

  return {
    tools,
    call: async (name, args) => {
      const entry = map.get(name);
      if (!entry) return `Error: unknown MCP tool ${name}`;
      return mcpCallTool(entry.server, entry.toolName, args);
    },
  };
}

// ---------------------------------------------------------------------------
// Responses API translation helpers
// ---------------------------------------------------------------------------
//
// The Responses API (newer Azure endpoint, e.g. gpt-5.4-pro) takes a
// flatter input array and a slightly different tool spec than chat.completions.
// We keep the internal state in chat.completions shape (`messages`) and
// translate at the boundary.

interface ResponsesTool {
  type: 'function';
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
}

type ResponsesInputItem =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string }
  | { type: 'function_call'; call_id: string; name: string; arguments: string }
  | { type: 'function_call_output'; call_id: string; output: string };

function chatToolsToResponsesTools(chatTools: ChatCompletionTool[]): ResponsesTool[] {
  return chatTools
    .filter(t => t.type === 'function')
    .map(t => ({
      type: 'function' as const,
      name: t.function.name,
      description: t.function.description,
      parameters: t.function.parameters as Record<string, unknown> | undefined,
    }));
}

function messagesToResponsesInput(
  messages: ChatCompletionMessageParam[],
): { instructions: string; input: ResponsesInputItem[] } {
  const items: ResponsesInputItem[] = [];
  let instructions = '';

  for (const msg of messages) {
    if (msg.role === 'system') {
      instructions = typeof msg.content === 'string' ? msg.content : '';
    } else if (msg.role === 'user') {
      items.push({ role: 'user', content: typeof msg.content === 'string' ? msg.content : '' });
    } else if (msg.role === 'assistant') {
      const text = typeof msg.content === 'string' ? msg.content : '';
      if (text) items.push({ role: 'assistant', content: text });
      const toolCalls = (msg as { tool_calls?: ChatCompletionMessageToolCall[] }).tool_calls ?? [];
      for (const tc of toolCalls) {
        if (tc.type === 'function') {
          items.push({
            type: 'function_call',
            call_id: tc.id,
            name: tc.function.name,
            arguments: tc.function.arguments,
          });
        }
      }
    } else if (msg.role === 'tool') {
      items.push({
        type: 'function_call_output',
        call_id: (msg as { tool_call_id: string }).tool_call_id,
        output: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
      });
    }
  }

  return { instructions, input: items };
}

interface ResponsesOutputCall {
  call_id: string;
  name: string;
  arguments: string;
}

interface ResponsesOutputParsed {
  text: string;
  toolCalls: ResponsesOutputCall[];
}

function parseResponsesOutput(output: unknown): ResponsesOutputParsed {
  const items = Array.isArray(output) ? output : [];
  const textParts: string[] = [];
  const toolCalls: ResponsesOutputCall[] = [];

  for (const raw of items) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as {
      type?: string;
      role?: string;
      content?: unknown;
      call_id?: string;
      name?: string;
      arguments?: string;
    };
    if (item.type === 'message' && item.role === 'assistant' && Array.isArray(item.content)) {
      for (const c of item.content) {
        if (!c || typeof c !== 'object') continue;
        const chunk = c as { type?: string; text?: string };
        if ((chunk.type === 'output_text' || chunk.type === 'text') && typeof chunk.text === 'string') {
          textParts.push(chunk.text);
        }
      }
    } else if (item.type === 'function_call' && typeof item.call_id === 'string' && typeof item.name === 'string') {
      toolCalls.push({
        call_id: item.call_id,
        name: item.name,
        arguments: typeof item.arguments === 'string' ? item.arguments : '{}',
      });
    }
    // Ignore: 'reasoning' (hidden chain-of-thought summaries)
  }

  return { text: textParts.join('\n'), toolCalls };
}

// ---------------------------------------------------------------------------
// Main ReAct loop -- chat.completions or responses, dispatched on env style
// ---------------------------------------------------------------------------

function formatBudget(used: number, budget: number): string {
  const remaining = Math.max(0, budget - used);
  const pct = budget > 0 ? Math.round((used / budget) * 100) : 0;
  return `[CTF Budget: ${remaining.toLocaleString()} / ${budget.toLocaleString()} tokens remaining (${pct}% spent)]`;
}

function readUsage(response: unknown): number {
  if (!response || typeof response !== 'object') return 0;
  const u = (response as { usage?: { total_tokens?: number; input_tokens?: number; output_tokens?: number; prompt_tokens?: number; completion_tokens?: number } }).usage;
  if (!u) return 0;
  if (typeof u.total_tokens === 'number') return u.total_tokens;
  return (u.prompt_tokens ?? u.input_tokens ?? 0) + (u.completion_tokens ?? u.output_tokens ?? 0);
}

async function main(): Promise<void> {
  const rawStyle = process.env.AZURE_OPENAI_API_STYLE;
  const apiStyle: 'responses' | 'chat-completions' | 'vertex' =
    rawStyle === 'responses' ? 'responses' : rawStyle === 'vertex' ? 'vertex' : 'chat-completions';
  const { tools: mcpTools, call: callMcp } = await loadMcpTools();
  const allTools: ChatCompletionTool[] = [...BUILTIN_TOOLS, ...mcpTools];

  // The OpenAI SDK shape works for Azure Chat Completions AND Vertex AI
  // OpenAI-compat. Pick the right client.
  const client = apiStyle === 'vertex' ? await vertexClient() : azureClient();

  const sessionBudget = Math.max(
    1024,
    parseInt(process.env.CTF_TOKEN_BUDGET ?? '200000', 10) || 200000,
  );
  let sessionTokensUsed = 0;

  const messages: ChatCompletionMessageParam[] = [
    {
      role: 'system',
      content: `${systemPrompt}

## Token Budget
You have a session token budget of ${sessionBudget.toLocaleString()} tokens. After each
tool round you'll see a "[CTF Budget: X / Y tokens remaining]" line at the
end of the tool result. When you near the budget, wrap up and emit your
best <finding> block. The run terminates when the budget is exhausted.`,
    },
    { role: 'user', content: userPrompt },
  ];

  const perCallMaxTokens = parseInt(process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS ?? '8192', 10) || 8192;

  let lastAssistantText = '';
  let turn = 0;

  while (turn < maxTurns) {
    if (sessionTokensUsed >= sessionBudget) {
      emitText(`[Token budget exhausted (${sessionTokensUsed.toLocaleString()} / ${sessionBudget.toLocaleString()}); ending agent run before turn ${turn + 1}.]`);
      break;
    }
    turn += 1;

    let assistantText = '';
    let toolCallsForLoop: Array<{ call_id: string; name: string; arguments: string }> = [];

    if (apiStyle === 'responses') {
      // ----- Responses API path -----
      const responsesTools = chatToolsToResponsesTools(allTools);
      const { instructions, input } = messagesToResponsesInput(messages);
      let resp;
      try {
        resp = await client.responses.create({
          model,
          input,
          instructions,
          tools: responsesTools.length > 0 ? responsesTools : undefined,
          max_output_tokens: perCallMaxTokens,
        } as Parameters<typeof client.responses.create>[0]);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // Surface to BOTH stderr AND a structured stream event so the
        // orchestrator and any tail of the ndjson can see why the lane is
        // stuck (4xx/5xx, version mismatch, rate limit, etc).
        process.stderr.write(`[azure-harness] Responses error turn ${turn}: ${msg}\n`);
        emit({ type: 'system', subtype: 'azure_error', message: msg, turn });
        break;
      }
      sessionTokensUsed += readUsage(resp);
      emitUsage(sessionTokensUsed, sessionBudget);
      const parsed = parseResponsesOutput((resp as { output?: unknown }).output);
      assistantText = parsed.text;
      toolCallsForLoop = parsed.toolCalls;

      if (assistantText) {
        const { stripped, chats } = extractChatLines(assistantText);
        for (const c of chats) emitAgentChat(c);
        assistantText = stripped;
        if (stripped) emitText(stripped);
        lastAssistantText = stripped;
      }

      if (toolCallsForLoop.length === 0) break;

      messages.push({
        role: 'assistant',
        content: assistantText,
        tool_calls: toolCallsForLoop.map(tc => ({
          id: tc.call_id,
          type: 'function' as const,
          function: { name: tc.name, arguments: tc.arguments },
        })),
      });
    } else {
      // ----- chat.completions path (azure + vertex share this shape) -----
      // Vertex AI uses Gemini behind the OpenAI-compat endpoint. Model ids
      // for Vertex are prefixed with "google/", e.g. "google/gemini-2.5-pro".
      // Wrap calls in retry on 429/503 for Gemini's stingy rate limits.
      const runOnce = (opts: { useLegacyMaxTokens: boolean }) =>
        client.chat.completions.create({
          model,
          messages,
          tools: allTools.length > 0 ? allTools : undefined,
          tool_choice: allTools.length > 0 ? 'auto' : undefined,
          ...(opts.useLegacyMaxTokens
            ? { max_tokens: perCallMaxTokens }
            : { max_completion_tokens: perCallMaxTokens }),
          stream: false,
        });
      let response;
      try {
        if (apiStyle === 'vertex') {
          response = await withGeminiRetry(() => runOnce({ useLegacyMaxTokens: false }), `vertex turn ${turn}`);
        } else {
          response = await runOnce({ useLegacyMaxTokens: false });
        }
      } catch (err) {
        const msgErr = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[azure-harness] OpenAI error turn ${turn}: ${msgErr}\n`);
        if (msgErr.includes('max_completion_tokens')) {
          try {
            response = apiStyle === 'vertex'
              ? await withGeminiRetry(() => runOnce({ useLegacyMaxTokens: true }), `vertex turn ${turn} fallback`)
              : await runOnce({ useLegacyMaxTokens: true });
          } catch (err2) {
            process.stderr.write(`[azure-harness] fallback failed: ${err2 instanceof Error ? err2.message : String(err2)}\n`);
            break;
          }
        } else {
          break;
        }
      }

      sessionTokensUsed += readUsage(response);
      emitUsage(sessionTokensUsed, sessionBudget);
      const choice = response.choices[0];
      const msg = choice?.message;
      if (!msg) break;
      assistantText = msg.content ?? '';
      const tcs: ChatCompletionMessageToolCall[] = msg.tool_calls ?? [];
      toolCallsForLoop = tcs
        .filter(tc => tc.type === 'function')
        .map(tc => ({ call_id: tc.id, name: tc.function.name, arguments: tc.function.arguments }));

      if (assistantText) {
        const { stripped, chats } = extractChatLines(assistantText);
        for (const c of chats) emitAgentChat(c);
        assistantText = stripped;
        if (stripped) emitText(stripped);
        lastAssistantText = stripped;
      }
      if (toolCallsForLoop.length === 0) break;

      messages.push({
        role: 'assistant',
        content: assistantText,
        tool_calls: tcs,
      });
    }

    // ----- Common: dispatch tool calls (same for both APIs) -----
    for (const call of toolCallsForLoop) {
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(call.arguments || '{}');
      } catch {
        args = {};
      }
      emitToolUse(call.name, args);

      let result: string;
      if (call.name === 'Bash') {
        result = runBash(args);
      } else if (call.name === 'Read') {
        result = runRead(args);
      } else if (call.name === 'WebFetch') {
        result = await runWebFetch(args);
      } else if (call.name.startsWith('mcp__')) {
        result = await callMcp(call.name, args);
      } else {
        result = `Error: unknown tool ${call.name}`;
      }
      const annotated = `${result}\n\n---\n${formatBudget(sessionTokensUsed, sessionBudget)}`;
      emitToolResult(annotated);

      messages.push({
        role: 'tool',
        tool_call_id: call.call_id,
        content: annotated,
      });
    }
  }

  emit({
    type: 'result',
    content: [{ type: 'text', text: lastAssistantText }],
    sessionUsage: { used: sessionTokensUsed, budget: sessionBudget },
  });
}

main().catch(err => {
  process.stderr.write(`[azure-harness] fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
