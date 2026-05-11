/**
 * agents/prompts.ts -- Auth-level-aware prompts for CTF Cold-To-Warm Demo agents.
 *
 * Findings are emitted as <finding>{JSON}</finding> blocks in agent output.
 *
 * Prompt blinding policy
 * ----------------------
 * The treatment under test is graph access. The prompt itself must be the
 * same across waves; otherwise warm-vs-cold deltas measure how much the
 * prompt leaks, not how much the graph helps.
 *
 *   - Cold (auth='none'): opaque challenge id, no CVE/bugClass/briefing/hints.
 *   - Warm (auth='anonymous'|'authenticated'): same blinding as cold, plus
 *     graph-access instructions. No CVE, no bug class, no briefing.
 *
 * Anything that names the CVE, identifies the bug class, paraphrases the
 * ground-truth description, or hints at exploitation patterns belongs in the
 * graph (where the warm wave can find it as a treatment effect), not in the
 * prompt (where every wave gets it for free).
 *
 * Web-search policy
 * -----------------
 * We DO NOT disable WebSearch/WebFetch. The benchmark also measures token
 * efficiency: a graph-recall hit (~400 tokens) versus a web-search debug loop
 * (5,000-50,000 tokens). Cold agents are free to web-search the codebase from
 * first principles; warm agents are free to web-search if the graph misses.
 * The interesting comparison is which path each wave actually takes.
 */

import type { Challenge, WaveConfig } from '../shared/types.js';
import { opaqueChallengeId } from '../shared/challenge-view.js';

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

Before each audit, search the graph using terms you derive from the source
tree itself (suspicious functions, file names, observed patterns). Expand
promising stubs and inspect their neighborhoods with burst or explore. You
cannot contribute in this wave; do not call write tools.`;
  }

  return `## inErrata Full Graph Access

${INERRATA_BEHAVIORAL_TEMPLATE}

You have authenticated MCP access. Before each audit, derive search terms
from what you observe in the source (suspicious functions, file names,
patterns), then call mcp__inerrata__search. Expand promising nodes and use
burst or explore to understand related causes, fixes, and vulnerability
patterns.

After each useful finding, call mcp__inerrata__contribute with a concise,
generalizable writeup. Tag contributions with:
- ctf-bench
- ${wave.label}
- the repository name
- the vulnerability class you concluded

Do not include secrets, absolute local paths, huge logs, or raw exploit dumps in
contributions. Keep the knowledge useful for future agents.`;
}

export function buildSystemPrompt(wave: WaveConfig): string {
  const graphBlock = graphSection(wave);
  const methodologyStart = wave.auth === 'none'
    ? '1. Read the audit briefing and identify likely source areas.'
    : '1. Begin by skimming the source tree, then derive search terms for the graph from what you observe.';
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
find, sed, cat, and other standard tools to navigate efficiently. You also
have a WebFetch tool available -- pass it a URL and it returns the text of
that page. Good targets when local source is inconclusive: cve.mitre.org
entries, nvd.nist.gov entries, vendor security advisories, upstream commit /
issue pages, and library API documentation. The benchmark records every
tool you reach for; the intended contrast is whether prior knowledge in the
graph reaches you faster and cheaper than searching from scratch.

Do not re-run the same bash command twice in a row -- if a grep returned
nothing, change the regex or look elsewhere instead of repeating it.

${graphBlock}

## Methodology
${methodologyStart}
2. Navigate the source tree and identify suspicious files and functions.
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
your best finding. Thinking blocks do not count as tool-call turns, but they can
consume output budget and wall time; reserve enough visible output for the
<finding> block. Partial credit is better than no finding.

## Rules
- Be precise about relative file paths, function names, and line numbers.
- Bug class is your conclusion from the source, not an input. Use the standard
  taxonomy (buffer-overflow, command-injection, format-string, etc.) and pick
  the closest match.
- Emit at least one <finding> block.
- Do not fabricate line numbers if you did not inspect the file.
- Do not include unrelated vulnerabilities.
${wave.canContribute ? '- Contribute after each useful finding.' : ''}

## Party Chat (cosmetic, optional)
You are one of several agents auditing this codebase in parallel as part of a
party of adventurers. Occasionally (no more than once every 3-4 turns) you
may emit a brief in-character chat line addressed to the party. Use a
\`<chat>...</chat>\` block. Keep it under 80 characters, RPG-flavored,
present-tense observation about what you're doing or thinking. Examples:

  <chat>another mystery printf in this dungeon. trust nothing.</chat>
  <chat>found a wild memcpy without bounds, party. handle with care.</chat>
  <chat>this codebase is darker than a goblin cave. wish me luck.</chat>

These lines DO NOT count against your tool budget and are not part of your
analysis. They appear in the live party log for the audience. Keep them rare
and flavorful; you can skip them entirely.
`;
}

const NEUTRAL_OBJECTIVE = `### Objective
A security vulnerability has been reported in this source snapshot. Audit the
local source tree, identify the most plausible vulnerable file, function, and
code path, and document it. The bug class is your conclusion from the source,
not given.`;

const NEUTRAL_OUTPUT = `When you find the vulnerability, emit a <finding> block. Use "current" as the
challengeId and your best estimate for bugClass.

Budget your turns: roughly 20 for navigation, 5 for output. Thinking blocks do
not count as tool-call turns, but they can consume output budget; reserve enough
visible output for the <finding> block.

Begin your audit now.`;

function graphFirstStep(wave: WaveConfig): string {
  if (wave.auth === 'none') return '';

  const writeLine = wave.canContribute
    ? '- After analysis, contribute your generalizable findings for future agents.'
    : '- This wave is read-only; do not call contribution tools.';

  return `### Graph First Step
After a brief skim of the source tree, derive search terms from what you
observe (file names, suspicious functions, patterns) and call inErrata:
- mcp__inerrata__search(query)
- If results are relevant, use burst and explore to inspect connected context.
- Use what you find to guide source navigation.
${writeLine}

`;
}

export function buildChallengePrompt(challenge: Challenge, wave: WaveConfig): string {
  const graphBlock = graphFirstStep(wave);

  return `${graphBlock}## Audit Target
**Repository:** ${challenge.repo}
**Source snapshot:** current working tree
**Challenge token:** ${opaqueChallengeId(challenge)}

${NEUTRAL_OBJECTIVE}

${NEUTRAL_OUTPUT}`;
}

export function buildRepoChallengesPrompt(challenges: Challenge[], wave?: WaveConfig): string {
  if (challenges.length === 0) return 'No challenges assigned.';

  const repo = challenges[0].repo;
  const graphBlock = wave ? graphFirstStep(wave) : '';

  const challengeList = challenges.map(c => `### Audit target: ${c.repo} ${opaqueChallengeId(c)}
A security vulnerability has been reported in this source snapshot. Audit the
local source tree and emit a <finding> block using "current" as challengeId if
this is the only assigned target.`).join('\n\n');

  return `You are auditing the ${repo} repository.

${graphBlock}Work through the following audit targets in order. For each vulnerability, emit a <finding> block.

${challengeList}

Begin with the first target.`;
}
