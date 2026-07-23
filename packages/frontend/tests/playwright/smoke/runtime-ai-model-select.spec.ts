import { test, expect, type Page } from "@playwright/test";
import { prepareStudio } from "../utils/harness.js";
import { mockDefaultAiCredential } from "../utils/credentialMocks.js";
import { openRuntimeAiMenu } from "../utils/runtimeAi.js";

async function openPrimaryModelMenu(page: Page) {
  const runtimePopover = page.getByTestId("runtime-selector-popover");
  const modelMenu = page.getByTestId("octo-agent-model-menu");

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const modelTrigger = page.getByTestId("octo-agent-model-select").first();
    await expect(modelTrigger).toBeVisible();
    await expect(modelTrigger).toBeEnabled({ timeout: 15_000 });

    let menuVisible = await modelMenu.isVisible().catch(() => false);
    if (!menuVisible) {
      await modelTrigger.click().catch(() => {});
      menuVisible = await modelMenu.isVisible().catch(() => false);
    }
    if (!menuVisible) {
      await modelTrigger.press("Enter").catch(() => {});
      menuVisible = await modelMenu.isVisible().catch(() => false);
    }
    if (!menuVisible) {
      await modelTrigger.press("ArrowDown").catch(() => {});
      menuVisible = await modelMenu.isVisible().catch(() => false);
    }
    if (!menuVisible) {
      await modelTrigger.evaluate((element) => (element as HTMLButtonElement).click()).catch(() => {});
      menuVisible = await modelMenu.isVisible().catch(() => false);
    }
    if (menuVisible) {
      return;
    }

    await page.keyboard.press("Escape").catch(() => {});
    await expect(runtimePopover).toBeHidden({ timeout: 3_000 }).catch(() => {});
    await openRuntimeAiMenu(page);
  }

  await expect(modelMenu).toBeVisible({ timeout: 15_000 });
}

test.describe("Runtime & AI menu model selector", () => {
  test.setTimeout(120_000);

  test("shows the primary agent model selector inside the runtime menu", async ({ page }) => {
    await mockDefaultAiCredential(page);
    await prepareStudio(page);

    await openRuntimeAiMenu(page);

    const modelTrigger = page.getByTestId("octo-agent-model-select").first();
    await expect(modelTrigger).toBeVisible({ timeout: 30_000 });
    await expect(modelTrigger).toBeEnabled({ timeout: 30_000 });

    await openPrimaryModelMenu(page);

    const modelMenu = page.getByTestId("octo-agent-model-menu");
    await expect(modelMenu).toBeVisible({ timeout: 15_000 });
    await expect(modelMenu.getByRole("menuitemradio").first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("octo-agent-model-select-custom-input")).toBeVisible({ timeout: 15_000 });
  });
});
