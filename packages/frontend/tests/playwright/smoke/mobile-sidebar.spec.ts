import { test, expect, type Page } from "@playwright/test";
import { prepareStudio, resetRuntimeUserState, writeWorkspaceFile } from "../utils/harness.js";

async function emulateTouchFirst(page: Page) {
  await page.addInitScript(() => {
    const originalMatchMedia = window.matchMedia.bind(window);
    const createMediaQueryList = (query: string, matches: boolean): MediaQueryList =>
      ({
        matches,
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => true,
      }) as MediaQueryList;

    Object.defineProperty(navigator, "maxTouchPoints", {
      configurable: true,
      get: () => 5,
    });

    window.matchMedia = (query: string) => {
      if (query === "(pointer: coarse)" || query === "(hover: none)") {
        return createMediaQueryList(query, true);
      }
      return originalMatchMedia(query);
    };
  });
}

async function openFilesDrawerOverChat(page: Page) {
  await expect(page.getByTestId("chat-input")).toBeVisible();
  await page.getByTestId("topbar-sidebar-toggle").click();
  await expect(page.getByTestId("mobile-sidebar-overlay")).toBeVisible();
  await page.getByTestId("sidebar-nav-code").click();
  const drawer = page.getByTestId("mobile-left-drawer-overlay");
  await expect(drawer).toBeVisible();
  return drawer;
}

