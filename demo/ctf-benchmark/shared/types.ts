/**
 * shared/types.ts -- Single source of truth for all shared interfaces
 * in the CTF Cold-To-Warm Demo.
 */

// ---------------------------------------------------------------------------
// Core enums and unions
// ---------------------------------------------------------------------------

/** All model tiers used in the demo. */
export type ModelTier = 'opus' | 'sonnet' | 'haiku' | 'qwen3-14b';

/** Display model for a wave; mixed waves contain multiple concrete agent models. */
export type WaveModel = ModelTier | 'mixed';

/** Runtime used to execute an agent model. */
export type AgentRuntime = 'claude' | 'ollama' | 'azure-openai' | 'google-vertex';

/** Display runtime for a wave; mixed waves contain multiple concrete runtimes. */
export type WaveRuntime = AgentRuntime | 'mixed';

/** inErrata access level for a demo wave. */
export type AuthLevel = 'none' | 'anonymous' | 'authenticated';

/** Demo story framing. */
export type BenchmarkFraming = 'equalization' | 'funnel';

/** Graph state visible to a wave. */
export type GraphState = 'empty' | 'warm' | 'production';

/** Challenge difficulty: 1-5, with 4-5 being "legendary". */
export type Difficulty = 1 | 2 | 3 | 4 | 5;

/** Bug class taxonomy for C/systems vulnerabilities. */
export type BugClass =
  | 'buffer-overflow' | 'heap-overflow' | 'stack-overflow'
  | 'format-string' | 'command-injection' | 'path-traversal'
  | 'integer-overflow' | 'use-after-free' | 'null-deref'
  | 'type-confusion' | 'race-condition' | 'crypto-side-channel'
  | 'shell-injection' | 'symlink-attack' | 'logic-bug'
  | 'restricted-bypass' | 'url-parsing'
  | 'double-free' | 'information-leak' | 'memory-leak'
  | 'out-of-bounds-read' | 'certificate-validation';

/** Exploit complexity classification. */
export type ExploitComplexity = 'single-step' | 'multi-step' | 'chain';

// ---------------------------------------------------------------------------
// Challenge definition
// ---------------------------------------------------------------------------

export interface Challenge {
  id: string;
  cve: string;
  repo: string;
  repoUrl: string;
  affectedVersion: string;
  fixedVersion: string;
  bugClass: BugClass;
  difficulty: Difficulty;
  points: number;
  briefing: string;
}

export interface ChallengeGroundTruth {
  files: string[];
  functions: string[];
  description: string;
  exploitVector: string;
  patchHint: string;
  callChain: string[];
  exploitComplexity: ExploitComplexity;
  cweId: string;
  affectedVersionRange: string;
  /**
   * Optional vulnerable line ranges in the ground-truth files. If present,
   * the location scorer validates the agent's reported lineRange overlaps
   * one of these (within tolerance). Falsy = no line-level validation.
   */
  vulnerableLines?: Array<[number, number]>;
}

export type ScoringChallenge = Challenge & {
  groundTruth: ChallengeGroundTruth;
  /**
   * Negative-control marker. When true, the challenge does not actually
   * describe a real vulnerability in this codebase. Any finding submitted
   * by an agent on this challenge is treated as a cheating signal (the agent
   * is hallucinating or pattern-matching from the prompt instead of
   * auditing). All scores zero; disqualified with `negative-control-cheating`.
   */
  isFake?: boolean;
};

// ---------------------------------------------------------------------------
// Agent configuration
// ---------------------------------------------------------------------------

export interface AgentConfig {
  id: string;
  name: string;
  model: ModelTier;
  modelId: string;
  runtime: AgentRuntime;
  auth: AuthLevel;
  wave: number;
  waveLabel: string;
  spriteType: string;
  canContribute: boolean;
}

