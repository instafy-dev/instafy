import { expect, type Page } from "@playwright/test";

/**
 * Opens the browser's Options menu: the Shared Browser's "Browser options" or
 * the Personal Browser's "Browser settings", whichever is on screen.
 */
export async function openBrowserOptions(page: Page, { timeout = 30_000 }: { timeout?: number } = {}) {
  await page
    .getByRole("button", { name: /^Browser (options|settings)$/ })
    .filter({ visible: true })
    .first()
    .click({ timeout });
}

/**
 * Picks where the browser runs ("Run browser on") from its Options menu, and
 * leaves the menu closed.
 */
export async function chooseBrowserLocation(
  page: Page,
  mode: "shared" | "personal",
  { timeout = 30_000 }: { timeout?: number } = {},
) {
  await openBrowserOptions(page, { timeout });
  const choice = page.getByTestId(`browser-transport-${mode}`).filter({ visible: true }).first();
  await expect(choice).toBeEnabled({ timeout });
  await choice.click();
  // Choosing the other browser closes this one's menu; the same one stays open.
  if (await choice.isVisible()) await page.keyboard.press("Escape");
}
