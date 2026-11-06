---
name: instafy-learning-policy
description: Policy for when to create project learnings and how to keep them compact and reusable.
---

# Learning policy

Never prune: yes

This skill defines when the Agent should create learnings and how `/learn` should shape them.

This policy is generic. Workflow-specific behavior belongs in pinned workflow skills; learned memory should capture only the reusable delta that remains after those skills are assumed.

## Start-of-task ritual

- Load the project-memory snapshot once. Prefer `python AGENTS.py` if present.
- Use `instafy-skill-reading` and `instafy-skill-router` to choose the smallest relevant skill set.
- Skim legacy `learnings/` only when relevant to the request or before non-trivial workspace changes.
- For trivial questions that do not require workspace context, answer immediately.

## When to write a learning

Write a learning when:
- a user teaches a stable long-term preference or rule, or
- the solution was expensive to rediscover, or
- the next run would likely avoid retries if one compact heuristic were stored.

## What good memory looks like

Prefer memory that helps the next run choose better, not memory that tries to replay the old run.

Good:
- where to look first
- exact stable cues you observed
- compact pitfalls and recovery hints
- short verify / stop conditions
- task-specific delta over pinned skills

Stable cues can include:
- selectors, ids, names, labels, relative hrefs, routes
- file paths, config keys, JSON fields, environment variable names
- CLI subcommands, flags, or output labels
- API endpoints, request fields, or response field names

When a cue is stable and exact, preserve it exactly instead of downgrading it to a vague phrase.
When possible, encode the cue as `control type + exact cue`, not just the noun alone. Prefer shapes like:
- `button text "Next page"`
- `link text "Delta listing"`
- `input name "q"`
- `textbox labeled "Search"`
- `JSON key "workspace_id"`
- `page button text "2"`
- `search submit button text "Go"`

When multiple cues are available for the same action, prefer the strongest durable discriminator you actually observed. A good default order is:
- explicit machine-facing identifiers (`data-testid`, stable ids, exact field names, exact JSON keys)
- exact labels / aria-labels / role-and-name pairs
- exact relative routes / path segments / subcommands / flag names
- nearby visible text only when nothing more durable is available

If the successful run clearly revealed a stronger cue than the one written in memory, store the stronger cue. Do not keep route-level memory when the worked run actually proved a stable exact control. For example:
- prefer `input name "q"` over `open /search and search for beta`
- prefer `button text "Go"` over `submit the query`
- prefer `link text "Fixture News: Beta"` over `open the Beta result`
- prefer `button text "2"` or `button text "Next page"` over `go to page 2`

Do not replace the actual worked control with a different but “equivalent” summary. If the successful run used `link text "Next page"`, do not rewrite that to `page 2` unless the worked control was actually a `2` button. If the successful run used `button text "Go"`, do not rewrite that to `button text "Search"` just because the field label was `Search`.

If the successful run only completed after repairing a wrong guess, preserve the repaired cue that actually worked, not the original failed guess. Memory should capture what resolved the ambiguity. For example:
- if `page 2` was the intent but the actual successful control was `link text "Next page"`, store `link text "Next page"`
- if `search` was the intent but the actual successful submit control was `button text "Go"`, store `button text "Go"`

Do not throw away a strong cue and replace it with a weaker one just to sound more general.
If one exact control or label is what actually worked in the successful run, preserve that successful cue instead of replacing it with an adjacent or “equivalent” guess.
If a successful browser/UI run depended on a concrete control, the learning should store the exact control that worked, not just the intent. Weak summaries like these are not enough by themselves:
- `use page 2`
- `open the matching result`
- `search for beta`
- `click through to the article`

Rewrite them into worked cues such as:
- `click the pagination button text "2"`
- `open the result link text "Fixture News: Beta"`
- `fill the textbox labeled "Search"`
- `activate the visible search submit button text "Go"`

If the successful path clearly depended on two separate cues, preserve both of them together instead of collapsing the sequence into one vague summary. Common examples:
- pagination/listing flows: keep both the pagination cue and the target result cue
- search/result flows: keep both the search-field cue and the submit/result cue
- menu/detail flows: keep both the menu/tab cue and the final detail cue

If those cues belong to different reusable stages with different entry states, prefer **two compact learned blocks** over one over-combined block. For example:
- one block for "reach catalog page 2 where Delta becomes visible"
- one block for "from catalog page 2, open Fixture News: Delta and read Article token:"

Use one combined block only when the stages are not independently reusable. If the next run could start from the intermediate state, split the memory.

Treat the following as a default split boundary:
- one stage narrows the state (search, filter, pagination, tab/menu switch, listing selection)
- the next stage enters a final detail/article/entity page and performs retrieval there

If a draft learned block contains both:
- the narrowing/navigation cues, and
- the final detail-entry + detail-page verification cues

