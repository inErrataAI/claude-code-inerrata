import { describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  buildAgentSandbox,
  buildClaudeArgs,
  parseConfig,
  parseFindings,
  parseStreamJson,
  runChallengesWithSequentialAgents,
  runWithConcurrency,
} from '../benchmark/orchestrator.js';
import { CHALLENGES } from '../challenges/registry.js';
import { SCORING_CHALLENGES } from '../challenges/registry.private.js';

describe('CTF Cold-To-Warm Demo orchestrator config', () => {
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
    expect(args).not.toContain('--plugin-dir');
  });

  it('uses the bubblewrap agent sandbox when enabled', () => {
    const sandbox = buildAgentSandbox({
      enabled: true,
      repoPath: '/tmp/challenge-repo',
      mcpConfigPath: '/tmp/agent-mcp.json',
    });

    expect(sandbox.enabled).toBe(true);
    expect(sandbox.command).toBe('bwrap');
    expect(sandbox.args).toContain('--tmpfs');
    expect(sandbox.args.join(' ')).toContain('demo/ctf-benchmark');
    expect(sandbox.args).toContain('/tmp/ctf-workspace');
    expect(sandbox.mcpConfigPath).toBe('/tmp/ctf-mcp-config.json');
  });

  it('sandbox exposes only the challenge workspace from the demo tree', () => {
    const repoDir = mkdtempSync(join(tmpdir(), 'ctf-workspace-'));
    const mcpPath = join(repoDir, 'mcp.json');
    writeFileSync(join(repoDir, 'marker.c'), 'int main(void) { return 0; }\n');
    writeFileSync(mcpPath, '{"mcpServers":{}}\n');

    try {
      const sandbox = buildAgentSandbox({
        enabled: true,
        repoPath: repoDir,
        mcpConfigPath: mcpPath,
      });
      if (!sandbox.enabled) return;

      const publicRegistry = join(__dirname, '..', 'challenges', 'registry.ts');
      const privateRegistry = join(__dirname, '..', 'challenges', 'registry.private.ts');
      const check = [
        'test -f marker.c',
        `test ! -e ${JSON.stringify(publicRegistry)}`,
        `test ! -e ${JSON.stringify(privateRegistry)}`,
        `test -f ${JSON.stringify(sandbox.mcpConfigPath)}`,
      ].join(' && ');

      execFileSync(sandbox.command, [...sandbox.args, 'bash', '-lc', check], {
        cwd: sandbox.cwd,
        stdio: 'pipe',
        timeout: 10_000,
      });
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
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

  it('maps hidden cold challenge token to the active challenge id', () => {
    const challenge = CHALLENGES[0];
    const scoringChallenge = SCORING_CHALLENGES[0];
    const findings = parseFindings(
      `<finding>
{
  "challengeId": "current",
  "vulnerableFile": "${scoringChallenge.groundTruth.files[0]}",
  "vulnerableFunction": "${scoringChallenge.groundTruth.functions[0]}",
  "lineRange": [1, 2],
  "bugClass": "command-injection",
  "explanation": "A plausible issue exists in this code path."
}
</finding>`,
      'cold-agent',
      challenge,
    );

    expect(findings).toHaveLength(1);
    expect(findings[0].challengeId).toBe(challenge.id);
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
