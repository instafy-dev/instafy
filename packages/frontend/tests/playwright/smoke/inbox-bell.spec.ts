import { test, expect, type Locator, type Page } from "@playwright/test";
import {
  clearNotificationInbox,
  clearRuntimePreference,
  ensureRealDefaultCodexCredentialWhenRequired,
  prepareStudio,
  resetRuntimeUserState,
} from "../utils/harness.js";
import { createPublicChatFromTopBar } from "../utils/chatUi.js";
import { ensureProjectCreditsReadyInUi } from "../utils/projectCredits.js";

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assistantBubbles(page: Page): Locator {
  return page.locator('[data-testid="chat-bubble-assistant"]');
}

async function waitForConversationControllerId(page: Page) {
  await page.waitForFunction(() => {
    const params = new URLSearchParams(window.location.search);
    const value = params.get("conversationControllerId") ?? "";
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.trim());
  });
  const conversationId = await page.evaluate(() => {
    const params = new URLSearchParams(window.location.search);
    return params.get("conversationControllerId") ?? "";
  });
  if (!conversationId || !UUID_REGEX.test(conversationId.trim())) {
    throw new Error("Conversation controller id missing in URL.");
  }
  return conversationId.trim();
}

async function waitForConversationControllerIdChange(page: Page, previousId: string) {
  const normalizedPrevious = previousId.trim();
  await page.waitForFunction(
    (previous) => {
      const params = new URLSearchParams(window.location.search);
      const value = (params.get("conversationControllerId") ?? "").trim();
      return (
        value.length > 0 &&
        value.toLowerCase() !== String(previous ?? "").trim().toLowerCase() &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
      );
    },
    normalizedPrevious,
  );
  const nextId = await waitForConversationControllerId(page);
  if (nextId.toLowerCase() === normalizedPrevious.toLowerCase()) {
    throw new Error("Expected conversationControllerId to change, but it stayed the same.");
  }
  return nextId;
}

async function waitForAssistantReply(page: Page, baselineAssistantCount: number, timeoutMs = 240_000) {
  const bubbles = assistantBubbles(page);
  const setupIndicator = page.getByTestId("assistant-setup-indicator");
  const typingIndicator = page.getByTestId("assistant-typing-indicator");

  await expect
    .poll(
      async () => {
        const [assistantCount, typingCount, setupCount] = await Promise.all([
          bubbles.count(),
          typingIndicator.count(),
          setupIndicator.count(),
        ]);

        if (assistantCount > baselineAssistantCount) return "assistant";
        if (typingCount > 0) return "typing";
        if (setupCount > 0) return "setup";
        return "none";
      },
      { timeout: Math.min(timeoutMs, 60_000) },
    )
    .not.toBe("none");

  await expect
    .poll(async () => await bubbles.count(), { timeout: timeoutMs })
    .toBeGreaterThan(baselineAssistantCount);
  await setupIndicator.waitFor({ state: "detached", timeout: timeoutMs }).catch(() => {});
  await typingIndicator.waitFor({ state: "detached", timeout: timeoutMs }).catch(() => {});
}

