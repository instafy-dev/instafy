import { test } from "@playwright/test";
import {
  clearRuntimePreference,
  prepareStudio,
  resetRuntimeUserState,
  selectPrimaryAgentModel,
  writeWorkspaceFile,
} from "../utils/harness.js";
import { attemptApplyLearn, openNewConversation, summarizeBenchSignal } from "./benchLearnUtils.js";
import { writeLearnBenchDiagnostics } from "./benchDiagnostics.js";
import { collectLearnRoutingSnapshot } from "./benchRoutingDebug.js";
import {
  FIXTURE_BENCH_MODEL,
  assertDeterministicBenchCompleted,
  ensureHostedRuntimeReadyForBench,
  hideBrowserSessionIfVisible,
  seedRepoPinnedSkillsIntoWorkspace,
  writeBenchProgressMarker,
} from "./fixtureBenchShared.js";
import { startBenchFixtureSite, type BenchFixtureSite } from "./fixtureSiteHarness.js";
import {
  runCatalogPaginationAttempt,
  runFixtureNewsTokenAttempt,
  type CatalogPaginationAttemptResult,
  type FixtureNewsTokenAttemptResult,
} from "./benchTasks.js";
import { updateLearnBenchSummary } from "./learnBenchSummary.js";

test.describe("Bench: /learn composes split browser memory blocks (opt-in)", () => {
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
    fixtureSite = await startBenchFixtureSite("fixture-news-catalog-composition");
  });

  test.afterAll(async () => {
    await fixtureSite?.stop?.();
  });

  test.afterEach(async ({ page }) => {
    await resetRuntimeUserState(page, { source: "bench:fixture-news-catalog-composition:cleanup" }).catch(() => {});
  });

  test("pre combined -> learn pagination -> learn article -> post combined", async ({ page }) => {
    page.setDefaultTimeout(60_000);

    const learnCommand = (process.env.PLAYWRIGHT_BENCH_LEARN_COMMAND ?? "/learn 6").trim() || "/learn 6";
    const budgetSec = Number(process.env.PLAYWRIGHT_BENCH_FIXTURE_NEWS_BUDGET_SECS ?? "210");
    const fixtureBaseUrl = fixtureSite.baseUrl.replace(/\/+$/, "");
    const expectedOrigin = new URL(fixtureBaseUrl).origin;
    const expectedPathname = "/article/delta";
    const expectedToken = "DELTA-TOKEN-5c203a";

    const projectId = await prepareStudio(page);
    if (!projectId) throw new Error("Project id missing for fixture-news-catalog-composition bench.");

    await page.getByTestId("sidebar-nav-chat").click();
    await clearRuntimePreference(page, { projectId, source: "bench:fixture-news-catalog-composition" }).catch(() => {});
    await ensureHostedRuntimeReadyForBench(page, projectId);
    await selectPrimaryAgentModel(page, FIXTURE_BENCH_MODEL);
    await seedRepoPinnedSkillsIntoWorkspace(page, projectId);

    const benchDir = "bench/fixture-news-catalog-composition";
    await writeWorkspaceFile(page, `${benchDir}/README.md`, "# Fixture news catalog composition /learn benchmark\n", {
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

    const paginationPrompt =
      [
        "Training task (pagination stage):",
        "",
        "Open a live browser session (visible inline).",
        `Navigate to ${fixtureBaseUrl}/catalog`,
        'If a cookie dialog appears, click "I agree".',
        "Use the catalog pagination to reach page 2.",
        "Stop on page 2 once the Delta listing is visible; do not open the Delta article.",
        "",
        "Do not use curl/fetch; use only the browser session.",
        "",
        "In your final reply, include lines exactly like:",
        "PAGE_TITLE: <title>",
        "PAGE_URL: <url>",
        "DELTA_LISTING_VISIBLE: <yes|no>",
      ].join("\n");

    const articlePrompt =
      [
        "Training task (article-entry stage):",
        "",
        "Open a live browser session (visible inline).",
        `Navigate directly to ${fixtureBaseUrl}/catalog?page=2`,
        'If a cookie dialog appears, click "I agree".',
        "Open the exact Delta article entry from the current page.",
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
    const trainingNotes: string[] = [];
    const learnOutcomes: Array<{ label: string; wallMs: number | null; signal: string | null; error: string | null }> = [];

    await writeBenchProgressMarker(page, { projectId, benchDir, step: "pre-combined-start" });
    const preCombined = await runFixtureNewsTokenAttempt(page, 1, combinedPrompt("pre combined"), budgetSec, {
      expectedOrigin,
      expectedPathname,
      expectedToken,
    });
    const preRoutingSnapshot = await collectLearnRoutingSnapshot(page, projectId).catch(() => null);
    const preEnriched = { ...preCombined, phase: "pre", routingSnapshot: preRoutingSnapshot };
    attempts.push(preEnriched as FixtureNewsTokenAttemptResult);
    await writeWorkspaceFile(page, `${benchDir}/attempt-pre-1.json`, JSON.stringify(preEnriched, null, 2), {
      createDirectories: true,
      projectId,
    }).catch(() => {});
    await hideBrowserSessionIfVisible(page);

    await openNewConversation(page);
    await writeBenchProgressMarker(page, { projectId, benchDir, step: "train-pagination-start" });
    const paginationResult = await runCatalogPaginationAttempt(page, 2, paginationPrompt, budgetSec, {
      expectedOrigin,
      expectedPathname: "/catalog",
      expectedQuery: "?page=2",
    });
    trainingNotes.push(`pagination: ${paginationResult.success ? "OK" : paginationResult.failureKind ?? "FAIL"} in ${Math.round(paginationResult.wallMs / 1000)}s`);
    await writeWorkspaceFile(page, `${benchDir}/training-pagination.json`, JSON.stringify(paginationResult, null, 2), {
      createDirectories: true,
      projectId,
    }).catch(() => {});
    await hideBrowserSessionIfVisible(page);

    const paginationLearn = await attemptApplyLearn(page, learnCommand, { projectId, requireWorkspaceMutation: true }).catch(() => ({
      signal: null,
      error: "learn command failed",
      wallMs: null,
      assistantSummary: null,
      workspaceMutatedObserved: false,
    }));
    learnOutcomes.push({ label: "pagination", wallMs: paginationLearn.wallMs, signal: paginationLearn.signal, error: paginationLearn.error });
    await writeBenchProgressMarker(page, {
      projectId,
      benchDir,
      step: "train-pagination-learn-complete",
      details: {
        signal: paginationLearn.signal,
        error: paginationLearn.error,
        workspaceMutatedObserved: paginationLearn.workspaceMutatedObserved,
      },
    });

    await writeBenchProgressMarker(page, { projectId, benchDir, step: "conversation-after-pagination-learn-start" });
    await openNewConversation(page);
    await writeBenchProgressMarker(page, { projectId, benchDir, step: "conversation-after-pagination-learn-complete" });
    await writeBenchProgressMarker(page, { projectId, benchDir, step: "train-article-start" });
    const articleTraining = await runFixtureNewsTokenAttempt(page, 3, articlePrompt, budgetSec, {
      expectedOrigin,
      expectedPathname,
      expectedToken,
    });
    trainingNotes.push(`article: ${articleTraining.success ? "OK" : articleTraining.failureKind ?? "FAIL"} in ${Math.round(articleTraining.wallMs / 1000)}s`);
    await writeWorkspaceFile(page, `${benchDir}/training-article.json`, JSON.stringify(articleTraining, null, 2), {
      createDirectories: true,
      projectId,
    }).catch(() => {});
    await hideBrowserSessionIfVisible(page);

    const articleLearn = await attemptApplyLearn(page, learnCommand, { projectId, requireWorkspaceMutation: true }).catch(() => ({
      signal: null,
      error: "learn command failed",
      wallMs: null,
      assistantSummary: null,
      workspaceMutatedObserved: false,
    }));
    learnOutcomes.push({ label: "article", wallMs: articleLearn.wallMs, signal: articleLearn.signal, error: articleLearn.error });
    await writeBenchProgressMarker(page, {
      projectId,
      benchDir,
      step: "train-article-learn-complete",
      details: {
        signal: articleLearn.signal,
        error: articleLearn.error,
        workspaceMutatedObserved: articleLearn.workspaceMutatedObserved,
      },
    });

    await writeBenchProgressMarker(page, { projectId, benchDir, step: "conversation-before-post-start" });
    await openNewConversation(page);
    await writeBenchProgressMarker(page, { projectId, benchDir, step: "conversation-before-post-complete" });
    await writeBenchProgressMarker(page, { projectId, benchDir, step: "post-combined-start" });
    const postCombined = await runFixtureNewsTokenAttempt(page, 4, combinedPrompt("post combined"), budgetSec, {
      expectedOrigin,
      expectedPathname,
      expectedToken,
    });
    const postRoutingSnapshot = await collectLearnRoutingSnapshot(page, projectId).catch(() => null);
    const postEnriched = { ...postCombined, phase: "post", routingSnapshot: postRoutingSnapshot };
    attempts.push(postEnriched as FixtureNewsTokenAttemptResult);
    await writeWorkspaceFile(page, `${benchDir}/attempt-post-1.json`, JSON.stringify(postEnriched, null, 2), {
      createDirectories: true,
      projectId,
    }).catch(() => {});
    await hideBrowserSessionIfVisible(page);
    await writeBenchProgressMarker(page, { projectId, benchDir, step: "post-complete" });

    await updateLearnBenchSummary(page, {
      projectId,
      benchKey: "fixture-news-catalog-composition",
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
      "# Fixture news catalog composition /learn benchmark",
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
      "## Training steps",
      "",
      ...trainingNotes.map((line) => `- ${line}`),
      "",
      "## /learn outcomes",
      "",
      ...learnOutcomes.map(
        (outcome) =>
          `- ${outcome.label}: wall=${outcome.wallMs ? `${Math.round(outcome.wallMs / 1000)}s` : "-"}, signal=${summarizeBenchSignal(
            outcome.signal ?? "-",
          )}, error=${(outcome.error ?? "-").replace(/\\|/g, " ")}`,
      ),
      "",
    ];

    await writeWorkspaceFile(page, `${benchDir}/report.md`, reportLines.join("\n"), {
      createDirectories: true,
      projectId,
    }).catch(() => {});
    const aiQuality =
      (await writeLearnBenchDiagnostics(page, { projectId, benchDir, attempts: attempts as any }).catch(() => null)) ??
      null;

    assertDeterministicBenchCompleted({ attempts, aiQuality });
  });
});
