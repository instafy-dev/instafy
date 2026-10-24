import { expect, test, type Page } from "@playwright/test";
import { RUN_STOP_FIXTURE_STUBS } from "../../fixtures/run-stop-control/dataStubs";

const fixture = "/tests/fixtures/conversation-view-tabs/index.html?context=composer&navigation=compact";
const originalOrder = ["queue-1", "queue-2", "queue-3"];
const trigger = (page: Page) => page.getByTestId("chat-send-queue-agent-summary");
const editor = (page: Page) => page.getByRole("textbox", { name: "Ask Octo" });
const order = async (page: Page): Promise<string[]> => JSON.parse(await page.getByTestId("queue-order").textContent() ?? "[]");

async function openFixture(page: Page, options: { width: number; theme?: string; count?: number; draft?: string; readonly?: boolean; stash?: boolean }) {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  for (const [path, body] of Object.entries(RUN_STOP_FIXTURE_STUBS)) {
    await page.route(`**${path}*`, route => route.fulfill({ contentType: "application/javascript", body }));
  }
  await page.setViewportSize({ width: options.width, height: 900 });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: options.width < 640, maxTouchPoints: 1 });
  const params = new URLSearchParams({ queue: String(options.count ?? 3), theme: options.theme ?? "light" });
  if (options.width >= 1024) params.set("placement", "header");
  if (options.draft) params.set("draft", options.draft);
  if (options.readonly) params.set("readonly", "1");
  if (options.stash) params.set("stash", "1");
  await page.goto(`${fixture}&${params}`, { waitUntil: "domcontentloaded" });
  if (options.count === 0) await expect(editor(page)).toBeVisible();
  else await expect(trigger(page)).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  return { errors, cdp };
}

for (const width of [390, 1280]) for (const theme of ["light", "dark"]) {
  test(`joined queue preserves draft, order and actions in ${theme} at ${width}px`, async ({ page }) => {
    const { errors } = await openFixture(page, { width, theme });
    const surface = page.getByTestId("chat-composer-surface");
    const toolbar = page.getByTestId("chat-composer-joined-toolbar");
    await expect(surface.getByTestId("chat-send-queue-agent-summary")).toBeVisible();
    await expect(toolbar).toBeVisible();
    if (width < 640) {
      await expect(toolbar.getByRole("tab", { name: "Chat", exact: true })).toBeVisible();
      await expect(toolbar.getByRole("tab", { name: "Browser", exact: true })).toBeVisible();
    } else await expect(toolbar.getByRole("tab")).toHaveCount(0);
    await expect(page.getByTestId("chat-send-queue-list")).toHaveCount(0);
    const collapsedBounds = (await surface.boundingBox())!;
    await trigger(page).click();
    await expect(page.getByTestId("chat-send-queue-item")).toHaveCount(3);
    const expandedBounds = (await surface.boundingBox())!;
    expect(expandedBounds.y).toBeCloseTo(collapsedBounds.y, 0);
    const popover = page.getByTestId("chat-saved-message-popover");
    const popoverBounds = (await popover.boundingBox())!;
    expect(popoverBounds.y + popoverBounds.height).toBeLessThanOrEqual(collapsedBounds.y + 8);
    expect(popoverBounds.x).toBeGreaterThanOrEqual(0);
    expect(popoverBounds.x + popoverBounds.width).toBeLessThanOrEqual(width);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

    // The production hook must refuse to replace an unrelated in-progress draft.
    await page.keyboard.press("Escape");
    await editor(page).fill("Keep my unfinished draft");
    await trigger(page).click();
    await page.getByTestId("chat-send-queue-steer").nth(1).click();
    await expect(editor(page)).toHaveText("Keep my unfinished draft");
    await expect.poll(() => order(page)).toEqual(originalOrder);
    await expect(page.getByTestId("queue-status")).toBeVisible();

    // Cancel restores the same entry at the same position.
    await editor(page).press("ControlOrMeta+A");
    await editor(page).press("Backspace");
    await expect(editor(page)).toHaveText("");
    await trigger(page).click();
    await page.getByTestId("chat-send-queue-steer").nth(1).click();
    await expect(editor(page)).toContainText("Then check keyboard accessibility");
    await expect.poll(() => order(page)).toEqual(["queue-1", "queue-3"]);
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect.poll(() => order(page)).toEqual(originalOrder);
    await expect(editor(page)).toHaveText("");

    // Save updates content in place; it must not move the second item to the end.
    await trigger(page).click();
    await page.getByTestId("chat-send-queue-steer").nth(1).click();
    await expect(editor(page)).toContainText("Then check keyboard accessibility");
    // Exercise the editor's keyboard selection pipeline, rather than replacing
    // its contentEditable DOM behind Lexical's selection state with fill().
    await editor(page).press("ControlOrMeta+A");
    await editor(page).press("Backspace");
    await page.keyboard.insertText("Updated second message");
    await expect(editor(page)).toHaveText("Updated second message");
    await page.getByRole("button", { name: "Save queue", exact: true }).click();
    await expect.poll(() => order(page)).toEqual(originalOrder);
    await expect(page.getByTestId("queue-messages")).toContainText("Updated second message");
    await expect(editor(page)).toHaveText("");

    await trigger(page).click();
    await page.getByTestId("chat-send-queue-send-now").nth(1).click();
    await expect(page.getByTestId("sent-messages")).toHaveText('["Updated second message"]');
    await expect.poll(() => order(page)).toEqual(["queue-1", "queue-3"]);
    await page.getByTestId("chat-send-queue-remove").first().click();
    await expect.poll(() => order(page)).toEqual(["queue-3"]);
    await expect(page.getByTestId("chat-send-queue-reorder")).toHaveCount(0);
    expect(errors).toEqual([]);
  });
}

