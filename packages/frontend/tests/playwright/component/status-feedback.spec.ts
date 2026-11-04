import { expect, test, type Locator, type Page } from "@playwright/test";
import { statusFeedbackBoundaries } from "../../fixtures/status-feedback/boundaries";

const fixture = "/tests/fixtures/status-feedback/index.html";
type ReviewWindow = Window & { __review: Record<string, (...args: unknown[]) => unknown> & { counters: Record<string, number> } };

async function mount(page: Page, surface: string, theme = "light", extra = "") {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("https://**", route => {
    errors.push(`Unexpected external request: ${new URL(route.request().url()).origin}`);
    return route.abort();
  });
  for (const [path, body] of Object.entries(statusFeedbackBoundaries)) {
    if (path.startsWith("virtual:")) continue;
    await page.route(`**${path}*`, route => route.fulfill({ contentType: "application/javascript", body }));
  }
  await page.emulateMedia({ colorScheme: theme });
  await page.goto(`${fixture}?surface=${surface}&theme=${theme}${extra}`);
  await expect(page.getByRole("main")).toBeVisible();
  await expect.poll(() => page.evaluate(() => typeof (window as ReviewWindow).__review?.triggerToast)).toBe("function");
  return errors;
}

async function inViewport(page: Page, locator: Locator) {
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  const viewport = page.viewportSize()!;
  expect(box!.x).toBeGreaterThanOrEqual(-1);
  expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width + 1);
  expect(box!.y).toBeGreaterThanOrEqual(-1);
  expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height + 1);
}

async function noOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}

test("ordinary information waits behind recovery and is shown after recovery closes", async ({ page }) => {
  const errors = await mount(page, "behavior");
  await page.clock.install();
  await page.evaluate(() => {
    const review = (window as ReviewWindow).__review;
    review.recovery();
    review.information();
  });
  const toast = page.getByTestId("status-toast");
  await expect(toast).toContainText("Couldn’t save your changes");
  await page.clock.fastForward(7000);
  await expect(toast.getByRole("button", { name: "Retry", exact: true })).toBeVisible();
  await toast.getByRole("button", { name: "Retry", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as ReviewWindow).__review.counters.retry)).toBe(1);
  await expect(toast).toContainText("Your export is ready.");
  expect(errors).toEqual([]);
});

