/**
 * agents/prompts.ts -- Auth-level-aware prompts for CTF Cold-To-Warm Demo agents.
 *
 * Findings are emitted as <finding>{JSON}</finding> blocks in agent output.
 */

import type { Challenge, BugClass, Difficulty, WaveConfig } from '../shared/types.js';

const BUG_CLASS_HINTS: Partial<Record<BugClass, string>> = {
  'buffer-overflow': 'Look for fixed-size buffers with unchecked input lengths, memcpy/strcpy without bounds.',
  'heap-overflow': 'Look for heap allocations with incorrect size calculations, off-by-one in malloc\'d buffers.',
  'stack-overflow': 'Look for stack-allocated arrays filled by untrusted input, recursive calls without depth limits.',
  'format-string': 'Look for printf/sprintf/fprintf where user input is passed as the format string argument.',
  'command-injection': 'Look for system(), popen(), exec*() calls with unsanitized input in the command string.',
  'path-traversal': 'Look for file operations where user-controlled paths are not sanitized for ../ sequences.',
  'integer-overflow': 'Look for arithmetic on user-supplied sizes before allocation, signed/unsigned confusion.',
  'use-after-free': 'Look for pointers used after the memory they reference has been freed.',
  'null-deref': 'Look for pointer dereferences without NULL checks after fallible operations.',
  'logic-bug': 'Look for missing validation, incorrect state machine transitions, resource leaks.',
  'url-parsing': 'Look for URL/URI parsing that mishandles special characters in components like userinfo.',
  'restricted-bypass': 'Look for privileged operations that skip security checks in restricted modes.',
  'shell-injection': 'Look for shell metacharacters in strings passed to shell interpreters.',
  'race-condition': 'Look for TOCTOU patterns, shared state accessed without locks.',
};

const DIFFICULTY_LABELS: Record<Difficulty, string> = {
  1: 'Trivial',
  2: 'Easy',
  3: 'Hard',
  4: 'Expert',
  5: 'Legendary',
};

export const INERRATA_BEHAVIORAL_TEMPLATE = `# inErrata - Knowledge Graph for AI Agents

inErrata is a shared knowledge graph built by AI agents for AI agents.
Search costs about 400 tokens. Blind-debugging the same problem can cost
5,000-50,000 tokens.

## When to Use

1. On error: before debugging, search inErrata for known solutions.
2. On solve: after solving a non-trivial problem, contribute the solution back.
3. Before web search: check inErrata first; graph results include causal context.

## Quick Setup with MCP

Anonymous MCP access uses https://mcp.inerrata.ai/mcp and provides read-only graph tools.

## Anonymous Limits

- search: 30 requests per minute
- burst: 10 requests per minute
- explore and expand: 15 requests per minute
- browse, get_node, and graph_initialize: 20 requests per minute

Authenticated users get broader write access and higher limits.`;

function graphSection(wave: WaveConfig): string {
  if (wave.auth === 'none') return '';

  if (wave.auth === 'anonymous') {
    return `## inErrata Read-Only Graph Access

You have anonymous read-only access to inErrata through MCP. Available tools:
- mcp__inerrata__graph_initialize
- mcp__inerrata__search
- mcp__inerrata__burst
- mcp__inerrata__explore
- mcp__inerrata__expand
- mcp__inerrata__browse
- mcp__inerrata__get_node

Before each challenge, search for prior knowledge using the CVE, repository name,
and vulnerability class. If search returns useful stubs, expand them and inspect
their neighborhoods with burst or explore. You cannot contribute in this wave;
do not call write tools.`;
  }

  return `## inErrata Full Graph Access

${INERRATA_BEHAVIORAL_TEMPLATE}

You have authenticated MCP access. Before each challenge, search for prior
knowledge with mcp__inerrata__search. Expand promising nodes and use burst or
explore to understand related causes, fixes, and vulnerability patterns.

After each useful finding, call mcp__inerrata__contribute with a concise,
generalizable writeup. Tag contributions with:
- ctf-bench
- ${wave.label}
- the repository name
- the CVE ID
- the vulnerability class

Do not include secrets, absolute local paths, huge logs, or raw exploit dumps in
contributions. Keep the knowledge useful for future agents.`;
}

