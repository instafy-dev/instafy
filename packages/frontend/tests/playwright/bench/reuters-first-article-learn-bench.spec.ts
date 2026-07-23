import { test, expect, type Page } from "@playwright/test";
import {
  clearRuntimePreference,
  getControllerUrl,
  getSupabaseAuthHeaders,
  prepareStudio,
  requestHostedRuntime,
  resetRuntimeUserState,
  waitForHostedRuntimeReady,
  writeWorkspaceFile,
} from "../utils/harness.js";
import { updateLearnBenchSummary } from "./learnBenchSummary.js";

const UUID_REGEX =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

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

async function openNewConversation(page: Page) {
  const tabs = page.locator('[data-testid="workspace-tabs"] [data-tab-kind="conversation"]');
  const previousCount = await tabs.count().catch(() => 0);
  const previousUrl = page.url();

  await page.getByTestId("chat-new-conversation").click();

  // Creating a new conversation is async: depending on layout state we might
  // not get a full navigation, but we should at least see either:
  // - a new conversation tab, or
  // - a URL change (conversationId/controllerId changes)
  await expect
    .poll(
      async () => {
        const currentUrl = page.url();
        const urlChanged = currentUrl !== previousUrl;

        const tabCount = await tabs.count().catch(() => previousCount);
        const countChanged = previousCount > 0 ? tabCount === previousCount + 1 : tabCount > previousCount;

        let conversationChanged = false;
        try {
          const prev = new URL(previousUrl);
          const next = new URL(currentUrl);
          const prevKey = `${prev.searchParams.get("conversationId") ?? ""}:${prev.searchParams.get("conversationControllerId") ?? ""}`;
          const nextKey = `${next.searchParams.get("conversationId") ?? ""}:${next.searchParams.get("conversationControllerId") ?? ""}`;
          conversationChanged = prevKey !== nextKey && nextKey !== ":";
        } catch {
          conversationChanged = false;
        }

        return urlChanged || countChanged || conversationChanged;
      },
      { timeout: 60_000 },
    )
    .toBeTruthy();

  if (previousCount > 0) {
    await expect(tabs).toHaveCount(previousCount + 1, { timeout: 60_000 });
  }

  // Ensure the new conversation is the active one before sending the next prompt.
  if (await tabs.last().isVisible().catch(() => false)) {
    await expect(tabs.last()).toHaveAttribute("aria-current", "page", { timeout: 60_000 }).catch(() => {});
  }

  await expect(page.getByTestId("chat-input")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("chat-send-button")).toBeEnabled({ timeout: 60_000 });
}

function parseConversationControllerIdFromUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    const value = (parsed.searchParams.get("conversationControllerId") ?? "").trim();
    return UUID_REGEX.test(value) ? value : null;
  } catch {
    return null;
  }
}

async function tryWaitForConversationControllerId(page: Page, timeoutMs = 10_000): Promise<string | null> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const id = parseConversationControllerIdFromUrl(page.url());
    if (id) return id;
    await page.waitForTimeout(100);
  }
  return parseConversationControllerIdFromUrl(page.url());
}

