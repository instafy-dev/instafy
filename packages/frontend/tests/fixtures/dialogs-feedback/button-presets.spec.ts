import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";

const baseline = process.env.INSTAFY_REVIEW_CAPTURE === "before";
const fixture = "/tests/fixtures/dialogs-feedback/index.html";

async function geometry(button: Locator, kind: "inline" | "form", coarse: boolean) {
  await expect(button).toBeVisible();
  if (baseline) return;
  const style = await button.evaluate(element => {
    const computed = getComputedStyle(element);
    return { fontSize: computed.fontSize, radius: computed.borderRadius, shadow: computed.boxShadow, height: element.getBoundingClientRect().height, minHeight: computed.minHeight, coarse: matchMedia("(pointer: coarse)").matches };
  });
  expect(style.fontSize).toBe("14px");
  expect(style.radius).toBe("12px");
  expect(style.shadow).toBe("none");
  if (coarse) expect(style.height, JSON.stringify(style)).toBeGreaterThanOrEqual(44);
  else expect(style.height).toBe(kind === "inline" ? 32 : 36);
}

async function widthFits(page: Page, locator: Locator) {
  const bounds = (await locator.boundingBox())!;
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(page.viewportSize()!.width);
}

async function keyboardFocus(page: Page, button: Locator) {
  await button.focus();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Shift+Tab");
  await expect(button).toBeFocused();
  await expect(button).toHaveAttribute("data-focus-visible", "true");
}

async function capture(target: Page | Locator, info: TestInfo, name: string) {
  const folder = process.env.INSTAFY_REVIEW_SCREENSHOTS;
  if (folder) await fs.mkdir(folder, { recursive: true });
  const options = { path: folder ? path.join(folder, name) : info.outputPath(name), animations: "disabled" as const };
  await target.screenshot(options);
}

async function chooseTheme(page: Page, theme: string) {
  await page.getByRole("radiogroup", { name: "Theme" }).getByText(theme, { exact: true }).click();
}

for (const { width, hasTouch } of [{ width: 390, hasTouch: true }, { width: 1280, hasTouch: false }]) {
  test.describe(`action presets ${width}px`, () => {
    test.use({ hasTouch });
    for (const theme of ["Light", "Dark"]) test(`${theme} production actions and pending behavior`, async ({ page }, info) => {
      const errors: string[] = [];
      page.on("pageerror", error => errors.push(error.message));
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`${fixture}?panel=feedback`);
      await chooseTheme(page, theme);
      const prefix = `${width}-${theme.toLowerCase()}`;
      const apply = page.getByTestId("org-invite-role-conflict-apply");
      const keep = page.getByTestId("org-invite-role-conflict-dismiss");
      await geometry(apply, "inline", hasTouch);
      await geometry(keep, "inline", hasTouch);
      await geometry(page.getByTestId("org-member-invite-submit"), "form", hasTouch);
      await capture(page, info, `${prefix}-conflict.png`);
      await capture(page.getByTestId("org-invite-role-conflict"), info, `${prefix}-conflict-detail.png`);
      await keyboardFocus(page, keep);
      await page.keyboard.press("Enter");
      await expect(apply).toHaveCount(0);
      await page.getByTestId("feedback-scenarios").getByRole("button", { name: "Pending", exact: true }).click();
      await expect(apply).toBeDisabled();
      await expect(keep).toBeDisabled();
      await apply.evaluate(element => (element as HTMLButtonElement).click());
      await expect(page.getByTestId("org-invite-role-conflict")).toBeVisible();

      await page.getByTestId("feedback-scenarios").getByRole("button", { name: "Members", exact: true }).click();
      const review = page.getByTestId("org-invitations-toggle");
      const manage = page.getByTestId("org-members-toggle");
      await geometry(review, "inline", hasTouch);
      await geometry(manage, "inline", hasTouch);
      await review.click();
      await manage.click();
      const cancel = page.getByTestId("org-invite-cancel-review-pending");
      const remove = page.getByTestId("org-member-remove-review-teammate");
      await geometry(cancel, "inline", hasTouch);
      await geometry(remove, "inline", hasTouch);
      // Chromium's full-page capture changes touch emulation in this runner.
      // Keep the real viewport and scroll the actual list actions into view.
      await review.evaluate(element => window.scrollTo(0, element.getBoundingClientRect().top + window.scrollY - 16));
      await capture(page, info, `${prefix}-members.png`);
      await keyboardFocus(page, cancel);
      await page.keyboard.press("Enter");
      await expect(cancel).toBeDisabled();
      await expect(cancel).toHaveText("Canceling…");
      await expect(page.getByTestId("org-invite-role-review-pending")).toBeDisabled();
      await cancel.evaluate(element => (element as HTMLButtonElement).click());
      await expect(page.getByTestId("feedback-action-count")).toHaveText("1");
      await keyboardFocus(page, remove);
      await page.keyboard.press("Enter");
      await expect(remove).toBeDisabled();
      await expect(remove).toHaveText("Removing…");
      await expect(page.getByTestId("org-member-role-review-teammate")).toBeDisabled();
      await remove.evaluate(element => (element as HTMLButtonElement).click());
      await expect(page.getByTestId("feedback-action-count")).toHaveText("2");

      await page.getByRole("button", { name: "Dialogs", exact: true }).click();
      await page.getByTestId("open-invite").click();
      const invite = page.getByTestId("chat-invite-modal");
      const add = page.getByTestId("composer-invite-chat-list").getByRole("button", { name: "Add", exact: true });
      await geometry(page.getByTestId("composer-device-handoff-copy"), "inline", hasTouch);
      await geometry(add, "inline", hasTouch);
      await geometry(page.getByTestId("composer-invite-email-submit"), "form", hasTouch);
      await page.getByTestId("composer-invite-email-input").fill("new-teammate@example.test");
      await add.scrollIntoViewIfNeeded();
      await capture(page, info, `${prefix}-invite.png`);
      await keyboardFocus(page, add);
      await page.keyboard.press("Enter");
      await expect(add).toBeDisabled();
      await expect(page.getByTestId("review-status")).toContainText("Add Taylor Morgan selected");
      await page.getByRole("button", { name: "Close invite modal", exact: true }).click();
      await expect(invite).toHaveCount(0);

      await page.getByTestId("open-agent").click();
      const save = page.getByTestId("agent-profile-save");
      const footerCancel = page.getByTestId("agent-profile-modal").getByRole("button", { name: "Cancel", exact: true });
      await geometry(save, "form", hasTouch);
      await geometry(footerCancel, "form", hasTouch);
      await capture(page, info, `${prefix}-agent-footer.png`);
      await keyboardFocus(page, save);
      await page.keyboard.press("Enter");
      await expect(save).toBeDisabled();
      await expect(footerCancel).toBeDisabled();
      await expect(page.getByTestId("agent-profile-modal")).toHaveCount(0);
      await expect(page.getByTestId("review-status")).toContainText("Agent saved");
      expect(errors).toEqual([]);
    });
  });
}

