import { expect, test, type Locator } from "@playwright/test";

import { prepareStudio, resetRuntimeUserState } from "../utils/harness.js";

test.use({
  viewport: { width: 360, height: 649 },
  hasTouch: true,
});

async function expectHeightBetween(locator: Locator, minimum: number, maximum: number) {
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.height).toBeGreaterThanOrEqual(minimum);
  expect(box!.height).toBeLessThanOrEqual(maximum);
}

test.describe("Narrow-phone Studio density", () => {
  test.afterEach(async ({ page }) => {
    await resetRuntimeUserState(page, { source: "mobile-density:cleanup" }).catch(() => {});
  });

  test("keeps 360px chrome compact without shrinking touch or text-entry targets", async ({ page }) => {
    test.setTimeout(120_000);
    page.setDefaultTimeout(60_000);

    await prepareStudio(page, { waitForHostedRuntime: false });

    await expect(page.getByTestId("chat-input")).toBeVisible();
    expect(page.viewportSize()).toEqual({ width: 360, height: 649 });

    const headerPicker = page.getByTestId("mobile-header-picker");
    const headerMore = page.getByTestId("mobile-header-more");
    const studioHeader = headerPicker.locator("xpath=ancestor::header[1]");
    await expectHeightBetween(studioHeader, 56, 58);
    await expectHeightBetween(page.locator('[data-testid="mobile-header-back"], [data-testid="mobile-header-open-chats"]'), 48, 48);
    await expectHeightBetween(headerPicker, 48, 48);
    await expectHeightBetween(headerMore, 48, 48);
    await expect(page.getByTestId("topbar-sidebar-toggle")).toHaveCount(0);
    await expect(page.getByTestId("mobile-bottom-dock")).toHaveCount(0);

    // The idle composer is one row: 1px top border + 6px top padding + the
    // 44px control row + the 8px safe-area floor = 59px. Image upload folds
    // into the "+" menu below sm. Chromium under Playwright supports web
    // speech, so the rest row ends in the hold-to-talk mic AND Send: Send is
    // always mounted, quiet (data-send-rest) while the draft is empty, and
    // lights up in place once there is a payload. Typing adds nothing to the
    // row and removes nothing from it.
    const composer = page.getByTestId("chat-composer-overlay");
    const input = page.getByTestId("chat-input");
    const voice = page.getByTestId("chat-voice-input-button");
    const send = page.getByTestId("chat-send-button");
    await expectHeightBetween(composer, 56, 62);
    await expect(input).toHaveCSS("font-size", "16px");
    await expect(page.getByTestId("chat-home-button-mobile")).toHaveCount(0);
    await expectHeightBetween(page.getByTestId("composer-action-menu-trigger"), 44, 44);
    await expectHeightBetween(voice, 44, 44);
    await expectHeightBetween(send, 44, 44);
    await expect(send).toHaveAttribute("data-send-rest", "true");
    await expect(page.getByTestId("chat-image-upload-button")).toHaveCount(0);
    const restVoiceBox = await voice.boundingBox();
    const restSendBox = await send.boundingBox();
    expect(restVoiceBox).not.toBeNull();
    expect(restSendBox).not.toBeNull();

    // With a one-line draft the composer is still the same one row: the 20px
    // line + 8px editor padding sits inside the 44px row, Send lights up in
    // its own slot and the mic keeps the slot it had.
    await input.fill("Density check");
    await expect(input.locator("p").last()).toHaveText("Density check");
    await expectHeightBetween(send, 44, 44);
    await expectHeightBetween(voice, 44, 44);
    await expectHeightBetween(composer, 56, 62);
    const draftVoiceBox = await voice.boundingBox();
    const draftSendBox = await send.boundingBox();
    expect(draftVoiceBox).not.toBeNull();
    expect(draftSendBox).not.toBeNull();
    expect(Math.abs(draftVoiceBox!.x - restVoiceBox!.x)).toBeLessThan(1);
    expect(Math.abs(draftSendBox!.x - restSendBox!.x)).toBeLessThan(1);
    await input.press("ControlOrMeta+a");
    await input.press("Backspace");
    await expect(send).toHaveAttribute("data-send-rest", "true");
    await expectHeightBetween(send, 44, 44);
    await expectHeightBetween(voice, 44, 44);
    await expectHeightBetween(composer, 56, 62);

    const baseHeaderBox = await studioHeader.boundingBox();
    const baseComposerBox = await composer.boundingBox();
    expect(baseHeaderBox).not.toBeNull();
    expect(baseComposerBox).not.toBeNull();
    await page.evaluate(() => {
      document.documentElement.style.setProperty("--safe-area-inset-top", "24px");
      document.documentElement.style.setProperty("--safe-area-inset-bottom", "18px");
    });
    await expect
      .poll(async () => (await studioHeader.boundingBox())?.height)
      .toBe(baseHeaderBox!.height + 24);
    await expect
      .poll(async () => (await composer.boundingBox())?.height ?? 0)
      .toBeGreaterThan(baseComposerBox!.height);
    await page.evaluate(() => {
      document.documentElement.style.removeProperty("--safe-area-inset-top");
      document.documentElement.style.removeProperty("--safe-area-inset-bottom");
    });
    await expectHeightBetween(studioHeader, 56, 58);
    await expectHeightBetween(composer, 56, 62);

    await page.setViewportSize({ width: 374, height: 649 });
    await expectHeightBetween(studioHeader, 56, 58);
    await expectHeightBetween(headerPicker, 48, 48);
    await expectHeightBetween(composer, 56, 62);
    await page.setViewportSize({ width: 360, height: 649 });

    await headerPicker.click();
    await page.getByTestId("mobile-navigation-sheet").getByRole("button", { name: "All chats", exact: true }).click();
    await expect(page.getByTestId("conversation-history-panel")).toBeVisible();
    const dock = page.getByTestId("mobile-bottom-dock");
    await expect(dock).toBeVisible();
    await expectHeightBetween(dock, 56, 58);
    for (const id of ["home", "chat", "projects"]) {
      await expectHeightBetween(page.getByTestId(`mobile-bottom-dock-${id}`), 48, 48);
    }
    await page.getByTestId("mobile-bottom-dock-home").click();
    await expect(page.getByTestId("home-panel")).toBeVisible();

    await page.getByTestId("mobile-header-picker").click();
    await page.getByTestId("mobile-navigation-sheet").getByRole("button", { name: "Files", exact: true }).click();
    await expect(dock).toHaveCount(0);
    const filesTree = page.getByTestId("files-explorer-tree");
    const searchRow = page.getByTestId("files-explorer-search-row");
    const searchInput = page.getByTestId("code-search-input");

    await expect(filesTree).toBeVisible();
    await expect(filesTree).toHaveCSS("padding-top", "12px");
    await expect(filesTree).toHaveCSS("padding-right", "16px");
    await expect(filesTree).toHaveCSS("padding-bottom", "12px");
    await expect(filesTree).toHaveCSS("padding-left", "16px");
    await expect(searchRow).toHaveCSS("margin-top", "12px");
    await expect(searchInput).toHaveCSS("font-size", "16px");

    const narrowSearchBox = await searchInput.boundingBox();
    expect(narrowSearchBox).not.toBeNull();
    expect(narrowSearchBox!.x).toBe(16);
    expect(narrowSearchBox!.width).toBe(328);
    // Coarse pointers intentionally enforce the 44px minimum touch target from
    // the shared Input primitive, even when the visual density is compact.
    expect(narrowSearchBox!.height).toBe(44);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);

    await page.setViewportSize({ width: 374, height: 649 });
    await expectHeightBetween(studioHeader, 56, 58);
    await expect(dock).toHaveCount(0);
    await expect(filesTree).toHaveCSS("padding-top", "12px");
    await expect(filesTree).toHaveCSS("padding-right", "16px");
    await expect(searchRow).toHaveCSS("margin-top", "12px");

    await page.setViewportSize({ width: 375, height: 649 });
    await expectHeightBetween(studioHeader, 56, 58);
    await expectHeightBetween(headerPicker, 48, 48);
    await expect(filesTree).toHaveCSS("padding-top", "20px");
    await expect(filesTree).toHaveCSS("padding-right", "20px");
    await expect(filesTree).toHaveCSS("padding-bottom", "20px");
    await expect(filesTree).toHaveCSS("padding-left", "20px");
    await expect(searchRow).toHaveCSS("margin-top", "20px");
    await expect(dock).toHaveCount(0);
  });

  test("keeps landscape controls inside native horizontal safe areas", async ({ page }) => {
    test.setTimeout(120_000);
    page.setDefaultTimeout(60_000);

    await prepareStudio(page, { waitForHostedRuntime: false });
    await page.setViewportSize({ width: 780, height: 360 });
    await page.evaluate(() => {
      document.documentElement.style.setProperty("--safe-area-inset-top", "24px");
      document.documentElement.style.setProperty("--safe-area-inset-right", "48px");
      document.documentElement.style.setProperty("--safe-area-inset-bottom", "0px");
      document.documentElement.style.setProperty("--safe-area-inset-left", "27px");
    });

    const composer = page.getByTestId("chat-composer-overlay");
    const backOrChats = page.locator('[data-testid="mobile-header-back"], [data-testid="mobile-header-open-chats"]');
    const more = page.getByTestId("mobile-header-more");
    const voice = page.getByTestId("chat-voice-input-button");
    const [composerBox, backBox, moreBox, voiceBox] = await Promise.all([
      composer.boundingBox(),
      backOrChats.boundingBox(),
      more.boundingBox(),
      voice.boundingBox(),
    ]);

    expect(composerBox).not.toBeNull();
    expect(backBox).not.toBeNull();
    expect(moreBox).not.toBeNull();
    expect(voiceBox).not.toBeNull();
    expect(Math.abs(composerBox!.x - 27)).toBeLessThan(1);
    expect(Math.abs(composerBox!.x + composerBox!.width - 732)).toBeLessThan(1);
    expect(backBox!.x).toBeGreaterThanOrEqual(27);
    expect(moreBox!.x + moreBox!.width).toBeLessThanOrEqual(732);
    expect(voiceBox!.x + voiceBox!.width).toBeLessThanOrEqual(732);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(780);

    await page.getByTestId("runtime-selector-button").click();
    const runtimeMenu = page.getByTestId("runtime-selector-popover");
    await expect(runtimeMenu).toBeVisible();
    await expect(runtimeMenu).toHaveCSS("padding-left", "39px");
    await expect(runtimeMenu).toHaveCSS("padding-right", "60px");
    await page.keyboard.press("Escape");
    await expect(runtimeMenu).toHaveCount(0);

    await more.click();
    const toggle = page.getByTestId("topbar-sidebar-toggle");
    await expectHeightBetween(toggle, 48, 48);
    await toggle.click();
    const sidebarOverlay = page.getByTestId("mobile-sidebar-overlay");
    const sidebar = sidebarOverlay.getByTestId("sidebar-project-button").locator("xpath=ancestor::nav[1]");
    const sidebarBox = await sidebar.boundingBox();
    expect(sidebarBox).not.toBeNull();
    expect(sidebarBox!.x).toBeGreaterThanOrEqual(27);
    expect(sidebarBox!.y).toBeGreaterThanOrEqual(24);
    expect(sidebarBox!.y + sidebarBox!.height).toBeLessThanOrEqual(360);

    await sidebarOverlay.getByTestId("sidebar-nav-code").click();
    const filesDrawer = page.getByTestId("mobile-left-drawer-overlay");
    const filesSearch = filesDrawer.getByTestId("code-search-input");
    await expect(filesDrawer).toHaveCSS("padding-left", "27px");
    await expect(filesDrawer).toHaveCSS("padding-right", "48px");
    const filesSearchBox = await filesSearch.boundingBox();
    expect(filesSearchBox).not.toBeNull();
    expect(filesSearchBox!.x).toBeGreaterThanOrEqual(27);
    expect(filesSearchBox!.x + filesSearchBox!.width).toBeLessThanOrEqual(732);
  });
});
