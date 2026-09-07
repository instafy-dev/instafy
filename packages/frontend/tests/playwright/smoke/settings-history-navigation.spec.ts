import { test, expect, type Page } from "@playwright/test";
import { prepareStudio, resetRuntimeUserState } from "../utils/harness.js";
import { openSecretsPanel as openSecretsSidebarPanel } from "../utils/sidebar.js";

async function openSecretsPanel(page: Page) {
  await openSecretsSidebarPanel(page);
  await expect(page.getByTestId("secrets-panel")).toBeVisible();
}

async function openOrgSettings(page: Page) {
  await page.getByTestId("sidebar-project-button").click();
  await expect(page.getByTestId("sidebar-project-switcher-menu")).toBeVisible();
  await page.getByTestId("sidebar-org-settings-button").click();
  await expect(page.getByTestId("settings-panel")).toBeVisible();
  await expect(page.getByTestId("org-settings-section")).toBeVisible();
}

async function openProjectSettings(page: Page) {
  if (!(await page.getByTestId("sidebar-project-button").isVisible())) {
    await page.getByTestId("topbar-sidebar-toggle").click();
  }
  await page.getByTestId("sidebar-project-button").click();
  await expect(page.getByTestId("sidebar-project-switcher-menu")).toBeVisible();
  await page.getByTestId("sidebar-project-settings").click();
  await expect(page.getByTestId("settings-panel")).toBeVisible();
  await expect(page.getByTestId("project-settings-section")).toBeVisible();
}

async function selectProjectCategory(page: Page, category: string) {
  const picker = page.getByTestId("settings-category-nav-picker");
  if (await picker.isVisible()) {
    await picker.click();
  }
  await page.getByTestId(`settings-category-project-${category}`).click();
}

async function openProfileSettings(page: Page) {
  await page.getByTestId("sidebar-profile-menu").click();
  await expect(page.getByTestId("profile-settings-button")).toBeVisible();
  await page.getByTestId("profile-settings-button").click();
  await expect(page.getByTestId("settings-panel")).toBeVisible();
  await expect(page.getByTestId("profile-settings-section")).toBeVisible();
}

async function openProfilePreferences(page: Page) {
  await openProfileSettings(page);
  await page.getByTestId("settings-category-profile-preferences").click();
  await expect(page.getByTestId("profile-preference-git-auto-sync")).toBeVisible();
}

test.describe("Settings browser history", () => {
  test.setTimeout(120_000);

  test.beforeEach(async ({ page }) => {
    await prepareStudio(page, { waitForHostedRuntime: false });
  });

  test.afterEach(async ({ page }) => {
    await resetRuntimeUserState(page, { source: "settings-history-navigation:cleanup" }).catch(() => {});
  });

  test("org, project, and profile settings entries push browser history", async ({ page }) => {
    await openSecretsPanel(page);
    await openOrgSettings(page);
    await page.goBack();
    await expect(page.getByTestId("secrets-panel")).toBeVisible();
    await page.goForward();
    await expect(page.getByTestId("org-settings-section")).toBeVisible();

    await openSecretsPanel(page);
    await openProjectSettings(page);
    await page.goBack();
    await expect(page.getByTestId("secrets-panel")).toBeVisible();
    await page.goForward();
    await expect(page.getByTestId("project-settings-section")).toBeVisible();

    await openSecretsPanel(page);
    await openProfileSettings(page);
    await page.goBack();
    await expect(page.getByTestId("secrets-panel")).toBeVisible();
    await page.goForward();
    await expect(page.getByTestId("profile-settings-section")).toBeVisible();
  });

  test("profile preference toggles assistant auto-save", async ({ page }) => {
    await page.evaluate(() => window.localStorage.setItem("instafy.git.autoSyncAfterApply", "1"));
    await openProfilePreferences(page);
    const toggle = page.getByTestId("profile-preference-git-auto-sync");

    await expect(toggle).toBeChecked();
    await toggle.uncheck();
    await expect(toggle).not.toBeChecked();
    await expect
      .poll(async () => await page.evaluate(() => window.localStorage.getItem("instafy.git.autoSyncAfterApply")))
      .toBe("0");

    await toggle.check();
    await expect(toggle).toBeChecked();
    await expect
      .poll(async () => await page.evaluate(() => window.localStorage.getItem("instafy.git.autoSyncAfterApply")))
      .toBe("1");
  });

  for (const width of [1280, 390]) {
    test(`project categories return to Overview and restore deep links at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await openProjectSettings(page);

      // All named destinations must be able to return to the omitted/default
      // category. Previously an optimistic state update re-applied the old URL
      // before navigation settled, and the missing param never corrected it.
      for (const category of ["danger", "access", "providers"]) {
        await selectProjectCategory(page, category);
        await expect(page).toHaveURL(new RegExp(`settingsCategory=${category}`));
        if (category === "danger") {
          await expect(page.getByTestId("settings-danger-zone")).toBeVisible();
        }
        await selectProjectCategory(page, "overview");
        await expect(page).not.toHaveURL(/settingsCategory=/);
        await expect(page.getByTestId("project-settings-name-input")).toBeVisible();
        await expect(page.getByTestId("settings-danger-zone")).toHaveCount(0);
      }

      await selectProjectCategory(page, "providers");
      await expect(page).toHaveURL(/settingsCategory=providers/);
      const providersUrl = page.url();
      await page.reload();
      await expect(page.getByTestId("project-providers-section")).toBeVisible();

      await selectProjectCategory(page, "overview");
      await expect(page.getByTestId("project-settings-name-input")).toBeVisible();
      const overviewUrl = page.url();
      await page.goto(providersUrl);
      await expect(page.getByTestId("project-providers-section")).toBeVisible();
      await page.goBack();
      await expect(page).toHaveURL(overviewUrl);
      await expect(page.getByTestId("project-settings-name-input")).toBeVisible();
    });
  }
});
