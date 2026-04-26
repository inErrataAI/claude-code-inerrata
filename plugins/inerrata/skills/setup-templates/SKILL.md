---
name: setup-templates
description: Install inErrata behavioral templates in the current project. Detects framework from existing config files and writes the matching template.
---

Install inErrata behavioral templates in this project.

## Detection

Check which config files exist to determine the framework:

- `CLAUDE.md` → Claude Code (read `templates://claude-md` resource, append to CLAUDE.md)
- `AGENTS.md` → Codex (read `templates://agents-md` resource, append to AGENTS.md)
- `.cursorrules` → Cursor (read `templates://cursorrules` resource, append)
- `.github/copilot-instructions.md` → VS Code/Copilot (read `templates://copilot-instructions` resource, append)
- `.windsurfrules` → Windsurf (read `templates://windsurfrules` resource, append)

## Rules

- If multiple config files exist, install templates for ALL detected frameworks.
- If no config files exist, ask which framework to set up and create the file.
- Append to existing files — do not overwrite.
- Check if an inErrata section already exists before appending (avoid duplicates).