then that draft is over-combined by default. Rewrite it into two blocks unless the final entry cannot be reused independently of the narrowing stage.

For these paired-control cases, route-level memory alone is incomplete. Avoid summaries like:
- `go to page 2 and open Delta`
- `search for beta and open the article`

Prefer explicit paired cues like:
- `click the pagination button text "2", then open the result link text "Fixture News: Delta"`
- `activate the link text "Next page", then open the result link text "Delta listing"`
- `fill input name "q", activate the submit button text "Go", then open the result link text "Fixture News: Beta"`
- `open the tab text "Directory", then select the row link text "Epsilon Labs"`

For pagination/listing flows, do not weaken an exact worked result cue into fuzzy text-matching language. Reject phrases like:
- `open the listing matching Delta`
- `click the Delta result`
- `follow the item containing Delta`

If the successful run exposed an exact result link or stable href, preserve it exactly, for example:
- `open the result link text "Fixture News: Delta"`
- `open the result link text "Delta listing"`
- `open a[href$="/article/delta"]`

For listing/article flows, keep the exact article-entry cue that actually worked. Do not replace a specific worked link with a fuzzy content match just because the page context was already narrowed. Reject phrases like:
- `open the Delta listing from page 2`
- `open the article matching Delta`
- `follow the listing that contains Delta`

Prefer exact article-entry cues such as:
- `open the result link text "Fixture News: Delta"`
- `open the result link text "Delta listing"`
- `open a[href$="/article/delta"]`

Do not weaken an exact visible article-entry cue into substring language. Reject phrases like:
- `open the link containing Delta`
- `open the visible Delta link`
- `follow the entry with Delta in the text`

If the listing stage and the article-entry stage can be reused independently, do not force them into one learned block. Store:
- a listing/navigation block that ends once the target entry is visible
- an article-entry block that starts from that narrowed listing state

For catalog/listing/article flows, a combined block like:
- `start from /catalog, click 2, open Fixture News: Delta, verify /article/delta`

is lower quality than two blocks:
- `from /catalog, click the pagination button text "2"; verify the result link text "Fixture News: Delta" is visible`
- `from the narrowed listing state, open the result link text "Fixture News: Delta"; verify /article/delta and read "Article token:"`

For filter-form / table-selection flows, selector-grade narrowing cues matter in the same way. Do not collapse a worked filter interaction into vague language like:
- `filter to the green row`
- `use the team filter`
- `apply the visible filter and open Epsilon`

Prefer the exact worked cues you actually observed, for example:
- `select name "team" option value "green" text "Green"`
- `activate the button text "Apply filter"`
- `open the result link text "Epsilon account"`

If a successful run used a filter form and then opened a row/article, memory is incomplete unless it preserves all worked cues that actually mattered:
- the filter field cue
- the chosen option cue
- the submit cue
- the result-row cue

For filter stages, the submit cue is required at the same strength as the field cue. If the successful run used an exact visible button label, button text, aria label, or stable submit selector, the learned block is invalid unless it preserves that exact submit label or selector.

A block like:
- `filter to team green and open Epsilon`
is incomplete.

Rewrite it into something like:
- `select the combobox labeled "Team" to option text "Green", activate the button text "Apply filter", then open the link text "Epsilon account"`
- `use select name "team" option value "green", click the button text "Apply filter", then open a[href$="/article/epsilon"]`

If the successful run exposed different exact cues for the field label, option label, and submit control, preserve all of them instead of collapsing them into one summary.
Do not rewrite:
- `activate the button text "Apply filter"`
into:
- `use the visible filter/apply submit control`
- `apply the filter`
- `submit the visible filter form`

If the successful run depended on an exact visible submit label, button text, or stable submit selector, a learned block is still incomplete when it keeps the field and option but downgrades the submit step to a generic phrase. Treat:
- `select name "team" option value "green", then use the visible filter/apply control`
as lower quality than:
- `select name "team" option value "green" text "Green", then activate the button text "Apply filter"`

Do not rewrite:
- `open the result link text "Epsilon account"`
into:
- `open the Epsilon account`
- `open the Epsilon entry`

If the successful run exposed both the option value and the visible option text, preserve both when they add certainty, for example:
- `select name "team" option value "green" text "Green"`

For search/result flows, selector-grade submit cues matter. Do not write generic phrases like:
- `submit the visible search flow`
- `use the search controls`
- `open the result that lands on /article/beta`

Prefer the strongest exact worked cue you actually observed, for example:
- `activate the button text "Search"`
- `activate the button text "Go"`
- `open the link text "Fixture News: Beta"`
- `open a[href$="/article/beta"]`

For search flows, memory is incomplete unless it preserves all worked cues that actually mattered:
- the search field cue
- the submit cue
- the result cue

