import { test, expect, type Page } from "@playwright/test";
import { prepareStudio } from "../utils/harness.js";
import { mockDefaultAiCredential } from "../utils/credentialMocks.js";
import { openRuntimeAiMenu } from "../utils/runtimeAi.js";

test.describe("Runtime & AI menu navigation", () => {
  test.setTimeout(180_000);

  test("cog opens AI & Providers and browser back returns to chat", async ({ page }) => {
    await mockDefaultAiCredential(page);
    await prepareStudio(page);

    await openRuntimeAiMenu(page);
    await page.getByTestId("runtime-ai-settings-button").first().click();

    await expect(page.getByTestId("ai-panel")).toBeVisible();

    await page.goBack();
    await expect(page.getByTestId("chat-input")).toBeVisible();
  });
});
