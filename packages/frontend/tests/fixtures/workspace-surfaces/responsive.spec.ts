import { expect, test, type Locator, type Page } from "@playwright/test";

// Run with this directory's playwright.config.ts and isolated Vite fixture.
// These are production UI
// components with local data adapters, not controller or native-device tests.
for (const { width, hasTouch } of [
  { width: 390, hasTouch: true },
  { width: 1280, hasTouch: false },
  { width: 2560, hasTouch: false },
]) {
  test.describe(`workspace surfaces at ${width}px`, () => {
    test.use({ hasTouch });
    for (const theme of ["Light", "Dark"]) {
      test(`${theme.toLowerCase()} navigation, menus and spacing`, async ({ page }, testInfo) => {
        const errors: string[] = [];
        page.on("pageerror", error => errors.push(error.message));
        await page.setViewportSize({ width, height: 900 });
        await page.goto("/tests/fixtures/workspace-surfaces/index.html");
        const themeGroup = page.getByRole("radiogroup", { name: "Review theme" });
        await themeGroup.getByText(theme, { exact: true }).click();
        await expect(themeGroup.getByRole("radio", { name: theme, exact: true })).toBeChecked();
        const capture = (name: string) => page.screenshot({ animations: "disabled", path: testInfo.outputPath(`${name}.png`) });
        const withinViewport = async (locator: Locator) => {
          await expect(locator).toBeVisible();
          await locator.evaluate(element => Promise.all(element.getAnimations().map(animation => animation.finished)));
          const box = (await locator.boundingBox())!;
          expect(box.x).toBeGreaterThanOrEqual(0);
          expect(box.x + box.width).toBeLessThanOrEqual(width + 1);
        };
        const pageWidth = async (id: string) => {
          const panel = page.getByTestId(id);
          await withinViewport(panel);
          expect((await panel.boundingBox())!.width).toBeLessThanOrEqual(896);
        };

        await expect(page.getByTestId("skills-item-review")).toBeVisible();
        await pageWidth("skills-panel");
        await capture("skills");
        const actions = page.getByTestId("skills-actions");
        await actions.click();
        await withinViewport(page.getByRole("menu", { name: "More skill actions", exact: true }));
        await capture("skills-menu");
        await page.getByRole("menuitem", { name: "Import custom skill", exact: true }).click();
        await expect(page.getByTestId("skills-import-source")).toBeFocused();
        await capture("skills-import");
        await page.setViewportSize({ width, height: 420 });
        const cancel = page.getByRole("button", { name: "Cancel", exact: true });
        await withinViewport(cancel);
        const cancelBox = (await cancel.boundingBox())!;
        expect(cancelBox.y + cancelBox.height).toBeLessThanOrEqual(420);
        await capture("skills-import-short");
        await cancel.click();
        await expect(actions).toBeFocused();
        await page.setViewportSize({ width, height: 900 });

        await page.getByRole("button", { name: "Machines", exact: true }).click();
        await pageWidth("machines-panel");
        await capture("machines");
        const pin = page.getByRole("button", { name: "Pin an agent to Workshop Mac", exact: true });
        await pin.click();
        const pinMenu = page.getByRole("menu", { name: "Pin an agent to Workshop Mac", exact: true });
        await withinViewport(pinMenu);
        await capture("machines-pin");
        await pinMenu.press("Escape");
        await expect(pin).toBeFocused();
        const more = page.getByRole("button", { name: "More actions for Build machine", exact: true });
        await more.click();
        await withinViewport(page.getByRole("menu", { name: "More actions for Build machine", exact: true }));
        await page.getByRole("menuitem", { name: "Remove machine…", exact: true }).click();
        await expect(cancel).toBeFocused();
        await capture("machines-confirm");
        await cancel.click();
        await expect(more).toBeFocused();

        await page.getByRole("button", { name: "Files", exact: true }).click();
        // The first visit loads the fixture's Files/Monaco module graph. The
        // router retains Machines during that transition, so wait for the page
        // to mount before checking the file tree (especially on a busy CI host).
        await expect(page.getByTestId("review-files-panel")).toBeVisible({ timeout: 15_000 });
        await expect(page.getByTestId("files-entry-docs")).toBeVisible();
        await page.getByTestId("files-entry-docs").click();
        await expect(page.getByTestId("files-entry-docs-guide-md")).toBeVisible();
        await capture("files");
        const filter = page.getByTestId("files-explorer-search-toggle");
        await filter.click();
        const search = page.getByRole("searchbox", { name: "Filter loaded files", exact: true });
        await expect(search).toBeFocused();
        await search.fill("guide");
        await expect(page.getByTestId("files-entry-docs-guide-md")).toBeVisible();
        await expect(page.getByTestId("files-entry-README-md")).toHaveCount(0);
        await capture("files-filter");
        await search.press("Escape");
        await expect(filter).toBeFocused();
        await page.getByTestId("files-entry-docs-guide-md").click();
        if (width < 900) {
          await expect(page.getByRole("button", { name: "Back to file list", exact: true })).toBeVisible();
          await capture("files-preview");
          await page.getByRole("button", { name: "Back to file list", exact: true }).click();
          await expect(page.getByTestId("files-entry-docs-guide-md")).toBeVisible();
        }
        await page.getByRole("button", { name: "Skills", exact: true }).click();
        await expect(page.getByTestId("skills-panel")).toBeVisible();
        await page.getByRole("button", { name: "Back", exact: true }).click();
        await expect(page.getByTestId("review-files-panel")).toBeVisible();
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(hasTouch);
        expect(errors).toEqual([]);
      });
    }
  });
}

