import { test, expect, type Page } from "@playwright/test";
import {
  clearRuntimePreference,
  prepareStudio,
  requestHostedRuntime,
  resetRuntimeUserState,
  waitForHostedRuntimeReady,
  writeWorkspaceFile,
} from "../utils/harness.js";
import { attemptApplyLearn, openNewConversation } from "./benchLearnUtils.js";
import { runTitleAttempt, runWikipediaAttempt } from "./benchTasks.js";

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

function formatMs(ms: number): string {
  if (!Number.isFinite(ms)) return "-";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rem = seconds % 60;
  return `${minutes}m ${rem}s`;
}

function buildSummaryMarkdown(data: any): string {
  const lines: string[] = [];
  lines.push("# /learn bench summary (interference)");
  lines.push("");
  lines.push(`Generated: ${data.generatedAt}`);
  lines.push("");
  lines.push("## Browser title (example.com)");
  lines.push("");
  lines.push("| Attempt | Success | Wall | Input | Output | Notes |");
  lines.push("| --- | --- | --- | --- | --- | --- |");
  for (const attempt of data.browserTitle.attempts) {
    const usage = attempt.tokenUsage;
    const input = usage?.inputTokens ?? "-";
    const output = usage?.outputTokens ?? "-";
    const outcome = attempt.success
      ? "OK"
      : attempt.failureKind
        ? `FAIL(${attempt.failureKind})`
        : "FAIL";
    lines.push(
      `| ${attempt.attempt} | ${outcome} | ${formatMs(attempt.wallMs)} | ${input} | ${output} | ${attempt.label} |`,
    );
  }
  lines.push("");
  lines.push("## Wikipedia search");
  lines.push("");
  lines.push("| Attempt | Success | Wall | Input | Output | Notes |");
  lines.push("| --- | --- | --- | --- | --- | --- |");
  for (const attempt of data.wikipedia.attempts) {
    const usage = attempt.tokenUsage;
    const input = usage?.inputTokens ?? "-";
    const output = usage?.outputTokens ?? "-";
    const outcome = attempt.success
      ? "OK"
      : attempt.failureKind
        ? `FAIL(${attempt.failureKind})`
        : "FAIL";
    lines.push(
      `| ${attempt.attempt} | ${outcome} | ${formatMs(attempt.wallMs)} | ${input} | ${output} | ${attempt.label} |`,
    );
  }
  lines.push("");
  lines.push("Notes:");
  lines.push("- This suite checks whether later /learn steps interfere with earlier tasks (Attempt 3 reruns Attempt 1 prompt after finishing Wikipedia).");
  lines.push("- Token columns show `inputTokens` and `outputTokens` from the matched run metadata when available.");
  return lines.join("\n");
}

test.describe("Bench suite: /learn interference check (opt-in)", () => {
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
    await resetRuntimeUserState(page, { source: "bench:learn-interference:cleanup" }).catch(() => {});
  });

  test("runs A/B tasks with /learn between and re-runs A to detect interference", async ({ page }) => {
    page.setDefaultTimeout(60_000);

    const learnCommand = (process.env.PLAYWRIGHT_BENCH_LEARN_COMMAND ?? "/learn 6").trim() || "/learn 6";
    const titleBudgetSec = Number(process.env.PLAYWRIGHT_BENCH_BROWSER_TITLE_BUDGET_SECS ?? "120");
    const wikiBudgetSec = Number(process.env.PLAYWRIGHT_BENCH_WIKI_BUDGET_SECS ?? "120");
    const wikiQuery = (process.env.PLAYWRIGHT_BENCH_WIKI_QUERY ?? "Vienna").trim() || "Vienna";

    const projectId = await prepareStudio(page);
    if (!projectId) throw new Error("Project id missing for learn interference bench.");

    await page.getByTestId("sidebar-nav-chat").click();
    await clearRuntimePreference(page, { projectId, source: "bench:learn-interference" }).catch(() => {});
    await ensureHostedRuntimeReady(page, projectId);

    const suiteDir = "bench/learn-interference";
    await writeWorkspaceFile(page, `${suiteDir}/README.md`, "# /learn interference bench\n", {
      createDirectories: true,
      projectId,
    }).catch(() => {});

    const titlePrompt = [
      "Benchmark task:",
      "",
      "Open a live browser session (visible inline) and navigate to https://example.com/.",
      "Read the page title from the browser session (do not use curl/fetch).",
      "",
      "In your final reply, include a line exactly like: TITLE: Example Domain",
    ].join("\n");

    const wikiPrompt = [
      "Benchmark task:",
      "",
      "Open a live browser session (visible inline) and navigate to https://en.wikipedia.org/.",
      `Use the Wikipedia UI search to open the page for: ${wikiQuery}`,
      "",
      "In your final reply, include two lines:",
      "ARTICLE_TITLE: <title>",
      "ARTICLE_URL: <url>",
    ].join("\n");

    // Task A: browser-title (before + after /learn)
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

    // Task B: wikipedia (before + after /learn)
    await openNewConversation(page);
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

    // Re-run task A after finishing B to detect interference.
    await openNewConversation(page);
    const titleAttempt3 = await runTitleAttempt(page, 3, titlePrompt, titleBudgetSec);
    await writeWorkspaceFile(page, `${suiteDir}/browser-title-attempt-3.json`, JSON.stringify(titleAttempt3, null, 2), {
      createDirectories: true,
      projectId,
    }).catch(() => {});
    await hideBrowserSessionIfVisible(page);

    const summary = {
      version: 1,
      generatedAt: new Date().toISOString(),
      browserTitle: {
        attempts: [
          { ...titleAttempt1, label: "before /learn" },
          { ...titleAttempt2, label: "after /learn" },
          { ...titleAttempt3, label: "post-wikipedia" },
        ],
      },
      wikipedia: {
        attempts: [
          { ...wikiAttempt1, label: "before /learn" },
          { ...wikiAttempt2, label: "after /learn" },
        ],
      },
    };

    await writeWorkspaceFile(page, `${suiteDir}/summary.json`, JSON.stringify(summary, null, 2), {
      createDirectories: true,
      projectId,
    }).catch(() => {});

    await writeWorkspaceFile(page, `${suiteDir}/summary.md`, buildSummaryMarkdown(summary), {
      createDirectories: true,
      projectId,
    }).catch(() => {});

    expect(true).toBeTruthy();
  });
});
