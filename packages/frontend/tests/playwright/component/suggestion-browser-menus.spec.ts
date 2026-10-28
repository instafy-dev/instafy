import { expect, test, type Locator, type Page } from "@playwright/test";
import { SUGGESTION_BROWSER_MENU_STUBS } from "../../fixtures/suggestion-browser-menus/dataStubs";

const fixture = "/tests/fixtures/suggestion-browser-menus/index.html";
const editor = (page: Page) => page.getByRole("textbox", { name: "Review message" });
const draft = (page: Page) => page.getByTestId("review-message-value");

async function clearEditor(page: Page) {
  // Use the editor's keyboard path, then wait for both Lexical and its controlled
  // owner to accept the edit before starting the next suggestion interaction.
  await editor(page).press("ControlOrMeta+A");
  await editor(page).press("Backspace");
  await expect(editor(page)).toHaveText("");
  await expect(draft(page)).toHaveText("");
}

async function configure(page: Page, width: number) {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  for (const [path, body] of Object.entries(SUGGESTION_BROWSER_MENU_STUBS)) {
    await page.route(`**${path}*`, route => route.fulfill({ contentType: "application/javascript", body }));
  }
  await page.setViewportSize({ width, height: 844 });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: width < 640, maxTouchPoints: 1 });
  return errors;
}

async function open(page: Page, surface: string, theme: string, extra = "") {
  await page.goto(`${fixture}?surface=${surface}&theme=${theme}${extra}`, { waitUntil: "domcontentloaded" });
  await expect(page.getByTestId("suggestion-browser-menu-review")).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
}

async function fitsViewport(page: Page, surface: Locator) {
  await expect(surface).toBeInViewport({ ratio: 1 });
  const bounds = (await surface.boundingBox())!;
  const viewport = page.viewportSize()!;
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width + 1);
  expect(bounds.y).toBeGreaterThanOrEqual(0);
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(viewport.height + 1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}

async function touchTargets(options: Locator, width: number) {
  if (width >= 640) return;
  for (const option of await options.all()) {
    const bounds = (await option.boundingBox())!;
    expect(bounds.height).toBeGreaterThanOrEqual(44);
    expect(bounds.width).toBeGreaterThanOrEqual(44);
  }
}

