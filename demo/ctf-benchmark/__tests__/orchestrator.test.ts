import { describe, expect, it } from 'vitest';
import {
  buildClaudeArgs,
  parseConfig,
  parseFindings,
  parseStreamJson,
  runChallengesWithSequentialAgents,
  runWithConcurrency,
} from '../benchmark/orchestrator.js';
import { CHALLENGES } from '../challenges/registry.js';

describe('ctf benchmark orchestrator config', () => {
  it('parses --parallel', () => {
    expect(parseConfig(['--parallel', '7']).parallel).toBe(7);
  });

  it('rejects invalid --parallel values', () => {
    expect(() => parseConfig(['--parallel', '0'])).toThrow(/Invalid --parallel/);
  });

  it('isolates benchmark Claude runs from user settings and ambient MCP servers', () => {
    const args = buildClaudeArgs({
      includeModel: true,
      modelId: 'haiku',
      mcpConfigPath: '/tmp/empty-mcp.json',
      systemPrompt: 'system',
      challengePrompt: 'challenge',
    });

    expect(args).toContain('--strict-mcp-config');
    expect(args.slice(args.indexOf('--setting-sources'), args.indexOf('--setting-sources') + 2))
      .toEqual(['--setting-sources', 'project,local']);
    expect(args).toContain('--plugin-dir');
  });

  it('deduplicates stream-json assistant text from final result text', () => {
    const raw = [
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'assistant answer' }] } }),
      JSON.stringify({ type: 'result', result: 'assistant answer' }),
    ].join('\n');

    expect(parseStreamJson(raw).text).toBe('assistant answer');
  });

  it('falls back to markdown finding blocks for local Qwen output', () => {
    const challenge = CHALLENGES[0];
    const findings = parseFindings(
      `<finding>
**File:** src/arith.c
**Function:** ps_shift
**Lines:** 123-145
**Description:** The shift count is not validated before the operation.
**Fix Recommendation:** Validate the shift count before shifting.
</finding>`,
      'qwen',
      challenge,
    );

    expect(findings).toHaveLength(1);
    expect(findings[0].challengeId).toBe(challenge.id);
    expect(findings[0].vulnerableFile).toBe('src/arith.c');
    expect(findings[0].vulnerableFunction).toBe('ps_shift');
    expect(findings[0].lineRange).toEqual([123, 145]);
    expect(findings[0].bugClass).toBe(challenge.bugClass);
  });
});

describe('runWithConcurrency', () => {
  it('respects the concurrency limit', async () => {
    let currentConcurrent = 0;
    let maxConcurrent = 0;

    await runWithConcurrency([1, 2, 3, 4], 2, async () => {
      currentConcurrent++;
      maxConcurrent = Math.max(maxConcurrent, currentConcurrent);
      await new Promise(resolve => setTimeout(resolve, 10));
      currentConcurrent--;
    });

    expect(maxConcurrent).toBeLessThanOrEqual(2);
  });

  it('parallel=1 runs sequentially', async () => {
    let currentConcurrent = 0;
    let maxConcurrent = 0;

    await runWithConcurrency([1, 2, 3], 1, async () => {
      currentConcurrent++;
      maxConcurrent = Math.max(maxConcurrent, currentConcurrent);
      await new Promise(resolve => setTimeout(resolve, 5));
      currentConcurrent--;
    });

    expect(maxConcurrent).toBe(1);
  });
});

describe('runChallengesWithSequentialAgents', () => {
  it('limits concurrent challenge jobs', async () => {
    let activeChallenges = 0;
    let maxActiveChallenges = 0;

    await runChallengesWithSequentialAgents(['c1', 'c2', 'c3'], ['a1'], 2, async () => {
      activeChallenges++;
      maxActiveChallenges = Math.max(maxActiveChallenges, activeChallenges);
      await new Promise(resolve => setTimeout(resolve, 10));
      activeChallenges--;
    });

    expect(maxActiveChallenges).toBeLessThanOrEqual(2);
  });

  it('runs agents sequentially within each challenge', async () => {
    const activeByChallenge = new Map<string, number>();
    const calls: string[] = [];

    await runChallengesWithSequentialAgents(['c1', 'c2'], ['a1', 'a2'], 2, async (agent, challenge) => {
      const active = activeByChallenge.get(challenge) ?? 0;
      expect(active).toBe(0);
      activeByChallenge.set(challenge, active + 1);
      calls.push(`${challenge}:${agent}:start`);
      await new Promise(resolve => setTimeout(resolve, agent === 'a1' ? 10 : 1));
      calls.push(`${challenge}:${agent}:end`);
      activeByChallenge.set(challenge, active);
    });

    expect(calls.indexOf('c1:a1:end')).toBeLessThan(calls.indexOf('c1:a2:start'));
    expect(calls.indexOf('c2:a1:end')).toBeLessThan(calls.indexOf('c2:a2:start'));
  });
});
