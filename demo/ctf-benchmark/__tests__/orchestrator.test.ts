import { describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  artifactChallengeId,
  buildAgentSandbox,
  buildClaudeArgs,
  parseConfig,
  parseFindings,
  parseStreamJson,
  prepareColdSourceWorkspace,
  runDisqualificationReasons,
  runChallengesWithSequentialAgents,
  runWithConcurrency,
} from '../benchmark/orchestrator.js';
import { CHALLENGES } from '../challenges/registry.js';
import { SCORING_CHALLENGES } from '../challenges/registry.private.js';
import { opaqueChallengeId } from '../shared/challenge-view.js';
import type { Challenge, WaveConfig } from '../shared/types.js';

describe('CTF Cold-To-Warm Demo orchestrator config', () => {
  it('parses --parallel', () => {
    expect(parseConfig(['--parallel', '7']).parallel).toBe(7);
  });

  it('parses --max-tool-calls', () => {
    expect(parseConfig(['--max-tool-calls', '12']).maxToolCalls).toBe(12);
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
    expect(args.slice(args.indexOf('--max-turns'), args.indexOf('--max-turns') + 2))
      .toEqual(['--max-turns', '35']);
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
    expect(
      sandbox.args.join(' ').includes('demo/ctf-benchmark')
      || (process.env.HOME ? sandbox.args.join(' ').includes(`${process.env.HOME}/Repos`) : false),
    ).toBe(true);
    expect(sandbox.args).toContain('/tmp/ctf-workspace');
    expect(sandbox.mcpConfigPath).toBe('/tmp/ctf-mcp-config.json');
    if (process.env.HOME) {
      const homeBindIndex = sandbox.args.findIndex((arg, index) =>
        arg === '--bind'
        && sandbox.args[index + 1] === process.env.HOME
        && sandbox.args[index + 2] === process.env.HOME,
      );
      expect(homeBindIndex).toBe(-1);
      expect(sandbox.args.join(' ')).toContain(`${process.env.HOME}/Repos`);
    }
  });

  it('prepares cold source workspaces without git history or advisory files', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'ctf-cold-source-'));
    const baseRepo = join(tmp, 'repo');
    mkdirSync(join(baseRepo, 'src'), { recursive: true });
    mkdirSync(join(baseRepo, '.github'), { recursive: true });
    writeFileSync(join(baseRepo, 'src', 'vuln.c'), 'int vuln(void) { return 0; }\n');
    writeFileSync(join(baseRepo, 'NEWS'), 'CVE-shaped release notes\n');
    writeFileSync(join(baseRepo, 'ChangeLog'), 'security fix history\n');
    writeFileSync(join(baseRepo, '.github', 'advisory.yml'), 'private advisory\n');

    try {
      execFileSync('git', ['init', baseRepo], { stdio: 'pipe' });
      execFileSync('git', ['-C', baseRepo, 'add', '.'], { stdio: 'pipe' });
      execFileSync('git', [
        '-C', baseRepo,
        '-c', 'user.email=test@example.com',
        '-c', 'user.name=Test',
        'commit', '-m', 'initial',
      ], { stdio: 'pipe' });
      execFileSync('git', ['-C', baseRepo, 'tag', 'snapshot'], { stdio: 'pipe' });

      const challenge: Challenge = {
        ...CHALLENGES[0],
        repo: 'testrepo',
        affectedVersion: 'snapshot',
      };
      const coldPath = prepareColdSourceWorkspace({
        baseRepoPath: baseRepo,
        reposDir: join(tmp, 'repos'),
        agentId: 'cold-agent',
        challenge,
      });

      expect(existsSync(join(coldPath, 'src', 'vuln.c'))).toBe(true);
      expect(existsSync(join(coldPath, '.git'))).toBe(false);
      expect(existsSync(join(coldPath, 'NEWS'))).toBe(false);
      expect(existsSync(join(coldPath, 'ChangeLog'))).toBe(false);
      expect(existsSync(join(coldPath, '.github'))).toBe(false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('uses opaque challenge ids for cold artifacts', () => {
    const challenge = CHALLENGES[0];
    const coldWave: WaveConfig = {
      number: 1,
      label: 'cold',
      model: 'haiku',
      modelId: 'haiku',
      runtime: 'claude',
      auth: 'none',
      graphState: 'empty',
      canContribute: false,
      spriteType: 'rogue',
      description: 'cold wave',
    };
    const warmWave: WaveConfig = { ...coldWave, auth: 'anonymous' };

    expect(artifactChallengeId(challenge, coldWave)).toBe(opaqueChallengeId(challenge));
    expect(artifactChallengeId(challenge, coldWave)).not.toContain('CVE');
    expect(artifactChallengeId(challenge, coldWave)).not.toContain(challenge.repo);
    expect(artifactChallengeId(challenge, warmWave)).toBe(challenge.id);
  });

  it('disqualifies cold runs for over-budget or external lookup tool use', () => {
    const coldWave: WaveConfig = {
      number: 1,
      label: 'cold',
      model: 'haiku',
      modelId: 'haiku',
      runtime: 'claude',
      auth: 'none',
      graphState: 'empty',
      canContribute: false,
      spriteType: 'rogue',
      description: 'cold wave',
    };

    expect(runDisqualificationReasons({
      toolCalls: Array.from({ length: 13 }, () => 'Bash'),
      classified: { graphHits: 0 },
      wave: coldWave,
      maxToolCalls: 12,
    })).toContain('tool-budget-exceeded:13/12');

    expect(runDisqualificationReasons({
      toolCalls: ['WebSearch'],
      classified: { graphHits: 1 },
      wave: coldWave,
      maxToolCalls: 12,
    })).toEqual([
      'graph-tool-used-in-cold-wave',
      'external-lookup-tool-used-in-cold-wave',
    ]);
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

  it('ignores thinking blocks when extracting scorable output', () => {
    const raw = [
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            { type: 'thinking', thinking: 'hidden reasoning that should not be scored' },
            { type: 'text', text: '<finding>{"challengeId":"current"}</finding>' },
          ],
        },
      }),
      JSON.stringify({
        type: 'result',
        content: [
          { type: 'thinking', thinking: 'more hidden reasoning' },
        ],
      }),
    ].join('\n');

    const parsed = parseStreamJson(raw);
    expect(parsed.text).toBe('<finding>{"challengeId":"current"}</finding>');
    expect(parsed.text).not.toContain('hidden reasoning');
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

  it('maps hidden cold challenge tokens to the active challenge id', () => {
    const challenge = CHALLENGES[0];
    const scoringChallenge = SCORING_CHALLENGES[0];
    const findings = parseFindings(
      `<finding>
{
  "challengeId": "${opaqueChallengeId(challenge)}",
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