test("queue bubbles keep six long messages scrollable and keyboard reordering reachable", async ({ page }) => {
  const { errors } = await openFixture(page, { width: 390, count: 6 });
  await trigger(page).click();
  await expect(page.getByTestId("chat-send-queue-item")).toHaveCount(6);
  const startKeyboardDrag = async (index: number) => {
    const grip = page.getByTestId("chat-send-queue-reorder").nth(index);
    await grip.focus();
    await expect(grip).toBeInViewport();
    await page.keyboard.press("Space");
    await expect(page.getByTestId("chat-send-queue-drag-overlay")).toBeVisible();
    // dnd-kit defers its keyboard listener to the next task so the pickup key
    // cannot also drop. Complete that task before sending another key.
    await page.evaluate(() => new Promise<void>(resolve => window.setTimeout(resolve, 0)));
  };
  await startKeyboardDrag(0);
  await page.keyboard.press("ArrowDown");
  // Verify the rendered destination before committing the drop.
  await expect(page.getByRole("status").filter({ hasText: "Queued message will move to position 2 of 6." })).toHaveCount(1);
  await page.keyboard.press("Space");
  await expect.poll(() => order(page)).toEqual(["queue-2", "queue-1", "queue-3", "queue-4", "queue-5", "queue-6"]);
  await expect(page.getByTestId("chat-send-queue-drag-overlay")).toHaveCount(0);

  // Focusing the final row scrolls the bubble list. Reordering upward must use
  // the new scrolled coordinates, and Escape must leave that order intact.
  await startKeyboardDrag(5);
  await page.keyboard.press("ArrowUp");
  await expect(page.getByRole("status").filter({ hasText: "Queued message will move to position 5 of 6." })).toHaveCount(1);
  await page.keyboard.press("Space");
  const reordered = ["queue-2", "queue-1", "queue-3", "queue-4", "queue-6", "queue-5"];
  await expect.poll(() => order(page)).toEqual(reordered);
  await expect(page.getByTestId("chat-send-queue-drag-overlay")).toHaveCount(0);
  await startKeyboardDrag(4);
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("status").filter({ hasText: "Queued message will move to position 6 of 6." })).toHaveCount(1);
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("chat-send-queue-drag-overlay")).toHaveCount(0);
  await expect.poll(() => order(page)).toEqual(reordered);
  await expect(page.getByTestId("chat-send-queue-list")).toBeVisible();
  const lastRemove = page.getByTestId("chat-send-queue-remove").last();
  await lastRemove.focus();
  await expect(lastRemove).toBeInViewport();
  await lastRemove.press("Enter");
  await expect.poll(() => order(page)).toEqual(["queue-2", "queue-1", "queue-3", "queue-4", "queue-6"]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("chat-send-queue-list")).toHaveCount(0);
  expect(errors).toEqual([]);
});

for (const touch of [false, true]) {
  test(`queue drag handle preserves ${touch ? "touch" : "mouse"} reordering in the bubble layout`, async ({ page }) => {
    const { errors, cdp } = await openFixture(page, { width: touch ? 390 : 1280 });
    await trigger(page).click();
    const first = (await page.getByTestId("chat-send-queue-reorder").first().boundingBox())!;
    const second = (await page.getByTestId("chat-send-queue-reorder").nth(1).boundingBox())!;
    const start = { x: first.x + first.width / 2, y: first.y + first.height / 2 };
    const end = { x: second.x + second.width / 2, y: second.y + second.height / 2 };
    if (touch) {
      await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [start] });
      await page.waitForTimeout(250); // Existing TouchSensor long-press threshold is 200 ms.
      await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [end] });
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    } else {
      await page.mouse.move(start.x, start.y);
      await page.mouse.down();
      await page.mouse.move(end.x, end.y, { steps: 10 });
      await page.mouse.up();
    }
    await expect.poll(() => order(page)).toEqual(["queue-2", "queue-1", "queue-3"]);
    await expect(page.getByTestId("chat-send-queue-list")).toBeVisible();
    expect(errors).toEqual([]);
  });
}

