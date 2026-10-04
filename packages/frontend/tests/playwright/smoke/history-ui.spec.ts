import { test, expect, type Page } from "@playwright/test";
import {
  prepareStudio,
  readWorkspaceFileText,
  resetRuntimeUserState,
  writeWorkspaceFile,
} from "../utils/harness.js";
import { requireGatewayMode } from "../utils/gatewayMode.js";
import { plantRecoveryRef } from "../utils/recoveryRefs.js";

/**
 * History on a cloud space backed by the stateless gateway: every save is a
 * version, Revert saves an undo on top, and work the gateway or a runtime
 * kept aside shows under Unsaved work.
 *
 * Needs a git-canonical stack whose gateway is the stateless one and a
 * controller that forwards git/revert-commit and git/recovery*:
 *   GIT_CANONICAL=1 PLAYWRIGHT_GATEWAY_MODE=stateless
 */

function sanitizeTestId(value: string): string {
  return value.replace(/[^a-zA-Z0-9]/g, "-");
}

async function openHistory(page: Page) {
  const drawer = page.getByTestId("source-control-drawer");
  if (!(await drawer.isVisible().catch(() => false))) {
    await page.getByTestId("sidebar-nav-sourceControl").click();
  }
  await expect(drawer).toBeVisible({ timeout: 30_000 });
  await expect(drawer).toHaveAttribute("data-mode", "history", { timeout: 30_000 });
  await expect(page.getByTestId("sidebar-nav-sourceControl")).toContainText("History");
  return drawer;
}

async function refreshHistory(page: Page) {
  await page.getByTestId("source-control-refresh").click();
}

function historyRows(page: Page) {
  return page.getByTestId("source-control-history-entry");
}

function unsavedRow(page: Page, ref: string) {
  return page.locator(`[data-testid="unsaved-work-entry"][data-ref="${ref}"]`);
}

async function revertRow(page: Page, row: ReturnType<typeof historyRows>) {
  await row.getByTestId("source-control-history-toggle").click();
  await row.getByTestId("source-control-history-revert").click();
  const dialog = page.getByTestId("history-revert-dialog");
  await expect(dialog).toContainText("Revert this version?");
  await page.getByTestId("history-revert-dialog-confirm").click();
}

