import { expect, test, type Locator, type Page } from "@playwright/test";
import { RUN_STOP_FIXTURE_STUBS } from "../../fixtures/run-stop-control/dataStubs";

const fixture = "/tests/fixtures/conversation-view-tabs/index.html?context=composer&navigation=compact";
const originalOrder = ["queue-1", "queue-2", "queue-3"];
const trigger = (page: Page) => page.getByTestId("chat-send-queue-agent-summary");
const editor = (page: Page) => page.getByRole("textbox", { name: "Ask Octo" });
const order = async (page: Page): Promise<string[]> => JSON.parse(await page.getByTestId("queue-order").textContent() ?? "[]");
// The shared Button's focus ring transitions in. Read it only once no
// transition runs: mid-transition Chromium reports the same ring in other
// colour formats (rgba(255, 255, 255, 1) for the settled rgb(255, 255, 255)).
const settledBoxShadow = (locator: Locator) => locator.evaluate(async node => {
  await Promise.all(node.getAnimations().map(animation => animation.finished));
  return getComputedStyle(node).boxShadow;
});

async function openFixture(page: Page, options: { width: number; theme?: string; count?: number; draft?: string; readonly?: boolean; stash?: boolean; utilities?: boolean; attachments?: number; sending?: boolean; messages?: boolean }) {
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
  if (options.utilities) params.set("utilities", "1");
  if (options.attachments !== undefined) params.set("attachments", String(options.attachments));
  if (options.sending) params.set("sending", "1");
  if (options.messages) params.set("messages", "1");
  await page.goto(`${fixture}&${params}`, { waitUntil: "domcontentloaded" });
  if (options.count === 0) await expect(editor(page)).toBeVisible();
  else await expect(trigger(page)).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  return { errors, cdp };
}

for (const width of [320, 1280]) for (const theme of ["light", "dark"]) {
  test(`counted queue and stash icons keep labelled navigation and keyboard access in ${theme} at ${width}px`, async ({ page }) => {
    const { errors } = await openFixture(page, { width, theme, count: 3, stash: true, draft: "Keep this unfinished draft" });
    const queue = trigger(page);
    const stash = page.getByTestId("chat-message-stashes-summary");
    await expect(queue).toHaveText("3");
    await expect(queue).toHaveAccessibleName("Queued messages (3)");
    await expect(stash).toHaveText("1");
    await expect(stash).toHaveAccessibleName("Stashed drafts (1)");
    for (const name of ["Chat", "Browser"]) {
      const tab = page.getByRole("tab", { name, exact: true });
      await expect(tab).toBeVisible();
      await expect(tab).toHaveText(name);
    }

    const surface = (await page.getByTestId("chat-composer-surface").boundingBox())!;
    const targetSize = width < 640 ? 44 : 32;
    for (const button of [stash, queue]) {
      const bounds = (await button.boundingBox())!;
      expect(bounds.width).toBe(targetSize);
      expect(bounds.height).toBe(targetSize);
      const badge = (await button.locator('span[aria-hidden="true"]').boundingBox())!;
      // Badges float outside their trigger, but remain inside the clipped composer.
      expect(badge.x).toBeGreaterThanOrEqual(surface.x);
      expect(badge.y).toBeGreaterThanOrEqual(surface.y);
      expect(badge.x + badge.width).toBeLessThanOrEqual(surface.x + surface.width);
      expect(badge.y + badge.height).toBeLessThanOrEqual(surface.y + surface.height);
    }
    await page.keyboard.press("Tab");
    await queue.focus();
    await queue.press("Enter");
    const dialog = page.getByRole("dialog", { name: "Queued messages", exact: true });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("heading", { name: "Queued messages", exact: true })).toBeVisible();
    await expect(queue).toHaveAttribute("aria-expanded", "true");
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(queue).toBeFocused();
    await expect(queue).toHaveAttribute("aria-expanded", "false");
    await stash.press("Enter");
    await expect(page.getByTestId("chat-message-stash-restore").first()).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(stash).toBeFocused();
    await expect(editor(page)).toHaveText("Keep this unfinished draft");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(errors).toEqual([]);
  });
}

