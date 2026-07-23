import { expect, test } from "@playwright/test";
import { prepareStudio, resetRuntimeUserState } from "../utils/harness.js";

test.describe("Home panel", () => {
  test.beforeEach(async ({ page }) => {
    await prepareStudio(page, { waitForHostedRuntime: false });
  });

  test.afterEach(async ({ page }) => {
    await resetRuntimeUserState(page, { source: "home-panel:cleanup" }).catch(() => {});
  });

  test("opens the global home view and links into project surfaces", async ({ page }) => {
    await page.getByTestId("sidebar-home-button").click();

    await expect(page.getByTestId("home-panel")).toBeVisible();
    await expect(page.getByTestId("home-attention-section")).toBeVisible();
    await expect(page.getByTestId("home-recent-section")).toBeVisible();
    await expect(page.getByTestId("home-suggestions-section")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Suggestions" })).toBeVisible();
    await expect(page.getByText("Start something", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Continue fast or start something new.")).toHaveCount(0);
    await expect(page.getByText("Jump back into the latest chats across your spaces.")).toHaveCount(0);
    await expect(page.getByTestId("home-open-current-files")).toHaveCount(0);
    await expect(page.getByTestId("home-open-current-chat")).toHaveCount(0);
    await expect(page.getByTestId("home-refresh-button")).toHaveCount(0);

    const recentItems = page.locator('[data-testid^="home-recent-item-"]');
    await expect(recentItems.first()).toBeVisible();
    const recentGroupToggle = page.getByTestId("home-recent-group-toggle").first();
    await expect(recentGroupToggle).toBeVisible();
    await recentGroupToggle.click();
    await expect(recentItems.first()).toBeHidden();
    await recentGroupToggle.click();
    await expect(recentItems.first()).toBeVisible();
    await recentItems.first().click();
    await expect(page).toHaveURL(/conversation(?:Id|ControllerId)=/);
    await expect(page.getByTestId("chat-input")).toBeVisible();
    await page.getByTestId("sidebar-home-button").click();
    await expect(page.getByTestId("home-panel")).toBeVisible();

    await page.getByTestId("home-starter-analyze-company").click();
    await expect(page.getByTestId("chat-input")).toBeVisible();
    await expect(page.getByTestId("chat-input")).toContainText("Help me analyze a company");
  });
});
