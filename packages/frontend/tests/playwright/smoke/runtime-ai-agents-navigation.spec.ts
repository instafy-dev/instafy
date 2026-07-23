import { test, expect, type Page } from "@playwright/test";
import { prepareStudio } from "../utils/harness.js";
import { mockDefaultAiCredential } from "../utils/credentialMocks.js";
import { openRuntimeAiMenu } from "../utils/runtimeAi.js";

test.describe("Runtime & AI agents navigation", () => {
  test.setTimeout(120_000);

  test("stays open and returns to main view after selecting an agent", async ({ page }) => {
    await mockDefaultAiCredential(page);
    await prepareStudio(page);

    await openRuntimeAiMenu(page);
    await page.getByRole("button", { name: "Agents" }).click();
    await expect(page.getByText("Agents")).toBeVisible();

    await page.getByRole("button", { name: /@octo/i }).first().click();

    await expect(page.getByTestId("runtime-selector-popover")).toBeVisible();
    await expect(page.getByTestId("chat-assistant-toggle")).toBeVisible();
    await expect(page.getByRole("button", { name: "Agents" })).toBeVisible();
    await expect(page.getByText("Default responder")).toHaveCount(0);
  });
});
