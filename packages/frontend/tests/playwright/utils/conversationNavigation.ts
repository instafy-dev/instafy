import { expect, type Page } from "@playwright/test";

export async function activeConversationId(page: Page): Promise<string> {
  await expect.poll(() => new URL(page.url()).searchParams.get("conversationId")).toBeTruthy();
  return new URL(page.url()).searchParams.get("conversationId")!;
}

export async function openChats(page: Page) {
  if (await page.getByTestId("conversation-history-panel").isVisible()) return;
  const entry = page.getByTestId("sidebar-nav-history");
  if (!(await entry.isVisible())) {
    await page.getByTestId("mobile-header-picker")
      .or(page.getByTestId("topbar-sidebar-toggle")).filter({ visible: true }).first().click();
  }
  await entry.click();
  await expect(page.getByTestId("conversation-history-panel")).toBeVisible();
}

export function conversationRow(page: Page, conversationId: string) {
  return page.getByTestId("conversation-history-item").and(page.locator(`[data-conversation-id="${conversationId}"]`));
}

export async function selectConversation(page: Page, conversationId: string) {
  await openChats(page);
  await conversationRow(page, conversationId).click();
  await expect.poll(() => new URL(page.url()).searchParams.get("conversationId")).toBe(conversationId);
  await expect(page.getByTestId("chat-input")).toBeVisible();
}

/** Return from a panel or artifact to the selected chat without depending on tab order. */
export async function returnToConversation(page: Page) {
  if (await page.getByTestId("chat-input").isVisible()) return;
  const resume = page.getByTestId("home-resume-conversation");
  const returnButton = page.getByRole("button", { name: /^Return to / });
  if (await resume.isVisible()) await resume.click();
  else if (await returnButton.isVisible()) await returnButton.click();
  else await selectConversation(page, await activeConversationId(page));
  // A remembered artifact can be active after resuming the workspace.
  const chatView = page.getByTestId("conversation-workspace-views").getByRole("tab", { name: "Chat", exact: true });
  if (!(await page.getByTestId("chat-input").isVisible()) && await chatView.isVisible()) await chatView.click();
  await expect(page.getByTestId("chat-input")).toBeVisible();
}
