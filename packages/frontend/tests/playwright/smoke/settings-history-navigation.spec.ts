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
  await page.getByTestId("sidebar-project-button").click();
  await expect(page.getByTestId("sidebar-project-switcher-menu")).toBeVisible();
  await page.getByTestId("sidebar-project-settings").click();
  await expect(page.getByTestId("settings-panel")).toBeVisible();
  await expect(page.getByTestId("project-settings-section")).toBeVisible();
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
});
