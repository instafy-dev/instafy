import { expect, test, type Page } from "@playwright/test";
const fixture = "/tests/fixtures/chat-references/index.html";
const filePath = "src/workspace/navigation/components/ConversationHistoryPanel.tsx";
async function openPreview(page: Page) {
  const chip = page.getByTestId("chat-message-file-reference-inline");
  await chip.focus();
  await chip.press("Shift+F10");
  await page.getByRole("menuitem", { name: "Preview", exact: true }).click();
  return page.getByTestId("chat-message-file-reference-preview");
}
async function expectInsideViewport(page: Page) {
  const preview = page.getByTestId("chat-message-file-reference-preview");
  const box = await preview.boundingBox();
  expect(box).not.toBeNull();
  const viewport = page.viewportSize()!;
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width + 1);
  expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height + 1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width);
}
for (const width of [320, 390, 1280]) for (const theme of ["light", "dark"]) {
  test.describe(`${width}px ${theme}`, () => {
    test.use({ viewport: { width, height: width < 768 ? 844 : 900 }, hasTouch: width < 768, isMobile: width < 768 });
    test("quote source has a reachable target and preserves the draft", async ({ page }) => {
      await page.goto(`${fixture}?theme=${theme}`);
      const source = page.getByTestId("chat-message-quote-source-reference");
      const box = await source.boundingBox();
      expect(box!.width).toBeGreaterThanOrEqual(width < 768 ? 44 : 32);
      expect(box!.height).toBeGreaterThanOrEqual(width < 768 ? 44 : 32);
      await source.click();
      await expect(page.getByTestId("review-event")).toHaveText("Opened message: source-message in review-chat");
      await expect(page.locator("#draft")).toHaveValue("Please keep this draft while I check the source.");
    });
    test("keyboard preview fits and Escape returns to its trigger", async ({ page }) => {
      await page.goto(`${fixture}?theme=${theme}`);
      const preview = await openPreview(page);
      await expect(preview.getByText(/return <History/)).toBeVisible();
      await expect(page.getByRole("dialog")).toBeVisible();
      await expectInsideViewport(page);
      const highlighted = preview.locator('[data-preview-line-highlighted="true"]');
      await expect(highlighted).toContainText("return <History");
      await page.keyboard.press("Escape");
      await expect(preview).toBeHidden();
      await expect(page.getByTestId("chat-message-file-reference-inline")).toBeFocused();
      await expect(page.getByTestId("review-event")).toHaveText("No action yet");
    });
    test("retry recovers within the preview then opens the exact file", async ({ page }) => {
      await page.goto(`${fixture}?theme=${theme}&state=error`);
      const preview = await openPreview(page);
      await expect(preview.getByRole("button", { name: /try again|retry/i })).toBeVisible();
      await preview.getByRole("button", { name: /try again|retry/i }).click();
      await expect(preview.getByText(/return <History/)).toBeVisible();
      await preview.getByRole("button", { name: /open file/i }).click();
      await expect(preview).toBeHidden();
      await expect(page.getByTestId("review-event")).toHaveText(`Opened ${filePath}:18`);
      await expect(page.locator("#draft")).toHaveValue("Please keep this draft while I check the source.");
    });
  });
}