test("read-only queue keeps the bubble list visible while disabling mutations", async ({ page }) => {
  const { errors } = await openFixture(page, { width: 390, readonly: true });
  await trigger(page).click();
  for (const name of ["chat-send-queue-steer", "chat-send-queue-remove", "chat-send-queue-send-now", "chat-send-queue-reorder"]) {
    for (const button of await page.getByTestId(name).all()) await expect(button).toBeDisabled();
  }
  await expect.poll(() => order(page)).toEqual(originalOrder);
  expect(errors).toEqual([]);
});

for (const theme of ["light", "dark"]) for (const fontSize of [16, 20]) {
  test(`joined toolbar fits stashed drafts and queue controls at 320px in ${theme} with ${fontSize}px text`, async ({ page }) => {
    const { errors } = await openFixture(page, { width: 320, stash: true, theme });
    // Exercise wider system-font metrics / increased text size without shrinking
    // the labels or their touch targets to make them fit.
    await page.addStyleTag({ content: `html { font-size: ${fontSize}px; }` });
    const toolbar = page.getByTestId("chat-composer-joined-toolbar");
    const stash = page.getByTestId("chat-message-stashes-summary");
    await expect(stash).toBeInViewport();
    await expect(trigger(page)).toBeInViewport();
    const toolbarBounds = (await toolbar.boundingBox())!;
    expect(toolbarBounds.x + toolbarBounds.width).toBeLessThanOrEqual(320);
    const viewport = toolbar.getByTestId("conversation-resource-tabs").locator(".overflow-x-auto");
    const tabs = ["Chat", "Browser"].map(name => toolbar.getByRole("tab", { name, exact: true }));
    for (const tab of tabs) await expect(tab).toBeVisible();
    await expect.poll(async () => {
      const viewBounds = (await viewport.boundingBox())!;
      return (await Promise.all(tabs.map(async tab => {
        const bounds = (await tab.boundingBox())!;
        return bounds.x >= viewBounds.x - 1 && bounds.x + bounds.width <= viewBounds.x + viewBounds.width + 1;
      }))).every(Boolean);
    }).toBe(true);
    await expect(toolbar.getByRole("button", { name: /Scroll views/ })).toHaveCount(0);
    const viewsBounds = (await toolbar.getByTestId("conversation-subtabs").boundingBox())!;
    const controlsBounds = (await page.getByTestId("chat-saved-message-controls").boundingBox())!;
    expect(controlsBounds.y >= viewsBounds.y + viewsBounds.height || controlsBounds.x >= viewsBounds.x + viewsBounds.width).toBe(true);
    for (const button of [stash, trigger(page), ...tabs]) {
      const bounds = (await button.boundingBox())!;
      expect(bounds.width).toBeGreaterThanOrEqual(44);
      expect(bounds.height).toBeGreaterThanOrEqual(44);
    }
    const browser = toolbar.getByRole("tab", { name: "Browser", exact: true });
    await browser.focus();
    await browser.press("Enter");
    await expect(browser).toHaveAttribute("aria-selected", "true");
    await trigger(page).click();
    await expect(page.getByRole("dialog", { name: "Queued messages" })).toBeVisible();
    await stash.click();
    await expect(page.getByRole("dialog", { name: "Stashed drafts" })).toBeVisible();
    await expect(page.getByRole("dialog", { name: "Queued messages" })).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(errors).toEqual([]);
  });
}

test("joined toolbar hides an empty queue while keeping the mobile views and editor", async ({ page }) => {
  const { errors } = await openFixture(page, { width: 320, count: 0 });
  await expect(editor(page)).toBeVisible();
  await expect(trigger(page)).toHaveCount(0);
  await expect(page.getByTestId("chat-composer-joined-toolbar").getByRole("tab", { name: "Chat", exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

for (const width of [390, 1280]) {
  test(`editing a queued message saves in place with the ${width < 640 ? "mobile primary control" : "desktop Enter key"}`, async ({ page }) => {
    const { errors } = await openFixture(page, { width });
    await trigger(page).click();
    await page.getByTestId("chat-send-queue-steer").nth(1).click();
    await expect(editor(page)).toContainText("Then check keyboard accessibility");
    await editor(page).press("ControlOrMeta+A");
    await editor(page).press("Backspace");
    await expect(page.getByTestId("chat-send-button")).toHaveAccessibleName("Save queued message");
    await expect(page.getByTestId("chat-send-button")).toBeDisabled();
    await page.keyboard.insertText("Revised queued instruction");
    await expect(page.getByTestId("chat-send-button")).toHaveAccessibleName("Save queued message");
    if (width < 640) await page.getByTestId("chat-send-button").click();
    else await editor(page).press("Enter");
    await expect.poll(() => order(page)).toEqual(originalOrder);
    await expect(page.getByTestId("queue-messages")).toContainText("Revised queued instruction");
    await expect(page.getByTestId("sent-messages")).toHaveText("[]");
    await expect(editor(page)).toHaveText("");
    expect(errors).toEqual([]);
  });
}
