import { expect, test, type Locator, type Page } from "@playwright/test";
import { loginKeyboardBoundaries } from "../../fixtures/login-keyboard/boundaries";

type Theme = "light" | "dark";
const fixture = "/tests/fixtures/login-keyboard/index.html";

async function openLogin(page: Page, theme: Theme, surface = "email", native = true) {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("https://**", route => {
    errors.push(`Unexpected remote request: ${new URL(route.request().url()).origin}`);
    return route.abort();
  });
  // Also works against the generic browser-UI server, without fixture-specific Vite stubs.
  for (const [path, body] of Object.entries(loginKeyboardBoundaries)) {
    await page.route(`**${path}*`, route => route.fulfill({ contentType: "application/javascript", body }));
  }
  await page.emulateMedia({ colorScheme: theme });
  await page.goto(`${fixture}?theme=${theme}&surface=${surface}&native=${native ? "1" : "0"}`);
  await expect(page.getByTestId("login-page")).toBeVisible();
  if (page.viewportSize()!.height <= 560) await expect(page.getByTestId("login-page")).toHaveAttribute("data-compact-layout", "true");
  return errors;
}

async function visibleAboveKeyboard(control: Locator, page: Page) {
  await expect.poll(async () => control.evaluate(element => {
    const box = element.getBoundingClientRect();
    const viewport = window.visualViewport;
    const top = viewport?.offsetTop ?? 0;
    const bottom = top + (viewport?.height ?? innerHeight);
    return box.height > 0 && box.top >= top - 1 && box.bottom <= bottom + 1;
  })).toBe(true);
  expect(await control.isVisible()).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(page.viewportSize()!.width);
}

async function oneScrollOwner(page: Page) {
  const nested = await page.getByTestId("login-page").evaluate(root => [...root.querySelectorAll<HTMLElement>("*")]
    .filter(element => /auto|scroll/.test(getComputedStyle(element).overflowY) && element.scrollHeight > element.clientHeight + 1)
    .map(element => element.tagName));
  expect(nested).toEqual([]);
}

async function focusedForm(page: Page, input: Locator) {
  await input.focus();
  await expect(input).toBeFocused();
  await visibleAboveKeyboard(input, page);
  await visibleAboveKeyboard(page.locator('form button[type="submit"]'), page);
  await oneScrollOwner(page);
}

for (const width of [320, 390]) {
  test.describe(`${width}px resized phone keyboard`, () => {
    test.use({ viewport: { width, height: 438 }, hasTouch: true });
    for (const theme of ["light", "dark"] as const) {
      test(`${theme}: email, password and invalid-credential recovery keep the action reachable`, async ({ page }) => {
        const errors = await openLogin(page, theme);
        const email = page.getByRole("textbox", { name: "Email address" });
        await email.fill("review@example.test");
        await focusedForm(page, email);
        expect(await email.evaluate(element => getComputedStyle(element).fontSize)).toBe("16px");
        await page.locator('form button[type="submit"]').click();
        const password = page.getByLabel("Password", { exact: true });
        await password.fill("inert review password");
        await focusedForm(page, password);
        await page.evaluate(() => window.__loginKeyboardReview.setFailure("password"));
        await page.locator('form button[type="submit"]').click();
        await expect(page.getByTestId("login-error")).toBeVisible();
        await expect(password).toHaveAttribute("aria-describedby", "login-error");
        await visibleAboveKeyboard(page.getByTestId("login-error"), page);
        await focusedForm(page, password);
        await expect(password).toHaveValue("inert review password");
        await page.getByRole("button", { name: "Email me a code instead" }).click();
        const code = page.getByRole("textbox", { name: "Verification code" });
        await code.fill("12345678");
        await focusedForm(page, code);
        expect(errors).toEqual([]);
      });

      test(`${theme}: signup code and password confirmation remain editable with the keyboard open`, async ({ page }) => {
        const errors = await openLogin(page, theme);
        await page.getByRole("button", { name: "Create account", exact: true }).click();
        const email = page.getByRole("textbox", { name: "Email address" });
        await email.fill("new.user@example.test");
        await focusedForm(page, email);
        await page.getByRole("button", { name: "Send verification code" }).click();
        const code = page.getByRole("textbox", { name: "Verification code" });
        await code.fill("123456");
        await focusedForm(page, code);
        await page.locator('form button[type="submit"]').click();
        const password = page.getByLabel("New password", { exact: true });
        await password.fill("inert review password");
        await focusedForm(page, password);
        const confirmation = page.getByLabel("Confirm password", { exact: true });
        await confirmation.fill("a different password");
        await focusedForm(page, confirmation);
        await page.getByRole("button", { name: "Save password" }).click();
        await expect(page.getByTestId("login-error")).toBeVisible();
        await expect(confirmation).toHaveAttribute("aria-describedby", "login-error");
        await visibleAboveKeyboard(page.getByTestId("login-error"), page);
        await focusedForm(page, confirmation);
        await expect(password).toHaveValue("inert review password");
        await expect(confirmation).toHaveValue("a different password");
        expect(errors).toEqual([]);
      });
    }
  });
}

