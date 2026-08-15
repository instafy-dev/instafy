import { test, expect } from "@playwright/test";
import { prepareStudio, resetRuntimeUserState } from "../utils/harness.js";
import { openSidebarSecondaryItem } from "../utils/sidebar.js";

test.beforeEach(async ({ page }) => {
  await prepareStudio(page, { waitForHostedRuntime: false });
});

test.afterEach(async ({ page }) => {
  await resetRuntimeUserState(page, { source: "automations:cleanup" }).catch(() => {});
});

test.describe("Automations", () => {
  test.setTimeout(120_000);

  test("creates an automation", async ({ page }) => {
    await page.goto("/studio");
    await expect(page.getByTestId("chat-input")).toBeVisible({ timeout: 30_000 });

    await openSidebarSecondaryItem(page, "automations");

    await expect(page.getByTestId("automations-panel")).toBeVisible();

    await page.getByTestId("automations-create-button").click();
    await expect(page.getByTestId("automation-name-input")).toBeVisible();

    await page.getByTestId("automation-name-input").fill("Daily bug scan");
    await page
      .getByTestId("automation-prompt-input")
      .fill("Scan recent commits (last 24h) for likely bugs and propose minimal fixes.");

    const findingsOnlyToggle = page.getByTestId(
      "automation-silent-when-nothing-to-report-toggle"
    );
    const findingsOnlyInput = findingsOnlyToggle.locator('input[type="checkbox"]');
    await expect(findingsOnlyInput).not.toBeChecked();
    await findingsOnlyToggle.click();
    await expect(findingsOnlyInput).toBeChecked();

    await page.getByTestId("automation-save-button").click();

    const automationRow = page
      .locator('[data-testid^="automation-row-"]')
      .filter({ hasText: "Daily bug scan" })
      .first();
    await expect(automationRow).toBeVisible({ timeout: 30_000 });
    await expect(automationRow).toContainText("Findings only");

    await automationRow.getByRole("button", { name: "Automation actions" }).click();
    await page.getByRole("menuitem", { name: "Edit" }).click();
    await expect(findingsOnlyInput).toBeChecked();
  });

  test("creates a one-shot automation", async ({ page }) => {
    await page.goto("/studio");
    await expect(page.getByTestId("chat-input")).toBeVisible({ timeout: 30_000 });

    await openSidebarSecondaryItem(page, "automations");

    await expect(page.getByTestId("automations-panel")).toBeVisible();

    await page.getByTestId("automations-create-button").click();
    await expect(page.getByTestId("automation-name-input")).toBeVisible();

    await page.getByTestId("automation-name-input").fill("One time check");
    await page.getByTestId("automation-prompt-input").fill("Say hello once.");

    await page.getByRole("button", { name: "Once" }).click();
    await expect(page.getByTestId("automation-runat-input")).toBeVisible();
    await page.getByTestId("automation-runat-input").fill("2030-01-01T09:00");

    await page.getByTestId("automation-save-button").click();

    await expect(
      page
        .locator('[data-testid^="automation-row-"]')
        .filter({ hasText: "One time check" })
        .first()
    ).toBeVisible({ timeout: 30_000 });
  });

  test("keeps the automation editor controls reachable at laptop height", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto("/studio?panel=automations");
    await expect(page.getByTestId("automations-panel")).toBeVisible();

    await page.getByTestId("automations-create-button").click();

    const saveButton = page.getByTestId("automation-save-button");
    const findingsOnlyToggle = page.getByTestId(
      "automation-silent-when-nothing-to-report-toggle"
    );
    const findingsOnlyInput = findingsOnlyToggle.locator('input[type="checkbox"]');

    await expect(saveButton).toBeInViewport({ ratio: 1 });
    await expect(saveButton).toBeEnabled();

    await findingsOnlyToggle.scrollIntoViewIfNeeded();
    await expect(findingsOnlyToggle).toBeInViewport({ ratio: 1 });
    await findingsOnlyToggle.click();
    await expect(findingsOnlyInput).toBeChecked();
    await expect(saveButton).toBeInViewport({ ratio: 1 });
  });

  test("keeps the automation editor usable on mobile", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/studio?panel=automations");
    await expect(page.getByTestId("automations-panel")).toBeVisible();

    await page.getByTestId("automations-create-button").click();
    await expect(page.getByTestId("automation-name-input")).toBeVisible();
    await expect(page.getByTestId("automation-save-button")).toBeVisible();
  });
});
