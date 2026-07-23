import { expect, test, type Page } from "@playwright/test";
import { prepareStudio } from "../utils/harness";

async function openRuntimeAiMenu(page: Page) {
  const runtimeButton = page.locator('[data-testid="runtime-selector-button"]:visible').first();
  await runtimeButton.scrollIntoViewIfNeeded().catch(() => {});
  await runtimeButton.click();
  await expect(page.getByTestId("runtime-selector-popover")).toBeVisible();
}

test.describe.skip("Runtime image menu", () => {
  test.setTimeout(120_000);

  test("submits selected custom runtime image through runtime ensure", async ({ page }) => {
    await prepareStudio(page);
    await openRuntimeAiMenu(page);

    await expect(page.getByTestId("runtime-image-current-label")).toBeVisible();

    await page.getByRole("button", { name: "Custom" }).first().click();
    await page.getByTestId("runtime-image-custom-input").fill("ghcr.io/acme/runtime-agent:test");

    const ensureRequest = page.waitForRequest((request) => {
      return request.method() === "POST" && request.url().includes("/runtime/ensure");
    });

    await page.getByTestId("runtime-image-apply-button").click();
    const request = await ensureRequest;
    const payload = request.postDataJSON() as {
      metadata?: Record<string, unknown>;
    } | null;

    expect(payload?.metadata?.["runtimeImagePreset"]).toBe("custom");
    expect(payload?.metadata?.["runtimeAgentImage"]).toBe("ghcr.io/acme/runtime-agent:test");
  });
});
