import type { Page } from "@playwright/test";

export async function dismissToastIfVisible(page: Page) {
  const toast = page.getByTestId("status-toast");
  try {
    if (await toast.isVisible()) {
      const dismissButton = toast.getByRole("button", { name: /Dismiss notification/i });
      await dismissButton.click();
    }
  } catch (error) {
    // Toast not present or already dismissed; ignore.
  }
}
