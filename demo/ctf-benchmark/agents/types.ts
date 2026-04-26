/**
 * agents/types.ts — Shared type definitions for the CTF benchmark agent layer.
 *
 * These mirror the types from the challenge catalog and target harness,
 * kept here so the agents/ module is self-contained.
 */

// ---------------------------------------------------------------------------
// Challenge + Target descriptors
// ---------------------------------------------------------------------------

export type Category =
  | 'injection'
  | 'auth-bypass'
  | 'idor'
  | 'ssrf'
  | 'crypto'
  | 'misc'
  | 'broken-access'
  | 'sensitive-data'
  | 'race-condition'

export type Difficulty = 'trivial' | 'easy' | 'medium' | 'hard' | 'expert'

export interface Challenge {
  id: string
  target: string
  name: string
  description: string
  category: Category
  difficulty: Difficulty
  points: number
  /** Validate a submission (flag, payload, evidence). May be async. */
  validate: (submission: string) => boolean | Promise<boolean>
}

export interface Target {
  name: string
  url: string
  dockerService: string
}

// ---------------------------------------------------------------------------
// Run result
// ---------------------------------------------------------------------------

export interface AgentRunResult {
  flagsCaptured: Array<{
    challengeId: string
    capturedAt: Date
    submission: string
  }>
  timeToFirstFlagMs: number | null
  timeToSolveMs: number | null
  totalTokensInput: number
  totalTokensOutput: number
  /** Tool calls tracked only in warm mode via MCP; 0 for CLI-spawned cold agents */
  toolCalls: number
  graphToolCalls: number
  graphHits: number
  firstGraphHitAt: Date | null
  contributeCalls: number
  traversalPatterns: string[]
  errors: string[]
  status: 'completed' | 'failed' | 'timeout'
}

// ---------------------------------------------------------------------------
// SSE event types (emitted by maze server, consumed by dashboard)
// ---------------------------------------------------------------------------

export interface FlagCapturedEvent {
  type: 'flag_captured'
  challengeId: string
  agentId: string
  points: number
  timestamp: string
}

export interface FlagFailedEvent {
  type: 'flag_failed'
  challengeId: string
  agentId: string
  timestamp: string
}

export interface AgentStartedEvent {
  type: 'agent_started'
  agentId: string
  handle: string
  model: string
  mode: 'cold' | 'warm'
  timestamp: string
}

export interface AgentFinishedEvent {
  type: 'agent_finished'
  agentId: string
  handle: string
  flagCount: number
  points: number
  status: 'completed' | 'failed' | 'timeout'
  timestamp: string
}

export interface WaveStartedEvent {
  type: 'wave_started'
  wave: number
  label: string
  model: string
  mode: 'cold' | 'warm'
  agentCount: number
  timestamp: string
}

export interface WaveFinishedEvent {
  type: 'wave_finished'
  wave: number
  label: string
  totalFlags: number
  totalPoints: number
  timestamp: string
}

export type BenchmarkEvent =
  | FlagCapturedEvent
  | FlagFailedEvent
  | AgentStartedEvent
  | AgentFinishedEvent
  | WaveStartedEvent
  | WaveFinishedEvent
