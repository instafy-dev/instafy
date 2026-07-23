# /learn Benchmarking And Memory Routing

This document is the entry point for anyone working on Instafy's `/learn` flow, learned-memory router, persistent-context tree, or benchmark suite.

Read this before changing:

- `packages/runtime-agent/src/jobs/learn.rs`
- `packages/runtime-agent/src/jobs/mod.rs`
- `packages/runtime-agent/assets/instafy/learnings/_pinned/learning-policy.md`
- `packages/frontend/tests/playwright/bench/README.md`

## What `/learn` is supposed to do

`/learn` is not a browser-specific feature. It is a generic memory-improvement loop.

The desired behavior is:

1. An agent solves a task.
2. `/learn` extracts the reusable delta from that run.
3. That delta is stored as compact learned memory.
4. A later run should solve the same or related task with:
   - less time,
   - less token usage,
   - less branching / retrying,
   - and without storing replay-style junk.

The memory should help the next run choose better. It should not try to replay the old run step by step.

## What lives where

Keep the responsibilities split cleanly.

### Skills and pinned policy

These should own behavioral guidance:

- how to think about memory quality,
- how to write compact learned blocks,
- how to preserve exact worked cues,
- browser/task workflow guidance.

Important files:

- `packages/runtime-agent/assets/instafy/learnings/_pinned/learning-policy.md`
- `packages/runtime-agent/assets/instafy/.agents/skills/instafy-learning-policy/SKILL.md`
- `packages/runtime-agent/assets/instafy/.agents/skills/instafy-browser-automation/SKILL.md`

### Rust runtime code

This should own invariants and bounded routing, not site-specific know-how.

Important files:

- `packages/runtime-agent/src/jobs/learn.rs`
- `packages/runtime-agent/src/jobs/mod.rs`

Rust should handle:

- memory budgets,
- active index limits,
- archive/prune mechanics,
- learned-block routing caps,
- exact-cue scoring,
- hard guardrails against obviously bad memory shapes.

Rust should not be where we keep detailed browsing heuristics for known sites.

## Current learned-memory router

The learned-memory router is in:

- `packages/runtime-agent/src/jobs/mod.rs`

Current important behavior:

- project memory is loaded with a bounded total budget,
- top-level skills are treated as persistent-context nodes rather than one flat dump,
- routing walks a bounded context tree (root -> workflow -> learned children),
- learned blocks are discovered from `.agents/skills/instafy-learned/blocks/*/SKILL.md`,
- blocks are scored against the prompt,
- exact routing cues get extra weight,
- only the best few blocks are loaded,
- the active learned surface stays small.

Current effective constraints:

- max loaded learned blocks: `2`
- top-score window is bounded by a score-gap cutoff
- learned block file budget is tighter than general project memory

This is intentional. The router is supposed to be useful and predictable, not load everything.

## Current optimizer

The optimizer is in:

- `packages/runtime-agent/src/jobs/learn.rs`

It currently does three important things:

1. Rewrites the learned index so the active routing surface stays small.
2. Archives lower-value blocks instead of keeping them all active.
3. Demotes replay-style memory that looks like copied commands or one-off execution logs.

The optimizer should act like downward pressure, not like a second agent inventing new behavior.

## What good learned memory looks like

Good learned memory should usually contain:

- `Apply when`
- `Look first`
- exact worked cues
- pitfalls
- `Verify` or `Stop when`

Examples of good cues:

- `input name "q"`
- `button text "Go"`
- `link text "Fixture News: Beta"`
- `select name "team" option value "green" text "Green"`

Examples of bad memory:

- copied shell scripts,
- exact command replay,
- vague summaries like `open the matching result`,
- storing example output values instead of retrieval cues.

If a task has two reusable stages, memory should usually be split into two blocks instead of one long combined block.

## Bench suite

The benchmark suite lives in:

- `packages/frontend/tests/playwright/bench`

The main human-facing guide is:

- `packages/frontend/tests/playwright/bench/README.md`

The suite is mostly deterministic local-fixture benchmarks now. That is deliberate. Public websites are useful later, but they are bad for early tuning because they add too much variance.

