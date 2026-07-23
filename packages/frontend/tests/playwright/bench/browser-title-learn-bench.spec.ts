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
  tryWaitForConversationControllerId,
  type TokenUsage,
} from "./benchLearnUtils.js";
import { updateLearnBenchSummary } from "./learnBenchSummary.js";

async function ensureHostedRuntimeReady(page: Page, projectId: string) {
  const ready = await waitForHostedRuntimeReady(page, 10_000).then(() => true).catch(() => false);
  if (!ready) {
    await requestHostedRuntime(page, { projectId }).catch(() => {});
  }
  await waitForHostedRuntimeReady(page, 120_000);
  await page.getByTestId("chat-input").fill("Ready check");
  await expect(page.getByTestId("chat-send-button")).toBeEnabled({ timeout: 120_000 });
  await page.getByTestId("chat-input").fill("");
}

function parseTitleFromAssistantText(text: string): string | null {
  const normalized = (text ?? "").trim();
  if (!normalized) return null;
  // Prefer a dedicated "TITLE: ..." line, but accept inline usage too since models
  // often append it to the end of a sentence.
  for (const line of normalized.split(/\r?\n/)) {
    const match = line.match(/\bTITLE\s*[:=]\s*(.+?)\s*$/i);
    if (match) return match[1].trim();
  }
  const inlineMatch = normalized.match(/\bTITLE\s*[:=]\s*([^\n]+)/i);
  if (inlineMatch) return inlineMatch[1].trim();
  return null;
}

type TitleAttemptResult = {
  attempt: number;
  startedAt: string;
  endedAt: string;
  wallMs: number;
  budgetSec: number;
  title: string | null;
  success: boolean;
  browserVisible: boolean;
  assistantTurns: number;
  assistantSummary: string;
  runId: string | null;
  tokenUsage: TokenUsage | null;
  mcpToolCalls: number;
  shellCommands: number;
};

async function runTitleAttempt(
  page: Page,
  attempt: number,
  prompt: string,
  budgetSec: number,
): Promise<TitleAttemptResult> {
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
  let title: string | null = null;

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
        title = parseTitleFromAssistantText(currentText) ?? title;
        if (title) {
          break;
        }
      }
    }

    await page.waitForTimeout(1_000);
  }

  const endedAtMs = Date.now();
  const endedAt = new Date(endedAtMs).toISOString();
  const assistantTurns = Math.max(0, (await assistantBubbles.count()) - baselineAssistantCount);
  const normalizedTitle = title ? title.trim() : null;
  const success = normalizedTitle?.toLowerCase() === "example domain";

  const assistantMatch = (content: string) => {
    const parsed = parseTitleFromAssistantText(content);
    if (!parsed) return false;
    return parsed.toLowerCase().includes("example");
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
    title,
    success,
    browserVisible,
    assistantTurns,
    assistantSummary,
    runId: metrics.runId,
    tokenUsage: metrics.tokenUsage,
    mcpToolCalls: metrics.mcpToolCalls,
    shellCommands: metrics.shellCommands,
  };
}

test.describe("Bench: /learn improves simple browser title read (opt-in)", () => {
  test.skip((process.env.PLAYWRIGHT_RUN_BENCH ?? "").trim() !== "1", "Set PLAYWRIGHT_RUN_BENCH=1 to enable benchmarks.");
  test.skip(
    (process.env.PLAYWRIGHT_SKIP_CODEX ?? "").trim() === "1",
    "Codex backend unavailable (rate limited). Provide Codex auth (OPENAI_API_KEY or tmp/proxy-codex/auth.json).",
  );
  test.skip(
    (process.env.INSTAFY_ENABLE_BROWSER_SESSION ?? "").trim() !== "1",
    "Browser session disabled (set INSTAFY_ENABLE_BROWSER_SESSION=1 and use runtime-webdev image target).",
  );

  test.describe.configure({ timeout: 30 * 60_000 });

  test.afterEach(async ({ page }) => {
    await resetRuntimeUserState(page, { source: "bench:browser-title:cleanup" }).catch(() => {});
  });

	  test("before/after /learn (example.com title)", async ({ page }) => {
	    page.setDefaultTimeout(60_000);

	    const budgetSec = Number(process.env.PLAYWRIGHT_BENCH_BROWSER_TITLE_BUDGET_SECS ?? "120");
	    const iterationsRaw = Number(process.env.PLAYWRIGHT_BENCH_BROWSER_TITLE_ITERATIONS ?? "2");
	    const iterations = Math.max(2, Math.min(25, Number.isFinite(iterationsRaw) ? iterationsRaw : 2));
	    const learnCommand = (process.env.PLAYWRIGHT_BENCH_LEARN_COMMAND ?? "/learn 6").trim() || "/learn 6";
	    const projectId = await prepareStudio(page);
	    if (!projectId) {
	      throw new Error("Project id missing for browser title bench.");
	    }

    await page.getByTestId("sidebar-nav-chat").click();
    await clearRuntimePreference(page, { projectId, source: "bench:browser-title" }).catch(() => {});
    await ensureHostedRuntimeReady(page, projectId);

    const benchDir = "bench/browser-title";
	    await writeWorkspaceFile(page, `${benchDir}/README.md`, "# Browser title /learn benchmark\n", {
	      createDirectories: true,
	      projectId,
	    }).catch(() => {});

	    const attemptPrompt = (attemptNumber: number) =>
	      [
	        `Benchmark task (attempt ${attemptNumber}/${iterations}):`,
	        "",
	        `Open a live browser session (visible inline) and navigate to https://example.com/.`,
	        `Read the page title from the browser session (do not use curl/fetch).`,
	        "",
	        `In your final reply, include a line exactly like: TITLE: Example Domain`,
	      ].join("\n");

	    const attempts: TitleAttemptResult[] = [];
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

	      const attemptResult = await runTitleAttempt(page, iteration, attemptPrompt(iteration), budgetSec);
	      attempts.push(attemptResult);
	      await writeWorkspaceFile(page, `${benchDir}/attempt-${iteration}.json`, JSON.stringify(attemptResult, null, 2), {
	        createDirectories: true,
	        projectId,
	      }).catch(() => {});

	      // Hide after each attempt so the next attempt must explicitly re-open the browser panel.
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
	    reportLines.push("# Browser title /learn benchmark");
	    reportLines.push("");
	    reportLines.push(`Budget per attempt: ${budgetSec}s`);
	    reportLines.push(`Generated: ${new Date().toISOString()}`);
	    reportLines.push("");
	    reportLines.push("| Attempt | Wall time | Title | Browser visible | Assistant turns |");
	    reportLines.push("| --- | --- | --- | --- | --- |");
	    for (const attempt of attempts) {
	      reportLines.push(
	        `| ${attempt.attempt} | ${formatMs(attempt.wallMs)} | ${attempt.title ?? "-"} | ${
	          attempt.browserVisible ? "yes" : "no"
	        } | ${attempt.assistantTurns} |`,
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
        reportLines.push(`  - signal: ${outcome.signal ?? "-"}`);
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
      benchKey: "browser-title",
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
