import { expect, test, type Locator, type Page } from "@playwright/test";
import { BROWSER_APPROVAL_FEEDBACK_STUBS } from "../../fixtures/browser-approval-feedback/dataStubs";

const fixture = "/tests/fixtures/browser-approval-feedback/index.html";
const longError = "The browser could not confirm the control change. Your current page and unfinished work are still available. Check your connection and try again before continuing.";
const stopError = "The run could not be stopped. The AI may still be working. Check your connection and retry stopping before starting another task.";

async function configure(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  for (const [path, body] of Object.entries(BROWSER_APPROVAL_FEEDBACK_STUBS)) {
    await page.route(`**${path}*`, route => route.fulfill({ contentType: "application/javascript", body }));
  }
  return errors;
}

async function open(page: Page, surface: string, theme: string, extra = "") {
  await page.goto(`${fixture}?surface=${surface}&theme=${theme}${extra}`, { waitUntil: "domcontentloaded" });
  const touch = page.viewportSize()!.width < 640;
  // Reapply touch emulation after navigation, but leave the desktop context's
  // native mouse alone. Explicitly disabling touch in headless Linux Chromium
  // can report pointer:none instead of restoring pointer:fine.
  if (touch) {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 });
  }
  await expect(page.getByTestId("browser-approval-feedback-review")).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await expect.poll(() => page.evaluate(() => ({
    coarse: matchMedia("(pointer: coarse)").matches,
    fine: matchMedia("(pointer: fine)").matches,
  })), { message: "the browser context has the intended primary pointer before measuring controls" }).toEqual({ coarse: touch, fine: !touch });
}