test.describe("Home attention", () => {
  test.skip(
    (process.env.PLAYWRIGHT_SKIP_CODEX ?? "").trim() === "1",
    "Codex backend unavailable. Provide Codex auth (OPENAI_API_KEY or tmp/proxy-codex/auth.json).",
  );
  test.setTimeout(360_000);

  test.afterEach(async ({ page }) => {
    await clearNotificationInbox(page).catch(() => {});
    await resetRuntimeUserState(page, { source: "home-attention:cleanup" }).catch(() => {});
  });

  test("shows the inbox count on Home and opens the surfaced conversation from Home", async ({ page }) => {
    page.setDefaultTimeout(60_000);

    const projectId = await prepareStudio(page);
    if (!projectId) {
      throw new Error("Project id missing for home attention test.");
    }
    // Guest sessions have no AI access in the BYOC stack; onboard the
    // canonical local Codex login so the AI-targeted send is actually enabled.
    await ensureRealDefaultCodexCredentialWhenRequired(page);
    await clearNotificationInbox(page);
    await clearRuntimePreference(page, { projectId, source: "home-attention" });
    await page.getByTestId("sidebar-nav-chat").click();
    await ensureProjectCreditsReadyInUi(page, projectId);
    await page.getByTestId("sidebar-nav-chat").click();

    const createConversationA = page.waitForResponse(
      (response) =>
        response.ok() &&
        response.request().method() === "POST" &&
        response.url().includes(`/projects/${projectId}/conversations/blank`),
    );
    await createPublicChatFromTopBar(page);
    await createConversationA;
    const conversationId1 = await waitForConversationControllerId(page);

    const bubbles = assistantBubbles(page);
    const baselineAssistantCount = await bubbles.count();
    const unique = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    await page
      .getByTestId("chat-input")
      .fill(`@octo What is 1+1? Reply only with ok ${unique}`);
    await page.getByTestId("chat-send-button").click();
    await waitForAssistantReply(page, baselineAssistantCount);

    const createConversationB = page.waitForResponse(
      (response) =>
        response.ok() &&
        response.request().method() === "POST" &&
        response.url().includes(`/projects/${projectId}/conversations/blank`),
    );
    await createPublicChatFromTopBar(page);
    await createConversationB;
    const conversationId2 = await waitForConversationControllerIdChange(page, conversationId1);

    await expect(page.getByTestId("sidebar-home-badge")).toHaveText("1");
    await page.getByTestId("sidebar-home-button").click();
    await expect(page.getByTestId("home-panel")).toBeVisible();

    const attentionItem = page.getByTestId(`home-attention-conversation-${conversationId1}`);
    await expect(attentionItem).toBeVisible({ timeout: 30_000 });
    await attentionItem.click();

    await page.waitForFunction(
      (expected) => {
        const params = new URLSearchParams(window.location.search);
        return (params.get("conversationControllerId") ?? "").trim().toLowerCase() === String(expected).toLowerCase();
      },
      conversationId1,
    );
    await expect(page.getByTestId("chat-bubble-user").last()).toContainText(unique);
    await expect(page.getByTestId("sidebar-home-badge")).toHaveCount(0);

    expect(conversationId2.toLowerCase()).not.toBe(conversationId1.toLowerCase());
  });

  test("does not badge Home for the conversation already visible in chat", async ({ page }) => {
    page.setDefaultTimeout(60_000);

    const projectId = await prepareStudio(page);
    if (!projectId) {
      throw new Error("Project id missing for active conversation test.");
    }
    // Guest sessions have no AI access in the BYOC stack; onboard the
    // canonical local Codex login so the AI-targeted send is actually enabled.
    await ensureRealDefaultCodexCredentialWhenRequired(page);
    await clearNotificationInbox(page);
    await clearRuntimePreference(page, { projectId, source: "home-attention:active-conversation" });
    await page.getByTestId("sidebar-nav-chat").click();
    await ensureProjectCreditsReadyInUi(page, projectId);
    await page.getByTestId("sidebar-nav-chat").click();

    const createConversation = page.waitForResponse(
      (response) =>
        response.ok() &&
        response.request().method() === "POST" &&
        response.url().includes(`/projects/${projectId}/conversations/blank`),
    );
    await createPublicChatFromTopBar(page);
    await createConversation;
    await waitForConversationControllerId(page);

    await expect(page.getByTestId("sidebar-home-badge")).toHaveCount(0);

    const bubbles = assistantBubbles(page);
    const baselineAssistantCount = await bubbles.count();
    const unique = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    await page
      .getByTestId("chat-input")
      .fill(`@octo What is 2+2? Reply only with ok ${unique}`);
    await page.getByTestId("chat-send-button").click();
    await waitForAssistantReply(page, baselineAssistantCount);

    await expect(page.getByTestId("chat-bubble-user").last()).toContainText(unique);
    await expect(page.getByTestId("sidebar-home-badge")).toHaveCount(0);
  });
});
