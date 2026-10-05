import { expect, type Page } from "@playwright/test";
import { returnToConversation } from "./conversationNavigation.js";

export async function createPublicChatFromTopBar(page: Page) {
  const previous = new URL(page.url()).searchParams.get("conversationId");
  await page.getByTestId("topbar-new-conversation")
    .or(page.getByTestId("sidebar-new-chat"))
    .or(page.getByTestId("conversation-history-new-chat"))
    .filter({ visible: true }).first().click();
  const popover = page.getByTestId("chat-new-chat-menu-popover");
  const menuOpened = await popover
    .waitFor({ state: "visible", timeout: 1_500 })
    .then(() => true)
    .catch(() => false);
  if (menuOpened) {
    await page.getByRole("button", { name: "Public chat" }).click();
  }
  await expect.poll(() => {
    const current = new URL(page.url()).searchParams.get("conversationId");
    return Boolean(current && current !== previous);
  }).toBe(true);
  await expect(page.getByTestId("chat-input")).toBeVisible();
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
  await returnToConversation(page);
}
