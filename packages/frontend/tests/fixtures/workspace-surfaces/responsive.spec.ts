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

for (const { width, hasTouch } of [{ width: 390, hasTouch: true }, { width: 1440, hasTouch: false }]) {
  test.describe(`Changes surfaces at ${width}px`, () => {
    test.use({ hasTouch });
    for (const theme of ["Light", "Dark"]) {
      test(`${theme.toLowerCase()} diff switching and unavailable Files remain usable`, async ({ page }, testInfo) => {
        const errors: string[] = [];
        page.on("pageerror", error => errors.push(error.message));
        await page.setViewportSize({ width, height: 950 });
        await page.goto("/tests/fixtures/workspace-surfaces/index.html?panel=changes");
        await page.getByRole("radiogroup", { name: "Review theme" }).getByText(theme, { exact: true }).click();
        const rolling = page.getByTestId(hasTouch ? "source-control-rolling-diff-sheet-panel" : "source-control-rolling-diff-view");
        await expect(rolling).toBeVisible();
        const welcome = rolling.getByTestId("source-control-rolling-diff-item-src-welcome-ts-panel");
        const changedLine = welcome.getByText('const displayName = name.trim() || "there";', { exact: false });
        await expect(changedLine).toBeVisible();
        const toggle = welcome.getByRole("button", { name: "Collapse diff", exact: true });
        await toggle.click();
        await expect(changedLine).toHaveCount(0);
        await welcome.getByRole("button", { name: "Expand diff", exact: true }).click();
        await expect(changedLine).toBeVisible();
        await page.screenshot({ path: testInfo.outputPath("changes-all.png"), animations: "disabled" });

        if (hasTouch) await page.getByTestId("source-control-rolling-diff-close").click();
        else await page.getByTestId("source-control-review-mode-focused").click();
        const focused = page.getByTestId(hasTouch ? "source-control-diff-sheet-panel" : "source-control-diff-view");
        await expect(focused).toBeVisible();
        await expect(focused).toContainText('const displayName = name.trim() || "there";');
        await page.screenshot({ path: testInfo.outputPath("changes-focused.png"), animations: "disabled" });
        if (hasTouch) await page.getByTestId("source-control-diff-close").click();
        await page.getByTestId("source-control-review-mode-all").click();
        await expect(rolling).toBeVisible();
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

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
    const title = page.getByRole("heading", { name: longFilePath.split("/").at(-1), exact: true });
    expect((await title.boundingBox())!.width).toBeGreaterThan(32);
    await page.screenshot({ path: testInfo.outputPath("files-long-name-preview.png"), animations: "disabled" });
    await page.getByTestId("files-viewer-mode").tap();
    await expect(page.getByTestId("monaco-editor")).toBeVisible();
    await expectFileControlsInViewport(page, 320);
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
