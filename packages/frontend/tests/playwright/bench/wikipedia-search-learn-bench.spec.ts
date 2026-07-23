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
  fetchRunMetricsForAttemptWithRetry,
  formatMs,
  openNewConversation,
  truncateMiddle,
  tryWaitForConversationControllerId,
  type TokenUsage,
} from "./benchLearnUtils.js";
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

function parseArticleFields(text: string): { title: string | null; url: string | null } {
  const normalized = (text ?? "").trim();
  if (!normalized) return { title: null, url: null };

  let title: string | null = null;
  let url: string | null = null;

  for (const line of normalized.split(/\r?\n/)) {
    const titleMatch = line.match(/^\s*ARTICLE_TITLE\s*[:=]\s*(.+?)\s*$/i);
    if (titleMatch && !title) {
      title = titleMatch[1].trim();
    }
    const urlMatch = line.match(/^\s*ARTICLE_URL\s*[:=]\s*(.+?)\s*$/i);
    if (urlMatch && !url) {
      url = urlMatch[1].trim();
    }
  }

  if (!title) {
    const match = normalized.match(/\bARTICLE_TITLE\s*[:=]\s*(.+?)(?=\s+ARTICLE_URL\s*[:=]|$)/i);
    if (match) title = match[1].trim();
  }
  if (!url) {
    const match = normalized.match(/\bARTICLE_URL\s*[:=]\s*(.+?)\s*$/i);
    if (match) url = match[1].trim();
  }
  if (url) {
    url = url.replace(/[).,;!?\u201d]+$/g, "").trim();
  }

  return { title, url };
}

