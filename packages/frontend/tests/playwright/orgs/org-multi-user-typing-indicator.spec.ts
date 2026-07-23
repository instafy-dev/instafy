import { test, expect } from "@playwright/test";
import { loginAsGuest, prepareStudio, resetRuntimeUserState, waitForStoreProjectId } from "../utils/harness.js";
import { createPublicChatFromTopBar } from "../utils/chatUi.js";

async function openProjectSettings(page: import("@playwright/test").Page) {
  await page.getByTestId("sidebar-project-button").click();
  await page.getByTestId("sidebar-project-settings").click();
  await expect(page.getByTestId("settings-panel")).toBeVisible({ timeout: 30_000 });
  await page.getByTestId("settings-category-project-access").click();
  await expect(page.getByTestId("project-access-section")).toBeVisible();
}

function conversationTabLocator(page: import("@playwright/test").Page) {
  return page.getByTestId("workspace-tabs").locator('[data-tab-kind="conversation"]');
}

async function waitForConversationControllerId(page: import("@playwright/test").Page) {
  await page.waitForFunction(() => {
    const params = new URLSearchParams(window.location.search);
    const value = params.get("conversationControllerId") ?? "";
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.trim());
  });
}

test.describe("Org multi-user typing indicator", () => {
  test.setTimeout(180_000);

  test.afterEach(async ({ page }) => {
    await resetRuntimeUserState(page, { source: "org-multi-user-typing-indicator:cleanup" }).catch(() => {});
  });

  test("shows when another user is typing", async ({ page, browser }) => {
    page.setDefaultTimeout(60_000);

    const projectId = await prepareStudio(page, { waitForHostedRuntime: false });
    if (!projectId) {
      throw new Error("Project id missing for typing indicator test.");
    }

    await openProjectSettings(page);
    await page.getByTestId("org-invite-link-role").selectOption("builder");
    await page.getByTestId("org-invite-link-create").click();
    const inviteLinkUrl = await page.getByTestId("org-invite-link-url").inputValue();
    if (!inviteLinkUrl) {
      throw new Error("Invite link URL missing.");
    }

    await page.getByTestId("sidebar-nav-chat").click();

    const ownerConversationTabs = conversationTabLocator(page);
    await expect(ownerConversationTabs).toHaveCount(1);

    const guestContext = await browser.newContext();
    const guestPage = await guestContext.newPage();
    await loginAsGuest(guestPage);
    await guestPage.goto(inviteLinkUrl, { waitUntil: "domcontentloaded" });
    await guestPage.waitForURL((url) => url.pathname.includes("/studio"), { timeout: 60_000 });
    await waitForStoreProjectId(guestPage, projectId, 20_000);
    await guestPage.getByTestId("sidebar-nav-chat").click();

    const guestConversationTabs = conversationTabLocator(guestPage);
    await expect(guestConversationTabs).toHaveCount(1);

    const ownerCreateConversation = page.waitForResponse(
      (response) =>
        response.ok() &&
        response.request().method() === "POST" &&
        response.url().includes(`/projects/${projectId}/conversations/blank`)
    );
    await createPublicChatFromTopBar(page);
    await ownerCreateConversation;
    await expect(ownerConversationTabs).toHaveCount(2);
    await expect(guestConversationTabs).toHaveCount(2, { timeout: 30_000 });

    await ownerConversationTabs.nth(1).click();
    await waitForConversationControllerId(page);
    await guestConversationTabs.nth(1).click();
    await waitForConversationControllerId(guestPage);

    await guestPage.getByTestId("chat-input").fill("typing…");
    await guestPage.waitForTimeout(1400);
    await guestPage.getByTestId("chat-input").type("!", { delay: 25 });
    await expect(page.getByTestId("human-typing-indicator")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId("human-typing-indicator")).toContainText(/typing/i);

    await guestPage.getByTestId("chat-input").fill("");
    await expect(page.getByTestId("human-typing-indicator")).toHaveCount(0, { timeout: 15_000 });

    await guestContext.close();
  });
});
