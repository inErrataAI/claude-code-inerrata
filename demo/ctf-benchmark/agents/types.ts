/**
 * agents/types.ts — Type definitions for the GNU Security Audit CTF benchmark.
 */

export type Difficulty = 1 | 2 | 3 | 4 | 5;

export type BugClass =
  | 'buffer-overflow' | 'heap-overflow' | 'stack-overflow'
  | 'format-string' | 'command-injection' | 'path-traversal'
  | 'integer-overflow' | 'use-after-free' | 'null-deref'
  | 'type-confusion' | 'race-condition' | 'crypto-side-channel'
  | 'shell-injection' | 'symlink-attack' | 'logic-bug'
  | 'restricted-bypass' | 'url-parsing';

export type ModelTier = 'opus' | 'sonnet' | 'haiku';

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
    functions?: string[];
    description: string;
    exploitVector: string;
    patchHint: string;
  };
}

export interface AgentConfig {
  id: string;
  name: string;
  model: ModelTier;
  mode: 'cold' | 'warm';
  spriteType: 'opus' | 'sonnet' | 'haiku';
}

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

export interface AgentRunResult {
  agent: AgentConfig;
  startTime: number;
  endTime: number;
  findings: ScoredFinding[];
  totalScore: number;
  challengesAttempted: number;
  challengesSolved: number;
  graphQueries: number;
  graphContributions: number;
}

export const MODEL_IDS: Record<ModelTier, string> = {
  opus: 'claude-opus-4-20250514',
  sonnet: 'claude-sonnet-4-20250514',
  haiku: 'claude-haiku-3-5-20241022',
};
