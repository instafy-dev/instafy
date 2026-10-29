import { expect, test, type Locator, type Page } from "@playwright/test";
import { cliLoginLayoutBoundaries } from "../../fixtures/cli-login-layout/boundaries";

const fixture = "/tests/fixtures/cli-login-layout/index.html";
// How long the page waits, visible and focused, before Connect or Copy takes a press.
const PRESS_READY_MS = 750;

async function openCliLogin(page: Page, theme: "light" | "dark") {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("https://**", (route) => {
    errors.push(`Unexpected remote request: ${new URL(route.request().url()).origin}`);
    return route.abort();
  });
  await page.route("http://127.0.0.1:45678/**", (route) => {
    errors.push("Unexpected request to the CLI");
    return route.abort();
  });
  // Also works against the generic browser-UI server, without fixture-specific Vite stubs.
  for (const [path, body] of Object.entries(cliLoginLayoutBoundaries)) {
    await page.route(`**${path}*`, (route) => route.fulfill({ contentType: "application/javascript", body }));
  }
  await page.emulateMedia({ colorScheme: theme });
  await page.goto(`${fixture}?theme=${theme}`);
  await expect(page.getByTestId("cli-login-connect")).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  return errors;
}

const connect = (page: Page) => page.getByTestId("cli-login-connect");
const copy = (page: Page) => page.getByRole("button", { name: "Copy token" });
const line = (page: Page, button: "connect" | "copy") => page.getByTestId(`cli-login-move-pointer-${button}`);

async function lineCount(element: Locator) {
  return element.evaluate((node) => {
    const range = document.createRange();
    range.selectNodeContents(node);
    return new Set([...range.getClientRects()].map((rect) => Math.round(rect.top))).size;
  });
}

// Where the controls are, and how tall the page is.
async function layout(page: Page) {
  return page.evaluate(() => {
    const box = (selector: string) => {
      const rect = document.querySelector(selector)!.getBoundingClientRect();
      return [rect.x, rect.y, rect.width, rect.height].map((value) => Math.round(value * 10) / 10);
    };
    return {
      code: box('[data-testid="cli-login-confirmation-code"]'),
      connect: box('[data-testid="cli-login-connect"]'),
      token: box('[data-testid="cli-login-token"]'),
      copy: box('[aria-label="Copy token"]'),
      height: document.documentElement.scrollHeight,
    };
  });
}

// Rests the pointer on the button, starts the wait again as the window coming
// forward does, then clicks once the button looks ready, without moving.
async function clickAtRest(page: Page, button: Locator) {
  const box = (await button.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.evaluate(() => {
    window.dispatchEvent(new Event("blur"));
    window.dispatchEvent(new Event("focus"));
  });
  await expect(button).toHaveAttribute("aria-disabled", "true");
  await expect(button).not.toHaveAttribute("aria-disabled", { timeout: PRESS_READY_MS * 4 });
  await page.mouse.down();
  await page.mouse.up();
}

for (const width of [320, 360, 390, 1280]) {
  test.describe(`${width}px with a mouse`, () => {
    test.use({ viewport: { width, height: 800 } });

    test(`the token keeps one line and a line under Connect or Copy shows without moving anything at ${width}px`, async ({ page }) => {
      const errors = await openCliLogin(page, width === 360 ? "dark" : "light");
      expect(await page.evaluate(() => matchMedia("(any-pointer: fine)").matches)).toBe(true);
      expect(await lineCount(page.getByTestId("cli-login-token"))).toBe(1);
      // Hidden, each line keeps its room under its button.
      for (const button of ["connect", "copy"] as const) {
        await expect(line(page, button)).toBeHidden();
        expect(await line(page, button).evaluate((node) => node.getBoundingClientRect().height)).toBeGreaterThan(0);
      }
      // Each line sits under its button: Connect's under Connect, Copy's under the token row.
      expect(await page.evaluate(() => {
        const rect = (selector: string) => document.querySelector(selector)!.getBoundingClientRect();
        const below = (top: number, ...over: string[]) => over.every((selector) => top >= rect(selector).bottom);
        return {
          connect: below(rect('[data-testid="cli-login-move-pointer-connect"]').top, '[data-testid="cli-login-connect"]'),
          copy: below(rect('[data-testid="cli-login-move-pointer-copy"]').top, '[aria-label="Copy token"]', '[data-testid="cli-login-token"]'),
        };
      })).toEqual({ connect: true, copy: true });
      const before = await layout(page);

      await clickAtRest(page, connect(page));
      await expect(line(page, "connect")).toBeVisible();
      await expect(line(page, "copy")).toBeHidden();
      expect(await layout(page)).toEqual(before);

      await clickAtRest(page, copy(page));
      await expect(line(page, "copy")).toBeVisible();
      await expect(line(page, "connect")).toBeHidden();
      expect(await layout(page)).toEqual(before);

      expect(await lineCount(page.getByTestId("cli-login-token"))).toBe(1);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
      expect(errors).toEqual([]);
    });
  });
}

for (const width of [320, 360, 390]) {
  test.describe(`${width}px touch screen`, () => {
    test.use({ viewport: { width, height: 740 }, hasTouch: true, isMobile: true });

    test(`the lines about the pointer take no room on a touch screen at ${width}px`, async ({ page }) => {
      const errors = await openCliLogin(page, "light");
      expect(await page.evaluate(() => matchMedia("(any-pointer: fine)").matches)).toBe(false);
      for (const button of ["connect", "copy"] as const) {
        expect(await line(page, button).evaluate((node) => getComputedStyle(node).display)).toBe("none");
      }
      expect(await lineCount(page.getByTestId("cli-login-token"))).toBe(1);
      // Connect's row is as tall as Connect.
      const [button, row] = await connect(page).evaluate((node) => [
        node.getBoundingClientRect().height,
        node.parentElement!.getBoundingClientRect().height,
      ]);
      expect(row).toBe(button);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
      expect(errors).toEqual([]);
    });
  });
}
