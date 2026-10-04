import { test, expect, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import {
  assertGitRemoteFileText,
  getControllerUrl,
  prepareStudio,
  pushGitRemoteFileText,
  requireWorkspaceProjectId,
  resetRuntimeUserState,
  resolveAuthenticatedAccessToken,
  writeWorkspaceFile,
} from "../utils/harness.js";
import { ensureDesktopOriginServer, stopDesktopOriginServer } from "../utils/desktopRuntimeHarness.js";

/**
 * A Desktop space: the folder on this computer is the project's default
 * origin. Saving never loses the user's bytes, and History counts files
 * changed in the folder outside Studio.
 *
 *   PLAYWRIGHT_DESKTOP_ORIGIN_SMOKE=1 GIT_CANONICAL=1
 */

function resolveServiceRoleKey(): string {
  return (
    process.env.CONTROLLER_INTERNAL_TOKEN ||
    process.env.PLAYWRIGHT_CONTROLLER_INTERNAL_TOKEN ||
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SERVICE_ROLE_KEY ||
    ""
  );
}

/** Mirrors desktopRuntimeHarness: the folder the CLI runtime serves. */
function desktopWorkspaceDir(): string {
  return process.env.PLAYWRIGHT_DESKTOP_RUNTIME_WORKSPACE ?? path.join(process.cwd(), "tmp", "playwright-desktop-runtime");
}

function sanitizeTestId(value: string): string {
  return value.replace(/[^a-zA-Z0-9]/g, "-");
}

async function startDesktopOrigin(page: Page): Promise<string> {
  const controllerUrl = getControllerUrl();
  const serviceRoleKey = resolveServiceRoleKey();
  const ownerAccessToken = await resolveAuthenticatedAccessToken(page);
  const projectId = await requireWorkspaceProjectId(page);
  if (!controllerUrl || !serviceRoleKey || !ownerAccessToken) {
    throw new Error("Controller URL, service role key and an authenticated owner are required.");
  }
  await ensureDesktopOriginServer({ controllerUrl, serviceRoleKey, ownerAccessToken, projectId });
  await page.reload();
  // The Desktop origin is now the default origin: Studio shows History.
  await expect(page.getByTestId("sidebar-nav-sourceControl")).toContainText("History", { timeout: 120_000 });
  return projectId;
}

test.describe.serial("Desktop saves and the Desktop line", () => {
  test.setTimeout(300_000);

  test.beforeEach(async ({ page }) => {
    test.skip(
      (process.env.PLAYWRIGHT_DESKTOP_ORIGIN_SMOKE ?? "").trim() !== "1",
      "Set PLAYWRIGHT_DESKTOP_ORIGIN_SMOKE=1 to run the Desktop origin smoke.",
    );
    test.skip((process.env.GIT_CANONICAL ?? "").trim() !== "1", "Requires git-canonical stack (start with GIT_CANONICAL=1).");
    process.env.PLAYWRIGHT_DESKTOP_RUNTIME_MODE = "cli";
    page.setDefaultTimeout(60_000);
    await prepareStudio(page, { waitForHostedRuntime: false });
  });

  test.afterEach(async ({ page }) => {
    await stopDesktopOriginServer().catch(() => {});
    await resetRuntimeUserState(page, { source: "desktop-save-conflict:cleanup" }).catch(() => {});
  });

  test("a save that meets a newer version keeps the user's bytes in the folder", async ({ page }) => {
    // Uses the single Save from the Files change of the same release.
    const projectId = await startDesktopOrigin(page);
    const unique = Date.now();
    const fileName = `pw-desktop-conflict-${unique}.txt`;
    await writeWorkspaceFile(page, fileName, `base ${unique}\n`, { projectId });

    await page.getByTestId("sidebar-nav-code").click();
    await page.evaluate((pid) => {
      window.dispatchEvent(new CustomEvent("instafy:workspace-commit", { detail: { projectId: pid } }));
    }, projectId);
    const entry = page.getByTestId(`files-entry-${sanitizeTestId(fileName)}`);
    await expect(entry).toBeVisible({ timeout: 60_000 });
    await entry.click();
    await expect(page.getByTestId("monaco-editor")).toContainText(`base ${unique}`, { timeout: 60_000 });

    const userText = `mine ${unique}\n`;
    const editor = page.getByTestId("monaco-editor").locator("textarea.inputarea");
    await editor.click({ force: true });
    await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
    await page.keyboard.type(userText, { delay: 5 });

    // Someone else saves the same file in the space first.
    await pushGitRemoteFileText(page, fileName, `theirs ${unique}\n`, {
      projectId,
      message: `playwright: newer version of ${fileName}`,
      requireGitRemote: true,
    });

    await page.getByTestId("code-save-button").click();
    await expect(page.getByTestId("workspace-file-stale-card")).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId("monaco-editor")).toContainText(`mine ${unique}`);
    const onDisk = fs.readFileSync(path.join(desktopWorkspaceDir(), fileName), "utf8");
    expect(onDisk).toBe(userText);
  });

  test("History counts files changed outside Studio and saves them as a version", async ({ page }) => {
    const projectId = await startDesktopOrigin(page);
    const unique = Date.now();
    const fileName = `pw-desktop-outside-${unique}.txt`;
    fs.writeFileSync(path.join(desktopWorkspaceDir(), fileName), `from the terminal ${unique}\n`, "utf8");

    await page.getByTestId("sidebar-nav-sourceControl").click();
    const drawer = page.getByTestId("source-control-drawer");
    await expect(drawer).toHaveAttribute("data-mode", "history", { timeout: 30_000 });
    await page.getByTestId("source-control-refresh").click();
    const line = page.getByTestId("desktop-changes-line");
    // The folder is shared across serial tests, so other leftovers may count too.
    await expect(line).toContainText(/\d+ files? changed outside Studio/, { timeout: 60_000 });

    await page.getByTestId("desktop-save-as-version").click();
    await expect(page.getByTestId("history-status")).toContainText(/Saved \d+ files? as a version\./, {
      timeout: 120_000,
    });
    await expect(line).toHaveCount(0, { timeout: 30_000 });
    await assertGitRemoteFileText(page, fileName, {
      projectId,
      expectedText: `from the terminal ${unique}`,
      requireGitRemote: true,
    });
  });
});
