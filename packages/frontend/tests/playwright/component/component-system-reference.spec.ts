import { expect, test, type Page } from "@playwright/test";

const REFERENCE = "/tests/fixtures/component-system/index.html";

async function openReference(page: Page, width = 390) {
  await page.setViewportSize({ width, height: 844 });
  await page.goto(REFERENCE);
  await expect(page.getByRole("heading", { name: "Component reference" })).toBeVisible();
}

async function expectFormSizes(page: Page, minimum: number) {
  const input = page.getByRole("textbox", { name: "Name", exact: true });
  const select = page.getByTestId("reference-select");
  const native = page.getByRole("combobox", { name: "Native access", exact: true });
  const picker = page.getByTestId("reference-picker");
  const heights = await Promise.all([input, select, native, picker].map(async control => (await control.boundingBox())!.height));
  expect(Math.min(...heights)).toBeGreaterThanOrEqual(minimum);
  expect(Math.max(...heights) - Math.min(...heights), `Input, Select, native Select, picker: ${heights.join(", ")}`).toBeLessThanOrEqual(1);
}

async function expectButtonTargets(page: Page, coarse: boolean) {
  for (const id of ["reference-primary", "reference-retry", "reference-text", "reference-danger", "reference-icon"]) {
    const bounds = (await page.getByTestId(id).boundingBox())!;
    if (coarse) {
      expect(bounds.height, id).toBeGreaterThanOrEqual(44);
      expect(bounds.width, id).toBeGreaterThanOrEqual(44);
    } else {
      expect(bounds.height, id).toBe(id === "reference-text" ? 20 : 32);
      if (id === "reference-danger" || id === "reference-icon") expect(bounds.width, id).toBe(32);
    }
  }
}

async function expectCheckboxTouchTarget(page: Page) {
  const checkboxTarget = page.getByTestId("reference-checkbox").locator("..").locator("..");
  const bounds = (await checkboxTarget.boundingBox())!;
  expect(bounds.height).toBeGreaterThanOrEqual(44);
  expect(bounds.width).toBeGreaterThanOrEqual(44);
}

test.describe("shared control contracts with a fine pointer", () => {
  test.use({ hasTouch: false });

  test("narrow mouse layouts keep compact buttons and full form targets", async ({ page }) => {
    await openReference(page);
    await expectFormSizes(page, 44);
    await expectButtonTargets(page, false);
    await expectCheckboxTouchTarget(page);
    await expect(page.getByRole("heading", { name: "Actions", exact: true })).toHaveCSS("font-size", "16px");
    await page.getByText("Include selected files", { exact: true }).click();
    await expect(page.getByRole("checkbox", { name: "Include selected files" })).toBeChecked();
    await page.getByText("Model", { exact: true }).click();
    await expect(page.getByTestId("reference-picker")).toBeFocused();
    await page.getByRole("button", { name: "Model", exact: true }).click();
    await page.getByRole("menuitemradio", { name: "Custom", exact: true }).click();
    await expect(page.getByTestId("reference-picker")).toContainText("Custom");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });

  test("wide controls preserve compact form density", async ({ page }) => {
    await openReference(page, 1280);
    await expectFormSizes(page, 38);
    await expectButtonTargets(page, false);
  });

  test("keyboard choice and pending action behavior survive theme changes", async ({ page }) => {
    await openReference(page, 1280);
    const theme = page.getByRole("radiogroup", { name: "Preview theme" });
    await theme.getByText("Dark", { exact: true }).click();
    const choices = page.getByRole("radiogroup", { name: "Changes view" });
    await choices.getByRole("radio", { name: "Files", exact: true }).focus();
    await page.keyboard.press("ArrowRight");
    await expect(choices.getByRole("radio", { name: "All changes" })).toBeChecked();
    await expect(choices.getByRole("radio", { name: "All changes" })).toBeFocused();
    const pending = page.getByTestId("reference-pending");
    await pending.focus();
    await page.keyboard.press("Enter");
    await expect(pending).toBeFocused();
    await expect(pending).toHaveAttribute("aria-disabled", "true");
    await expect(pending.getByRole("progressbar")).toBeVisible();
    await page.getByTestId("reference-primary").click();
    await expect(page.getByText("Actions: 1", { exact: true })).toBeVisible();
  });

  test("editor keeps title and actions reachable while only its body scrolls", async ({ page }) => {
    await openReference(page, 900);
    await page.setViewportSize({ width: 900, height: 460 });
    await page.getByRole("button", { name: "Open editor", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Reference editor" });
    const draft = dialog.getByRole("textbox", { name: "Draft" });
    await draft.fill("Keep this draft");
    await expect(dialog.getByRole("heading", { name: "Reference editor" })).toBeVisible();
    for (const name of ["Cancel", "Done"]) {
      const bounds = (await dialog.getByRole("button", { name, exact: true }).boundingBox())!;
      expect(bounds.y).toBeGreaterThanOrEqual(0);
      expect(bounds.y + bounds.height).toBeLessThanOrEqual(460);
    }
    expect(await dialog.locator(".overflow-y-auto").evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true);
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Open editor", exact: true })).toBeFocused();
    await page.getByRole("button", { name: "Open editor", exact: true }).click();
    await expect(page.getByRole("textbox", { name: "Draft" })).toHaveValue("Keep this draft");
  });
});

test.describe("shared control contracts with a coarse pointer", () => {
  test.use({ hasTouch: true });
  for (const width of [390, 1280]) {
    test(`touch layouts retain full targets at ${width}px`, async ({ page }) => {
      await openReference(page, width);
      await expectFormSizes(page, 44);
      await expectButtonTargets(page, true);
      await expectCheckboxTouchTarget(page);
    });
  }
});
