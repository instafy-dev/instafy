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
  abortBenchIfNoSuccessfulPreAttempt,
  FIXTURE_BENCH_MODEL,
  assertDeterministicBenchCompleted,
  ensureHostedRuntimeReadyForBench,
  hideBrowserSessionIfVisible,
  recycleHostedRuntimeForBench,
  seedRepoPinnedSkillsIntoWorkspace,
  writeBenchProgressMarker,
} from "./fixtureBenchShared.js";
import { startBenchFixtureSite, type BenchFixtureSite } from "./fixtureSiteHarness.js";
import { runFixtureNewsTokenAttempt, type FixtureNewsTokenAttemptResult } from "./benchTasks.js";
import { updateLearnBenchSummary } from "./learnBenchSummary.js";

test.describe("Bench: /learn improves deterministic article-entry navigation (opt-in)", () => {
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
    fixtureSite = await startBenchFixtureSite("fixture-news-catalog-article");
  });

  test.afterAll(async () => {
    await fixtureSite?.stop?.();
  });

  test.afterEach(async ({ page }) => {
    await resetRuntimeUserState(page, { source: "bench:fixture-news-catalog-article:cleanup" }).catch(() => {});
  });

  test("before/after /learn (fixture catalog page 2 -> delta article)", async ({ page }) => {
    page.setDefaultTimeout(60_000);

    const learnCommand = (process.env.PLAYWRIGHT_BENCH_LEARN_COMMAND ?? "/learn 6").trim() || "/learn 6";
    const budgetSec = Number(process.env.PLAYWRIGHT_BENCH_FIXTURE_NEWS_BUDGET_SECS ?? "210");
    const preAttemptsRaw = Number(process.env.PLAYWRIGHT_BENCH_PRE_ATTEMPTS ?? "1");
    const postAttemptsRaw = Number(process.env.PLAYWRIGHT_BENCH_POST_ATTEMPTS ?? "1");
    const preAttempts = Math.max(1, Math.min(10, Number.isFinite(preAttemptsRaw) ? preAttemptsRaw : 1));
    const postAttempts = Math.max(1, Math.min(10, Number.isFinite(postAttemptsRaw) ? postAttemptsRaw : 1));
    const totalAttempts = preAttempts + postAttempts;
    const fixtureBaseUrl = fixtureSite.baseUrl.replace(/\/+$/, "");
    const expectedOrigin = new URL(fixtureBaseUrl).origin;
    const expectedPathname = "/article/delta";
    const expectedToken = "DELTA-TOKEN-5c203a";

    const projectId = await prepareStudio(page);
    if (!projectId) throw new Error("Project id missing for fixture-news-catalog-article bench.");

    await page.getByTestId("sidebar-nav-chat").click();
    await clearRuntimePreference(page, { projectId, source: "bench:fixture-news-catalog-article" }).catch(() => {});
    await ensureHostedRuntimeReadyForBench(page, projectId);
    await selectPrimaryAgentModel(page, FIXTURE_BENCH_MODEL);
    await seedRepoPinnedSkillsIntoWorkspace(page, projectId);

    const benchDir = "bench/fixture-news-catalog-article";
    await writeWorkspaceFile(page, `${benchDir}/README.md`, "# Fixture news catalog-article /learn benchmark\n", {
      createDirectories: true,
      projectId,
    }).catch(() => {});
    await writeBenchProgressMarker(page, { projectId, benchDir, step: "initialized" });

    const attemptPrompt = (label: string, attemptNumber: number) =>
      [
        `Benchmark task (${label}, attempt ${attemptNumber}/${totalAttempts}):`,
        "",
        "Open a live browser session (visible inline).",
        `Navigate directly to ${fixtureBaseUrl}/catalog?page=2`,
        'If a cookie dialog appears, click "I agree".',
        'Open the exact Delta article entry from the current page.',
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
    let learnOutcome: {
      command: string;
      signal: string | null;
      error: string | null;
      wallMs: number | null;
      assistantSummary: string | null;
    } | null = null;

    let attemptIndex = 0;
    for (let preIndex = 1; preIndex <= preAttempts; preIndex += 1) {
      attemptIndex += 1;
      if (attemptIndex > 1) await openNewConversation(page);
      await writeBenchProgressMarker(page, {
        projectId,
        benchDir,
        step: "pre-attempt-start",
        details: { attempt: preIndex, total: preAttempts, globalAttempt: attemptIndex },
      });

      const attemptResult = await runFixtureNewsTokenAttempt(page, attemptIndex, attemptPrompt(`pre ${preIndex}/${preAttempts}`, attemptIndex), budgetSec, {
        expectedOrigin,
        expectedPathname,
        expectedToken,
      });
      const routingSnapshot = await collectLearnRoutingSnapshot(page, projectId).catch(() => null);
      const enriched = { ...attemptResult, phase: "pre", routingSnapshot };
      attempts.push(enriched as FixtureNewsTokenAttemptResult);
      await writeWorkspaceFile(page, `${benchDir}/attempt-pre-${preIndex}.json`, JSON.stringify(enriched, null, 2), {
        createDirectories: true,
        projectId,
      }).catch(() => {});
      await writeBenchProgressMarker(page, {
        projectId,
        benchDir,
        step: "pre-attempt-complete",
        details: {
          attempt: preIndex,
          total: preAttempts,
          globalAttempt: attemptIndex,
          success: enriched.success,
          failureKind: enriched.failureKind,
        },
      });
      await hideBrowserSessionIfVisible(page);
    }
    await writeBenchProgressMarker(page, { projectId, benchDir, step: "pre-complete", details: { attempts: preAttempts } });
    await abortBenchIfNoSuccessfulPreAttempt(page, { projectId, benchDir, attempts });

    await writeBenchProgressMarker(page, { projectId, benchDir, step: "learn-start", details: { command: learnCommand } });
    const learnOutcomeRaw = await attemptApplyLearn(page, learnCommand, { projectId, requireWorkspaceMutation: true }).catch(() => ({
      signal: null,
      error: "learn command failed",
      wallMs: null,
      assistantSummary: null,
      workspaceMutatedObserved: false,
    }));
    learnOutcome = { command: learnCommand, ...learnOutcomeRaw };
    await writeBenchProgressMarker(page, {
      projectId,
      benchDir,
      step: "learn-complete",
      details: {
        error: learnOutcome.error,
        workspaceMutatedObserved: learnOutcome.workspaceMutatedObserved,
      },
    });

    await recycleHostedRuntimeForBench(page, projectId, "bench:fixture-news-catalog-article:post-reset");
    await writeBenchProgressMarker(page, { projectId, benchDir, step: "post-reset-ready" });
    await openNewConversation(page);
    await writeBenchProgressMarker(page, { projectId, benchDir, step: "post-conversation-ready" });

    for (let postIndex = 1; postIndex <= postAttempts; postIndex += 1) {
      attemptIndex += 1;
      if (postIndex > 1) await openNewConversation(page);
      await writeBenchProgressMarker(page, {
        projectId,
        benchDir,
        step: "post-attempt-start",
        details: { attempt: postIndex, total: postAttempts, globalAttempt: attemptIndex },
      });

      const attemptResult = await runFixtureNewsTokenAttempt(page, attemptIndex, attemptPrompt(`post ${postIndex}/${postAttempts}`, attemptIndex), budgetSec, {
        expectedOrigin,
        expectedPathname,
        expectedToken,
      });
      const routingSnapshot = await collectLearnRoutingSnapshot(page, projectId).catch(() => null);
      const enriched = { ...attemptResult, phase: "post", routingSnapshot };
      attempts.push(enriched as FixtureNewsTokenAttemptResult);
      await writeWorkspaceFile(page, `${benchDir}/attempt-post-${postIndex}.json`, JSON.stringify(enriched, null, 2), {
        createDirectories: true,
        projectId,
      }).catch(() => {});
      await writeBenchProgressMarker(page, {
        projectId,
        benchDir,
        step: "post-attempt-complete",
        details: {
          attempt: postIndex,
          total: postAttempts,
          globalAttempt: attemptIndex,
          success: enriched.success,
          failureKind: enriched.failureKind,
        },
      });
      await hideBrowserSessionIfVisible(page);
    }
    await writeBenchProgressMarker(page, { projectId, benchDir, step: "post-complete", details: { attempts: postAttempts } });

    await updateLearnBenchSummary(page, {
      projectId,
      benchKey: "fixture-news-catalog-article",
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

    const lines = [
      "# Fixture news catalog-article /learn benchmark",
      "",
      `Fixture: ${fixtureBaseUrl}`,
      `Expected: ${expectedOrigin}${expectedPathname}`,
      `Expected token: ${expectedToken}`,
      `Budget per attempt: ${budgetSec}s`,
      `Attempts: pre=${preAttempts}, post=${postAttempts}`,
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
      "## /learn outcome",
      "",
      `Command: \`${learnOutcome?.command ?? learnCommand}\``,
      "",
      `Wall: ${learnOutcome?.wallMs ? `${Math.round(learnOutcome.wallMs / 1000)}s` : "-"}`,
      `Signal: ${summarizeBenchSignal(learnOutcome?.signal ?? "-")}`,
      `Error: ${((learnOutcome?.error ?? "-") as string).replace(/\\|/g, " ")}`,
      "",
    ];

    await writeWorkspaceFile(page, `${benchDir}/report.md`, lines.join("\n"), {
      createDirectories: true,
      projectId,
    }).catch(() => {});
    const aiQuality =
      (await writeLearnBenchDiagnostics(page, { projectId, benchDir, attempts: attempts as any }).catch(() => null)) ??
      null;

    assertDeterministicBenchCompleted({ attempts, aiQuality });
  });
});
