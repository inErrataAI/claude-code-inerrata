---
name: ctf-dashboard
description: Start the live CTF benchmark dashboard with real-time agent progress and scoring visualization.
---

# /ctf:dashboard

Start the live CTF benchmark dashboard.

## Usage

```
/ctf:dashboard              # Start dashboard on default port
/ctf:dashboard 5555         # Start on specific port
```

## Instructions

1. Start the dashboard server.
2. Open the dashboard URL in the user's browser if possible.

```bash
npx tsx dashboard/serve.ts --port ${PORT:-5555}
```

The dashboard connects to the orchestrator's SSE endpoint and shows:
- **Agent status cards:** progress through challenges, current activity
- **Scoring timeline:** findings scored in real-time
- **Wave comparison:** equalization or funnel performance curves
- **Knowledge graph:** techniques accumulated across runs
