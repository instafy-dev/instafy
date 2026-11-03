import { expect, test, type Locator } from "@playwright/test";

const fixture = "/tests/fixtures/context-hierarchy/index.html?sidebar=actual";

async function center(locator: Locator) {
  const box = await locator.boundingBox();
  if (!box) throw new Error("Missing control geometry");
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

for (const theme of ["light", "dark"]) {
  for (const width of [900, 1024, 1280]) {
    test(`actual sidebar groups chat actions and keeps the footer toggle stable at ${width}px in ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`${fixture}&theme=${theme}`);
      const toggle = page.getByTestId("sidebar-drawer-toggle");
      const newChat = page.getByTestId("sidebar-new-chat");
      const chats = page.getByTestId("sidebar-nav-chat");
      const navigation = page.getByTestId("sidebar-context-navigation");
      const status = page.getByTestId("review-action-status");
      await expect(newChat).toBeVisible();
      await expect(navigation.getByTestId("sidebar-team-header")).toHaveCount(0);
      const toggleCenter = await center(toggle.locator("svg"));
      const chatCenter = await center(chats);
      const actionCenter = await center(newChat);
      expect(Math.abs(chatCenter.y - actionCenter.y)).toBeLessThanOrEqual(1);
      const chatBox = await chats.boundingBox();
      const actionBox = await newChat.boundingBox();
      const navBox = await navigation.boundingBox();
      if (!chatBox || !actionBox || !navBox) throw new Error("Missing sidebar controls");
      expect(chatBox.x + chatBox.width).toBeLessThanOrEqual(actionBox.x);
      expect(actionBox.x + actionBox.width).toBeLessThanOrEqual(navBox.x + navBox.width);
      expect(toggleCenter.y).toBeGreaterThan(navBox.y + navBox.height - 64);
      expect(await newChat.evaluate(element => element.parentElement?.closest("button") === null)).toBe(true);
      await chats.click();
      await expect(status).toHaveText("Navigation selected: chat.");
      await newChat.click();
      await expect(status).toHaveText("New chat selected in local preview.");
      await expect(chats).toHaveAttribute("aria-current", "page");
      // The same DOM control survives collapse so its keyboard focus is retained.
      await toggle.evaluate(element => element.setAttribute("data-focus-sentinel", "retained"));
      await toggle.click();
      await expect(toggle).toHaveAccessibleName("Expand sidebar");
      await expect(navigation).toHaveCSS("width", "64px");
      await expect(toggle).toHaveAttribute("data-focus-sentinel", "retained");
      await expect(toggle).toBeFocused();
      const collapsedCenter = await center(toggle.locator("svg"));
      expect(collapsedCenter.x).toBeCloseTo(toggleCenter.x, 0);
      expect(collapsedCenter.y).toBeCloseTo(toggleCenter.y, 0);
      await expect(newChat).toHaveAccessibleName("New chat");
      const collapsedChat = await chats.boundingBox();
      const collapsedNew = await newChat.boundingBox();
      if (!collapsedChat || !collapsedNew) throw new Error("Missing collapsed chat controls");
      expect(collapsedNew.y).toBeGreaterThanOrEqual(collapsedChat.y + collapsedChat.height);
      expect(Math.abs(collapsedNew.x + collapsedNew.width / 2 - (collapsedChat.x + collapsedChat.width / 2))).toBeLessThanOrEqual(1);
      await newChat.click();
      await toggle.click();
      await expect(toggle).toHaveAccessibleName("Collapse sidebar");
      await expect(navigation).toHaveCSS("width", `${navBox.width}px`);
      const restoredCenter = await center(toggle.locator("svg"));
      expect(restoredCenter.x).toBeCloseTo(toggleCenter.x, 0);
      expect(restoredCenter.y).toBeCloseTo(toggleCenter.y, 0);
      await chats.focus();
      await page.keyboard.press("Tab");
      await expect(newChat).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(status).toHaveText("New chat selected in local preview.");
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    });
  }

  test(`actual sidebar touch targets stay separate at 1024px in ${theme}`, async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 1024, height: 900 }, hasTouch: true, isMobile: true });
    const page = await context.newPage();
    await page.goto(`${fixture}&theme=${theme}`);
    const toggle = page.getByTestId("sidebar-drawer-toggle");
    const newChat = page.getByTestId("sidebar-new-chat");
    const chats = page.getByTestId("sidebar-nav-chat");
    await expect(newChat).toBeVisible();
    const action = await newChat.boundingBox();
    const chat = await chats.boundingBox();
    const control = await toggle.boundingBox();
    if (!action || !chat || !control) throw new Error("Missing touch geometry");
    expect(action.height).toBeGreaterThanOrEqual(44);
    expect(action.width).toBeGreaterThanOrEqual(44);
    expect(control.height).toBeGreaterThanOrEqual(44);
    expect(control.width).toBeGreaterThanOrEqual(44);
    expect(chat.x + chat.width).toBeLessThanOrEqual(action.x);
    await newChat.tap();
    await expect(page.getByTestId("review-action-status")).toHaveText("New chat selected in local preview.");
    const initial = await center(toggle.locator("svg"));
    await toggle.tap();
    await expect(toggle).toHaveAccessibleName("Expand sidebar");
    await expect(page.getByTestId("sidebar-context-navigation")).toHaveCSS("width", "64px");
    const collapsed = await center(toggle.locator("svg"));
    expect(collapsed.x).toBeCloseTo(initial.x, 0);
    expect(collapsed.y).toBeCloseTo(initial.y, 0);
    const collapsedAction = await newChat.boundingBox();
    if (!collapsedAction) throw new Error("Missing collapsed touch action");
    expect(collapsedAction.width).toBeGreaterThanOrEqual(44);
    expect(collapsedAction.height).toBeGreaterThanOrEqual(44);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await context.close();
  });

  test(`footer remains reachable while the navigation scrolls at 1024x420 in ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 420 });
    await page.goto(`${fixture}&theme=${theme}`);
    const toggle = page.getByTestId("sidebar-drawer-toggle");
    const scroll = page.getByTestId("sidebar-context-scroll");
    await expect(toggle).toBeVisible();
    const initial = await center(toggle.locator("svg"));
    expect(await scroll.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true);
    await scroll.evaluate(element => { element.scrollTop = element.scrollHeight; });
    await expect(page.getByTestId("sidebar-nav-settings")).toBeInViewport();
    expect(await center(toggle.locator("svg"))).toEqual(initial);
    await toggle.click();
    await expect(toggle).toHaveAccessibleName("Expand sidebar");
    await expect(toggle).toBeInViewport();
    const collapsed = await center(toggle.locator("svg"));
    expect(collapsed.x).toBeCloseTo(initial.x, 0);
    expect(collapsed.y).toBeCloseTo(initial.y, 0);
  });
}
