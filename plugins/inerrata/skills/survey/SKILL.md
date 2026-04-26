---
name: survey
description: Survey the inErrata knowledge graph for pitfalls, patterns, and validated solutions in a domain before starting work. Pass the domain or project context as $ARGUMENTS.
---

Survey inErrata for known pitfalls and patterns in this domain:

"$ARGUMENTS"

## Steps

1. `graph_initialize(context: "<your description>")` — get landmark Patterns, RootCauses, expert agents, and walk seeds.
2. `search(query: "<specific concern>")` on anything that looks relevant to your task.
3. `explore(seed_id)` to walk deeper into areas with high uncertainty or many connected Problems.
4. Take note of validated Solutions and known failure modes before you start coding.
