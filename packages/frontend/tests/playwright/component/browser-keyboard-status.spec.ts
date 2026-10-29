import { expect, test, type Locator, type Page } from "@playwright/test";
import { browserKeyboardStatusBoundaries } from "../../fixtures/browser-keyboard-status/boundaries";

type Theme = "light" | "dark";
type Surface = "keyboard" | "keyboard-inline" | "personal-opening" | "personal-error" | "shared-opening" | "shared-connected";

async function mount(page: Page, surface: Surface, theme: Theme, coarse = page.viewportSize()!.width < 640) {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("https://**", route => {
    errors.push(`Unexpected external request: ${new URL(route.request().url()).origin}`);
    return route.abort();
  });
  for (const [path, body] of Object.entries(browserKeyboardStatusBoundaries)) {
    if (path === "/src/sdk/instafy") continue;
    await page.route(`**${path}*`, route => route.fulfill({ contentType: "application/javascript", body }));
  }
  await page.emulateMedia({ colorScheme: theme });
  await page.goto(`/tests/fixtures/browser-keyboard-status/index.html?surface=${surface}&theme=${theme}`);
  await expect(page.getByRole("main")).toBeVisible();
  await expect.poll(() => page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(coarse);
  return errors;
}

async function noHorizontalOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}

async function inside(child: Locator, parent: Locator) {
  const [c, p] = await Promise.all([child.boundingBox(), parent.boundingBox()]);
  expect(c).not.toBeNull(); expect(p).not.toBeNull();
  expect(c!.x).toBeGreaterThanOrEqual(p!.x - 1);
  expect(c!.x + c!.width).toBeLessThanOrEqual(p!.x + p!.width + 1);
  expect(c!.y).toBeGreaterThanOrEqual(p!.y - 1);
  expect(c!.y + c!.height).toBeLessThanOrEqual(p!.y + p!.height + 1);
}

async function touchTarget(control: Locator) {
  await expect.poll(async () => {
    const rect = await control.boundingBox();
    return rect ? Math.min(rect.width, rect.height) : 0;
  }).toBeGreaterThanOrEqual(44);
}

for (const width of [320, 390, 768, 1280]) {
  test.describe(`${width}px browser keyboard and status`, () => {
    test.use({ viewport: { width, height: 844 }, hasTouch: width < 640 });
    for (const theme of ["light", "dark"] as const) {
      test(`${theme}: Personal opening and failed retry stay inside the browser pane`, async ({ page }) => {
        let errors = await mount(page, "personal-opening", theme);
        const viewport = page.getByTestId("personal-browser-viewport");
        await expect(viewport).toBeVisible();
        await expect(viewport.getByRole("button")).toHaveCount(0);
        await noHorizontalOverflow(page);
        expect(errors).toEqual([]);

        errors = await mount(page, "personal-error", theme);
        const retry = page.getByRole("button", { name: "Retry Personal Browser", exact: true });
        await expect(retry).toBeEnabled();
        await inside(retry, viewport);
        // The actionable diagnostic stays visible even with a long unbroken reference.
        await expect(viewport).toContainText("personal-browser-connection-recovery-reference-");
        await noHorizontalOverflow(page);
        if (width < 640) await touchTarget(retry);
        await retry.focus();
        await page.keyboard.press("Enter");
        await expect.poll(() => page.evaluate(() => window.__browserKeyboardStatusReview.retryCount)).toBe(1);
        await expect(retry).toHaveAttribute("aria-disabled", "true");
        await expect(retry).toBeFocused();
        await inside(retry, viewport);
        await page.keyboard.press("Enter");
        await page.keyboard.press("Space");
        expect(await page.evaluate(() => window.__browserKeyboardStatusReview.retryCount)).toBe(1);
        await page.evaluate(() => window.__browserKeyboardStatusReview.finishRetry());
        await expect(retry).toBeEnabled();
        await expect(retry).toBeFocused();
        await page.keyboard.press("Enter");
        await expect.poll(() => page.evaluate(() => window.__browserKeyboardStatusReview.retryCount)).toBe(2);
        await expect(retry).toHaveAttribute("aria-disabled", "true");
        await inside(retry, viewport);
        await noHorizontalOverflow(page);
        expect(errors).toEqual([]);
      });

      test(`${theme}: connected Shared browser retains its page and does not open another session`, async ({ page }) => {
        const errors = await mount(page, "shared-connected", theme);
        await expect(page.getByTestId("review-browser-page")).toBeVisible();
        await expect.poll(() => page.evaluate(() => window.__browserKeyboardStatusReview.viewStates.includes("live"))).toBe(true);
        expect(await page.evaluate(() => window.__browserKeyboardStatusReview.ensureCount)).toBe(0);
        expect(await page.evaluate(() => window.__browserKeyboardStatusReview.stopCount)).toBe(0);
        await noHorizontalOverflow(page);
        expect(errors).toEqual([]);
      });

      if (width >= 640) {
        test(`${theme}: desktop keeps the remote software-keyboard utility hidden`, async ({ page }) => {
          const errors = await mount(page, "keyboard", theme);
          await expect(page.getByTestId("shared-browser-mobile-keyboard-open")).toBeHidden();
          await expect(page.getByTestId("review-browser-page")).toBeVisible();
          expect(await page.evaluate(() => window.__browserKeyboardStatusReview.occupiedHeight)).toBe(0);
          await noHorizontalOverflow(page);
          expect(errors).toEqual([]);
        });
      } else {
        for (const surface of ["keyboard", "keyboard-inline"] as const) {
          test(`${theme}: ${surface} preserves input, composition and control-key routing`, async ({ page }) => {
            const errors = await mount(page, surface, theme);
            const trigger = page.getByTestId("shared-browser-mobile-keyboard-open");
            await touchTarget(trigger);
            await trigger.tap();
            const input = page.getByTestId("shared-browser-mobile-keyboard-input");
            const close = page.getByTestId("shared-browser-mobile-keyboard-close");
            await expect(input).toBeFocused();
            await touchTarget(close);
            await inside(input, page.getByTestId("keyboard-review-stage"));
            await page.keyboard.type("Hi");
            await input.evaluate(element => {
              const field = element as HTMLInputElement;
              const clipboard = new DataTransfer(); clipboard.setData("text/plain", " pasted");
              field.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: clipboard }));
              field.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
              field.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, cancelable: true, data: "日", inputType: "insertCompositionText", isComposing: true }));
              field.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "日本" }));
              // Chromium/WebKit may deliver a final input after compositionend.
              field.value = "日本"; field.dispatchEvent(new InputEvent("input", { bubbles: true, data: "日本", inputType: "insertText" }));
              for (const [key, inputType] of [["Backspace", "deleteContentBackward"], ["Enter", "insertLineBreak"]]) {
                field.dispatchEvent(new KeyboardEvent("keydown", { key, code: key, bubbles: true, cancelable: true }));
                field.dispatchEvent(new InputEvent("beforeinput", { inputType, bubbles: true, cancelable: true }));
              }
            });
            const messages = await page.evaluate(() => window.__browserKeyboardStatusReview.messages);
            expect(messages.filter(message => message.type === "text").map(message => message.text)).toEqual(["H", "i", " pasted", "日本"]);
            expect(messages.filter(message => message.type === "key").map(message => [message.kind, message.key])).toEqual([
              ["rawKeyDown", "Backspace"], ["keyUp", "Backspace"], ["keyDown", "Enter"], ["keyUp", "Enter"],
            ]);
            await expect(input).toHaveValue("");
            await expect.poll(() => page.evaluate(() => window.__browserKeyboardStatusReview.occupiedHeight)).toBeGreaterThan(0);

            // Simulated reduced visual space, not a claim about a physical OS keyboard.
            await page.setViewportSize({ width, height: 420 });
            await expect(input).toBeFocused();
            await inside(input, page.getByTestId("keyboard-review-stage"));
            await inside(close, page.getByTestId("keyboard-review-stage"));
            await noHorizontalOverflow(page);
            await close.tap();
            await expect(input).toHaveCount(0);
            expect(await page.evaluate(() => window.__browserKeyboardStatusReview.occupiedHeight)).toBe(0);
            await trigger.tap();
            await expect(input).toBeFocused();
            expect(await page.evaluate(() => window.__browserKeyboardStatusReview.messages.length)).toBe(messages.length);
            await noHorizontalOverflow(page);
            expect(errors).toEqual([]);
          });
        }
      }
    }
  });
}

