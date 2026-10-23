import { expect, test } from "@playwright/test";

const fixture = "/tests/fixtures/style-followups-controls/index.html";
for (const pointer of ["touch", "mouse"] as const) {
  test(`${pointer}: narrow panes retain mode text and expose Release in More`, async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: pointer === "touch" ? 320 : 1440, height: 900 }, hasTouch: pointer === "touch" });
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:5242${fixture}?surface=shared-tab&state=control&pane=300`);
    await expect(page.getByTestId("local-browser-share-image")).toBeVisible();
    const toolbar = page.getByTestId("local-tab-toolbar");
    const mode = page.getByTestId("local-tab-view-mode");
    await expect(mode).toContainText("You control");
    await expect.poll(() => mode.locator("span").first().evaluate(label => label.scrollWidth <= label.clientWidth)).toBe(true);
    expect(await toolbar.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    await expect(toolbar.getByRole("button", { name: "Release control", exact: true })).toHaveCount(0);
    if (pointer === "touch") {
      await page.getByRole("button", { name: "Open remote keyboard", exact: true }).click();
      await expect(page.getByRole("textbox", { name: "Type into the focused page field" })).toBeFocused();
      await page.getByRole("button", { name: "Close remote keyboard", exact: true }).click();
    }
    await page.getByRole("button", { name: "Shared tab options", exact: true }).click();
    await page.getByRole("button", { name: "Release control", exact: true }).click();
    await expect(page.getByTestId("review-action-log")).toHaveText("releaseControl");
    await expect(mode).toContainText("Following");
    await expect(page.getByRole("dialog", { name: "Shared tab options" })).toHaveCount(0);
    await context.close();
  });
}

test("wide panes retain inline Release and local request/cancel flow", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${fixture}?surface=shared-tab&state=following`);
  await expect(page.getByTestId("local-browser-share-image")).toBeVisible();
  const options = page.getByRole("button", { name: "Shared tab options", exact: true });
  await options.click();
  await page.getByRole("button", { name: "Request control", exact: true }).click();
  await expect(page.getByTestId("local-tab-view-mode")).toContainText("Control requested");
  await expect(page.getByTestId("review-action-log")).toHaveText("requestControl");
  await options.click();
  await page.getByRole("button", { name: "Cancel control request", exact: true }).click();
  await expect(page.getByTestId("local-tab-view-mode")).toContainText("Following");
  await page.getByRole("button", { name: "Simulate control granted", exact: true }).click();
  await expect(page.getByTestId("local-tab-toolbar").getByRole("button", { name: "Release control", exact: true })).toBeVisible();
  await options.click();
  await expect(page.getByRole("dialog", { name: "Shared tab options" }).getByRole("button", { name: "Release control", exact: true })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(options).toBeFocused();
});
