import { test, expect } from "@playwright/test";
import {
  loginAsGuest,
  prepareStudio,
  resetRuntimeUserState,
  waitForStoreProjectId,
} from "../utils/harness.js";
import { createPublicChatFromTopBar } from "../utils/chatUi.js";
import { chooseOption } from "../utils/select.js";

async function openProjectSettings(page: import("@playwright/test").Page) {
  await page.getByTestId("sidebar-project-button").click();
  await page.getByTestId("sidebar-project-settings").click();
  await expect(page.getByTestId("settings-panel")).toBeVisible();
  await page.getByTestId("settings-category-project-access").click();
  await expect(page.getByTestId("project-access-section")).toBeVisible();
}

function conversationTabLocator(page: import("@playwright/test").Page) {
  return page
    .getByTestId("workspace-tabs")
    .locator('[data-tab-kind="conversation"]');
}

async function waitForConversationControllerId(page: import("@playwright/test").Page) {
  await page.waitForFunction(() => {
    const params = new URLSearchParams(window.location.search);
    const value = params.get("conversationControllerId") ?? "";
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      value.trim(),
    );
  });
}

test.describe("Org multi-user conversation rename", () => {
  test.setTimeout(180_000);

  test.afterEach(async ({ page }) => {
    await resetRuntimeUserState(page, {
      source: "org-multi-user-conversation-rename:cleanup",
    }).catch(() => {});
  });

  test("renaming a conversation syncs across sessions", async ({ page, browser }) => {
    page.setDefaultTimeout(60_000);

    const projectId = await prepareStudio(page, { waitForHostedRuntime: false });
    if (!projectId) {
      throw new Error("Project id missing for multi-user conversation rename test.");
    }

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
    await loginAsGuest(guestPage);
    await guestPage.goto(inviteLinkUrl, { waitUntil: "domcontentloaded" });
    await guestPage.waitForURL((url) => url.pathname.includes("/studio"), {
      timeout: 60_000,
    });
    await waitForStoreProjectId(guestPage, projectId, 20_000);
    await guestPage.getByTestId("sidebar-nav-chat").click();

    const ownerConversationTabs = conversationTabLocator(page);
    const guestConversationTabs = conversationTabLocator(guestPage);
    await expect(ownerConversationTabs).toHaveCount(1);
    await expect(guestConversationTabs).toHaveCount(1);

    const ownerCreateConversation = page.waitForResponse((response) => {
      return (
        response.ok() &&
        response.request().method() === "POST" &&
        response.url().includes(`/projects/${projectId}/conversations/blank`)
      );
    });
    await createPublicChatFromTopBar(page);
    await ownerCreateConversation;
    await expect(ownerConversationTabs).toHaveCount(2);
    await expect(guestConversationTabs).toHaveCount(2, { timeout: 30_000 });
    await ownerConversationTabs.last().click();
    await waitForConversationControllerId(page);

    const newTitle = `Teammate sync ${Date.now()}`;
    const renameResponse = page.waitForResponse((response) => {
      return (
        response.ok() &&
        response.request().method() === "PATCH" &&
        response.url().includes("/conversations/")
      );
    });
    await ownerConversationTabs.last().click({ button: "right" });
    await page.getByTestId("conversation-tab-menu-rename").click();
    await page.getByTestId("conversation-tab-rename-input").fill(newTitle);
    await page.getByTestId("conversation-tab-rename-input").press("Enter");
    await renameResponse;

    await expect(ownerConversationTabs.filter({ hasText: newTitle })).toHaveCount(1);
    await expect(guestConversationTabs.filter({ hasText: newTitle })).toHaveCount(1, {
      timeout: 30_000,
    });

    const guestRenamedTab = guestConversationTabs.filter({ hasText: newTitle }).first();
    await guestRenamedTab.click();
    await expect(guestRenamedTab).toHaveAttribute("aria-current", "page");

    await guestContext.close();
  });
});