for (const theme of ["light", "dark"] as const) {
  test.describe(`${theme} touch tablet keyboard`, () => {
    test.use({ viewport: { width: 768, height: 844 }, hasTouch: true });
    test("keeps native text at 16px and controls reachable with a coarse pointer", async ({ page }) => {
      const errors = await mount(page, "keyboard-inline", theme, true);
      const trigger = page.getByTestId("shared-browser-mobile-keyboard-open");
      await touchTarget(trigger);
      await trigger.tap();
      const input = page.getByTestId("shared-browser-mobile-keyboard-input");
      await expect(input).toBeFocused();
      await expect(input).toHaveCSS("font-size", "16px");
      await touchTarget(page.getByTestId("shared-browser-mobile-keyboard-close"));
      await inside(input, page.getByTestId("keyboard-review-stage"));
      await noHorizontalOverflow(page);
      expect(errors).toEqual([]);
    });
  });

  test.describe(`${theme} compact Shared opening`, () => {
    // The actual compact-opening policy is desktop, 620–759px viewport height.
    test.use({ viewport: { width: 1280, height: 700 }, hasTouch: false });
    test("Expand enters fullscreen once while preserving the pending session", async ({ page }) => {
      const errors = await mount(page, "shared-opening", theme);
      const card = page.getByTestId("browser-session-collapsed-card");
      await expect(card).toBeVisible();
      // The shared card owns its frame; its positioning wrapper must not add
      // another border/radius or decorative shadow behind it.
      const stage = page.getByTestId("browser-session-stage");
      await expect(stage).toHaveCSS("border-top-width", "0px");
      await expect(stage).toHaveCSS("box-shadow", "none");
      await expect(card).toHaveCSS("border-radius", "16px");
      await expect(card).toHaveCSS("box-shadow", "none");
      const expand = card.getByRole("button", { name: "Open browser fullscreen" });
      await inside(expand, card);
      await inside(card, page.getByTestId("browser-session-stage"));
      await expect.poll(() => page.evaluate(() => window.__browserKeyboardStatusReview.ensureCount)).toBe(1);
      await expand.focus();
      await page.keyboard.press("Enter");
      await expect(card).toHaveCount(0);
      await expect(page.getByRole("dialog")).toBeVisible();
      expect(await page.evaluate(() => window.__browserKeyboardStatusReview.ensureCount)).toBe(1);
      expect(await page.evaluate(() => window.__browserKeyboardStatusReview.hideCount)).toBe(0);
      expect(await page.evaluate(() => window.__browserKeyboardStatusReview.stopCount)).toBe(0);
      await noHorizontalOverflow(page);
      expect(errors).toEqual([]);
    });
  });
}