function looksLikeValidWikipediaTarget(title: string | null, url: string | null, query: string): boolean {
  if (!title || !url) return false;
  if (title.includes("<") || url.includes("<")) return false;
  if (!/^https?:\/\//i.test(url)) return false;
  if (!/wikipedia\.org\/wiki\//i.test(url)) return false;
  const lowered = title.toLowerCase();
  if (!lowered.includes(query.toLowerCase())) {
    // Some pages include disambiguation suffixes; allow exact match as well.
    if (lowered !== query.toLowerCase()) return false;
  }
  return true;
}

type WikiAttemptResult = {
  attempt: number;
  startedAt: string;
  endedAt: string;
  wallMs: number;
  budgetSec: number;
  articleTitle: string | null;
  articleUrl: string | null;
  success: boolean;
  browserVisible: boolean;
  assistantTurns: number;
  assistantSummary: string;
  runId: string | null;
  tokenUsage: TokenUsage | null;
  mcpToolCalls: number;
  shellCommands: number;
};

async function runWikipediaAttempt(
  page: Page,
  attempt: number,
  prompt: string,
  budgetSec: number,
  query: string,
): Promise<WikiAttemptResult> {
  const assistantBubbles = page.locator('[data-testid="chat-bubble-assistant"]');
  const baselineAssistantCount = await assistantBubbles.count();

  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();

  await page.getByTestId("chat-input").fill(prompt);
  await expect(page.getByTestId("chat-send-button")).toBeEnabled();
  await page.getByTestId("chat-send-button").click();

  const deadline = startedAtMs + budgetSec * 1000;
  const browserModal = page.getByTestId("browser-session-modal");
  let browserVisible = false;
  let assistantSummary = "";
  let lastSeenText = "";
  let articleTitle: string | null = null;
  let articleUrl: string | null = null;

  while (Date.now() < deadline) {
    if (!browserVisible) {
      browserVisible = await browserModal.isVisible().catch(() => false);
    }

    const count = await assistantBubbles.count();
    if (count > baselineAssistantCount) {
      const currentText = (await assistantBubbles.last().innerText().catch(() => "")).trim();
      if (currentText && currentText !== lastSeenText) {
        lastSeenText = currentText;
        assistantSummary = currentText;
        const parsed = parseArticleFields(currentText);
        articleTitle = parsed.title ?? articleTitle;
        articleUrl = parsed.url ?? articleUrl;
        if (looksLikeValidWikipediaTarget(articleTitle, articleUrl, query)) {
          break;
        }
      }
    }

    await page.waitForTimeout(1_000);
  }

  const endedAtMs = Date.now();
  const endedAt = new Date(endedAtMs).toISOString();
  const assistantTurns = Math.max(0, (await assistantBubbles.count()) - baselineAssistantCount);

  const assistantMatch = (content: string) => {
    const parsed = parseArticleFields(content);
    return looksLikeValidWikipediaTarget(parsed.title, parsed.url, query);
  };
  const conversationControllerId = await tryWaitForConversationControllerId(page, 20_000);
  const metrics =
    conversationControllerId
      ? await fetchRunMetricsForAttemptWithRetry(page, conversationControllerId, assistantMatch).catch(() => ({
          runId: null,
          tokenUsage: null,
          mcpToolCalls: 0,
          shellCommands: 0,
          learnRouterBlocks: [],
          learnedBlockReads: [],
          learnedBlockReadCommands: [],
        }))
      : {
          runId: null,
          tokenUsage: null,
          mcpToolCalls: 0,
          shellCommands: 0,
          learnRouterBlocks: [],
          learnedBlockReads: [],
          learnedBlockReadCommands: [],
        };

  return {
    attempt,
    startedAt,
    endedAt,
    wallMs: endedAtMs - startedAtMs,
    budgetSec,
    articleTitle,
    articleUrl,
    success: looksLikeValidWikipediaTarget(articleTitle, articleUrl, query),
    browserVisible,
    assistantTurns,
    assistantSummary,
    runId: metrics.runId,
    tokenUsage: metrics.tokenUsage,
    mcpToolCalls: metrics.mcpToolCalls,
    shellCommands: metrics.shellCommands,
  };
}

test.describe("Bench: /learn improves Wikipedia search navigation (opt-in)", () => {
  test.skip((process.env.PLAYWRIGHT_RUN_BENCH ?? "").trim() !== "1", "Set PLAYWRIGHT_RUN_BENCH=1 to enable benchmarks.");
  test.skip(
    (process.env.PLAYWRIGHT_SKIP_CODEX ?? "").trim() === "1",
    "Codex backend unavailable (rate limited). Provide Codex auth (OPENAI_API_KEY or tmp/proxy-codex/auth.json).",
  );
  test.skip(
    (process.env.INSTAFY_ENABLE_BROWSER_SESSION ?? "").trim() !== "1",
    "Browser session disabled (set INSTAFY_ENABLE_BROWSER_SESSION=1 and use runtime-webdev image target).",
  );

  test.describe.configure({ timeout: 60 * 60_000 });

  test.afterEach(async ({ page }) => {
    await resetRuntimeUserState(page, { source: "bench:wikipedia:cleanup" }).catch(() => {});
  });

  test("before/after /learn (Wikipedia search)", async ({ page }) => {
    page.setDefaultTimeout(60_000);

    const budgetSec = Number(process.env.PLAYWRIGHT_BENCH_WIKI_BUDGET_SECS ?? "120");
    const iterationsRaw = Number(process.env.PLAYWRIGHT_BENCH_WIKI_ITERATIONS ?? "2");
    const iterations = Math.max(2, Math.min(25, Number.isFinite(iterationsRaw) ? iterationsRaw : 2));
    const learnCommand = (process.env.PLAYWRIGHT_BENCH_LEARN_COMMAND ?? "/learn 6").trim() || "/learn 6";
    const query = (process.env.PLAYWRIGHT_BENCH_WIKI_QUERY ?? "Vienna").trim() || "Vienna";

    const projectId = await prepareStudio(page);
    if (!projectId) {
      throw new Error("Project id missing for Wikipedia bench.");
    }

    await page.getByTestId("sidebar-nav-chat").click();
    await clearRuntimePreference(page, { projectId, source: "bench:wikipedia" }).catch(() => {});
    await ensureHostedRuntimeReady(page, projectId);

    const benchDir = "bench/wikipedia-search";
    await writeWorkspaceFile(page, `${benchDir}/README.md`, "# Wikipedia search /learn benchmark\n", {
      createDirectories: true,
      projectId,
    }).catch(() => {});

    const attemptPrompt = (attemptNumber: number) =>
      [
        `Benchmark task (attempt ${attemptNumber}/${iterations}):`,
        "",
        "Open a live browser session (visible inline).",
        "Navigate to https://en.wikipedia.org/.",
        `Use the search box to search for: ${query}`,
        "Open the main article result (not special pages).",
        "Wait for the article page to load, then read the article heading/title and the current URL from the browser.",
        "",
        "Do not use curl/fetch; use only the browser session.",
        "",
        "In your final reply, include lines exactly like:",
        "ARTICLE_TITLE: <title>",
        "ARTICLE_URL: <url>",
      ].join("\n");

    const attempts: WikiAttemptResult[] = [];
    const learnOutcomes: {
      iteration: number;
      command: string;
      signal: string | null;
      error: string | null;
      wallMs: number | null;
      assistantSummary: string | null;
    }[] = [];

    for (let iteration = 1; iteration <= iterations; iteration += 1) {
      if (iteration > 1) {
        await openNewConversation(page);
      }

      const attemptResult = await runWikipediaAttempt(page, iteration, attemptPrompt(iteration), budgetSec, query);
      attempts.push(attemptResult);
      await writeWorkspaceFile(page, `${benchDir}/attempt-${iteration}.json`, JSON.stringify(attemptResult, null, 2), {
        createDirectories: true,
        projectId,
      }).catch(() => {});

      const existingModal = page.getByTestId("browser-session-modal");
      const modalVisible = await existingModal.isVisible().catch(() => false);
      if (modalVisible) {
        const hideButton = existingModal.getByRole("button", { name: /hide browser session/i });
        if (await hideButton.isVisible().catch(() => false)) {
          await hideButton.click().catch(() => {});
        }
        await expect(existingModal).toBeHidden({ timeout: 30_000 }).catch(() => {});
      }

      if (iteration < iterations) {
        const outcome = await attemptApplyLearn(page, learnCommand);
        learnOutcomes.push({ iteration, command: learnCommand, ...outcome });
      }
    }

    const reportLines: string[] = [];
    reportLines.push("# Wikipedia search /learn benchmark");
    reportLines.push("");
    reportLines.push(`Query: ${query}`);
    reportLines.push(`Budget per attempt: ${budgetSec}s`);
    reportLines.push(`Generated: ${new Date().toISOString()}`);
    reportLines.push("");
    reportLines.push("| Attempt | Wall time | Outcome | Tool calls | Token usage (in/cached/out) |");
    reportLines.push("| --- | --- | --- | --- | --- |");
    for (const attempt of attempts) {
      const outcome = attempt.success
        ? `OK: ${truncateMiddle(attempt.articleTitle ?? "", 40)}`
        : attempt.articleTitle
          ? `FAIL: ${truncateMiddle(attempt.articleTitle, 40)}`
          : "-";
      const tokens = attempt.tokenUsage
        ? `${attempt.tokenUsage.inputTokens}/${attempt.tokenUsage.cachedInputTokens}/${attempt.tokenUsage.outputTokens}`
        : "-";
      reportLines.push(
        `| ${attempt.attempt} | ${formatMs(attempt.wallMs)} | ${outcome} | ${attempt.mcpToolCalls} mcp, ${attempt.shellCommands} shell | ${tokens} |`,
      );
    }
    reportLines.push("");
    if (attempts.length >= 2) {
      const first = attempts[0];
      const last = attempts[attempts.length - 1];
      reportLines.push(`Delta wall time (last - first): ${formatMs(last.wallMs - first.wallMs)}`);
    }
    reportLines.push("");
    reportLines.push("Learn outcome:");
    if (learnOutcomes.length === 0) {
      reportLines.push("- (no learn runs)");
    } else {
      for (const outcome of learnOutcomes) {
        reportLines.push(`- after attempt ${outcome.iteration}: ${outcome.command}`);
        reportLines.push(`  - wall: ${formatMs(outcome.wallMs ?? Number.NaN)}`);
        reportLines.push(`  - signal: ${(outcome.signal ?? "-").split(/\r?\n/)[0]}`);
        reportLines.push(`  - error: ${outcome.error ?? "-"}`);
      }
    }
    reportLines.push("");
    reportLines.push("Raw outputs:");
    for (const attempt of attempts) {
      reportLines.push(`- ${benchDir}/attempt-${attempt.attempt}.json`);
    }

    await writeWorkspaceFile(page, `${benchDir}/report.md`, reportLines.join("\n"), {
      createDirectories: true,
      projectId,
    }).catch(() => {});

    await updateLearnBenchSummary(page, {
      projectId,
      benchKey: "wikipedia-search",
      benchDir,
      attempts: attempts.map((attempt) => ({
        attempt: attempt.attempt,
        wallMs: attempt.wallMs,
        success: attempt.success,
        assistantTurns: attempt.assistantTurns,
        tokenUsage: attempt.tokenUsage,
        mcpToolCalls: attempt.mcpToolCalls,
        shellCommands: attempt.shellCommands,
      })),
    }).catch(() => {});

    expect(true).toBeTruthy();
  });
});
