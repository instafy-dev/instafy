import { expect, test, type Locator, type Page } from "@playwright/test";
import { RUN_STOP_FIXTURE_STUBS } from "../../fixtures/run-stop-control/dataStubs";

test.beforeEach(async ({ page }) => {
  for (const [path, body] of Object.entries(RUN_STOP_FIXTURE_STUBS)) {
    await page.route(`**${path}*`, route => route.fulfill({ contentType: "application/javascript", body }));
  }
});

async function open(page: Page, surface: string, theme: string) {
  await page.goto(`/tests/fixtures/composer-panels/index.html?surface=${surface}&theme=${theme}`);
  await expect(page.getByTestId("composer-action-menu-trigger")).toBeVisible();
}

async function fitsViewport(page: Page, locator: Locator) {
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  const size = page.viewportSize()!;
  expect(box!.x).toBeGreaterThanOrEqual(-1);
  expect(box!.y).toBeGreaterThanOrEqual(-1);
  expect(box!.x + box!.width).toBeLessThanOrEqual(size.width + 1);
  expect(box!.y + box!.height).toBeLessThanOrEqual(size.height + 1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}

for (const width of [320, 390, 768, 1280]) {
  for (const theme of ["light", "dark"] as const) {
    test.describe(`${width}px ${theme}`, () => {
      test.use({ viewport: { width, height: 900 }, isMobile: width <= 390, hasTouch: width <= 390, colorScheme: theme });

      test("composer menu keeps nested navigation, keyboard focus and disabled guidance usable", async ({ page }) => {
        await open(page, "menu", theme);
        const trigger = page.getByTestId("composer-action-menu-trigger");
        await trigger.click();
        const menu = page.getByTestId("composer-action-menu");
        await fitsViewport(page, menu);
        const separators = await menu.getByRole("separator").evaluateAll(elements => elements.map(element => {
          const style = getComputedStyle(element);
          return { tag: element.tagName, border: style.borderTopWidth, height: style.height, background: style.backgroundColor };
        }));
        expect(separators.length).toBeGreaterThan(0);
        for (const separator of separators) {
          expect(separator).toMatchObject({ tag: "HR", border: "0px", height: "1px" });
          expect(separator.background).not.toBe("rgba(0, 0, 0, 0)");
          expect(separator.background).not.toBe("transparent");
        }
        await expect(page.getByTestId("composer-action-menu-upload-image")).toBeDisabled();
        await page.getByTestId("composer-action-menu-connect").click();
        await fitsViewport(page, menu);
        await page.getByTestId("composer-action-menu-connect-back").focus();
        await page.keyboard.press("End");
        await expect(page.getByTestId("composer-action-menu-connect-browse")).toBeFocused();
        await page.keyboard.press("Home");
        await expect(page.getByTestId("composer-action-menu-connect-back")).toBeFocused();
        await page.getByTestId("composer-action-menu-connect-back").click();
        await page.getByTestId("composer-action-menu-commands").click();
        await fitsViewport(page, menu);
        await page.keyboard.press("Escape");
        await expect(menu).toHaveCount(0);
        await expect(trigger).toBeFocused();
        await trigger.click();
        await page.getByTestId("composer-action-menu-connect").click();
        await page.getByTestId("composer-action-menu-connect-browse").click();
        await expect(page.getByTestId("review-events")).toHaveText('["browse-tools"]');
        await expect(trigger).toBeFocused();
      });

      test("queue and stash popovers fit, scroll, reorder and restore focus", async ({ page }) => {
        await open(page, "queue-edit", theme);
        const queueTrigger = page.getByTestId("chat-send-queue-agent-summary");
        await queueTrigger.click();
        await fitsViewport(page, page.getByTestId("chat-saved-message-popover"));
        await expect(page.getByTestId("chat-send-queue-item")).toHaveCount(6);
        const handle = page.getByTestId("chat-send-queue-reorder").first();
        await handle.focus();
        await page.keyboard.press("Space");
        await expect(page.getByTestId("chat-send-queue-drag-overlay")).toBeVisible();
        // dnd-kit installs its keyboard listener in the next task so pickup
        // cannot also drop. Wait for that task before sending movement.
        await page.evaluate(() => new Promise<void>(resolve => setTimeout(resolve, 0)));
        await page.keyboard.press("ArrowDown");
        await expect(page.getByRole("status").filter({ hasText: "Queued message will move to position 2 of 6." })).toHaveCount(1);
        await page.keyboard.press("Space");
        await expect(page.getByTestId("queue-order")).toHaveText('["queue-2","queue-1","queue-3","queue-4","queue-5","queue-6"]');
        await page.keyboard.press("Escape");
        await expect(page.getByTestId("chat-saved-message-popover")).toHaveCount(0);
        await expect(queueTrigger).toBeFocused();
        await queueTrigger.click();
        await page.getByTestId("chat-send-queue-steer").first().click();
        await expect(page.getByTestId("composer-draft")).toContainText("Then check keyboard accessibility");
        await expect(page.getByRole("button", { name: "Save queue", exact: true })).toBeVisible();
        await page.getByRole("button", { name: "Save queue", exact: true }).click();
        await expect(page.getByTestId("queue-order")).toHaveText('["queue-2","queue-1","queue-3","queue-4","queue-5","queue-6"]');

        await open(page, "stash", theme);
        const stashTrigger = page.getByTestId("chat-message-stashes-summary");
        await stashTrigger.click();
        await fitsViewport(page, page.getByTestId("chat-saved-message-popover"));
        const list = page.getByTestId("chat-message-stashes-list");
        expect(await list.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true);
        if (theme === "dark") expect(await list.evaluate(element => getComputedStyle(element).colorScheme)).toBe("dark");
        await page.getByTestId("chat-message-stash-delete").first().click();
        await expect(page.getByTestId("chat-message-stash-restore")).toHaveCount(5);
        await expect(page.getByTestId("chat-message-stash-restore").first()).toBeFocused();
        await page.keyboard.press("Escape");
        await expect(stashTrigger).toBeFocused();
        await stashTrigger.click();
        await page.getByTestId("chat-message-stash-restore").first().click();
        await expect(page.getByTestId("composer-draft")).toContainText("Save the follow-up questions");
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      });

      test("Stop and Take over confirmations fit and preserve cancellation semantics", async ({ page }) => {
        await open(page, "stop", theme);
        const stop = page.getByTestId("chat-run-stop-button");
        await stop.click();
        const stopDialog = page.getByRole("dialog", { name: "Stop another person's turn?" });
        await fitsViewport(page, stopDialog);
        await expect(page.getByRole("button", { name: "Keep working", exact: true })).toBeFocused();
        await page.keyboard.press("Escape");
        await expect(stopDialog).toHaveCount(0);
        await expect(page.getByTestId("review-events")).toHaveText("[]");
        await expect(stop).toBeFocused();
        await stop.click();
        await page.getByRole("button", { name: "Stop Octo", exact: true }).click();
        await expect(page.getByTestId("review-events")).toHaveText('["stop-confirmed"]');

        await open(page, "takeover", theme);
        const takeover = page.getByTestId("browser-human-input-request");
        await takeover.click();
        const takeoverDialog = page.getByRole("dialog", { name: "Take over browser" });
        await fitsViewport(page, takeoverDialog);
        await page.keyboard.press("Escape");
        await expect(takeoverDialog).toHaveCount(0);
        await expect(page.getByTestId("review-events")).toHaveText("[]");
        await expect(takeover).toBeFocused();
        await takeover.click();
        await page.getByTestId("browser-human-input-takeover").click();
        await expect(page.getByTestId("review-events")).toHaveText('["takeover-confirmed"]');
        await expect(page.getByTestId("browser-human-input-continue")).toBeVisible();
      });
    });
  }
}

for (const theme of ["light", "dark"] as const) {
  test.describe(`320px ${theme} confirmation edge states`, () => {
    test.use({ viewport: { width: 320, height: 900 }, isMobile: true, hasTouch: true, colorScheme: theme });

    test("long Stop label wraps and pending Take over cannot be dismissed", async ({ page }) => {
      await page.goto(`/tests/fixtures/composer-panels/index.html?surface=stop&theme=${theme}&longName=1`);
      await page.getByTestId("chat-run-stop-button").click();
      const stop = page.getByRole("dialog", { name: "Stop another person's turn?" });
      await fitsViewport(page, stop);
      const action = page.getByRole("button", { name: "Stop Octo research and accessibility reviewer", exact: true });
      await fitsViewport(page, action);
      expect(await action.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
      await page.getByRole("button", { name: "Keep working", exact: true }).click();
      await expect(page.getByTestId("review-events")).toHaveText("[]");

      await page.goto(`/tests/fixtures/composer-panels/index.html?surface=takeover&theme=${theme}&outcome=pending`);
      await page.getByTestId("browser-human-input-request").click();
      await page.getByTestId("browser-human-input-takeover").click();
      const dialog = page.getByRole("dialog", { name: "Take over browser" });
      await expect(page.getByTestId("browser-human-input-cancel")).toBeDisabled();
      await expect(page.getByTestId("browser-human-input-takeover")).toBeDisabled();
      await page.keyboard.press("Escape");
      await page.mouse.click(4, 4);
      await expect(dialog).toBeVisible();
      await page.evaluate(() => window.dispatchEvent(new Event("composer-panels:resolve-takeover")));
      await expect(page.getByTestId("review-events")).toHaveText('["takeover-confirmed"]');
      await expect(dialog).toHaveCount(0);
    });

    test("Take over error remains readable and can be dismissed", async ({ page }) => {
      await page.goto(`/tests/fixtures/composer-panels/index.html?surface=takeover&theme=${theme}&outcome=error`);
      await page.getByTestId("browser-human-input-request").click();
      await page.getByTestId("browser-human-input-takeover").click();
      const dialog = page.getByRole("dialog", { name: "Take over browser" });
      await expect(dialog.getByRole("alert")).toContainText("could not confirm");
      await fitsViewport(page, dialog);
      expect(await dialog.getByRole("alert").evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
      await expect(page.getByTestId("browser-human-input-cancel")).toBeEnabled();
      await page.keyboard.press("Escape");
      await expect(dialog).toHaveCount(0);
      await expect(page.getByTestId("review-events")).toHaveText("[]");
    });
  });
}
