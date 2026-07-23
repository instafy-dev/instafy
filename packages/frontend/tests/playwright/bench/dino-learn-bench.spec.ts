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
  fetchRunMetricsForAttemptWithRetry,
  type TokenUsage,
} from "./benchLearnUtils.js";
import { updateLearnBenchSummary } from "./learnBenchSummary.js";

const UUID_REGEX =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

function resolveControllerUrl(): string {
  return (process.env.CONTROLLER_URL ?? "http://127.0.0.1:8788").trim().replace(/\/+$/, "");
}

function resolveServiceRoleKey(): string | null {
  const candidates = [
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    process.env.SERVICE_ROLE_KEY,
  ];
  for (const value of candidates) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return null;
}

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

async function waitForConversationControllerId(page: Page, timeoutMs = 30_000): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const controllerId = await page
      .evaluate(() => {
        try {
          const params = new URLSearchParams(window.location.search);
          return params.get("conversationControllerId");
        } catch {
          return null;
        }
      })
      .catch(() => null);
    if (typeof controllerId === "string" && UUID_REGEX.test(controllerId.trim())) {
      return controllerId.trim();
    }
    await page.waitForTimeout(200);
  }
  return null;
}

type ControllerRunSnapshot = {
  id: string;
  conversation_id?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  run_type?: string | null;
  status?: string | null;
};

async function fetchControllerRuns(page: Page, projectId: string, limit = 200): Promise<ControllerRunSnapshot[] | null> {
  const controllerUrl = resolveControllerUrl();
  const serviceRoleKey = resolveServiceRoleKey();
  if (!controllerUrl || !serviceRoleKey) {
    return null;
  }

  const url = new URL(`${controllerUrl}/runs`);
  url.searchParams.set("projectId", projectId);
  url.searchParams.set("limit", String(Math.max(1, Math.min(limit, 200))));

  const response = await page.context().request.get(url.toString(), {
    headers: { authorization: `Bearer ${serviceRoleKey}` },
  });
  if (!response.ok()) {
    return null;
  }
  const payload = (await response.json().catch(() => null)) as unknown;
  if (!Array.isArray(payload)) {
    return null;
  }
  return payload
    .map((entry) => (entry && typeof entry === "object" ? (entry as Record<string, unknown>) : null))
    .filter((entry): entry is Record<string, unknown> => !!entry)
    .map((entry) => ({
      id: typeof entry.id === "string" ? entry.id : "",
      conversation_id: typeof entry.conversation_id === "string" ? entry.conversation_id : null,
      created_at: typeof entry.created_at === "string" ? entry.created_at : null,
      updated_at: typeof entry.updated_at === "string" ? entry.updated_at : null,
      run_type: typeof entry.run_type === "string" ? entry.run_type : null,
      status: typeof entry.status === "string" ? entry.status : null,
    }))
    .filter((entry) => !!entry.id);
}

function parseScoreFromAssistantText(text: string): number | null {
  const normalized = (text ?? "").trim();
  if (!normalized) {
    return null;
  }
  const explicit = normalized.match(/(?:^|\n)\s*SCORE\s*[:=]\s*(\d+)\s*(?:$|\n)/i);
  if (explicit) {
    return Number(explicit[1]);
  }
  const loose = normalized.match(/\bscore\b[^0-9]{0,20}(\d{1,6})/i);
  if (loose) {
    return Number(loose[1]);
  }
  return null;
}

type DinoAttemptResult = {
  attempt: number;
  startedAt: string;
  endedAt: string;
  wallMs: number;
  budgetSec: number;
  score: number | null;
  assistantTurns: number;
  controllerRuns: number | null;
  assistantSummary: string;
  runId: string | null;
  tokenUsage: TokenUsage | null;
  mcpToolCalls: number;
  shellCommands: number;
};

