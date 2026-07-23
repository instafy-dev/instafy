import { test, expect, type Page } from "@playwright/test";
import { prepareStudio, resetRuntimeUserState } from "../utils/harness.js";

async function waitForWorkspaceOriginConnected(page: Page, timeoutMs = 120_000) {
  await expect(page.getByText("Connecting to workspace origin…")).toHaveCount(0, {
    timeout: timeoutMs,
  });
}

test.describe("File explorer UI", () => {
  test.afterEach(async ({ page }) => {
    await resetRuntimeUserState(page, { source: "file-explorer-ui:cleanup" }).catch(() => {});
  });

  test("shows a search icon in the Files explorer", async ({ page }) => {
    test.setTimeout(120_000);
    page.setDefaultTimeout(60_000);
    await page.setViewportSize({ width: 1280, height: 720 });

    await prepareStudio(page, { waitForHostedRuntime: false });

    await page.getByTestId("sidebar-nav-code").click();
    await expect(page.getByTestId("code-search-input")).toBeVisible();
    await expect(page.getByTestId("code-search-icon")).toBeVisible();
  });

  test("creates folder + file via toolbar and deletes via context menu", async ({ page }) => {
    test.setTimeout(180_000);
    page.setDefaultTimeout(60_000);
    await page.setViewportSize({ width: 1280, height: 720 });

    await prepareStudio(page);

    await page.getByTestId("sidebar-nav-code").click();
    await waitForWorkspaceOriginConnected(page);
    await expect(page.getByTestId("files-explorer-refresh")).toBeEnabled({ timeout: 90_000 });

    const folderName = `pwfolder${Date.now()}`;
    const folderPath = folderName;
    const folderTestId = `files-entry-${folderPath.replace(/[^a-zA-Z0-9]/g, "-")}`;

    await expect(page.getByTestId("files-explorer-new-folder")).toBeEnabled();
    await page.getByTestId("files-explorer-new-folder").click();
    const folderInput = page.getByTestId("files-explorer-create-folder-input");
    await expect(folderInput).toBeVisible();
    await folderInput.click();
    await folderInput.fill(folderName);
    await folderInput.press("Enter");

    await waitForWorkspaceOriginConnected(page);
    await page.getByTestId("files-explorer-refresh").click();
    await waitForWorkspaceOriginConnected(page);
    await expect(page.getByTestId(folderTestId)).toBeVisible({ timeout: 30_000 });
    await page.getByTestId(folderTestId).click();

    const fileName = `pwfile${Date.now()}.txt`;
    const filePath = `${folderPath}/${fileName}`;
    const fileTestId = `files-entry-${filePath.replace(/[^a-zA-Z0-9]/g, "-")}`;

    await expect(page.getByTestId("files-explorer-new-file")).toBeEnabled({ timeout: 30_000 });
    await page.getByTestId("files-explorer-new-file").click();
    const fileInput = page.getByTestId("files-explorer-create-file-input");
    await expect(fileInput).toBeVisible();
    await fileInput.click();
    await fileInput.fill(fileName);
    await fileInput.press("Enter");

    await waitForWorkspaceOriginConnected(page);
    await page.getByTestId("files-explorer-refresh").click();
    await waitForWorkspaceOriginConnected(page);
    await expect(page.getByTestId(fileTestId)).toBeVisible({ timeout: 30_000 });

    await page.getByTestId(fileTestId).click({ button: "right" });
    await expect(page.getByTestId("files-explorer-menu")).toBeVisible();
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByTestId("files-explorer-menu-delete").click();
    await waitForWorkspaceOriginConnected(page);
    await page.getByTestId("files-explorer-refresh").click();
    // Refresh can briefly kick the origin connection back into "Connecting…" during controller/tunnel churn.
    // Wait for a stable connected state before asserting that the deleted entry disappears from the tree.
    await waitForWorkspaceOriginConnected(page, 180_000);
    await expect(page.getByTestId(fileTestId)).toHaveCount(0, { timeout: 60_000 });

    await page.getByTestId(folderTestId).click({ button: "right" });
    await expect(page.getByTestId("files-explorer-menu")).toBeVisible();
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByTestId("files-explorer-menu-delete").click();
    await waitForWorkspaceOriginConnected(page);
    await page.getByTestId("files-explorer-refresh").click();
    await waitForWorkspaceOriginConnected(page, 180_000);
    await expect(page.getByTestId(folderTestId)).toHaveCount(0, { timeout: 60_000 });
  });
});
