import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";

// Run against the isolated fixture server, never a signed-in live application.
const origin = process.env.AUTOMATION_REVIEW_ORIGIN ?? "http://127.0.0.1:5238";
assert.match(origin, /^http:\/\/(127\.0\.0\.1|localhost):\d+$/);
const browser = await chromium.launch();
let checks = 0;
const errors = [];
async function open(page, { theme = "light", save = "success" } = {}) {
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/*", route => {
    const target = new URL(route.request().url());
    if (target.origin !== origin) return route.abort();
    return route.continue();
  });
  await page.goto(`${origin}/tests/fixtures/style-followups-automation/index.html?theme=${theme}&save=${save}`);
  await page.getByRole("button", { name: "Automation actions", exact: true }).click();
  await page.getByRole("menuitem", { name: "Edit", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Automation editor", exact: true })).toBeVisible();
}
try {
  for (const [width, height, theme] of [[1440, 900, "light"], [1440, 900, "dark"], [390, 844, "light"], [390, 844, "dark"], [320, 568, "light"], [1440, 420, "dark"]]) {
    const page = await browser.newPage({ viewport: { width, height }, hasTouch: width < 640 });
    await open(page, { theme });
    const dialog = page.getByRole("dialog", { name: "Automation editor", exact: true });
    const bounds = await dialog.boundingBox();
    assert(bounds && bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= width + 1 && bounds.y + bounds.height <= height + 1);
    const save = page.getByTestId("automation-save-button");
    const saveBounds = await save.boundingBox();
    assert(saveBounds && saveBounds.y >= 0 && saveBounds.y + saveBounds.height <= height + 1);
    assert(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth + 1));
    await page.getByText("Once", { exact: true }).click();
    await expect(page.getByTestId("automation-runat-input")).toBeVisible();
    await page.getByText("Interval", { exact: true }).click();
    await expect(page.getByTestId("automation-interval-input")).toHaveValue("4");
    await page.getByText("Weekly", { exact: true }).click();
    await page.getByRole("button", { name: "Saturday", exact: true }).click();
    await expect(page.getByRole("button", { name: "Saturday", exact: true })).toHaveAttribute("aria-pressed", "true");
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "Unfinished work", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Keep editing", exact: true }).click();
    await expect(page.getByRole("button", { name: "Saturday", exact: true })).toHaveAttribute("aria-pressed", "true");
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await page.getByRole("button", { name: "Discard and leave", exact: true }).click();
    await expect(dialog).not.toBeVisible();
    console.log(`PASS ${width}x${height} ${theme}: viewport, scrolling, schedules, dirty dismissal`);
    checks += 1;
    await page.close();
  }
  for (const width of [390, 1440]) {
    for (const mode of ["error", "pending"]) {
      const page = await browser.newPage({ viewport: { width, height: 844 }, hasTouch: width < 640 });
      await open(page, { save: mode });
      const dialog = page.getByRole("dialog", { name: "Automation editor", exact: true });
      await page.getByTestId("automation-name-input").fill("Preserve this draft");
      await page.getByTestId("automation-save-button").click();
      if (mode === "error") {
        await expect(page.getByTestId("status-toast")).toContainText("Could not save automation");
        await expect(page.getByTestId("automation-name-input")).toHaveValue("Preserve this draft");
        await expect(page.getByTestId("automation-save-button")).toBeEnabled();
      } else {
        await expect(page.getByTestId("automation-save-button")).toBeDisabled();
        await expect(dialog.getByRole("button", { name: "Cancel", exact: true })).toBeDisabled();
        await expect(dialog.getByRole("button", { name: "Close automation editor", exact: true })).toBeDisabled();
        await page.keyboard.press("Escape");
        await expect(dialog).toBeVisible();
        await page.evaluate(() => window.dispatchEvent(new Event("review:complete-save")));
        await expect(dialog).not.toBeVisible();
        await expect(page.getByTestId("automation-row-review-automation")).toContainText("Preserve this draft");
      }
      console.log(`PASS ${width}px ${mode}: draft/save safeguards`);
      checks += 1;
      await page.close();
    }
  }
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true });
  await open(page);
  await page.getByTestId("automation-prompt-input").focus();
  for (const height of [400, 220]) {
    await page.setViewportSize({ width: 390, height });
    await page.getByTestId("automation-runtime-provider-input").fill("fixture-only");
    await page.getByTestId("automation-save-button").scrollIntoViewIfNeeded();
    await page.getByTestId("automation-save-button").click();
    await expect(page.getByRole("dialog", { name: "Automation editor", exact: true })).not.toBeVisible();
    console.log(`PASS 390x${height}: short viewport footer remains reachable and save works`);
    checks += 1;
    if (height === 400) { await page.setViewportSize({ width: 390, height: 844 }); await open(page); }
  }
  await page.close();
  assert.deepEqual(errors, [], "Unexpected browser errors");
  console.log(`${checks} responsive/editor flows passed`);
} finally {
  await browser.close();
}
