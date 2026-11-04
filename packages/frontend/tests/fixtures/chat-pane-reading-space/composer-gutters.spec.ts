import { expect, test } from "@playwright/test";

const fixtureOrigin = process.env.INSTAFY_CHAT_READING_REVIEW_ORIGIN
  ?? "http://127.0.0.1:5372";
const fixture = `${fixtureOrigin}/tests/fixtures/chat-pane-reading-space/index.html`;

test.use({ viewport: { width: 1280, height: 800 } });

test.beforeEach(async ({ page }) => {
  // Installed headless Chrome can leave its native content area shorter than
  // the emulated viewport. Native wheel input needs both to cover the gutter.
  const session = await page.context().newCDPSession(page);
  const { windowId } = await session.send("Browser.getWindowForTarget");
  await session.send("Browser.setContentsSize", { windowId, ...page.viewportSize()! });
  await session.detach();
});

for (const theme of ["light", "dark"]) {
  for (const side of ["left", "right"] as const) {
    test(`scrolling beside the composer reaches the transcript: ${side}, ${theme}`, async ({ page }) => {
      await page.goto(`${fixture}?pane=420&theme=${theme}&scrollbar=classic&state=completed`);
      const composer = page.getByTestId("chat-composer-surface");
      const transcript = page.getByTestId("chat-message-scroll");
      await expect(composer).toBeVisible();
      await expect.poll(() => transcript.evaluate(element => element.scrollHeight - element.clientHeight))
        .toBeGreaterThan(120);
      await transcript.evaluate(element => { element.scrollTop = 40; });
      const initialTop = await transcript.evaluate(element => element.scrollTop);
      const bounds = await composer.boundingBox();
      if (!bounds) throw new Error("Expected the visible composer bounds");

      // The blank reading inset belongs to the transcript beneath the overlay.
      // Exercise both sides without targeting the visible scrollbar itself.
      await page.mouse.move(side === "left" ? bounds.x - 8 : bounds.x + bounds.width + 8,
        bounds.y + bounds.height / 2);
      await page.mouse.wheel(0, 120);
      await expect.poll(() => transcript.evaluate(element => element.scrollTop), { timeout: 3_000 })
        .toBeGreaterThan(initialTop + 20);
    });
  }

  test(`the inset composer still accepts input and restores menu focus: ${theme}`, async ({ page }) => {
    await page.goto(`${fixture}?pane=420&theme=${theme}&scrollbar=classic&state=completed`);
    const input = page.getByTestId("chat-input");
    const actions = page.getByTestId("composer-action-menu-trigger");
    await input.fill("Keep this draft.");
    await actions.click();
    await expect(page.getByTestId("composer-action-menu")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("composer-action-menu")).toBeHidden();
    await expect(actions).toBeFocused();
    await expect(input).toHaveText("Keep this draft.");
    await input.click();
    await page.keyboard.press("End");
    await page.keyboard.type(" Still here.");
    await expect(input).toBeFocused();
    await expect(input).toHaveText("Keep this draft. Still here.");
    await page.getByTestId("chat-send-button").click();
    await expect(page.getByTestId("sent-messages")).toHaveText('["Keep this draft. Still here."]');
    await expect(input).toBeEmpty();
  });
}
