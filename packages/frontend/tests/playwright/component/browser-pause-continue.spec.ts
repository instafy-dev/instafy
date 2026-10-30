import { expect, test, type Page } from "@playwright/test";
import { browserPauseBoundaries } from "../../fixtures/browser-pause-continue/boundaries";

// Live drive, Oct 30, at 1024×768: a card's browser turn opened a site, a
// typed turn opened its sign-in page and paused on the fields, and the reply
// said "then choose Let Octo continue". The chat's Browser view was narrow
// enough that its toolbar folded that button into the participants menu, so
// nothing on screen let the task go on. A phone folds it too.

type Review = { takeControlCalls: number; continuations: string[] };
const review = (page: Page) =>
  page.evaluate(() => (window as unknown as { __browserPauseReview: Review }).__browserPauseReview);

async function mount(page: Page, control: "held" | "free") {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("https://**", (route) => {
    errors.push(`Unexpected external request: ${new URL(route.request().url()).origin}`);
    return route.abort();
  });
  for (const [path, body] of Object.entries(browserPauseBoundaries)) {
    await page.route(`**${path}*`, (route) => route.fulfill({ contentType: "application/javascript", body }));
  }
  await page.goto(`/tests/fixtures/browser-pause-continue/index.html?control=${control}`);
  await expect(page.getByTestId("review-browser-page")).toBeVisible();
  // As in the drive, the toolbar's own controls are folded into a menu.
  await expect(page.getByTestId("review-chat-panel")).toHaveAttribute("data-compact", "true");
  await expect(page.getByTestId("shared-browser-collaboration-toggle")).toBeVisible();
  return errors;
}

for (const viewport of [{ width: 1024, height: 768 }, { width: 375, height: 812 }]) {
  const size = `${viewport.width}×${viewport.height}`;
  test.describe(size, () => {
    test.use({ viewport, hasTouch: viewport.width < 640 });

    test(`the sign-in pause shows Let Octo continue and the press continues the turn at ${size}`, async ({ page }) => {
      const errors = await mount(page, "held");
      // One button, on screen without opening any menu.
      const button = page.getByTestId("browser-human-input-continue");
      await expect(button).toBeVisible();
      await expect(button).toHaveCount(1);
      await expect(button).toHaveText("Let Octo continue");
      await expect(page.getByRole("dialog")).toHaveCount(0);
      // In the row under the toolbar, beside what a sign-in leaves behind.
      const row = page.getByTestId("browser-human-input-row");
      await expect(row.getByTestId("browser-human-input-continue")).toBeVisible();
      await expect(row).toContainText("This space's browser keeps you signed in for its chats until you clear it.");
      const box = (await button.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
      expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

      await button.click();
      await expect.poll(async () => (await review(page)).continuations.length).toBe(1);
      expect((await review(page)).continuations[0]).toMatch(/^Continue the previous browser task on this same page\./);
      expect((await review(page)).takeControlCalls).toBe(0);
      // The turn goes on: the pause's row is gone.
      await expect(row).toHaveCount(0);
      expect(errors).toEqual([]);
    });

    test(`with nobody holding the browser, the press takes control first, then continues, at ${size}`, async ({ page }) => {
      const errors = await mount(page, "free");
      const button = page.getByTestId("browser-human-input-continue");
      await expect(button).toBeVisible();
      await expect(button).toHaveText("Let Octo continue");
      await button.click();
      await expect.poll(async () => (await review(page)).continuations.length).toBe(1);
      expect((await review(page)).takeControlCalls).toBe(1);
      expect(errors).toEqual([]);
    });
  });
}
