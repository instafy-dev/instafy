---
name: instafy-persistent-contexts
description: Work with persistent context trees instead of flat skill dumps; load roots, select scoped children, and keep routing bounded.
context_kind: root
always_include: true
context_children: instafy-agent-collaboration, instafy-skill-reading, instafy-skill-router, instafy-learned
max_children: 4
routing_keywords: persistent context, context tree, learned memory, context routing, recursive routing
---

# Persistent contexts

Never prune: yes

Treat `.agents/skills/*/SKILL.md` as **persistent context nodes**.

The filesystem format still says "skills", but the working mental model should be:

- root contexts set global memory/routing rules
- agent-collaboration contexts set top-level chat/thread collaboration policy
- workflow contexts describe a task area
- learned contexts capture reusable workflow or project-specific instruction delta
- compact context cards capture soft per-agent/per-scope observations that should stay outside skills
- `INSTAFY.md` stores small stable facts and preferences

## Default routing model

Use a bounded tree, not a flat dump:

1. Load the root context rules first.
2. Load the smallest workflow context(s) that match the request.
3. Load learned child contexts only when they clearly apply.
4. Stop when you can act safely.

Specific contexts are acceptable when their scope is clear. A narrow context is not bad by itself; it becomes bad when it leaks into unrelated tasks.

## Scope rules

Prefer contexts that are scoped to something concrete:

- project/workspace
- workflow type
- automation
- target site/domain
- exact UI / CLI / API cues that actually worked

When two contexts conflict:

- prefer the more specific scope
- prefer the current prompt's exact cues over older sibling-surface memory
- prefer a durable worked cue over a vague summary

## Learned context rules

Learned contexts should usually store:

- where to start
- exact worked cues
- compact pitfalls
- short verify / stop conditions

Soft observations such as "which bench host last had an ESP32 attached" should usually be stored as compact context cards via `instafy agents context put`, not as learned skill blocks. Treat those cards as hints and verify before acting.

Learned contexts should not store:

- replay scripts
- copied command transcripts
- example output values when the stable lesson is how to retrieve them again

## Automations

Recurring automations often reuse a conversation, but do not rely on conversation state alone.

Persistent contexts should still capture durable automation-specific knowledge so a fresh worker or restarted thread can recover quickly.

Good examples:

- "for automation X, the target site exposes the search field as `input name \"q\"`"
- "for domain Y, the stable result entry is `link text \"Fixture News: Beta\"`"
- "for this project, the controller log file is `/tmp/runtime-controller.log`"
- "for automation Z, keep `status dashboard` and `news source` as separate browser child contexts under the same automation root"

For multi-site browser work or monitoring automations:

- prefer one parent context for the automation or workflow
- store one child context per site/domain/session label
- keep each child's worked cues isolated
- do not collapse two sibling sites into one mixed browser memory block

For browser context routing, keep the scope terms distinct:

- `page` contexts: one site/page/tab inside the current shared session
- `isolated session` contexts: same runtime, separate browser context because login/account state must not mix
- `runtime-backed session` contexts: a separate visible browser runtime/surface

Default learned memory should attach to `page` contexts first. Only promote memory to an `isolated session` or `runtime-backed session` scope when the separation itself is the durable lesson.

When the UI already exposes multiple browser page/session cards, treat those as the preferred routing surface:

- default to the currently active card unless the user names another one
- if the user asks to keep multiple sites alive at once, attach a new sibling `page` context before escalating to isolated or runtime-backed scopes

## Loading discipline

- Do not load every context file just because it exists.
- Use the context index to discover what is available.
- Load only the selected context tree plus any directly relevant learned children.
- If blocked, load one more child or details file, not the whole tree.
