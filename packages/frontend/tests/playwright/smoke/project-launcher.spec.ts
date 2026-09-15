import { test, expect } from "@playwright/test";
import { prepareStudio, resetRuntimeUserState } from "../utils/harness.js";
import { openTeamDirectory } from "../utils/sidebar.js";

test.describe("Project launcher", () => {
  test.afterEach(async ({ page }) => {
    await resetRuntimeUserState(page, { source: "project-launcher:cleanup" }).catch(() => {});
  });

  test("opens and closes from the project menu", async ({ page }) => {
    test.setTimeout(120_000);
    page.setDefaultTimeout(60_000);

    await prepareStudio(page, { waitForHostedRuntime: false });

    await openTeamDirectory(page);
    const projectMenu = page.getByTestId("sidebar-project-switcher-menu");
    await expect(projectMenu).toBeVisible();

    await projectMenu.getByTestId("sidebar-project-new").click();
    const nameInput = page.getByTestId("project-launcher-name-input");
    await expect(nameInput).toBeVisible();
    await expect(nameInput).toBeFocused();

    await page.keyboard.press("Escape");
    await expect(page.getByTestId("project-launcher-close")).toHaveCount(0);

    await openTeamDirectory(page);
    await expect(projectMenu).toBeVisible();
    await projectMenu.getByTestId("sidebar-project-new").click();
    const overlay = page.getByTestId("project-launcher-overlay");
    await expect(overlay).toBeVisible();
    await overlay.click({ position: { x: 10, y: 10 } });
    await expect(page.getByTestId("project-launcher-close")).toHaveCount(0);
  });
});