for (const theme of ["light", "dark"] as const) {
  test.describe(`${theme} visual-only keyboard`, () => {
    test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });
    test("preserves email and focus, and leaves long errors reachable through document scrolling", async ({ page }) => {
      await page.addInitScript(() => {
        const viewport = Object.assign(new EventTarget(), {
          height: 844, width: 390, offsetTop: 0, offsetLeft: 0, pageTop: 0, pageLeft: 0, scale: 1,
        });
        Object.defineProperty(window, "visualViewport", { configurable: true, value: viewport });
      });
      const errors = await openLogin(page, theme);
      await page.getByRole("button", { name: "Create account", exact: true }).click();
      const email = page.getByRole("textbox", { name: "Email address" });
      await email.fill("review@example.test");
      await email.focus();
      await page.evaluate(() => {
        Object.assign(window.visualViewport!, { height: 438 });
        window.visualViewport!.dispatchEvent(new Event("resize"));
      });
      await expect(page.getByTestId("login-page")).toHaveAttribute("data-compact-layout", "true");
      await expect(email).toBeFocused();
      await expect(email).toHaveValue("review@example.test");
      await visibleAboveKeyboard(email, page);
      await visibleAboveKeyboard(page.locator('form button[type="submit"]'), page);
      // Manual document scrolling with unchanged visual bounds must not snap
      // back to the focused field, even when the browser emits a scroll event.
      const manuallyScrolled = await page.evaluate(() => {
        window.scrollBy(0, 100);
        window.visualViewport!.dispatchEvent(new Event("scroll"));
        return window.scrollY;
      });
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      expect(await page.evaluate(() => window.scrollY)).toBe(manuallyScrolled);
      await expect(email).toBeFocused();
      // A visual viewport pan reveals the field once and converges; repeated
      // events with the same offset do not keep scrolling the document.
      await page.evaluate(() => {
        Object.assign(window.visualViewport!, { offsetTop: 36 });
        window.visualViewport!.dispatchEvent(new Event("scroll"));
      });
      await visibleAboveKeyboard(email, page);
      await visibleAboveKeyboard(page.locator('form button[type="submit"]'), page);
      const settledScroll = await page.evaluate(() => window.scrollY);
      await page.evaluate(() => {
        window.visualViewport!.dispatchEvent(new Event("scroll"));
        window.visualViewport!.dispatchEvent(new Event("resize"));
      });
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      expect(await page.evaluate(() => window.scrollY)).toBe(settledScroll);
      await page.evaluate(() => window.__loginKeyboardReview.setFailure("send"));
      await page.getByRole("button", { name: "Send verification code" }).click();
      const error = page.getByTestId("login-error");
      await expect(error).toContainText("verification-email-delivery-reference-");
      await expect(email).toHaveAttribute("aria-describedby", "login-error");
      await visibleAboveKeyboard(error, page);
      await visibleAboveKeyboard(email, page);
      await visibleAboveKeyboard(page.locator('form button[type="submit"]'), page);
      await oneScrollOwner(page);
      await expect(email).toHaveValue("review@example.test");
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
      expect(errors).toEqual([]);
    });
  });

  test.describe(`${theme} landscape phone`, () => {
    test.use({ viewport: { width: 844, height: 390 }, hasTouch: true });
    test("reset fields retain touch typography and their primary action", async ({ page }) => {
      const errors = await openLogin(page, theme, "recovery");
      const password = page.getByLabel("New password", { exact: true });
      await password.fill("inert review password");
      expect(await password.evaluate(element => getComputedStyle(element).fontSize)).toBe("16px");
      await focusedForm(page, password);
      const confirmation = page.getByLabel("Confirm password", { exact: true });
      await confirmation.fill("inert review password");
      await focusedForm(page, confirmation);
      expect(errors).toEqual([]);
    });
  });

  test.describe(`${theme} desktop`, () => {
    test.use({ viewport: { width: 1280, height: 800 }, hasTouch: false });
    test("retains desktop form bounds and keyboard access", async ({ page }) => {
      const errors = await openLogin(page, theme, "email", false);
      const email = page.getByRole("textbox", { name: "Email address" });
      await email.fill("review@example.test");
      await focusedForm(page, email);
      expect(await email.evaluate(element => parseFloat(getComputedStyle(element).fontSize))).toBeGreaterThanOrEqual(14);
      const box = await email.boundingBox();
      expect(box!.width).toBeLessThanOrEqual(400);
      await page.keyboard.press("Enter");
      await expect(page.getByLabel("Password", { exact: true })).toBeFocused();
      expect(errors).toEqual([]);
    });
  });
}

