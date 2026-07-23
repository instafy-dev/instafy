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
  assertDeterministicBenchCompleted,
  hideBrowserSessionIfVisible,
  recycleHostedRuntimeForBench,
  seedRepoPinnedSkillsIntoWorkspace,
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
    fixtureSite = await startBenchFixtureSite("fixture-news-gate-gamma");
  });

  test.afterAll(async () => {
    await fixtureSite?.stop?.();
  });

  test.afterEach(async ({ page }) => {
    await resetRuntimeUserState(page, { source: "bench:fixture-news-gate-gamma:cleanup" }).catch(() => {});
  });

  test("before/after /learn (fixture gate -> gamma)", async ({ page }) => {
    page.setDefaultTimeout(60_000);

    const learnCommand = (process.env.PLAYWRIGHT_BENCH_LEARN_COMMAND ?? "/learn 6").trim() || "/learn 6";
    const budgetSec = Number(process.env.PLAYWRIGHT_BENCH_FIXTURE_NEWS_BUDGET_SECS ?? "240");
    const preAttemptsRaw = Number(process.env.PLAYWRIGHT_BENCH_PRE_ATTEMPTS ?? "2");
    const postAttemptsRaw = Number(process.env.PLAYWRIGHT_BENCH_POST_ATTEMPTS ?? "2");
    const preAttempts = Math.max(1, Math.min(10, Number.isFinite(preAttemptsRaw) ? preAttemptsRaw : 2));
    const postAttempts = Math.max(1, Math.min(10, Number.isFinite(postAttemptsRaw) ? postAttemptsRaw : 2));
    const totalAttempts = preAttempts + postAttempts;
    const fixtureBaseUrl = fixtureSite.baseUrl.replace(/\/+$/, "");
    const expectedOrigin = new URL(fixtureBaseUrl).origin;
    const expectedPathname = "/article/gamma";
    const expectedToken = "GAMMA-TOKEN-91c0fa";

    const projectId = await prepareStudio(page);
    if (!projectId) throw new Error("Project id missing for fixture-news-gate-gamma bench.");

    await page.getByTestId("sidebar-nav-chat").click();
    await clearRuntimePreference(page, { projectId, source: "bench:fixture-news-gate-gamma" }).catch(() => {});
    await ensureHostedRuntimeReady(page, projectId);
    await selectPrimaryAgentModel(page, BENCH_MODEL);
    await seedRepoPinnedSkillsIntoWorkspace(page, projectId);

    const benchDir = "bench/fixture-news-gate-gamma";
    await writeWorkspaceFile(page, `${benchDir}/README.md`, "# Fixture news gate-gamma /learn benchmark\n", {
      createDirectories: true,
      projectId,
    }).catch(() => {});

    const attemptPrompt = (label: string, attemptNumber: number) =>
      [
        `Benchmark task (${label}, attempt ${attemptNumber}/${totalAttempts}):`,
        "",
        "Open a live browser session (visible inline).",
        `Navigate to ${fixtureBaseUrl}/`,
        'If a cookie dialog appears, click "I agree".',
        `Open the secret story via the Gate page (click "Secret story" or navigate to ${fixtureBaseUrl}/gate).`,
        "Find the access code on the gate page, enter it in the form, and unlock the story.",
        "Wait for the article page to load (it should be /article/gamma), then read the article heading, the current URL, and the article token from the browser.",
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
      if (attemptIndex > 1) {
        await openNewConversation(page);
      }

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
      await hideBrowserSessionIfVisible(page);
    }

    const learnOutcomeRaw = await attemptApplyLearn(page, learnCommand, { projectId, requireWorkspaceMutation: true }).catch(() => ({
      signal: null,
      error: "learn command failed",
      wallMs: null,
      assistantSummary: null,
    }));
    learnOutcome = { command: learnCommand, ...learnOutcomeRaw };

    await recycleHostedRuntimeForBench(page, projectId, "bench:fixture-news-gate-gamma:post-reset");
    await openNewConversation(page);

    for (let postIndex = 1; postIndex <= postAttempts; postIndex += 1) {
      attemptIndex += 1;
      if (postIndex > 1) {
        await openNewConversation(page);
      }

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
      await hideBrowserSessionIfVisible(page);
    }

    await updateLearnBenchSummary(page, {
      projectId,
      benchKey: "fixture-news-gate-gamma",
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
        learnRouterBlocks: attempt.learnRouterBlocks,
      })),
    }).catch(() => {});

    const reportLines: string[] = [];
    reportLines.push("# Fixture news gate-gamma /learn benchmark");
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

    assertDeterministicBenchCompleted({ attempts, aiQuality });
  });
});
