import { expect, test, type Page } from "@playwright/test";
import { BROWSER_TURN_BEATS, type TurnBeatId } from "../../src/screens/landing/landingTurnScript";

// The landing's example window shows its work in a laptop's first view: from
// 1184px it fits the viewport (landingStudioChrome.ts FRAME), so the press
// that opens the Shared Browser, the site approval, Octo's cursor, the action
// ticker and Kim's reply are all on screen when they happen, with no scroll.
// docs/Brand.md: only Ada's press opens the browser, so that press has to be
// seen, or the browser would look as if it opened on its own.

type Box = { top: number; bottom: number };

async function box(page: Page, testId: string): Promise<Box | null> {
  return page.evaluate((id) => {
    const node = document.querySelector(`[data-testid="landing-session-deck"] [data-testid="${id}"]`);
    if (!node) return null;
    const rect = node.getBoundingClientRect();
    return rect.height > 0 ? { top: rect.top, bottom: rect.bottom } : null;
  }, testId);
}

function browserTurnClock(page: Page) {
  let elapsed = 0;
  let nextIndex = 1;
  return async (beat: TurnBeatId) => {
    const targetIndex = BROWSER_TURN_BEATS.findIndex((entry) => entry.id === beat);
    expect(targetIndex, `the browser script includes ${beat}`).toBeGreaterThanOrEqual(nextIndex);
    // Render every scheduled beat, including the routine-choice scroll before
    // Allow. A busy runner must not miss the 250ms tap/allowPress states while
    // inspecting the previous frame. The real application still owns its
    // timers and state; only elapsed time is controlled by the test.
    while (nextIndex <= targetIndex) {
      const next = BROWSER_TURN_BEATS[nextIndex];
      await page.clock.fastForward(next.atMs - elapsed);
      await page.clock.runFor(32);
      elapsed = next.atMs + 32;
      await expect(page.getByTestId("landing-session-deck")).toHaveAttribute("data-beat", next.id);
      nextIndex += 1;
    }
  };
}

async function expectAboveFold(page: Page, testId: string, label: string) {
  const height = page.viewportSize()!.height;
  const seen = await box(page, testId);
  expect(seen, `${label}: ${testId} is drawn`).not.toBeNull();
  expect(seen!.top, `${label}: ${testId} starts on screen`).toBeGreaterThanOrEqual(0);
  expect(seen!.bottom, `${label}: ${testId} ends above the fold`).toBeLessThanOrEqual(height);
}

async function routineChoiceInsidePrompt(page: Page) {
  return page.evaluate(() => {
    const check = document.querySelector('[data-testid="landing-browser-routine-check"]')!.getBoundingClientRect();
    const content = document.querySelector('[data-testid="landing-browser-approval-content"]')!.getBoundingClientRect();
    return check.top >= content.top - 0.5 && check.bottom <= content.bottom + 0.5;
  });
}

// Display sizes, and the shorter first views real browsers leave once their
// own chrome is drawn (about 110px): a 1440x900 display (1440x780), a 1536x864
// one (1536x730), a 1280x800 one (1280x720) and a 1366x768 laptop (1366x650).
for (const [width, height] of [
  [1440, 900],
  [1440, 800],
  [1536, 864],
  [1280, 800],
  [1440, 780],
  [1536, 730],
  [1280, 720],
  [1366, 650],
] as const) {
  test.describe(`the landing's example at ${width}x${height}`, () => {
    test.beforeEach(async ({ page }) => {
      test.setTimeout(90_000);
      await page.setViewportSize({ width, height });
      await page.emulateMedia({ reducedMotion: "no-preference", colorScheme: "light" });
      await page.clock.install({ time: new Date("2026-01-01T00:00:00Z") });
      await page.clock.pauseAt(new Date("2026-01-01T00:00:01Z"));
      await page.goto("/?cub-dev=0", { waitUntil: "networkidle" });
      await page.getByTestId("landing-session-deck").waitFor();
      // Measured once the web font has swapped in (a fallback face sets the
      // hero's lines, and so the window's top, differently).
      await page.waitForFunction(() => document.fonts.status === "loaded");
      await page.clock.runFor(100);
    });

    test("fits the window, its composer included, in the first view", async ({ page }) => {
      const frame = await page.getByTestId("landing-session-deck").boundingBox();
      expect(frame!.y + frame!.height).toBeLessThanOrEqual(height);
      expect(await page.evaluate(() => window.scrollY)).toBe(0);
      const composer = await page.locator('[data-testid="landing-session-deck"] [data-landing-composer]').boundingBox();
      expect(composer!.y + composer!.height).toBeLessThanOrEqual(height);
    });

    test("shows Ada's press, the approval, Octo's work and Kim's reply above the fold as they happen", async ({ page }) => {
      await page.getByTestId("landing-scenario-chips").getByRole("button", { name: "Launch a site" }).click();
      await page.mouse.move(2, 2);
      await expect(page.getByTestId("landing-session-deck")).toHaveAttribute("data-example", "site");
      await expect(page.getByTestId("landing-session-deck")).toHaveAttribute("data-beat", "rest");
      const untilBeat = browserTurnClock(page);
      expect(await page.evaluate(() => window.scrollY)).toBe(0);

      await untilBeat("tap");
      await expectAboveFold(page, "landing-browser-request-button", "tap");
      await untilBeat("press");
      await expectAboveFold(page, "landing-browser-request-button", "press");
      await expect(page.getByTestId("landing-browser-request-button")).toHaveText("Opening browser…");
      await expectAboveFold(page, "landing-browser-starting", "press");

      await untilBeat("approve");
      await expectAboveFold(page, "landing-browser-allow", "approve");
      // Ada's ticked choice is in view beside the Allow she presses: the
      // prompt's content is scrolled so its checkbox shows, above the fold.
      await untilBeat("routine");
      // The browser's CSS transition uses rendering time, not the mocked JS
      // clock. Finish the routine-choice scroll before advancing to her press.
      await expect.poll(() => routineChoiceInsidePrompt(page), {
        message: "routine: the checkbox scrolls inside the prompt before Allow is pressed",
      }).toBe(true);
      await untilBeat("allowPress");
      await expectAboveFold(page, "landing-browser-routine-check", "allowPress");
      const checkShown = await routineChoiceInsidePrompt(page);
      expect(checkShown, "allowPress: the ticked checkbox is inside the prompt's visible content").toBe(true);
      await untilBeat("navigate");
      await expectAboveFold(page, "landing-browser-ticker", "navigate");
      await untilBeat("click");
      await expectAboveFold(page, "landing-browser-cursor", "click");
      await expectAboveFold(page, "landing-browser-ticker", "click");
      await untilBeat("reply");
      await expectAboveFold(page, "landing-kim-reply", "reply");
      await expectAboveFold(page, "landing-browser-kim", "reply");
      expect(await page.evaluate(() => window.scrollY)).toBe(0);
    });
  });
}
