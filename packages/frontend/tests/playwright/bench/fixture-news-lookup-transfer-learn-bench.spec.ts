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

test.describe("Bench: /learn transfers from search flow to lookup variant (opt-in)", () => {
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
    fixtureSite = await startBenchFixtureSite("fixture-news-lookup-transfer");
  });

  test.afterAll(async () => {
    await fixtureSite?.stop?.();
  });

  test.afterEach(async ({ page }) => {
    await resetRuntimeUserState(page, { source: "bench:fixture-news-lookup-transfer:cleanup" }).catch(() => {});
  });

  test("learn on search-beta, then test transfer on lookup-beta", async ({ page }) => {
    page.setDefaultTimeout(60_000);

    const learnCommand = (process.env.PLAYWRIGHT_BENCH_LEARN_COMMAND ?? "/learn 6").trim() || "/learn 6";
    const budgetSec = Number(process.env.PLAYWRIGHT_BENCH_FIXTURE_NEWS_BUDGET_SECS ?? "210");
    const fixtureBaseUrl = fixtureSite.baseUrl.replace(/\/+$/, "");
    const expectedOrigin = new URL(fixtureBaseUrl).origin;
    const expectedPathname = "/article/beta";
    const expectedToken = "BETA-TOKEN-2a4e19";

    const projectId = await prepareStudio(page);
    if (!projectId) throw new Error("Project id missing for fixture-news-lookup-transfer bench.");

    await page.getByTestId("sidebar-nav-chat").click();
    await clearRuntimePreference(page, { projectId, source: "bench:fixture-news-lookup-transfer" }).catch(() => {});
    await ensureHostedRuntimeReadyForBench(page, projectId);
    await selectPrimaryAgentModel(page, FIXTURE_BENCH_MODEL);
    await seedRepoPinnedSkillsIntoWorkspace(page, projectId);

    const benchDir = "bench/fixture-news-lookup-transfer";
    await writeWorkspaceFile(page, `${benchDir}/README.md`, "# Fixture news lookup-transfer /learn benchmark\n", {
      createDirectories: true,
      projectId,
    }).catch(() => {});
    await writeBenchProgressMarker(page, { projectId, benchDir, step: "initialized" });

    const lookupPrompt = (label: string) =>
      [
        `Benchmark task (${label}):`,
        "",
        "Open a live browser session (visible inline).",
        `Navigate to ${fixtureBaseUrl}/lookup`,
        'If a cookie dialog appears, click "I agree".',
        'Use the lookup archive UI (button text is "Find").',
        'Search for "beta dossier".',
        "Open the Beta dossier result.",
        "Wait for the article page to load, then read the article heading, current URL, and article token from the browser.",
        "",
        "Do not use curl/fetch; use only the browser session.",
        "",
        "In your final reply, include lines exactly like:",
        "ARTICLE_TITLE: <title>",
        "ARTICLE_URL: <url>",
        "ARTICLE_TOKEN: <token>",
      ].join("\n");

    const trainingPrompt =
      [
        "Training task before /learn:",
        "",
        "Open a live browser session (visible inline).",
        `Navigate to ${fixtureBaseUrl}/search`,
        'If a cookie dialog appears, click "I agree".',
        'Search for "beta" and submit.',
        "Open the Beta result and read the article heading, current URL, and article token.",
        "",
        "Final reply format:",
        "ARTICLE_TITLE: <title>",
        "ARTICLE_URL: <url>",
        "ARTICLE_TOKEN: <token>",
      ].join("\n");

    const attempts: FixtureNewsTokenAttemptResult[] = [];

    await writeBenchProgressMarker(page, { projectId, benchDir, step: "pre-attempt-start", details: { attempt: 1, total: 1, globalAttempt: 1 } });
    const preAttempt = await runFixtureNewsTokenAttempt(page, 1, lookupPrompt("pre transfer"), budgetSec, {
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
      details: { attempt: 1, total: 1, globalAttempt: 1, success: preEnriched.success, failureKind: preEnriched.failureKind },
    });
    await hideBrowserSessionIfVisible(page);
    await writeBenchProgressMarker(page, { projectId, benchDir, step: "pre-complete", details: { attempts: 1 } });
    await abortBenchIfNoSuccessfulPreAttempt(page, { projectId, benchDir, attempts });
    await openNewConversation(page);
    await writeBenchProgressMarker(page, { projectId, benchDir, step: "train-attempt-start", details: { attempt: 1, total: 1, globalAttempt: 2 } });
    const trainingAttempt = await runFixtureNewsTokenAttempt(page, 2, trainingPrompt, budgetSec, {
      expectedOrigin,
      expectedPathname,
      expectedToken,
    });
    const trainingSnapshot = await collectLearnRoutingSnapshot(page, projectId).catch(() => null);
    await writeWorkspaceFile(
      page,
      `${benchDir}/attempt-train-1.json`,
      JSON.stringify({ ...trainingAttempt, phase: "train", routingSnapshot: trainingSnapshot }, null, 2),
      {
        createDirectories: true,
        projectId,
      },
    ).catch(() => {});
    await writeBenchProgressMarker(page, {
      projectId,
      benchDir,
      step: "train-attempt-complete",
      details: {
        attempt: 1,
        total: 1,
        globalAttempt: 2,
        success: trainingAttempt.success,
        failureKind: trainingAttempt.failureKind,
      },
    });
    await hideBrowserSessionIfVisible(page);

    await writeBenchProgressMarker(page, { projectId, benchDir, step: "learn-start", details: { command: learnCommand } });
    const learnOutcome = await attemptApplyLearn(page, learnCommand, { projectId, requireWorkspaceMutation: true }).catch(() => ({
      signal: null,
      error: "learn command failed",
      wallMs: null,
      assistantSummary: null,
      workspaceMutatedObserved: false,
    }));
    await writeBenchProgressMarker(page, {
      projectId,
      benchDir,
      step: "learn-complete",
      details: {
        error: learnOutcome.error,
        workspaceMutatedObserved: learnOutcome.workspaceMutatedObserved,
      },
    });

    await recycleHostedRuntimeForBench(page, projectId, "bench:fixture-news-lookup-transfer:post-reset");
    await writeBenchProgressMarker(page, { projectId, benchDir, step: "post-reset-ready" });
    await openNewConversation(page);
    await writeBenchProgressMarker(page, { projectId, benchDir, step: "post-conversation-ready" });
    await writeBenchProgressMarker(page, { projectId, benchDir, step: "post-attempt-start", details: { attempt: 1, total: 1, globalAttempt: 3 } });
    const postAttempt = await runFixtureNewsTokenAttempt(page, 3, lookupPrompt("post transfer"), budgetSec, {
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
      details: { attempt: 1, total: 1, globalAttempt: 3, success: postEnriched.success, failureKind: postEnriched.failureKind },
    });
    await writeBenchProgressMarker(page, { projectId, benchDir, step: "post-complete", details: { attempts: 1 } });

    await updateLearnBenchSummary(page, {
      projectId,
      benchKey: "fixture-news-lookup-transfer",
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
      "# Fixture news lookup-transfer /learn benchmark",
      "",
      `Fixture: ${fixtureBaseUrl}`,
      `Expected: ${expectedOrigin}${expectedPathname}`,
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
          )}s | ${(attempt.articleUrl ?? "-").replace(/\|/g, " ")} |`,
      ),
      "",
      "## /learn outcome",
      "",
      `Command: \`${learnCommand}\``,
      `Wall: ${learnOutcome.wallMs ? `${Math.round(learnOutcome.wallMs / 1000)}s` : "-"}`,
      `Signal: ${summarizeBenchSignal(learnOutcome.signal ?? "-")}`,
      `Error: ${((learnOutcome.error ?? "-") as string).replace(/\|/g, " ")}`,
      "",
    ];

    await writeWorkspaceFile(page, `${benchDir}/report.md`, lines.join("\n"), {
      createDirectories: true,
      projectId,
    }).catch(() => {});
    const aiQuality =
      (await writeLearnBenchDiagnostics(page, { projectId, benchDir, attempts: attempts as any }).catch(() => null)) ??
      null;

    test.expect.soft(
      trainingAttempt.success,
      `Training attempt should succeed but failed with ${trainingAttempt.failureKind ?? "unknown"}.`,
    ).toBe(true);
    assertDeterministicBenchCompleted({
      attempts,
      aiQuality,
      allowNoLearnedBlocks: false,
    });
  });
});
