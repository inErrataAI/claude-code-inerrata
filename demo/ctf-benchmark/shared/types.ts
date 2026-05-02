/**
 * shared/types.ts -- Single source of truth for all shared interfaces
 * in the GNU Security Audit CTF benchmark.
 */

// ---------------------------------------------------------------------------
// Core enums and unions
// ---------------------------------------------------------------------------

/** All model tiers used in the benchmark. */
export type ModelTier = 'opus' | 'sonnet' | 'haiku';

/** inErrata access level for a benchmark wave. */
export type AuthLevel = 'none' | 'anonymous' | 'authenticated';

/** Benchmark story framing. */
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
  groundTruth: {
    files: string[];
    functions: string[];
    description: string;
    exploitVector: string;
    patchHint: string;
    callChain: string[];
    exploitComplexity: ExploitComplexity;
    cweId: string;
    affectedVersionRange: string;
  };
}

// ---------------------------------------------------------------------------
// Agent configuration
// ---------------------------------------------------------------------------

export interface AgentConfig {
  id: string;
  name: string;
  model: ModelTier;
  auth: AuthLevel;
  wave: number;
  waveLabel: string;
  spriteType: string;
  canContribute: boolean;
}

/** Wave configuration used by the orchestrator and prompt builder. */
export interface WaveConfig {
  number: number;
  label: string;
  model: ModelTier;
  modelId: string;
  auth: AuthLevel;
  graphState: GraphState;
  canContribute: boolean;
  spriteType: string;
  description: string;
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

/** Wave tracking for framing-based benchmark runs. */
export interface Wave {
  number: number;
  label: string;
  mode: AuthLevel;
  auth: AuthLevel;
  model: ModelTier;
  modelId: string;
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
  opus: 'claude-opus-4-20250514',
  sonnet: 'claude-sonnet-4-20250514',
  haiku: 'claude-haiku-3-5-20241022',
};
