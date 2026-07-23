import { test, expect, type Page } from "@playwright/test";
import {
  clearRuntimePreference,
  prepareStudio,
  requestHostedRuntime,
  resetRuntimeUserState,
  selectPrimaryAgentModel,
  waitForHostedRuntimeReady,
  writeWorkspaceFile,
} from "../utils/harness.js";
import { attemptApplyLearn, openNewConversation, summarizeBenchSignal } from "./benchLearnUtils.js";
import { writeLearnBenchDiagnostics } from "./benchDiagnostics.js";
import { collectLearnRoutingSnapshot } from "./benchRoutingDebug.js";
import {
  abortBenchIfNoSuccessfulPreAttempt,
  assertDeterministicBenchCompleted,
  hideBrowserSessionIfVisible,
  recycleHostedRuntimeForBench,
  seedRepoPinnedSkillsIntoWorkspace,
  writeBenchProgressMarker,
} from "./fixtureBenchShared.js";
import { startBenchFixtureSite, type BenchFixtureSite } from "./fixtureSiteHarness.js";
import { runFixtureNewsTokenAttempt, type FixtureNewsTokenAttemptResult } from "./benchTasks.js";
import { updateLearnBenchSummary } from "./learnBenchSummary.js";

const BENCH_MODEL =
  (process.env.PLAYWRIGHT_BENCH_MODEL ?? process.env.PLAYWRIGHT_LEARN_MODEL ?? process.env.PLAYWRIGHT_RETRO_MODEL ?? "gpt-5.5").trim() ||
  "gpt-5.5";

async function ensureHostedRuntimeReady(page: Page, projectId: string) {
  const ready = await waitForHostedRuntimeReady(page, 10_000)
    .then(() => true)
    .catch(() => false);
  if (!ready) {
    await requestHostedRuntime(page, { projectId }).catch(() => {});
  }
  await waitForHostedRuntimeReady(page, 120_000);
  await page.getByTestId("chat-input").fill("Ready check");
  await expect(page.getByTestId("chat-send-button")).toBeEnabled({ timeout: 120_000 });
  await page.getByTestId("chat-input").fill("");
}

