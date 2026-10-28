import { expect, test, type Locator, type Page } from "@playwright/test";
import { recoveryBoundaries } from "../../fixtures/browser-recovery/boundaries";

type Theme = "light" | "dark";
type Surface = "reconnecting" | "disconnected" | "runtime-limit";
const blocker = "Quarterly financial reconciliation and forecasting browser";
const workspace = "International operations and financial planning workspace";
const interruption = "This can interrupt work running there.";

// Full production modal and recovery actions; SDK and viewer boundaries are
// inert. This suite exercises layout and state transitions, not live transport.
async function mount(page: Page, surface: Surface, theme: Theme, layout = "expanded") {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("https://**", route => {
    errors.push(`Unexpected external request: ${new URL(route.request().url()).origin}`);
    return route.abort();
  });
  for (const [path, body] of Object.entries(recoveryBoundaries)) {
    if (path === "/src/sdk/instafy") continue;
    await page.route(`**${path}*`, route => route.fulfill({ contentType: "application/javascript", body }));
  }
  await page.emulateMedia({ colorScheme: theme });
  await page.goto(`/tests/fixtures/browser-recovery/index.html?surface=${surface}&theme=${theme}&layout=${layout}`);
  // Chromium can briefly report the previous document's pointer media after
  // navigation. Wait for this matrix's context posture before reading geometry.
  const coarse = page.viewportSize()!.width < 768;
  await expect.poll(() => page.evaluate(() => ({
    coarse: matchMedia("(pointer: coarse)").matches,
    fine: matchMedia("(pointer: fine)").matches,
  }))).toEqual({ coarse, fine: !coarse });
  const target = surface === "reconnecting" ? "browser-session-reconnecting"
    : surface === "runtime-limit" ? "browser-runtime-limit-notice" : "browser-session-error-notice";
  await expect(page.getByTestId(target)).toBeVisible();
  return errors;
}

async function noHorizontalOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}

async function touchTarget(button: Locator) {
  await expect.poll(async () => {
    const rect = await button.boundingBox();
    return rect ? Math.min(rect.width, rect.height) : 0;
  }).toBeGreaterThanOrEqual(44);
}

async function inside(child: Locator, parent: Locator) {
  const [childRect, parentRect] = await Promise.all([child.boundingBox(), parent.boundingBox()]);
  expect(childRect).not.toBeNull();
  expect(parentRect).not.toBeNull();
  expect(childRect!.x).toBeGreaterThanOrEqual(parentRect!.x - 1);
  expect(childRect!.x + childRect!.width).toBeLessThanOrEqual(parentRect!.x + parentRect!.width + 1);
  expect(childRect!.y).toBeGreaterThanOrEqual(parentRect!.y - 1);
  expect(childRect!.y + childRect!.height).toBeLessThanOrEqual(parentRect!.y + parentRect!.height + 1);
}

for (const width of [320, 390, 1280]) {
  test.describe(`${width}px recovery`, () => {
    test.use({ viewport: { width, height: 844 }, hasTouch: width < 768 });
    for (const theme of ["light", "dark"] as const) {
      test(`${theme}: reconnecting stays readable over the retained page`, async ({ page }) => {
        const errors = await mount(page, "reconnecting", theme);
        const status = page.getByTestId("browser-session-reconnecting");
        await expect(status).toContainText("Reconnecting…");
        await expect(page.getByTestId("review-browser-page")).toBeVisible();
        await inside(status, page.getByTestId("browser-session-viewport"));
        await noHorizontalOverflow(page);
        expect(errors).toEqual([]);
      });

      test(`${theme}: disconnected notice retries without starting unrelated work`, async ({ page }) => {
        const errors = await mount(page, "disconnected", theme);
        const notice = page.getByTestId("browser-session-error-notice");
        await expect(notice).toContainText("Instafy's browser did not open. Try again.");
        // The raw reason remains diagnostic data; the user sees the shared sentence.
        await expect(notice.locator("[data-debug-reason]")).toHaveAttribute("data-debug-reason", /Your messages are still available/);
        const retry = page.getByTestId("browser-session-error-retry");
        if (width < 768) await touchTarget(retry);
        const attempts = await page.evaluate(() => window.__browserRecoveryReview.ensureCount);
        await retry.click();
        await expect.poll(() => page.evaluate(() => window.__browserRecoveryReview.ensureCount)).toBe(attempts + 1);
        await expect(notice).toBeVisible();
        await inside(page.getByTestId("browser-session-state-card"), page.getByTestId("browser-session-viewport"));
        expect(await page.evaluate(() => window.__browserRecoveryReview.stopCalls)).toEqual([]);
        await noHorizontalOverflow(page);
        expect(errors).toEqual([]);
      });

      test(`${theme}: runtime limit preserves long context, recovery actions and pending state`, async ({ page }) => {
        const errors = await mount(page, "runtime-limit", theme);
        const notice = page.getByTestId("browser-runtime-limit-notice");
        await expect(notice).toContainText(blocker);
        await expect(notice).toContainText(workspace);
        await expect(notice).toContainText(interruption);
        const retry = page.getByTestId("browser-runtime-limit-retry");
        const takeover = page.getByTestId("browser-runtime-limit-takeover");
        if (width < 768) { await touchTarget(retry); await touchTarget(takeover); }
        const attempts = await page.evaluate(() => window.__browserRecoveryReview.ensureCount);
        await retry.click();
        await expect.poll(() => page.evaluate(() => window.__browserRecoveryReview.ensureCount)).toBe(attempts + 1);
        await expect(takeover).toBeEnabled();
        await takeover.click();
        await expect(takeover).toHaveText("Opening here...");
        await expect(takeover).toBeDisabled();
        await expect(retry).toBeDisabled();
        expect(await page.evaluate(() => window.__browserRecoveryReview.stopCalls)).toEqual([{
          runtimeId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", reason: "browser_session_runtime_limit_takeover",
        }]);
        await page.evaluate(() => window.__browserRecoveryReview.finishStop());
        await expect.poll(() => page.evaluate(() => window.__browserRecoveryReview.ensureCount)).toBe(attempts + 2);
        await expect(takeover).toBeEnabled();
        await inside(page.getByTestId("browser-runtime-limit-card"), page.getByTestId("browser-session-viewport"));
        await noHorizontalOverflow(page);
        expect(errors).toEqual([]);
      });
    }
  });
}

