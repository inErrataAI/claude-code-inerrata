/**
 * shared/types.ts -- Single source of truth for all shared interfaces
 * in the CTF Cold-To-Warm Demo.
 */

// ---------------------------------------------------------------------------
// Core enums and unions
// ---------------------------------------------------------------------------

/** All model tiers used in the demo. */
export type ModelTier = 'opus' | 'sonnet' | 'haiku' | 'qwen2.5-14b';

/** Display model for a wave; mixed waves contain multiple concrete agent models. */
export type WaveModel = ModelTier | 'mixed';

/** Runtime used to execute an agent model. */
export type AgentRuntime = 'claude' | 'ollama';

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
}

export type ScoringChallenge = Challenge & { groundTruth: ChallengeGroundTruth };

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

export interface ScoredFinding extends Finding {
  scores: {
    location: number;
    explanation: number;
    poc: number;
    patch: number;
    crossRepo: number;
    total: number;
  };
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
  findings: ScoredFinding[];
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
// Model IDs
// ---------------------------------------------------------------------------

export const MODEL_IDS: Record<ModelTier, string> = {
  opus: 'opus',
  sonnet: 'sonnet',
  haiku: 'haiku',
  'qwen2.5-14b': process.env.CTF_QWEN_MODEL ?? process.env.OLLAMA_QWEN_MODEL ?? 'qwen2.5:14b',
};
