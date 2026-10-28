import { test, expect } from "@playwright/test";
import { prepareStudio, resetRuntimeUserState } from "../utils/harness.js";
import { activeConversationId, openChats, selectConversation } from "../utils/conversationNavigation.js";
import { createPublicChatFromTopBar } from "../utils/chatUi.js";

test.describe("Mobile conversation navigation", () => {
  test.afterEach(async ({ page }) => {
    await resetRuntimeUserState(page, { source: "mobile-tabs:cleanup" }).catch(() => {});
  });

  test("switches through Chats below the desktop breakpoint", async ({ page }) => {
    test.setTimeout(120_000);
    page.setDefaultTimeout(60_000);
    await page.setViewportSize({ width: 390, height: 844 });
    await prepareStudio(page, { waitForHostedRuntime: false });
    const first = await activeConversationId(page);
    // Every untitled chat reads "New chat"; which chat is open is its id.
    await expect(page.getByTestId("mobile-header-title")).toContainText("New chat");
    await openChats(page);
    await createPublicChatFromTopBar(page);
    await expect(page.getByTestId("mobile-header-title")).toContainText("New chat");
    expect(await activeConversationId(page)).not.toBe(first);
    await selectConversation(page, first);
    expect(await activeConversationId(page)).toBe(first);
    await expect(page.getByTestId("mobile-header-title")).toContainText("New chat");
    await expect(page.getByTestId("conversation-history-panel")).toHaveCount(0);
    await expect(page.getByTestId("workspace-tabs")).toHaveCount(0);
    await expect(page.getByTestId("topbar-tab-selector")).toHaveCount(0);
  });
});
