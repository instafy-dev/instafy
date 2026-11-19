import { expect, test, type Page } from "@playwright/test";

const fixture = "/tests/fixtures/browser-composer-consistency/index.html";
async function open(page: Page, surface: string, theme: string, extra = "") {
  await page.goto(`${fixture}?surface=${surface}&theme=${theme}${extra}`);
  await expect(page.getByTestId("review-app")).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
}
async function withinViewport(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  const viewport = page.viewportSize()!;
  for (const area of await page.locator('[role="dialog"], [data-testid="local-tab-toolbar"], [data-testid="project-read-only-notice"]').all()) {
    if (!await area.isVisible()) continue;
    const bounds = await area.boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(-1);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.width + 1);
  }
}
async function openTakeBack(page: Page, theme: string, state = "normal", extra = "") {
  await open(page, "takeback", theme, `&state=${state}${extra}`);
  await page.getByTestId("local-browser-share-start").click();
  await page.getByRole("button", { name: /Share tab with$/ }).click();
  await page.getByRole("option", { name: "Everyone with space access", exact: true }).click();
  await page.getByTestId("local-browser-share-confirm").click();
  await expect(page.getByRole("dialog", { name: "Take back control", exact: true })).toBeVisible();
}

for (const width of [320, 390, 768, 1280]) for (const theme of ["light", "dark"]) {
  test.describe(`${width}px ${theme}`, () => {
    test.use({ viewport: { width, height: width < 768 ? 844 : 900 }, hasTouch: width < 768 });
    test("tabs, sharing, access feedback and composer text remain usable", async ({ page }) => {
      const errors: string[] = [];
      page.on("pageerror", error => errors.push(error.message));
      await open(page, "tabs", theme);
      const research = page.getByRole("button", { name: "Accessibility research and design recommendations for narrow screens (opened by Octo)", exact: true });
      await research.click();
      await expect(page.getByTestId("review-browser-event")).toHaveText("select:research");
      await expect(research).toHaveAttribute("aria-pressed", "true");
      await page.getByRole("button", { name: "Close Accessibility research and design recommendations for narrow screens", exact: true }).click();
      await expect(page.getByTestId("personal-browser-tab")).toHaveCount(2);
      await withinViewport(page);

      await open(page, "shared", theme, "&state=control");
      await expect(page.getByTestId("local-tab-view-mode")).toHaveText("You control");
      await expect(page.getByTestId("local-tab-connection-status")).toContainText("Live tab");
      await withinViewport(page);
      const release = page.getByTestId("local-tab-control-action");
      if (!await release.isVisible()) await page.getByRole("button", { name: "Shared tab options", exact: true }).click();
      await page.getByRole("button", { name: "Release control", exact: true }).click();
      await expect(page.getByTestId("local-tab-view-mode")).toHaveText("Following");

      await open(page, "readonly", theme);
      await expect(page.getByTestId("project-read-only-notice")).toHaveAttribute("role", "status");
      await expect(page.getByTestId("chat-input")).toHaveAttribute("aria-readonly", "true");
      await withinViewport(page);

      await open(page, "mentions", theme);
      await expect(page.getByTestId("chat-input")).toContainText("@octo");
      await expect(page.getByTestId("chat-input").getByText("@researcher", { exact: true })).toBeVisible();
      await expect(page.getByTestId("chat-input").getByText("@alex", { exact: true })).toBeVisible();
      const draft = await page.getByTestId("composer-draft").textContent();
      await page.getByRole("tab", { name: "Browser", exact: true }).click();
      await page.getByRole("tab", { name: "Chat", exact: true }).click();
      await expect(page.getByTestId("composer-draft")).toHaveText(draft!);
      await withinViewport(page);

      await openTakeBack(page, theme);
      await withinViewport(page);
      await page.getByRole("button", { name: "Keep watching", exact: true }).click();
      await expect(page.getByRole("dialog", { name: "Take back control", exact: true })).toHaveCount(0);
      await expect(page.getByTestId("local-tab-take-back")).toBeVisible();
      expect(errors).toEqual([]);
    });
  });
}

