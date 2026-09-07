import { expect, test } from "@playwright/test";
import { prepareStudio } from "../utils/harness.js";
import { DEFAULT_MOCK_CREDENTIAL_ID, mockDefaultAiCredential } from "../utils/credentialMocks.js";

test.describe("Chat inline composer completion", () => {
  test.setTimeout(120_000);

  test.beforeEach(async ({ page }) => {
    await mockDefaultAiCredential(page);
    await page.route("**/projects/*/editor/completions", async (route, request) => {
      if (request.method().toUpperCase() !== "POST") {
        await route.continue();
        return;
      }

      const payload = request.postDataJSON() as {
        prefix?: string;
      } | null;
      const prefix = payload?.prefix ?? "";
      const completion = prefix.trim().toLowerCase() === "hel" ? "lo there" : "";

      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          success: true,
          completion,
          provider: "openai",
          model: "gpt-5.5",
          credentialId: DEFAULT_MOCK_CREDENTIAL_ID,
        }),
      });
    });
  });

  test("accepts inline completion with Tab on desktop without a secondary action button", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await prepareStudio(page, { waitForHostedRuntime: false });

    const input = page.getByTestId("chat-input");
    await expect(input).toBeVisible({ timeout: 30_000 });
    const editorParagraph = input.locator("p").last();

    await input.fill("Hel");
    await expect(editorParagraph).toHaveText("Hel");

    await expect(page.getByText("lo there", { exact: true })).toBeVisible({ timeout: 30_000 });

    await expect(page.getByTestId("chat-accept-suggestion-button")).toHaveCount(0);

    await input.press("Tab");
    await expect(editorParagraph).toHaveText("Hello there");
  });

  test("offers the accept action in the + menu on desktop too and applies the suggestion when clicked", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await prepareStudio(page, { waitForHostedRuntime: false });

    const input = page.getByTestId("chat-input");
    await expect(input).toBeVisible({ timeout: 30_000 });
    const editorParagraph = input.locator("p").last();

    await input.fill("Hel");
    await expect(editorParagraph).toHaveText("Hel");

    await expect(page.getByText("lo there", { exact: true })).toBeVisible({ timeout: 30_000 });

    // The composer is one row on every viewport; the wand lives in the "+"
    // menu everywhere, never as a control that appears while typing.
    await expect(page.getByTestId("chat-accept-suggestion-button")).toHaveCount(0);
    await expect(page.getByTestId("chat-image-upload-button")).toHaveCount(0);
    await page.getByTestId("composer-action-menu-trigger").click();
    const acceptAction = page.getByTestId("composer-action-menu-insert-suggestion");
    await expect(acceptAction).toBeVisible({ timeout: 30_000 });
    // Image upload uses the same menu entry on every viewport.
    await expect(page.getByTestId("composer-action-menu-upload-image")).toBeVisible();
    await acceptAction.click();

    await expect(acceptAction).toBeHidden();
    await expect(editorParagraph).toHaveText("Hello there");
  });

  test("folds the accept action into the + menu on mobile and applies the suggestion when tapped", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await prepareStudio(page, { waitForHostedRuntime: false });

    const input = page.getByTestId("chat-input");
    await expect(input).toBeVisible({ timeout: 30_000 });
    const editorParagraph = input.locator("p").last();

    await input.fill("Hel");
    await expect(editorParagraph).toHaveText("Hel");

    await expect(page.getByText("lo there", { exact: true })).toBeVisible({ timeout: 30_000 });

    // Below sm the composer is one row; the wand lives in the "+" menu.
    await expect(page.getByTestId("chat-accept-suggestion-button")).toHaveCount(0);
    await page.getByTestId("composer-action-menu-trigger").click();
    const acceptAction = page.getByTestId("composer-action-menu-insert-suggestion");
    await expect(acceptAction).toBeVisible({ timeout: 30_000 });
    await acceptAction.click();

    await expect(acceptAction).toBeHidden();
    await expect(editorParagraph).toHaveText("Hello there");
  });

  test("does not offer the accept action before there is an actual draft prefix", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await prepareStudio(page, { waitForHostedRuntime: false });

    await expect(page.getByTestId("chat-input")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("chat-accept-suggestion-button")).toHaveCount(0);
    await page.getByTestId("composer-action-menu-trigger").click();
    await expect(page.getByTestId("composer-action-menu-upload-image")).toBeVisible();
    await expect(page.getByTestId("composer-action-menu-insert-suggestion")).toHaveCount(0);
  });
});
