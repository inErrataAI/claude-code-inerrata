/**
 * agents/types.ts -- Re-exports from shared/types.ts for backward compatibility.
 *
 * All canonical type definitions live in shared/types.ts. This module
 * re-exports them so existing imports from '../agents/types.js' continue
 * to work without changes.
 */

export type {
  Difficulty,
  BugClass,
  ModelTier,
  AuthLevel,
  BenchmarkFraming,
  GraphState,
  ExploitComplexity,
  Challenge,
  AgentConfig,
  WaveConfig,
  Finding,
  ScoredFinding,
  AgentRunResult,
  AgentState,
  Wave,
  DashboardState,
  FlagEvent,
  GraphNode,
  GraphEdge,
} from '../shared/types.js';

export { MODEL_IDS } from '../shared/types.js';
