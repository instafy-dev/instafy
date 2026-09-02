import { expect, test } from "@playwright/test";
import { prepareStudio, resetRuntimeUserState } from "../utils/harness.js";

test.describe("Home panel", () => {
  test.beforeEach(async ({ page }) => {
    await prepareStudio(page, { waitForHostedRuntime: false });
  });

  test.afterEach(async ({ page }) => {
    await resetRuntimeUserState(page, { source: "home-panel:cleanup" }).catch(() => {});
  });

  test("opens the cross-team feed and links into conversations", async ({ page }) => {
    await page.getByTestId("sidebar-home-button").click();

    await expect(page.getByTestId("home-panel")).toBeVisible();
    // A feed: the Activity lane, no zero-count "Needs you" placeholder, and no
    // starter prompts (suggestions live on an empty chat).
    await expect(page.getByTestId("home-recent-section")).toBeVisible();
    await expect(page.getByText("Nothing needs you right now.", { exact: true })).toHaveCount(0);
    await expect(page.getByTestId("home-suggestions-section")).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Suggestions" })).toHaveCount(0);
    await expect(page.locator('[data-testid^="home-starter-"]')).toHaveCount(0);
    // Legacy chrome that must stay gone.
    await expect(page.getByText("Start something", { exact: true })).toHaveCount(0);
    await expect(page.getByTestId("home-open-current-files")).toHaveCount(0);
    await expect(page.getByTestId("home-refresh-button")).toHaveCount(0);

    const recentItems = page.locator('[data-testid^="home-recent-item-"]');
    await expect(recentItems.first()).toBeVisible();
    await recentItems.first().click();
    await expect(page).toHaveURL(/conversation(?:Id|ControllerId)=/);
    await expect(page.getByTestId("chat-input")).toBeVisible();

    await page.getByTestId("sidebar-home-button").click();
    await expect(page.getByTestId("home-panel")).toBeVisible();
    await expect(page.getByTestId("home-recent-section")).toBeVisible();
  });
});
