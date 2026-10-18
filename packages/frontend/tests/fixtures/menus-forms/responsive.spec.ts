import { expect, test, type Locator } from "@playwright/test";
import path from "node:path";
import fs from "node:fs/promises";

const baseline = process.env.INSTAFY_REVIEW_CAPTURE === "before";
for (const { width, hasTouch } of [{ width: 390, hasTouch: true }, { width: 1280, hasTouch: false }, { width: 2560, hasTouch: false }]) {
 test.describe(`${width}px`, () => {
  test.use({ hasTouch });
  for (const theme of ["Light", "Dark"]) test(`${theme} menus and forms`, async ({ page }, testInfo) => {
   const errors: string[] = [];
   page.on("pageerror", error => errors.push(error.message));
   await page.setViewportSize({ width, height: 900 });
   await page.goto("/tests/fixtures/menus-forms/index.html");
   await page.getByRole("radiogroup", { name: "Theme" }).getByText(theme, { exact: true }).click();
   const capture = async (name: string) => {
    const folder = process.env.INSTAFY_REVIEW_SCREENSHOTS;
    if (folder) await fs.mkdir(folder, { recursive: true });
    await page.screenshot({ animations: "disabled", path: folder ? path.join(folder, `${width}-${theme.toLowerCase()}-${name}.png`) : testInfo.outputPath(`${name}.png`) });
   };
   const inViewport = async (locator: Locator) => {
    await expect(locator).toBeVisible();
    const b = (await locator.boundingBox())!;
    expect(b.x).toBeGreaterThanOrEqual(0); expect(b.x + b.width).toBeLessThanOrEqual(width + 1);
   };
   await expect(page.getByText("DEPLOY_PREVIEW_TOKEN", { exact: true })).toBeVisible();
   if (!baseline) expect((await page.getByTestId("secrets-panel").boundingBox())!.width).toBeLessThanOrEqual(896);
   await capture("secrets");
   const create = page.getByTestId("project-secret-create");
   await create.click();
   const name = page.getByTestId("project-secret-name-input");
   await name.fill("LOCAL_REVIEW_KEY");
   await page.getByTestId("project-secret-value-input").fill("inert-review-value");
   await inViewport(page.getByRole("dialog"));
   if (!baseline) {
    const gutter = await name.evaluate(el => el.getBoundingClientRect().x - el.closest('[role="dialog"]')!.getBoundingClientRect().x);
    expect(gutter).toBe(width < 640 ? 16 : 20);
   }
   await capture("secret-editor");
   // Scroll/viewport changes keep the typed draft and Save reachable.
   await page.setViewportSize({ width, height: 420 });
   const save = page.getByTestId("project-secret-save");
   await inViewport(save);
   expect((await save.boundingBox())!.y + (await save.boundingBox())!.height).toBeLessThanOrEqual(420);
   await expect(name).toHaveValue("LOCAL_REVIEW_KEY");
   await page.setViewportSize({ width, height: 900 });
   // Complete a local write and verify return to the list.
   await save.click();
   await expect(page.getByRole("dialog")).toHaveCount(0);
   await expect(page.getByText("LOCAL_REVIEW_KEY", { exact: true })).toBeVisible();
   await page.getByRole("button", { name: "Connections", exact: true }).click();
   await expect(page.getByTestId("credentials-connection-row-credential-1")).toBeVisible();
   await capture("connections");
   if (hasTouch) {
    const menu = page.getByTestId("credentials-connection-menu-credential-1");
    await menu.click();
    await inViewport(page.getByRole("menu"));
    await capture("connection-menu");
    await page.keyboard.press("Escape");
    await expect(menu).toBeFocused();
   }
   const add = page.getByTestId("credentials-add-connection");
   await add.click();
   await page.getByRole("dialog").getByText("OpenAI API key", { exact: true }).click();
   const key = page.getByTestId("credentials-openai-api-key-input");
   await key.fill("inert-key-draft");
   await capture("connection-form");
   await page.setViewportSize({ width, height: 420 });
   const connect = page.getByTestId("credentials-openai-connect");
   if (!baseline) {
    await inViewport(connect);
    expect((await connect.boundingBox())!.y + (await connect.boundingBox())!.height).toBeLessThanOrEqual(420);
   }
   await expect(key).toHaveValue("inert-key-draft");
   await page.setViewportSize({ width, height: 900 });
   await page.getByRole("button", { name: "Back", exact: true }).click();
   await expect(page.getByRole("dialog").getByText("DeepSeek API key", { exact: true })).toBeVisible();
   await page.getByRole("button", { name: "Close", exact: true }).click();
   await expect(page.getByRole("dialog")).toHaveCount(0);
   await expect(add).toBeFocused();
   await page.getByRole("button", { name: "Pickers", exact: true }).click();
   const select = page.getByRole("button", { name: /Connection scope/ });
   await select.click();
   await inViewport(page.getByRole("listbox"));
   await capture("picker");
   await page.getByRole("option", { name: "All team spaces", exact: true }).click();
   await expect(select).toBeFocused();
   await expect(select).toHaveAttribute("data-value", "team");
   await expect(select).toContainText("All team spaces");
   expect(errors).toEqual([]);
  });
 });
}

