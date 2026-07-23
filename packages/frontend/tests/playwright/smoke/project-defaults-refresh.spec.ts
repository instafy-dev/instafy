import { expect, test, type Page } from "@playwright/test";
import {
  prepareStudio,
  readWorkspaceFileText,
  resetRuntimeUserState,
} from "../utils/harness.js";
import { dismissToastIfVisible } from "../utils/toasts.js";

async function openProjectSettings(page: Page) {
  await page.getByTestId("sidebar-project-button").click();
  await expect(page.getByTestId("sidebar-project-switcher-menu")).toBeVisible();
  await page.getByTestId("sidebar-project-settings").click();
  await expect(page.getByTestId("settings-panel")).toBeVisible();
  await expect(page.getByTestId("project-settings-section")).toBeVisible();
}

test.describe("Project defaults refresh", () => {
  test.setTimeout(120_000);
  let projectId: string;

  test.beforeEach(async ({ page }) => {
    projectId = await prepareStudio(page, { waitForHostedRuntime: false });
  });

  test.afterEach(async ({ page }) => {
    await resetRuntimeUserState(page, { source: "project-defaults-refresh:cleanup" }).catch(() => {});
  });

  test("refreshes managed defaults from project settings", async ({ page }) => {
    await openProjectSettings(page);
    await dismissToastIfVisible(page);

    const button = page.getByTestId("project-defaults-refresh");
    await expect(button).toBeVisible();
    await expect(button).toHaveText("Refresh defaults");
    const refreshResponsePromise = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().includes("/memory/bootstrap"),
    );
    await button.click();
    const refreshResponse = await refreshResponsePromise;
    expect(refreshResponse.ok()).toBeTruthy();

    const toast = page.getByTestId("status-toast");
    if (await toast.isVisible().catch(() => false)) {
      await expect(toast).toContainText(/Defaults refreshed|No default files changed|Workspace is busy/);
    }

    await expect(button).toHaveText("Refresh defaults");

    await expect
      .poll(
        async () =>
          projectId
            ? (
                await readWorkspaceFileText(
                  page,
                  ".agents/skills/instafy-group-participation/SKILL.md",
                  { projectId },
                )
              )?.trim()
            : null,
        { timeout: 30_000 },
      )
      .toContain("Group conversation participation");
  });
});