test.describe("Bench: /learn improves deterministic fixture-site navigation (opt-in)", () => {
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
    fixtureSite = await startBenchFixtureSite("fixture-news-search-beta");
  });

  test.afterAll(async () => {
    await fixtureSite?.stop?.();
  });

  test.afterEach(async ({ page }) => {
    await resetRuntimeUserState(page, { source: "bench:fixture-news-search-beta:cleanup" }).catch(() => {});
  });

  test("before/after /learn (fixture search -> beta)", async ({ page }) => {
    page.setDefaultTimeout(60_000);

    const learnCommand = (process.env.PLAYWRIGHT_BENCH_LEARN_COMMAND ?? "/learn 6").trim() || "/learn 6";
    const budgetSec = Number(process.env.PLAYWRIGHT_BENCH_FIXTURE_NEWS_BUDGET_SECS ?? "210");
    const preAttemptsRaw = Number(process.env.PLAYWRIGHT_BENCH_PRE_ATTEMPTS ?? "2");
    const postAttemptsRaw = Number(process.env.PLAYWRIGHT_BENCH_POST_ATTEMPTS ?? "2");
    const preAttempts = Math.max(1, Math.min(10, Number.isFinite(preAttemptsRaw) ? preAttemptsRaw : 2));
    const postAttempts = Math.max(1, Math.min(10, Number.isFinite(postAttemptsRaw) ? postAttemptsRaw : 2));
    const totalAttempts = preAttempts + postAttempts;
    const fixtureBaseUrl = fixtureSite.baseUrl.replace(/\/+$/, "");
    const expectedOrigin = new URL(fixtureBaseUrl).origin;
    const expectedPathname = "/article/beta";
    const expectedToken = "BETA-TOKEN-2a4e19";

    const projectId = await prepareStudio(page);
    if (!projectId) throw new Error("Project id missing for fixture-news-search-beta bench.");

    await page.getByTestId("sidebar-nav-chat").click();
    await clearRuntimePreference(page, { projectId, source: "bench:fixture-news-search-beta" }).catch(() => {});
    await ensureHostedRuntimeReady(page, projectId);
    await selectPrimaryAgentModel(page, BENCH_MODEL);
    await seedRepoPinnedSkillsIntoWorkspace(page, projectId);

    const benchDir = "bench/fixture-news-search-beta";
    await writeWorkspaceFile(page, `${benchDir}/README.md`, "# Fixture news search-beta /learn benchmark\n", {
      createDirectories: true,
      projectId,
    }).catch(() => {});
    await writeBenchProgressMarker(page, { projectId, benchDir, step: "initialized" });

    const attemptPrompt = (label: string, attemptNumber: number) =>
      [
        `Benchmark task (${label}, attempt ${attemptNumber}/${totalAttempts}):`,
        "",
        "Open a live browser session (visible inline).",
        `Navigate to ${fixtureBaseUrl}/`,
        'If a cookie dialog appears, click "I agree".',
        `Use the Search page (either click "Search" or navigate to ${fixtureBaseUrl}/search).`,
        'Search for "beta" (non-empty query) and submit.',
        'Open the Beta result (it should lead to /article/beta).',
        "Wait for the article page to load, then read the article heading, the current URL, and the article token from the browser.",
        "",
        "Do not use curl/fetch; use only the browser session.",
        "",
        "In your final reply, include lines exactly like:",
        "ARTICLE_TITLE: <title>",
        "ARTICLE_URL: <url>",
        "ARTICLE_TOKEN: <token>",
        "SEARCH_FIELD_CUE: exact field label/name/placeholder used, or -",
        "SUBMIT_CONTROL_CUE: exact button/link text used to submit, or -",
        "RESULT_ENTRY_CUE: exact result link text used, or -",
        "READBACK_LABEL_CUE: exact visible label used to read the token, or -",
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
      if (attemptIndex > 1) {
        await openNewConversation(page);
      }
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
      const enriched = {
        ...attemptResult,
        phase: "pre",
        routingSnapshot,
      };
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

    await recycleHostedRuntimeForBench(page, projectId, "bench:fixture-news-search-beta:post-reset");
    await writeBenchProgressMarker(page, { projectId, benchDir, step: "post-reset-ready" });
    await openNewConversation(page);
    await writeBenchProgressMarker(page, { projectId, benchDir, step: "post-conversation-ready" });

    for (let postIndex = 1; postIndex <= postAttempts; postIndex += 1) {
      attemptIndex += 1;
      if (postIndex > 1) {
        await openNewConversation(page);
      }
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
      const enriched = {
        ...attemptResult,
        phase: "post",
        routingSnapshot,
      };
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
      benchKey: "fixture-news-search-beta",
      benchDir,
      requestedModelHint: BENCH_MODEL,
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
        searchFieldCue: attempt.searchFieldCue,
        submitControlCue: attempt.submitControlCue,
        resultEntryCue: attempt.resultEntryCue,
        readbackLabelCue: attempt.readbackLabelCue,
        learnRouterBlocks: attempt.learnRouterBlocks,
      })),
    }).catch(() => {});

    const reportLines: string[] = [];
    reportLines.push("# Fixture news search-beta /learn benchmark");
    reportLines.push("");
    reportLines.push(`Fixture: ${fixtureBaseUrl}`);
    reportLines.push(`Expected: ${expectedOrigin}${expectedPathname}`);
    reportLines.push(`Expected token: ${expectedToken}`);
    reportLines.push(`Budget per attempt: ${budgetSec}s`);
    reportLines.push(`Attempts: pre=${preAttempts}, post=${postAttempts}`);
    reportLines.push(`Model: ${BENCH_MODEL}`);
    reportLines.push(`Generated: ${new Date().toISOString()}`);
    reportLines.push("");
    reportLines.push("| Phase | Attempt | Success | Failure | Wall | URL |");
    reportLines.push("| --- | --- | --- | --- | --- | --- |");
    for (const attempt of attempts) {
      reportLines.push(
        `| ${(attempt as any).phase ?? "-"} | ${attempt.attempt} | ${attempt.success ? "OK" : "FAIL"} | ${attempt.failureKind ?? "-"} | ${Math.round(
          attempt.wallMs / 1000,
        )}s | ${(attempt.articleUrl ?? "-").replace(/\|/g, " ")} |`,
      );
    }
    reportLines.push("");
    if (learnOutcome) {
      reportLines.push("## /learn outcome");
      reportLines.push("");
      reportLines.push(`Command: \`${learnOutcome.command}\``);
      reportLines.push("");
      reportLines.push(`Wall: ${learnOutcome.wallMs ? `${Math.round(learnOutcome.wallMs / 1000)}s` : "-"}`);
      reportLines.push(`Signal: ${summarizeBenchSignal(learnOutcome.signal)}`);
      reportLines.push(`Error: ${(learnOutcome.error ?? "-").replace(/\|/g, " ")}`);
      reportLines.push("");
    }

    await writeWorkspaceFile(page, `${benchDir}/report.md`, reportLines.join("\n"), {
      createDirectories: true,
      projectId,
    }).catch(() => {});
    const aiQuality =
      (await writeLearnBenchDiagnostics(page, { projectId, benchDir, attempts: attempts as any }).catch(() => null)) ??
      null;

    assertDeterministicBenchCompleted({
      attempts,
      aiQuality,
      postMaxShellCommands: 2,
      postMustNotExceedPreBy: 1,
    });
  });
});
