import { MODEL_IDS } from '../shared/types.js';
import type { WaveConfig } from '../shared/types.js';

export const EQUALIZATION_WAVES: WaveConfig[] = [
  {
    number: 1,
    label: 'opus-cold',
    model: 'opus',
    modelId: MODEL_IDS.opus,
    auth: 'authenticated',
    graphState: 'empty',
    canContribute: true,
    spriteType: 'opus',
    description: 'Opus with no prior benchmark knowledge; sets the intelligence ceiling.',
  },
  {
    number: 2,
    label: 'haiku-cold',
    model: 'haiku',
    modelId: MODEL_IDS.haiku,
    auth: 'none',
    graphState: 'empty',
    canContribute: false,
    spriteType: 'haiku',
    description: 'Haiku with no graph and no tools; sets the cost floor.',
  },
  {
    number: 3,
    label: 'haiku-anon',
    model: 'haiku',
    modelId: MODEL_IDS.haiku,
    auth: 'anonymous',
    graphState: 'warm',
    canContribute: false,
    spriteType: 'haiku-anon',
    description: 'Haiku with anonymous read-only graph access; shows free-tier value.',
  },
  {
    number: 4,
    label: 'haiku-warm',
    model: 'haiku',
    modelId: MODEL_IDS.haiku,
    auth: 'authenticated',
    graphState: 'warm',
    canContribute: true,
    spriteType: 'haiku-warm',
    description: 'Haiku with full graph access; shows the equalizing compound loop.',
  },
];

export const FUNNEL_WAVES: WaveConfig[] = [
  {
    number: 1,
    label: 'blind',
    model: 'sonnet',
    modelId: MODEL_IDS.sonnet,
    auth: 'none',
    graphState: 'production',
    canContribute: false,
    spriteType: 'sonnet',
    description: 'Sonnet blind; no graph access.',
  },
  {
    number: 2,
    label: 'anon',
    model: 'sonnet',
    modelId: MODEL_IDS.sonnet,
    auth: 'anonymous',
    graphState: 'production',
    canContribute: false,
    spriteType: 'sonnet-anon',
    description: 'Sonnet with anonymous read-only graph access.',
  },
  {
    number: 3,
    label: 'authed',
    model: 'sonnet',
    modelId: MODEL_IDS.sonnet,
    auth: 'authenticated',
    graphState: 'production',
    canContribute: true,
    spriteType: 'sonnet-warm',
    description: 'Sonnet with full graph access; reads, writes, and compounds.',
  },
];

export function wavesForFraming(framing: 'equalization' | 'funnel'): WaveConfig[] {
  return framing === 'equalization' ? EQUALIZATION_WAVES : FUNNEL_WAVES;
}
