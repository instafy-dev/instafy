import { test, expect } from "@playwright/test";
import { prepareStudio, resetRuntimeUserState } from "../utils/harness.js";
import { createPublicChatFromTopBar } from "../utils/chatUi.js";
import { activeConversationId, openChats, selectConversation } from "../utils/conversationNavigation.js";

test.describe("Conversation history", () => {
  test.afterEach(async ({ page }) => {
    await resetRuntimeUserState(page, { source: "conversation-history:cleanup" }).catch(() => {});
  });

  test("chat row menu deletes a conversation and its threads into Trash", async ({ page }) => {
    page.setDefaultTimeout(60_000);
    await prepareStudio(page, { waitForHostedRuntime: false });
    await createPublicChatFromTopBar(page);
    const parent = await activeConversationId(page);
    await openChats(page);
    await page.getByTestId(`conversation-history-menu-${parent}`).click();
    await page.getByTestId("conversation-history-menu-new-thread").click();
    await expect(page.getByTestId("conversation-workspace-title")).toHaveText("Thread 1");
    const thread = await activeConversationId(page);
    expect(thread).not.toBe(parent);

    await page.getByTestId(`conversation-history-menu-${parent}`).click();
    page.once("dialog", dialog => dialog.accept());
    await page.getByRole("menuitem", { name: "Delete…", exact: true }).click();
    await expect(page.getByTestId("conversation-history-item").filter({ hasText: "Conversation 2" })).toHaveCount(0);
    await expect(page.getByTestId("conversation-history-item").filter({ hasText: "Thread 1" })).toHaveCount(0);
    await page.getByTestId("conversation-history-filter").click();
    await page.getByRole("menuitemradio", { name: /Trash/ }).click();
    await expect(page.getByTestId("conversation-history-item").filter({ hasText: "Conversation 2" })).toBeVisible();
    const expand = page.getByTestId("conversation-history-toggle");
    if (await expand.getAttribute("aria-expanded") === "false") await expand.click();
    await expect(page.getByTestId("conversation-history-item").filter({ hasText: "Thread 1" })).toBeVisible();
  });

  test("reopens chats and nested threads from the explorer", async ({ page }) => {
    page.setDefaultTimeout(60_000);
    await prepareStudio(page, { waitForHostedRuntime: false });
    const first = await activeConversationId(page);
    await createPublicChatFromTopBar(page);
    const parent = await activeConversationId(page);
    await openChats(page);
    await page.getByTestId(`conversation-history-menu-${parent}`).click();
    await page.getByTestId("conversation-history-menu-new-thread").click();
    await expect(page.getByTestId("conversation-workspace-title")).toHaveText("Thread 1");
    const thread = await activeConversationId(page);
    await selectConversation(page, first);
    const expand = page.getByTestId("conversation-history-toggle");
    if (await expand.getAttribute("aria-expanded") === "false") await expand.click();
    await selectConversation(page, thread);
    await expect(page.getByTestId("conversation-workspace-title")).toHaveText("Thread 1");
    await selectConversation(page, parent);
    await expect(page.getByTestId("conversation-workspace-title")).toHaveText("Conversation 2");
    await expect(page.getByTestId("workspace-tabs")).toHaveCount(0);
  });
});
