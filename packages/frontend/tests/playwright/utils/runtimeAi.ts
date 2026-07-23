import { expect, type Page } from "@playwright/test";

export async function openRuntimeAiMenu(page: Page): Promise<void> {
  const runtimeButton = page.locator('[data-testid="runtime-selector-button"]:visible').first();
  await runtimeButton.scrollIntoViewIfNeeded().catch(() => {});
  await runtimeButton.click();
  await expect(page.getByTestId("runtime-selector-popover")).toBeVisible();
}

export async function closeRuntimeAiMenu(page: Page): Promise<void> {
  const closeButton = page.getByRole("button", { name: /close agent menu/i }).first();
  if (await closeButton.isVisible().catch(() => false)) {
    await closeButton.click().catch(() => {});
  }
  await page.keyboard.press("Escape").catch(() => {});
  await page.getByTestId("runtime-selector-popover").waitFor({ state: "hidden", timeout: 5_000 }).catch(() => {});
}

export async function disableAssistantIfPossible(page: Page): Promise<boolean> {
  await openRuntimeAiMenu(page);

  const toggle = page.getByTestId("chat-assistant-toggle");
  if (!(await toggle.isVisible().catch(() => false))) {
    await closeRuntimeAiMenu(page);
    return false;
  }
  const toggleSwitch = toggle.locator('input[role="switch"]');
  await expect(toggle).toBeVisible();
  if (await toggleSwitch.isChecked()) {
    await toggle.click();
    await expect(toggleSwitch).not.toBeChecked();
  }
  await closeRuntimeAiMenu(page);
  return true;
}

export async function enableAssistant(page: Page): Promise<void> {
  await openRuntimeAiMenu(page);

  const connectAiButton = page.getByTestId("runtime-ai-connect-button");
  if (await connectAiButton.isVisible().catch(() => false)) {
    throw new Error("Cannot enable assistant: no AI credential is connected.");
  }

  const toggle = page.getByTestId("chat-assistant-toggle");
  const toggleSwitch = toggle.locator('input[role="switch"]');
  await expect(toggle).toBeVisible();
  if (!(await toggleSwitch.isChecked())) {
    await toggle.click();
    await expect(toggleSwitch).toBeChecked();
  }
  await closeRuntimeAiMenu(page);
}
