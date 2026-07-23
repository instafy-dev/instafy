---
name: instafy-runtime-flavors
description: Current runtime flavor policy and disabled paths.
---

# Runtime flavors (core skill) — disabled

Never prune: yes

This skill is intentionally disabled for now.

## Current behavior

- Do not offer manual runtime image/flavor switching.
- Assume the hosted runtime defaults are managed by the platform.
- For browser tooling tasks, use the existing browser session flow.

## Guardrail

If asked to switch runtime image/flavor manually, state that this path is disabled and continue with standard runtime flows.
