import { expect, type Page } from "@playwright/test";

export async function openFileExplorerMenu(page: Page) {
  const menu = page.getByTestId("files-explorer-menu");
  if (await menu.isVisible()) return;
  const desktopMore = page.getByRole("button", { name: "More file actions", exact: true });
  if (await desktopMore.isVisible()) {
    await desktopMore.click();
  } else {
    await page.getByTestId("mobile-header-more").filter({ visible: true }).click();
    await page.getByRole("button", { name: "File actions", exact: true }).click();
  }
  await expect(menu).toBeVisible();
}

/** Secondary file actions share the root menu on desktop and touch layouts. */
export async function fileExplorerAction(page: Page, action: "refresh" | "new-folder" | "collapse-all") {
  await openFileExplorerMenu(page);
  return page.getByTestId(`files-explorer-menu-${action}`);
}

export async function fileExplorerSearch(page: Page) {
  const input = page.getByTestId("code-search-input");
  if (!(await input.isVisible())) await page.getByTestId("files-explorer-search-toggle").click();
  await expect(input).toBeVisible();
  return input;
}

export async function closeFileExplorer(page: Page) {
  const close = page.getByTestId("files-explorer-close");
  if (await close.isVisible()) {
    await close.click();
  } else {
    await page.getByTestId("mobile-header-more").filter({ visible: true }).click();
    await page.getByTestId("mobile-header-back").filter({ visible: true }).click();
  }
}
