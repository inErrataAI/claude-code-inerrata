import { execSync } from 'node:child_process';
import { resolveTier } from '../shared/types.js';
import type { AuthLevel, GraphState, ModelTier, WaveAgentConfig, WaveConfig } from '../shared/types.js';

// One-time probe at module load: if ollama isn't available, drop the local
// qwen lane entirely (don't display the party on the dashboard either).
const OLLAMA_AVAILABLE: boolean = (() => {
  try {
    execSync('ollama --version', { stdio: 'pipe', timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
})();

// Gemini lanes (3 tiers) appear in the head-to-head roster only when a Vertex
// service-account JSON is configured. Rate limits handled in the harness.
const GEMINI_AVAILABLE = !!process.env.VERTEX_SERVICE_ACCOUNT_PATH;

function tierAgent(
  label: string,
  tier: ModelTier,
  auth: AuthLevel,
  canContribute: boolean,
  spriteType: string,
): WaveAgentConfig {
  const { runtime, modelId } = resolveTier(tier);
  return {
    label: `${label}-${tier}`,
    model: tier,
    modelId,
    runtime,
    auth,
    canContribute,
    spriteType,
  };
}

const HEAD_TO_HEAD = process.env.CTF_HEAD_TO_HEAD === '1' || process.env.CTF_HEAD_TO_HEAD === 'true';

/**
 * Head-to-head roster: 6 model lanes (3 claude + 3 azure gpt-5.4) +
 * optional local qwen. Used when CTF_HEAD_TO_HEAD=1. Each lane is an
 * independent agent — both opus lanes (claude + gpt-5.4-pro) run in
 * parallel-with-respect-to-wave-ordering. With --parallel 1 they run
 * strictly sequentially, so later agents in wave 3 see what earlier
 * agents contributed.
 */
function headToHeadAgents(label: string, auth: AuthLevel, canContribute: boolean): WaveAgentConfig[] {
  return [
    {
      label: `${label}-claude-opus`,
      model: 'opus',
      modelId: process.env.CTF_CLAUDE_OPUS ?? 'opus',
      runtime: 'claude',
      auth,
      canContribute,
      spriteType: 'opus',
    },
    {
      label: `${label}-claude-sonnet`,
      model: 'sonnet',
      modelId: process.env.CTF_CLAUDE_SONNET ?? 'sonnet',
      runtime: 'claude',
      auth,
      canContribute,
      spriteType: 'sonnet',
    },
    {
      label: `${label}-claude-haiku`,
      model: 'haiku',
      modelId: process.env.CTF_CLAUDE_HAIKU ?? 'haiku',
      runtime: 'claude',
      auth,
      canContribute,
      spriteType: 'haiku',
    },
    {
      label: `${label}-gpt-5-4-pro`,
      model: 'opus',
      modelId: process.env.AZURE_OPENAI_DEPLOYMENT_OPUS ?? 'gpt-5.4-pro',
      runtime: 'azure-openai',
      auth,
      canContribute,
      spriteType: 'opus',
    },
    {
      label: `${label}-gpt-5-4-mini`,
      model: 'sonnet',
      modelId: process.env.AZURE_OPENAI_DEPLOYMENT_SONNET ?? 'gpt-5.4-mini',
      runtime: 'azure-openai',
      auth,
      canContribute,
      spriteType: 'sonnet',
    },
    {
      label: `${label}-gpt-5-4-nano`,
      model: 'haiku',
      modelId: process.env.AZURE_OPENAI_DEPLOYMENT_HAIKU ?? 'gpt-5.4-nano',
      runtime: 'azure-openai',
      auth,
      canContribute,
      spriteType: 'haiku',
    },
    ...(GEMINI_AVAILABLE
      ? [
          {
            label: `${label}-gemini-2-5-pro`,
            model: 'opus' as ModelTier,
            modelId: process.env.GEMINI_MODEL_PRO ?? 'google/gemini-2.5-pro',
            runtime: 'google-vertex' as const,
            auth,
            canContribute,
            spriteType: 'opus',
          },
          {
            label: `${label}-gemini-2-5-flash`,
            model: 'sonnet' as ModelTier,
            modelId: process.env.GEMINI_MODEL_FLASH ?? 'google/gemini-2.5-flash',
            runtime: 'google-vertex' as const,
            auth,
            canContribute,
            spriteType: 'sonnet',
          },
          {
            label: `${label}-gemini-2-5-flash-lite`,
            model: 'haiku' as ModelTier,
            modelId: process.env.GEMINI_MODEL_FLASH_LITE ?? 'google/gemini-2.5-flash-lite',
            runtime: 'google-vertex' as const,
            auth,
            canContribute,
            spriteType: 'haiku',
          },
        ]
      : []),
    ...(OLLAMA_AVAILABLE
      ? [{
          label: `${label}-qwen3-14b`,
          model: 'qwen3-14b' as ModelTier,
          modelId: process.env.CTF_QWEN_MODEL ?? process.env.OLLAMA_QWEN_MODEL ?? 'qwen3:14b',
          runtime: 'ollama' as const,
          auth,
          canContribute,
          spriteType: 'qwen3-14b',
        }]
      : []),
  ];
}

function tierAgents(label: string, auth: AuthLevel, canContribute: boolean): WaveAgentConfig[] {
  if (HEAD_TO_HEAD) return headToHeadAgents(label, auth, canContribute);
  const agents: WaveAgentConfig[] = [
    tierAgent(label, 'opus', auth, canContribute, 'opus'),
    tierAgent(
      label,
      'sonnet',
      auth,
      canContribute,
      auth === 'authenticated' ? 'sonnet-warm' : auth === 'anonymous' ? 'sonnet-anon' : 'sonnet',
    ),
    tierAgent(
      label,
      'haiku',
      auth,
      canContribute,
      auth === 'authenticated' ? 'haiku-warm' : auth === 'anonymous' ? 'haiku-anon' : 'haiku',
    ),
  ];
  if (OLLAMA_AVAILABLE) {
    agents.push(tierAgent(label, 'qwen3-14b', auth, canContribute, 'qwen3-14b'));
  }
  return agents;
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

// Anon wave is only meaningful when the graph already has prior knowledge
// (e.g. production inerrata with existing real-agent contributions). On a
// fresh local stack the ctf-bench neighborhood is wiped before wave 1, no
// contributions happen between cold and anon, and the anon wave runs as
// effectively cold -- just burning tokens. Opt back in for production demos:
//   CTF_INCLUDE_ANON_WAVE=1
const INCLUDE_ANON_WAVE = process.env.CTF_INCLUDE_ANON_WAVE === '1' || process.env.CTF_INCLUDE_ANON_WAVE === 'true';

const EQUALIZATION_COLD = tierWave(
  1,
  'cold',
  'none',
  'empty',
  false,
  'Cold baseline: every model runs without graph access.',
);
const EQUALIZATION_ANON_BASE = tierWave(
  2,
  'anonymous',
  'anonymous',
  'warm',
  false,
  'Read-only graph tier: every model gets anonymous inErrata search and graph context.',
);

function buildEqualizationWaves(generations: number): WaveConfig[] {
  const waves: WaveConfig[] = [EQUALIZATION_COLD];
  let nextIdx = 2;
  if (INCLUDE_ANON_WAVE) {
    waves.push({ ...EQUALIZATION_ANON_BASE, number: nextIdx });
    nextIdx += 1;
  }
  const gens = Math.max(1, generations);
  for (let g = 1; g <= gens; g += 1) {
    const label = gens > 1 ? `auth-gen-${g}` : 'authenticated';
    const description =
      gens > 1
        ? `Authenticated generation ${g} of ${gens}: agents read+write the same compounding graph.`
        : 'Authenticated tier: every model reads, writes, and compounds graph knowledge.';
    waves.push(tierWave(nextIdx, label, 'authenticated', 'warm', true, description));
    nextIdx += 1;
  }
  return waves;
}

/**
 * Legacy default for callers that don't pass generations -- single auth wave.
 * Prefer wavesForFraming(framing, generations) for actual runs.
 */
export const EQUALIZATION_WAVES: WaveConfig[] = buildEqualizationWaves(1);

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

export function wavesForFraming(
  framing: 'equalization' | 'funnel',
  generations: number = 1,
): WaveConfig[] {
  if (framing === 'funnel') return FUNNEL_WAVES;
  return buildEqualizationWaves(generations);
}