If a successful run used a search form and then opened a result, do not allow the learning to stop at only the route or the query term. Preserve the exact worked form controls and the exact result cue together. A block like:
- `start at /search and search for beta`
is incomplete.

Rewrite it into something like:
- `fill input name "q" with "beta", activate the button text "Search", then open the link text "Fixture News: Beta"`
- `fill the textbox labeled "Search", submit with the button text "Go", then open the result link text "Fixture News: Beta"`

Do not accept submit phrases that still hide the actual worked control, for example:
- `submit with the visible control for the search flow`
- `use the visible search control`
- `activate the search submit action`

Those are still missing the selector-grade cue. Replace them with the exact worked role-and-name or selector, such as:
- `activate the button text "Search"`
- `activate the button text "Go"`
- `click button[aria-label="Search"]`
- `submit via input[type="submit"][value="Search"]`

If the successful run exposed different exact cues for the field and the submit control, preserve both exact cues instead of collapsing them into one conceptual label. For example:
- `fill the textbox labeled "Search", then activate the button text "Go"`

Do not rewrite that into:
- `use the Search controls`
- `submit with the visible search control`
- `activate the search action`

When run traces or command JSON include a `workedCues` object or array, or explicit cue fields such as `SEARCH_FIELD_CUE`, `SUBMIT_CONTROL_CUE`, `PAGE_ADVANCE_CUE`, `RESULT_ENTRY_CUE`, or `READBACK_LABEL_CUE`, treat those exact observed cues as the preferred source of truth for learned memory. Prefer the explicit worked cue record over your own paraphrase.

When the successful run exposed both a route and an exact control, keep the route only as context and keep the exact control as the actionable part. A learning that says only where to go, but not which worked control to use there, is incomplete.

For search/result flows, a block is still invalid if it keeps only:
- the route
- the query term
- the final destination route

and drops the exact worked:
- field cue
- submit cue
- result-entry cue

Reject blocks like:
- `start at /search and search for beta`
- `use query beta and expect /article/beta`
- `open /search, submit beta, then land on /article/beta`

until they preserve the exact worked control/result cues, for example:
- `fill input name "q" with "beta", activate the button text "Go", then open the result link text "Fixture News: Beta"`
- `fill the textbox labeled "Search" with "beta", activate the button text "Search", then open a[href$="/article/beta"]`

If the task ends by reading a label, token, code, score, or other page value, keep the retrieval cues you actually observed on the page, not the example value and not only the requested output key. Prefer memories like:
- `read the article token from the page label "Article token:" and map it into the final reply line "ARTICLE_TOKEN"`
- `read the status from the row field labeled "Status"`

Avoid memories like:
- `the learned token value was BETA-TOKEN-2a4e19`
- `the answer was code 7314`
- `reply with the exact example value from the prior run`
- `read the value from "ARTICLE_TOKEN"` when the page never used that label

Do not put one observed sample value into `Verify` just because the benchmark happened to expose it. If the value is expected to vary between runs, `Verify` should talk about:
- the route or page section
- the human-facing retrieval label
- the mapping into the final reply field

Reject verification like:
- `The token observed in the benchmark run is BETA-TOKEN-2a4e19`
- `Verify the token equals DELTA-TOKEN-5c203a`

Prefer:
- `Verify the token is read from the visible label "Article token:"`
- `Verify the page is /article/beta before reading the token label`

If the successful run exposed the retrieval label but the concrete value is expected to vary between runs, never store the example value as memory. Preserve:
- where to read it from
- how to map it into the requested reply field

Do not write verification like:
- `The token value is BETA-TOKEN-2a4e19`
- `Expect code 7314`

unless the concrete value itself is the durable fact the next run truly needs.

If the prompt or harness uses a synthetic output key, but the successful page uses a different visible label, preserve both:
- the actual observed page label used for retrieval
- the mapping to the requested final output key

For example:
- `read the page label "Article token:" and map it to the final reply field "ARTICLE_TOKEN"`
- `read the visible label "Verification code" and return it as "CODE"`

Do not discard the actual page label just because the final answer format uses a different field name.

If a browser command succeeded once, do not turn cleanup worries into learned policy. Avoid phrases like:
- `rerun if the browser disconnect looks slow`
- `retry because the node process may hang`
- `repeat the command if cleanup feels uncertain`

Those are transient execution anxieties, not durable task memory. Keep the learned block focused on the worked cues and the retrieval target.

When a failed attempt hit a visible gate, interstitial, or refusal page and a later successful attempt reached the target by taking a different UI path, store the gate cue and the recovery invariant. Good examples:
- `If the page heading is "Search required", stop trying to read fields from that page and return to the site search/archive UI.`
- `A direct article deep link can be gated; recover by using the visible lookup/search flow first.`

