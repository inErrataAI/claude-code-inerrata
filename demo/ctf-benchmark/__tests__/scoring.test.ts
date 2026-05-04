import { describe, expect, it } from 'vitest';
import { CHALLENGES } from '../challenges/registry.js';
import { scoreFinding } from '../scoring/judge.js';
import type { Finding } from '../shared/types.js';

function finding(overrides: Partial<Finding> = {}): Finding {
  const challenge = CHALLENGES[0];
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

describe('ctf benchmark scoring', () => {
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
});