for (const { width, hasTouch } of [{ width: 390, hasTouch: false }, { width: 1280, hasTouch: true }]) {
  test.describe(`pointer density ${width}px ${hasTouch ? "coarse" : "fine"}`, () => {
    test.use({ hasTouch });
    test("follows the pointer independently of screen width", async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`${fixture}?panel=feedback`);
      expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(hasTouch);
      await geometry(page.getByTestId("org-invite-role-conflict-apply"), "inline", hasTouch);
      await geometry(page.getByTestId("org-member-invite-submit"), "form", hasTouch);
      if (!baseline) {
        await page.evaluate(() => { document.documentElement.style.fontSize = "20px"; });
        const primaryHeight = (await page.getByTestId("org-invite-role-conflict-apply").boundingBox())!.height;
        await page.getByTestId("feedback-scenarios").getByRole("button", { name: "Members", exact: true }).click();
        await page.getByTestId("org-invitations-toggle").click();
        expect((await page.getByTestId("org-invite-cancel-review-pending").boundingBox())!.height).toBe(primaryHeight);
        expect(primaryHeight).toBeGreaterThan(hasTouch ? 44 : 32);
      }
      await page.goto(`${fixture}?panel=actions`);
      const inline = page.getByTestId("text-inline-preset");
      await geometry(inline, "inline", hasTouch);
      await geometry(page.getByTestId("text-form-preset"), "form", hasTouch);
      await keyboardFocus(page, inline);
      await page.keyboard.press("Enter");
      await expect(page.getByTestId("review-status")).toContainText("Inline text action selected");
    });
  });
}

for (const hasTouch of [false, true]) test.describe(`320px ${hasTouch ? "touch" : "mouse"} action wrapping`, () => {
  test.use({ hasTouch });
  test("keeps conflict, member and pending actions inside the available width", async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 568 });
    await page.goto(`${fixture}?panel=feedback&long=1`);
    await widthFits(page, page.getByTestId("org-invite-role-conflict-apply"));
    await widthFits(page, page.getByTestId("org-invite-role-conflict-dismiss"));
    await page.getByTestId("feedback-scenarios").getByRole("button", { name: "Members", exact: true }).click();
    await page.getByTestId("org-invitations-toggle").click();
    await page.getByTestId("org-members-toggle").click();
    const cancel = page.getByTestId("org-invite-cancel-review-pending");
    const remove = page.getByTestId("org-member-remove-review-teammate");
    await widthFits(page, cancel);
    await widthFits(page, remove);
    await cancel.click();
    await expect(cancel).toHaveText("Canceling…");
    await widthFits(page, cancel);
    await remove.click();
    await expect(remove).toHaveText("Removing…");
    await widthFits(page, remove);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
  });
});
