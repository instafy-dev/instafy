import { test, expect, type Page } from "@playwright/test";
import { prepareStudio, resetRuntimeUserState } from "../utils/harness.js";

async function openProjectSettings(page: Page) {
  await page.getByTestId("sidebar-project-button").click();
  await expect(page.getByTestId("sidebar-project-switcher-menu")).toBeVisible();
  await page.getByTestId("sidebar-project-settings").click();
  await expect(page.getByTestId("settings-panel")).toBeVisible();
  await expect(page.getByTestId("project-settings-section")).toBeVisible();
}

async function openConnectionsCategory(page: Page) {
  await page.getByTestId("settings-category-project-providers").click();
  await expect(page.getByTestId("project-workspace-source-panel")).toBeVisible();
}

test.describe("Project workspace source panel", () => {
  test.setTimeout(180_000);

  test.afterEach(async ({ page }) => {
    await resetRuntimeUserState(page, {
      source: "project-workspace-source-panel:cleanup",
    }).catch(() => {});
  });

  test("shows canonical storage with no local copy by default", async ({ page }) => {
    await prepareStudio(page, { waitForHostedRuntime: false });
    await openProjectSettings(page);
    await openConnectionsCategory(page);

    const panel = page.getByTestId("project-workspace-source-panel");
    await expect(panel).toContainText("Stored in Instafy");
    await expect(panel).toContainText("No local copy connected");
    await expect(page.getByTestId("project-workspace-local-path")).toHaveCount(0);
  });

  test("shows a registered local copy and restores Connections after reload", async ({
    page,
  }) => {
    const projectId = await prepareStudio(page, { waitForHostedRuntime: false });
    const workspacePath = `/tmp/playwright-handoff/${projectId ?? "project"}`;

    await page.route("**/projects/*/workspaces/local", async (route, request) => {
      if (request.method().toUpperCase() !== "GET") {
        await route.fallback();
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          workspace: {
            deviceId: "playwright-desktop",
            hostname: "Playwright Desktop",
            path: workspacePath,
            expiresAt: new Date(Date.now() + 180_000).toISOString(),
          },
        }),
      });
    });

    // Reload so the presence hydrates from the mocked endpoint before the
    // Connections category is opened.
    await page.reload();
    await openProjectSettings(page);
    await openConnectionsCategory(page);

    const panel = page.getByTestId("project-workspace-source-panel");
    await expect(panel).toContainText("Stored in Instafy");
    await expect(panel).toContainText("Copy on Playwright Desktop");
    await expect(page.getByTestId("project-workspace-local-path")).toHaveText(
      workspacePath,
    );

    // Selecting the Connections category writes settingsCategory to the URL so
    // reloads and Open-in-Desktop deep links land back on Connections.
    await expect(page).toHaveURL(/settingsCategory=providers/);

    await page.reload();
    await expect(page.getByTestId("settings-panel")).toBeVisible();
    await expect(page.getByTestId("project-settings-section")).toBeVisible();
    await expect(page.getByTestId("project-workspace-source-panel")).toBeVisible();
    await expect(page.getByTestId("project-workspace-local-path")).toHaveText(
      workspacePath,
    );
  });
});