const longFilePath = "docs/product-navigation-review-with-a-deliberately-long-file-name-for-small-screens.md";

async function expectToolbarFocusClearance(header: Locator) {
  const bounds = (await header.boundingBox())!;
  const coarsePointer = await header.evaluate(() => matchMedia("(pointer: coarse)").matches);
  const controls = await header.getByRole("button").evaluateAll(elements => elements
    .filter(element => element.getClientRects().length > 0)
    .map(element => {
      const rect = element.getBoundingClientRect();
      return { name: element.getAttribute("aria-label") || element.textContent, x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    }));
  for (const control of controls) {
    if (coarsePointer) {
      expect(control.width, `${control.name}: touch width`).toBeGreaterThanOrEqual(44);
      expect(control.height, `${control.name}: touch height`).toBeGreaterThanOrEqual(44);
    }
    // The shared 2px ring plus 2px offset needs room on every edge.
    expect(control.x - bounds.x, `${control.name}: left focus clearance`).toBeGreaterThanOrEqual(4);
    expect(bounds.x + bounds.width - control.x - control.width, `${control.name}: right focus clearance`).toBeGreaterThanOrEqual(4);
    expect(control.y - bounds.y, `${control.name}: top focus clearance`).toBeGreaterThanOrEqual(4);
    expect(bounds.y + bounds.height - control.y - control.height, `${control.name}: bottom focus clearance`).toBeGreaterThanOrEqual(4);
  }
  for (let index = 1; index < controls.length; index++) {
    const previous = controls[index - 1];
    const current = controls[index];
    const sameRow = Math.min(previous.y + previous.height, current.y + current.height) > Math.max(previous.y, current.y);
    const gap = sameRow ? current.x - previous.x - previous.width : current.y - previous.y - previous.height;
    expect(gap, `${previous.name} → ${current.name}: neighboring focus rings have breathing room`).toBeGreaterThanOrEqual(7.9);
  }
}

for (const { width, hasTouch } of [{ width: 390, hasTouch: true }, { width: 1440, hasTouch: false }]) {
  test.describe(`Changes surfaces at ${width}px`, () => {
    test.use({ hasTouch });
    for (const theme of ["Light", "Dark"]) {
      test(`${theme.toLowerCase()} diff switching and unavailable Files remain usable`, async ({ page }, testInfo) => {
        const errors: string[] = [];
        page.on("pageerror", error => errors.push(error.message));
        await page.setViewportSize({ width, height: 950 });
        await page.goto("/tests/fixtures/workspace-surfaces/index.html?panel=files");
        await page.getByRole("radiogroup", { name: "Review theme" }).getByText(theme, { exact: true }).click();
        await page.getByTestId("files-entry-docs").click();
        await page.getByTestId("files-entry-docs-guide-md").click();
        const fileHeader = page.getByTestId("files-viewer-header");
        const fileTitle = fileHeader.getByRole("heading", { name: "guide.md", exact: true });
        await expect(fileTitle).toBeVisible();
        const titleStyle = await fileTitle.evaluate(element => {
          const style = getComputedStyle(element);
          return { fontSize: style.fontSize, fontWeight: style.fontWeight, color: style.color };
        });
        const headerGutters = (header: Locator) => header.evaluate(element => {
          const style = getComputedStyle(element);
          return { left: style.paddingLeft, right: style.paddingRight };
        });
        expect(await headerGutters(fileHeader)).toEqual({ left: "16px", right: "16px" });
        await expectToolbarFocusClearance(fileHeader);
        await page.goto("/tests/fixtures/workspace-surfaces/index.html?panel=changes");
        await page.getByRole("radiogroup", { name: "Review theme" }).getByText(theme, { exact: true }).click();
        const rolling = page.getByTestId(hasTouch ? "source-control-rolling-diff-sheet-panel" : "source-control-rolling-diff-view");
        await expect(rolling).toBeVisible();
        const welcome = rolling.getByTestId("source-control-rolling-diff-item-src-welcome-ts-panel");
        const changedLine = welcome.getByText('const displayName = name.trim() || "there";', { exact: false });
        await expect(changedLine).toBeVisible();
        const toggle = welcome.getByRole("button", { name: "Collapse diff", exact: true });
        const header = welcome.getByRole("heading", { name: "src/welcome.ts", exact: true });
        await expect(header).toBeVisible();
        expect(await header.evaluate(element => {
          const style = getComputedStyle(element);
          return { fontSize: style.fontSize, fontWeight: style.fontWeight, color: style.color };
        })).toEqual(titleStyle);
        expect(await headerGutters(welcome.getByTestId("source-control-rolling-diff-item-src-welcome-ts-diff-toolbar"))).toEqual({ left: "16px", right: "16px" });
        const titleBounds = (await header.boundingBox())!;
        const toggleBounds = (await toggle.boundingBox())!;
        expect(Math.abs(titleBounds.y + titleBounds.height / 2 - toggleBounds.y - toggleBounds.height / 2), "file title and action share a vertical center").toBeLessThanOrEqual(2);
        if (hasTouch) {
          expect(toggleBounds.width).toBeGreaterThanOrEqual(44);
          expect(toggleBounds.height).toBeGreaterThanOrEqual(44);
        }
        await toggle.focus();
        await expect(toggle).toHaveAttribute("aria-expanded", "true");
        await toggle.press("Enter");
        await expect(changedLine).toHaveCount(0);
        const expand = welcome.getByRole("button", { name: "Expand diff", exact: true });
        await expect(expand).toBeFocused();
        await expect(expand).toHaveAttribute("aria-expanded", "false");
        await expect(header).toBeVisible();
        await expand.press("Space");
        await expect(changedLine).toBeVisible();
        await expect(toggle).toBeFocused();
        await page.screenshot({ path: testInfo.outputPath("changes-all.png"), animations: "disabled" });

        if (hasTouch) await page.getByTestId("source-control-rolling-diff-close").click();
        else await page.getByTestId("source-control-review-mode-focused").click();
        const focused = page.getByTestId(hasTouch ? "source-control-diff-sheet-panel" : "source-control-diff-view");
        await expect(focused).toBeVisible();
        await expect(focused).toContainText('const displayName = name.trim() || "there";');
        const previousFile = focused.getByRole("button", { name: "Previous changed file", exact: true });
        const nextFile = focused.getByRole("button", { name: "Next changed file", exact: true });
        if (hasTouch) {
          for (const action of [previousFile, nextFile]) {
            const bounds = (await action.boundingBox())!;
            expect(bounds.width).toBeGreaterThanOrEqual(44);
            expect(bounds.height).toBeGreaterThanOrEqual(44);
          }
        }
        await expect(previousFile).toBeDisabled();
        await expect(nextFile).toBeEnabled();
        await nextFile.click();
        await expect(focused.getByRole("heading", { name: "README.md", exact: true })).toBeVisible();
        await expect(nextFile).toBeDisabled();
        await expect(previousFile).toBeEnabled();
        await previousFile.click();
        await expect(previousFile).toBeDisabled();
        const selectedTitle = focused.getByRole("heading", { name: "src/welcome.ts", exact: true });
        await expect(selectedTitle).toBeVisible();
        expect(await selectedTitle.evaluate(element => {
          const style = getComputedStyle(element);
          return { fontSize: style.fontSize, fontWeight: style.fontWeight, color: style.color };
        })).toEqual(titleStyle);
        const selectedToolbar = focused.getByTestId("source-control-diff-toolbar");
        expect(await headerGutters(selectedToolbar)).toEqual({ left: "16px", right: "16px" });
        const expectReadableSelectedHeader = async () => {
          await expectToolbarFocusClearance(selectedToolbar);
          expect((await selectedTitle.boundingBox())!.width, "selected filename remains readable beside the actions (1px rounding tolerance)").toBeGreaterThanOrEqual(99);
          expect((await selectedToolbar.getByText("Working tree", { exact: true }).boundingBox())!.height, "subtitle does not wrap into a vertical stack").toBeLessThanOrEqual(32);
          expect((await selectedToolbar.boundingBox())!.height, "crowded actions wrap without making the toolbar excessively tall").toBeLessThan(140);
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        };
        await expectReadableSelectedHeader();
        if (hasTouch) {
          await page.setViewportSize({ width: 320, height: 950 });
          await expectReadableSelectedHeader();
          await page.setViewportSize({ width, height: 950 });
        }
        const refresh = focused.getByRole("button", { name: "Refresh diff", exact: true });
        const refreshBounds = (await refresh.boundingBox())!;
        expect(refreshBounds.x).toBeGreaterThanOrEqual(0);
        expect(refreshBounds.x + refreshBounds.width).toBeLessThanOrEqual(width);
        if (hasTouch) {
          expect(refreshBounds.width).toBeGreaterThanOrEqual(44);
          expect(refreshBounds.height).toBeGreaterThanOrEqual(44);
        }
        await page.screenshot({ path: testInfo.outputPath("changes-focused.png"), animations: "disabled" });
        if (hasTouch) await page.getByTestId("source-control-diff-close").click();
        await page.getByTestId("source-control-review-mode-all").click();
        await expect(rolling).toBeVisible();
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        if (hasTouch) {
          await page.getByTestId("source-control-rolling-diff-close").click();
          await page.getByRole("button", { name: "README.md", exact: true }).click();
        } else {
          await page.getByTestId("source-control-review-mode-focused").click();
          await nextFile.click();
        }
        await expect(focused).toBeVisible();
        const openFile = focused.getByRole("button", { name: "Open file", exact: true });
        await expect(openFile).toHaveText("Open");
        await openFile.click();
        await expect(page.getByTestId("review-files-panel")).toBeVisible();
        await expect(page.getByTestId("files-viewer-header").getByRole("heading", { name: "README.md", exact: true })).toBeVisible();

        for (const [scenario, message, action] of [
          ["unavailable", "Connect the runtime controller to browse space files.", "Back to Assistant"],
          ["no-space", "Select or create a space to view its files.", "Browse spaces"],
        ]) {
          await page.goto(`/tests/fixtures/workspace-surfaces/index.html?panel=files&filesScenario=${scenario}`);
          await expect(page.getByText(message, { exact: true })).toBeVisible();
          const button = page.getByRole("button", { name: action, exact: true });
          await expect(button).toBeEnabled();
          const bounds = (await button.boundingBox())!;
          expect(bounds.x).toBeGreaterThanOrEqual(0);
          expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
          await page.screenshot({ path: testInfo.outputPath(`files-${scenario}.png`), animations: "disabled" });
        }
        expect(errors).toEqual([]);
      });
    }
  });
}

const fileEntry = (page: Page, path: string) => page.getByTestId(`files-entry-${path.replace(/[^a-zA-Z0-9]/g, "-")}`);

async function openDocs(page: Page, hasTouch: boolean) {
  const row = fileEntry(page, "docs");
  await expect(row).toBeVisible();
  if (hasTouch) {
    await expect(page.getByTestId("files-focus-docs")).toHaveCount(0);
    await row.tap();
  } else {
    await row.click();
    await expect(fileEntry(page, "docs/guide.md")).toBeVisible();
    await page.getByTestId("files-focus-docs").click();
  }
  await expect(page.getByRole("navigation", { name: "File location" }).getByText("docs", { exact: true })).toBeVisible();
  await expect(fileEntry(page, "README.md")).toHaveCount(0);
}

async function replaceEditorText(page: Page, text: string) {
  // The locally bundled Monaco uses Chromium's native EditContext rather than
  // the textarea used by the older editor in the authenticated test helper.
  const editor = page.getByTestId("monaco-editor").getByRole("textbox", { name: "Editor content", exact: true });
  await page.getByTestId("monaco-editor").locator(".view-line").first().click({ position: { x: 10, y: 10 } });
  await expect(editor).toBeFocused();
  const modifier = await page.evaluate(() => navigator.userAgent.includes("Macintosh") ? "Meta" : "Control");
  await page.keyboard.press(`${modifier}+A`);
  await page.keyboard.press("Backspace");
  await page.keyboard.type(text, { delay: 5 });
}

async function showMarkdownPreview(page: Page) {
  const mode = page.getByTestId("files-viewer-mode");
  await expect(mode).toBeVisible();
  if (await mode.getAttribute("aria-label") === "Preview markdown") await mode.click();
  await expect(mode).toHaveAccessibleName(/^(Edit|View source)$/);
}

async function showFileEditor(page: Page) {
  const mode = page.getByTestId("files-viewer-mode");
  await expect(mode).toBeVisible();
  if (await mode.getAttribute("aria-label") !== "Preview markdown") await mode.click();
  await expect(mode).toHaveAccessibleName("Preview markdown");
  await expect(page.getByTestId("monaco-editor")).toBeVisible();
}

async function expectFileControlsInViewport(page: Page, width: number) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  for (const id of ["files-back-button", "files-viewer-mode", "files-viewer-more", "code-save-button"]) {
    const control = page.getByTestId(id);
    if (await control.count()) {
      await expect(control).toBeVisible();
      const box = (await control.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(width);
    }
  }
}

for (const width of [320, 390, 1440]) {
  test.describe(`Files toolbar states at ${width}px`, () => {
    test.use({ viewport: { width, height: 950 }, hasTouch: width < 540 });
    for (const theme of ["light", "dark"]) {
      test(`${theme} quiet controls and save emphasis follow the file state`, async ({ page }, testInfo) => {
        await page.addInitScript(value => localStorage.setItem("instafy.themeMode", value), theme);
        await page.goto("/tests/fixtures/workspace-surfaces/index.html?panel=files&filesSave=manual");
        await openDocs(page, width < 540);
        await fileEntry(page, "docs/guide.md").click();
        await showMarkdownPreview(page);
        const header = page.getByTestId("files-viewer-header");
        const mode = page.getByTestId("files-viewer-mode");
        const save = page.getByTestId("code-save-button");
        await page.mouse.move(1, 1);
        await expect(mode).toHaveCSS("border-radius", "8px");
        await expect(save).toHaveCSS("border-radius", "8px");
        await expect(mode).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
        await expect(save).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
        // This fixture deliberately starts with unavailable Git status, not a
        // known-clean version; quiet styling must not disable the fallback save.
        await expect(save).toBeEnabled();
        expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(width < 540);
        await expectToolbarFocusClearance(header);
        const cleanHeight = (await header.boundingBox())!.height;
        await mode.focus();
        await mode.press("Enter");
        await expect(page.getByTestId("monaco-editor")).toBeVisible();
        for (const action of await header.getByRole("button").all()) await expect(action).toHaveCSS("border-radius", "8px");
        await replaceEditorText(page, "# Toolbar review\n\nThe save control follows local changes.\n");
        await expect(page.getByTestId("files-save-status")).toHaveText("Unsaved changes");
        expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(width < 540);
        await expect(save).toBeEnabled();
        await page.mouse.move(1, 1);
        await expect(save).not.toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
        await save.evaluate(element => Promise.all(element.getAnimations().map(animation => animation.finished)));
        const changedFill = await save.evaluate(element => getComputedStyle(element).backgroundColor);
        await save.focus();
        await save.press("Enter");
        await expect(save).toHaveAttribute("aria-busy", "true");
        await expect(save).toBeDisabled();
        await expect(save).toBeFocused();
        await expect(save).toHaveCSS("background-color", changedFill);
        await expect(page.getByTestId("files-save-status")).toHaveText("Saving…");
        expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(width < 540);
        await expectToolbarFocusClearance(header);
        await page.screenshot({ path: testInfo.outputPath("files-saving.png"), animations: "disabled" });
        await page.evaluate(() => window.dispatchEvent(new Event("review:finish-save")));
        await expect(page.getByTestId("files-save-status")).toHaveText("Saved");
        await expect(save).not.toHaveAttribute("aria-busy", "true");
        await expect(save).toHaveAttribute("aria-disabled", "true");
        expect(await save.evaluate(element => (element as HTMLButtonElement).disabled), "clean save remains focusable after completion").toBe(false);
        await expect(save).toBeFocused();
        await expect(save).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
        expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(width < 540);
        expect((await header.boundingBox())!.height).toBe(cleanHeight);
        await expectToolbarFocusClearance(header);
        if (width < 540) {
          const more = page.getByTestId("files-viewer-more");
          const back = page.getByTestId("files-back-button");
          for (const action of [more, back]) await expect(action).toHaveCSS("border-radius", "8px");
          await more.focus();
          await more.press("Enter");
          const menu = page.getByRole("menu", { name: "File editing actions", exact: true });
          await expect(menu).toBeVisible();
          await menu.press("Escape");
          await expect(more).toBeFocused();
          await back.focus();
          await back.press("Enter");
          await expect(fileEntry(page, "docs/guide.md")).toBeVisible();
        }
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      });
    }
  });
}

for (const width of [320, 390, 1440]) {
  test.describe(`Files footer at ${width}px`, () => {
    test.use({ hasTouch: width < 540 });
    for (const theme of ["Light", "Dark"]) {
      test(`${theme.toLowerCase()} metadata stays compact and details dismiss safely`, async ({ page }, testInfo) => {
        const errors: string[] = [];
        page.on("pageerror", error => errors.push(error.message));
        await page.setViewportSize({ width, height: 900 });
        await page.goto("/tests/fixtures/workspace-surfaces/index.html?panel=files");
        await page.getByRole("radiogroup", { name: "Review theme" }).getByText(theme, { exact: true }).click();
        await openDocs(page, width < 540);
        await fileEntry(page, "docs/guide.md").click();
        await showMarkdownPreview(page);
        const footer = page.getByTestId("files-viewer-footer");
        const details = footer.getByRole("button", { name: "File details", exact: true });
        await expect(footer.getByTestId("files-save-status")).toHaveText("Saved");
        await expect(footer.getByText("text/markdown", { exact: true })).toHaveCount(0);
        const size = footer.getByTestId("files-viewer-size");
        await expect(size).toBeVisible();
        const footerBounds = (await footer.boundingBox())!;
        expect(footerBounds.height).toBeLessThanOrEqual(width < 540 ? 54 : 42);
        if (width < 540) {
          const bounds = (await details.boundingBox())!;
          expect(bounds.width).toBeGreaterThanOrEqual(44);
          expect(bounds.height).toBeGreaterThanOrEqual(44);
        }
        await details.focus();
        await details.press("Enter");
        const dialog = page.getByRole("dialog", { name: "File details", exact: true });
        await expect(dialog).toBeVisible();
        await expect(dialog.getByText("Size", { exact: true })).toBeVisible();
        await expect(dialog.getByText("Modified", { exact: true })).toBeVisible();
        await expect(dialog.getByText("MIME", { exact: true })).toBeVisible();
        await expect(dialog.getByText("text/markdown", { exact: true })).toBeVisible();
        const dialogBounds = (await dialog.boundingBox())!;
        expect(dialogBounds.x).toBeGreaterThanOrEqual(0);
        expect(dialogBounds.x + dialogBounds.width).toBeLessThanOrEqual(width);
        expect(dialogBounds.y).toBeGreaterThanOrEqual(0);
        expect(dialogBounds.y + dialogBounds.height).toBeLessThanOrEqual(900);
        const close = dialog.getByRole("button", { name: "Close file details", exact: true });
        if (width < 540) {
          const bounds = (await close.boundingBox())!;
          expect(bounds.width).toBeGreaterThanOrEqual(44);
          expect(bounds.height).toBeGreaterThanOrEqual(44);
        }
        await page.screenshot({ path: testInfo.outputPath("file-details.png"), animations: "disabled" });
        await dialog.press("Escape");
        await expect(dialog).toHaveCount(0);
        await expect(details).toBeFocused();
        await details.press("Enter");
        await close.click();
        await expect(dialog).toHaveCount(0);
        await expect(details).toBeFocused();
        await details.press("Enter");
        // A workspace navigation event may switch files while the popover is open.
        await page.evaluate(() => window.dispatchEvent(new CustomEvent("instafy:open-workspace-file", {
          detail: { projectId: "review-space", path: "docs/release-checklist.md", preferPreview: true },
        })));
        await expect(page.getByRole("heading", { name: "release-checklist.md", exact: true })).toBeVisible();
        await expect(dialog).toHaveCount(0);
        await expect(details).toBeVisible();
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        expect(errors).toEqual([]);
      });
    }
  });
}

for (const { width, hasTouch } of [{ width: 390, hasTouch: true }, { width: 1280, hasTouch: false }]) {
  test.describe(`Files editing at ${width}px`, () => {
    test.use({ hasTouch });
    test("saves locally and preserves a draft plus folder position through back and reopen", async ({ page }, testInfo) => {
      const errors: string[] = [];
      page.on("pageerror", error => errors.push(error.message));
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/tests/fixtures/workspace-surfaces/index.html?panel=files");
      await openDocs(page, hasTouch);
      await fileEntry(page, "docs/guide.md").click();
      const mode = page.getByTestId("files-viewer-mode");
      await showMarkdownPreview(page);
      await expect(mode).toHaveAccessibleName("Edit");
      await expect(page.getByRole("button", { name: "Undo", exact: true })).toHaveCount(0);
      await mode.click();
      await expect(mode).toHaveAccessibleName("Preview markdown");
      await expectToolbarFocusClearance(page.getByTestId("files-viewer-header"));
      if (!hasTouch) {
        const undo = page.getByRole("button", { name: "Undo", exact: true });
        const redo = page.getByRole("button", { name: "Redo", exact: true });
        await expect(undo).toBeVisible();
        await expect(redo).toBeVisible();
        expect((await redo.boundingBox())!.x - (await undo.boundingBox())!.x - (await undo.boundingBox())!.width).toBeCloseTo(8);
      }
      await replaceEditorText(page, "# Reviewed guide\n\nSaved local review draft.\n");
      await expect(page.getByTestId("files-save-status")).toHaveText("Unsaved changes");
      const save = page.getByTestId("code-save-button");
      await expect(save).toBeEnabled();
      await save.click();
      await expect(page.getByTestId("review-status")).toHaveText("Version saved");
      await expect(page.getByTestId("files-save-status")).toHaveText("Saved");
      await expect(save).toBeDisabled();
      await page.screenshot({ path: testInfo.outputPath("files-editor.png"), animations: "disabled" });
      await mode.click();
      await expect(page.getByRole("heading", { name: "Reviewed guide", exact: true })).toBeVisible();
      await expectFileControlsInViewport(page, width);
      await page.screenshot({ path: testInfo.outputPath("files-saved-preview.png"), animations: "disabled" });

      await mode.click();
      await replaceEditorText(page, "# Reviewed guide\n\nUnsaved follow-up stays here.\n");
      if (hasTouch) {
        await page.getByTestId("files-back-button").click();
        await expect(page.getByRole("navigation", { name: "File location" }).getByText("docs", { exact: true })).toBeVisible();
        await expect(fileEntry(page, "README.md")).toHaveCount(0);
      } else {
        // Desktop keeps the tree beside the editor: switch files and return.
        await fileEntry(page, "docs/release-checklist.md").click();
      }
      await fileEntry(page, "docs/guide.md").click();
      await showFileEditor(page);
      await expect(page.getByTestId("monaco-editor")).toContainText("Unsaved follow-up stays here.");
      if (hasTouch) {
        await page.getByTestId("files-viewer-more").click();
        const editing = page.getByRole("menu", { name: "File editing actions", exact: true });
        await expect(editing.getByRole("menuitem", { name: "Undo", exact: true })).toBeVisible();
        await expect(editing.getByRole("menuitem", { name: "Redo", exact: true })).toBeVisible();
        await editing.getByRole("menuitem", { name: /^Save draft/ }).click();
      } else await page.getByTestId("code-save-draft-button").click();
      await expect(page.getByTestId("review-status")).toHaveText("Draft saved to workspace");
      await expect(page.getByTestId("files-save-status")).toHaveText("Draft saved · version pending");
      if (hasTouch) {
        await page.setViewportSize({ width: 320, height: 900 });
        const footer = page.getByTestId("files-viewer-footer");
        const status = footer.getByTestId("files-save-status");
        await expect(status).toHaveText("Draft saved · version pending");
        expect((await footer.boundingBox())!.height).toBeLessThanOrEqual(54);
        expect(await status.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
        await expect(footer.getByTestId("files-viewer-size")).toBeVisible();
        await expectFileControlsInViewport(page, 320);
        await page.screenshot({ path: testInfo.outputPath("files-long-save-status-320.png"), animations: "disabled" });
        await page.setViewportSize({ width, height: 900 });
      }
      await mode.click();
      await expect(page.getByText("Unsaved follow-up stays here.", { exact: true })).toBeVisible();
      await expectFileControlsInViewport(page, width);
      await page.getByRole("radiogroup", { name: "Review theme" }).getByText("Dark", { exact: true }).click();
      await page.screenshot({ path: testInfo.outputPath("files-saved-preview-dark.png"), animations: "disabled" });
      await mode.click();
      await page.screenshot({ path: testInfo.outputPath("files-editor-dark.png"), animations: "disabled" });
      expect(errors).toEqual([]);
    });

    test("keeps read-only, failed reads and failed saves honest without losing text", async ({ page }, testInfo) => {
      test.setTimeout(60_000);
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/tests/fixtures/workspace-surfaces/index.html?panel=files&filesScenario=read-only");
      await openDocs(page, hasTouch);
      await fileEntry(page, "docs/guide.md").click();
      await expect(page.getByTestId("files-viewer-read-only-badge")).toBeVisible();
      await showMarkdownPreview(page);
      await expect(page.getByTestId("files-viewer-mode")).toHaveAccessibleName("View source");
      await expect(page.getByTestId("code-save-button")).toHaveCount(0);
      await expect(page.getByTestId("files-viewer-more")).toHaveCount(0);
      await page.getByTestId("files-viewer-mode").click();
      await expect(page.getByTestId("monaco-editor")).toBeVisible();
      const readOnlyEditor = page.getByTestId("monaco-editor").getByRole("textbox", { name: "Editor content", exact: true });
      await page.getByTestId("monaco-editor").locator(".view-line").first().click({ position: { x: 10, y: 10 } });
      await expect(readOnlyEditor).toBeFocused();
      await page.keyboard.type("unwanted edit");
      await page.getByTestId("files-viewer-mode").click();
      await expect(page.getByText("unwanted edit", { exact: false })).toHaveCount(0);
      await expectFileControlsInViewport(page, width);
      await page.screenshot({ path: testInfo.outputPath("files-read-only.png"), animations: "disabled" });

      await page.goto("/tests/fixtures/workspace-surfaces/index.html?panel=files&filesScenario=read-error");
      await openDocs(page, hasTouch);
      await fileEntry(page, "docs/guide.md").click();
      await expect(page.getByRole("alert")).toContainText("Unable to load file content.");
      await page.getByRole("button", { name: "Retry", exact: true }).click();
      await expect(page.getByRole("alert")).toContainText("Unable to load file content.");
      await expect(page.getByTestId("code-save-button")).toHaveCount(0);
      await expectFileControlsInViewport(page, width);
      await page.screenshot({ path: testInfo.outputPath("files-read-error.png"), animations: "disabled" });
      if (hasTouch) await page.getByTestId("files-back-button").click();
      await expect(page.getByRole("navigation", { name: "File location" }).getByText("docs", { exact: true })).toBeVisible();

      await page.goto("/tests/fixtures/workspace-surfaces/index.html?panel=files&filesScenario=write-error");
      await openDocs(page, hasTouch);
      await fileEntry(page, "docs/guide.md").click();
      await showFileEditor(page);
      await replaceEditorText(page, "# Failed save\n\nThis unsaved text must survive.\n");
      await page.getByTestId("code-save-button").click();
      await expect(page.getByTestId("review-status")).toHaveText("Review scenario: the file could not be saved. Your edits are kept.");
      await expect(page.getByTestId("code-save-button")).toBeEnabled();
      await expect(page.getByTestId("monaco-editor")).toContainText("This unsaved text must survive.");
      if (hasTouch) await page.getByTestId("files-back-button").click();
      else await fileEntry(page, "docs/release-checklist.md").click();
      await fileEntry(page, "docs/guide.md").click();
      await showFileEditor(page);
      await expect(page.getByTestId("monaco-editor")).toContainText("This unsaved text must survive.");
      await expectFileControlsInViewport(page, width);
      await page.screenshot({ path: testInfo.outputPath("files-write-error.png"), animations: "disabled" });
    });
  });
}

test.describe("Files at 320px", () => {
  test.use({ hasTouch: true });
  test("keeps long filenames and edit controls inside the narrow viewport", async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 320, height: 760 });
    await page.goto("/tests/fixtures/workspace-surfaces/index.html?panel=files");
    await openDocs(page, true);
    await fileEntry(page, longFilePath).tap();
    await showMarkdownPreview(page);
    await expectFileControlsInViewport(page, 320);
    await expectToolbarFocusClearance(page.getByTestId("files-viewer-header"));
    const title = page.getByRole("heading", { name: longFilePath.split("/").at(-1), exact: true });
    expect((await title.boundingBox())!.width).toBeGreaterThan(32);
    for (const id of ["files-back-button", "files-viewer-mode"]) {
      const bounds = (await page.getByTestId(id).boundingBox())!;
      expect(bounds.width).toBeGreaterThanOrEqual(44);
      expect(bounds.height).toBeGreaterThanOrEqual(44);
    }
    await page.screenshot({ path: testInfo.outputPath("files-long-name-preview.png"), animations: "disabled" });
    await page.getByTestId("files-viewer-mode").tap();
    await expect(page.getByTestId("monaco-editor")).toBeVisible();
    await expectFileControlsInViewport(page, 320);
    await expectToolbarFocusClearance(page.getByTestId("files-viewer-header"));
    await page.screenshot({ path: testInfo.outputPath("files-long-name-edit.png"), animations: "disabled" });
    await page.getByTestId("files-back-button").tap();
    await expect(fileEntry(page, longFilePath)).toBeVisible();
  });
});