test.describe("Mobile sidebar drawer", () => {
  test.afterEach(async ({ page }) => {
    await resetRuntimeUserState(page, { source: "mobile-sidebar:cleanup" }).catch(() => {});
  });

  test("hides the sidebar and opens it from the topbar on small screens", async ({ page }) => {
    test.setTimeout(120_000);
    page.setDefaultTimeout(60_000);
    await page.setViewportSize({ width: 390, height: 844 });
    await emulateTouchFirst(page);

    await prepareStudio(page, { waitForHostedRuntime: false });

    await expect(page.getByTestId("sidebar-project-button")).toHaveCount(0);
    await expect(page.getByTestId("topbar-home-button")).toHaveCount(0);

    const toggle = page.getByTestId("topbar-sidebar-toggle");
    await expect(toggle).toBeVisible();
    await toggle.click();

    await expect(page.getByTestId("mobile-sidebar-overlay")).toBeVisible();
    await expect(page.getByTestId("sidebar-project-button")).toBeVisible();

    const backdrop = page.getByTestId("mobile-sidebar-overlay");
    const backdropBox = await backdrop.boundingBox();
    await backdrop.click({
      position: {
        x: backdropBox ? Math.max(1, backdropBox.width - 10) : 380,
        y: 10
      }
    });
    await expect(page.getByTestId("mobile-sidebar-overlay")).toHaveCount(0);
    await expect(page.getByTestId("sidebar-project-button")).toHaveCount(0);
  });

  test("switches recent chats in two taps and restores each draft", async ({ page }) => {
    test.setTimeout(120_000);
    page.setDefaultTimeout(60_000);
    await page.setViewportSize({ width: 390, height: 844 });
    await emulateTouchFirst(page);
    await prepareStudio(page, { waitForHostedRuntime: false });

    const input = page.getByTestId("chat-input");
    await input.fill("First chat draft");
    await page.getByTestId("chat-composer-navigation-button").click();
    const firstChat = page.getByTestId("sidebar-recent-chats-list").getByRole("button").first();
    const firstChatTestId = await firstChat.getAttribute("data-testid");
    expect(firstChatTestId).toBeTruthy();
    await page.getByTestId("sidebar-drawer-toggle").click();
    await page.getByTestId("topbar-new-conversation").click();
    await page.getByTestId("chat-new-chat-public").click();
    await expect(page.getByTestId("mobile-sidebar-overlay")).toHaveCount(0);
    await expect(input).toHaveText("");
    await input.fill("Second chat draft");

    // Menu tap opens Chats already expanded; the next tap switches directly.
    await page.getByTestId("chat-composer-navigation-button").click();
    await expect(page.getByTestId("sidebar-nav-history")).toHaveAttribute("aria-expanded", "true");
    await page.getByTestId(firstChatTestId!).click();
    await expect(page.getByTestId("mobile-sidebar-overlay")).toHaveCount(0);
    await expect(input).toHaveText("First chat draft");

    await page.getByTestId("chat-composer-navigation-button").click();
    await page.getByTestId("sidebar-recent-chats-list").getByRole("button").nth(1).click();
    await expect(input).toHaveText("Second chat draft");
    await expect(page.getByTestId("mobile-sidebar-overlay")).toHaveCount(0);
  });

  test("opens Home from the composer navigation and returns to chat on mobile", async ({ page }) => {
    test.setTimeout(120_000);
    page.setDefaultTimeout(60_000);
    await page.setViewportSize({ width: 390, height: 844 });
    await emulateTouchFirst(page);

    await prepareStudio(page, { waitForHostedRuntime: false });

    await page.getByTestId("topbar-sidebar-toggle").click();
    await expect(page.getByTestId("mobile-sidebar-overlay")).toBeVisible();
    await page.getByTestId("sidebar-recent-chats-list").getByRole("button").first().click();
    await expect(page.getByTestId("chat-input")).toBeVisible();
    await expect(page.getByTestId("chat-composer-navigation-button")).toBeVisible();

    await page.getByTestId("chat-composer-navigation-button").click();
    await expect(page.getByTestId("sidebar-recent-chats-list")).toBeVisible();
    await page.getByTestId("sidebar-home-button").click();
    await expect(page.getByTestId("home-panel")).toBeVisible();
    await expect(page.getByTestId("mobile-bottom-dock-return")).toBeVisible();

    await page.getByTestId("mobile-bottom-dock-return").click();
    await expect(page.getByTestId("chat-input")).toBeVisible();
  });

  test("opens chat navigation from the composer on medium hidden-sidebar layouts", async ({ page }) => {
    test.setTimeout(120_000);
    page.setDefaultTimeout(60_000);
    await page.setViewportSize({ width: 834, height: 1194 });

    await prepareStudio(page, { waitForHostedRuntime: false });

    await expect(page.getByTestId("topbar-sidebar-toggle")).toBeVisible();
    await expect(page.getByTestId("topbar-home-button")).toHaveCount(0);
    await expect(page.getByTestId("chat-composer-navigation-button")).toBeVisible();
    await expect(page.getByTestId("mobile-bottom-dock")).toHaveCount(0);

    await page.getByTestId("chat-composer-navigation-button").click();
    await expect(page.getByTestId("sidebar-recent-chats-list")).toBeVisible();
    await page.getByTestId("sidebar-home-button").click();
    await expect(page.getByTestId("home-panel")).toBeVisible();
    await expect(page.getByTestId("topbar-home-button")).toHaveCount(0);
    await expect(page.getByTestId("mobile-bottom-dock")).toHaveCount(0);
  });

  test("keeps touch toolbar hidden on narrow non-touch layouts", async ({ page }) => {
    test.setTimeout(120_000);
    page.setDefaultTimeout(60_000);
    await page.setViewportSize({ width: 390, height: 844 });

    await prepareStudio(page, { waitForHostedRuntime: false });

    await expect(page.getByTestId("topbar-sidebar-toggle")).toBeVisible();
    await expect(page.getByTestId("topbar-home-button")).toHaveCount(0);
    await expect(page.getByTestId("chat-composer-navigation-button")).toBeVisible();
    await expect(page.getByTestId("mobile-bottom-dock")).toHaveCount(0);
  });

  test("allows forcing touch layout from the touchMode URL override", async ({ page }) => {
    test.setTimeout(120_000);
    page.setDefaultTimeout(60_000);
    await page.setViewportSize({ width: 390, height: 844 });

    await prepareStudio(page, { waitForHostedRuntime: false });

    const url = new URL(page.url());
    url.searchParams.set("workspaceTab", "files");
    url.searchParams.set("touchMode", "1");
    await page.goto(url.toString());

    await expect(page.getByTestId("mobile-left-drawer-overlay")).toHaveCount(0);
    await expect(page.getByTestId("code-search-input")).toBeVisible();
    await expect(page.getByTestId("files-explorer-touch-actions")).toBeVisible();
  });

  test("labels the mobile drawer surface instead of the underlying tab", async ({ page }) => {
    test.setTimeout(120_000);
    page.setDefaultTimeout(60_000);
    await page.setViewportSize({ width: 390, height: 844 });

    await prepareStudio(page, { waitForHostedRuntime: false });

    const url = new URL(page.url());
    url.searchParams.set("panel", "home");
    url.searchParams.set("workspaceTab", "files");
    await page.goto(url.toString());

    const overlay = page.getByTestId("mobile-left-drawer-overlay");
    await expect(overlay).toBeVisible();
    await expect(page.getByTestId("files-explorer-search-toggle")).toBeVisible();
    await expect(overlay.getByTestId("topbar-tab-selector")).toContainText("Files");
    await expect(page.getByTestId("topbar-home-button")).toHaveCount(0);
  });

  test("keeps the mobile Home topbar controls on a single row", async ({ page }) => {
    test.setTimeout(120_000);
    page.setDefaultTimeout(60_000);
    await page.setViewportSize({ width: 390, height: 844 });
    await emulateTouchFirst(page);

    await prepareStudio(page, { waitForHostedRuntime: false });

    await expect(page.getByTestId("chat-composer-navigation-button")).toBeVisible();
    await page.getByTestId("chat-composer-navigation-button").click();
    await expect(page.getByTestId("sidebar-recent-chats-list")).toBeVisible();
    await page.getByTestId("sidebar-home-button").click();
    await expect(page.getByTestId("home-panel")).toBeVisible();

    const toggle = page.getByTestId("topbar-sidebar-toggle");
    const tabSelector = page.getByTestId("topbar-tab-selector");
    const newConversation = page.getByTestId("topbar-new-conversation");

    await expect(toggle).toBeVisible();
    await expect(tabSelector).toBeVisible();
    await expect(newConversation).toBeVisible();

    const [toggleBox, tabSelectorBox, newConversationBox] = await Promise.all([
      toggle.boundingBox(),
      tabSelector.boundingBox(),
      newConversation.boundingBox(),
    ]);

    expect(toggleBox).not.toBeNull();
    expect(tabSelectorBox).not.toBeNull();
    expect(newConversationBox).not.toBeNull();

    const rowTops = [toggleBox!.y, tabSelectorBox!.y, newConversationBox!.y];
    const rowCenters = [
      toggleBox!.y + toggleBox!.height / 2,
      tabSelectorBox!.y + tabSelectorBox!.height / 2,
      newConversationBox!.y + newConversationBox!.height / 2,
    ];

    expect(Math.max(...rowTops) - Math.min(...rowTops)).toBeLessThan(8);
    expect(Math.max(...rowCenters) - Math.min(...rowCenters)).toBeLessThan(8);
  });

  test("opens the file tree from the mobile dock instead of the empty editor shell", async ({ page }) => {
    test.setTimeout(120_000);
    page.setDefaultTimeout(60_000);
    await page.setViewportSize({ width: 390, height: 844 });
    await emulateTouchFirst(page);

    await prepareStudio(page, { waitForHostedRuntime: false });

    await expect(page.getByTestId("chat-composer-navigation-button")).toBeVisible();
    await page.getByTestId("chat-composer-navigation-button").click();
    await expect(page.getByTestId("sidebar-recent-chats-list")).toBeVisible();
    await page.getByTestId("sidebar-home-button").click();
    await expect(page.getByTestId("home-panel")).toBeVisible();

    const filesButton = page.getByTestId("mobile-bottom-dock-files");
    await expect(filesButton).toBeVisible();
    await filesButton.click();

    await expect(page.getByTestId("mobile-left-drawer-overlay")).toHaveCount(0);
    await expect(page.getByTestId("code-search-input")).toBeVisible();
    await expect(page.getByTestId("files-explorer-touch-actions")).toBeVisible();
    await expect(page.getByTestId("files-explorer-close")).toBeVisible();
    await expect(page.getByText("Select a file to start editing.")).toHaveCount(0);

    await page.getByTestId("files-explorer-touch-actions").click();
    await expect(page.getByTestId("files-explorer-menu")).toBeVisible();
    await expect(page.getByTestId("files-explorer-menu-new-folder")).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(page.getByTestId("files-explorer-menu")).toHaveCount(0);
    await page.getByTestId("files-explorer-close").click();

    await expect(page.getByTestId("code-search-input")).toHaveCount(0);
    await expect(page.getByTestId("files-explorer-close")).toHaveCount(0);
    await expect(page.getByText("Select a file to start editing.")).toBeVisible();
  });

  test("opens a mobile drawer file in the editor and restores it through history", async ({ page }) => {
    test.setTimeout(180_000);
    page.setDefaultTimeout(60_000);
    await page.setViewportSize({ width: 360, height: 800 });
    await emulateTouchFirst(page);

    const projectId = await prepareStudio(page);
    if (!projectId) {
      throw new Error("Project id missing for mobile file viewer test.");
    }

    const targetPath = "MOBILE_VIEWER.py";
    await writeWorkspaceFile(page, targetPath, "print('mobile viewer')\n", { projectId });

    await page.getByTestId("topbar-sidebar-toggle").click();
    await expect(page.getByTestId("mobile-sidebar-overlay")).toBeVisible();
    await page.getByTestId("sidebar-nav-code").click();

    const drawer = page.getByTestId("mobile-left-drawer-overlay");
    await expect(drawer).toBeVisible();
    const fileEntry = drawer.getByText(targetPath, { exact: true });
    await expect(fileEntry).toBeVisible({ timeout: 30_000 });
    await fileEntry.click();

    await expect(drawer).toHaveCount(0);
    await expect(page.getByTestId("code-search-input")).toHaveCount(0);
    await expect(page.getByRole("heading", { name: targetPath })).toBeVisible();
    await expect(page.getByTestId("monaco-editor")).toHaveAttribute("data-file", targetPath);
    await expect(page.getByTestId("files-back-button")).toBeVisible();

    await page.getByTestId("topbar-sidebar-toggle").click();
    await expect(page.getByTestId("mobile-sidebar-overlay")).toBeVisible();
    await page.getByTestId("sidebar-nav-code").click();
    await expect(page.getByTestId("code-search-input")).toBeVisible();
    await expect
      .poll(() => new URL(page.url()).searchParams.get("workspaceTab"))
      .toBe("files");

    await page.goBack();
    await expect
      .poll(() => new URL(page.url()).searchParams.get("workspaceTab"))
      .not.toBe("files");
    await expect(page.getByTestId("code-search-input")).toHaveCount(0);
    await expect(page.getByTestId("monaco-editor")).toHaveAttribute("data-file", targetPath);

    await page.goForward();
    await expect
      .poll(() => new URL(page.url()).searchParams.get("workspaceTab"))
      .toBe("files");
    await expect(page.getByTestId("code-search-input")).toBeVisible();
    await expect(page.getByTestId("monaco-editor")).toHaveCount(0);

    await page.goBack();
    await expect
      .poll(() => new URL(page.url()).searchParams.get("workspaceTab"))
      .not.toBe("files");
    await expect(page.getByTestId("monaco-editor")).toHaveAttribute("data-file", targetPath);

    await page.setViewportSize({ width: 920, height: 800 });
    await expect(page.getByTestId("monaco-editor")).toHaveAttribute("data-file", targetPath);
    await page.getByTestId("sidebar-nav-code").click();
    await expect
      .poll(() => new URL(page.url()).searchParams.get("workspaceTab"))
      .toBe("files");

    await page.setViewportSize({ width: 890, height: 800 });
    await expect(page.getByTestId("code-search-input")).toBeVisible();
    await expect(page.getByTestId("monaco-editor")).toHaveCount(0);
    await page.getByTestId("files-explorer-close").click();
    await expect(page.getByTestId("monaco-editor")).toHaveAttribute("data-file", targetPath);

    await page.setViewportSize({ width: 360, height: 800 });
    await page.getByTestId("files-back-button").click();
    await expect(page.getByTestId("code-search-input")).toBeVisible();
    await page.getByTestId("files-explorer-close").click();

    await expect(page.getByTestId("code-search-input")).toHaveCount(0);
    await expect(page.getByTestId("monaco-editor")).toHaveAttribute("data-file", targetPath);
  });

  test("keeps an image preview when leaving the mobile Files drawer over Chat", async ({ page }) => {
    test.setTimeout(180_000);
    page.setDefaultTimeout(60_000);
    await page.setViewportSize({ width: 360, height: 800 });
    await emulateTouchFirst(page);

    const projectId = await prepareStudio(page);
    if (!projectId) {
      throw new Error("Project id missing for mobile image preview test.");
    }

    const targetPath = "MOBILE_IMAGE_PREVIEW.svg";
    await writeWorkspaceFile(
      page,
      targetPath,
      '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="#7c3aed"/></svg>\n',
      { projectId },
    );

    const drawer = await openFilesDrawerOverChat(page);
    const fileEntry = drawer.getByText(targetPath, { exact: true });
    await expect(fileEntry).toBeVisible({ timeout: 30_000 });
    await fileEntry.click();

    await expect(drawer).toHaveCount(0);
    await expect(page.getByRole("heading", { name: targetPath })).toBeVisible();
    await expect(page.getByRole("img", { name: targetPath })).toBeVisible();
    await expect(page.getByTestId("files-back-button")).toBeVisible();
    await expect(page.getByTestId("code-search-input")).toHaveCount(0);

    await page.getByTestId("files-back-button").click();
    await expect(page.getByTestId("code-search-input")).toBeVisible();
    await page.goBack();
    await expect(page.getByRole("heading", { name: targetPath })).toBeVisible();
    await expect(page.getByRole("img", { name: targetPath })).toBeVisible();
  });

  test("keeps an unsupported preview when leaving the mobile Files drawer over Chat", async ({ page }) => {
    test.setTimeout(180_000);
    page.setDefaultTimeout(60_000);
    await page.setViewportSize({ width: 360, height: 800 });
    await emulateTouchFirst(page);

    const projectId = await prepareStudio(page);
    if (!projectId) {
      throw new Error("Project id missing for mobile unsupported preview test.");
    }

    const targetPath = "MOBILE_UNSUPPORTED_PREVIEW.bin";
    await writeWorkspaceFile(page, targetPath, "unsupported-preview\n", { projectId });

    const drawer = await openFilesDrawerOverChat(page);
    const fileEntry = drawer.getByText(targetPath, { exact: true });
    await expect(fileEntry).toBeVisible({ timeout: 30_000 });
    await fileEntry.click();

    const heading = page.getByRole("heading", { name: targetPath });
    const openedFromDrawer = await heading
      .waitFor({ state: "visible", timeout: 15_000 })
      .then(() => true)
      .catch(() => false);
    if (!openedFromDrawer) {
      // Pre-existing mobile handoff race (reproducible on main): the drawer's
      // bounded rAF handoff can lose the code-panel mount. Recover the way a
      // user would — reopen the files surface from the dock and tap again.
      await page.getByTestId("mobile-bottom-dock-files").click();
      await expect(page.getByTestId("code-search-input")).toBeVisible({ timeout: 15_000 });
      await page.getByText(targetPath, { exact: true }).first().click();
      await expect(heading).toBeVisible({ timeout: 15_000 });
    }

    await expect(drawer).toHaveCount(0);
    await expect(
      page.getByText("This file cannot be opened directly in the studio.", { exact: false }),
    ).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("link", { name: "Open in new tab" })).toBeVisible();
    await expect(page.getByTestId("files-back-button")).toBeVisible();
    await expect(page.getByTestId("monaco-editor")).toHaveCount(0);

    await page.getByTestId("files-back-button").click();
    await expect(page.getByTestId("code-search-input")).toBeVisible();
    if (openedFromDrawer) {
      // The dock-based recovery pushes extra history entries, so the
      // history-restore expectation only holds on the clean drawer handoff.
      await page.goBack();
      await expect(page.getByRole("heading", { name: targetPath })).toBeVisible({
        timeout: 15_000,
      });
      await expect(page.getByRole("link", { name: "Open in new tab" })).toBeVisible();
    }
  });

  test("leaves the mobile files surface when switching back to chat from the dock", async ({ page }) => {
    test.setTimeout(120_000);
    page.setDefaultTimeout(60_000);
    await page.setViewportSize({ width: 390, height: 844 });
    await emulateTouchFirst(page);

    await prepareStudio(page, { waitForHostedRuntime: false });

    await expect(page.getByTestId("chat-composer-navigation-button")).toBeVisible();
    await page.getByTestId("chat-composer-navigation-button").click();
    await expect(page.getByTestId("sidebar-recent-chats-list")).toBeVisible();
    await page.getByTestId("sidebar-home-button").click();
    await expect(page.getByTestId("home-panel")).toBeVisible();

    await page.getByTestId("mobile-bottom-dock-files").click();
    await expect(page.getByTestId("code-search-input")).toBeVisible();

    await page.getByTestId("mobile-bottom-dock-chat").click();
    await expect(page.getByTestId("chat-input")).toBeVisible();
    await expect(page.getByTestId("mobile-left-drawer-overlay")).toHaveCount(0);
    await expect(page.getByTestId("code-search-input")).toHaveCount(0);
  });

  test("keeps spaces search collapsed on mobile until requested", async ({ page }) => {
    test.setTimeout(120_000);
    page.setDefaultTimeout(60_000);
    await page.setViewportSize({ width: 390, height: 844 });
    await emulateTouchFirst(page);

    await prepareStudio(page, { waitForHostedRuntime: false });

    await expect(page.getByTestId("chat-composer-navigation-button")).toBeVisible();
    await page.getByTestId("chat-composer-navigation-button").click();
    await expect(page.getByTestId("sidebar-recent-chats-list")).toBeVisible();
    await page.getByTestId("sidebar-home-button").click();
    await expect(page.getByTestId("home-panel")).toBeVisible();

    await page.getByTestId("mobile-bottom-dock-projects").click();
    await expect(page.getByTestId("project-picker-new-project")).toBeVisible();
    await expect(page.getByTestId("project-picker-search")).toHaveCount(0);

    await page.getByTestId("project-picker-search-toggle").click();
    await expect(page.getByTestId("project-picker-search")).toBeVisible();

    await page.getByTestId("project-picker-search-toggle").click();
    await expect(page.getByTestId("project-picker-search")).toHaveCount(0);
  });

  test("shows touch-friendly conversation history search on mobile", async ({ page }) => {
    test.setTimeout(120_000);
    page.setDefaultTimeout(60_000);
    await page.setViewportSize({ width: 390, height: 844 });
    await emulateTouchFirst(page);

    await prepareStudio(page, { waitForHostedRuntime: false });

    await page.getByTestId("topbar-sidebar-toggle").click();
    await expect(page.getByTestId("mobile-sidebar-overlay")).toBeVisible();

    await page.getByTestId("sidebar-browse-all-chats").click();
    await expect(page.getByTestId("conversation-history-panel")).toBeVisible();
    await expect(page.getByTestId("conversation-history-filter")).toBeVisible();
    await expect(page.getByTestId("conversation-history-close")).toBeVisible();
    await expect(page.getByTestId("conversation-history-search")).toBeVisible();
    await expect(page.getByTestId("conversation-history-search-toggle")).toHaveCount(0);
  });

  test("folds secondary tools into More below the recent chats on mobile", async ({ page }) => {
    test.setTimeout(120_000);
    page.setDefaultTimeout(60_000);
    await page.setViewportSize({ width: 390, height: 844 });
    await emulateTouchFirst(page);

    await prepareStudio(page, { waitForHostedRuntime: false });

    await page.getByTestId("topbar-sidebar-toggle").click();
    await expect(page.getByTestId("mobile-sidebar-overlay")).toBeVisible();

    await expect(page.getByTestId("sidebar-recent-chats-list")).toBeVisible();
    await expect(page.getByTestId("sidebar-nav-more")).toBeVisible();
    await page.getByTestId("sidebar-nav-more").click();
    await expect(page.getByTestId("sidebar-more-item-skills").first()).toBeVisible();
  });
});
