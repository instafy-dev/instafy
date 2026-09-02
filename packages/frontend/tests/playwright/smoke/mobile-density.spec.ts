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

    const topbarToggle = page.getByTestId("topbar-sidebar-toggle");
    const studioHeader = topbarToggle.locator("xpath=ancestor::header[1]");
    await expectHeightBetween(studioHeader, 52, 54);
    await expectHeightBetween(topbarToggle, 44, 44);
    await expectHeightBetween(page.getByTestId("topbar-tab-selector"), 44, 44);
    await expectHeightBetween(page.getByTestId("topbar-new-conversation"), 44, 44);

    // The idle composer is one row: border + 6px top + 44px controls + the
    // 8px safe-area floor. Image upload folds into the "+" menu below sm.
    const composer = page.getByTestId("chat-composer-overlay");
    await expectHeightBetween(composer, 56, 62);
    await expect(page.getByTestId("chat-input")).toHaveCSS("font-size", "16px");
    await expectHeightBetween(page.getByTestId("chat-home-button-mobile"), 44, 44);
    await expectHeightBetween(page.getByTestId("composer-action-menu-trigger"), 44, 44);
    await expectHeightBetween(page.getByTestId("chat-send-button"), 44, 44);
    await expect(page.getByTestId("chat-image-upload-button")).toHaveCount(0);

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
    await expectHeightBetween(studioHeader, 52, 54);
    await expectHeightBetween(composer, 56, 62);

    await page.setViewportSize({ width: 374, height: 649 });
    await expectHeightBetween(studioHeader, 52, 54);
    await expectHeightBetween(topbarToggle, 44, 44);
    await expectHeightBetween(composer, 56, 62);
    await page.setViewportSize({ width: 360, height: 649 });

    await page.getByTestId("chat-home-button-mobile").click();
    const dock = page.getByTestId("mobile-bottom-dock");
    await expect(dock).toBeVisible();
    await expectHeightBetween(dock, 60, 62);
    await expectHeightBetween(page.getByTestId("mobile-bottom-dock-return"), 48, 48);

    await page.getByTestId("mobile-bottom-dock-files").click();
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
    await expectHeightBetween(studioHeader, 52, 54);
    await expectHeightBetween(dock, 60, 62);
    await expect(filesTree).toHaveCSS("padding-top", "12px");
    await expect(filesTree).toHaveCSS("padding-right", "16px");
    await expect(searchRow).toHaveCSS("margin-top", "12px");

    await page.setViewportSize({ width: 375, height: 649 });
    await expectHeightBetween(studioHeader, 60, 62);
    await expectHeightBetween(topbarToggle, 44, 44);
    await expect(filesTree).toHaveCSS("padding-top", "20px");
    await expect(filesTree).toHaveCSS("padding-right", "20px");
    await expect(filesTree).toHaveCSS("padding-bottom", "20px");
    await expect(filesTree).toHaveCSS("padding-left", "20px");
    await expect(searchRow).toHaveCSS("margin-top", "20px");
    await expectHeightBetween(dock, 64, 66);
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
    const toggle = page.getByTestId("topbar-sidebar-toggle");
    const newConversation = page.getByTestId("topbar-new-conversation");
    const voice = page.getByTestId("chat-voice-input-button");
    const [composerBox, toggleBox, newConversationBox, voiceBox] = await Promise.all([
      composer.boundingBox(),
      toggle.boundingBox(),
      newConversation.boundingBox(),
      voice.boundingBox(),
    ]);

    expect(composerBox).not.toBeNull();
    expect(toggleBox).not.toBeNull();
    expect(newConversationBox).not.toBeNull();
    expect(voiceBox).not.toBeNull();
    expect(Math.abs(composerBox!.x - 27)).toBeLessThan(1);
    expect(Math.abs(composerBox!.x + composerBox!.width - 732)).toBeLessThan(1);
    expect(toggleBox!.x).toBeGreaterThanOrEqual(27);
    expect(newConversationBox!.x + newConversationBox!.width).toBeLessThanOrEqual(732);
    expect(voiceBox!.x + voiceBox!.width).toBeLessThanOrEqual(732);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(780);

    await page.getByTestId("runtime-selector-button").click();
    const runtimeMenu = page.getByTestId("runtime-selector-popover");
    await expect(runtimeMenu).toBeVisible();
    await expect(runtimeMenu).toHaveCSS("padding-left", "39px");
    await expect(runtimeMenu).toHaveCSS("padding-right", "60px");
    await page.keyboard.press("Escape");
    await expect(runtimeMenu).toHaveCount(0);

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