test.describe("Files mobile list restoration", () => {
  test.use({ hasTouch: true });
  test("returns to the scrolled folder after editing a file near the end", async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 390, height: 760 });
    await page.goto("/tests/fixtures/workspace-surfaces/index.html?panel=files&filesList=long");
    await openDocs(page, true);
    const target = fileEntry(page, "docs/note-28.md");
    await target.scrollIntoViewIfNeeded();
    const scroll = page.getByTestId("files-explorer-scroll");
    const before = await scroll.evaluate(element => element.scrollTop);
    expect(before).toBeGreaterThan(100);
    await target.tap();
    await showFileEditor(page);
    await replaceEditorText(page, "# Note 28\n\nDraft survives the trip back.\n");
    await page.getByTestId("files-back-button").tap();
    await expect(target).toBeVisible();
    expect(Math.abs(await scroll.evaluate(element => element.scrollTop) - before)).toBeLessThanOrEqual(2);
    await page.screenshot({ path: testInfo.outputPath("files-scroll-restored.png"), animations: "disabled" });
    await target.tap();
    await showFileEditor(page);
    await expect(page.getByTestId("monaco-editor")).toContainText("Draft survives the trip back.");
  });
});

for (const { width, hasTouch } of [
  { width: 390, hasTouch: true },
  { width: 1280, hasTouch: false },
]) {
  test.describe(`machine agent alignment at ${width}px`, () => {
    test.use({ hasTouch });
    test("keeps the label aligned with the first agent row when chips wrap", async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/tests/fixtures/workspace-surfaces/index.html?panel=machines");
      const activate = (control: Locator) => hasTouch ? control.tap() : control.click();
      await activate(page.getByRole("radiogroup", { name: "Review theme" }).getByText("Light", { exact: true }));
      const machine = page.locator('[data-runtime-option-id="review-local"]');
      const agents = machine.getByTestId("machines-card-agents-review-local");
      const choices = page.getByRole("radiogroup", { name: "Agents example" });

      for (const mode of ["Single", "Several"]) {
        await activate(choices.getByText(mode, { exact: true }));
        await expect(choices.getByRole("radio", { name: mode, exact: true })).toBeChecked();
        const chips = agents.locator('[data-testid^="machines-agent-chip-"]');
        await expect(chips).toHaveCount(mode === "Single" ? 1 : 8);
        const firstChip = chips.first();
        const label = agents.getByText("Agents", { exact: true });
        const labelBox = (await label.boundingBox())!;
        const chipBox = (await firstChip.boundingBox())!;
        expect(Math.abs(labelBox.y + labelBox.height / 2 - chipBox.y - chipBox.height / 2), `${mode}: label follows first chip row`).toBeLessThanOrEqual(2);

        const plot = machine.getByTestId("runtime-sparkline-cpu").locator("svg");
        const imageValue = machine.getByText("instafy/runtime:review", { exact: true });
        for (const content of [plot, imageValue]) {
          expect(Math.abs((await content.boundingBox())!.x - chipBox.x), `${mode}: fact content uses one left edge`).toBeLessThanOrEqual(1);
        }
        const chipBoxes = await chips.evaluateAll(elements => elements.map(element => {
          const { x, y, width, height } = element.getBoundingClientRect();
          return { x, y, width, height };
        }));
        for (const box of chipBoxes) {
          expect(box.x).toBeGreaterThanOrEqual(0);
          expect(box.x + box.width).toBeLessThanOrEqual(width);
        }
        if (mode === "Several") {
          expect(chipBoxes.some(box => box.y > chipBox.y + chipBox.height), "fixture forces a second chip row even on desktop").toBe(true);
          const groupBox = (await agents.boundingBox())!;
          expect(labelBox.y + labelBox.height / 2).toBeLessThan(groupBox.y + groupBox.height / 2 - 4);
        }
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        await page.screenshot({ animations: "disabled", path: testInfo.outputPath(`machines-agents-${mode.toLowerCase()}.png`) });
        await agents.screenshot({ animations: "disabled", path: testInfo.outputPath(`agents-row-${mode.toLowerCase()}.png`) });

        const pin = machine.getByRole("button", { name: "Pin an agent to Workshop Mac", exact: true });
        expect((await pin.boundingBox())!.height).toBe(hasTouch ? 44 : 32);
        await activate(pin);
        const menu = page.getByRole("menu", { name: "Pin an agent to Workshop Mac", exact: true });
        await expect(menu).toBeVisible();
        await expect(menu.getByRole("menuitem", { name: "@builder", exact: true })).toBeVisible();
        await menu.press("Escape");
        await expect(pin).toBeFocused();
      }
    });
  });
}
