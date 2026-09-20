import { test, expect } from "@playwright/test";
import { openTeamDirectory } from "../utils/sidebar.js";
import {
  clearRuntimePreference,
  deleteDisposableTestUser,
  ensureRealDefaultCodexCredentialWhenRequired,
  expectAssistantReplyOrSkipRateLimit,
  loginAsGuest,
  prepareStudio,
  requestHostedRuntime,
  purgeRealUserCredential,
  resetRuntimeUserState,
  waitForHostedRuntimeReady,
  waitForStoreProjectId,
} from "../utils/harness.js";
import { createPublicChatFromTopBar } from "../utils/chatUi.js";
import { ensureProjectCreditsReadyForChat } from "../utils/projectCredits.js";
import { chooseOption } from "../utils/select.js";

// The secondary user receives the machine's real Codex credential. Keep all
// credential/session material out of Playwright trace archives.
test.use({ trace: "off" });

async function openProjectSettings(page: import("@playwright/test").Page) {
  await openTeamDirectory(page);
  await page.getByTestId("sidebar-project-settings").click();
  await expect(page.getByTestId("settings-panel")).toBeVisible();
  await page.getByTestId("settings-category-project-access").click();
  await expect(page.getByTestId("project-access-section")).toBeVisible();
}

async function ensureHostedRuntimeReady(page: import("@playwright/test").Page, projectId: string) {
  const ready = await waitForHostedRuntimeReady(page, 10_000, { projectId })
    .then(() => true)
    .catch(() => false);
  if (!ready) {
    await requestHostedRuntime(page, { projectId }).catch(() => {});
  }
  await waitForHostedRuntimeReady(page, 120_000, { projectId });
}

function conversationTabLocator(page: import("@playwright/test").Page) {
  return page
    .getByTestId("workspace-tabs")
    .locator('[data-tab-kind="conversation"]')
    .filter({ hasText: /^Conversation\s+\d+/ });
}

async function waitForConversationControllerId(page: import("@playwright/test").Page) {
  await page.waitForFunction(() => {
    const params = new URLSearchParams(window.location.search);
    const value = params.get("conversationControllerId") ?? "";
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.trim());
  });
}

async function waitForAssistantReply(
  page: import("@playwright/test").Page,
  options: {
    projectId: string;
    expectedText: RegExp;
    initialTimeoutMs?: number;
    recoveryTimeoutMs?: number;
  }
) {
  const initialTimeoutMs = options.initialTimeoutMs ?? 120_000;
  const recoveryTimeoutMs = options.recoveryTimeoutMs ?? 120_000;

  try {
    await expectAssistantReplyOrSkipRateLimit(page, options.expectedText, { timeout: initialTimeoutMs });
    return;
  } catch {
    // If the UI got stuck (SSE disconnect, runtime restart), try re-ensuring and reloading.
  }

  await requestHostedRuntime(page, { projectId: options.projectId, source: "chat" }).catch(() => {});
  const url = page.url();
  await page.reload({ waitUntil: "domcontentloaded" }).catch(async () => {
    await page.goto(url, { waitUntil: "domcontentloaded" }).catch(() => {});
  });
  await page.waitForURL((next) => next.pathname.includes("/studio"), { timeout: 60_000 }).catch(() => {});
  await waitForStoreProjectId(page, options.projectId, 20_000).catch(() => {});
  await page.getByTestId("sidebar-nav-chat").click().catch(() => {});

  await expectAssistantReplyOrSkipRateLimit(page, options.expectedText, { timeout: recoveryTimeoutMs });
}

