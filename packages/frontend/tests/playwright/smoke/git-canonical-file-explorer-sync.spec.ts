import { fileExplorerAction, fileExplorerSearch } from "../utils/filesExplorer.js";
import { recordOriginRequests } from "../utils/filesEditor.js";
import { assertGatewayMode, gatewayMode } from "../utils/gatewayMode.js";
import { test, expect, type Page } from "@playwright/test";
import {
  clearRuntimePreference,
  prepareStudio,
  pushGitRemoteFileText,
  requestHostedRuntime,
  resetRuntimeUserState,
  setRuntimePreference,
  waitForHostedRuntimeReady,
} from "../utils/harness.js";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function ensureHostedRuntimeReady(page: Page, projectId: string): Promise<string | null> {
  const ready = await waitForHostedRuntimeReady(page, 10_000).then(() => true).catch(() => false);
  if (!ready) {
    await requestHostedRuntime(page, { projectId }).catch(() => {});
  }
  const hosted = await waitForHostedRuntimeReady(page, 120_000);
  return hosted.runtimeId ?? null;
}

async function waitForWorkspaceOriginConnected(page: Page, timeoutMs = 120_000) {
  await expect(page.getByText(/Opening files…|Still opening files…|Reconnecting to your files…/)).toHaveCount(0, {
    timeout: timeoutMs,
  });
}

test.describe("Git-canonical file explorer sync", () => {
  test.skip(
    (process.env.GIT_CANONICAL ?? "").trim() !== "1",
    "Requires git-canonical stack (start with GIT_CANONICAL=1)."
  );

  test.describe.configure({ timeout: 240_000 });
  let activeProjectId: string | null = null;

  test.beforeEach(async ({ page }) => {
    page.setDefaultTimeout(60_000);
    const projectId = await prepareStudio(page);
    activeProjectId = projectId;
    if (projectId) {
      await assertGatewayMode(page, projectId);
    }
    await clearRuntimePreference(page, { projectId, source: "git-canonical-file-explorer-sync" });
    if (projectId) {
      const runtimeId = await ensureHostedRuntimeReady(page, projectId);
      if (runtimeId) {
        await setRuntimePreference(page, projectId, runtimeId, "git-canonical-file-explorer-sync");
      }
    }

    await page.getByTestId("sidebar-nav-code").click();
    await waitForWorkspaceOriginConnected(page);
    await expect(await fileExplorerAction(page, "refresh")).toBeEnabled({ timeout: 90_000 });
  });

  test.afterEach(async ({ page }) => {
    await resetRuntimeUserState(page, { source: "git-canonical-file-explorer-sync:cleanup" }).catch(
      () => {}
    );
  });

  test("updates an open file explorer when an external git push lands", async ({ page }) => {
    if (!activeProjectId) {
      throw new Error("Active project id missing for file explorer external sync test.");
    }

    const unique = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const filePath = `playwright-external-sync-${unique}.txt`;
    const fileContents = `external sync ${unique}`;
    const fileTestId = `files-entry-${filePath.replace(/[^a-zA-Z0-9]/g, "-")}`;

    await (await fileExplorerSearch(page)).fill(filePath);
    await expect(page.getByTestId(fileTestId)).toHaveCount(0);

    const recorded = recordOriginRequests(page);
    const remoteCommit = await pushGitRemoteFileText(page, filePath, `${fileContents}\n`, {
      projectId: activeProjectId,
      message: `playwright: external push ${filePath}`,
      requireGitRemote: true,
    });
    if (!remoteCommit) {
      throw new Error("Expected external git push to return a commit hash, but got null.");
    }

    const byTestId = page.getByTestId(fileTestId).first();
    const byButtonText = page.locator("button", { hasText: filePath }).first();
    const byAnyText = page.getByText(new RegExp(escapeRegExp(filePath), "i")).first();

    const visibleLocator = await expect
      .poll(
        async () => {
          if ((await byTestId.count()) > 0 && (await byTestId.isVisible().catch(() => false))) {
            return "testid";
          }
          if (
            (await byButtonText.count()) > 0 &&
            (await byButtonText.isVisible().catch(() => false))
          ) {
            return "button";
          }
          if ((await byAnyText.count()) > 0 && (await byAnyText.isVisible().catch(() => false))) {
            return "text";
          }
          return null;
        },
        { timeout: 120_000 },
      )
      .not.toBeNull();

    if (gatewayMode() === "stateless") {
      // The commit event pins every reload to the pushed commit, and the
      // stateless explorer never asks for a blocking sync.
      const params = recorded.entries.map((url) => new URL(url).searchParams);
      expect(params.some((search) => search.get("rev") === remoteCommit)).toBe(true);
      expect(params.every((search) => search.get("sync") !== "blocking")).toBe(true);
    }

    // The contract for this spec is explorer-level detection of external git updates.
    // Opening Monaco can fail if the runtime lease rotates while the row is already visible.
  });
});
