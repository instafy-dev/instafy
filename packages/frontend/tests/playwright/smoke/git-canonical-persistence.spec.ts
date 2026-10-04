import { test, expect, type Page } from "@playwright/test";
import {
  applyManifestText,
  openFileInFiles,
  pressSaveShortcut,
  recordOriginRequests,
  replaceEditorText,
  waitForApply,
} from "../utils/filesEditor.js";
import { assertGatewayMode, gatewayMode } from "../utils/gatewayMode.js";
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
    test.skip(gatewayMode() !== "legacy", "Stateful gateway flow (Save draft, then sync).");
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

test.describe("Git-canonical persistence on the stateless gateway", () => {
  test.skip(
    (process.env.GIT_CANONICAL ?? "").trim() !== "1" || gatewayMode() !== "stateless",
    "Requires a git-canonical stack with the stateless gateway (GIT_CANONICAL=1, PLAYWRIGHT_GATEWAY_MODE=stateless).",
  );

  test.describe.configure({ timeout: 240_000 });

  test.afterEach(async ({ page }) => {
    await resetRuntimeUserState(page, { source: "git-canonical-persistence:stateless:cleanup" }).catch(() => {});
  });

  test("one Save commits on apply and never calls /git/sync", async ({ page }) => {
    page.setDefaultTimeout(60_000);
    await page.setViewportSize({ width: 1280, height: 720 });
    const projectId = await prepareStudio(page);
    if (!projectId) {
      throw new Error("Active project id missing for the stateless persistence test.");
    }
    await assertGatewayMode(page, projectId);

    const unique = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const filePath = `playwright-stateless-save-${unique}.txt`;
    const savedText = `saved from Files ${unique}`;
    const seeded = await pushGitRemoteFileText(page, filePath, `seed ${unique}\n`, {
      projectId,
      message: `playwright: seed ${filePath}`,
      requireGitRemote: true,
    });
    expect(seeded).toBeTruthy();

    await openFileInFiles(page, projectId, filePath);
    await expect(page.getByTestId("code-save-draft-button")).toHaveCount(0);
    await expect(page.getByTestId("code-save-button")).toHaveAttribute("aria-label", "Save");

    const recorded = recordOriginRequests(page);
    await replaceEditorText(page, `${savedText}\n`);
    await expect(page.getByTestId("code-save-button")).toBeEnabled({ timeout: 30_000 });
    const applied = waitForApply(page);
    await pressSaveShortcut(page);
    const response = await applied;

    expect(response.status()).toBe(200);
    expect(((await response.json()) as { committed?: boolean }).committed).toBe(true);
    const manifest = applyManifestText(response.request());
    expect(manifest).toMatch(/"baseRev":"[0-9a-f]{40}"/);
    expect(manifest).toContain(`"expected":{"${filePath}":"`);
    expect(manifest).not.toContain("idempotencyKey");
    await expect(page.getByTestId("code-save-button")).toBeDisabled({ timeout: 30_000 });
    expect(recorded.syncs).toHaveLength(0);

    await assertGitRemoteFileText(page, filePath, { projectId, expectedText: savedText, requireGitRemote: true });
  });
});
