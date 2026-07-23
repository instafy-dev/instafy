import { test, expect, type Page } from "@playwright/test";
import { prepareStudio, resetRuntimeUserState } from "../utils/harness.js";
import { createPublicChatFromTopBar } from "../utils/chatUi.js";

function conversationTabButtons(page: Page) {
  return page.locator('[data-testid="workspace-tabs"] [data-tab-kind="conversation"]');
}

test.describe("Conversation history", () => {
  test.afterEach(async ({ page }) => {
    await resetRuntimeUserState(page, { source: "conversation-history:cleanup" }).catch(() => {});
  });

  test("tab context menu delete moves conversations to Trash", async ({ page }) => {
    page.setDefaultTimeout(60_000);

    const projectId = await prepareStudio(page, { waitForHostedRuntime: false });
    if (!projectId) {
      throw new Error("Project id missing for conversation history delete test.");
    }

    await page.getByTestId("sidebar-nav-chat").click();

    const conversationTabs = conversationTabButtons(page);
    await expect(conversationTabs).toHaveCount(1);

    await createPublicChatFromTopBar(page);
    await expect(conversationTabs).toHaveCount(2);
    const conversationTwoTab = conversationTabs.filter({ hasText: "Conversation 2" }).first();

    await conversationTwoTab.click({ button: "right" });
    await expect(page.getByTestId("conversation-tab-menu")).toBeVisible();
    await page.getByTestId("conversation-tab-menu-new-thread").click();
    await expect(conversationTabs).toHaveCount(3);
    await expect(conversationTabs.last()).toContainText("Thread 1");

    await conversationTwoTab.click({ button: "right" });
    await expect(page.getByTestId("conversation-tab-menu-delete")).toContainText("Delete…");
    page.once("dialog", (dialog) => dialog.accept().catch(() => {}));
    await page.getByTestId("conversation-tab-menu-delete").click();

    await expect(conversationTabs).toHaveCount(1);
    await expect(conversationTabs.filter({ hasText: "Conversation 2" })).toHaveCount(0);
    await expect(conversationTabs.filter({ hasText: "Thread 1" })).toHaveCount(0);

    await page.getByTestId("sidebar-nav-history").click();
    await expect(page.getByTestId("conversation-history-panel")).toBeVisible();
    await page.getByTestId("conversation-history-filter").click();
    await expect(page.getByRole("menuitemradio", { name: /Trash/ })).toBeVisible();
    await page.getByText("Chats", { exact: true }).click();
    await expect(page.getByRole("menuitemradio", { name: /Trash/ })).toHaveCount(0);
    await page.getByTestId("conversation-history-filter").click();
    await page.getByRole("menuitemradio", { name: /Trash/ }).click();

    await expect(
      page.getByTestId("conversation-history-item").filter({ hasText: "Conversation 2" }).first(),
    ).toBeVisible();
    await page.getByTestId("conversation-history-toggle").click();
    await expect(
      page.getByTestId("conversation-history-item").filter({ hasText: "Thread 1" }).first(),
    ).toBeVisible();
  });

  test("reopens closed conversation tabs from history", async ({ page }) => {
    page.setDefaultTimeout(60_000);

    const projectId = await prepareStudio(page, { waitForHostedRuntime: false });
    if (!projectId) {
      throw new Error("Project id missing for conversation history test.");
    }

    await page.getByTestId("sidebar-nav-chat").click();

    const conversationTabs = conversationTabButtons(page);
    await expect(conversationTabs).toHaveCount(1);

    await createPublicChatFromTopBar(page);
    await expect(conversationTabs).toHaveCount(2);
    await expect(conversationTabs.last()).toContainText("Conversation 2");

    await conversationTabs.filter({ hasText: "Conversation 2" }).first().click({ button: "right" });
    await expect(page.getByTestId("conversation-tab-menu")).toBeVisible();
    await page.getByTestId("conversation-tab-menu-new-thread").click();
    await expect(conversationTabs).toHaveCount(3);
    await expect(conversationTabs.last()).toContainText("Thread 1");

    await page
      .getByTestId("workspace-tabs")
      .locator('[aria-label="Close Thread 1"]')
      .click();
    await expect(conversationTabs).toHaveCount(2);

    await conversationTabs
      .filter({ hasText: "Conversation 2" })
      .first()
      .locator("xpath=..")
      .locator('[aria-label="Close Conversation 2"]')
      .click();
    await expect(conversationTabs).toHaveCount(1);

    await page.getByTestId("sidebar-nav-history").click();
    await expect(page.getByTestId("conversation-history-panel")).toBeVisible();
    await expect(page.getByTestId("workspace-tabs").locator('[data-tab-kind="history"]')).toHaveCount(0);

    await conversationTabs
      .filter({ hasText: "Conversation 1" })
      .first()
      .locator("xpath=..")
      .locator('[aria-label="Close Conversation 1"]')
      .click();
    await expect(conversationTabs).toHaveCount(0);
    await expect(page.getByTestId("conversation-history-panel")).toBeVisible();

    await page.getByTestId("conversation-history-toggle").click();
    await expect(
      page
        .getByTestId("conversation-history-item")
        .filter({ hasText: "Thread 1" })
        .first()
    ).toBeVisible();

    await page
      .getByTestId("conversation-history-item")
      .filter({ hasText: "Thread 1" })
      .first()
      .click();

    await expect(conversationTabs).toHaveCount(1);
    const reopenedThreadTab = conversationTabs.filter({ hasText: "Thread 1" }).first();
    await expect(reopenedThreadTab).toHaveAttribute("aria-current", "page");

    await page
      .getByTestId("workspace-tabs")
      .locator('[aria-label="Close Thread 1"]')
      .click();
    await expect(conversationTabs).toHaveCount(0);

    await page
      .getByTestId("conversation-history-item")
      .filter({ hasText: "Conversation 2" })
      .first()
      .click();

    await expect(conversationTabs).toHaveCount(1);
    const reopenedTab = conversationTabs.filter({ hasText: "Conversation 2" }).first();
    await expect(reopenedTab).toHaveAttribute("aria-current", "page");
  });
});
