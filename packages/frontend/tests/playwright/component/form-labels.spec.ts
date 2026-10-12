import { expect, test } from "@playwright/test";

for (const width of [390, 1280]) {
  test(`Field labels name styled and native selects at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await page.goto("/tests/fixtures/component-system/index.html");
    const styled = page.getByTestId("reference-select");
    await expect(styled).toHaveAccessibleName(/\bAccess\b/);
    await expect(page.getByRole("combobox", { name: "Native access", exact: true })).toBeVisible();
    await styled.click();
    const choices = page.getByRole("listbox", { name: "Access", exact: true });
    await expect(choices).toBeVisible();
    await choices.getByRole("option", { name: "Editor", exact: true }).click();
    await expect(styled).toHaveAccessibleName(/\bAccess\b/);
    await expect(styled).toHaveAccessibleName(/\bEditor\b/);
    await expect(styled).toBeFocused();
  });
}
