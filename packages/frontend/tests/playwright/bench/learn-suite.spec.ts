import { test, expect, type Page } from "@playwright/test";
import {
  clearRuntimePreference,
  prepareStudio,
  requestHostedRuntime,
  resetRuntimeUserState,
  waitForHostedRuntimeReady,
  writeWorkspaceFile,
} from "../utils/harness.js";
import {
  attemptApplyLearn,
  openNewConversation,
} from "./benchLearnUtils.js";
import { runTitleAttempt, runWikipediaAttempt, type TitleAttemptResult, type WikiAttemptResult } from "./benchTasks.js";
import { updateLearnBenchSummary } from "./learnBenchSummary.js";

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

test.describe("Bench suite: multiple /learn tasks in one workspace (opt-in)", () => {
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

  test.afterEach(async ({ page }) => {
    await resetRuntimeUserState(page, { source: "bench:learn-suite:cleanup" }).catch(() => {});
  });

  test("runs browser-title + wikipedia-search in one project and writes a combined summary table", async ({ page }) => {
    page.setDefaultTimeout(60_000);

    const learnCommand = (process.env.PLAYWRIGHT_BENCH_LEARN_COMMAND ?? "/learn 6").trim() || "/learn 6";
    const titleBudgetSec = Number(process.env.PLAYWRIGHT_BENCH_BROWSER_TITLE_BUDGET_SECS ?? "120");
    const wikiBudgetSec = Number(process.env.PLAYWRIGHT_BENCH_WIKI_BUDGET_SECS ?? "120");
    const wikiQuery = (process.env.PLAYWRIGHT_BENCH_WIKI_QUERY ?? "Vienna").trim() || "Vienna";

    const projectId = await prepareStudio(page);
    if (!projectId) {
      throw new Error("Project id missing for learn suite bench.");
    }

    await page.getByTestId("sidebar-nav-chat").click();
    await clearRuntimePreference(page, { projectId, source: "bench:learn-suite" }).catch(() => {});
    await ensureHostedRuntimeReady(page, projectId);

    const suiteDir = "bench/learn-suite";
    await writeWorkspaceFile(page, `${suiteDir}/README.md`, "# /learn bench suite\n", {
      createDirectories: true,
      projectId,
    }).catch(() => {});

    // Bench 1: browser-title
    const titlePrompt = [
      "Benchmark task:",
      "",
      "Open a live browser session (visible inline) and navigate to https://example.com/.",
      "Read the page title from the browser session (do not use curl/fetch).",
      "",
      "In your final reply, include a line exactly like: TITLE: Example Domain",
    ].join("\n");

    const titleAttempt1 = await runTitleAttempt(page, 1, titlePrompt, titleBudgetSec);
    await writeWorkspaceFile(page, `${suiteDir}/browser-title-attempt-1.json`, JSON.stringify(titleAttempt1, null, 2), {
      createDirectories: true,
      projectId,
    }).catch(() => {});
    await hideBrowserSessionIfVisible(page);

    await attemptApplyLearn(page, learnCommand).catch(() => {});
    await openNewConversation(page);

    const titleAttempt2 = await runTitleAttempt(page, 2, titlePrompt, titleBudgetSec);
    await writeWorkspaceFile(page, `${suiteDir}/browser-title-attempt-2.json`, JSON.stringify(titleAttempt2, null, 2), {
      createDirectories: true,
      projectId,
    }).catch(() => {});
    await hideBrowserSessionIfVisible(page);

    await updateLearnBenchSummary(page, {
      projectId,
      benchKey: "browser-title",
      benchDir: suiteDir,
      attempts: [titleAttempt1, titleAttempt2].map((attempt) => ({
        attempt: attempt.attempt,
        wallMs: attempt.wallMs,
        success: attempt.success,
        failureKind: attempt.failureKind,
        assistantTurns: attempt.assistantTurns,
        tokenUsage: attempt.tokenUsage,
        mcpToolCalls: attempt.mcpToolCalls,
        shellCommands: attempt.shellCommands,
      })),
    }).catch(() => {});

    // Bench 2: wikipedia-search
    await openNewConversation(page);
    const wikiPrompt = [
      "Benchmark task:",
      "",
      `Open a live browser session (visible inline) and navigate to https://en.wikipedia.org/.`,
      `Use the Wikipedia UI search to open the page for: ${wikiQuery}`,
      "",
      "In your final reply, include two lines:",
      "ARTICLE_TITLE: <title>",
      "ARTICLE_URL: <url>",
    ].join("\n");

    const wikiAttempt1 = await runWikipediaAttempt(page, 1, wikiPrompt, wikiBudgetSec, wikiQuery);
    await writeWorkspaceFile(page, `${suiteDir}/wikipedia-attempt-1.json`, JSON.stringify(wikiAttempt1, null, 2), {
      createDirectories: true,
      projectId,
    }).catch(() => {});
    await hideBrowserSessionIfVisible(page);

    await attemptApplyLearn(page, learnCommand).catch(() => {});
    await openNewConversation(page);

    const wikiAttempt2 = await runWikipediaAttempt(page, 2, wikiPrompt, wikiBudgetSec, wikiQuery);
    await writeWorkspaceFile(page, `${suiteDir}/wikipedia-attempt-2.json`, JSON.stringify(wikiAttempt2, null, 2), {
      createDirectories: true,
      projectId,
    }).catch(() => {});
    await hideBrowserSessionIfVisible(page);

    await updateLearnBenchSummary(page, {
      projectId,
      benchKey: "wikipedia-search",
      benchDir: suiteDir,
      attempts: [wikiAttempt1, wikiAttempt2].map((attempt) => ({
        attempt: attempt.attempt,
        wallMs: attempt.wallMs,
        success: attempt.success,
        failureKind: attempt.failureKind,
        assistantTurns: attempt.assistantTurns,
        tokenUsage: attempt.tokenUsage,
        mcpToolCalls: attempt.mcpToolCalls,
        shellCommands: attempt.shellCommands,
      })),
    }).catch(() => {});

    expect(true).toBeTruthy();
  });
});
