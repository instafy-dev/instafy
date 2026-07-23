import { test, expect, type Page } from "@playwright/test";
import {
  assertGitRemoteFileText,
  clearRuntimePreference,
  prepareStudio,
  pushGitRemoteFileText,
  readWorkspaceFileText,
  requestHostedRuntime,
  resetRuntimeUserState,
  syncGitRemote,
  waitForHostedRuntimeReady,
  writeWorkspaceFile,
} from "../utils/harness.js";

async function ensureHostedRuntimeReady(page: Page, projectId: string) {
  const ready = await waitForHostedRuntimeReady(page, 10_000).then(() => true).catch(() => false);
  if (!ready) {
    await requestHostedRuntime(page, { projectId }).catch(() => {});
  }
  await waitForHostedRuntimeReady(page, 120_000);
}

test.describe("Git-canonical sync conflicts", () => {
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
    await clearRuntimePreference(page, { projectId, source: "git-canonical-sync-conflict" });
    if (projectId) {
      await ensureHostedRuntimeReady(page, projectId);
    }
  });

  test.afterEach(async ({ page }) => {
    await resetRuntimeUserState(page, {
      source: "git-canonical-sync-conflict:cleanup",
    }).catch(() => {});
  });

  test("rebases dirty text edits onto the latest remote tip", async ({ page }) => {
    if (!activeProjectId) {
      throw new Error("Active project id missing for git-canonical sync conflict test.");
    }

    const unique = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const filePath = `playwright/git-sync-conflict-${unique}.txt`;
    const baseText = `base-${unique}`;
    const remoteText = `remote-${unique}`;
    const localText = `local-${unique}`;

    await writeWorkspaceFile(page, filePath, `${baseText}\n`, { projectId: activeProjectId });
    const seeded = await syncGitRemote(page, {
      projectId: activeProjectId,
      message: `playwright: seed base ${filePath}`,
    });
    if (!seeded) {
      throw new Error("Expected git sync to return a commit hash for baseline seed, but got null.");
    }

    await assertGitRemoteFileText(page, filePath, {
      projectId: activeProjectId,
      expectedText: baseText,
      requireGitRemote: true,
    });

    const remoteCommit = await pushGitRemoteFileText(page, filePath, `${remoteText}\n`, {
      projectId: activeProjectId,
      message: `playwright: remote advance ${filePath}`,
      requireGitRemote: true,
    });
    if (!remoteCommit) {
      throw new Error("Expected remote push to return a commit hash, but got null.");
    }

    await assertGitRemoteFileText(page, filePath, {
      projectId: activeProjectId,
      expectedText: remoteText,
      requireGitRemote: true,
    });

    await writeWorkspaceFile(page, filePath, `${localText}\n`, { projectId: activeProjectId });
    await expect
      .poll(
        async () =>
          (await readWorkspaceFileText(page, filePath, { projectId: activeProjectId }))?.trim(),
        { timeout: 60_000 }
      )
      .toBe(localText);

    const synced = await syncGitRemote(page, {
      projectId: activeProjectId,
      message: `playwright: rebase dirty text edit ${filePath}`,
    });
    expect(synced).toBeTruthy();

    await assertGitRemoteFileText(page, filePath, {
      projectId: activeProjectId,
      expectedText: localText,
      requireGitRemote: true,
    });
    const localAfter = await readWorkspaceFileText(page, filePath, { projectId: activeProjectId });
    expect(localAfter?.trim()).toBe(localText);
  });
});