/** Concrete agent roster entry for a mixed wave/tier. */
export interface WaveAgentConfig {
  label: string;
  name?: string;
  model: ModelTier;
  modelId: string;
  runtime: AgentRuntime;
  auth: AuthLevel;
  canContribute: boolean;
  spriteType: string;
}

/** Wave configuration used by the orchestrator and prompt builder. */
export interface WaveConfig {
  number: number;
  label: string;
  model: WaveModel;
  modelId: string;
  runtime: WaveRuntime;
  auth: AuthLevel;
  graphState: GraphState;
  canContribute: boolean;
  spriteType: string;
  description: string;
  agents?: WaveAgentConfig[];
}

// ---------------------------------------------------------------------------
// Findings
// ---------------------------------------------------------------------------

export interface Finding {
  agentId: string;
  challengeId: string;
  timestamp: number;
  vulnerableFile: string;
  vulnerableFunction?: string;
  lineRange?: [number, number];
  bugClass: BugClass;
  explanation: string;
  pocCode?: string;
  patchSuggestion?: string;
  crossRepoPattern?: string;
}

export interface FindingDiagnostics {
  exactFunctionMatch: boolean;
  bugClassMatch: boolean;
  wrongCveMentions: string[];
  evidenceHits: string[];
  /**
   * Keyword overlap between the finding's explanation and the public
   * challenge briefing (0..1). High values suggest the agent paraphrased
   * the briefing instead of analysing the source.
   */
  briefingOverlap?: number;
  /**
   * True when the agent's reported lineRange overlaps a ground-truth
   * vulnerableLines range (within tolerance). False when ground-truth
   * specifies lines and the agent's range did not match. Undefined when
   * ground-truth does not specify vulnerable lines or the agent did not
   * report a range.
   */
  lineRangeMatch?: boolean;
  /** True if the underlying challenge is a negative-control fake. */
  fakeChallenge?: boolean;
}

export interface ScoredFinding extends Finding {
  scores: {
    location: number;
    explanation: number;
    poc: number;
    patch: number;
    crossRepo: number;
    total: number;
  };
  solved: boolean;
  disqualified: boolean;
  disqualificationReasons: string[];
  diagnostics: FindingDiagnostics;
}

// ---------------------------------------------------------------------------
// Agent run result
// ---------------------------------------------------------------------------

export interface AgentRunResult {
  agent: AgentConfig;
  wave: WaveConfig;
  startTime: number;
  endTime: number;
  findings: ScoredFinding[];
  totalScore: number;
  challengesAttempted: number;
  challengesSolved: number;
  graphQueries: number;
  graphContributions: number;
  /** WebSearch + WebFetch tool calls. Tracked as a metric across waves. */
  webLookups: number;
}

// ---------------------------------------------------------------------------
// Dashboard / orchestrator shared state
// ---------------------------------------------------------------------------

/** Unified agent state for dashboard and orchestrator. */
export interface AgentState {
  id: string;
  name: string;
  model: ModelTier;
  modelId: string;
  runtime: AgentRuntime;
  auth: AuthLevel;
  waveLabel: string;
  sprite: string; // opus-wizard | sonnet-bard | haiku-rogue
  status: 'idle' | 'running' | 'throttled' | 'finished' | 'failed';
  currentChallenge?: string;
  currentRepo?: string;
  flagsCaptured: number;
  totalPoints: number;
  toolCalls: number;
  graphHits: number;
  /** WebSearch + WebFetch tool calls. */
  webLookups: number;
  /** Cumulative session tokens used by the agent (HP-bar fuel). */
  tokensUsed: number;
  /** Total session token budget for the agent (HP-bar max). */
  tokenBudget: number;
  /** Max tool calls per agent run (MP-bar max). */
  maxToolCalls: number;
  findings: ScoredFinding[];
  budgetExceeded?: boolean;
  disqualifications?: string[];
  wave: number;
}