### Core deterministic benches

- `fixture-news-search-beta`
  - search + submit + exact result + exact field extraction
- `fixture-news-gate-gamma`
  - gate/unlock + exact field extraction
- `fixture-news-catalog-delta`
  - pagination + listing + article entry
- `fixture-news-directory-epsilon`
  - filter form + result row + article entry
- `fixture-news-lookup-transfer`
  - learn on one shape, test transfer on a sibling shape
- `learn-anti-bloat-seeded`
  - prove the optimizer shrinks the active routing surface

### Supporting benches

- loop-series benches for repeated `pre -> /learn -> post`
- composition benches for split-stage memory
- routing-only benches that seed known-good blocks directly

## How to run the benches

Typecheck first:

```bash
pnpm -C packages/frontend exec tsc --noEmit
```

Typical bench run:

```bash
PLAYWRIGHT_RUN_BENCH=1 \
PLAYWRIGHT_BENCH_MODEL=gpt-5.5 \
PLAYWRIGHT_BENCH_AI_EVAL=1 \
pnpm -C packages/frontend test:e2e -- \
tests/playwright/bench/fixture-news-search-beta-learn-bench.spec.ts --max-failures=1
```

If the bench uses the live browser panel:

```bash
INSTAFY_ENABLE_BROWSER_SESSION=1
```

## How to read the results

Each workspace writes:

- `bench/<bench>/attempt-*.json`
- `bench/<bench>/report.md`
- `bench/<bench>/diagnostics.md`
- `bench/<bench>/ai-quality.json`
- `bench/<bench>/ai-quality.md`

Cross-workspace aggregation:

```bash
node packages/frontend/tests/playwright/bench/aggregateLearnBenchResults.mjs
```

Generated outputs:

- `tmp/bench-rollup/learn-bench-rollup.md`
- `tmp/bench-rollup/learn-bench-lineage.md`
- `tmp/bench-rollup/learn-bench-loop-series.md`

Use them like this:

- `rollup`: broad summary across all recorded loops
- `lineage`: chronological history per bench family
- `loop-series`: repeated loops inside one project

If you are actively tuning `/learn`, `lineage` and the recent-window part of the rollup matter more than all-time medians.

## AI evaluation vs hardcoded checks

Semantic learned-block quality is now primarily evaluated by the model, not by string matching alone.

Important files:

- `packages/frontend/tests/playwright/bench/learnedBlockAiEvaluator.ts`
- `packages/instafy-cli/src/chat.ts`

The current approach is:

- keep tiny static guardrails for obvious junk,
- use AI evaluation as the primary semantic quality signal,
- compare that against real benchmark outcomes.

This is intentional. Hardcoded string checks are acceptable as guardrails, but not as the main quality oracle.

## What another agent should do first

If a new agent is trying to improve `/learn`, the order should be:

1. Read this doc.
2. Read `packages/frontend/tests/playwright/bench/README.md`.
3. Read the pinned learning policy.
4. Read the latest rollups under `tmp/bench-rollup/`.
5. Pick one bench family only.
6. Change policy first, not router code, unless there is a real invariant problem.
7. Rerun one reduced bench and compare:
   - wall time,
   - token usage,
   - shell count,
   - AI quality,
   - learned block shape.

Do not tune everything at once.

## Current status

As of the current branch state:

- `/learn` is meaningful and benchmarked.
- The deterministic fixture suite is producing useful signals.
- The router is bounded and behaving credibly.
- The optimizer is doing real downward pressure.
- New projects can pick up current repo-pinned defaults without runtime image rebuilds.

This is good enough for internal / beta use.

It is still worth improving:

- CI thresholds should become stricter,
- more non-browser bench families should be added,
- the docs should stay aligned with the actual benchmark suite.

## Related files

- `AGENTS.md`
- `docs/Testing.md`
- `packages/frontend/tests/playwright/bench/checkLearnBenchThresholds.mjs`
- `packages/frontend/tests/playwright/bench/benchDiagnostics.ts`
- `packages/frontend/tests/playwright/bench/learnBenchSummary.ts`
