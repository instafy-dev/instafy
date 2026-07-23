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
import { attemptApplyLearn, formatMs, openNewConversation, summarizeBenchSignal } from "./benchLearnUtils.js";
import { collectLearnRoutingSnapshot } from "./benchRoutingDebug.js";
import { seedRepoPinnedSkillsIntoWorkspace } from "./fixtureBenchShared.js";
import { startBenchFixtureSite, type BenchFixtureSite } from "./fixtureSiteHarness.js";
import { runFixtureNewsTokenAttempt, type FixtureNewsTokenAttemptResult } from "./benchTasks.js";

const BENCH_MODEL =
  (
    process.env.PLAYWRIGHT_BENCH_MODEL ??
    process.env.PLAYWRIGHT_LEARN_MODEL ??
    process.env.PLAYWRIGHT_RETRO_MODEL ??
    "gpt-5.5"
  ).trim() || "gpt-5.5";

type LoopRecord = {
  loopIndex: number;
  pre: FixtureNewsTokenAttemptResult & { routingSnapshot: unknown };
  learn: {
    command: string;
    signal: string | null;
    error: string | null;
    wallMs: number | null;
    assistantSummary: string | null;
  };
  post: FixtureNewsTokenAttemptResult & { routingSnapshot: unknown };
  deltaWallMs: number | null;
  deltaInputTokens: number | null;
  deltaShellCommands: number | null;
};

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

async function hideBrowserSessionIfVisible(page: Page) {
  const modal = page.getByTestId("browser-session-modal");
  const visible = await modal.isVisible().catch(() => false);
  if (!visible) return;
  const hideButton = modal.getByRole("button", { name: /hide browser session/i });
  if (await hideButton.isVisible().catch(() => false)) {
    await hideButton.click().catch(() => {});
  }
  await expect(modal).toBeHidden({ timeout: 30_000 }).catch(() => {});
}

function summarizeDelta(current: number | null): string {
  if (current === null || !Number.isFinite(current)) return "-";
  if (Math.abs(current) < 1000) return `${Math.round(current)}ms`;
  return formatMs(current);
}

function promptForAttempt(
  fixtureBaseUrl: string,
  label: string,
  attemptNumber: number,
  totalAttempts: number,
): string {
  return [
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
  ].join("\n");
}

