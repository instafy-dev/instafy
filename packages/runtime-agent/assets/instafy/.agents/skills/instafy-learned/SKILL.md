---
name: instafy-learned
description: Index and routing hints for learned memory blocks produced by /learn (kept small; open blocks on demand).
context_kind: learned_index
context_parent: instafy-persistent-contexts
always_include: true
max_children: 2
---

# Learned memory blocks (index)

Never prune: yes

This skill is a **small index** into learned persistent-context blocks created by `/learn`.

Size budget (hard):
- Keep this file under ~6k bytes.
- Index at most ~20 blocks.
- Keep each entry to a single line; put details in the block's `SKILL.md` / `DETAILS.md`.

## Where learned blocks live

- `.agents/skills/instafy-learned/blocks/<name>/SKILL.md`
- Optional deep details: `.agents/skills/instafy-learned/blocks/<name>/DETAILS.md`

Do not load every block. Open only what applies to the current request.

## How to use (strict)

1. Read this index and pick **at most 2** blocks that match the user’s current request.
2. Open those block skill files and follow the procedure.
3. If blocked, open `DETAILS.md` for that block (only then).

## Blocks (managed by /learn)

<!-- /learn will keep this section short and updated. -->