for (const width of [320, 1280]) for (const theme of ["light", "dark"]) {
  test(`composer and sent image thumbnails share flat styling and keyboard previews in ${theme} at ${width}px`, async ({ page }) => {
    const { errors } = await openFixture(page, { width, theme, count: 0, attachments: 1, messages: true });
    const composerThumbnail = page.getByTestId("chat-image-upload-preview-item-0");
    const messageThumbnails = page.getByTestId("chat-image-attachment-thumbnail");
    await expect(messageThumbnails).toHaveCount(3);
    const thumbnails = [composerThumbnail, messageThumbnails.first()];
    for (const [index, thumbnail] of thumbnails.entries()) {
      await expect(thumbnail).toHaveCSS("box-shadow", "none");
      await expect(thumbnail).toHaveCSS("border-radius", "8px");
      const bounds = (await thumbnail.boundingBox())!;
      expect(bounds.width).toBe(index === 0 ? 48 : 96);
      expect(bounds.height).toBe(index === 0 ? 48 : 96);
      await expect(thumbnail.locator("img")).toHaveJSProperty("naturalWidth", 1200);
      await expect(thumbnail.locator("img")).toHaveJSProperty("naturalHeight", 630);
    }
    const firstBounds = (await messageThumbnails.first().boundingBox())!;
    const lastBounds = (await messageThumbnails.last().boundingBox())!;
    if (width < 640) expect(lastBounds.y).toBeGreaterThan(firstBounds.y);
    else expect(lastBounds.y).toBe(firstBounds.y);

    let sharedFocusRing = "";
    for (const thumbnail of thumbnails) {
      await page.keyboard.press("Tab");
      await thumbnail.focus();
      await expect(thumbnail).toBeFocused();
      expect(await thumbnail.evaluate(node => node.matches(":focus-visible"))).toBe(true);
      // Compare the settled 2px ring plus 2px offset of both thumbnails.
      await expect.poll(() => settledBoxShadow(thumbnail)).toMatch(/ 0px 0px 0px 4px(?:,|$)/);
      const focusRing = await settledBoxShadow(thumbnail);
      if (sharedFocusRing) expect(focusRing).toBe(sharedFocusRing);
      else sharedFocusRing = focusRing;
      await thumbnail.press("Enter");
      const preview = page.getByRole("dialog", { name: "Image preview", exact: true });
      await expect(preview).toBeVisible();
      await expect(preview.getByTestId("chat-image-lightbox-image")).toHaveJSProperty("naturalWidth", 1200);
      await preview.getByRole("button", { name: "Close image preview", exact: true }).press("Enter");
      await expect(preview).toHaveCount(0);
    }
    const remove = page.getByTestId("chat-image-upload-remove");
    await remove.focus();
    await remove.press("Enter");
    await expect(page.getByTestId("chat-image-upload-preview")).toHaveCount(0);
    await expect(messageThumbnails).toHaveCount(3);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(errors).toEqual([]);
  });
}