for (const theme of ["light", "dark"] as const) {
  test.describe(`${theme} compact recovery`, () => {
    // Actual production compact policy is desktop at 620–759px height.
    test.use({ viewport: { width: 1280, height: 700 }, hasTouch: false });

    test("runtime-limit stage grows around its guidance and handles a failed stop", async ({ page }) => {
      const errors = await mount(page, "runtime-limit", theme, "compact");
      const card = page.getByTestId("browser-session-collapsed-card");
      await expect(card).toBeVisible();
      await expect(card).toContainText(interruption);
      const stage = page.getByTestId("browser-session-stage");
      await inside(card, stage);
      await inside(page.getByTestId("browser-runtime-limit-takeover"), stage);
      // Long blocker names plus interruption guidance exceed the old fixed 156px stage.
      expect((await stage.boundingBox())!.height).toBeGreaterThan(156);
      const retry = page.getByTestId("browser-runtime-limit-retry");
      await retry.focus();
      await page.keyboard.press("Shift+Tab");
      await expect(page.getByTestId("browser-runtime-limit-takeover")).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(retry).toBeDisabled();
      await page.evaluate(() => window.__browserRecoveryReview.finishStop(true));
      await expect(page.getByTestId("browser-session-error-notice")).toBeVisible();
      await expect(page.locator("[data-debug-reason]")).toHaveAttribute("data-debug-reason", /Unable to stop the blocking runtime/);
      await inside(page.getByTestId("browser-session-error-retry"), stage);
      await noHorizontalOverflow(page);
      expect(errors).toEqual([]);
    });

    test("disconnected card keeps Retry and Hide inside its content-sized stage", async ({ page }) => {
      const errors = await mount(page, "disconnected", theme, "compact");
      const card = page.getByTestId("browser-session-collapsed-card");
      await expect(card).toBeVisible();
      await inside(card, page.getByTestId("browser-session-stage"));
      await inside(page.getByTestId("browser-session-error-retry"), card);
      const hide = card.getByRole("button", { name: "Hide", exact: true });
      await inside(hide, card);
      await hide.click();
      await expect(page.getByTestId("review-browser-hidden")).toBeVisible();
      await expect(page.getByTestId("browser-session-viewport")).toHaveCount(0);
      expect(errors).toEqual([]);
    });
  });

  test.describe(`${theme} short mobile recovery`, () => {
    test.use({ viewport: { width: 320, height: 360 }, hasTouch: true });
    test("long runtime limit scrolls inside the card without hiding its actions", async ({ page }) => {
      const errors = await mount(page, "runtime-limit", theme);
      const card = page.getByTestId("browser-runtime-limit-card");
      await inside(card, page.getByTestId("browser-session-viewport"));
      expect(await card.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true);
      await expect(card).toContainText(blocker);
      await expect(card).toContainText(workspace);
      await expect(card).toContainText(interruption);
      const takeover = page.getByTestId("browser-runtime-limit-takeover");
      await takeover.scrollIntoViewIfNeeded();
      await inside(takeover, card);
      await touchTarget(takeover);
      await takeover.click();
      await expect(takeover).toBeDisabled();
      await expect(page.getByTestId("browser-runtime-limit-retry")).toBeDisabled();
      await noHorizontalOverflow(page);
      expect(errors).toEqual([]);
    });
  });
}