test.describe("touch and bounds", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  test("long press opens a persistent preview without opening the file", async ({ page, context }) => {
    await page.goto(`${fixture}?theme=dark`);
    const chip = page.getByTestId("chat-message-file-reference-inline");
    const box = await chip.boundingBox();
    const cdp = await context.newCDPSession(page);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 }] });
    await expect(page.getByRole("dialog")).toBeVisible();
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    const preview = page.getByTestId("chat-message-file-reference-preview");
    await expect(preview.getByText(/return <History/)).toBeVisible();
    await expect(page.getByTestId("review-event")).toHaveText("No action yet");
    await preview.getByRole("button", { name: /close/i }).click();
    await expect(preview).toBeHidden();
    await expect(chip).toBeFocused();
    await cdp.detach();
  });
  for (const viewport of [{ width: 320, height: 360 }, { width: 844, height: 390 }]) {
    test(`preview and recovery actions remain reachable at ${viewport.width}x${viewport.height}`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await page.goto(`${fixture}?theme=dark&state=error`);
      const preview = await openPreview(page);
      await expect(preview.getByRole("button", { name: /try again|retry/i })).toBeVisible();
      await expectInsideViewport(page);
      await preview.getByRole("button", { name: /try again|retry/i }).click();
      await expect(preview.getByText(/return <History/)).toBeVisible();
      await preview.getByRole("button", { name: /close/i }).click();
      await expect(preview).toBeHidden();
    });
  }
});
test("mouse hover remains a passive preview and clicking keeps opening the file", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${fixture}?theme=light`);
  const chip = page.getByTestId("chat-message-file-reference-inline");
  await chip.hover();
  await expect(page.getByRole("tooltip")).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await chip.click();
  await expect(page.getByTestId("review-event")).toHaveText(`Opened ${filePath}:18`);
});

test("hover preview escapes the transcript clip and dismisses on Escape", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${fixture}?theme=dark`);
  await page.getByTestId("review-message").evaluate(element => { element.style.overflow = "hidden"; element.style.transform = "translateZ(0)"; });
  const chip = page.getByTestId("chat-message-file-reference-inline");
  await chip.hover();
  const preview = page.getByRole("tooltip");
  await expect(preview).toBeVisible();
  await expect(preview.getByText(/return <History/)).toBeVisible();
  expect(await preview.evaluate(element => element.parentElement === document.body)).toBe(true);
  await page.keyboard.press("Escape");
  await expect(preview).toBeHidden();
});

test("preview stays bounded when rotating from portrait to landscape", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${fixture}?theme=light`);
  const preview = await openPreview(page);
  await expect(preview.getByText(/return <History/)).toBeVisible();
  await page.setViewportSize({ width: 844, height: 390 });
  await expectInsideViewport(page);
  await expect(preview.getByRole("button", { name: "Close file preview" })).toBeInViewport();
  await expect(preview.getByRole("button", { name: "Open file" })).toBeInViewport();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("chat-message-file-reference-inline")).toBeFocused();
});

test("inline message reference retains the exact message destination", async ({ page }) => {
  await page.goto(`${fixture}?theme=dark`);
  await page.getByTestId("chat-message-inline-reference").click();
  await expect(page.getByTestId("review-event")).toHaveText("Opened message: source-message in review-chat");
});

test("a stale space refuses source navigation and keeps the draft", async ({ page }) => {
  await page.goto(`${fixture}?theme=light&scope=stale`);
  await page.getByTestId("chat-message-quote-source-reference").click();
  const event = page.getByTestId("review-event");
  await expect(event).not.toHaveText("No action yet");
  await expect(event).not.toContainText("Opened");
  await expect(page.locator("#draft")).toHaveValue("Please keep this draft while I check the source.");
});

test("file references remain fully within the message at enlarged text size", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await page.goto(`${fixture}?theme=dark&text=large`);
  const chip = page.getByTestId("chat-message-file-reference-inline");
  const reference = await chip.boundingBox();
  const message = await page.getByTestId("review-message").boundingBox();
  expect(reference!.x).toBeGreaterThanOrEqual(message!.x);
  expect(reference!.x + reference!.width).toBeLessThanOrEqual(message!.x + message!.width + 1);
  const preview = await openPreview(page);
  await expect(preview.getByText(/return <History/)).toBeVisible();
  await expectInsideViewport(page);
  const body = await preview.getByTestId("chat-message-file-reference-preview-body").boundingBox();
  const highlighted = await preview.locator('[data-preview-line-highlighted="true"]').boundingBox();
  expect(highlighted!.y).toBeGreaterThanOrEqual(body!.y - 1);
  expect(highlighted!.y).toBeLessThan(body!.y + body!.height);
  await expect(preview.getByRole("button", { name: "Close file preview" })).toBeInViewport();
  await expect(preview.getByRole("button", { name: "Open file" })).toBeInViewport();
});