/** Wave tracking for framing-based demo runs. */
export interface Wave {
  number: number;
  label: string;
  mode: AuthLevel;
  auth: AuthLevel;
  model: WaveModel;
  modelId: string;
  runtime: WaveRuntime;
  canContribute: boolean;
  graphState: GraphState;
  description: string;
  challenges: string[];
  scores: Record<string, Record<string, number>>; // agentId -> challengeId -> score
  // Snapshot of cumulative tokens used at the moment each challenge finished.
  // agentId -> challengeId -> tokensUsed-so-far. Used by the dashboard to plot
  // the convergence chart against tokens spent (cost) instead of arbitrary
  // challenge index.
  tokensAt?: Record<string, Record<string, number>>;
  startTime?: number;
  endTime?: number;
}

/** Dashboard API response shape. */
export interface DashboardState {
  agents: Record<string, AgentState>;
  challenges: Challenge[];
  waves: Wave[];
  currentWave: number;
  flags: FlagEvent[];
  runId: string;
  framing?: BenchmarkFraming;
}

/** A single flag capture event. */
export interface FlagEvent {
  agentId: string;
  challengeId: string;
  points: number;
  timestamp: number;
  wave: number;
  waveLabel?: string;
}

/** Knowledge graph node for visualization. */
export interface GraphNode {
  id: string;
  type: 'Domain' | 'Vulnerability' | 'Solution' | 'Pattern' | 'Exploit' | 'RootCause';
  label: string;
  x?: number;
  y?: number;
}

/** Knowledge graph edge for visualization. */
export interface GraphEdge {
  source: string;
  target: string;
  type: string;
}

// ---------------------------------------------------------------------------
// Per-tier runtime + model id resolution
// ---------------------------------------------------------------------------
//
// Each tier (opus / sonnet / haiku / qwen3-14b) chooses a runtime and a
// concrete model id at startup. Defaults send opus/sonnet/haiku through
// Azure OpenAI (gpt-5.x deployments) and qwen through ollama. Either side
// can be overridden per tier via env:
//
//   CTF_RUNTIME_OPUS=claude            # 'claude' | 'azure-openai'
//   CTF_RUNTIME_SONNET=azure-openai
//   CTF_RUNTIME_HAIKU=azure-openai
//
//   # Claude-CLI aliases (used when runtime=claude). Defaults to the tier name.
//   CTF_CLAUDE_OPUS=opus               # or claude-opus-4-7, etc.
//   CTF_CLAUDE_SONNET=sonnet
//   CTF_CLAUDE_HAIKU=haiku
//
//   # Azure deployment names (used when runtime=azure-openai).
//   AZURE_OPENAI_DEPLOYMENT_OPUS=gpt-5.4-pro
//   AZURE_OPENAI_DEPLOYMENT_SONNET=gpt-5.4-mini
//   AZURE_OPENAI_DEPLOYMENT_HAIKU=gpt-5.4-nano
//
//   # Per-tier Azure resource override (only set if a tier lives on a
//   # different Azure resource than the default AZURE_OPENAI_* values).
//   AZURE_OPENAI_ENDPOINT_OPUS=https://other.cognitiveservices.azure.com/
//   AZURE_OPENAI_API_KEY_OPUS=...
//   AZURE_OPENAI_API_VERSION_OPUS=2025-04-01-preview
//   AZURE_OPENAI_API_STYLE_OPUS=responses          # 'responses' | 'chat-completions'
//
// Use this for split runs: e.g. opus on a Responses-API-only resource,
// sonnet+haiku on the standard chat/completions resource.

const ALLOWED_RUNTIMES: AgentRuntime[] = ['claude', 'azure-openai', 'ollama'];
const ALLOWED_API_STYLES = ['responses', 'chat-completions'] as const;
export type AzureApiStyle = (typeof ALLOWED_API_STYLES)[number];

