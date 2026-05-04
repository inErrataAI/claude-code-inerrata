import { describe, expect, it } from 'vitest';
import { SCORING_CHALLENGES } from '../challenges/registry.private.js';
import { isSolved, scoreFinding } from '../scoring/judge.js';
import type { Finding } from '../shared/types.js';

function finding(overrides: Partial<Finding> = {}): Finding {
  const challenge = SCORING_CHALLENGES[0];
  return {
    agentId: 'test-agent',
    challengeId: challenge.id,
    timestamp: Date.now(),
    vulnerableFile: challenge.groundTruth.files[0],
    vulnerableFunction: challenge.groundTruth.functions[0],
    lineRange: [1, 2],
    bugClass: challenge.bugClass,
    explanation: `${challenge.groundTruth.description} ${challenge.groundTruth.exploitVector} ${challenge.groundTruth.cweId}`,
    pocCode: `1. Open the vulnerable path\n2. Trigger ${challenge.groundTruth.functions[0]}\n${challenge.groundTruth.exploitVector}`,
    patchSuggestion: `Validate input in ${challenge.groundTruth.functions[0]} and reject unsafe values.`,
    crossRepoPattern: `This command injection pattern is common in other software. Secure coding should avoid shell execution with user input.`,
    ...overrides,
  };
}

describe('CTF Cold-To-Warm Demo scoring', () => {
  it('zeros all score components when the finding cites the wrong location', () => {
    const scored = scoreFinding(finding({
      vulnerableFile: 'base/gdevpipe.c',
      vulnerableFunction: 'fs_file_open_pipe',
    }));

    expect(scored.scores).toEqual({
      location: 0,
      explanation: 0,
      poc: 0,
      patch: 0,
      crossRepo: 0,
      total: 0,
    });
  });

  it('still awards points for findings with a matching location', () => {
    const scored = scoreFinding(finding());
    expect(scored.scores.location).toBeGreaterThan(0);
    expect(scored.scores.total).toBeGreaterThan(0);
  });

  it('flags only exact-function findings with matching bug class and evidence', () => {
    const scored = scoreFinding(finding());

    expect(scored.diagnostics.exactFunctionMatch).toBe(true);
    expect(scored.diagnostics.bugClassMatch).toBe(true);
    expect(scored.diagnostics.evidenceHits.length).toBeGreaterThan(0);
    expect(isSolved(scored)).toBe(true);
    expect(scored.solved).toBe(true);
  });

  it('does not flag file-only findings even when they get partial points', () => {
    const scored = scoreFinding(finding({ vulnerableFunction: undefined }));

    expect(scored.scores.location).toBeGreaterThan(0);
    expect(scored.diagnostics.exactFunctionMatch).toBe(false);
    expect(isSolved(scored)).toBe(false);
    expect(scored.solved).toBe(false);
  });

  it('rejects findings that name a different CVE', () => {
    const scored = scoreFinding(finding({
      explanation: 'This looks like CVE-1999-0001, with a similar vulnerable code path.',
      pocCode: 'Trigger the vulnerable function.',
      patchSuggestion: 'Patch the vulnerable function.',
      crossRepoPattern: undefined,
    }));

    expect(scored.disqualified).toBe(true);
    expect(scored.disqualificationReasons).toContain('wrong-cve-mention:CVE-1999-0001');
    expect(scored.scores.total).toBe(0);
    expect(isSolved(scored)).toBe(false);
  });

  it('does not flag findings with the wrong bug class', () => {
    const scored = scoreFinding(finding({ bugClass: 'buffer-overflow' }));

    expect(scored.scores.total).toBeGreaterThan(0);
    expect(scored.diagnostics.bugClassMatch).toBe(false);
    expect(isSolved(scored)).toBe(false);
  });
});
