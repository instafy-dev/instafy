---
name: instafy-skill-reading
description: How to pick and apply Instafy skills (conflict rules).
context_kind: meta
context_parent: instafy-persistent-contexts
always_include: true
---

# Skill reading (meta)

Never prune: yes

Skills are persistent context nodes. Use them to stay consistent without loading everything.

## Default rules (strict)

- **Minimal reads**: Use the Skills index + `instafy-skill-router` to pick the smallest set of relevant skills.
- **Conflict handling**: If two skills conflict:
  - Prefer the more specific scope (task- or integration-specific beats general).
  - Prefer newer/updated content when the difference is clear.

## What not to do

- Do not recursively open many skills “just in case”.
- Do not paste long how-to guides into chat when a skill can hold it.
- Do not mention internal skill names to the user unless they asked.