test("locked tabs cannot switch or close; keyboard selects an unlocked tab", async ({ page }) => {
  await open(page, "tabs", "dark", "&locked=1");
  await expect(page.getByRole("button", { name: "Interface spacing guide (opened by Octo)", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Close Interface spacing guide", exact: true })).toBeDisabled();
  await open(page, "tabs", "dark");
  const button = page.getByRole("button", { name: "Interface spacing guide (opened by Octo)", exact: true });
  await button.focus(); await page.keyboard.press("Enter");
  await expect(button).toHaveAttribute("aria-pressed", "true");
});

test("take-back error remains readable and busy actions cannot dismiss", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 844 });
  await openTakeBack(page, "dark", "error");
  const dialog = page.getByRole("dialog", { name: "Take back control", exact: true });
  await dialog.getByRole("button", { name: "Take back", exact: true }).click();
  await expect(dialog.getByRole("alert")).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Take back", exact: true })).toBeEnabled();
  await withinViewport(page);
  await openTakeBack(page, "light", "busy");
  await dialog.getByRole("button", { name: "Take back", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Keep watching", exact: true })).toBeDisabled();
  await expect(dialog.getByRole("button", { name: "Taking back…", exact: true })).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();
});

test("pending access keeps the draft and escalates after ten seconds", async ({ page }) => {
  await page.clock.install();
  await open(page, "checking", "dark");
  const notice = page.getByTestId("project-access-checking-notice");
  await expect(notice).toBeVisible();
  const initialCopy = await notice.textContent();
  const draft = await page.getByTestId("composer-draft").textContent();
  await expect(page.getByTestId("chat-input")).toHaveAttribute("contenteditable", "false");
  await expect(page.getByTestId("chat-input")).toHaveAttribute("aria-readonly", "true");
  await page.clock.fastForward(10_100);
  await expect(notice).not.toHaveText(initialCopy!);
  await expect(notice).toHaveAttribute("role", "status");
  await expect(page.getByTestId("composer-draft")).toHaveText(draft!);
});

test("ghost text matches editor typography; large text and short landscape stay contained", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page, "ghost", "light");
  await expect(page.getByTestId("chat-input-ghost-suggestion")).toBeVisible();
  const typography = await page.locator('[data-testid="chat-input"], [data-testid="chat-input-ghost-suggestion"]').evaluateAll(nodes => nodes.map(node => {
    const s = getComputedStyle(node); return [s.fontSize, s.lineHeight, s.fontFamily];
  }));
  expect(typography).toHaveLength(2); expect(typography[0]).toEqual(typography[1]);
  await open(page, "readonly", "dark", "&text=large");
  await withinViewport(page);
  await page.setViewportSize({ width: 844, height: 390 });
  await openTakeBack(page, "light", "error", "&text=large");
  const dialog = page.getByRole("dialog", { name: "Take back control", exact: true });
  await dialog.getByRole("button", { name: "Take back", exact: true }).click();
  const bounds = await dialog.boundingBox();
  expect(bounds!.y).toBeGreaterThanOrEqual(0);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(390);
  for (const name of ["Keep watching", "Take back"]) {
    const button = dialog.getByRole("button", { name, exact: true });
    await button.scrollIntoViewIfNeeded();
    const target = await button.boundingBox();
    expect(target!.y).toBeGreaterThanOrEqual(0);
    expect(target!.y + target!.height).toBeLessThanOrEqual(390);
  }
  await withinViewport(page);
});

