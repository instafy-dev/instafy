import { test } from "@playwright/test";
import {
  clearRuntimePreference,
  prepareStudio,
  resetRuntimeUserState,
  selectPrimaryAgentModel,
  writeWorkspaceFile,
} from "../utils/harness.js";
import { openNewConversation } from "./benchLearnUtils.js";
import { writeLearnBenchDiagnostics } from "./benchDiagnostics.js";
import { collectLearnRoutingSnapshot } from "./benchRoutingDebug.js";
import {
  FIXTURE_BENCH_MODEL,
  assertDeterministicBenchCompleted,
  ensureHostedRuntimeReadyForBench,
  hideBrowserSessionIfVisible,
  seedLearnedBlocksIntoWorkspace,
  seedRepoPinnedSkillsIntoWorkspace,
  writeBenchProgressMarker,
} from "./fixtureBenchShared.js";
import { startBenchFixtureSite, type BenchFixtureSite } from "./fixtureSiteHarness.js";
import { runFixtureNewsTokenAttempt, type FixtureNewsTokenAttemptResult } from "./benchTasks.js";
import { updateLearnBenchSummary } from "./learnBenchSummary.js";

test.describe("Bench: seeded learned blocks compose on catalog flow (opt-in)", () => {
  test.skip((process.env.PLAYWRIGHT_RUN_BENCH ?? "").trim() !== "1", "Set PLAYWRIGHT_RUN_BENCH=1 to enable benchmarks.");
  test.skip(
    (process.env.PLAYWRIGHT_SKIP_CODEX ?? "").trim() === "1",
    "Codex backend unavailable (rate limited). Provide Codex auth (OPENAI_API_KEY or tmp/proxy-codex/auth.json).",
  );
  test.skip(
    (process.env.INSTAFY_ENABLE_BROWSER_SESSION ?? "").trim() !== "1",
    "Browser session disabled (set INSTAFY_ENABLE_BROWSER_SESSION=1 and use runtime-webdev image target).",
  );

  test.describe.configure({ timeout: 60 * 60_000, retries: 0 });
  let fixtureSite: BenchFixtureSite;

  test.beforeAll(async () => {
    fixtureSite = await startBenchFixtureSite("fixture-news-catalog-composition-routing");
  });

  test.afterAll(async () => {
    await fixtureSite?.stop?.();
  });

  test.afterEach(async ({ page }) => {
    await resetRuntimeUserState(page, { source: "bench:fixture-news-catalog-composition-routing:cleanup" }).catch(() => {});
  });

  test("pre combined -> seed learned blocks -> post combined", async ({ page }) => {
    page.setDefaultTimeout(60_000);

    const budgetSec = Number(process.env.PLAYWRIGHT_BENCH_FIXTURE_NEWS_BUDGET_SECS ?? "210");
    const fixtureBaseUrl = fixtureSite.baseUrl.replace(/\/+$/, "");
    const expectedOrigin = new URL(fixtureBaseUrl).origin;
    const expectedPathname = "/article/delta";
    const expectedToken = "DELTA-TOKEN-5c203a";

    const projectId = await prepareStudio(page);
    if (!projectId) throw new Error("Project id missing for fixture-news-catalog-composition-routing bench.");

    await page.getByTestId("sidebar-nav-chat").click();
    await clearRuntimePreference(page, { projectId, source: "bench:fixture-news-catalog-composition-routing" }).catch(() => {});
    await ensureHostedRuntimeReadyForBench(page, projectId);
    await selectPrimaryAgentModel(page, FIXTURE_BENCH_MODEL);
    await seedRepoPinnedSkillsIntoWorkspace(page, projectId);

    const benchDir = "bench/fixture-news-catalog-composition-routing";
    await writeWorkspaceFile(page, `${benchDir}/README.md`, "# Fixture news catalog composition routing benchmark\n", {
      createDirectories: true,
      projectId,
    }).catch(() => {});
    await writeBenchProgressMarker(page, { projectId, benchDir, step: "initialized" });

    const combinedPrompt = (label: string) =>
      [
        `Benchmark task (${label}):`,
        "",
        "Open a live browser session (visible inline).",
        `Navigate to ${fixtureBaseUrl}/catalog`,
        'If a cookie dialog appears, click "I agree".',
        "Use the catalog pagination to reach page 2.",
        "Open the Delta listing (it is only visible on page 2).",
        "Wait for the article page to load, then read the article heading, current URL, and article token from the browser.",
        "",
        "Do not use curl/fetch; use only the browser session.",
        "",
        "In your final reply, include lines exactly like:",
        "ARTICLE_TITLE: <title>",
        "ARTICLE_URL: <url>",
        "ARTICLE_TOKEN: <token>",
      ].join("\n");

    const attempts: FixtureNewsTokenAttemptResult[] = [];

    await writeBenchProgressMarker(page, { projectId, benchDir, step: "pre-attempt-start", details: { attempt: 1 } });
    const preAttempt = await runFixtureNewsTokenAttempt(page, 1, combinedPrompt("pre combined"), budgetSec, {
      expectedOrigin,
      expectedPathname,
      expectedToken,
    });
    const preSnapshot = await collectLearnRoutingSnapshot(page, projectId).catch(() => null);
    const preEnriched = { ...preAttempt, phase: "pre", routingSnapshot: preSnapshot };
    attempts.push(preEnriched as FixtureNewsTokenAttemptResult);
    await writeWorkspaceFile(page, `${benchDir}/attempt-pre-1.json`, JSON.stringify(preEnriched, null, 2), {
      createDirectories: true,
      projectId,
    }).catch(() => {});
    await writeBenchProgressMarker(page, {
      projectId,
      benchDir,
      step: "pre-attempt-complete",
      details: { attempt: 1, success: preEnriched.success, failureKind: preEnriched.failureKind },
    });
    await hideBrowserSessionIfVisible(page);

    await writeBenchProgressMarker(page, { projectId, benchDir, step: "seed-learned-blocks-start" });
    await seedLearnedBlocksIntoWorkspace(page, projectId, [
      {
        name: "catalog-pagination-page-2-delta",
        description: "Reach catalog page 2 where the Delta listing becomes visible.",
        content: `---
name: catalog-pagination-page-2-delta
description: Reach catalog page 2 where the Delta listing becomes visible.
---

# Catalog pagination to page 2 for Delta

Apply when a browser task starts at the catalog listing and the Delta entry is only visible on page 2.

Procedure:
- Start from the relative route \`/catalog\`.
- If a consent button labeled \`I agree\` is visible, click it once.
- Use the visible pagination control labeled \`Next page\`; if it is absent, use the exact page control text \`2\`.
- Stop once page 2 is loaded and the Delta listing is visible.

Verify:
- The URL includes \`?page=2\` or the page title is \`Catalog page 2\`.
- A visible listing link or page text contains \`Fixture News: Delta\`.`,
      },
      {
        name: "catalog-delta-article-entry",
        description: "Open the exact Delta article from catalog page 2 and read the article token label.",
        content: `---
name: catalog-delta-article-entry
description: Open the exact Delta article from catalog page 2 and read the article token label.
---

# Delta article entry from catalog page 2

Apply when the browser is already on \`/catalog?page=2\` and the task needs the Delta article fields.

Procedure:
- Open the exact result link text \`Fixture News: Delta\`.
- If text matching is ambiguous, prefer the exact selector \`a[href$="/article/delta"]\`.
- On the article page, read the article heading, current URL, and the token label \`Article token:\`.

Verify:
- The final URL path is \`/article/delta\`.
- The page includes \`Article token:\` with value \`DELTA-TOKEN-5c203a\`.`,
      },
    ]);
    await writeBenchProgressMarker(page, { projectId, benchDir, step: "seed-learned-blocks-complete" });

    await openNewConversation(page);
    await writeBenchProgressMarker(page, { projectId, benchDir, step: "post-conversation-ready" });
    const postAttempt = await runFixtureNewsTokenAttempt(page, 2, combinedPrompt("post combined"), budgetSec, {
      expectedOrigin,
      expectedPathname,
      expectedToken,
    });
    const postSnapshot = await collectLearnRoutingSnapshot(page, projectId).catch(() => null);
    const postEnriched = { ...postAttempt, phase: "post", routingSnapshot: postSnapshot };
    attempts.push(postEnriched as FixtureNewsTokenAttemptResult);
    await writeWorkspaceFile(page, `${benchDir}/attempt-post-1.json`, JSON.stringify(postEnriched, null, 2), {
      createDirectories: true,
      projectId,
    }).catch(() => {});
    await writeBenchProgressMarker(page, {
      projectId,
      benchDir,
      step: "post-attempt-complete",
      details: { attempt: 1, success: postEnriched.success, failureKind: postEnriched.failureKind },
    });
    await hideBrowserSessionIfVisible(page);

    await updateLearnBenchSummary(page, {
      projectId,
      benchKey: "fixture-news-catalog-composition-routing",
      benchDir,
      requestedModelHint: FIXTURE_BENCH_MODEL,
      attempts: attempts.map((attempt) => ({
        attempt: attempt.attempt,
        phase: (attempt as any).phase,
        wallMs: attempt.wallMs,
        success: attempt.success,
        failureKind: attempt.failureKind,
        assistantTurns: attempt.assistantTurns,
        tokenUsage: attempt.tokenUsage,
        mcpToolCalls: attempt.mcpToolCalls,
        shellCommands: attempt.shellCommands,
        learnedBlockReads: attempt.learnedBlockReads,
        learnedBlockReadCommands: attempt.learnedBlockReadCommands,
        learnRouterBlocks: attempt.learnRouterBlocks,
      })),
    }).catch(() => {});

    const reportLines = [
      "# Fixture news catalog composition routing benchmark",
      "",
      `Fixture: ${fixtureBaseUrl}`,
      `Expected final article: ${expectedOrigin}${expectedPathname}`,
      `Expected token: ${expectedToken}`,
      `Budget per attempt: ${budgetSec}s`,
      `Model: ${FIXTURE_BENCH_MODEL}`,
      `Generated: ${new Date().toISOString()}`,
      "",
      "| Phase | Attempt | Success | Failure | Wall | URL |",
      "| --- | --- | --- | --- | --- | --- |",
      ...attempts.map(
        (attempt) =>
          `| ${(attempt as any).phase ?? "-"} | ${attempt.attempt} | ${attempt.success ? "OK" : "FAIL"} | ${attempt.failureKind ?? "-"} | ${Math.round(
            attempt.wallMs / 1000,
          )}s | ${(attempt.articleUrl ?? "-").replace(/\\|/g, " ")} |`,
      ),
      "",
      "## Seeded learned blocks",
      "",
      "- `catalog-pagination-page-2-delta`",
      "- `catalog-delta-article-entry`",
      "",
    ];

    await writeWorkspaceFile(page, `${benchDir}/report.md`, reportLines.join("\n"), {
      createDirectories: true,
      projectId,
    }).catch(() => {});

    const aiQuality = await writeLearnBenchDiagnostics(page, {
      projectId,
      benchDir,
      benchKey: "fixture-news-catalog-composition-routing",
      attempts: attempts as any,
      modelLabel: FIXTURE_BENCH_MODEL,
    }).catch(() => null);

    assertDeterministicBenchCompleted({
      attempts: attempts as any,
      aiQuality,
      requireAiEvaluation: (process.env.PLAYWRIGHT_BENCH_AI_EVAL ?? "1").trim() !== "0",
      postMaxShellCommands: 2,
      postMustNotExceedPreBy: 1,
    });
  });
});
