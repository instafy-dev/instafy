import { expect, test, type Page } from "@playwright/test";
const fixture = "/tests/fixtures/browser-address-review/index.html";
const current = "https://workspace.example.test/project";
async function openAddress(page: Page) {
  const trigger = page.getByTestId("shared-browser-address-trigger");
  if (await trigger.count()) await trigger.click();
  const input = page.getByTestId("shared-browser-address");
  await expect(input).toBeVisible();
  await input.focus();
  return input;
}
async function noNavigation(page: Page) {
  expect(await page.evaluate(() => window.__browserAddressReview.navigations)).toEqual([]);
}
async function controlsFit(page: Page) {
  const width = page.viewportSize()!.width;
  const controls = await page.locator('input:visible, button:visible, [role="option"]:visible').evaluateAll(elements => elements.map(element => {
    const box = element.getBoundingClientRect(); return { left: box.left, right: box.right, width: box.width, label: element.getAttribute("aria-label") ?? element.textContent };
  }));
  for (const control of controls) { expect(control.left, control.label ?? "").toBeGreaterThanOrEqual(-1); expect(control.right, control.label ?? "").toBeLessThanOrEqual(width + 1); }
}
for (const width of [320, 390]) for (const theme of ["light", "dark"]) test.describe(`phone ${width} ${theme}`, () => {
  test.use({ viewport: { width, height: 844 }, isMobile: true, hasTouch: true });
  test("invalid input stays editable, corrected Go navigates once and closes", async ({ page }) => {
    await page.goto(`${fixture}?theme=${theme}`); const input = await openAddress(page);
    await input.fill("file:///private/notes.txt");
    await page.getByRole("button", { name: "Go", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "Enter an address" })).toBeVisible();
    await expect(input).toHaveAttribute("aria-invalid", "true");
    await noNavigation(page);
    await input.fill("example.test/corrected");
    await expect(input).not.toHaveAttribute("aria-invalid", "true");
    await page.getByRole("button", { name: "Go", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "Enter an address" })).toBeHidden();
    expect(await page.evaluate(() => window.__browserAddressReview.navigations)).toEqual(["https://example.test/corrected"]);
    await expect(page.getByTestId("shared-browser-address-trigger")).toContainText("https://example.test/corrected");
  });
  test("Clear preserves input focus; recent history clears without navigation", async ({ page }) => {
    await page.goto(`${fixture}?theme=${theme}`); const input = await openAddress(page);
    await page.getByRole("button", { name: "Clear address", exact: true }).click();
    await expect(input).toBeFocused(); await expect(input).toHaveValue("");
    await expect(page.getByRole("option")).toHaveCount(8);
    await controlsFit(page);
    const field = await input.boundingBox(); expect(field!.height).toBeGreaterThanOrEqual(44);
    expect(await input.evaluate(node => parseFloat(getComputedStyle(node).fontSize))).toBeGreaterThanOrEqual(16);
    await page.getByRole("button", { name: "Clear recent sites", exact: true }).click();
    await expect(input).toBeFocused(); await expect(page.getByRole("option")).toHaveCount(0);
    await expect(input).toBeFocused();
    expect(await page.evaluate(() => localStorage.getItem(window.__browserAddressReview.historyKey))).toBeNull();
    await noNavigation(page);
  });
  test("Back cancels draft and restores the current page", async ({ page }) => {
    await page.goto(`${fixture}?theme=${theme}`); const input = await openAddress(page);
    await input.fill("unfinished.example.test");
    await page.getByTestId("shared-browser-address-editor").getByRole("button", { name: "Back", exact: true }).click();
    const trigger = page.getByTestId("shared-browser-address-trigger");
    await expect(trigger).toHaveAttribute("aria-expanded", "false"); await expect(trigger).toContainText(current);
    await expect(trigger).toBeFocused(); await noNavigation(page);
  });
  test("losing input control releases editor and discards unsent draft", async ({ page }) => {
    await page.goto(`${fixture}?theme=${theme}`); const input = await openAddress(page);
    await input.fill("unfinished.example.test");
    await page.evaluate(() => window.__browserAddressReview.setControl(false));
    await expect(page.getByRole("dialog", { name: "Enter an address" })).toBeHidden();
    const trigger = page.getByTestId("shared-browser-address-trigger");
    await expect(trigger).toBeDisabled(); await expect(trigger).toContainText(current); await noNavigation(page);
  });
});
for (const theme of ["light", "dark"]) test.describe(`desktop ${theme}`, () => {
  test.use({ viewport: { width: 1280, height: 900 } });
  test("title filtering and ArrowDown Enter navigate exactly the chosen page", async ({ page }) => {
    await page.goto(`${fixture}?theme=${theme}`); const input = await openAddress(page);
    await input.fill("design"); await expect(page.getByRole("option")).toHaveCount(2);
    const first = page.getByRole("option").first();
    await expect(first).toHaveAccessibleName("Design system foundations — Color, typography, spacing and accessible interaction patterns");
    await expect(first).toHaveAccessibleDescription("design.example.test/docs/foundations/typography-and-layout?review=international-accessibility");
    await input.press("ArrowDown"); await input.press("Enter");
    await expect(page.getByTestId("review-event")).toContainText("https://design.example.test/docs/foundations/");
    expect(await page.evaluate(() => window.__browserAddressReview.navigations.length)).toBe(1);
    await expect(page.getByRole("listbox", { name: "Recent sites" })).toBeHidden();
  });
  test("Tab from a highlighted suggestion never navigates", async ({ page }) => {
    await page.goto(`${fixture}?theme=${theme}`); const input = await openAddress(page);
    await input.fill("design"); await expect(page.getByRole("option")).toHaveCount(2);
    await input.press("ArrowDown"); await input.press("Tab"); await noNavigation(page);
  });
  test("Escape dismisses suggestions without changing the page", async ({ page }) => {
    await page.goto(`${fixture}?theme=${theme}`); const input = await openAddress(page);
    await input.fill(""); await expect(page.getByRole("option")).toHaveCount(8);
    await input.press("Escape"); await expect(page.getByRole("listbox", { name: "Recent sites" })).toBeHidden();
    await expect(input).toBeFocused(); await noNavigation(page);
  });
  test("history footer supports reverse Tab, Escape and forward Tab without trapping focus", async ({ page }) => {
    await page.goto(`${fixture}?theme=${theme}`); const input = await openAddress(page);
    await input.fill(""); const clear = page.getByRole("button", { name: "Clear recent sites", exact: true });
    await input.press("Tab"); await expect(clear).toBeFocused();
    await page.keyboard.press("Shift+Tab"); await expect(input).toBeFocused();
    await expect(page.getByRole("listbox", { name: "Recent sites" })).toBeVisible();
    await input.press("Tab"); await expect(clear).toBeFocused();
    await page.keyboard.press("Escape"); await expect(input).toBeFocused();
    await expect(page.getByRole("listbox", { name: "Recent sites" })).toBeHidden();
    await input.press("ArrowDown"); await expect(clear).toBeVisible();
    await input.press("Tab"); await expect(clear).toBeFocused();
    await page.keyboard.press("Tab"); await expect(page.getByTestId("next-control")).toBeFocused();
    await expect(page.getByRole("listbox", { name: "Recent sites" })).toBeHidden();
    await noNavigation(page);
  });
  test("Clear recent sites is reachable and operable from the keyboard", async ({ page }) => {
    await page.goto(`${fixture}?theme=${theme}`); const input = await openAddress(page);
    await input.fill(""); const clear = page.getByRole("button", { name: "Clear recent sites", exact: true });
    await expect(clear).toBeVisible();
    await input.press("Tab"); await expect(clear).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("option")).toHaveCount(0);
    await expect(input).toBeFocused();
    expect(await page.evaluate(() => localStorage.getItem(window.__browserAddressReview.historyKey))).toBeNull();
    await noNavigation(page);
  });
});
for (const theme of ["light", "dark"]) test.describe(`phone resize and text ${theme}`, () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  test("rotation and keyboard viewport retain draft, focus and selection", async ({ page }) => {
    await page.goto(`${fixture}?theme=${theme}`); const input = await openAddress(page);
    await input.fill("unfinished.example.test"); await input.evaluate(node => node.setSelectionRange(3, 9));
    const handle = await input.elementHandle();
    for (const size of [{ width: 390, height: 300 }, { width: 844, height: 260 }]) {
      await page.setViewportSize(size); await expect(input).toBeFocused(); await expect(input).toHaveValue("unfinished.example.test");
      expect(await input.evaluate((node, original) => node === original, handle)).toBe(true);
      expect(await input.evaluate(node => [node.selectionStart, node.selectionEnd])).toEqual([3, 9]);
      await controlsFit(page);
      const box = await input.boundingBox(); expect(box!.y + box!.height).toBeLessThanOrEqual(size.height);
    }
    await page.getByTestId("shared-browser-address-editor").getByRole("button", { name: "Back", exact: true }).click();
    await expect(page.getByTestId("shared-browser-address-trigger")).toBeHidden();
    await expect(page.getByTestId("shared-browser-address")).toHaveValue(current); await noNavigation(page);
  });
  test("320px enlarged text keeps recent sites and header controls inside", async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 480 });
    await page.goto(`${fixture}?theme=${theme}&text=large`); const input = await openAddress(page);
    await input.fill(""); await expect(page.getByRole("option")).toHaveCount(8); await controlsFit(page);
    const clear = page.getByRole("button", { name: "Clear recent sites", exact: true });
    await clear.scrollIntoViewIfNeeded(); await clear.click(); await expect(input).toBeFocused();
    await noNavigation(page);
  });
});
test("recent sites fit a narrow pane in a wide desktop", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 }); await page.goto(`${fixture}?layout=split&theme=dark`);
  const input = await openAddress(page); await input.fill(""); await expect(page.getByRole("option")).toHaveCount(8);
  const list = await page.getByRole("listbox", { name: "Recent sites" }).boundingBox();
  const pane = await page.getByTestId("review-pane").boundingBox();
  expect(list!.x).toBeGreaterThanOrEqual(pane!.x); expect(list!.x + list!.width).toBeLessThanOrEqual(pane!.x + pane!.width);
  await controlsFit(page);
});

for (const theme of ["light", "dark"]) for (const large of [false, true]) test(`600px mouse trigger fits ${large ? "150%" : "normal"} text ${theme}`, async ({ page }) => {
  await page.setViewportSize({ width: 600, height: 720 });
  await page.goto(`${fixture}?theme=${theme}${large ? "&text=large" : ""}`);
  const trigger = page.getByTestId("shared-browser-address-trigger"); await expect(trigger).toBeVisible();
  const metrics = await trigger.evaluate(node => { const style = getComputedStyle(node); return { height: node.getBoundingClientRect().height, needed: parseFloat(style.lineHeight) + parseFloat(style.paddingTop) + parseFloat(style.paddingBottom) + parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth) }; });
  expect(metrics.height).toBeGreaterThanOrEqual(metrics.needed - 1); await controlsFit(page);
});
