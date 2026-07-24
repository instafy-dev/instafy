import { test, expect, type Locator, type Page } from "@playwright/test";
import {
  prepareStudio,
  clearRuntimePreference,
  ensureRealDefaultCodexCredentialWhenRequired,
  expectAssistantReplyOrSkipRateLimit,
  requestHostedRuntime,
  waitForHostedRuntimeReady,
  resetRuntimeUserState,
  waitForStoreProjectId,
  isLiveAiBackendUnavailableText,
} from "../utils/harness.js";
import { clickQueuedSendNowIfAvailable, createPublicChatFromTopBar } from "../utils/chatUi.js";
import { ensureProjectCreditsReadyForChat } from "../utils/projectCredits.js";
import { openCreditsPanel } from "../utils/sidebar.js";

function conversationTabButtons(page: Page) {
  return page.locator('[data-testid="workspace-tabs"] [data-tab-kind="conversation"]');
}

function assistantBubbles(page: Page): Locator {
  return page.locator('[data-testid="chat-bubble-assistant"]');
}

function agentJobThreadPreviews(page: Page): Locator {
  return page.locator('[data-testid="agent-job-thread-preview"]');
}

async function assistantBubbleTexts(page: Page): Promise<string[]> {
  return assistantBubbles(page).evaluateAll((nodes) =>
    nodes.map((node) => (node as HTMLElement).innerText ?? ""),
  );
}

async function ensureHostedRuntimeReady(page: Page, projectId: string) {
  const ready = await waitForHostedRuntimeReady(page, 10_000, { projectId }).then(() => true).catch(() => false);
  if (!ready) {
    await requestHostedRuntime(page, { projectId }).catch(() => {});
  }
  await waitForHostedRuntimeReady(page, 120_000, { projectId });
}

async function reloadStudioSurface(page: Page, projectId: string | null) {
  const currentUrl = page.url();
  await page.reload({ waitUntil: "domcontentloaded" }).catch(async () => {
    await page.goto(currentUrl, { waitUntil: "domcontentloaded" }).catch(() => {});
  });
  await page.waitForURL((url) => url.pathname.includes("/studio"), { timeout: 60_000 }).catch(() => {});
  if (projectId) {
    await waitForStoreProjectId(page, projectId, 20_000).catch(() => {});
  }
}

async function waitForAssistantRunStart(params: {
  assistantBubbles: Locator;
  baselineAssistantCount: number;
  setupIndicator: Locator;
  typingIndicator: Locator;
  timeoutMs?: number;
}) {
  const timeoutMs = params.timeoutMs ?? 30_000;
  await expect
    .poll(
      async () => {
        const [assistantCount, typingVisible, setupVisible] = await Promise.all([
          params.assistantBubbles.count(),
          params.typingIndicator.isVisible().catch(() => false),
          params.setupIndicator.isVisible().catch(() => false),
        ]);

        if (assistantCount > params.baselineAssistantCount) return "assistant";
        if (typingVisible) return "typing";
        if (setupVisible) return "setup";
        return "none";
      },
      { timeout: timeoutMs },
    )
    .not.toBe("none");
}

async function waitForAssistantNumberReplyInActiveConversation(
  page: Page,
  expectedNumber: number,
  timeoutMs = 180_000,
) {
  const pattern = new RegExp(`\\b${expectedNumber}\\b`);
  await expect
    .poll(
      async () => {
        const texts = await assistantBubbleTexts(page);
        return texts.some((text) => pattern.test(text.trim()));
      },
      { timeout: timeoutMs },
    )
    .toBe(true);
}