for (const width of [320, 390, 768, 1280]) for (const theme of ["light", "dark"]) {
  test(`composer suggestions keep keyboard selection, dismissal and touch targets in ${theme} at ${width}px`, async ({ page }) => {
    const errors = await configure(page, width);
    await open(page, "slash", theme);
    for (const suggestion of [
      { prefix: "/", menu: "chat-slash-command-menu", option: "chat-slash-command-option", token: "data-command" },
      { prefix: "@", menu: "assistant-mention-menu", option: "assistant-mention-option", token: "data-token" },
    ]) {
      await clearEditor(page);
      await editor(page).pressSequentially(suggestion.prefix);
      const menu = page.getByTestId(suggestion.menu);
      const options = menu.getByTestId(suggestion.option);
      await expect(menu).toBeVisible();
      await fitsViewport(page, menu);
      await touchTargets(options, width);
      await expect(options.first()).toHaveAttribute("data-highlighted", "true");
      const secondToken = await options.nth(1).getAttribute(suggestion.token);
      await editor(page).press("ArrowDown");
      await expect(options.nth(1)).toHaveAttribute("data-highlighted", "true");
      await expect(editor(page)).toBeFocused();
      await editor(page).press("Enter");
      await expect(menu).toHaveCount(0);
      await expect(editor(page)).toContainText(secondToken!);
      await expect(draft(page)).toContainText(secondToken!);

      await clearEditor(page);
      await editor(page).pressSequentially(suggestion.prefix);
      await expect(menu).toBeVisible();
      await editor(page).press("Escape");
      await expect(menu).toHaveCount(0);
      await expect(editor(page)).toHaveText(suggestion.prefix);
      await expect(editor(page)).toBeFocused();
    }
    await open(page, "silence", theme);
    const hint = page.getByTestId("octo-silence-hint");
    await fitsViewport(page, hint);
    const dismiss = hint.getByRole("button", { name: "Dismiss hint" });
    await touchTargets(dismiss, width);
    await dismiss.focus();
    await dismiss.press("Enter");
    await expect(hint).toHaveCount(0);
    await expect(page.getByTestId("review-hint-visible")).toHaveText("false");
    expect(errors).toEqual([]);
  });

  test(`browser location and session menus preserve selection and disabled actions in ${theme} at ${width}px`, async ({ page }) => {
    const errors = await configure(page, width);
    await open(page, "location", theme);
    const location = page.getByTestId("browser-location-menu");
    await location.click();
    const locationDialog = page.getByRole("dialog", { name: "Browser location", exact: true });
    await fitsViewport(page, locationDialog);
    const personal = page.getByTestId("browser-transport-personal");
    const workspace = page.getByTestId("browser-transport-shared");
    await expect(workspace).toHaveAttribute("aria-pressed", "true");
    await touchTargets(locationDialog.getByRole("button"), width);
    await personal.focus();
    await personal.press("Enter");
    await expect(locationDialog).toHaveCount(0);
    await expect(page.getByTestId("review-browser-mode")).toHaveText("personal");
    await location.click();
    await expect(personal).toHaveAttribute("aria-pressed", "true");
    await page.keyboard.press("Escape");
    await expect(locationDialog).toHaveCount(0);
    await expect(location).toBeFocused();

    await open(page, "location", theme, "&unavailable=1");
    await location.click();
    await expect(personal).toBeDisabled();
    await expect(workspace).toBeEnabled();

    await open(page, "sessions", theme, "&long=1");
    const toggle = page.getByTestId("shared-browser-sessions-toggle");
    await toggle.click();
    const sessions = page.getByTestId("shared-browser-session-control");
    await fitsViewport(page, sessions);
    await expect(sessions.getByRole("button", { name: "Resume Shared session review-workspace-machine", exact: true })).toContainText("Current");
    // React Aria adds screen-reader-only dismiss sentinels outside the dialog.
    await touchTargets(sessions.getByRole("dialog").getByRole("button"), width);
    const details = sessions.locator("summary");
    await touchTargets(details, width);
    await details.click();
    await expect(sessions.getByRole("textbox", { name: "Shared Browser resume link" })).toBeVisible();
    await fitsViewport(page, sessions);
    await page.keyboard.press("Escape");
    await expect(sessions).toHaveCount(0);
    await expect(toggle).toBeFocused();
    await toggle.click();
    const next = sessions.getByRole("button", { name: "Resume Shared session a1b2c3d4-review-session", exact: true });
    await next.focus();
    await next.press("Enter");
    await expect(sessions).toHaveCount(0);
    await expect(page.getByTestId("review-browser-session")).toHaveText("a1b2c3d4-review-session");
    await toggle.click();
    await expect(next).toContainText("Current");
    const clear = sessions.getByTestId("shared-browser-clear-data");
    page.once("dialog", dialog => dialog.dismiss());
    await clear.click();
    await expect(page.getByTestId("review-browser-action")).toHaveText("resume:a1b2c3d4-review-session");

    await open(page, "sessions", theme, "&busy=1&error=1");
    await toggle.click();
    await expect(sessions.getByRole("button", { name: "Start new session", exact: true })).toBeDisabled();
    await expect(sessions.getByRole("button", { name: "Refresh sessions", exact: true })).toBeDisabled();
    for (const row of await sessions.getByRole("button", { name: /^Resume Shared session / }).all()) await expect(row).toBeDisabled();
    await expect(sessions.getByRole("alert")).toHaveText("Could not refresh sessions. Your current browser is still available.");
    await fitsViewport(page, sessions);
    expect(errors).toEqual([]);
  });

  test(`tab sharing keeps audience choices and people actions usable in ${theme} at ${width}px`, async ({ page }) => {
    const errors = await configure(page, width);
    await open(page, "sharing", theme);
    await page.getByTestId("local-browser-share-start").click();
    const picker = page.getByRole("dialog", { name: "Share this tab", exact: true });
    await expect(page.getByTestId("local-browser-share-confirm")).toBeDisabled();
    const alice = picker.getByRole("checkbox", { name: /^Alice Morgan/ });
    await expect(alice).toBeVisible();
    await fitsViewport(page, picker);
    await touchTargets(picker.locator("label").filter({ has: page.getByRole("checkbox") }), width);
    await alice.check();
    await picker.getByRole("checkbox", { name: /^Bob Chen/ }).check();
    await picker.getByRole("checkbox", { name: /^Charlie with a longer display name/ }).check();
    await fitsViewport(page, picker);
    await page.getByTestId("local-browser-share-confirm").click();
    await expect(picker).toHaveCount(0);
    await page.getByTestId("local-browser-share-people").click();
    const sharing = page.getByRole("dialog", { name: "Sharing settings", exact: true });
    await expect(sharing.getByTestId("local-browser-share-person")).toHaveCount(3);
    await fitsViewport(page, sharing);
    await touchTargets(sharing.getByRole("button"), width);
    const lastRemove = sharing.getByRole("button", { name: "Remove Charlie with a longer display name", exact: true });
    await lastRemove.scrollIntoViewIfNeeded();
    await expect(lastRemove).toBeInViewport({ ratio: 1 });
    await lastRemove.click();
    await expect(sharing.getByTestId("local-browser-share-person").filter({ hasText: "Charlie with a longer display name" })).toContainText("Removed");
    await sharing.getByRole("button", { name: "Remove Alice Morgan", exact: true }).click();
    await expect(sharing.getByTestId("local-browser-share-person").filter({ hasText: "Alice Morgan" })).toContainText("Removed");
    await sharing.getByTestId("local-browser-share-stop").click();
    await expect(page.getByTestId("local-browser-share-start")).toBeVisible();
    await expect(sharing).toHaveCount(0);
    expect(errors).toEqual([]);
  });
}