for (const width of [390, 768, 1280]) {
  test.describe(`inline suggestions at ${width}px`, () => {
    test.use({ viewport: { width, height: 844 }, hasTouch: width === 390 });

    test("only paints complete lines without changing draft height", async ({ page }) => {
      for (const draft of ["Please compare", "Please compare these screenshots and the spacing between the controls.\nThen review"]) {
        const query = `&draft=${encodeURIComponent(draft)}`;
        await open(page, "placeholder", "light", query);
        const editor = page.getByTestId("chat-input");
        const heightWithoutSuggestion = (await editor.boundingBox())!.height;
        await open(page, "ghost", "light", query);
        expect((await editor.boundingBox())!.height).toBeCloseTo(heightWithoutSuggestion);
        const preview = page.getByTestId("chat-input-ghost-suggestion");
        // A fractional split-pane width must not be rounded to clientWidth:
        // even a subpixel difference can change the wrapping of a long draft.
        expect((await preview.boundingBox())!.width).toBeCloseTo((await editor.boundingBox())!.width, 2);
        const geometry = await preview.evaluate(element => {
          const bounds = element.getBoundingClientRect();
          const range = document.createRange();
          range.selectNodeContents(element.lastElementChild!);
          const painted = [...range.getClientRects()].filter(rect => rect.bottom > bounds.top && rect.top < bounds.bottom);
          return {
            lines: bounds.height / parseFloat(getComputedStyle(element).lineHeight),
            visible: painted.length,
            clipped: painted.some(rect => rect.bottom > bounds.bottom + 0.5 || rect.top < bounds.top - 0.5),
          };
        });
        expect(geometry.lines).toBeCloseTo(Math.floor(geometry.lines), 2);
        expect(geometry.visible).toBeGreaterThan(0);
        expect(geometry.clipped).toBe(false);
      }
    });
  });
}

test("a new suggestion follows the last line of a scrolled draft", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const start = new Date("2025-05-01T12:00:00Z");
  await page.clock.install({ time: start });
  await page.clock.pauseAt(new Date(start.getTime() + 1000));
  const draft = "Review the sidebar spacing carefully. ".repeat(21) + "Then";
  await open(page, "ghost", "dark", `&state=delayed&draft=${encodeURIComponent(draft)}`);
  const input = page.getByTestId("chat-input");
  const preview = page.getByTestId("chat-input-ghost-suggestion");
  await expect(preview).toHaveCount(0);
  const maxScroll = await input.evaluate(element => {
    element.scrollTop = element.scrollHeight;
    return element.scrollTop;
  });
  expect(maxScroll).toBeGreaterThan(0);
  await page.clock.fastForward(3100);

  // The suggestion arrives after scrolling. Its first glyph sits beside
  // the end of the draft on the same visible line as the last typed letter.
  async function lastLineOffset() {
    return preview.evaluate(element => {
      const lastLetter = document.createRange();
      const text = document.querySelector('[data-testid="chat-input"]')!.lastElementChild!.lastElementChild!.lastChild!;
      lastLetter.setStart(text, text.textContent!.length - 1);
      lastLetter.setEnd(text, text.textContent!.length);
      const tail = lastLetter.getBoundingClientRect();
      const firstLetter = document.createRange();
      const next = element.lastElementChild!.firstChild!;
      firstLetter.setStart(next, 0);
      firstLetter.setEnd(next, 1);
      const first = firstLetter.getBoundingClientRect();
      const bounds = element.getBoundingClientRect();
      return Math.max(Math.abs(tail.top - first.top), Math.abs(tail.right - first.left), first.bottom - bounds.bottom);
    });
  }
  await expect(preview).toBeVisible();
  await expect.poll(lastLineOffset).toBeLessThan(1);
  await input.evaluate(element => { element.scrollTop = 0; });
  await page.clock.runFor(32);
  await expect(preview).toBeHidden();
  await input.evaluate(element => { element.scrollTop = element.scrollHeight; });
  await page.clock.runFor(32);
  await expect(preview).toBeVisible();
  await expect.poll(lastLineOffset).toBeLessThan(1);
});
