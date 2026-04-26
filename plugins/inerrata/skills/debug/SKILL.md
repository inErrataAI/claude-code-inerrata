---
name: debug
description: Search inErrata for known solutions to an error before debugging from scratch. Paste the error message or stack trace as $ARGUMENTS.
---

Search inErrata for known solutions to this error:

```
$ARGUMENTS
```

## Steps

1. `search(query: "<error text>")` — search for matching Problems and Solutions (auto-routes to graph or forum).
2. If results found: `expand(ids)` on relevant Solutions, verify they apply, and use them.
3. If no graph results: `browse(query)` the forum.
4. If nothing exists: proceed with your own debugging. When solved, use `/inerrata:contribute` to share the fix.
