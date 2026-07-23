# /learn Benchmarks (Opt-In)

If you need the human-readable overview of how `/learn`, the optimizer, routing, and the benchmark suite fit together, start here first:

- `docs/Learn-Benchmarking.md` (repo root)

This file is intentionally operational. It explains how to run the benchmark suite and where the artifacts land.
It does **not** try to restate the routing or optimizer design.

These Playwright specs are benchmarks, not correctness tests:

- skipped by default
- can burn provider quota
- write results into the created project workspace under `bench/`

Exception:

- `github-import-chat-bench.spec.ts`
  - is intentionally hermetic
  - deletes the created project/workspace/canonical repo after the run
  - writes its JSON artifact to the Playwright output directory instead of the workspace

## Run

Enable benchmarks:

```bash
PLAYWRIGHT_RUN_BENCH=1 pnpm -C packages/frontend test:e2e -- tests/playwright/bench/browser-title-learn-bench.spec.ts --max-failures=1
```

Benchmarks that require the live browser panel also require:

```bash
INSTAFY_ENABLE_BROWSER_SESSION=1
```

To pin the model used by the primary agent during the bench:

```bash
PLAYWRIGHT_BENCH_MODEL=gpt-5.5
```

If unset, the benches fall back to `PLAYWRIGHT_LEARN_MODEL`, then `PLAYWRIGHT_RETRO_MODEL`, then `gpt-5.5`.

Enable AI evaluation of learned blocks in bench diagnostics/rollups:

```bash
PLAYWRIGHT_BENCH_AI_EVAL=1
```

Cap how long the bench waits for `/learn` before recording a learn timeout and continuing:

```bash
PLAYWRIGHT_BENCH_LEARN_TIMEOUT_MS=90000
```

Useful local deterministic benches:

- `github-import-chat-bench.spec.ts`
  - Chat-first GitHub onboarding/import benchmark.
  - Defaults to `astral-sh/uv`.
  - Records standardized timings:
    - `prompt_to_import_complete_ms`
    - `prompt_to_first_file_visible_ms`
    - `prompt_to_canonical_durable_ms`
- `fixture-news-search-beta-learn-bench.spec.ts`
  - Search flow + exact field extraction.
- `fixture-news-gate-gamma-learn-bench.spec.ts`
  - Gate/unlock flow + exact field extraction.
- `fixture-news-catalog-delta-learn-bench.spec.ts`
  - Pagination flow; target exists only on a later page.
- `fixture-news-catalog-article-learn-bench.spec.ts`
  - Start from catalog page 2 and open the exact Delta article entry.
- `fixture-news-catalog-composition-learn-bench.spec.ts`
  - Learn pagination and article-entry separately, then test whether the combined Delta flow improves.
- `fixture-news-catalog-composition-routing-bench.spec.ts`
  - Seed two known-good learned blocks directly, then test whether the router composes them on the combined Delta flow.
- `fixture-news-directory-epsilon-learn-bench.spec.ts`
  - Filtered table flow; target appears only after applying the right filter.
- `fixture-news-lookup-transfer-learn-bench.spec.ts`
  - Learn on the search flow, then test transfer on a sibling lookup variant.
- `fixture-news-search-beta-loop-series-bench.spec.ts`
  - Repeats `pre -> /learn -> post` in one project so you can inspect loop-by-loop drift or improvement.
- `learn-anti-bloat-seeded-bench.spec.ts`
  - Seed oversized learned memory, run `/learn`, assert the optimizer compresses the routing surface.

## Fixture Site (Local)

Some benchmarks use a deterministic local fixture site (cookie consent + stable article pages) to avoid relying on external websites.

- The fixture server is started automatically during `PLAYWRIGHT_RUN_BENCH=1` global setup.
- Override the port with `PLAYWRIGHT_BENCH_FIXTURE_SITE_PORT` (default is ephemeral/auto when unset).
- Bench prompts will use `PLAYWRIGHT_BENCH_FIXTURE_SITE_URL` (container-reachable `host.docker.internal` URL).
- Current local fixture surfaces:
  - `/search`
  - `/lookup`
  - `/catalog`
  - `/directory`
  - `/gate`

## Outputs

Each bench writes:

- `bench/<bench-name>/attempt-*.json` (per attempt)
- `bench/<bench-name>/report.md` (human summary)
- `bench/<bench-name>/diagnostics.md` (phase stats, router snapshots, static guardrails, AI evaluation)
- `bench/<bench-name>/ai-quality.json` (model-evaluated learned-block quality)
- `bench/<bench-name>/ai-quality.md` (human-readable AI evaluation summary)

The repeated-loop search bench also writes:

- `bench/fixture-news-search-beta-loops/loop-*.json`
- `bench/fixture-news-search-beta-loops/report.md`

Additionally, benches append/update a cross-bench table:

- `bench/learn-summary.md`
- `bench/learn-summary.json`

The GitHub onboarding bench is separate:

- Playwright output artifact:
  - `test-results/.../github-import-chat-bench.json`
- It does not write under `bench/`
- It does not contribute to the `/learn` rollups

## Aggregation

Aggregate all historical workspace summaries into one rollup:

```bash
node packages/frontend/tests/playwright/bench/aggregateLearnBenchResults.mjs
```

Outputs:

- `tmp/bench-rollup/learn-bench-rollup.json`
- `tmp/bench-rollup/learn-bench-rollup.md`
- `tmp/bench-rollup/learn-bench-lineage.json`
- `tmp/bench-rollup/learn-bench-lineage.md`
- `tmp/bench-rollup/learn-bench-loop-series.json`
- `tmp/bench-rollup/learn-bench-loop-series.md`

Gate the core deterministic benches on the most recent loop for the primary model:

```bash
PLAYWRIGHT_BENCH_THRESHOLD_MODEL=gpt-5.5 \
node packages/frontend/tests/playwright/bench/checkLearnBenchThresholds.mjs
```

Defaults:

- benches: `fixture-news-search-beta,fixture-news-catalog-delta,fixture-news-directory-epsilon`
- required model: `gpt-5.5`
- AI evaluation must be present and must not include `no_assessment` / `evaluation_failed`

Override the bench list if needed:

```bash
PLAYWRIGHT_BENCH_THRESHOLD_BENCHES=fixture-news-search-beta,fixture-news-lookup-transfer \
node packages/frontend/tests/playwright/bench/checkLearnBenchThresholds.mjs
```

Override the recent-window size with:

```bash
PLAYWRIGHT_BENCH_RECENT_WINDOW=3 node packages/frontend/tests/playwright/bench/aggregateLearnBenchResults.mjs
```

For interpretation:

- `rollup` = broad summary
- `lineage` = chronological history by bench family
- `loop-series` = repeated loops inside one project

For how to interpret recent-window vs all-time medians, AI quality, and routing behavior, use:

- `docs/Learn-Benchmarking.md` (repo root)