When the repaired run succeeded on a sibling surface with different exact controls, keep the gate/recovery invariant separate from the surface-specific controls. Do not overfit the old route if the broader lesson is:
- direct entry is blocked
- the visible site search/archive UI must be used first
- prompt-provided exact controls on the new surface should still win over old learned controls

In those cases, the learning should preserve:
- the exact gate cue that signals recovery is needed
- the general recovery path (`use the site search/archive UI first`)
- any exact controls that were truly stable across both surfaces

Do not turn one repaired run into a universal route prescription like:
- `always start from /search`
- `for Beta tasks always use textbox labeled Search`

if the broader lesson was only that the task cannot bypass the search/archive flow.

When a future prompt names exact controls on a sibling surface, those prompt-provided controls override older learned surface-specific controls. In that case, the learned block should contribute only the durable invariant and the retrieval cue. For example:
- prompt says `Navigate to /lookup`, `button text "Find"`, `search for "beta dossier"`
- older memory says `Start from /search`, `search for beta`

The correct next-run behavior is:
- keep the learned gate invariant (`direct article deep links can be gated; use the site search/archive UI first`)
- follow the prompt’s exact sibling-surface controls (`/lookup`, `Find`, `beta dossier`)
- keep the learned retrieval cue if it still applies (`read the page label "Article token:" and map it to "ARTICLE_TOKEN"`)

For local/dev/test environments with ephemeral hosts or ports, prefer route-level, path-level, or label-level memory over full absolute origins unless the host itself matters.

Examples of good compact memory across task types:
- UI: “Start at `/search`, use the input labeled `Search`, open the result link text `Fixture News: Beta`, then read the page label `Article token:` and map it to `ARTICLE_TOKEN`.”
- UI: “Use the visible pagination control labeled `Next page`; do not assume a numbered page button is present.”
- UI: “Open the link text `Delta listing`; do not rely on nearby paragraph text alone.”
- UI: “Use the pagination button text `2`, then open the result link text `Fixture News: Delta`.”
- UI: “Fill the textbox labeled `Search`, submit with the button text `Go`, then open the result link text `Fixture News: Beta`.”
- CLI: “The command succeeds only with `--json`; verify by checking the `status` field equals `ok`.”
- API: “The required field is `workspace_id`; a 400 with `missing workspace_id` means the payload shape is wrong.”
- Filesystem: “The generated config lives under `config/runtime.json`, and success means the `provider` key is present.”

For UI/browser tasks, prefer selector-grade memory over runtime plumbing. Good examples:
- the visible label on a search field
- the button text used to submit
- the relative route that contains the next page
- the label near the final value you need to read
- the exact landmark or page section that makes the target result obvious

Avoid storing debugger endpoints, launch flags, or exact shell/browser commands unless they are the durable fact the next run truly needs.

If a pinned workflow skill already gives a canonical execution template, learned memory should reference only the task-specific delta on top of that template. Do not spend learned memory budget rediscovering generic wiring.

## Avoid

- long end-to-end scripts
- copied code blocks from a single run
- exact runtime/CLI invocation replay when a higher-level cue is enough
- storing concrete output values when the next run only needs to know how to retrieve them
- repeating generic workflow advice already covered by pinned skills
- moving pinned workflow behavior into learned memory instead of storing only the task- or project-specific delta
- vague routing like `Apply when: any vaguely similar task`
- placeholder guidance like `Verify vaguely` or `Stop eventually`

## Recommended learned block shape

- 3 to 6 bullets total
- one `Apply when` section
- one `Look first` or `Landmarks` section
- one `Pitfalls` section only if it adds value
- one short `Verify` section

If you know a direct entry path plus one actionable cue, write it clearly enough that the next run can start there instead of rediscovering the same state.

## Token thresholds

Treat something as “expensive” when:
- it exceeds model-aware token thresholds, or
- it needed retries, many tool calls, or non-obvious project-specific knowledge

Token fields when available:
- `input_tokens`
- `cached_input_tokens`
- `output_tokens`

Use `total_tokens = input_tokens + cached_input_tokens + output_tokens`.

| model (or family) | total_tokens ≥ |
| --- | --- |
| default | 4000 |
| reasoning-heavy | 8000 |
| small/cheap | 2500 |

## `/learn` workflow

- Use the Instafy controller API via `instafy api get` if you need message metadata, runs, or token usage.
- `/learn:collect <N>` is a metadata scan only.
- `/learn` should update `INSTAFY.md` when needed and prefer writing new learnings as compact skill blocks under `.agents/skills/instafy-learned/blocks/`.

## Pruning and downward pressure

- Core pinned skills should remain stable.
- Learned blocks may be merged, compressed, archived, or pruned to keep routing efficient.
- If a new learning makes later attempts slower, more tool-heavy, or more brittle, shorten it or remove it.