test("updating a focused notice preserves readable time until focus leaves", async ({ page }) => {
  const errors = await mount(page, "behavior");
  await page.clock.install();
  await page.evaluate(() => (window as ReviewWindow).__review.information());
  const toast = page.getByTestId("status-toast");
  const dismiss = toast.getByRole("button", { name: "Dismiss notification" });
  await dismiss.focus();
  await page.clock.fastForward(6000);
  await page.evaluate(() => (window as ReviewWindow).__review.information("Your updated export is ready."));
  await expect(toast).toContainText("Your updated export is ready.");
  await expect(dismiss).toBeFocused();
  await page.clock.fastForward(6000);
  await expect(toast).toBeVisible();
  await page.getByTestId("review-secondary").focus();
  await page.clock.fastForward(5100);
  await expect(toast).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("hovering an informational notice pauses reading time until the pointer leaves", async ({ page }) => {
  const errors = await mount(page, "behavior");
  await page.clock.install();
  await page.evaluate(() => (window as ReviewWindow).__review.information());
  const toast = page.getByTestId("status-toast");
  await toast.hover();
  await page.clock.fastForward(6000);
  await expect(toast).toBeVisible();
  await page.mouse.move(0, 0);
  await page.clock.fastForward(5100);
  await expect(toast).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("preview reading time pauses when a reduced visual viewport obscures it", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const errors = await mount(page, "location");
  await page.clock.install();
  const toast = page.getByTestId("preview-location-toast");
  await expect(toast).toBeVisible();
  expect((await toast.boundingBox())!.y + (await toast.boundingBox())!.height).toBeGreaterThan(100);
  await page.evaluate(() => {
    Object.defineProperty(window.visualViewport!, "height", { configurable: true, value: 100 });
    window.visualViewport!.dispatchEvent(new Event("resize"));
  });
  await page.clock.runFor(100);
  await page.clock.fastForward(9000);
  await expect(toast).toBeVisible();
  await page.evaluate(() => {
    Object.defineProperty(window.visualViewport!, "height", { configurable: true, value: innerHeight });
    window.visualViewport!.dispatchEvent(new Event("resize"));
  });
  await page.clock.runFor(100);
  await page.clock.fastForward(8100);
  await expect(toast).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("Undo keeps its absolute offer deadline while focused or waiting behind recovery", async ({ page }) => {
  const errors = await mount(page, "behavior");
  await page.clock.install();
  await page.evaluate(() => (window as ReviewWindow).__review.deadlineUndo());
  const toast = page.getByTestId("status-toast");
  await toast.getByRole("button", { name: "Undo", exact: true }).focus();
  await page.clock.fastForward(6100);
  await expect(toast).toHaveCount(0);
  await page.keyboard.press("Enter");
  expect(await page.evaluate(() => (window as ReviewWindow).__review.counters.undo)).toBe(0);
  await page.evaluate(() => {
    const review = (window as ReviewWindow).__review;
    review.recovery();
    review.deadlineUndo();
  });
  await page.clock.fastForward(6100);
  await toast.getByRole("button", { name: "Dismiss notification" }).click();
  await expect(toast).toHaveCount(0);
  expect(await page.evaluate(() => (window as ReviewWindow).__review.counters.undo)).toBe(0);
  expect(errors).toEqual([]);
});

test("informational time pauses while a short viewport clips the notice", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 100 });
  const errors = await mount(page, "behavior");
  await page.clock.install();
  await page.evaluate(() => (window as ReviewWindow).__review.information("Your export is ready. The download includes all selected files, saved versions, and the latest conversation attachments."));
  const toast = page.getByTestId("status-toast");
  await expect(toast).toBeVisible();
  const region = page.getByRole("region").filter({ has: toast });
  expect((await toast.boundingBox())!.height).toBeGreaterThan((await region.boundingBox())!.height);
  await page.clock.runFor(150);
  await page.clock.fastForward(6000);
  await expect(toast).toBeVisible();
  await page.setViewportSize({ width: 320, height: 844 });
  await inViewport(page, toast);
  await page.clock.runFor(150);
  await page.clock.fastForward(5100);
  await expect(toast).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("location Stop and dismiss return focus only when their notice owned it", async ({ page }) => {
  const errors = await mount(page, "location");
  const address = page.getByRole("textbox", { name: "Address" });
  const toast = page.getByTestId("preview-location-toast");
  await address.focus();
  await toast.getByTestId("preview-location-toast-stop").focus();
  await page.keyboard.press("Enter");
  await expect(toast).toHaveCount(0);
  await expect(address).toBeFocused();
  await page.evaluate(() => (window as ReviewWindow).__review.showPreview());
  await toast.getByRole("button", { name: /^Dismiss/ }).focus();
  await page.keyboard.press("Enter");
  await expect(address).toBeFocused();
  await page.evaluate(() => (window as ReviewWindow).__review.showPreview());
  await toast.getByTestId("preview-location-toast-stop").focus();
  const reload = page.getByRole("button", { name: "Reload page" });
  await reload.focus();
  await page.evaluate(() => (window as ReviewWindow).__review.clear());
  await expect(reload).toBeFocused();
  expect(errors).toEqual([]);
});

for (const width of [320, 390, 768, 1280]) {
  test.describe(`${width}px status feedback`, () => {
    test.use({ viewport: { width, height: 844 }, hasTouch: width < 640 });
    for (const theme of ["light", "dark"]) {
      test(`${theme}: long feedback keeps the complete message and every action reachable`, async ({ page }) => {
        const errors = await mount(page, "toast-unbroken", theme);
        await page.evaluate(() => (window as ReviewWindow).__review.triggerToast("toast-action", `Couldn’t open https://example.test/${"long-unbroken-path-".repeat(15)}`, 0));
        const toast = page.getByTestId("status-toast");
        await expect(toast).toBeVisible();
        await inViewport(page, toast);
        const retry = toast.getByRole("button", { name: "Retry", exact: true });
        const dismiss = toast.getByRole("button", { name: "Dismiss notification" });
        await inViewport(page, retry);
        await inViewport(page, dismiss);
        if (width < 640) {
          expect((await retry.boundingBox())!.height).toBeGreaterThanOrEqual(44);
          expect((await dismiss.boundingBox())!.height).toBeGreaterThanOrEqual(44);
        }
        await noOverflow(page);
        await retry.focus();
        await page.keyboard.press("Enter");
        await expect.poll(() => page.evaluate(() => (window as ReviewWindow).__review.counters.retry)).toBe(1);
        await expect(toast).toHaveCount(0);
        expect(errors).toEqual([]);
      });

      test(`${theme}: notice actions form a consistent footer aligned with the message`, async ({ page }) => {
        for (const [surface, noticeId, message, actions] of [
          ["location", "preview-location-toast", "Lisbon neighbourhoods, viewpoints, museums and places to explore can see your location", ["Stop"]],
          ["toast-action", "status-toast", "Couldn’t connect to the workspace. Your latest changes are still here. Check your internet connection, then try again.", ["Retry"]],
          ["location-approval", "site-ask-confirm", "Send “Add these nearby places to my visit plan and show me a walking route before booking any tickets or sharing my personal details.” as you?", ["Cancel", "Send"]],
        ] as const) {
          const errors = await mount(page, surface, theme);
          const notice = page.getByTestId(noticeId);
          const text = notice.getByText(message, { exact: true });
          await expect(text).toBeVisible();
          const textBox = (await text.boundingBox())!;
          const noticeBox = (await notice.boundingBox())!;
          let previousRight: number | null = null;
          let actionTop: number | null = null;
          for (const name of actions) {
            const action = name === "Stop" ? notice.getByTestId("preview-location-toast-stop") : notice.getByRole("button", { name, exact: true });
            await expect(action).toBeEnabled();
            const box = (await action.boundingBox())!;
            // Four pixels outside each control remain available for its focus
            // outline; the shared footer has an eight-pixel gap from the text.
            expect(box.y - (textBox.y + textBox.height)).toBeGreaterThanOrEqual(7);
            expect(box.y + box.height + 4).toBeLessThanOrEqual(noticeBox.y + noticeBox.height);
            if (previousRight === null) expect(box.x).toBeCloseTo(textBox.x, 0);
            else expect(box.x - previousRight).toBeCloseTo(8, 0);
            if (actionTop !== null) expect(box.y).toBeCloseTo(actionTop, 0);
            previousRight = box.x + box.width;
            actionTop = box.y;
            await action.focus();
            await expect(action).toBeFocused();
            await inViewport(page, action);
          }
          const dismiss = notice.getByRole("button", { name: /^Dismiss(?:\s|$)/ });
          if (await dismiss.count()) {
            const box = (await dismiss.boundingBox())!;
            const glyph = (await dismiss.locator("svg").boundingBox())!;
            const lineHeight = await text.evaluate(element => Number.parseFloat(getComputedStyle(element).lineHeight));
            expect(glyph.y + glyph.height / 2).toBeCloseTo(textBox.y + lineHeight / 2, 0);
            expect(box.y).toBeGreaterThanOrEqual(noticeBox.y - 1);
            expect(box.y + box.height).toBeLessThanOrEqual(noticeBox.y + noticeBox.height + 1);
            expect(box.x).toBeGreaterThanOrEqual(textBox.x + textBox.width);
            if (width < 640) expect(Math.min(box.width, box.height)).toBeGreaterThanOrEqual(44);
            await dismiss.focus();
            await expect(dismiss).toBeFocused();
            const clip = await dismiss.evaluate(element => {
              for (let parent = element.parentElement; parent; parent = parent.parentElement) {
                if (/(auto|scroll|hidden|clip)/.test(getComputedStyle(parent).overflowY)) {
                  const rect = parent.getBoundingClientRect();
                  return { top: rect.top, right: rect.right, bottom: rect.bottom, left: rect.left };
                }
              }
              return { top: 0, right: innerWidth, bottom: innerHeight, left: 0 };
            });
            // The hit target stays intact and its four-pixel focus outline fits
            // inside the lane's scrollport after the glyph is lifted.
            const focused = (await dismiss.boundingBox())!;
            expect(focused.y - 4).toBeGreaterThanOrEqual(clip.top);
            expect(focused.x + focused.width + 4).toBeLessThanOrEqual(clip.right);
            expect(focused.y + focused.height + 4).toBeLessThanOrEqual(clip.bottom);
          }
          await noOverflow(page);
          expect(errors).toEqual([]);
        }
      });
    }
  });
}

test("Copy never removes an available Undo and passive confirmations add no Tab stop", async ({ page }) => {
  const errors = await mount(page, "confirmation");
  const confirmation = page.locator('[data-testid="status-toast"][data-presentation="confirmation"]');
  await expect(confirmation).toBeVisible();
  await expect(confirmation.locator('button, [tabindex]')).toHaveCount(0);
  await page.getByTestId("review-primary").focus();
  await page.keyboard.press("Tab");
  await expect(page.getByTestId("review-secondary")).toBeFocused();
  await page.keyboard.press("Tab");
  expect(await page.evaluate(() => Boolean(document.activeElement?.closest('[data-testid="status-toast"]')))).toBe(false);
  await page.evaluate(() => { const review = (window as ReviewWindow).__review; review.undo(); review.copy(); });
  const undo = page.getByRole("button", { name: "Undo", exact: true });
  await expect(undo).toBeVisible();
  await expect(confirmation).toHaveCount(0);
  await undo.focus();
  await page.keyboard.press("Enter");
  await expect.poll(() => page.evaluate(() => (window as ReviewWindow).__review.counters.undo)).toBe(1);
  expect(errors).toEqual([]);
});

test("a workspace banner moves a persistent notification below unchanged browser chrome", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const errors = await mount(page, "toast-action", "light", "&workspace=1");
  const toast = page.getByTestId("status-toast");
  const toolbar = page.getByRole("toolbar", { name: "Browser navigation" });
  const before = (await toast.boundingBox())!.y;
  await page.evaluate(() => (window as ReviewWindow).__review.triggerWorkspaceFailure("connection"));
  await expect(page.getByTestId("workspace-availability-banner")).toBeVisible();
  await expect.poll(async () => (await toast.boundingBox())!.y).toBeGreaterThan(before);
  const bar = (await toolbar.boundingBox())!;
  expect((await toast.boundingBox())!.y).toBeGreaterThanOrEqual(bar.y + bar.height + 7);
  await page.evaluate(() => { const review = (window as ReviewWindow).__review; review.workspaceSetResult("available"); review.workspaceRetry(); });
  await expect(page.getByTestId("workspace-availability-banner")).toHaveCount(0);
  await expect.poll(async () => (await toast.boundingBox())!.y).toBeCloseTo(before, 0);
  expect(errors).toEqual([]);
});

test("preview decisions and location feedback coexist with full text and Send runs once", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 844 });
  const errors = await mount(page, "location-approval", "dark");
  const decision = page.getByTestId("site-ask-confirm");
  const location = page.getByTestId("preview-location-toast");
  await expect(decision).toContainText("before booking any tickets or sharing my personal details.");
  await expect(location).toBeVisible();
  await inViewport(page, decision);
  await inViewport(page, location);
  const [first, second] = await Promise.all([decision.boundingBox(), location.boundingBox()]);
  expect(first!.y + first!.height).toBeLessThanOrEqual(second!.y);
  // Inline elements report different clientHeight values across engines. The
  // range measures the rendered decision text, including every wrapped line.
  const decisionText = await page.getByTestId("site-ask-confirm-line").evaluate(element => {
    const range = document.createRange(); range.selectNodeContents(element);
    const rect = range.getBoundingClientRect();
    return { top: rect.top, bottom: rect.bottom, clamp: getComputedStyle(element).getPropertyValue("-webkit-line-clamp") };
  });
  expect(decisionText.top).toBeGreaterThanOrEqual(first!.y - 1);
  expect(decisionText.bottom).toBeLessThanOrEqual(first!.y + first!.height + 1);
  expect(["", "none"]).toContain(decisionText.clamp);
  const send = page.getByTestId("site-ask-confirm-send");
  await expect(send).toBeEnabled();
  await send.focus();
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Space");
  await expect.poll(() => page.evaluate(() => (window as ReviewWindow).__review.counters.send)).toBe(1);
  await noOverflow(page);
  expect(errors).toEqual([]);
});

