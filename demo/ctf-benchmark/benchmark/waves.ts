import { MODEL_IDS } from '../shared/types.js';
import type { AuthLevel, GraphState, WaveAgentConfig, WaveConfig } from '../shared/types.js';

function tierAgents(label: string, auth: AuthLevel, canContribute: boolean): WaveAgentConfig[] {
  return [
    {
      label: `${label}-opus`,
      model: 'opus',
      modelId: MODEL_IDS.opus,
      runtime: 'claude',
      auth,
      canContribute,
      spriteType: 'opus',
    },
    {
      label: `${label}-sonnet`,
      model: 'sonnet',
      modelId: MODEL_IDS.sonnet,
      runtime: 'claude',
      auth,
      canContribute,
      spriteType: auth === 'authenticated' ? 'sonnet-warm' : auth === 'anonymous' ? 'sonnet-anon' : 'sonnet',
    },
    {
      label: `${label}-haiku`,
      model: 'haiku',
      modelId: MODEL_IDS.haiku,
      runtime: 'claude',
      auth,
      canContribute,
      spriteType: auth === 'authenticated' ? 'haiku-warm' : auth === 'anonymous' ? 'haiku-anon' : 'haiku',
    },
    {
      label: `${label}-qwen3-14b`,
      model: 'qwen3-14b',
      modelId: MODEL_IDS['qwen3-14b'],
      runtime: 'ollama',
      auth,
      canContribute,
      spriteType: 'qwen3-14b',
    },
  ];
}

function tierWave(
  number: number,
  label: string,
  auth: AuthLevel,
  graphState: GraphState,
  canContribute: boolean,
  description: string,
): WaveConfig {
  return {
    number,
    label,
    model: 'mixed',
    modelId: 'mixed',
    runtime: 'mixed',
    auth,
    graphState,
    canContribute,
    spriteType: 'mixed',
    description,
    agents: tierAgents(label, auth, canContribute),
  };
}

export const EQUALIZATION_WAVES: WaveConfig[] = [
  tierWave(
    1,
    'cold',
    'none',
    'empty',
    false,
    'Cold baseline: Opus, Sonnet, Haiku, and local Qwen run without graph access.',
  ),
  tierWave(
    2,
    'anonymous',
    'anonymous',
    'warm',
    false,
    'Read-only graph tier: every model gets anonymous inErrata search and graph context.',
  ),
  tierWave(
    3,
    'authenticated',
    'authenticated',
    'warm',
    true,
    'Full graph tier: every model gets authenticated inErrata read/write access.',
  ),
];

export const FUNNEL_WAVES: WaveConfig[] = [
  tierWave(
    1,
    'blind',
    'none',
    'production',
    false,
    'Blind tier: every model runs without graph access.',
  ),
  tierWave(
    2,
    'anon',
    'anonymous',
    'production',
    false,
    'Anonymous tier: every model gets read-only graph access.',
  ),
  tierWave(
    3,
    'authed',
    'authenticated',
    'production',
    true,
    'Authenticated tier: every model reads, writes, and compounds graph knowledge.',
  ),
];

export function wavesForFraming(framing: 'equalization' | 'funnel'): WaveConfig[] {
  return framing === 'equalization' ? EQUALIZATION_WAVES : FUNNEL_WAVES;
}