test.describe("Org invite link conversation tabs + AI", () => {
  test.skip(
    (process.env.PLAYWRIGHT_SKIP_CODEX ?? "").trim() === "1",
    "Codex backend unavailable (rate limited). Provide Codex auth (OPENAI_API_KEY or tmp/proxy-codex/auth.json)."
  );
  test.setTimeout(360_000);

  test.afterEach(async ({ page }) => {
    await resetRuntimeUserState(page, { source: "org-invite-link-conversation-tabs-ai:cleanup" }).catch(() => {});
  });

  test("guest joins via invite link and sees new conversation tabs + assistant reply", async ({ page, browser }) => {
    page.setDefaultTimeout(60_000);

    const projectId = await prepareStudio(page);
    if (!projectId) {
      throw new Error("Project id missing for invite link conversation tab test.");
    }
    await ensureRealDefaultCodexCredentialWhenRequired(page);

    await clearRuntimePreference(page, { projectId, source: "org-invite-link-conversation-tabs-ai" });
    await ensureHostedRuntimeReady(page, projectId);

    await openProjectSettings(page);
    await chooseOption(page.getByTestId("org-invite-link-role"), "builder");
    await page.getByTestId("org-invite-link-create").click();
    const inviteLinkUrl = await page.getByTestId("org-invite-link-url").inputValue();
    if (!inviteLinkUrl) {
      throw new Error("Invite link URL missing.");
    }

    await page.getByTestId("sidebar-nav-chat").click();

    const guestContext = await browser.newContext();
    const guestPage = await guestContext.newPage();
    let guestCredentialId: string | null = null;
    let guestDisposableUserId: string | null = null;
    let guestFlowError: unknown = null;
    let credentialCleanupFailed = false;
    try {
      const guestLogin = await loginAsGuest(guestPage);
      guestDisposableUserId = guestLogin.disposableUserId;
      const guestCredential = await ensureRealDefaultCodexCredentialWhenRequired(guestPage);
      guestCredentialId = guestCredential?.created
        ? guestCredential.credentialId
        : null;
      await guestPage.goto(inviteLinkUrl, { waitUntil: "domcontentloaded" });
      await guestPage.waitForURL((url) => url.pathname.includes("/studio"), { timeout: 60_000 });
      await waitForStoreProjectId(guestPage, projectId, 20_000);
      await guestPage.getByTestId("sidebar-nav-chat").click();
      await ensureHostedRuntimeReady(guestPage, projectId);
      await ensureProjectCreditsReadyForChat(guestPage, projectId);

      const ownerConversationTabs = conversationTabLocator(page);
      const guestConversationTabs = conversationTabLocator(guestPage);
      await expect(ownerConversationTabs).toHaveCount(1);
      await expect(guestConversationTabs).toHaveCount(1);

      const ownerCreateConversation = page.waitForResponse(
        (response) =>
          response.ok() &&
          response.request().method() === "POST" &&
          response.url().includes(`/projects/${projectId}/conversations/blank`)
      );
      const statusToast = page.getByTestId("status-toast");
      await statusToast.getByLabel("Dismiss notification").click({ timeout: 1000 }).catch(() => {});
      await statusToast.waitFor({ state: "hidden", timeout: 10_000 }).catch(() => {});
      await createPublicChatFromTopBar(page);
      await ownerCreateConversation;
      await waitForConversationControllerId(page);

      await expect(ownerConversationTabs).toHaveCount(2);
      await expect(guestConversationTabs).toHaveCount(2, { timeout: 30_000 });

      await expect(ownerConversationTabs.nth(1)).toContainText("Conversation 2");
      await expect(guestConversationTabs.nth(1)).toContainText("Conversation 2");

      await ownerConversationTabs.nth(1).click();
      await guestConversationTabs.nth(1).click();
      await waitForConversationControllerId(guestPage);

      await guestPage.getByTestId("chat-input").fill("Typing…");
      await guestPage.waitForTimeout(1400);
      await guestPage.getByTestId("chat-input").type("!", { delay: 25 });
      await expect(page.getByTestId("human-typing-indicator")).toBeVisible({ timeout: 20_000 });

      const prompt = "Hello! What is 1+1? Reply with just the number.";
      await guestPage.getByTestId("chat-input").fill(prompt);
      await guestPage.getByTestId("chat-send-button").click();

      await expect(guestPage.getByTestId("assistant-setup-indicator"))
        .toHaveCount(0, { timeout: 120_000 })
        .catch(() => {});
      await waitForAssistantReply(guestPage, { projectId, expectedText: /\b2\b/ });

      await expect(page.locator('[data-testid="chat-bubble-user"]').filter({ hasText: prompt }).first()).toBeVisible({
        timeout: 60_000,
      });
      await expectAssistantReplyOrSkipRateLimit(page, /\b2\b/, { timeout: 120_000 });
    } catch (error) {
      guestFlowError = error;
    } finally {
      if (guestCredentialId) {
        try {
          await purgeRealUserCredential(guestPage, guestCredentialId);
        } catch {
          credentialCleanupFailed = true;
        }
      }
      await guestContext.close().catch(() => {
        credentialCleanupFailed = true;
      });
      if (guestDisposableUserId) {
        try {
          await deleteDisposableTestUser(guestDisposableUserId);
        } catch {
          credentialCleanupFailed = true;
        }
      }
    }
    if (guestFlowError) {
      if (credentialCleanupFailed) {
        throw new AggregateError(
          [guestFlowError, new Error("Disposable invite-guest credential cleanup failed.")],
          "Invite-guest flow and credential cleanup both failed."
        );
      }
      throw guestFlowError;
    }
    if (credentialCleanupFailed) {
      throw new Error("Disposable invite-guest credential cleanup failed.");
    }
  });
});
