---
name: ctf-dashboard
description: Start the live CTF benchmark dashboard with retro arcade visualization, SSE event feed, and real-time scoring.
---

# /ctf:dashboard

Start the live CTF benchmark dashboard.

## Usage

```
/ctf:dashboard              # Start dashboard on default port
/ctf:dashboard 5555         # Start on specific port
```

## Instructions

1. Start the dashboard server, piping benchmark output if a run is active.
2. Open the dashboard URL in the user's browser if possible.

```bash
npx tsx dashboard/serve.ts --port ${PORT:-5555}
```

The dashboard shows:
- **Left panel:** Force-directed knowledge graph growing in real-time
- **Top-right:** Agent status cards with flags/progress
- **Bottom-right:** Activity timeline
- **Header:** Generational score comparison (cold vs warm)
