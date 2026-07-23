import { expect, test, type Locator, type Page } from "@playwright/test";
import { prepareStudio } from "../utils/harness.js";

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function getHighlightedSlashCommand(menu: Locator) {
  return (
    (await menu
      .locator('[data-testid="chat-slash-command-option"][data-highlighted="true"]')
      .first()
      .getAttribute("data-command")) ?? ""
  );
}

async function highlightSlashCommand(page: Page, menu: Locator, targetCommand: string) {
  const optionCount = await menu.getByTestId("chat-slash-command-option").count();
  for (let attempt = 0; attempt <= optionCount; attempt += 1) {
    if ((await getHighlightedSlashCommand(menu)) === targetCommand) {
      return;
    }
    await page.keyboard.press("ArrowDown");
  }
  throw new Error(`Unable to highlight slash command ${targetCommand}`);
}

test.describe("Chat slash-command typeahead", () => {
  test("accepts the highlighted slash command with Tab", async ({ page }) => {
    await prepareStudio(page, { waitForHostedRuntime: false });

    await page.getByTestId("sidebar-nav-chat").click();

    const chatInput = page.getByTestId("chat-input");
    await chatInput.click();
    await chatInput.type("/");

    const menu = page.getByTestId("chat-slash-command-menu");
    await expect(menu).toBeVisible();
    const highlightedCommand = "/invite";
    await highlightSlashCommand(page, menu, highlightedCommand);
    expect(highlightedCommand).toMatch(/^\/[a-z]/i);
    await page.keyboard.press("Tab");
    await expect(menu).toHaveCount(0);
    await page.waitForTimeout(250);
    await expect(menu).toHaveCount(0);
    await expect
      .poll(async () => (await chatInput.textContent())?.trimStart() ?? "")
      .toMatch(new RegExp(`^${escapeRegExp(highlightedCommand)}(?:\\s|$)`));
  });

  test("shows slash commands and inserts the selected command", async ({ page }) => {
    await prepareStudio(page, { waitForHostedRuntime: false });

    await page.getByTestId("sidebar-nav-chat").click();

    const chatInput = page.getByTestId("chat-input");
    await chatInput.click();
    await chatInput.type("/");

    const menu = page.getByTestId("chat-slash-command-menu");
    await expect(menu).toBeVisible();
    await expect(menu.getByTestId("chat-slash-command-option")).toContainText([
      "/invite",
      "/learn",
      "/terminal",
    ]);
    await expect(menu.getByTestId("chat-slash-command-option").filter({ hasText: "/learn collect" })).toHaveCount(0);

    await menu.getByTestId("chat-slash-command-option").filter({ hasText: "/learn" }).first().click();
    await expect(chatInput).toContainText("/learn ");

    await chatInput.click();
    await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
    await page.keyboard.press("Backspace");
    await expect(chatInput).toHaveText("");

    await chatInput.type("/te");
    await expect(menu).toBeVisible();
    await expect(menu.getByTestId("chat-slash-command-option")).toContainText([
      "/invite",
      "/terminal",
    ]);
    await menu.getByTestId("chat-slash-command-option").filter({ hasText: "/terminal" }).first().click();
    await expect(chatInput).toContainText("/terminal ");
  });

  test("composer action menu inserts commands with the caret at the end", async ({ page }) => {
    await prepareStudio(page, { waitForHostedRuntime: false });

    await page.getByTestId("sidebar-nav-chat").click();

    const chatInput = page.getByTestId("chat-input");
    await page.getByTestId("composer-action-menu-trigger").click();
    await page.getByTestId("composer-action-menu-commands").click();
    await page.getByTestId("composer-action-menu-command-invite").click();

    await expect(chatInput).toContainText("/invite ");
    await page.keyboard.type("teammate@instafy.dev");
    await expect(chatInput).toContainText("/invite teammate@instafy.dev");
  });

  test("submitting /invite keeps the composer responsive", async ({ page }) => {
    await prepareStudio(page, { waitForHostedRuntime: false });

    await page.getByTestId("sidebar-nav-chat").click();

    const chatInput = page.getByTestId("chat-input");
    const inviteEmail = `invite-${Date.now()}@instafy.dev`;
    const recordedMessages: string[] = [];

    page.on("requestfinished", (request) => {
      if (
        request.method() !== "POST" ||
        !/\/conversations\/[^/]+\/messages\/record$/.test(request.url())
      ) {
        return;
      }
      try {
        const body = request.postDataJSON() as { content?: unknown } | null;
        if (typeof body?.content === "string") {
          recordedMessages.push(body.content);
        }
      } catch {
        // Ignore malformed/non-JSON request bodies.
      }
    });

    await chatInput.click();
    await chatInput.type(`/invite ${inviteEmail}`);

    const inviteResponsePromise = page.waitForResponse((response) => {
      return response.request().method() === "POST" && /\/orgs\/[^/]+\/invitations$/.test(response.url());
    });

    await page.keyboard.press("Enter");

    const inviteResponse = await inviteResponsePromise;
    expect(inviteResponse.status()).toBeGreaterThanOrEqual(200);
    expect(inviteResponse.status()).toBeLessThan(500);
    await expect
      .poll(() => recordedMessages.length, {
        message: "expected /invite to record both the user command and assistant result",
      })
      .toBeGreaterThanOrEqual(2);
    expect(recordedMessages).toContain(`/invite ${inviteEmail}`);
    expect(
      recordedMessages.some((content) =>
        content.includes(`Prepared an invite for ${inviteEmail}`),
      ),
    ).toBe(true);

    const inviteModal = page.getByTestId("chat-invite-modal");
    await expect(inviteModal).toBeVisible();
    await inviteModal.getByRole("button", { name: "Close invite modal" }).click();
    await expect(inviteModal).toBeHidden();

    await chatInput.click();
    await page.keyboard.type("hello");
    await expect(chatInput).toContainText("hello");
  });

  test("accepts the highlighted assistant mention with Tab", async ({ page }) => {
    await prepareStudio(page, { waitForHostedRuntime: false });

    await page.getByTestId("sidebar-nav-chat").click();

    const chatInput = page.getByTestId("chat-input");
    await chatInput.click();
    await chatInput.type("@");

    const menu = page.getByTestId("assistant-mention-menu");
    await expect(menu).toBeVisible();
    const highlightedToken =
      (await menu
        .locator('[data-testid="assistant-mention-option"][data-highlighted="true"]')
        .first()
        .getAttribute("data-token")) ?? "";
    expect(highlightedToken).toMatch(/^@[a-z0-9]/i);
    await page.keyboard.press("Tab");
    await expect(menu).toHaveCount(0);
    await page.waitForTimeout(250);
    await expect(menu).toHaveCount(0);
    await expect
      .poll(async () => (await chatInput.textContent())?.trimStart() ?? "")
      .toMatch(new RegExp(`^${escapeRegExp(highlightedToken)}(?:\\s|$)`));
  });
});
