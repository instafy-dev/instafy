import { test, expect } from "@playwright/test";
import { prepareStudio, resetRuntimeUserState } from "../utils/harness.js";

test.describe("Mobile workspace tabs", () => {
  test.afterEach(async ({ page }) => {
    await resetRuntimeUserState(page, { source: "mobile-tabs:cleanup" }).catch(() => {});
  });

  test("uses a topbar tab selector below lg", async ({ page }) => {
    test.setTimeout(120_000);
    page.setDefaultTimeout(60_000);
    await page.setViewportSize({ width: 390, height: 844 });

    await prepareStudio(page, { waitForHostedRuntime: false });

    await expect(page.getByTestId("workspace-tabs")).toHaveCount(0);

    const tabSelector = page.getByTestId("topbar-tab-selector");
    await expect(tabSelector).toBeVisible();
    await expect(tabSelector).toContainText("Conversation 1");

    await page.getByTestId("status-toast").waitFor({ state: "detached", timeout: 15_000 }).catch(() => {});

    await page.getByTestId("topbar-new-conversation").click();
    const newChatMenu = page.getByTestId("chat-new-chat-menu-popover");
    await expect(newChatMenu).toBeVisible();
    await newChatMenu.getByRole("button", { name: "Public chat" }).click();
    await expect(tabSelector).toContainText("Conversation 2");

    await tabSelector.click();
    const tabMenu = page.getByTestId("topbar-tab-selector-menu");
    await expect(tabMenu).toBeVisible();
    await expect(tabMenu).not.toContainText("Tabs");
    await expect(tabMenu).toContainText("Conversation 1");
    await expect(tabMenu).toContainText("Conversation 2");

    await tabMenu
      .locator('[data-testid^="topbar-tab-item-"]')
      .filter({ hasText: "Conversation 1" })
      .first()
      .click();
    await expect(tabSelector).toContainText("Conversation 1");
  });
});
