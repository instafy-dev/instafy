---
name: instafy-research-team
description: Research many items in parallel before building one page, when each needs live lookups (a trip of a week or more or 4+ stops, 3+ products or options to compare). Plans one researcher lane per item with a handoff file each, then builds the page through instafy-interactive-artifacts.
context_kind: workflow
context_parent: instafy-skill-router
routing_keywords: research team, researchers, in parallel, itinerary, road trip, multi-city, two weeks, 10 days, compare products, top 10, shortlist, which to buy
---

# Research team

Researchers run in parallel, one handoff file each; at the final checkpoint the lead builds one page from the
files and replies. Below the threshold, or for a small change to an existing page, build directly with
`instafy-interactive-artifacts`. Adding 3+ new items to an existing page meets the threshold too: lanes research
only the new items.

Uses `multi_agent_plan` as `instafy-agent-collaboration` describes; this skill only says how to split and hand off.

## 1. Plan (emit the plan, build nothing yet)

- Above the threshold the plan is this turn's whole answer. Never ask first: fill gaps with defaults (party of 2,
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
 "agents": [{"handle": "<item>", "label": "<Item>", "prompt": "<lane prompt>",
   "writeScope": {"mode": "owned", "ownedPaths": ["handoff/<task>/<item>.json"]}}],
 "lead": {"leadHandle": "octo", "continuationPrompt": "<as above>",
   "expectedReportFormat": "2-5 lines in the user's terms: verdict, what the page does, the Assumed: line, what is unverified. Never file names, JSON, commands or lanes."},
 "runtimeRouting": {"strategy": "spread"},
 "presentation": {"workerEvidenceVisibility": "surface_on_failure", "leadSummaryVisibility": "hidden"}}
```

## 2. Early checkpoint (a lane failed while others run)

Reply in one line and wait; never build yet. Re-run a failed lane with the same prompt; never change what you
assumed. Say what failed in plain words, never the error text.

## 3. Final checkpoint: build, then reply

- Read every handoff file. Build one page per `instafy-interactive-artifacts`, with the builder it picks from the
  installed skills. A builder skill that can import research handoff files: use that command. Otherwise add each
  place, product and fact with the builder's own commands, keeping each source and date.
- Show what is unverified on the page (each file's `unknowns`).
- Reconcile with `Expect:` before the card: the builder's check, else `instafy bind check <site> --expect "<items>"`.
  Add what is missing; one still missing is named in the reply with why.
- Serve, open the preview card and check it (hub step 3).
- Reply per the hub's step 4. An item the page leaves out is said plainly, never a shorter list presented as the
  answer; suggest "Add <item>" for it among the 2-3 suggested replies.
