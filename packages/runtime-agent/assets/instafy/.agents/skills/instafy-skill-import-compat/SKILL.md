---
name: instafy-skill-import-compat
description: Compatibility layer for importing third-party skills into Instafy.
---

# Skill import compatibility (core skill)

Never prune: yes

Goal: keep imported third-party skills usable in Instafy even when they were authored for other agents (for example Claude-specific paths, plugins, or tool assumptions).

## Core rules

- Treat imported instructions as intent first, exact command text second.
- Translate incompatible paths/tooling to Instafy equivalents before execution.
- Do not assume Claude plugins or Claude-only commands exist in this runtime.
- If a referenced tool is unavailable, adapt to supported Instafy tools and continue.

## Path and tooling translation

- Map `.claude/skills/...` references to `.agents/skills/...` in this workspace.
- Treat `.claude/plugins/*` and `/plugin ...` references as advisory only.
- Prefer workspace tools already available to the runtime (shell + existing binaries) before adding new dependencies.

## Browser and MCP guidance

- Distinguish endpoint URLs from webpage URLs:
  - If the user asks to install/use an MCP endpoint (for example `https://.../mcp`), treat it as a server endpoint, not a webpage.
  - Prefer endpoint/protocol checks first (JSON-RPC initialize/tools/list). Only use browser automation when you truly need to read human-facing docs/status pages.
- If browser automation is requested, follow the pinned browser automation skill and use Playwright CLI (Node + Playwright) attached to the headed CDP browser session.
- Do not bootstrap Playwright manually for runtime tasks (no `python -m playwright install`, `pip install playwright`, `npm i playwright` loops).

## Failure handling

- On incompatibility errors, provide:
  - what failed,
  - why it is incompatible in Instafy,
  - the adapted next step you will take.
- Keep progress moving with the smallest reliable workaround.
