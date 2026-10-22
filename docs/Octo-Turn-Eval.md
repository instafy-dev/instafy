# Octo Turn Eval

An AI agent runs this to see what real Octo turns do end to end: the route and skills the routing preflight
picked, what Octo ran, whether the page it built opens and is the kind of page asked for, what it replied, and what
it cost (time, tokens, credits). Each case runs in a fresh space with the real model. A model-free grader turns the
saved evidence into `report.md` and a bench rollup.

It is a measurement, not a correctness test, and it spends real model quota: opt-in, never in PR CI. Run it before
and after changing a skill, the routing preflight or the reply rules, or nightly.

| Piece | Path |
|---|---|
| Cases: one of each kind of ask, no particular skill pack needed | `packages/frontend/tests/playwright/bench/octo-turn-cases.json` |
| Spec and its runner config (no web server, global setup or runtime cleanup reporter) | `packages/frontend/tests/playwright/bench/octo-turn-eval.{spec,config}.ts` |
| Grader (no model) and its tests | `scripts/octo-turn-grade.mjs`, `scripts/octo-turn-grade.test.mjs` |
| Output | `tmp/octo-turn/<runId>/{run.json, cases/<id>/{evidence.json,site.png}, grade.json, report.md}` |
| Rollup across runs (same shape as the `/learn` bench rollup) | `tmp/bench-rollup/octo-turn-rollup.{json,md}` |

## Before you start

- The local stack is up from this checkout: Supabase, the controller on `:8788`, Studio, the runtime image. A probe
  that answers "You've hit your usage limit" means the managed model's account is spent, not that a case failed.
- Page cases need site previews (`instafy preview open` and the "Ready to preview" card), which are off unless the
  controller and tunnel broker are configured for them. Without previews the eval still runs: chat cases grade as
  usual, `card_posted` is n/a ("this server offers no site previews"), and page cases fail `site_opens` because
  there is no page to open.
- Studio defaults to `http://localhost:5173`. If that port is another checkout's, set `PLAYWRIGHT_EXTERNAL_BASE_URL`
  to this checkout's Studio. Never drive a Studio this checkout did not start.
- Use only the eval's own config. The default Playwright config removes every `instafy-runtime-*` container on the
  machine. Never run `stack:down`/`stack:refresh` or kill a controller you did not start. The spec only
  `docker stop`s the containers of the spaces it made.
- Never print tokens or session JSON. Write the minted user to a file created under `umask 077`, outside the repo.

## Steps

1. **Precheck (seconds, no model).** Fix any failure first.

   ```bash
   node --test scripts/octo-turn-grade.test.mjs
   node scripts/octo-turn-grade.mjs --check-cases
   ```

2. **Mint a user** (it picks managed AI; the spec clicks that choice if Studio offers it):
   `(umask 077; node scripts/mint-test-user.mjs --json > "$PRIVATE_DIR/octo-eval-user.json")`.
   Without `PLAYWRIGHT_OCTO_EVAL_USER_FILE` the spec mints one in memory: you can clean it up from `run.json`'s
   `userId`, but not sign in as it.

3. **Run.** Per case: a new space, the prompt sent through the composer, `agent_jobs` polled every 10 s until every
   job of the turn is terminal and quiet for 20 s, then the page found and measured, the credits read, the space's
   skills listed and its runtime stopped.

   ```bash
   cd packages/frontend
   PLAYWRIGHT_RUN_BENCH=1 PLAYWRIGHT_OCTO_EVAL=1 \
   PLAYWRIGHT_OCTO_EVAL_USER_FILE="$PRIVATE_DIR/octo-eval-user.json" \
   PLAYWRIGHT_OCTO_EVAL_TIER=cheap \
   node_modules/.bin/playwright test -c tests/playwright/bench/octo-turn-eval.config.ts
   ```

   | Variable | Meaning |
   |---|---|
   | `PLAYWRIGHT_OCTO_EVAL_TIER` | `cheap` (the chat turns: start here) or `standard` (the pages); comma-separated |
   | `PLAYWRIGHT_OCTO_EVAL_CASES` | Comma-separated case ids |
   | `PLAYWRIGHT_OCTO_EVAL_CASES_FILE` | Another cases file |
   | `PLAYWRIGHT_OCTO_EVAL_RUN_ID` | Output folder name (default: a timestamp) |
   | `PLAYWRIGHT_OCTO_EVAL_STOP_RUNTIMES=0` | Leave the runtimes up for a readback |
   | `OCTO_EVAL_DB_URL` | Database for jobs and credits (default: the local stack) |

   The spec grades when it finishes. To regrade saved evidence: `node scripts/octo-turn-grade.mjs tmp/octo-turn/<runId>`
   (it uses the cases file named in `run.json`; `--cases` overrides). Exit 1 means a case failed a must.