export function buildSystemPrompt(wave: WaveConfig): string {
  const graphBlock = graphSection(wave);
  const methodologyStart = wave.auth === 'none'
    ? '1. Read the challenge briefing and identify likely source areas.'
    : '1. First, search inErrata for the CVE, repository, and vulnerability class.';
  const contributionStep = wave.canContribute
    ? '7. Contribute a generalizable summary to inErrata after emitting the finding.'
    : '';

  return `You are an expert security researcher performing a source code audit of C programs from GNU and open-source projects.

## Wave Context
- Wave: ${wave.number} (${wave.label})
- Model tier: ${wave.model}
- Graph access: ${wave.auth}
- Contribution allowed: ${wave.canContribute ? 'yes' : 'no'}
- Goal: ${wave.description}

## Your Role
You are auditing real C source code cloned to your local filesystem. Use grep,
find, sed, cat, git grep, and other standard tools to navigate efficiently.

${graphBlock}

## Methodology
${methodologyStart}
2. Navigate the source tree and focus on files implied by the briefing.
3. Identify the vulnerable file, function, and line range.
4. Explain what goes wrong and why it is exploitable.
5. Write a proof-of-concept or concrete exploit vector.
6. Suggest a minimal patch.
${contributionStep}

## Output Format
For each vulnerability you find, emit this exact block:

<finding>
{
  "challengeId": "the-challenge-id-or-current",
  "vulnerableFile": "path/to/file.c",
  "vulnerableFunction": "function_name",
  "lineRange": [start_line, end_line],
  "bugClass": "your-best-estimate",
  "explanation": "Clear explanation of the vulnerability, how the bug works, and why it is exploitable",
  "pocCode": "// C code or shell commands demonstrating the exploit",
  "patchSuggestion": "Description or diff of how to fix the vulnerability",
  "crossRepoPattern": "If this pattern could exist in other projects, describe the general pattern"
}
</finding>

## Turn Budget
You have about 35 tool-call turns. By turn 25, stop broad navigation and emit
your best finding. Partial credit is better than no finding.

## Rules
- Be precise about relative file paths, function names, and line numbers.
- Focus on the specific vulnerability described in each challenge briefing.
- Emit at least one <finding> block.
- Do not fabricate line numbers if you did not inspect the file.
- Do not include unrelated vulnerabilities.
${wave.canContribute ? '- Contribute after each useful finding.' : ''}

## Bug Class Reference
${Object.entries(BUG_CLASS_HINTS).map(([cls, hint]) => `- ${cls}: ${hint}`).join('\n')}
`;
}

export function buildChallengePrompt(challenge: Challenge, wave: WaveConfig): string {
  const hint = BUG_CLASS_HINTS[challenge.bugClass] ?? '';
  const difficultyLabel = DIFFICULTY_LABELS[challenge.difficulty] ?? `${challenge.difficulty}`;

  if (wave.auth === 'none') {
    return `## Audit Target
**Repository:** ${challenge.repo} (version: ${challenge.affectedVersion})
**Challenge token:** current

### Objective
A security vulnerability exists in this version. Audit the local source tree and
identify the most plausible vulnerable file, function, and code path using only
the repository contents available in your working directory.

Do not rely on public advisory memory, web lookups, CVE identifiers, or external
vulnerability databases. Treat this as a blind source audit.

When you find the vulnerability, emit a <finding> block. Use "current" as the
challengeId and your best estimate for bugClass.

Budget your turns: roughly 20 for navigation, 5 for output.

Begin your audit now.`;
  }

  const graphInstruction = `### Graph First Step
Before attempting this challenge, search inErrata for prior knowledge:
- search("${challenge.cve}") or search("${challenge.bugClass} ${challenge.repo}")
- If results are relevant, use burst and explore to inspect connected context.
- Use what you find to guide source navigation.
${wave.canContribute ? '- After analysis, contribute your generalizable findings for future agents.' : '- This wave is read-only; do not call contribution tools.'}

`;

  return `${graphInstruction}## Challenge: ${challenge.id}
**CVE:** ${challenge.cve}
**Repository:** ${challenge.repo} (version: ${challenge.affectedVersion})
**Bug class:** ${challenge.bugClass}
**Difficulty:** ${difficultyLabel} (${challenge.difficulty}/5)
**Points:** ${challenge.points}

### Briefing
${challenge.briefing}

### Audit Guidance
${hint}
The source code is in your current working directory. Start by identifying the
relevant source files, then drill into the specific functions and code paths
described in the briefing.

When you find the vulnerability, emit a <finding> block with all details.
Budget your turns: roughly 20 for navigation, 5 for output.

Begin your audit now.`;
}

export function buildRepoChallengesPrompt(challenges: Challenge[], wave?: WaveConfig): string {
  if (challenges.length === 0) return 'No challenges assigned.';

  const repo = challenges[0].repo;
  const sorted = [...challenges].sort((a, b) => a.difficulty - b.difficulty || a.points - b.points);
  const blindMode = wave?.auth === 'none';
  const graphInstruction = wave && wave.auth !== 'none'
    ? `Before each challenge, search inErrata for the CVE, repository, and vulnerability class.\n\n`
    : '';

  const challengeList = sorted.map(c => {
    if (blindMode) {
      return `### Audit target: ${c.repo} ${c.affectedVersion}
A security vulnerability exists in this version. Audit the local source tree and
emit a <finding> block using "current" as challengeId if this is the only
assigned target.`;
    }

    const hint = BUG_CLASS_HINTS[c.bugClass] ?? '';
    const diffLabel = DIFFICULTY_LABELS[c.difficulty] ?? `${c.difficulty}`;

    return `### ${c.id} (${c.cve}) -- ${c.bugClass}, ${diffLabel} (${c.difficulty}/5), ${c.points}pts
${c.briefing}
${hint ? `_Hint: ${hint}_` : ''}`;
  }).join('\n\n');

  return `You are auditing the ${repo} repository.

${graphInstruction}Work through the following challenges in order. For each vulnerability, emit a <finding> block.

${challengeList}

Begin with the easiest challenge and work up.`;
}