test("location notice timers survive rerenders and pause while an action has focus", async ({ page }) => {
  await page.clock.install();
  const errors = await mount(page, "location", "light", "&text=short");
  const toast = page.getByTestId("preview-location-toast");
  await expect(toast).toBeVisible();
  await page.clock.fastForward(4_000);
  await page.evaluate(() => (window as ReviewWindow).__review.rerender());
  await page.clock.fastForward(4_100);
  await expect(toast).toHaveCount(0);
  await page.evaluate(() => (window as ReviewWindow).__review.showPreview());
  await expect(toast).toBeVisible();
  const stop = page.getByTestId("preview-location-toast-stop");
  await stop.focus();
  await page.clock.fastForward(12_000);
  await expect(stop).toBeFocused();
  await page.getByRole("textbox", { name: "Address" }).focus();
  await page.clock.fastForward(8_100);
  await expect(toast).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("a short embedded preview scrolls its feedback lane to every keyboard action", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const errors = await mount(page, "location-approval", "light", "&paneWidth=300&paneHeight=220");
  const scroll = page.getByTestId("preview-feedback-scroll");
  const pane = page.getByTestId("review-browser-pane");
  await expect(scroll).toBeVisible();
  expect(await scroll.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true);
  const bounds = (await pane.boundingBox())!;
  for (const action of [page.getByTestId("site-ask-confirm-cancel"), page.getByTestId("site-ask-confirm-send"), page.getByTestId("preview-location-toast-stop")]) {
    await expect(action).toBeEnabled();
    await action.focus();
    await expect(action).toBeFocused();
    await expect.poll(async () => {
      const rect = (await action.boundingBox())!;
      return rect.y >= bounds.y && rect.y + rect.height <= bounds.y + bounds.height;
    }).toBe(true);
  }
  await expect.poll(() => scroll.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
  await noOverflow(page);
  expect(errors).toEqual([]);
});

test("blocked location stays for its own duration and hidden previews suspend feedback", async ({ page }) => {
  await page.clock.install();
  const errors = await mount(page, "location-blocked");
  const toast = page.getByTestId("preview-location-blocked");
  await expect(toast).toBeVisible();
  await page.clock.fastForward(8_000);
  await page.evaluate(() => (window as ReviewWindow).__review.rerender());
  await page.clock.fastForward(4_100);
  await expect(toast).toHaveCount(0);
  await page.evaluate(() => { const review = (window as ReviewWindow).__review; review.showPreview(); review.setActive(false); });
  await expect(toast).toHaveCount(0);
  await page.clock.fastForward(15_000);
  await page.evaluate(() => (window as ReviewWindow).__review.setActive(true));
  await expect(toast).toBeVisible();
  expect(errors).toEqual([]);
});

test("workspace retry recovers once and returns keyboard focus to workspace content", async ({ page }) => {
  const errors = await mount(page, "workspace");
  const retry = page.getByTestId("workspace-availability-retry");
  await expect(retry).toBeVisible();
  await page.evaluate(() => (window as ReviewWindow).__review.workspaceHoldNext());
  await retry.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("workspace-availability-banner")).toContainText("Checking workspace connection");
  await page.keyboard.press("Enter");
  expect(await page.evaluate(() => (window as ReviewWindow).__review.counters.probes)).toBe(2);
  await page.evaluate(() => (window as ReviewWindow).__review.retryFinish("available"));
  await expect(page.getByTestId("workspace-availability-banner")).toHaveCount(0);
  await expect(page.getByTestId("studio-context-workspace-focus")).toBeFocused();
  expect(errors).toEqual([]);
});

test("feedback actions fit a short viewport with side insets and doubled text", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 420 });
  const errors = await mount(page, "toast-action", "dark", "&safeArea=1&textScale=2&text=short");
  const toast = page.getByTestId("status-toast");
  await expect(toast).toBeVisible();
  for (const button of await toast.getByRole("button").all()) {
    await button.focus();
    await inViewport(page, button);
  }
  const box = (await toast.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(20);
  expect(box.x + box.width).toBeLessThanOrEqual(370);
  await noOverflow(page);
  expect(errors).toEqual([]);
});