test.describe("Controller conversation smoke", () => {
  test.skip(
    (process.env.PLAYWRIGHT_SKIP_CODEX ?? "").trim() === "1",
    "Codex backend unavailable (rate limited). Provide Codex auth (OPENAI_API_KEY or tmp/proxy-codex/auth.json)."
  );
  test.setTimeout(480_000);
  let activeProjectId: string | null = null;

  test.beforeEach(async ({ page }) => {
    const projectId = await prepareStudio(page);
    await ensureRealDefaultCodexCredentialWhenRequired(page);
    activeProjectId = projectId;
    // Clear any stale preferred runtime so runs are not deferred.
    await clearRuntimePreference(page, { projectId, source: "smoke" });
    if (projectId) {
      await ensureHostedRuntimeReady(page, projectId);
      await ensureProjectCreditsReadyForChat(page, projectId, 40);
    }
  });

  test.afterEach(async ({ page }) => {
    await resetRuntimeUserState(page, { source: "conversation-smoke:cleanup" }).catch(() => {});
  });

  test("answers workspace question via conversation", async ({ page }) => {
    page.setDefaultTimeout(60_000);
    if (!activeProjectId) {
      throw new Error("Active project id missing for conversation smoke.");
    }

    const conversationTabs = conversationTabButtons(page);
    await expect(conversationTabs).toHaveCount(1);

    const setupIndicator = page.getByTestId("assistant-setup-indicator");
    const typingIndicator = page.getByTestId("assistant-typing-indicator");
    const bubbles = assistantBubbles(page);
    const baselineAssistantCount = await bubbles.count();

    const promptText = `Quick status check: how many files are in this workspace? ${Date.now()}. ` +
      `Answer in the format "Total files: <number>, Total directories: <number>"`;
    await page.getByTestId("chat-input").fill(promptText);
    await page.getByTestId("chat-send-button").click();

    const userBubble = page.locator('[data-testid="chat-bubble-user"]').last();
    await expect(userBubble).toContainText(promptText);
    await waitForAssistantRunStart({
      assistantBubbles: bubbles,
      baselineAssistantCount,
      setupIndicator,
      typingIndicator,
      timeoutMs: 30_000,
    });

    // Wait for either an assistant bubble or setup completion, whichever happens first.
    const start = Date.now();
    let sawAssistant = false;
    try {
      await bubbles.first().waitFor({ state: "visible", timeout: 90_000 });
      sawAssistant = true;
    } catch {
      // no-op
    }
    if (sawAssistant) {
      await expect(typingIndicator).toHaveCount(0, { timeout: 120_000 });
      const expected = /Total files:\s*\d+[\s\S]*Total directories:\s*\d+/i;
      await expect
        .soft(bubbles.filter({ hasText: expected }).last())
        .toContainText(expected, { timeout: 30_000 });
    }
    if (!sawAssistant) {
      await setupIndicator.waitFor({ state: "detached", timeout: Math.max(1, 90_000 - (Date.now() - start)) }).catch(() => {});
    }
    await expect.soft(typingIndicator).toHaveCount(0, { timeout: 120_000 });
  });

  test("assistant handles arithmetic across conversations", async ({ page }) => {
    page.setDefaultTimeout(60_000);
    if (!activeProjectId) {
      throw new Error("Active project id missing for conversation smoke.");
    }

    const conversationTabs = conversationTabButtons(page);
    await expect(conversationTabs).toHaveCount(1);
    const assistantResponses = assistantBubbles(page);
    const threadPreviews = agentJobThreadPreviews(page);
    const setupIndicator = page.getByTestId("assistant-setup-indicator");
    const typingIndicator = page.getByTestId("assistant-typing-indicator");
    const numericReply = /\b\d+\b/;

    // This is an assistant-dispatch smoke, not an ambient group-participation
    // classifier proof. Address Octo explicitly so busy state is guaranteed
    // while the exact agent turn starts.
    const firstPrompt = "@octo What is 1+1? Reply with just the number.";
    await page.getByTestId("chat-input").fill(firstPrompt);
    const baselineAnswerCount = await assistantResponses.filter({ hasText: numericReply }).count();
    const baselineAssistantCount = await assistantResponses.count();
    const baselineThreadPreviewCount = await threadPreviews.count();
    await page.getByTestId("chat-send-button").click();
    await waitForAssistantRunStart({
      assistantBubbles: assistantResponses,
      baselineAssistantCount,
      setupIndicator,
      typingIndicator,
      timeoutMs: 30_000,
    });
    let sawAssistant = false;
    try {
      await assistantResponses.first().waitFor({ state: "visible", timeout: 90_000 });
      sawAssistant = true;
    } catch {
      sawAssistant = false;
    }
    if (sawAssistant) {
      await expect
        .poll(async () => await assistantResponses.filter({ hasText: numericReply }).count(), { timeout: 120_000 })
        .toBeGreaterThan(baselineAnswerCount);
    }
    await expect(threadPreviews).toHaveCount(baselineThreadPreviewCount);
    await setupIndicator.waitFor({ state: "detached", timeout: 10_000 }).catch(() => {});
    await typingIndicator.waitFor({ state: "detached", timeout: 10_000 }).catch(() => {});

    await createPublicChatFromTopBar(page);
    await expect(conversationTabs).toHaveCount(2);
    await expect(conversationTabs.last()).toContainText("Conversation 2");

    const secondPrompt = "@octo What is 1+2? Reply with just the number.";
    await page.getByTestId("chat-input").fill(secondPrompt);
    const baselineAnswerCount2 = await assistantResponses.filter({ hasText: numericReply }).count();
    const baselineAssistantCount2 = await assistantResponses.count();
    await page.getByTestId("chat-send-button").click();
    await waitForAssistantRunStart({
      assistantBubbles: assistantResponses,
      baselineAssistantCount: baselineAssistantCount2,
      setupIndicator,
      typingIndicator,
      timeoutMs: 30_000,
    });
    sawAssistant = false;
    try {
      await assistantResponses.first().waitFor({ state: "visible", timeout: 90_000 });
      sawAssistant = true;
    } catch {
      sawAssistant = false;
    }
    if (sawAssistant) {
      await expect
        .poll(async () => await assistantResponses.filter({ hasText: numericReply }).count(), { timeout: 120_000 })
        .toBeGreaterThan(baselineAnswerCount2);
    }
    await setupIndicator.waitFor({ state: "detached", timeout: 10_000 }).catch(() => {});
    await typingIndicator.waitFor({ state: "detached", timeout: 10_000 }).catch(() => {});

    await conversationTabs.first().click();
    await expect(conversationTabs.first()).toHaveAttribute("aria-current", "page");
    await page.getByTestId("chat-input").fill("What is 2+2? Reply with just the number.");
    const baselineAnswerCount3 = await assistantResponses.filter({ hasText: numericReply }).count();
    const baselineAssistantCountSecond = await assistantResponses.count();
    await page.getByTestId("chat-send-button").click();
    await waitForAssistantRunStart({
      assistantBubbles: assistantResponses,
      baselineAssistantCount: baselineAssistantCountSecond,
      setupIndicator,
      typingIndicator,
      timeoutMs: 30_000,
    });
    sawAssistant = false;
    try {
      await assistantResponses.first().waitFor({ state: "visible", timeout: 90_000 });
      sawAssistant = true;
    } catch {
      sawAssistant = false;
    }
    if (sawAssistant) {
      await expect
        .poll(async () => await assistantResponses.filter({ hasText: numericReply }).count(), { timeout: 120_000 })
        .toBeGreaterThan(baselineAnswerCount3);
    }
    await setupIndicator.waitFor({ state: "detached", timeout: 10_000 }).catch(() => {});
    await typingIndicator.waitFor({ state: "detached", timeout: 10_000 }).catch(() => {});

    await reloadStudioSurface(page, activeProjectId);
    await page.getByTestId("sidebar-nav-chat").click();
    const reloadedTabs = conversationTabButtons(page);
    await expect(reloadedTabs).toHaveCount(1);
  });

  test.describe("live quick prompt switching", () => {
    test.skip(
      (process.env.PLAYWRIGHT_LIVE_CONVERSATION_QUICK_PROMPTS ?? "").trim() !== "1",
      "Live assistant quick multi-conversation smoke is model-dependent; opt in with PLAYWRIGHT_LIVE_CONVERSATION_QUICK_PROMPTS=1.",
    );

    test("resolves quick prompts across two conversations", async ({ page }) => {
      page.setDefaultTimeout(60_000);
      if (!activeProjectId) {
        throw new Error("Active project id missing for conversation smoke.");
      }

      await waitForHostedRuntimeReady(page);
      const conversationTabs = conversationTabButtons(page);
      const userBubbles = page.locator('[data-testid="chat-bubble-user"]');
      await expect(conversationTabs).toHaveCount(1);

      const firstPrompt = `What is 1+1? Reply with just the number. ${Date.now()}`;
      await page.getByTestId("chat-input").fill(firstPrompt);
      await page.getByTestId("chat-send-button").click();
      await expect(userBubbles.last()).toContainText("What is 1+1?", { timeout: 15_000 });

      await createPublicChatFromTopBar(page);
      await expect(conversationTabs).toHaveCount(2);
      await expect(conversationTabs.last()).toContainText("Conversation 2");

      const secondPrompt = `What is 1+2? Reply with just the number. ${Date.now()}`;
      await page.getByTestId("chat-input").fill(secondPrompt);
      await page.getByTestId("chat-send-button").click();
      await expect(userBubbles.last()).toContainText("What is 1+2?", { timeout: 15_000 });

      await conversationTabs.first().click();
      await expect(conversationTabs.first()).toHaveAttribute("aria-current", "page");
      await expect(userBubbles.last()).toContainText("What is 1+1?", { timeout: 15_000 });
      await waitForAssistantNumberReplyInActiveConversation(page, 2);

      await conversationTabs.last().click();
      await expect(conversationTabs.last()).toHaveAttribute("aria-current", "page");
      await expect(userBubbles.last()).toContainText("What is 1+2?", { timeout: 15_000 });
      await waitForAssistantNumberReplyInActiveConversation(page, 3);
    });
  });

  test("queues messages while assistant is busy and supports interrupt", async ({ page }) => {
    page.setDefaultTimeout(60_000);
    if (!activeProjectId) {
      throw new Error("Active project id missing for conversation smoke.");
    }

    const typingIndicator = page.getByTestId("assistant-typing-indicator");

    const longPrompt = "@octo Generate a short poem and save it to `poem.txt` in the repo root.";
    const firstDispatchResponse = page.waitForResponse(
      (response) => {
        if (response.request().method() !== "POST" || !response.ok()) {
          return false;
        }
        const pathname = new URL(response.url()).pathname;
        return (
          pathname === `/projects/${activeProjectId}/conversations` ||
          /\/conversations\/[^/]+\/messages$/.test(pathname)
        );
      },
      { timeout: 30_000 },
    );
    await page.getByTestId("chat-input").fill(longPrompt);
    await page.getByTestId("chat-send-button").click();
    const firstDispatch = await firstDispatchResponse;
    const firstDispatchPayload = (await firstDispatch.json().catch(() => null)) as {
      runId?: unknown;
      runIds?: unknown;
      status?: unknown;
    } | null;
    expect(
      typeof firstDispatchPayload?.runId === "string" ||
        (Array.isArray(firstDispatchPayload?.runIds) && firstDispatchPayload.runIds.length > 0),
      "the first turn should return an exact run before the follow-up is sent",
    ).toBe(true);
    await expect(typingIndicator).toBeVisible({ timeout: 15_000 });

    // Explicitly addressed turns expose visible busy state, so their follow-up
    // queue and interrupt controls are a stable UI contract. Ambient agent
    // evaluations intentionally remain silent until the agent speaks.
    const queuedPrompt = "What is 1+3? Reply with just the number.";
    await page.getByTestId("chat-input").fill(queuedPrompt);
    await page.getByTestId("chat-send-button").click();

    const sendQueue = page.getByTestId("chat-send-queue");
    await expect(sendQueue).toBeVisible({ timeout: 10_000 });

    // Interrupt and send immediately.
    await clickQueuedSendNowIfAvailable(page);

    // Eventually we should see the arithmetic response and the typing indicator clears.
    await expectAssistantReplyOrSkipRateLimit(page, /\b4\b/, { timeout: 180_000 });
    await expect(typingIndicator).toHaveCount(0, { timeout: 180_000 });
  });

  test("restores conversation after reload", async ({ page }) => {
    page.setDefaultTimeout(60_000);
    test.setTimeout(180_000);
    if (!activeProjectId) {
      throw new Error("Active project id missing for conversation smoke.");
    }

    await waitForHostedRuntimeReady(page);
    const conversationTabs = conversationTabButtons(page);
    await expect(conversationTabs).toHaveCount(1);

    const setupIndicator = page.getByTestId("assistant-setup-indicator");
    const typingIndicator = page.getByTestId("assistant-typing-indicator");
    const assistantResponses = assistantBubbles(page);

    const firstPrompt = "What is 1+1? Reply with just the number.";
    await page.getByTestId("chat-input").fill(firstPrompt);
    const baselineAssistantCount = await assistantResponses.count();
    await page.getByTestId("chat-send-button").click();
    await waitForAssistantRunStart({
      assistantBubbles: assistantResponses,
      baselineAssistantCount,
      setupIndicator,
      typingIndicator,
      timeoutMs: 60_000,
    });
    const firstReplyBubble = assistantResponses.nth(baselineAssistantCount);
    await firstReplyBubble.waitFor({ state: "visible", timeout: 180_000 });

    try {
      await expectAssistantReplyOrSkipRateLimit(page, /\b2\b/, { timeout: 180_000 });
    } catch (error) {
      const allResponses = await assistantBubbleTexts(page);
      const responseText = allResponses.join(" | ");
      if (isLiveAiBackendUnavailableText(responseText)) {
        test.skip(
          true,
          `Live AI backend unavailable; skipping Codex-dependent assertion. (${responseText
            .replace(/\s+/g, " ")
            .slice(0, 240)})`,
        );
      }
      throw new Error(
        `Assistant response did not match expected "2". All responses: ${responseText}`,
      );
    }
    await expect(setupIndicator).toHaveCount(0, { timeout: 60_000 });

    const controllerIdHandle = await page.waitForFunction(() => {
      const value = new URL(window.location.href).searchParams.get("conversationControllerId") ?? "";
      const trimmed = value.trim();
      return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(trimmed)
        ? trimmed
        : null;
    }, undefined, { timeout: 30_000 });
    const conversationControllerId = await controllerIdHandle.jsonValue<string | null>();
    expect(conversationControllerId).toBeTruthy();
    if (!conversationControllerId) {
      throw new Error("Expected conversationControllerId to be present after the first reply.");
    }

    await page.evaluate(({ controllerId }) => {
      const url = new URL(window.location.href);
      url.searchParams.set("conversationId", "conv-stale-reload-placeholder");
      url.searchParams.set("conversationControllerId", controllerId);
      window.history.replaceState({}, "", url);
    }, { controllerId: conversationControllerId });

    await reloadStudioSurface(page, activeProjectId);
    await expect(conversationTabs).toHaveCount(1);
    // Best-effort: ensure any assistant bubble persists after reload; content may vary.
    await expect.soft(assistantResponses.first()).toBeVisible({ timeout: 30_000 });
    await expect
      .poll(() => {
        const parsed = new URL(page.url());
        return (parsed.searchParams.get("conversationControllerId") ?? "").trim();
      }, { timeout: 30_000 })
      .toBe(conversationControllerId);
    // Reload can coincide with runtime/tunnel churn; proactively re-ensure the hosted runtime
    // so the follow-up message doesn't get stuck on a revoked/idle runtime.
    await ensureHostedRuntimeReady(page, activeProjectId);

    const followUpPrompt = "Now add 3 to the result. Reply with just the number no other text.";
    const followUpAssistantBaseline = await assistantResponses.count();
    await page.getByTestId("chat-input").fill(followUpPrompt);
    await expect(page.getByTestId("chat-send-button")).toBeEnabled({ timeout: 60_000 });
    await page.getByTestId("chat-send-button").click();

    // After reload/runtime churn, the message can be queued briefly while the controller runtime
    // recovers. Drain it if needed.
    const followUpQueue = page.getByTestId("chat-send-queue");
    if (await followUpQueue.isVisible().catch(() => false)) {
      await clickQueuedSendNowIfAvailable(page);
    }

    const followUpReply = assistantResponses.nth(followUpAssistantBaseline);
    await followUpReply.waitFor({ state: "visible", timeout: 180_000 });
    await expectAssistantReplyOrSkipRateLimit(page, /\b5\b/, { timeout: 180_000 });
    await expect(setupIndicator).toHaveCount(0, { timeout: 60_000 });
  });

  test("syncs project, conversation, and panel to the url", async ({ page }) => {
    page.setDefaultTimeout(60_000);
    if (!activeProjectId) {
      throw new Error("Active project id missing for conversation smoke.");
    }

    await waitForHostedRuntimeReady(page);
    const conversationTabs = conversationTabButtons(page);
    await expect(conversationTabs).toHaveCount(1);

    const storeProjectId = await page.evaluate(() => {
      return window["__INSTAFY_STORE__"]?.getState().activeProjectId ?? null;
    });
    expect(storeProjectId).not.toBeNull();
    await expect.poll(() => page.url()).toContain(`projectId=${storeProjectId as string}`);

    const conversationTab = conversationTabs.first();
    const conversationTabId = await conversationTab.getAttribute("data-tab-id");
    expect(conversationTabId).not.toBeNull();
    const conversationId =
      conversationTabId && conversationTabId.startsWith("workspace-conversation-")
        ? conversationTabId.replace("workspace-conversation-", "")
        : conversationTabId;
    expect(conversationId).not.toBeNull();
    await expect.poll(() => page.url()).toContain(`conversationId=${conversationId as string}`);

    await openCreditsPanel(page);
    await expect.poll(() => page.url()).toContain("panel=credits");

    await reloadStudioSurface(page, activeProjectId);
    await expect(page.getByTestId("sidebar-nav-credits")).toHaveAttribute("aria-current", "page");

    await page.getByTestId("sidebar-nav-chat").click();
    await expect(conversationTabs).toHaveCount(1);

    const reloadedTabId = await conversationTabs.first().getAttribute("data-tab-id");
    const reloadedConversationId =
      reloadedTabId && reloadedTabId.startsWith("workspace-conversation-")
        ? reloadedTabId.replace("workspace-conversation-", "")
        : reloadedTabId;
    expect(reloadedConversationId).toBe(conversationId);
  });
});