4. **Read the report, then do a readback.** The grader counts and matches; it does not judge quality. For each
   page case open `cases/<id>/site.png` and read the reply as the person who asked would: is it right, sourced,
   clear about what is unverified? Write two or three lines per case. For a closer look, sign in as the eval user
   ("Driving the app as a signed-in user" in `AGENTS.md`).

5. **Clean up.** No container of the run is left (`docker ps --format '{{.Names}}' | grep instafy-runtime-`, only
   the project ids in `run.json`), then `node scripts/mint-test-user.mjs --cleanup <userId>`.

6. **Answer** with: cases passed, the failed musts and shoulds that matter, time, tokens and credits, the readback
   lines, and what to change next.

## How the page is found

The way a person finds it:

1. The newest "Ready to preview" card in the conversation (`preview-ready-card`). The spec presses Open and measures
   the page in the side pane's frame (`site-preview-frame`).
2. No card, or one that will not open: the space's previews as the controller lists them
   (`GET /projects/:id/previews`). The newest active one is opened in a tab of its own, the way "Open in new tab"
   does (`POST …/view?tab=true`). The page is measured, and `card_posted` still fails.
3. Neither: no page. `site_opens` fails and says how many HTML files the turn wrote without showing them.

The evidence records which way the page was found (`pageSource`), whether the server offers previews
(`previewsAvailable`), how many previews it lists, the card's state, and the skills installed in the space
(`spaceSkills`, from the runtime's `.agents/skills`).

## Cases

Each case has an `id`, `tier`, `kind`, `prompt`, `budget` (`seconds`, `cardSeconds`, `inputTokens`,
`outputTokens`: ceilings from measured turns, not targets) and `expect`. The grader refuses a key it does not know.

- `route` (`direct`, `multi_agent_candidate`, `cross_chat_lookup` or `write_coordination_required`) and
  `siteRequired` (true for a page, false for a chat answer).
- What the page is: `map`, and `siteShape` with minimum counts of `tableRows`, `listItems`, `orderedItems`,
  `rankedItems` (lines numbered 1, 2, 3, … in order, in any layout), `checkboxes`, `datedItems` (lines with a date,
  week or countdown) or `items` (the largest of these).
- What the answer is: `minSources` (public https links on the page or in the reply), `replyAssumed` (one
  `Assumed:` line for a vague ask), `replyNotQuestionOnly` (default on for pages), `replyAnswers` (at least one
  plain statement), `language` (`en`, `es`, `pt`, `fr`, `de`, `it`, `nl`, `sv`), `mentionsUnverified`,
  `replyMaxLines` and `replyMaxChars` (page replies; default 6 and 1000), `allowFilePaths`.
- How it was done: `liveResearch`, `noBrowserHandoff`, `workersMin`; `allowFileChanges` lets a chat case write files.
- Skills, for a cases file about a skill: `skills` (all seen), `skillsAnyOf`, `forbiddenSkills`. Seen means selected
  by the preflight or used by running something from the skill's folder. These checks are n/a in a space that does
  not have the skill. The shipped cases name none.

The shipped cases: a map, a comparison table, a ranked list, a timeline, a checklist, a Spanish page, a plain answer,
and three asks that must stay in chat. Add a case when a real prompt surprised you. Keep the asks that must stay in
chat: they catch skills that grab too much.

## Where the time went

Each case's section of the report has a `Time:` line: the slowest lane, how many jobs the turn limit stopped, and
how many continuation turns ran. Under it, per job: how long it waited and ran, its commands' share, when the
wrap-up came, its slowest commands, and the steps its tools reported. The numbers come from the jobs' times and
their `agent/turn-timings` artifact. A turn that ran out of time and was continued by a later turn of the same
agent does not fail `job_succeeded`.

## What the grader checks

From the `agent_jobs` rows (preflight, prompt context, task usage, run log, applied paths, `summary` as the
reply), the credit ledger, and what the browser counted on the page. A check is pass, fail or n/a; a case passes
when no must fails. Its score is the share of graded checks that passed.

| Check | Severity | Rule |
|---|---|---|
| `job_succeeded` | must | Every job terminal, root `completed/succeeded`, none failed, no timeout (a run the controller continued in a new turn or retried after a short rate limit counts by the run that replaced it) |
| `route` | must | As expected; a team also passes on worker jobs, `direct` fails when workers ran |
| `skill:*`, `skill_any_of`, `not_skill:*` | must | Against the skills seen; n/a when the space does not have the skill |
| `card_posted` | must | A "Ready to preview" card; n/a on a server without site previews |
| `site_opens` | must | A page was found (card or previews) and opened with text and no HTTP error |
| `site_shape:*` | must | The page has at least the case's counts (a table, a ranking, checkboxes, dated steps) |
| `map_ready` | must | A MapLibre, Mapbox, Leaflet, OpenLayers or Google map rendered with a size |
| `no_site`, `no_file_changes` | must | Chat cases: no card, no preview listed, no `instafy preview open`; no file changed |
| `reply_present`, `reply_no_internal_urls`, `reply_no_file_paths` | must | A reply, without localhost, preview or tunnel hosts, and without file or folder paths (links excluded) |
| `reply_not_question_only` | must | Pages, and cases that ask for it: no more than half the sentences are questions, so "Built X. Want Y?" passes (a trailing `suggestions` chips block is not counted) |
| `reply_answers` | must | At least one sentence that is not a question and has six or more words (a CJK character counts as a word). Length does not matter: "Keep it short" is honoured |
| `reply_assumed`, `reply_language` | must | An `Assumed:` line; the reply reads in the case's language (n/a when too short to tell) |
| `no_browser_handoff` | must | Lookups: no `request_browser` consent card |
| `time_within_budget`, `input_tokens_within_budget`, `output_tokens_within_budget` | must | Within the case budget |
| `sources` | should | Enough public links to follow, on the page or in the reply |
| `credits_match_tokens` | should | The credits charged match the tokens at the rates the controller wrote on the ledger, ±max(jobs+1, 15%). Without rates: `credits_charged`, a turn over 500k input tokens charged more than 1 credit |
| `site_language`, `site_no_file_paths`, `site_console_clean` | should | The page reads in the case's language, shows no paths, logs no errors from its own origin |
| `reply_short`, `reply_no_dev_details`, `reply_flags_unverified` | should | Page replies: at most 6 lines and 1000 chars, no file paths or "validates"; says what is unverified |
| `prompt_carries_skills`, `card_within_budget` | should | Skills reached the prompt; the card came in time |
| `workers_spawned`, `live_research` | should | A team spawned its workers; a lookup ran a command that fetches (n/a if the run log was cut) |

The report shows credits charged next to the credits the tokens should have cost.

## Known limits

- No AI grading: whether the content is right or good needs the readback in step 4.
- Shapes are counted from the page as rendered: a ranking drawn on a canvas, or checkboxes made of plain text,
  count as nothing. `items` counts list items anywhere outside `nav`, not only in the main content.
- `map_ready` passes on any map container with a size; it does not check that tiles loaded.
- Language is read from function words in eight languages (no one-letter words). `Assumed:` and the unverified
  wording are matched in English.
- The space's skills are listed from its runtime container; when that fails they are unknown and skill checks are
  graded as the case says.
- The model is read from the job payload's managed-AI label when present. Long run logs are compacted, and checks
  that depend on a command are then n/a. Card timing is sampled every 10 s.
