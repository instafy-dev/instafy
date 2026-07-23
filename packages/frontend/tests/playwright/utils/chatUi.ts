import { expect, type Page } from "@playwright/test";

export async function createPublicChatFromTopBar(page: Page) {
  await page.getByTestId("chat-new-conversation").click();
  const popover = page.getByTestId("chat-new-chat-menu-popover");
  const menuOpened = await popover
    .waitFor({ state: "visible", timeout: 1_500 })
    .then(() => true)
    .catch(() => false);
  if (!menuOpened) {
    return;
  }
  await expect(popover).toBeVisible();
  await page.getByRole("button", { name: "Public chat" }).click();
}

export async function clickQueuedSendNowIfAvailable(page: Page): Promise<boolean> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const sendNowButtons = page.getByTestId("chat-send-queue-send-now");
    const sendNowCount = await sendNowButtons.count().catch(() => 0);
    if (sendNowCount > 0) {
      const sendNowButton = sendNowButtons.first();
      const enabled = await sendNowButton.isEnabled().catch(() => false);
      if (enabled) {
        await sendNowButton.click().catch(() => {});
        return true;
      }
    }

    const runtimeActionButtons = page.getByTestId("chat-send-queue-runtime-action");
    const runtimeActionCount = await runtimeActionButtons.count().catch(() => 0);
    if (runtimeActionCount > 0) {
      const runtimeActionButton = runtimeActionButtons.first();
      const enabled = await runtimeActionButton.isEnabled().catch(() => false);
      if (enabled) {
        await runtimeActionButton.click().catch(() => {});
        return true;
      }
    }

    await page.waitForTimeout(100);
  }
  return false;
}

export async function focusLastConversationTab(page: Page) {
  const conversationTabs = page
    .getByTestId("workspace-tabs")
    .locator('[data-tab-kind="conversation"]');
  const conversationTab = conversationTabs.last();
  const hasConversationTab = (await conversationTabs.count().catch(() => 0)) > 0;

  if (hasConversationTab) {
    await conversationTab.scrollIntoViewIfNeeded().catch(() => {});
    const clickedConversation = await conversationTab
      .click({ force: true })
      .then(() => true)
      .catch(() => false);
    if (clickedConversation) {
      await expect(page.getByTestId("chat-input")).toBeVisible({ timeout: 30_000 });
      return;
    }
  }

  await page.getByTestId("sidebar-nav-chat").click();
  await expect(page.getByTestId("chat-input")).toBeVisible({ timeout: 30_000 });
}