async function runDinoAttempt(
  page: Page,
  projectId: string,
  attempt: number,
  prompt: string,
  budgetSec: number,
): Promise<DinoAttemptResult> {
  const assistantBubbles = page.locator('[data-testid="chat-bubble-assistant"]');
  const baselineAssistantCount = await assistantBubbles.count();

  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();
  const conversationControllerId = await waitForConversationControllerId(page, 30_000);

  await page.getByTestId("chat-input").fill(prompt);
  await expect(page.getByTestId("chat-send-button")).toBeEnabled();
  await page.getByTestId("chat-send-button").click();

  const deadline = startedAtMs + budgetSec * 1000;
  let assistantSummary = "";
  let score: number | null = null;
  let lastSeenAssistantCount = baselineAssistantCount;
  let lastSeenText = "";
  while (Date.now() < deadline) {
    const count = await assistantBubbles.count();
    if (count > lastSeenAssistantCount) {
      lastSeenAssistantCount = count;
    }
    if (count > baselineAssistantCount) {
      const currentText = (await assistantBubbles.last().innerText().catch(() => "")).trim();
      if (currentText && currentText !== lastSeenText) {
        lastSeenText = currentText;
        assistantSummary = currentText;
        const maybeScore = parseScoreFromAssistantText(currentText);
        if (maybeScore !== null) {
          score = maybeScore;
          break;
        }
      }
    }
    await page.waitForTimeout(1_000);
  }

  const endedAtMs = Date.now();
  const endedAt = new Date(endedAtMs).toISOString();

  let controllerRuns: number | null = null;
  if (conversationControllerId) {
    const runs = await fetchControllerRuns(page, projectId, 200);
    if (runs) {
      const windowStart = startedAtMs - 5_000;
      const windowEnd = endedAtMs + 5_000;
      controllerRuns = runs.filter((run) => {
        if (run.conversation_id !== conversationControllerId) {
          return false;
        }
        const createdAt = run.created_at ? Date.parse(run.created_at) : NaN;
        if (!Number.isFinite(createdAt)) {
          return true;
        }
        return createdAt >= windowStart && createdAt <= windowEnd;
      }).length;
    }
  }

  const assistantTurns = Math.max(0, (await assistantBubbles.count()) - baselineAssistantCount);
  const assistantMatch = (content: string) => parseScoreFromAssistantText(content) !== null;
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
    score,
    assistantTurns,
    controllerRuns,
    assistantSummary,
    runId: metrics.runId,
    tokenUsage: metrics.tokenUsage,
    mcpToolCalls: metrics.mcpToolCalls,
    shellCommands: metrics.shellCommands,
  };
}

