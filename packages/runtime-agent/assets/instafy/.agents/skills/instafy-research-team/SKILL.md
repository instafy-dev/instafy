---
name: instafy-research-team
description: Research many items in parallel before building one page, when each needs live lookups (a trip of a week or more or 4+ stops, 3+ products or options to compare). Uses available tool-capable researchers with a handoff per item, then builds the page through instafy-interactive-artifacts.
context_kind: workflow
context_parent: instafy-skill-router
routing_keywords: research team, researchers, in parallel, itinerary, road trip, multi-city, two weeks, 10 days, compare products, top 10, shortlist, which to buy
---

# Research team

Split independent research among tool-capable helpers when available, with one handoff per item; the lead
then builds one page from the findings and replies. Below the threshold, or for a small change to an existing page, build directly with
`instafy-interactive-artifacts`. Adding 3+ new items to an existing page meets the threshold too: lanes research
only the new items.

Use `instafy-agent-collaboration` to choose execution before splitting the items. Live lookups require actual
read/search tools; file ownership and runtime spread do not provide them.

## 1. Choose execution and split the research

- Use available native helpers for independent live lookups in an ordinary turn. Pass each helper the exact
  source locators, constraints and a distinct handoff path. These paths coordinate shared-workspace writes;
  they are not independently enforced scopes. Wait for all needed helpers before synthesis.
- Use durable `multi_agent_plan` workers only when their runtime reports tool-capable execution and admits
  the scope. Set `requiresTools: true` on every worker needing commands or live observations. The ordinary
  scoped file-generation path cannot research; `spread` does not change that. Never enable experimental
  execution or change permissions from a prompt.
- If helpers or tool-capable workers are unavailable, research directly with the parent's available tools.
  Preserve an explicitly requested mechanism; explain its unavailability instead of silently substituting.
- Browser-bound turns remain single-agent. Helpers use public read/search tools only; a page requiring an
  interactive browser becomes a sourced gap for a later single-controller browser step. Do not share browser
  grants with helpers or emit a worker plan from a browser-bound turn.
- Allocate the available read/search budget across helpers before starting them; do not give every helper
  the parent's full allowance. Use disjoint source questions and reconcile duplicates at synthesis.
- When durable workers are selected, the plan is this turn's whole answer. Never ask first: fill gaps with defaults (party of 2,
  mid-range, a balanced pace, the length they gave or a week, the dates they named) and state them.
- List the items the answer must cover: every one the user named plus those you chose. Every item gets a lane;
  none is dropped to fit. One lane per item (a city, a cluster of nearby stops, a product); extra lanes queue.
- Slugs (lowercase ascii): `<task>` for the request, `<item>` per lane, `<slug>` for `sites/<slug>/`.
- Each lane's prompt: the user's constraints verbatim (else your defaults), what to find for that item, "Follow
  `.agents/skills/instafy-research-team/references/researcher.md`", and "Write `handoff/<task>/<item>.json`".
- `summary` (the user sees it): about how long it takes, plus ONE `Assumed:` line for what you filled in.
- `lead.continuationPrompt`: "Final checkpoint for <task>: follow step 3 of
  `.agents/skills/instafy-research-team/SKILL.md`. User request: <verbatim>. Assumed: <line>. Expect: <every
  item>. Handoffs: handoff/<task>/. Site: sites/<slug>/."

```json
{"type": "multi_agent_plan", "mode": "write_scoped", "rationale": "Independent live research per item",
 "thresholdReason": "<n> items that each need live lookups", "handoffPaths": ["handoff/<task>/**"],
 "agents": [{"handle": "<item>", "label": "<Item>", "prompt": "<lane prompt>", "requiresTools": true,
   "writeScope": {"mode": "owned", "ownedPaths": ["handoff/<task>/<item>.json"]}}],
 "lead": {"leadHandle": "octo", "continuationPrompt": "<as above>"},
 "runtimeRouting": {"strategy": "spread"},
 "presentation": {"workerEvidenceVisibility": "surface_on_failure", "leadSummaryVisibility": "hidden"}}
```

## 2. Early checkpoint (a lane failed while others run)

Keep useful failure details visible in plain language. Do not repeat a worker with missing capabilities;
resolve the missing capability or carry the gap to synthesis. Retry only a diagnosed transient failure within
the existing limits, without changing assumptions or repeating other workers' completed research.

## 3. Final checkpoint: build, then reply

- Read every handoff file and reconcile it with actual tool results. A generated file alone is not proof of
  a live lookup; retain source URLs, retrieval dates and unknowns. Build one page per `instafy-interactive-artifacts`, with the builder it picks from the
  installed skills. A builder skill that can import research handoff files: use that command. Otherwise add each
  place, product and fact with the builder's own commands, keeping each source and date.
- Show what is unverified on the page (each file's `unknowns`).
- Reconcile with `Expect:` before the card: the builder's check, else `instafy bind check <site> --expect "<items>"`.
  Add what is missing; one still missing is named in the reply with why.
- Serve, open the preview card and check it (hub step 3).
- Reply per the hub's step 4. An item the page leaves out is said plainly, never a shorter list presented as the
  answer; suggest "Add <item>" for it among the 2-3 suggested replies.
