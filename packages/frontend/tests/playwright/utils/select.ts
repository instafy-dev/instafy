import type { Locator } from "@playwright/test";

/**
 * Choose an option in the product's Select.
 *
 * Select draws its own menu now, so Playwright's selectOption(), which only
 * knows the native element, no longer reaches it. The trigger is what a
 * data-testid lands on; the menu it opens carries one role="option" per
 * choice with data-value set to the value the old <option> had.
 */
export async function chooseOption(trigger: Locator, value: string): Promise<void> {
  const page = trigger.page();
  await trigger.click();
  const option = page.locator(`[role="listbox"] [role="option"][data-value="${value}"]`).first();
  await option.waitFor({ state: "visible" });
  await option.click();
  await option.waitFor({ state: "hidden" }).catch(() => {});
}