test("a short notification stays below browser chrome when the short viewport has room", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 245 });
  const errors = await mount(page, "toast-action", "light", "&workspace=1&text=short");
  await expect(page.getByTestId("workspace-availability-banner")).toHaveCount(0);
  const toast = page.getByTestId("status-toast");
  const toolbar = page.getByRole("toolbar", { name: "Browser navigation" });
  await expect.poll(async () => {
    const [notice, bar] = await Promise.all([toast.boundingBox(), toolbar.boundingBox()]);
    return notice!.y - (bar!.y + bar!.height);
  }).toBeGreaterThanOrEqual(8);
  await inViewport(page, toast);
  for (const action of await toast.getByRole("button").all()) await inViewport(page, action);
  await noOverflow(page);
  expect(errors).toEqual([]);
});

for (const viewport of ["160px visual viewport", "320×220 page viewport"] as const) {
  test(`feedback retains readable scroll space with a workspace banner in a ${viewport}`, async ({ page }) => {
    const visualHeight = viewport === "160px visual viewport" ? 160 : 220;
    await page.setViewportSize({ width: 320, height: viewport === "160px visual viewport" ? 844 : 220 });
    const errors = await mount(page, "toast-action", "light", "&workspace=1");
    await page.evaluate(() => {
      const review = (window as ReviewWindow).__review;
      review.triggerWorkspaceFailure("connection");
      review.triggerToast("toast-action", "Your changes are still here. Check your connection and retry when the workspace is available. ".repeat(12), 0);
    });
    await expect(page.getByTestId("workspace-availability-banner")).toBeVisible();
    if (viewport === "160px visual viewport") {
      // Portable visual-space simulation, not native keyboard or CDP emulation.
      await page.evaluate(() => {
        const viewport = window.visualViewport!;
        Object.defineProperties(viewport, {
          height: { configurable: true, value: 160 },
          offsetTop: { configurable: true, value: 0 },
        });
        viewport.dispatchEvent(new Event("resize"));
        window.dispatchEvent(new Event("resize"));
      });
    }
    const toast = page.getByTestId("status-toast");
    const region = page.getByRole("region").filter({ has: toast });
    await expect.poll(async () => (await region.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(80);
    const visible = (await region.boundingBox())!;
    expect(visible.y).toBeGreaterThanOrEqual(0);
    expect(visible.y + visible.height).toBeLessThanOrEqual(visualHeight);
    const content = (await toast.boundingBox())!;
    const visibleToastHeight = Math.min(content.y + content.height, visible.y + visible.height)
      - Math.max(content.y, visible.y);
    expect(visibleToastHeight).toBeGreaterThanOrEqual(80);
    expect(await region.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true);
    for (const action of [toast.getByRole("button", { name: "Dismiss notification" }), toast.getByRole("button", { name: "Retry", exact: true })]) {
      await action.focus();
      await expect(action).toBeFocused();
      await expect.poll(async () => {
        const rect = (await action.boundingBox())!;
        return rect.y >= visible.y && rect.y + rect.height <= visible.y + visible.height;
      }).toBe(true);
    }
    await expect.poll(() => region.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
    await page.keyboard.press("Enter");
    await expect.poll(() => page.evaluate(() => (window as ReviewWindow).__review.counters.retry)).toBe(1);
    await expect(toast).toHaveCount(0);
    await noOverflow(page);
    expect(errors).toEqual([]);
  });
}

test.describe("coarse feedback during native keyboard reduction", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });
  test("a displaced 70px visual viewport keeps Retry reachable without double-counting the device inset", async ({ page }) => {
    const errors = await mount(page, "toast-action", "light", "&workspace=1");
    await page.evaluate(() => {
      document.documentElement.style.setProperty("--instafy-safe-area-inset-bottom", "24px");
      const review = (window as ReviewWindow).__review;
      review.triggerWorkspaceFailure("connection");
      review.triggerToast("toast-action", "Your changes are still here. Check your connection and retry when the workspace is available. ".repeat(30), 0);
      Object.defineProperties(window.visualViewport!, {
        height: { configurable: true, value: 70.1 },
        offsetTop: { configurable: true, value: 17.52 },
      });
      window.visualViewport!.dispatchEvent(new Event("resize"));
      window.dispatchEvent(new Event("resize"));
    });
    const toast = page.getByTestId("status-toast");
    const region = page.getByRole("region").filter({ has: toast });
    await expect.poll(async () => (await region.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(52);
    const visible = (await region.boundingBox())!;
    expect(visible.y).toBeGreaterThanOrEqual(17.52);
    expect(visible.y + visible.height).toBeLessThanOrEqual(87.62);
    const retry = toast.getByRole("button", { name: "Retry", exact: true });
    expect((await retry.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await retry.focus();
    await expect(retry).toBeFocused();
    await expect.poll(async () => {
      const rect = (await retry.boundingBox())!;
      return rect.y >= visible.y && rect.y + rect.height <= visible.y + visible.height;
    }).toBe(true);

    // When the keyboard closes and the viewport reaches the device edge, the
    // bottom safe area is required again. Long content fills the bounded region.
    await page.evaluate(() => {
      Object.defineProperties(window.visualViewport!, {
        height: { configurable: true, value: window.innerHeight },
        offsetTop: { configurable: true, value: 0 },
      });
      window.visualViewport!.dispatchEvent(new Event("resize"));
      window.dispatchEvent(new Event("resize"));
    });
    await expect.poll(async () => {
      const rect = (await region.boundingBox())!;
      return rect.y + rect.height;
    }).toBeCloseTo(820, 0);
    await noOverflow(page);
    expect(errors).toEqual([]);
  });
});