test("narrow error recovery and long text stay within the viewport", async ({ page }) => {
 await page.setViewportSize({ width: 320, height: 568 });
 await page.goto("/tests/fixtures/menus-forms/index.html?error=1&long=1");
 await expect(page.getByRole("alert")).toContainText("Couldn't load secrets");
 await expect(page.getByRole("button", { name: "Retry", exact: true })).toBeVisible();
 await page.getByRole("button", { name: "Retry", exact: true }).click();
 await expect(page.getByRole("alert")).toHaveCount(0);
 await expect(page.getByText("DEPLOY_PREVIEW_TOKEN_FOR_SHARED_REVIEW_ENVIRONMENTS", { exact: true })).toBeVisible();
 expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
});

test.describe("mobile connection recovery", () => {
 test.use({ hasTouch: true });
 test("keeps connection checks in the row and the menu limited to actions", async ({ page }, testInfo) => {
  test.skip(baseline, "The baseline does not expose API-key replacement on mobile.");
  await page.setViewportSize({ width: 390, height: 900 });
  await page.goto("/tests/fixtures/menus-forms/index.html?panel=connections&slowTest=1");
  const trigger = page.getByTestId("credentials-connection-menu-credential-2");
  const row = page.getByTestId("credentials-connection-row-credential-2");
  const guidance = "Review connection could not be verified. Retry with a valid key.";
  const capture = async (name: string) => {
   const folder = process.env.INSTAFY_REVIEW_SCREENSHOTS;
   if (folder) await fs.mkdir(folder, { recursive: true });
   await page.screenshot({ animations: "disabled", path: folder ? path.join(folder, `390-light-${name}.png`) : testInfo.outputPath(`${name}.png`) });
  };
  const expectReadable = async (text: Locator) => {
   await expect(text).toBeVisible();
   const metrics = await text.evaluate(el => ({ width: el.getBoundingClientRect().width, height: el.getBoundingClientRect().height, scrollWidth: el.scrollWidth, scrollHeight: el.scrollHeight }));
   expect(metrics.height).toBeGreaterThan(20);
   expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.width + 1);
   expect(metrics.scrollHeight).toBeLessThanOrEqual(metrics.height + 1);
  };
  await trigger.click();
  const menu = page.getByRole("menu");
  const actions = ["Make default", "Test", "Replace…", "Remove…"];
  await expect(menu.getByRole("menuitem")).toHaveText(actions);
  await page.getByRole("menuitem", { name: "Test", exact: true }).click();
  await expect(menu).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await expect(row.getByRole("status")).toHaveText("Testing…");
  await capture("connection-testing-row");
  await trigger.click();
  await expect(menu.getByRole("menuitem")).toHaveText(actions);
  await expect(page.getByRole("menuitem", { name: "Test", exact: true })).toBeDisabled();
  await expect(page.getByRole("menuitem", { name: "Replace…", exact: true })).toBeDisabled();
  await expect(menu.getByRole("status")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
  await expect(row.getByRole("status")).toContainText(guidance, { timeout: 10000 });
  await expectReadable(row.getByText(guidance, { exact: true }));
  await capture("connection-failure-row");
  await trigger.click();
  await expect(menu.getByRole("menuitem")).toHaveText(actions);
  await expect(menu.getByText(guidance, { exact: true })).toHaveCount(0);
  await expect(page.getByRole("menuitem", { name: "Test", exact: true })).toBeEnabled();
  await expect(page.getByRole("menuitem", { name: "Replace…", exact: true })).toBeEnabled();
  await capture("connection-compact-menu");
  await page.getByRole("menuitem", { name: "Replace…", exact: true }).click();
  await expect(page.getByTestId("credentials-gemini-api-key-input")).toBeVisible();
  await expect(page.getByTestId("credentials-openai-api-key-input")).toHaveCount(0);
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(trigger).toBeFocused();
 });
});
