import { test, expect, type Page } from "@playwright/test";
import { prepareStudio, resetRuntimeUserState, writeWorkspaceFile, readWorkspaceFileText } from "../utils/harness.js";

async function waitForWorkspaceOriginConnected(page: Page, timeoutMs = 180_000) {
  await expect(page.getByText("Connecting to workspace origin…")).toHaveCount(0, {
    timeout: timeoutMs,
  });
}

async function dismissAnyToast(page: Page) {
  const dismissToast = page
    .getByTestId("status-toast")
    .getByRole("button", { name: "Dismiss notification" })
    .first();
  if ((await dismissToast.count()) > 0) {
    await dismissToast.click().catch(() => {});
  }
}

test.describe("File concurrency", () => {
  test.afterEach(async ({ page }) => {
    await resetRuntimeUserState(page, { source: "file-concurrency-chat:cleanup" }).catch(() => {});
  });

  test("warns before clobbering a dirty editor when the workspace file changes", async ({ page, browser }) => {
    test.setTimeout(240_000);
    page.setDefaultTimeout(60_000);
    await page.setViewportSize({ width: 1280, height: 720 });

    const projectId = await prepareStudio(page);
    if (!projectId) {
      throw new Error("Active project id missing for file concurrency test.");
    }

    await page.getByTestId("sidebar-nav-code").click();
    const retryButton = page.getByRole("button", { name: "Retry" }).first();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const visible = await retryButton.isVisible().catch(() => false);
      if (!visible) {
        break;
      }
      await retryButton.click();
      await page.waitForTimeout(1_000);
    }
    await waitForWorkspaceOriginConnected(page);

    const unique = Date.now();
    const fileName = `pw-concurrency-${unique}.txt`;
    const filePath = fileName;
    const initialText = `initial ${unique}\n`;
    const localUnsavedText = `local unsaved ${unique}\n`;
    const peerText = `peer update ${unique}\n`;

    await writeWorkspaceFile(page, filePath, initialText, { projectId });
    await expect.poll(async () => (await readWorkspaceFileText(page, filePath, { projectId })) ?? "", {
      timeout: 120_000,
    }).toBe(initialText);

    // Refresh the portal-backed explorer, then open the file through the real
    // user flow. The portal owns the handoff that mounts the Files workspace
    // before it forwards instafy:open-workspace-file to the destination panel.
    await page.evaluate((pid) => {
      window.dispatchEvent(
        new CustomEvent("instafy:workspace-commit", { detail: { projectId: pid } }),
      );
    }, projectId);
    const fileEntry = page.getByTestId(
      `files-entry-${filePath.replace(/[^a-zA-Z0-9]/g, "-")}`,
    );
    await expect(fileEntry).toBeVisible({ timeout: 60_000 });
    await fileEntry.click();

    await expect(page.getByTestId("code-save-draft-button")).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId("workspace-tabs")).toContainText(fileName, { timeout: 60_000 });
    await expect(page.getByTestId("monaco-editor")).toContainText(`initial ${unique}`, { timeout: 60_000 });

    await dismissAnyToast(page);

    const monacoTextarea = page.getByTestId("monaco-editor").locator("textarea.inputarea");
    await monacoTextarea.click({ force: true });
    await expect(monacoTextarea).toBeFocused({ timeout: 10_000 });
    await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
    await page.keyboard.press("Backspace");
    await page.keyboard.type(localUnsavedText, { delay: 5 });
    await expect(page.getByTestId("monaco-editor")).toContainText(`local unsaved ${unique}`, {
      timeout: 30_000,
    });
    await expect(page.getByTestId("code-save-draft-button")).toBeEnabled({ timeout: 30_000 });

    // Use a separate browser context so localStorage mutations in the peer can't
    // trigger cross-tab project switching in the primary page.
    const peerContext = await browser.newContext({ storageState: await page.context().storageState() });
    try {
      const peerPage = await peerContext.newPage();
      await writeWorkspaceFile(peerPage, filePath, peerText, { projectId });
    } finally {
      await peerContext.close().catch(() => {});
    }

    await expect.poll(async () => (await readWorkspaceFileText(page, filePath, { projectId })) ?? "", {
      timeout: 120_000,
    }).toBe(peerText);

    // Simulate the workspace commit notification arriving to this tab.
    await page.evaluate((pid) => {
      window.dispatchEvent(new CustomEvent("instafy:workspace-commit", { detail: { projectId: pid } }));
    }, projectId);

    // Ensure we did not clobber the unsaved edits after the workspace commit.
    await expect(page.getByTestId("monaco-editor")).toContainText(`local unsaved ${unique}`, { timeout: 10_000 });

    const staleCard = page.getByTestId("workspace-file-stale-card");
    const staleCardVisible = await staleCard.isVisible().catch(() => false);
    if (!staleCardVisible) {
      await page.getByTestId("sidebar-nav-chat").click();
    }
    await expect(staleCard).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId("workspace-file-stale-reload")).toBeVisible({ timeout: 10_000 });
    await page.getByTestId("workspace-file-stale-reload").click();

    // Reopen the file through the Files drawer's portal handoff. Selecting the
    // sidebar item toggles the drawer; it does not itself replace the active
    // Chat workspace with the Files workspace.
    await page.getByTestId("sidebar-nav-code").click();
    const reloadedFileEntry = page.getByTestId(
      `files-entry-${filePath.replace(/[^a-zA-Z0-9]/g, "-")}`,
    );
    await expect(reloadedFileEntry).toBeVisible({ timeout: 60_000 });
    await reloadedFileEntry.click();

    // The reload action should discard the local edits and show the peer update in the editor.
    await expect(page.getByTestId("monaco-editor")).toContainText(`peer update ${unique}`, {
      timeout: 60_000,
    });
    await expect(page.getByTestId("code-save-draft-button")).toBeDisabled({ timeout: 30_000 });
  });
});