function formatMs(ms: number): string {
  if (!Number.isFinite(ms)) return "-";
  const sign = ms < 0 ? "-" : "";
  const absMs = Math.abs(ms);
  if (absMs < 1000) return `${sign}${absMs}ms`;
  const seconds = Math.round(absMs / 1000);
  if (seconds < 60) return `${sign}${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rem = seconds % 60;
  return `${sign}${minutes}m ${rem}s`;
}

function truncateMiddle(input: string, max = 72): string {
  const trimmed = (input ?? "").trim();
  if (trimmed.length <= max) return trimmed;
  const head = Math.max(10, Math.floor((max - 3) / 2));
  const tail = Math.max(10, max - 3 - head);
  return `${trimmed.slice(0, head)}...${trimmed.slice(trimmed.length - tail)}`;
}

type TokenUsage = {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
};

type RunMetrics = {
  runId: string | null;
  tokenUsage: TokenUsage | null;
  mcpToolCalls: number;
  shellCommands: number;
};

function getMetadataMessageType(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== "object") return null;
  const record = metadata as Record<string, unknown>;
  const raw = record["messageType"];
  return typeof raw === "string" ? raw.trim() : null;
}

function extractTokenUsage(metadata: unknown): TokenUsage | null {
  if (!metadata || typeof metadata !== "object") return null;
  const record = metadata as Record<string, unknown>;
  const details = record["details"];
  if (!details || typeof details !== "object") return null;
  const detailsRecord = details as Record<string, unknown>;
  const usage = detailsRecord["usage"];
  if (!usage || typeof usage !== "object") return null;
  const usageRecord = usage as Record<string, unknown>;

  const input = usageRecord["input_tokens"];
  const cached = usageRecord["cached_input_tokens"];
  const output = usageRecord["output_tokens"];
  if (typeof input !== "number" || typeof cached !== "number" || typeof output !== "number") {
    return null;
  }
  return {
    inputTokens: input,
    cachedInputTokens: cached,
    outputTokens: output,
  };
}

async function fetchRunMetricsForAttempt(
  page: Page,
  conversationControllerId: string,
  assistantMatch: (content: string) => boolean,
): Promise<RunMetrics> {
  const headers = getSupabaseAuthHeaders();
  const controllerUrl = getControllerUrl();
  const result: RunMetrics = {
    runId: null,
    tokenUsage: null,
    mcpToolCalls: 0,
    shellCommands: 0,
  };

  if (!headers.authorization) {
    return result;
  }

  const response = await page.context().request.get(
    `${controllerUrl}/conversations/${conversationControllerId}/messages?limit=200`,
    { headers },
  );
  if (!response.ok()) {
    const body = await response.text().catch(() => "");
    throw new Error(`failed to fetch conversation messages (${response.status()}): ${body}`);
  }
  const payload = (await response.json().catch(() => null)) as { messages?: any[] } | null;
  const messages = Array.isArray(payload?.messages) ? payload!.messages : [];

  // Newest-first. Find the main assistant message for this attempt (not token usage).
  const assistant = messages.find((message) => {
    const role = typeof message?.role === "string" ? message.role : "";
    if (role.toLowerCase() !== "assistant") return false;
    const content = typeof message?.content === "string" ? message.content : "";
    const metadata = message?.metadata;
    const messageType = getMetadataMessageType(metadata)?.toLowerCase() ?? "";
    if (messageType === "token_usage") return false;
    return assistantMatch(content);
  });

  const runId = typeof assistant?.runId === "string" && UUID_REGEX.test(assistant.runId) ? assistant.runId : null;
  result.runId = runId;
  if (!runId) {
    return result;
  }

  for (const message of messages) {
    const messageRunId = typeof message?.runId === "string" ? message.runId : null;
    if (messageRunId !== runId) continue;
    const metadata = message?.metadata;
    const messageType = getMetadataMessageType(metadata)?.toLowerCase() ?? "";
    if (messageType === "token_usage" && !result.tokenUsage) {
      result.tokenUsage = extractTokenUsage(metadata);
    } else if (messageType === "mcp_tool_call") {
      result.mcpToolCalls += 1;
    } else if (messageType === "command_execution") {
      result.shellCommands += 1;
    }
  }

  return result;
}

async function fetchRunMetricsForAttemptWithRetry(
  page: Page,
  conversationControllerId: string,
  assistantMatch: (content: string) => boolean,
): Promise<RunMetrics> {
  // Token usage + tool messages can land a beat after the final assistant reply.
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const metrics = await fetchRunMetricsForAttempt(page, conversationControllerId, assistantMatch);
    if (!metrics.runId) return metrics;
    if (metrics.tokenUsage) return metrics;
    await page.waitForTimeout(500);
  }
  return fetchRunMetricsForAttempt(page, conversationControllerId, assistantMatch);
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

  // Inline fallback: models sometimes append these on the same line as prose.
  if (!title) {
    const match = normalized.match(/\bARTICLE_TITLE\s*[:=]\s*(.+?)(?=\s+ARTICLE_URL\s*[:=]|$)/i);
    if (match) {
      title = match[1].trim();
    }
  }
  if (!url) {
    const match = normalized.match(/\bARTICLE_URL\s*[:=]\s*(.+?)\s*$/i);
    if (match) {
      url = match[1].trim();
    }
  }

  // Normalize URL-like values (trim trailing punctuation).
  if (url) {
    url = url.replace(/[).,;!?\u201d]+$/g, "").trim();
  }

  return { title, url };
}

function parseBlockedFields(text: string): { blocked: boolean | null; reason: string | null } {
  const normalized = (text ?? "").trim();
  if (!normalized) return { blocked: null, reason: null };

  let blocked: boolean | null = null;
  let reason: string | null = null;

  for (const line of normalized.split(/\r?\n/)) {
    const blockedMatch = line.match(/^\s*BLOCKED\s*[:=]\s*(yes|no|true|false)\s*$/i);
    if (blockedMatch && blocked === null) {
      const raw = blockedMatch[1].toLowerCase();
      blocked = raw === "yes" || raw === "true";
    }
    const reasonMatch = line.match(/^\s*BLOCK_REASON\s*[:=]\s*(.+?)\s*$/i);
    if (reasonMatch && !reason) {
      reason = reasonMatch[1].trim();
    }
  }

  return { blocked, reason };
}

function looksLikeValidReutersArticle(title: string | null, url: string | null): boolean {
  if (!title || !url) return false;
  const trimmedUrl = url.trim();
  if (!/^https?:\/\//i.test(trimmedUrl)) return false;
  if (!trimmedUrl.includes("reuters.com/")) return false;
  // Avoid accepting the homepage as an "article".
  try {
    const parsed = new URL(trimmedUrl);
    if (parsed.pathname === "/" || parsed.pathname.trim() === "") return false;
  } catch {
    return false;
  }
  if (title.includes("<") || title.toLowerCase().includes("blocked")) return false;
  return true;
}

function looksLikeArticleFieldsPresent(title: string | null, url: string | null): boolean {
  if (!title || !url) return false;
  // Avoid counting prompt placeholders as "present".
  if (title.includes("<") || url.includes("<")) return false;
  return true;
}

type ReutersAttemptResult = {
  attempt: number;
  startedAt: string;
  endedAt: string;
  wallMs: number;
  budgetSec: number;
  articleTitle: string | null;
  articleUrl: string | null;
  blocked: boolean | null;
  blockedReason: string | null;
  success: boolean;
  browserVisible: boolean;
  assistantTurns: number;
  assistantSummary: string;
  runId: string | null;
  tokenUsage: TokenUsage | null;
  mcpToolCalls: number;
  shellCommands: number;
};

async function runReutersAttempt(
  page: Page,
  attempt: number,
  prompt: string,
  budgetSec: number,
): Promise<ReutersAttemptResult> {
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
  let blocked: boolean | null = null;
  let blockedReason: string | null = null;

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
        const blockedParsed = parseBlockedFields(currentText);
        blocked = blockedParsed.blocked ?? blocked;
        blockedReason = blockedParsed.reason ?? blockedReason;
        if (blocked === true) {
          break;
        }
        // Stop when the agent provides article fields (even if it failed to open an article),
        // so we can measure time-to-outcome, not just time-to-budget-expiry.
        if (looksLikeArticleFieldsPresent(articleTitle, articleUrl)) {
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
    const blockedParsed = parseBlockedFields(content);
    if (blockedParsed.blocked === true) return true;
    const parsed = parseArticleFields(content);
    return looksLikeArticleFieldsPresent(parsed.title, parsed.url);
  };
  const conversationControllerId = await tryWaitForConversationControllerId(page, 20_000);
  const metrics =
    conversationControllerId
      ? await fetchRunMetricsForAttemptWithRetry(page, conversationControllerId, assistantMatch).catch(() => ({
          runId: null,
          tokenUsage: null,
          mcpToolCalls: 0,
          shellCommands: 0,
        }))
      : {
          runId: null,
          tokenUsage: null,
          mcpToolCalls: 0,
          shellCommands: 0,
        };

  return {
    attempt,
    startedAt,
    endedAt,
    wallMs: endedAtMs - startedAtMs,
    budgetSec,
    articleTitle,
    articleUrl,
    blocked,
    blockedReason,
    success: looksLikeValidReutersArticle(articleTitle, articleUrl),
    browserVisible,
    assistantTurns,
    assistantSummary,
    runId: metrics.runId,
    tokenUsage: metrics.tokenUsage,
    mcpToolCalls: metrics.mcpToolCalls,
    shellCommands: metrics.shellCommands,
  };
}

async function attemptApplyLearn(
  page: Page,
  command: string,
): Promise<{ signal: string | null; error: string | null; wallMs: number | null; assistantSummary: string | null }> {
  const startedAtMs = Date.now();
  let signal: string | null = null;
  let error: string | null = null;
  let assistantSummary: string | null = null;
  try {
    const learnPreviews = page.getByTestId("conversation-thread-preview").filter({ hasText: /learn/i });
    const baselineLearnCount = await learnPreviews.count().catch(() => 0);
    await page.getByTestId("chat-input").fill(command);
    await expect(page.getByTestId("chat-send-button")).toBeEnabled();
    await page.getByTestId("chat-send-button").click();

    // Wait for the *new* learn thread preview (don’t accidentally attach to an older one).
    await expect
      .poll(async () => await learnPreviews.count(), { timeout: 240_000 })
      .toBeGreaterThan(baselineLearnCount);

    const preview = learnPreviews.nth(baselineLearnCount);
    await expect(preview).toBeVisible({ timeout: 60_000 });

    // Expand and wait for the learn thread to actually finish (no spinner + at least one message).
    const expandButton = preview.getByLabel(/expand thread/i);
    if (await expandButton.isVisible().catch(() => false)) {
      await expandButton.click().catch(() => {});
    }

    const spinner = preview.getByLabel(/thread is running/i);
    await expect(spinner).toBeHidden({ timeout: 240_000 }).catch(() => {});

    const threadAssistantBubbles = preview.locator('[data-testid="chat-bubble-assistant"]');
    await expect
      .poll(async () => await threadAssistantBubbles.count(), { timeout: 240_000 })
      .toBeGreaterThan(0);

    assistantSummary = (await threadAssistantBubbles.last().innerText().catch(() => "")).trim() || null;
    const previewText = (await preview.innerText().catch(() => "")).trim();
    signal = assistantSummary ?? (previewText || "learn-thread-complete");
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  }
  return {
    signal,
    error,
    wallMs: Date.now() - startedAtMs,
    assistantSummary,
  };
}

test.describe("Bench: /learn improves Reuters first-article open (opt-in)", () => {
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
    await resetRuntimeUserState(page, { source: "bench:reuters:cleanup" }).catch(() => {});
  });

  test("before/after /learn (Reuters first article)", async ({ page }) => {
    page.setDefaultTimeout(60_000);

    const budgetSec = Number(process.env.PLAYWRIGHT_BENCH_REUTERS_BUDGET_SECS ?? "240");
    const iterationsRaw = Number(process.env.PLAYWRIGHT_BENCH_REUTERS_ITERATIONS ?? "2");
    const iterations = Math.max(2, Math.min(25, Number.isFinite(iterationsRaw) ? iterationsRaw : 2));
    const learnCommand = (process.env.PLAYWRIGHT_BENCH_LEARN_COMMAND ?? "/learn 6").trim() || "/learn 6";

    const projectId = await prepareStudio(page);
    if (!projectId) {
      throw new Error("Project id missing for Reuters bench.");
    }

    await page.getByTestId("sidebar-nav-chat").click();
    await clearRuntimePreference(page, { projectId, source: "bench:reuters" }).catch(() => {});
    await ensureHostedRuntimeReady(page, projectId);

    const benchDir = "bench/reuters-first-article";
    await writeWorkspaceFile(page, `${benchDir}/README.md`, "# Reuters first-article /learn benchmark\n", {
      createDirectories: true,
      projectId,
    }).catch(() => {});

    const attemptPrompt = (attemptNumber: number) =>
      [
        `Benchmark task (attempt ${attemptNumber}/${iterations}):`,
        "",
        "Open a live browser session (visible inline) and navigate to https://www.reuters.com/.",
        "If a cookie/consent dialog appears, accept it.",
        "Open the first visible news story/article on the homepage (avoid ads, Register/Sign in).",
        "Wait for the article page to load, then read the headline/title and the current URL from the browser.",
        "",
        "Do not use curl/fetch; use only the browser session.",
        "Do not run shell commands or install dependencies.",
        "",
        "In your final reply, include lines exactly like:",
        "ARTICLE_TITLE: <headline>",
        "ARTICLE_URL: <url>",
        "",
        "If Reuters blocks access (CAPTCHA / 'You have been blocked'), do not keep retrying. Reply with:",
        "BLOCKED: yes",
        "BLOCK_REASON: <short reason>",
      ].join("\n");

    const attempts: ReutersAttemptResult[] = [];
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

      const attemptResult = await runReutersAttempt(page, iteration, attemptPrompt(iteration), budgetSec);
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
    reportLines.push("# Reuters first-article /learn benchmark");
    reportLines.push("");
    reportLines.push(`Budget per attempt: ${budgetSec}s`);
    reportLines.push(`Generated: ${new Date().toISOString()}`);
    reportLines.push("");
    reportLines.push("| Attempt | Wall time | Outcome | Tool calls | Token usage (in/cached/out) |");
    reportLines.push("| --- | --- | --- | --- | --- |");
    for (const attempt of attempts) {
      const articleLabel = attempt.blocked === true
        ? `BLOCKED: ${truncateMiddle(attempt.blockedReason ?? "blocked", 40)}`
        : attempt.success
          ? `OK: ${truncateMiddle(attempt.articleTitle ?? "", 40)}`
          : looksLikeArticleFieldsPresent(attempt.articleTitle, attempt.articleUrl)
            ? `FAIL: ${truncateMiddle(attempt.articleTitle ?? "no-article", 40)}`
            : "-";
      const tokens = attempt.tokenUsage
        ? `${attempt.tokenUsage.inputTokens}/${attempt.tokenUsage.cachedInputTokens}/${attempt.tokenUsage.outputTokens}`
        : "-";
      reportLines.push(
        `| ${attempt.attempt} | ${formatMs(attempt.wallMs)} | ${articleLabel} | ${attempt.mcpToolCalls} mcp, ${attempt.shellCommands} shell | ${tokens} |`,
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
      benchKey: "reuters-first-article",
      benchDir,
      attempts: attempts.map((attempt) => ({
        attempt: attempt.attempt,
        wallMs: attempt.wallMs,
        success: attempt.success,
        assistantTurns: attempt.assistantTurns,
        tokenUsage: attempt.tokenUsage ? { ...attempt.tokenUsage, model: null } : null,
        mcpToolCalls: attempt.mcpToolCalls,
        shellCommands: attempt.shellCommands,
      })),
    }).catch(() => {});

    expect(true).toBeTruthy();
  });
});