async function fits(page: Page, locator: Locator) {
  await expect(locator).toBeInViewport({ ratio: 1 });
  const bounds = (await locator.boundingBox())!;
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(page.viewportSize()!.width + 1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}

async function readableError(page: Page, locator: Locator, message = longError) {
  await expect(locator).toContainText(message);
  await locator.scrollIntoViewIfNeeded();
  await fits(page, locator);
  expect(await locator.evaluate(element => element.scrollWidth <= element.clientWidth + 1 && element.scrollHeight <= element.clientHeight + 1)).toBe(true);
}

async function touchTargets(locator: Locator, width: number) {
  if (width >= 640) return;
  for (const target of await locator.all()) {
    await expect.poll(async () => (await target.boundingBox())?.width ?? 0).toBeGreaterThanOrEqual(44);
    await expect.poll(async () => (await target.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
  }
}

async function settleControl(page: Page) {
  await page.evaluate(() => window.dispatchEvent(new Event("review:resolve")));
}

for (const width of [320, 390, 1280]) for (const theme of ["light", "dark"]) {
  test.describe(`${theme} controls at ${width}px`, () => {
    // Set input capabilities on the context before its first document exists,
    // rather than depending on a per-page CDP override surviving navigation.
    test.use({ viewport: { width, height: 844 }, hasTouch: width < 640 });

    test(`browser approvals preserve decisions, focus and readable errors in ${theme} at ${width}px`, async ({ page }) => {
      const errors = await configure(page);
      await open(page, "approval", theme);
      const prompt = page.getByRole("alertdialog");
      const allow = page.getByTestId("shared-browser-approval-allow");
      const deny = page.getByTestId("shared-browser-approval-deny");
      const routine = page.getByTestId("shared-browser-approval-routine");
      await expect(deny).toBeFocused();
      await fits(page, prompt);
      await touchTargets(prompt.getByRole("button"), width);
      await touchTargets(prompt.locator("label").filter({ has: page.getByRole("checkbox") }), width);
      await allow.focus();
      await allow.press("Tab");
      await expect(routine).toBeFocused();
      await routine.press("Shift+Tab");
      await expect(allow).toBeFocused();
      await allow.press("Enter");
      await expect(page.getByTestId("review-decision")).toHaveText("allow_origin");
      await expect(prompt).toHaveCount(0);

      await open(page, "approval", theme, "&pending=1");
      await routine.check();
      await expect(allow).toHaveText("Allow routine browsing");
      await allow.click();
      await expect(page.getByTestId("review-decision")).toHaveText("allow_routine");
      await expect(allow).toBeDisabled();
      await expect(deny).toBeDisabled();
      await expect(routine).toBeDisabled();
      await page.keyboard.press("Escape");
      await expect(prompt).toBeVisible();
      await expect(page.getByTestId("review-decision")).toHaveText("allow_routine");

      await open(page, "action-approval", theme, "&error=1");
      await fits(page, prompt);
      const destination = page.getByTestId("shared-browser-approval-destination");
      await destination.scrollIntoViewIfNeeded();
      expect(await destination.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
      await readableError(page, page.getByTestId("shared-browser-approval-error"));
      await allow.click();
      await expect(page.getByTestId("review-decision")).toHaveText("allow_once");

      await open(page, "approval", theme);
      await expect(deny).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("review-decision")).toHaveText("deny");
      await expect(prompt).toHaveCount(0);
      expect(errors).toEqual([]);
    });

    test(`participant requests keep pending actions and keyboard focus usable in ${theme} at ${width}px`, async ({ page }) => {
      const errors = await configure(page);
      await open(page, "controls", theme, "&pending=1");
      const trigger = page.getByTestId("review-controls-trigger");
      await trigger.click();
      const dialog = page.getByRole("dialog", { name: "Sharing settings", exact: true });
      const owner = page.getByTestId("local-tab-control-owner");
      await fits(page, dialog);
      await touchTargets(dialog.getByRole("button"), width);
      await expect(owner).toContainText("Charlie with a longer display name");
      await page.getByTestId("local-tab-grant-control").first().click();
      await expect(page.getByTestId("review-control-action")).toHaveText("allow:alice-connection");
      for (const button of await owner.getByTestId("local-tab-grant-control").all()) await expect(button).toBeDisabled();
      await expect(page.getByTestId("local-tab-allow-explore")).toBeDisabled();
      await settleControl(page);
      await expect(page.getByTestId("review-control-grant")).toHaveText("alice");
      const takeBack = page.getByTestId("local-tab-take-back");
      await takeBack.click();
      await expect(page.getByTestId("review-control-action")).toHaveText("take-back");
      await expect(page.getByTestId("review-control-grant")).toHaveText("alice");
      await settleControl(page);
      await expect(page.getByTestId("review-control-grant")).toHaveText("none");
      const decline = owner.getByRole("button", { name: "Decline", exact: true }).first();
      await decline.focus();
      await decline.press("Enter");
      await expect(page.getByTestId("review-control-action")).toHaveText("deny:charlie-connection");
      await expect(dialog).toBeFocused();
      const browse = page.getByTestId("local-tab-allow-explore");
      await browse.press("Enter");
      await expect(browse).toBeDisabled();
      await settleControl(page);
      await expect(browse).toHaveCount(0);
      await expect(dialog).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(dialog).toHaveCount(0);
      await expect(trigger).toBeFocused();

      await open(page, "controls", theme, "&fail=1");
      await trigger.click();
      await page.getByTestId("local-tab-grant-control").first().click();
      await readableError(page, owner.getByRole("alert"));
      await expect(page.getByTestId("local-tab-grant-control").first()).toBeEnabled();
      expect(errors).toEqual([]);
    });

    test(`browser handoff and reading errors remain readable and actionable in ${theme} at ${width}px`, async ({ page }) => {
      const errors = await configure(page);
      await open(page, "handoff-error", theme);
      const controls = page.getByTestId("browser-human-input-controls");
      await readableError(page, controls.getByRole("alert"));
      const request = page.getByTestId("browser-human-input-request");
      await touchTargets(request, width);
      await request.click();
      const dialog = page.getByRole("dialog", { name: "Take over browser", exact: true });
      await fits(page, dialog);
      await readableError(page, dialog.getByRole("alert"));
      await touchTargets(dialog.getByRole("button"), width);
      await page.keyboard.press("Escape");
      await expect(dialog).toHaveCount(0);
      await expect(request).toBeFocused();
      await request.click();
      await page.getByTestId("browser-human-input-takeover").click();
      await expect(page.getByTestId("review-handoff-action")).toHaveText("take-over");

      await open(page, "reading-error", theme);
      const row = page.getByTestId("browser-reading-row");
      await readableError(page, row.getByRole("alert"));
      const takeover = page.getByTestId("browser-reading-takeover");
      await touchTargets(takeover, width);
      await takeover.click();
      await expect(page.getByTestId("review-reading-action")).toHaveText("take-over");
      await fits(page, row);
      expect(errors).toEqual([]);
    });

    test(`recovery and stop feedback use working actions and readable status in ${theme} at ${width}px`, async ({ page }) => {
      const errors = await configure(page);
      await open(page, "recovery", theme);
      const recovery = page.getByTestId("chat-message-proxy-error-guidance");
      const action = recovery.getByTestId("chat-message-proxy-error-action");
      await fits(page, recovery);
      await expect(recovery).toHaveRole("alert");
      // Exact recovery copy belongs to proxyError's unit tests. Here, require
      // visible guidance beyond the action label, regardless of its wording.
      await expect.poll(async () =>
        (await recovery.innerText()).replace(await action.innerText(), "").trim(),
      ).toMatch(/\S/);
      expect(await recovery.evaluate(element => element.scrollWidth <= element.clientWidth + 1 && element.scrollHeight <= element.clientHeight + 1)).toBe(true);
      await expect(action).toHaveAccessibleName(/\S/);
      await expect(action).toBeEnabled();
      await touchTargets(action, width);
      await action.focus();
      await expect(action).toBeFocused();
      await action.press("Enter");
      await expect(page.getByTestId("review-recovery-panel")).toHaveText("ai");

      await open(page, "stop-error", theme);
      await readableError(page, page.getByTestId("chat-run-stop-error"), stopError);
      const retry = page.getByRole("button", { name: "Retry stop", exact: true });
      await touchTargets(retry, width);
      await retry.click();
      await expect(page.getByTestId("review-stop-phase")).toHaveText("stopping");
      await expect(page.getByTestId("chat-run-stop-error")).toHaveCount(0);

      await open(page, "profile", theme, "&status=error");
      const profile = page.getByTestId("shared-browser-profile-status");
      await expect(profile).toContainText("Save status unavailable");
      await expect(profile).toContainText("Do not rely on recovery after this session ends.");
      await fits(page, profile);
      expect(await profile.evaluate(element => element.scrollWidth <= element.clientWidth + 1 && element.scrollHeight <= element.clientHeight + 1)).toBe(true);
      expect(errors).toEqual([]);
    });
  });
}