for (const theme of ["light", "dark"] as const) {
  test.describe(`${theme} native safe areas`, () => {
    test.use({ viewport: { width: 390, height: 438 }, hasTouch: true });
    test("keeps login actions clear of system bars and respects rotated side insets", async ({ page }) => {
      const errors = await openLogin(page, theme);
      await page.evaluate(() => {
        document.documentElement.style.setProperty("--safe-area-inset-top", "24px");
        document.documentElement.style.setProperty("--safe-area-inset-bottom", "16px");
      });
      const guest = page.getByRole("button", { name: "Continue as guest" });
      expect((await guest.boundingBox())!.y).toBeGreaterThanOrEqual(36);
      const email = page.getByRole("textbox", { name: "Email address" });
      await email.fill("review@example.test");
      await focusedForm(page, email);
      const checkSafe = async (control: Locator, top = 24, bottom = 16, left = 0, right = 0) => {
        await expect.poll(async () => {
          const box = await control.boundingBox();
          const viewport = page.viewportSize()!;
          return box !== null && box.y >= top - 1 && box.y + box.height <= viewport.height - bottom + 1 &&
            box.x >= left - 1 && box.x + box.width <= viewport.width - right + 1;
        }).toBe(true);
      };
      await checkSafe(email);
      await checkSafe(page.locator('form button[type="submit"]'));
      await page.locator('form button[type="submit"]').click();
      const password = page.getByLabel("Password", { exact: true });
      await password.fill("inert review password");
      await page.evaluate(() => window.__loginKeyboardReview.setFailure("password"));
      await page.locator('form button[type="submit"]').click();
      await expect(page.getByTestId("login-error")).toBeVisible();
      await focusedForm(page, password);
      await checkSafe(password);
      await checkSafe(page.locator('form button[type="submit"]'));
      await checkSafe(page.getByTestId("login-error"));

      await page.setViewportSize({ width: 844, height: 390 });
      await page.evaluate(() => {
        document.documentElement.style.setProperty("--safe-area-inset-top", "0px");
        document.documentElement.style.setProperty("--safe-area-inset-left", "44px");
        document.documentElement.style.setProperty("--safe-area-inset-right", "28px");
        window.dispatchEvent(new Event("resize"));
      });
      await password.blur();
      await focusedForm(page, password);
      await checkSafe(password, 0, 16, 44, 28);
      await checkSafe(page.locator('form button[type="submit"]'), 0, 16, 44, 28);
      await expect(password).toHaveValue("inert review password");
      const padding = await page.getByTestId("login-page").evaluate(element => {
        const style = getComputedStyle(element);
        return { left: style.paddingLeft, right: style.paddingRight };
      });
      expect(padding).toEqual({ left: "44px", right: "28px" });
      expect(errors).toEqual([]);
    });
  });
}