for (const width of [320, 390, 1280]) for (const theme of ["light", "dark"]) {
  test(`attachment previews stay above the input in ${theme} at ${width}px`, async ({ page }) => {
    const draft = "Review these social cards";
    const { errors } = await openFixture(page, { width, theme, count: 0, attachments: 12, draft });
    const surface = page.getByTestId("chat-composer-surface");
    const tray = surface.getByTestId("chat-image-upload-preview");
    const list = tray.getByTestId("chat-image-upload-list");
    const remove = tray.getByTestId("chat-image-upload-remove");
    const assertLayout = async (count: number) => {
      await expect(remove).toHaveCount(count);
      await expect(editor(page)).toHaveText(draft);
      await expect(editor(page)).toBeInViewport({ ratio: 1 });
      const surfaceBounds = (await surface.boundingBox())!;
      const trayBounds = (await tray.boundingBox())!;
      const inputBounds = (await editor(page).boundingBox())!;
      expect(trayBounds.x).toBeGreaterThanOrEqual(surfaceBounds.x);
      expect(trayBounds.x + trayBounds.width).toBeLessThanOrEqual(surfaceBounds.x + surfaceBounds.width);
      expect(trayBounds.y).toBeGreaterThanOrEqual(surfaceBounds.y);
      expect(trayBounds.y + trayBounds.height).toBeLessThanOrEqual(inputBounds.y);
      expect(inputBounds.y + inputBounds.height).toBeLessThanOrEqual(surfaceBounds.y + surfaceBounds.height);
      expect(await tray.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
      expect(await list.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    };

    for (const count of [12, 4, 1]) {
      await assertLayout(count);
      if (count > 1) expect(await list.evaluate(node => node.scrollHeight > node.clientHeight)).toBe(true);
      await page.getByTestId("composer-action-menu-trigger").click();
      await page.getByRole("button", { name: "Expand draft", exact: true }).click();
      await expect(page.getByRole("button", { name: "Collapse draft", exact: true })).toBeVisible();
      await assertLayout(count);
      if (count > 1) {
        expect(await list.evaluate(node => node.scrollHeight > node.clientHeight)).toBe(true);
        await remove.last().focus();
        await expect(remove.last()).toBeInViewport({ ratio: 1 });
        expect(await list.evaluate(node => node.scrollTop)).toBeGreaterThan(0);
        await expect(editor(page)).toBeInViewport({ ratio: 1 });
      }
      const nextCount = count === 12 ? 4 : count === 4 ? 1 : 0;
      for (let remaining = count; remaining > nextCount; remaining--) {
        await remove.last().focus();
        await remove.last().press("Enter");
        await expect(remove).toHaveCount(remaining - 1);
      }
      await expect(editor(page)).toHaveText(draft);
      await page.getByRole("button", { name: "Collapse draft", exact: true }).click();
    }
    await expect(tray).toHaveCount(0);
    await expect(editor(page)).toBeInViewport({ ratio: 1 });
    expect(errors).toEqual([]);
  });
}

test("sending attachment status remains visible while a long preview list scrolls", async ({ page }) => {
  const { errors } = await openFixture(page, { width: 390, count: 0, attachments: 12, sending: true });
  const tray = page.getByTestId("chat-image-upload-preview");
  const list = tray.getByTestId("chat-image-upload-list");
  const status = tray.getByTestId("chat-image-upload-status");
  await expect(tray).toHaveAttribute("aria-busy", "true");
  await expect(status).toContainText("12");
  await expect(tray.getByTestId("chat-image-upload-remove")).toHaveCount(12);
  for (const button of await tray.getByTestId("chat-image-upload-remove").all()) await expect(button).toBeDisabled();
  for (const expanded of [false, true]) {
    if (expanded) {
      await page.getByTestId("composer-action-menu-trigger").click();
      await page.getByRole("button", { name: "Expand draft", exact: true }).click();
    }
    for (const atEnd of [false, true]) {
      await list.evaluate((node, end) => { node.scrollTop = end ? node.scrollHeight : 0; }, atEnd);
      if (atEnd) expect(await list.evaluate(node => node.scrollTop)).toBeGreaterThan(0);
      await expect(status).toBeInViewport({ ratio: 1 });
      await expect(editor(page)).toBeInViewport({ ratio: 1 });
      const listBounds = (await list.boundingBox())!;
      const statusBounds = (await status.boundingBox())!;
      const inputBounds = (await editor(page).boundingBox())!;
      expect(statusBounds.y).toBeGreaterThanOrEqual(listBounds.y + listBounds.height);
      expect(statusBounds.y + statusBounds.height).toBeLessThanOrEqual(inputBounds.y);
    }
  }
  expect(errors).toEqual([]);
});

for (const width of [320, 1280]) for (const theme of ["light", "dark"]) {
  test(`composer utilities, the new-tab token and the browser follow-up token remain reachable in ${theme} at ${width}px`, async ({ page }) => {
    const { errors } = await openFixture(page, { width, theme, utilities: true });
    const goal = page.getByTestId("chat-active-goal");
    const summary = page.getByTestId("chat-active-goal-summary");
    await expect(summary).toBeVisible();
    // Utility targets must not squeeze the goal's title into an unreadable sliver.
    expect((await summary.boundingBox())!.width).toBeGreaterThanOrEqual(80);
    const goalBounds = (await goal.boundingBox())!;
    const utilities = ["Show goal details", "Resume goal", "Clear goal"].map(name => goal.getByRole("button", { name, exact: true }));
    for (const button of utilities) {
      const bounds = (await button.boundingBox())!;
      expect(bounds.x).toBeGreaterThanOrEqual(goalBounds.x);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(goalBounds.x + goalBounds.width);
      expect(bounds.y + bounds.height).toBeLessThanOrEqual(goalBounds.y + goalBounds.height);
      expect(await button.evaluate(node => getComputedStyle(node).borderRadius)).toBe("8px");
      if (width < 640) {
        expect(bounds.width).toBeGreaterThanOrEqual(44);
        expect(bounds.height).toBeGreaterThanOrEqual(44);
      }
    }
    const first = (await utilities[0].boundingBox())!;
    const second = (await utilities[1].boundingBox())!;
    expect(second.x - first.x - first.width).toBeGreaterThanOrEqual(8);
    await utilities[0].click();
    await expect(goal.getByRole("button", { name: "Help unblock", exact: true })).toBeVisible();
    await goal.getByRole("button", { name: "Hide goal details", exact: true }).click();
    await utilities[1].click();
    await expect(page.getByTestId("review-goal-status")).toHaveText("active");
    await goal.getByRole("button", { name: "Pause goal", exact: true }).click();
    await expect(page.getByTestId("review-goal-status")).toHaveText("paused");

    const stash = page.getByTestId("chat-message-stashes-summary");
    await stash.click();
    const restores = page.getByTestId("chat-message-stash-restore");
    const deletes = page.getByTestId("chat-message-stash-delete");
    await expect(restores).toHaveCount(3);
    await expect(deletes).toHaveCount(3);
    for (const button of [restores.first(), deletes.first()]) {
      await expect(button).toBeInViewport();
      const bounds = (await button.boundingBox())!;
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
      if (width < 640) expect(bounds.height).toBeGreaterThanOrEqual(44);
    }
    expect(await deletes.first().evaluate(node => getComputedStyle(node).borderRadius)).toBe("8px");
    await page.keyboard.press("Tab");
    await restores.first().focus();
    await expect(restores.first()).toBeFocused();
    await restores.first().press("Enter");
    await expect(editor(page)).toContainText("Compare keyboard navigation and touch targets");
    await expect(page.getByRole("dialog", { name: "Stashed drafts" })).toHaveCount(0);
    await stash.click();
    // The popover schedules initial focus after mounting. Wait for it before
    // moving to Delete so its initial focus cannot overtake this keyboard step.
    await expect(restores.first()).toBeFocused();
    await deletes.first().focus();
    await expect(deletes.first()).toBeFocused();
    await deletes.first().press("Enter");
    await expect(restores).toHaveCount(2);
    await expect(editor(page)).toContainText("Compare keyboard navigation and touch targets");
    await page.keyboard.press("Escape");
    await expect(stash).toBeFocused();
    await page.getByTestId("chat-image-upload-remove").click();
    await expect(page.getByTestId("chat-image-upload-preview")).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

    // A pending new tab is one removable token above the input: the chat has
    // no page strip, as the Browser view and the pane's tab picker list the tabs.
    await page.goto(`${fixture}&newtab=1&queue=0&theme=${theme}${width >= 1024 ? "&placement=header" : ""}`);
    const token = page.getByTestId("composer-new-tab-token");
    await expect(token).toHaveText("New tab for the next message");
    await expect(page.getByTestId("browser-session-page-strip")).toHaveCount(0);
    const cancelNewTab = token.getByRole("button", { name: "Cancel new tab" });
    if (width < 640) expect((await cancelNewTab.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    expect((await token.boundingBox())!.y + (await token.boundingBox())!.height)
      .toBeLessThanOrEqual((await editor(page).boundingBox())!.y);
    await cancelNewTab.focus();
    await expect(cancelNewTab).toBeInViewport();
    await cancelNewTab.press("Enter");
    await expect(page.getByTestId("review-new-tab-pending")).toHaveText("false");
    await expect(token).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

    // A message that goes on in Instafy's browser says so in the same row,
    // whole, and the person can keep it in the chat.
    await page.goto(`${fixture}&followup=1&queue=0&theme=${theme}${width >= 1024 ? "&placement=header" : ""}`);
    const followUp = page.getByTestId("composer-browser-follow-up-token");
    await expect(followUp).toHaveText("Goes to Instafy's browser");
    const label = followUp.getByText("Goes to Instafy's browser");
    expect(await label.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
    const keepInChat = followUp.getByRole("button", { name: "Don't send it to the browser" });
    if (width < 640) expect((await keepInChat.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    expect((await followUp.boundingBox())!.y + (await followUp.boundingBox())!.height)
      .toBeLessThanOrEqual((await editor(page).boundingBox())!.y);
    await keepInChat.focus();
    await expect(keepInChat).toBeInViewport();
    await keepInChat.press("Enter");
    await expect(page.getByTestId("review-browser-follow-up")).toHaveText("false");
    await expect(followUp).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(errors).toEqual([]);
  });
}

for (const width of [390, 1280]) for (const theme of ["light", "dark"]) {
  test(`the Browser view tab names its active page and shows when Octo uses the browser in ${theme} at ${width}px`, async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    for (const [path, body] of Object.entries(RUN_STOP_FIXTURE_STUBS)) {
      await page.route(`**${path}*`, route => route.fulfill({ contentType: "application/javascript", body }));
    }
    await page.setViewportSize({ width, height: 700 });
    const view = `/tests/fixtures/conversation-view-tabs/index.html?theme=${theme}&page=${encodeURIComponent("Results for Belém Tower")}${width >= 1024 ? "&placement=header" : ""}`;
    await page.goto(`${view}&agent=1`);
    const browser = page.getByTestId("conversation-subtab-browser");
    await expect(browser).toHaveAccessibleName("Browser, Octo is using the browser");
    await expect(browser).toHaveAccessibleDescription("Browser · Results for Belém Tower");
    await expect(browser).toHaveAttribute("title", "Browser · Results for Belém Tower");
    const dot = page.getByTestId("conversation-subtab-browser-busy");
    await expect(dot).toBeVisible();
    const tab = (await browser.boundingBox())!;
    const marker = (await dot.boundingBox())!;
    expect(marker.x).toBeGreaterThanOrEqual(tab.x);
    expect(marker.x + marker.width).toBeLessThanOrEqual(tab.x + tab.width);
    await browser.focus();
    await browser.press("ArrowLeft");
    await expect(page.getByTestId("conversation-subtab-chat")).toBeFocused();
    await page.goto(view);
    await expect(page.getByTestId("conversation-subtab-browser")).toHaveAccessibleName("Browser");
    await expect(dot).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(errors).toEqual([]);
  });
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
