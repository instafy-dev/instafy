import { expect, test, type Page } from "@playwright/test";
const fixture = "/tests/fixtures/browser-picker-review/index.html";
async function expectControlsInside(page: Page, testId: string) {
  const container = page.getByTestId(testId);
  const box = await container.boundingBox();
  expect(box).not.toBeNull();
  const bounds = await container.locator("button:visible, select:visible").evaluateAll(elements => elements.map(element => {
    const box = element.getBoundingClientRect();
    return { left: box.left, right: box.right, top: box.top, bottom: box.bottom };
  }));
  for (const control of bounds) {
    expect(control.left).toBeGreaterThanOrEqual(box!.x - 1);
    expect(control.right).toBeLessThanOrEqual(box!.x + box!.width + 1);
  }
  expect(box!.x + box!.width).toBeLessThanOrEqual(page.viewportSize()!.width + 1);
}
for (const width of [320, 390, 1280]) for (const theme of ["light", "dark"]) {
  test.describe(`${width}px ${theme}`, () => {
    test.use({ viewport: { width, height: width < 768 ? 844 : 900 }, hasTouch: width < 768, isMobile: width < 768 });
    test("native tab picker retains full option labels and switches the active page", async ({ page }) => {
      await page.goto(`${fixture}?theme=${theme}`);
      const select = page.getByTestId("shared-browser-page-select");
      await expect(select).toHaveJSProperty("tagName", "SELECT");
      await expect(select.locator("option")).toHaveCount(3);
      await expect(select.locator('option[value="research"]')).toContainText("Octo");
      await expect(select.locator('option[value="design"]')).toContainText("kept");
      await select.selectOption("design");
      await expect(page.getByTestId("review-event")).toHaveText("Selected design");
      await expect(select).toHaveValue("design");
      if (width < 768) await expect(page.getByTestId("shared-browser-address-trigger")).toContainText("https://example.test/design");
      else await expect(page.getByTestId("shared-browser-address")).toHaveValue("https://example.test/design");
      await expectControlsInside(page, "shared-browser-chrome");
      const target = await select.boundingBox();
      expect(target!.height).toBeGreaterThanOrEqual(width < 768 ? 44 : 32);
    });
    test("without input authority the picker cannot change tabs", async ({ page }) => {
      await page.goto(`${fixture}?theme=${theme}&authority=none`);
      const select = page.getByTestId("shared-browser-page-select");
      await expect(select).toBeDisabled();
      await expect(page.getByTestId(width < 768 ? "shared-browser-address-trigger" : "shared-browser-address")).toBeDisabled();
      await expect(select).toHaveValue("project");
      await expect(page.getByTestId("review-event")).toHaveText("No action yet");
      await expectControlsInside(page, "shared-browser-chrome");
    });
    test("Reconnect stays pending once, recovers a frame and preserves view-only authority", async ({ page }) => {
      await page.goto(`${fixture}?theme=${theme}&surface=recovery&state=reconnecting`);
      const reconnect = page.getByTestId("local-tab-reconnect");
      await expect(reconnect).toBeVisible();
      await reconnect.focus(); await page.keyboard.press("Enter");
      await expect.poll(() => page.evaluate(() => window.__browserPickerReview.attempts)).toBe(2);
      await expect(reconnect).toBeFocused();
      if (await reconnect.count()) await expect(reconnect).toBeDisabled();
      await page.keyboard.press("Enter");
      expect(await page.evaluate(() => window.__browserPickerReview.attempts)).toBe(2);
      await page.evaluate(() => window.__browserPickerReview.resume());
      const image = page.getByTestId("local-browser-share-image");
      await expect(image).toBeVisible();
      await expect(image).toHaveJSProperty("complete", true);
      await expect(reconnect).toBeHidden();
      await expect(page.getByRole("button", { name: "Choose shared tab view" })).toBeFocused();
      await expect(page.getByRole("button", { name: "Choose shared tab view" })).toContainText("Following");
      expect(await page.evaluate(() => window.__browserPickerReview.commands.filter(value => value.type === "input"))).toEqual([]);
      await expectControlsInside(page, "local-tab-toolbar");
      await page.getByRole("button", { name: "Leave shared tab" }).click();
      await expect(page.getByTestId("local-browser-share-viewer")).toBeHidden();
      await expect(page.getByTestId("review-event")).toHaveText("Left shared tab");
    });
  });
}
test("desktop native picker supports keyboard selection", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(fixture);
  const select = page.getByTestId("shared-browser-page-select");
  await select.focus();
  // Native type-ahead exercises keyboard selection without depending on the
  // operating system popup, which headless macOS Chrome does not drive.
  await page.keyboard.press("o");
  await expect(select).toHaveValue("research");
  await expect(page.getByTestId("review-event")).toHaveText("Selected research");
});
test("a narrow pane in a wide screen keeps tab and recovery controls inside", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${fixture}?layout=split&theme=dark`);
  await expect(page.getByTestId("shared-browser-tabs-picker")).toBeVisible();
  await expectControlsInside(page, "shared-browser-chrome");
  await page.goto(`${fixture}?layout=split&theme=dark&surface=recovery&state=closed`);
  await expect(page.getByTestId("local-tab-reconnect")).toBeVisible();
  await expectControlsInside(page, "local-browser-share-viewer");
});
test("closing while reconnecting does not reopen a late connection", async ({ page }) => {
  await page.goto(`${fixture}?surface=recovery&state=reconnecting`);
  await page.getByTestId("local-tab-reconnect").click();
  await expect.poll(() => page.evaluate(() => window.__browserPickerReview.attempts)).toBe(2);
  await page.getByRole("button", { name: "Leave shared tab" }).click();
  await page.evaluate(() => window.__browserPickerReview.resume());
  await expect(page.getByTestId("local-browser-share-viewer")).toBeHidden();
  await expect(page.getByTestId("review-event")).toHaveText("Left shared tab");
});
test("reconnect checks the current share instead of restoring revoked access", async ({ page }) => {
  await page.goto(`${fixture}?surface=recovery&state=closed`);
  await page.getByTestId("local-tab-reconnect").waitFor();
  await page.evaluate(() => { window.__browserPickerReview.ended = true; });
  await page.getByTestId("local-tab-reconnect").click();
  await expect(page.getByTestId("review-event")).toHaveText("Share ended: review-share");
  expect(await page.evaluate(() => window.__browserPickerReview.attempts)).toBe(1);
  await expect(page.getByTestId("local-tab-reconnect")).toBeHidden();
  await expect(page.getByTestId("local-browser-share-image")).toBeHidden();
});

for (const theme of ["light", "dark"]) test.describe(`320px enlarged text ${theme}`, () => {
  test.use({ viewport: { width: 320, height: 480 }, hasTouch: true, isMobile: true });
  test("native picker fits at 150% text", async ({ page }) => {
    await page.goto(`${fixture}?theme=${theme}&text=large`);
    await expectControlsInside(page, "shared-browser-chrome");
    await page.getByTestId("shared-browser-page-select").selectOption("research");
    await expect(page.getByTestId("review-event")).toHaveText("Selected research");
  });
  test("recovery and pending action fit with enlarged text", async ({ page }) => {
    await page.goto(`${fixture}?theme=${theme}&text=large&surface=recovery&state=reconnecting`);
    const reconnect = page.getByTestId("local-tab-reconnect");
    await expect(reconnect).toBeVisible();
    await expectControlsInside(page, "local-browser-share-viewer");
    const feedback = page.getByTestId("local-tab-connection-feedback");
    expect(await feedback.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
    await reconnect.focus(); await page.keyboard.press("Enter");
    await expect(reconnect).toBeDisabled();
    await expect(reconnect).toBeFocused();
    await expectControlsInside(page, "local-browser-share-viewer");
    expect(await feedback.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
  });
});
