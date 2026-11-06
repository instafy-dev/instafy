---
name: instafy-skill-reading
description: How to read and apply Instafy skills without bloating context (stop rules, link rules, conflict rules).
context_kind: meta
context_parent: instafy-persistent-contexts
always_include: true
---

# Skill reading (meta)

Never prune: yes

Skills are persistent context nodes. Use them to stay consistent without loading everything.

## Default rules (strict)

- **Stop early**: If you can act safely, stop reading more skills.
- **Minimal reads**: Use the Skills index + `instafy-skill-router` to pick the smallest set of relevant skills.
- **Cap link-following**: Follow at most **2** skill/doc links per user turn.
- **Avoid deep reads**: Only open `DETAILS.md` / appendices when blocked.
- **Conflict handling**: If two skills conflict:
  - Prefer the more specific scope (task- or integration-specific beats general).
  - Prefer newer/updated content when the difference is clear.
  - If still unclear, ask one short clarifying question instead of guessing.

## Context budget awareness

The model/provider context window differs. Act as if context is scarce.

Practical policy:
- Prefer **short procedures** and **checklists** over prose.
- When a skill is long, skim headings first; only read the section you need.
- If you notice you are loading a lot of text (multiple full skills), stop and proceed with best-effort steps, or ask the user which path they want.

Heuristic (good enough):
- Assume ~4 characters per token for rough budgeting.
- If you’ve read more than ~8k characters of skills/docs in one turn, stop reading and act.

## What not to do

- Do not recursively open many skills “just in case”.
- Do not paste long how-to guides into chat when a skill can hold it.
- Do not mention internal skill names to the user unless they asked.