test.describe("History UI (stateless gateway)", () => {
  test.skip((process.env.GIT_CANONICAL ?? "").trim() !== "1", "Requires git-canonical stack (start with GIT_CANONICAL=1).");
  test.describe.configure({ timeout: 240_000 });
  let projectId = "";

  test.beforeEach(async ({ page }) => {
    page.setDefaultTimeout(60_000);
    const prepared = await prepareStudio(page, { waitForHostedRuntime: false });
    if (!prepared) {
      throw new Error("Active project id missing for the History spec.");
    }
    projectId = prepared;
    await requireGatewayMode(page, projectId, "stateless");
  });

  test.afterEach(async ({ page }) => {
    await resetRuntimeUserState(page, { source: "history-ui:cleanup" }).catch(() => {});
  });

  test("Save in Files creates a version with its author", async ({ page }) => {
    // Uses the single Save from the Files change of the same release.
    const unique = Date.now();
    // At the root, so the explorer shows it without expanding a folder.
    const filePath = `pw-history-save-${unique}.txt`;
    await writeWorkspaceFile(page, filePath, `initial ${unique}\n`, { projectId });

    await page.getByTestId("sidebar-nav-code").click();
    await page.evaluate((pid) => {
      window.dispatchEvent(new CustomEvent("instafy:workspace-commit", { detail: { projectId: pid } }));
    }, projectId);
    const fileEntry = page.getByTestId(`files-entry-${sanitizeTestId(filePath)}`);
    await expect(fileEntry).toBeVisible({ timeout: 60_000 });
    await fileEntry.click();
    await expect(page.getByTestId("monaco-editor")).toContainText(`initial ${unique}`, { timeout: 60_000 });

    const editor = page.getByTestId("monaco-editor").locator("textarea.inputarea");
    await editor.click({ force: true });
    await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
    await page.keyboard.type(`saved from Studio ${unique}\n`, { delay: 5 });
    await expect(page.getByTestId("code-save-draft-button")).toHaveCount(0);
    await page.getByTestId("code-save-button").click();

    await expect
      .poll(async () => (await readWorkspaceFileText(page, filePath, { projectId })) ?? "", { timeout: 60_000 })
      .toContain(`saved from Studio ${unique}`);

    await openHistory(page);
    const row = historyRows(page).filter({ hasText: `Update ${filePath}` }).first();
    await expect(row).toBeVisible({ timeout: 30_000 });
    // A person's save names the person; Instafy's own versions carry the badge.
    await expect(row.getByTestId("history-author")).toBeVisible();
    await expect(row.getByTestId("history-author-instafy")).toHaveCount(0);
  });

  test("Show more pages older versions and keeps focus on the first new row", async ({ page }) => {
    const unique = Date.now();
    for (let index = 0; index < 22; index += 1) {
      await writeWorkspaceFile(page, `playwright/history-page-${unique}.txt`, `version ${index}\n`, { projectId });
    }
    await openHistory(page);
    await refreshHistory(page);
    await expect(historyRows(page)).toHaveCount(20, { timeout: 30_000 });
    await page.getByTestId("history-show-more").click();
    await expect.poll(async () => await historyRows(page).count(), { timeout: 30_000 }).toBeGreaterThan(20);
    await expect(historyRows(page).nth(20).getByTestId("source-control-history-review")).toBeFocused();
  });

  test("Revert saves a new version that undoes the chosen one", async ({ page }) => {
    const unique = Date.now();
    const filePath = `playwright/history-revert-${unique}.txt`;
    await writeWorkspaceFile(page, filePath, `one ${unique}\n`, { projectId });
    await writeWorkspaceFile(page, filePath, `two ${unique}\n`, { projectId });

    await openHistory(page);
    await refreshHistory(page);
    const newest = historyRows(page).filter({ hasText: `Update ${filePath}` }).first();
    await expect(newest).toBeVisible({ timeout: 30_000 });
    await revertRow(page, newest);

    await expect(page.getByTestId("history-status")).toHaveText("Reverted. Saved as a new version.", { timeout: 60_000 });
    await expect
      .poll(async () => (await readWorkspaceFileText(page, filePath, { projectId })) ?? "", { timeout: 60_000 })
      .toBe(`one ${unique}\n`);
    await expect(historyRows(page).filter({ hasText: `Revert "Update ${filePath}"` }).first()).toBeVisible({
      timeout: 30_000,
    });
  });

  test("a revert that later changes overlap explains itself and offers the agent", async ({ page }) => {
    const unique = Date.now();
    const filePath = `playwright/history-revert-conflict-${unique}.txt`;
    await writeWorkspaceFile(page, filePath, `a ${unique}\n`, { projectId });
    await writeWorkspaceFile(page, filePath, `b ${unique}\n`, { projectId });
    await writeWorkspaceFile(page, filePath, `c ${unique}\n`, { projectId });

    await openHistory(page);
    await refreshHistory(page);
    const rows = historyRows(page).filter({ hasText: `Update ${filePath}` });
    await expect(rows).toHaveCount(3, { timeout: 30_000 });
    // The middle version: the newest one rewrote the same line.
    await revertRow(page, rows.nth(1));

    const status = page.getByTestId("history-status");
    await expect(status).toContainText(
      "Later changes touch the same files, so this can't be reverted automatically.",
      { timeout: 60_000 },
    );
    await expect(page.getByTestId("history-revert-ask-agent")).toBeVisible();
    expect((await readWorkspaceFileText(page, filePath, { projectId })) ?? "").toBe(`c ${unique}\n`);
  });

  test("Unsaved work can be reviewed, restored and removed", async ({ page }) => {
    const unique = Date.now();
    const restorePath = `playwright/kept-restore-${unique}.txt`;
    const removePath = `playwright/kept-remove-${unique}.txt`;
    const toRestore = await plantRecoveryRef(page, {
      projectId,
      files: { [restorePath]: `kept ${unique}\n` },
      name: `restore-${unique}`,
    });
    const toRemove = await plantRecoveryRef(page, {
      projectId,
      files: { [removePath]: `discard ${unique}\n` },
      name: `remove-${unique}`,
    });

    await openHistory(page);
    await refreshHistory(page);
    const restoreRow = unsavedRow(page, toRestore.ref);
    await expect(restoreRow).toBeVisible({ timeout: 30_000 });
    await expect(restoreRow).toHaveAttribute("data-kind", "unpublished");
    await expect(restoreRow).toContainText("Agent work that couldn't be saved");
    await expect(restoreRow).toContainText("1 file");

    await restoreRow.getByTestId("unsaved-work-review").click();
    await expect(page.getByTestId("git-review-title")).toHaveText("Agent work that couldn't be saved", {
      timeout: 30_000,
    });
    await expect(page.getByTestId("git-review-view")).toContainText(restorePath);

    await openHistory(page);
    await unsavedRow(page, toRestore.ref).getByTestId("unsaved-work-restore").click();
    await expect(page.getByTestId("history-status")).toContainText("Restored as a new version.", { timeout: 60_000 });
    await expect(unsavedRow(page, toRestore.ref)).toHaveCount(0, { timeout: 30_000 });
    await expect
      .poll(async () => (await readWorkspaceFileText(page, restorePath, { projectId })) ?? "", { timeout: 60_000 })
      .toBe(`kept ${unique}\n`);

    await unsavedRow(page, toRemove.ref).getByTestId("unsaved-work-remove").click();
    await expect(page.getByTestId("unsaved-work-remove-dialog")).toContainText(
      "This removes it for everyone in this space and can't be undone.",
    );
    await page.getByTestId("unsaved-work-remove-dialog-confirm").click();
    await expect(unsavedRow(page, toRemove.ref)).toHaveCount(0, { timeout: 30_000 });
    expect(await readWorkspaceFileText(page, removePath, { projectId })).toBeNull();
  });

  test("a restore that meets newer changes asks per file", async ({ page }) => {
    const unique = Date.now();
    const filePath = `playwright/kept-conflict-${unique}.txt`;
    await writeWorkspaceFile(page, filePath, `base ${unique}\n`, { projectId });
    const kept = await plantRecoveryRef(page, {
      projectId,
      files: { [filePath]: `kept ${unique}\n` },
      name: `conflict-${unique}`,
    });
    await writeWorkspaceFile(page, filePath, `newer ${unique}\n`, { projectId });

    await openHistory(page);
    await refreshHistory(page);
    const row = unsavedRow(page, kept.ref);
    await row.getByTestId("unsaved-work-restore").click();
    await expect(row.getByTestId("unsaved-work-conflict")).toContainText(
      "These files changed since this work was kept. Choose a version for each:",
      { timeout: 60_000 },
    );
    const pathRow = row.locator(`[data-testid="unsaved-work-path"][data-path="${filePath}"]`);
    await pathRow.getByTestId("unsaved-work-path-use").click();
    await expect(pathRow.getByTestId("unsaved-work-path-resolved")).toContainText("Saved this version", {
      timeout: 60_000,
    });
    await row.getByTestId("unsaved-work-restore-rest").click();
    // The only kept file is already saved, so the rest adds no version.
    await expect(page.getByTestId("history-status")).toContainText(
      "Nothing to restore. The saved version already has this work.",
      { timeout: 60_000 },
    );
    expect((await readWorkspaceFileText(page, filePath, { projectId })) ?? "").toBe(`kept ${unique}\n`);
  });

  test("new unsaved work is announced once per viewer", async ({ page }) => {
    const unique = Date.now();
    await plantRecoveryRef(page, {
      projectId,
      files: { [`playwright/kept-row-${unique}.txt`]: `kept ${unique}\n` },
      name: `row-${unique}`,
    });
    await page.reload();
    await page.getByTestId("sidebar-nav-chat").click();
    const systemRow = page.getByTestId("unsaved-work-system-row");
    await expect(systemRow).toBeVisible({ timeout: 60_000 });
    await expect(systemRow).toContainText("Some work wasn't saved");
    await expect(page.getByTestId("sidebar-nav-sourceControl-badge")).toBeVisible();
    await page.getByTestId("unsaved-work-system-row-dismiss").click();
    await expect(systemRow).toHaveCount(0);

    await page.reload();
    await page.getByTestId("sidebar-nav-chat").click();
    // The list loads with Studio; once the badge shows it, the row would be up too.
    await expect(page.getByTestId("sidebar-nav-sourceControl-badge")).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId("unsaved-work-system-row")).toHaveCount(0);
  });
});
