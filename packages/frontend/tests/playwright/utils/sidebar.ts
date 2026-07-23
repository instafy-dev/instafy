import { expect, type Page } from "@playwright/test";

export async function openSidebarPrimaryItem(page: Page, itemId: string) {
  await page.getByTestId(`sidebar-nav-${itemId}`).click();
}

export async function openSidebarSecondaryItem(page: Page, itemId: string) {
  const directEntry = page.getByTestId(`sidebar-more-item-${itemId}`).first();
  if (await directEntry.isVisible().catch(() => false)) {
    await directEntry.click();
    return;
  }

  const moreButton = page.getByTestId("sidebar-nav-more");
  await expect(moreButton).toBeVisible();
  await moreButton.click();
  await page.getByTestId(`sidebar-more-item-${itemId}`).first().click();
}

export async function openCreditsPanel(page: Page) {
  await openSidebarPrimaryItem(page, "credits");
}

export async function openSecretsPanel(page: Page) {
  await openSidebarSecondaryItem(page, "secrets");
}
