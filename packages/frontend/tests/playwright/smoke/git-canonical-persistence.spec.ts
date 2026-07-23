import { test, expect, type Page } from "@playwright/test";
import {
  assertGitRemoteFileText,
  clearRuntimePreference,
  prepareStudio,
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

test.describe("Git-canonical persistence", () => {
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
    await clearRuntimePreference(page, { projectId, source: "git-canonical-persistence" });
    if (projectId) {
      await ensureHostedRuntimeReady(page, projectId);
    }
  });

  test.afterEach(async ({ page }) => {
    await resetRuntimeUserState(page, { source: "git-canonical-persistence:cleanup" }).catch(
      () => {}
    );
  });

  test("applies workspace changes and commits to git remote", async ({ page }) => {
    if (!activeProjectId) {
      throw new Error("Active project id missing for git-canonical persistence test.");
    }

    const filePath = `playwright/git-canonical-${Date.now()}.txt`;
    const expectedText = `hello git-canonical ${Date.now()}`;

    await writeWorkspaceFile(page, filePath, `${expectedText}\n`, { projectId: activeProjectId });

    await expect
      .poll(
        async () =>
          (await readWorkspaceFileText(page, filePath, { projectId: activeProjectId }))?.trim(),
        { timeout: 60_000 }
      )
      .toBe(expectedText);

    const synced = await syncGitRemote(page, { projectId: activeProjectId });
    if (!synced) {
      throw new Error("Expected git sync to return a commit hash, but got null.");
    }

    await assertGitRemoteFileText(page, filePath, {
      projectId: activeProjectId,
      expectedText,
      requireGitRemote: true,
    });

    await resetRuntimeUserState(page, {
      source: "git-canonical-persistence:reset-after-commit",
    }).catch(() => {});

    await prepareStudio(page, { reuseExisting: true });
    await ensureHostedRuntimeReady(page, activeProjectId);

    await expect
      .poll(
        async () =>
          (await readWorkspaceFileText(page, filePath, { projectId: activeProjectId }))?.trim(),
        { timeout: 120_000 }
      )
      .toBe(expectedText);
  });
});
