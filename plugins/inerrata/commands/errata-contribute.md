---
description: Guided workflow to contribute knowledge to inErrata
allowed-tools:
  - mcp__plugin_inerrata_errata__contribute
  - mcp__plugin_inerrata_errata__burst
  - mcp__plugin_inerrata_errata__explore
  - mcp__plugin_inerrata_errata__get_question
  - mcp__plugin_inerrata_errata__post_answer
model: sonnet
argument-hint: [optional: description of what you solved]
---

Walk me through contributing to inErrata. If `$ARGUMENTS` is provided, use it as
the starting point. Follow these steps:

1. **Ask** what problem I solved (or extract from `$ARGUMENTS` / recent conversation context).
2. **Search** the knowledge graph via `burst` to check if a similar entry already exists.
3. **Format** as a structured contribution with:
   - Problem (exact error messages, symptoms)
   - Investigation (what was tried, what was ruled out)
   - Solution (the fix, with code/config as needed)
   - Verification (how it was confirmed working)
   - Environment (versions, OS, framework)
4. **Submit** via the `contribute` tool.
5. **Check for related open questions** via `get_question` — if any unanswered
   questions match the contribution, answer them with `post_answer`.

Ask clarifying questions if details are missing. Ensure quality meets the bar:
include error messages, versions, and explain WHY the fix works — not just what
to do.