function resolveRuntime(envValue: string | undefined, fallback: AgentRuntime): AgentRuntime {
  if (envValue && (ALLOWED_RUNTIMES as string[]).includes(envValue)) {
    return envValue as AgentRuntime;
  }
  return fallback;
}

function resolveApiStyle(envValue: string | undefined, fallback: AzureApiStyle): AzureApiStyle {
  if (envValue && (ALLOWED_API_STYLES as readonly string[]).includes(envValue)) {
    return envValue as AzureApiStyle;
  }
  return fallback;
}

/** Azure-specific overrides for one tier when runtime='azure-openai'. */
export interface AzureTierOverrides {
  endpoint?: string;
  apiKey?: string;
  apiVersion?: string;
  apiStyle: AzureApiStyle;
}

export interface TierResolution {
  runtime: AgentRuntime;
  modelId: string;
  /** Only populated when runtime='azure-openai'. */
  azure?: AzureTierOverrides;
}

function azureOverrides(tierUpper: 'OPUS' | 'SONNET' | 'HAIKU'): AzureTierOverrides {
  return {
    endpoint: process.env[`AZURE_OPENAI_ENDPOINT_${tierUpper}`],
    apiKey: process.env[`AZURE_OPENAI_API_KEY_${tierUpper}`],
    apiVersion: process.env[`AZURE_OPENAI_API_VERSION_${tierUpper}`],
    apiStyle: resolveApiStyle(process.env[`AZURE_OPENAI_API_STYLE_${tierUpper}`], 'chat-completions'),
  };
}

export function resolveTier(tier: ModelTier): TierResolution {
  switch (tier) {
    case 'qwen3-14b':
      return {
        runtime: 'ollama',
        modelId: process.env.CTF_QWEN_MODEL ?? process.env.OLLAMA_QWEN_MODEL ?? 'qwen3:14b',
      };
    case 'opus': {
      const runtime = resolveRuntime(process.env.CTF_RUNTIME_OPUS, 'azure-openai');
      const modelId = runtime === 'claude'
        ? (process.env.CTF_CLAUDE_OPUS ?? 'opus')
        : (process.env.AZURE_OPENAI_DEPLOYMENT_OPUS ?? 'gpt-5.4-pro');
      return runtime === 'azure-openai'
        ? { runtime, modelId, azure: azureOverrides('OPUS') }
        : { runtime, modelId };
    }
    case 'sonnet': {
      const runtime = resolveRuntime(process.env.CTF_RUNTIME_SONNET, 'azure-openai');
      const modelId = runtime === 'claude'
        ? (process.env.CTF_CLAUDE_SONNET ?? 'sonnet')
        : (process.env.AZURE_OPENAI_DEPLOYMENT_SONNET ?? 'gpt-5.4-mini');
      return runtime === 'azure-openai'
        ? { runtime, modelId, azure: azureOverrides('SONNET') }
        : { runtime, modelId };
    }
    case 'haiku': {
      const runtime = resolveRuntime(process.env.CTF_RUNTIME_HAIKU, 'azure-openai');
      const modelId = runtime === 'claude'
        ? (process.env.CTF_CLAUDE_HAIKU ?? 'haiku')
        : (process.env.AZURE_OPENAI_DEPLOYMENT_HAIKU ?? 'gpt-5.4-nano');
      return runtime === 'azure-openai'
        ? { runtime, modelId, azure: azureOverrides('HAIKU') }
        : { runtime, modelId };
    }
  }
}

/**
 * Legacy MODEL_IDS map. Kept for callers that only need the model id at
 * import time without runtime context. Prefer `resolveTier(tier).modelId`
 * in code that also branches on runtime.
 */
export const MODEL_IDS: Record<ModelTier, string> = {
  opus: resolveTier('opus').modelId,
  sonnet: resolveTier('sonnet').modelId,
  haiku: resolveTier('haiku').modelId,
  'qwen3-14b': resolveTier('qwen3-14b').modelId,
};