test.describe("Bench: repeated /learn loops for fixture search-beta (opt-in)", () => {
  test.skip((process.env.PLAYWRIGHT_RUN_BENCH ?? "").trim() !== "1", "Set PLAYWRIGHT_RUN_BENCH=1 to enable benchmarks.");
  test.skip(
    (process.env.PLAYWRIGHT_SKIP_CODEX ?? "").trim() === "1",
    "Codex backend unavailable (rate limited). Provide Codex auth (OPENAI_API_KEY or tmp/proxy-codex/auth.json).",
  );
  test.skip(
    (process.env.INSTAFY_ENABLE_BROWSER_SESSION ?? "").trim() !== "1",
    "Browser session disabled (set INSTAFY_ENABLE_BROWSER_SESSION=1 and use runtime-webdev image target).",
  );

  test.describe.configure({ timeout: 90 * 60_000, retries: 0 });
  let fixtureSite: BenchFixtureSite;

  test.beforeAll(async () => {
    fixtureSite = await startBenchFixtureSite("fixture-news-search-beta-loops");
  });

  test.afterAll(async () => {
    await fixtureSite?.stop?.();
  });

  test.afterEach(async ({ page }) => {
    await resetRuntimeUserState(page, { source: "bench:fixture-news-search-beta-loops:cleanup" }).catch(() => {});
  });

  test("repeat learn -> rerun loops in one project", async ({ page }) => {
    page.setDefaultTimeout(60_000);

    const loopCountRaw = Number(process.env.PLAYWRIGHT_BENCH_LOOP_COUNT ?? "3");
    const loopCount = Math.max(1, Math.min(8, Number.isFinite(loopCountRaw) ? loopCountRaw : 3));
    const learnCommand = (process.env.PLAYWRIGHT_BENCH_LEARN_COMMAND ?? "/learn 6").trim() || "/learn 6";
    const budgetSec = Number(process.env.PLAYWRIGHT_BENCH_FIXTURE_NEWS_BUDGET_SECS ?? "210");
    const fixtureBaseUrl = fixtureSite.baseUrl.replace(/\/+$/, "");
    const expectedOrigin = new URL(fixtureBaseUrl).origin;
    const expectedPathname = "/article/beta";
    const expectedToken = "BETA-TOKEN-2a4e19";
    const totalAttempts = loopCount * 2;

    const projectId = await prepareStudio(page);
    if (!projectId) throw new Error("Project id missing for fixture-news-search-beta loop bench.");

    await page.getByTestId("sidebar-nav-chat").click();
    await clearRuntimePreference(page, { projectId, source: "bench:fixture-news-search-beta-loops" }).catch(() => {});
    await ensureHostedRuntimeReady(page, projectId);
    await selectPrimaryAgentModel(page, BENCH_MODEL);
    await seedRepoPinnedSkillsIntoWorkspace(page, projectId);

    const benchDir = "bench/fixture-news-search-beta-loops";
    await writeWorkspaceFile(page, `${benchDir}/README.md`, "# Fixture news search-beta repeated /learn loop benchmark\n", {
      createDirectories: true,
      projectId,
    }).catch(() => {});

    const loopRecords: LoopRecord[] = [];
    let attemptNumber = 0;

    for (let loopIndex = 1; loopIndex <= loopCount; loopIndex += 1) {
      if (loopRecords.length > 0) {
        await openNewConversation(page);
      }

      attemptNumber += 1;
      const pre = await runFixtureNewsTokenAttempt(
        page,
        attemptNumber,
        promptForAttempt(fixtureBaseUrl, `loop ${loopIndex} pre`, attemptNumber, totalAttempts),
        budgetSec,
        {
          expectedOrigin,
          expectedPathname,
          expectedToken,
        },
      );
      const preRoutingSnapshot = await collectLearnRoutingSnapshot(page, projectId).catch(() => null);
      await hideBrowserSessionIfVisible(page);

      const learnOutcomeRaw = await attemptApplyLearn(page, learnCommand, {
        projectId,
        requireWorkspaceMutation: true,
      }).catch(() => ({
        signal: null,
        error: "learn command failed",
        wallMs: null,
        assistantSummary: null,
      }));

      await openNewConversation(page);

      attemptNumber += 1;
      const post = await runFixtureNewsTokenAttempt(
        page,
        attemptNumber,
        promptForAttempt(fixtureBaseUrl, `loop ${loopIndex} post`, attemptNumber, totalAttempts),
        budgetSec,
        {
          expectedOrigin,
          expectedPathname,
          expectedToken,
        },
      );
      const postRoutingSnapshot = await collectLearnRoutingSnapshot(page, projectId).catch(() => null);
      await hideBrowserSessionIfVisible(page);

      const deltaWallMs =
        Number.isFinite(post.wallMs) && Number.isFinite(pre.wallMs) ? post.wallMs - pre.wallMs : null;
      const deltaInputTokens =
        typeof post.tokenUsage?.inputTokens === "number" && typeof pre.tokenUsage?.inputTokens === "number"
          ? post.tokenUsage.inputTokens - pre.tokenUsage.inputTokens
          : null;
      const deltaShellCommands =
        typeof post.shellCommands === "number" && typeof pre.shellCommands === "number"
          ? post.shellCommands - pre.shellCommands
          : null;

      const record: LoopRecord = {
        loopIndex,
        pre: { ...pre, routingSnapshot: preRoutingSnapshot },
        learn: { command: learnCommand, ...learnOutcomeRaw },
        post: { ...post, routingSnapshot: postRoutingSnapshot },
        deltaWallMs,
        deltaInputTokens,
        deltaShellCommands,
      };
      loopRecords.push(record);

      await writeWorkspaceFile(page, `${benchDir}/loop-${String(loopIndex).padStart(2, "0")}.json`, JSON.stringify(record, null, 2), {
        createDirectories: true,
        projectId,
      }).catch(() => {});
    }

    const reportLines: string[] = [];
    reportLines.push("# Fixture news search-beta repeated /learn loops");
    reportLines.push("");
    reportLines.push(`Fixture: ${fixtureBaseUrl}`);
    reportLines.push(`Expected: ${expectedOrigin}${expectedPathname}`);
    reportLines.push(`Expected token: ${expectedToken}`);
    reportLines.push(`Budget per attempt: ${budgetSec}s`);
    reportLines.push(`Loop count: ${loopCount}`);
    reportLines.push(`Model: ${BENCH_MODEL}`);
    reportLines.push(`Generated: ${new Date().toISOString()}`);
    reportLines.push("");
    reportLines.push("| Loop | Pre | Post | Δ wall | Δ input | Δ shell |");
    reportLines.push("| --- | --- | --- | --- | --- | --- |");

    for (const record of loopRecords) {
      reportLines.push(
        `| ${record.loopIndex} | ${record.pre.success ? "OK" : `FAIL (${record.pre.failureKind ?? "-"})`} ${formatMs(record.pre.wallMs)} | ${
          record.post.success ? "OK" : `FAIL (${record.post.failureKind ?? "-"})`
        } ${formatMs(record.post.wallMs)} | ${summarizeDelta(record.deltaWallMs)} | ${
          record.deltaInputTokens == null ? "-" : Math.round(record.deltaInputTokens)
        } | ${record.deltaShellCommands == null ? "-" : record.deltaShellCommands} |`,
      );
    }

    reportLines.push("");
    reportLines.push("## Learn outcomes");
    reportLines.push("");
    for (const record of loopRecords) {
      reportLines.push(`### Loop ${record.loopIndex}`);
      reportLines.push(`- Command: \`${record.learn.command}\``);
      reportLines.push(`- Wall: ${record.learn.wallMs == null ? "-" : formatMs(record.learn.wallMs)}`);
      reportLines.push(`- Signal: ${summarizeBenchSignal(record.learn.signal ?? "-")}`);
      reportLines.push(`- Error: ${(record.learn.error ?? "-").replace(/\|/g, " ")}`);
      reportLines.push("");
    }

    await writeWorkspaceFile(page, `${benchDir}/report.md`, reportLines.join("\n"), {
      createDirectories: true,
      projectId,
    }).catch(() => {});

    expect(loopRecords.length).toBe(loopCount);
  });
});
