import type { Page } from "@playwright/test";

/** Secondary file actions share the root menu on desktop and touch layouts. */
export async function fileExplorerAction(page: Page, action: "refresh" | "new-folder" | "collapse-all") {
  const menu = page.getByTestId("files-explorer-menu");
  if (!(await menu.isVisible())) {
    await page.getByRole("button", { name: "More file actions", exact: true }).click();
  }
  return page.getByTestId(`files-explorer-menu-${action}`);
}