function formatMs(ms: number): string {
  if (!Number.isFinite(ms)) {
    return "-";
  }
  const sign = ms < 0 ? "-" : "";
  const absMs = Math.abs(ms);
  if (absMs < 1000) {
    return `${sign}${absMs}ms`;
  }
  const seconds = Math.round(absMs / 1000);
  if (seconds < 60) {
    return `${sign}${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const rem = seconds % 60;
  return `${sign}${minutes}m ${rem}s`;
}

test.describe("Bench: /learn improves Dino game automation (opt-in)", () => {
  test.skip((process.env.PLAYWRIGHT_RUN_BENCH ?? "").trim() !== "1", "Set PLAYWRIGHT_RUN_BENCH=1 to enable benchmarks.");
  test.skip(
    (process.env.PLAYWRIGHT_SKIP_CODEX ?? "").trim() === "1",
    "Codex backend unavailable (rate limited). Provide Codex auth (OPENAI_API_KEY or tmp/proxy-codex/auth.json)."
  );
  test.skip(
    (process.env.INSTAFY_ENABLE_BROWSER_SESSION ?? "").trim() !== "1",
    "Browser session disabled (set INSTAFY_ENABLE_BROWSER_SESSION=1 and use runtime-webdev image target).",
  );

  test.describe.configure({ timeout: 30 * 60_000 });

  test.afterEach(async ({ page }) => {
    await resetRuntimeUserState(page, { source: "bench:dino:cleanup" }).catch(() => {});
  });

  test("before/after /learn (score >= 100 target)", async ({ page }) => {
    page.setDefaultTimeout(60_000);

    const budgetSec = Number(process.env.PLAYWRIGHT_BENCH_DINO_BUDGET_SECS ?? "600");
    const projectId = await prepareStudio(page);
    if (!projectId) {
      throw new Error("Project id missing for dino bench.");
    }
    await page.getByTestId("sidebar-nav-chat").click();
    await clearRuntimePreference(page, { projectId, source: "bench:dino" }).catch(() => {});
    await ensureHostedRuntimeReady(page, projectId);

    const benchDir = "bench/dino";
    await writeWorkspaceFile(page, `${benchDir}/README.md`, "# Dino /learn benchmark\n", {
      createDirectories: true,
      projectId,
    }).catch(() => {});

    const attemptPrompt = (attemptNumber: number) =>
      [
        `Benchmark task (attempt ${attemptNumber}/2):`,
        "",
        `Find the dinosaur game you can play in Chrome/Chromium when you are offline (the built-in dinosaur game).`,
        `Open a live browser session (visible inline) and get the game running.`,
        `Then play it (automate inputs) until you reach a score of at least 100, or until ${budgetSec} seconds have elapsed.`,
        "",
        `Important:`,
        `- Keep using the SAME existing browser session for follow-ups. Do not open a new session unless the existing one is gone.`,
        `- In your final reply, include a line exactly like: SCORE: <number>`,
      ].join("\n");

    const before = await runDinoAttempt(page, projectId, 1, attemptPrompt(1), budgetSec);

    await writeWorkspaceFile(page, `${benchDir}/attempt-1.json`, JSON.stringify(before, null, 2), {
      createDirectories: true,
      projectId,
    }).catch(() => {});

    // For a fair before/after, close any existing browser modal so attempt 2 must reopen it.
    const existingModal = page.getByTestId("browser-session-modal");
    const modalVisible = await existingModal.isVisible().catch(() => false);
    if (modalVisible) {
      const hideButton = existingModal.getByRole("button", { name: /hide browser session/i });
      if (await hideButton.isVisible().catch(() => false)) {
        await hideButton.click().catch(() => {});
      }
      await expect(existingModal).toBeHidden({ timeout: 30_000 }).catch(() => {});
    }

    // Apply learning.
    let learnSignal: string | null = null;
    let learnError: string | null = null;
    try {
      const baselineThreads = await page.getByTestId("conversation-thread-preview").count().catch(() => 0);
      await page.getByTestId("chat-input").fill("/learn");
      await expect(page.getByTestId("chat-send-button")).toBeEnabled();
      await page.getByTestId("chat-send-button").click();

      await expect
        .poll(
          async () => {
            const preview = page
              .getByTestId("conversation-thread-preview")
              .filter({ hasText: /learn/i })
              .first();
            if (await preview.isVisible().catch(() => false)) {
              return (await preview.innerText().catch(() => "")).trim();
            }
            const count = await page.getByTestId("conversation-thread-preview").count().catch(() => 0);
            return count > baselineThreads ? "thread-created" : "";
          },
          { timeout: 240_000 },
        )
        .not.toBe("");

      const preview = page
        .getByTestId("conversation-thread-preview")
        .filter({ hasText: /learn/i })
        .first();
      learnSignal = (await preview.innerText().catch(() => "")).trim() || "learn-thread-visible";
    } catch (error) {
      learnError = error instanceof Error ? error.message : String(error);
    }

    // New conversation for after-learn run.
    await page.getByTestId("chat-new-conversation").click();
    const after = await runDinoAttempt(page, projectId, 2, attemptPrompt(2), budgetSec);

    const attempts: DinoAttemptResult[] = [before, after];
    for (const attempt of attempts) {
      await writeWorkspaceFile(page, `${benchDir}/attempt-${attempt.attempt}.json`, JSON.stringify(attempt, null, 2), {
        createDirectories: true,
        projectId,
      }).catch(() => {});
    }

    const reportLines: string[] = [];
    reportLines.push("# Dino /learn benchmark");
    reportLines.push("");
    reportLines.push(`Budget per attempt: ${budgetSec}s`);
    reportLines.push(`Generated: ${new Date().toISOString()}`);
    reportLines.push("");
    reportLines.push("| Attempt | Wall time | Score | Assistant turns | Controller runs |");
    reportLines.push("| --- | --- | --- | --- | --- |");
    for (const attempt of attempts) {
      reportLines.push(
        `| ${attempt.attempt} | ${formatMs(attempt.wallMs)} | ${attempt.score ?? "-"} | ${attempt.assistantTurns} | ${
          attempt.controllerRuns ?? "-"
        } |`,
      );
    }
    reportLines.push("");
    if (before.score !== null && after.score !== null) {
      reportLines.push(`Delta score: ${after.score - before.score >= 0 ? "+" : ""}${after.score - before.score}`);
    }
    reportLines.push(
      `Delta wall time: ${formatMs(after.wallMs - before.wallMs)} (negative means faster after /learn)`,
    );
    reportLines.push("");
    reportLines.push("Learn outcome:");
    reportLines.push(`- signal: ${learnSignal ?? "-"}`);
    reportLines.push(`- error: ${learnError ?? "-"}`);
    reportLines.push("");
    reportLines.push("Raw outputs:");
    reportLines.push(`- ${benchDir}/attempt-1.json`);
    reportLines.push(`- ${benchDir}/attempt-2.json`);

    await writeWorkspaceFile(page, `${benchDir}/report.md`, reportLines.join("\n"), {
      createDirectories: true,
      projectId,
    });

    await updateLearnBenchSummary(page, {
      projectId,
      benchKey: "dino-score-100",
      benchDir,
      attempts: attempts.map((attempt) => ({
        attempt: attempt.attempt,
        wallMs: attempt.wallMs,
        success: typeof attempt.score === "number" ? attempt.score >= 100 : false,
        assistantTurns: attempt.assistantTurns,
        tokenUsage: attempt.tokenUsage,
        mcpToolCalls: attempt.mcpToolCalls,
        shellCommands: attempt.shellCommands,
      })),
    }).catch(() => {});

    // This is a benchmark: do not fail the suite just because the agent didn't hit the target.
    expect(true).toBeTruthy();
  });

  test("before/after /learn (maximize score within budget)", async ({ page }) => {
    page.setDefaultTimeout(60_000);

    const budgetSec = Number(process.env.PLAYWRIGHT_BENCH_DINO_BUDGET_SECS ?? "600");
    const projectId = await prepareStudio(page);
    if (!projectId) {
      throw new Error("Project id missing for dino bench.");
    }
    await page.getByTestId("sidebar-nav-chat").click();
    await clearRuntimePreference(page, { projectId, source: "bench:dino-max" }).catch(() => {});
    await ensureHostedRuntimeReady(page, projectId);

    const benchDir = "bench/dino";
    await writeWorkspaceFile(page, `${benchDir}/README.md`, "# Dino /learn benchmark\n", {
      createDirectories: true,
      projectId,
    }).catch(() => {});

    const attemptPrompt = (attemptNumber: number) =>
      [
        `Benchmark task (attempt ${attemptNumber}/2):`,
        "",
        `Find the dinosaur game you can play in Chrome/Chromium when you are offline (the built-in dinosaur game).`,
        `Open a live browser session (visible inline) and get the game running.`,
        `Then play it (automate inputs) and try to achieve the highest score you can within ${budgetSec} seconds.`,
        "",
        `Important:`,
        `- Keep using the SAME existing browser session for follow-ups. Do not open a new session unless the existing one is gone.`,
        `- In your final reply (when time is up), include a line exactly like: SCORE: <number>`,
      ].join("\n");

    const before = await runDinoAttempt(page, projectId, 1, attemptPrompt(1), budgetSec);

    await writeWorkspaceFile(page, `${benchDir}/max-attempt-1.json`, JSON.stringify(before, null, 2), {
      createDirectories: true,
      projectId,
    }).catch(() => {});

    // Close any existing browser modal so attempt 2 must reopen it.
    const existingModal = page.getByTestId("browser-session-modal");
    const modalVisible = await existingModal.isVisible().catch(() => false);
    if (modalVisible) {
      const hideButton = existingModal.getByRole("button", { name: /hide browser session/i });
      if (await hideButton.isVisible().catch(() => false)) {
        await hideButton.click().catch(() => {});
      }
      await expect(existingModal).toBeHidden({ timeout: 30_000 }).catch(() => {});
    }

    let learnSignal: string | null = null;
    let learnError: string | null = null;
    try {
      const baselineThreads = await page.getByTestId("conversation-thread-preview").count().catch(() => 0);
      await page.getByTestId("chat-input").fill("/learn");
      await expect(page.getByTestId("chat-send-button")).toBeEnabled();
      await page.getByTestId("chat-send-button").click();

      await expect
        .poll(
          async () => {
            const preview = page
              .getByTestId("conversation-thread-preview")
              .filter({ hasText: /learn/i })
              .first();
            if (await preview.isVisible().catch(() => false)) {
              return (await preview.innerText().catch(() => "")).trim();
            }
            const count = await page.getByTestId("conversation-thread-preview").count().catch(() => 0);
            return count > baselineThreads ? "thread-created" : "";
          },
          { timeout: 240_000 },
        )
        .not.toBe("");

      const preview = page
        .getByTestId("conversation-thread-preview")
        .filter({ hasText: /learn/i })
        .first();
      learnSignal = (await preview.innerText().catch(() => "")).trim() || "learn-thread-visible";
    } catch (error) {
      learnError = error instanceof Error ? error.message : String(error);
    }

    await page.getByTestId("chat-new-conversation").click();
    const after = await runDinoAttempt(page, projectId, 2, attemptPrompt(2), budgetSec);

    const attempts: DinoAttemptResult[] = [before, after];
    for (const attempt of attempts) {
      await writeWorkspaceFile(page, `${benchDir}/max-attempt-${attempt.attempt}.json`, JSON.stringify(attempt, null, 2), {
        createDirectories: true,
        projectId,
      }).catch(() => {});
    }

    const reportLines: string[] = [];
    reportLines.push("# Dino /learn benchmark (maximize)");
    reportLines.push("");
    reportLines.push(`Budget per attempt: ${budgetSec}s`);
    reportLines.push(`Generated: ${new Date().toISOString()}`);
    reportLines.push("");
    reportLines.push("| Attempt | Wall time | Score | Assistant turns | Controller runs |");
    reportLines.push("| --- | --- | --- | --- | --- |");
    for (const attempt of attempts) {
      reportLines.push(
        `| ${attempt.attempt} | ${formatMs(attempt.wallMs)} | ${attempt.score ?? "-"} | ${attempt.assistantTurns} | ${
          attempt.controllerRuns ?? "-"
        } |`,
      );
    }
    reportLines.push("");
    if (before.score !== null && after.score !== null) {
      reportLines.push(`Delta score: ${after.score - before.score >= 0 ? "+" : ""}${after.score - before.score}`);
    }
    reportLines.push(
      `Delta wall time: ${formatMs(after.wallMs - before.wallMs)} (negative means faster after /learn)`,
    );
    reportLines.push("");
    reportLines.push("Learn outcome:");
    reportLines.push(`- signal: ${learnSignal ?? "-"}`);
    reportLines.push(`- error: ${learnError ?? "-"}`);
    reportLines.push("");
    reportLines.push("Raw outputs:");
    reportLines.push(`- ${benchDir}/max-attempt-1.json`);
    reportLines.push(`- ${benchDir}/max-attempt-2.json`);

    await writeWorkspaceFile(page, `${benchDir}/report-max.md`, reportLines.join("\n"), {
      createDirectories: true,
      projectId,
    });

    await updateLearnBenchSummary(page, {
      projectId,
      benchKey: "dino-maximize",
      benchDir,
      attempts: attempts.map((attempt) => ({
        attempt: attempt.attempt,
        wallMs: attempt.wallMs,
        success: typeof attempt.score === "number",
        assistantTurns: attempt.assistantTurns,
        tokenUsage: attempt.tokenUsage,
        mcpToolCalls: attempt.mcpToolCalls,
        shellCommands: attempt.shellCommands,
      })),
    }).catch(() => {});

    expect(true).toBeTruthy();
  });
});
