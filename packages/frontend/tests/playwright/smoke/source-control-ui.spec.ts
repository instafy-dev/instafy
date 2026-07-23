import { test, expect, type Page } from "@playwright/test";
import {
  assertGitRemoteFileText,
  clearRuntimePreference,
  ensureRealDefaultCodexCredentialWhenRequired,
  expectAssistantReplyOrSkipRateLimit,
  prepareStudio,
  pushGitRemoteFileText,
  readWorkspaceFileText,
  requestHostedRuntime,
  resetRuntimeUserState,
  setRuntimePreference,
  syncGitRemote,
  waitForHostedRuntimeReady,
  writeWorkspaceFile,
  writeWorkspaceFiles,
} from "../utils/harness.js";

const IGNORED_GENERATED_CHANGE_PATHS = [
  ".agents/skills/instafy-agent-collaboration/SKILL.md",
  ".agents/skills/instafy-collaboration/SKILL.md",
  ".agents/skills/instafy-persistent-contexts/SKILL.md",
  ".agents/skills/instafy-skill-router/SKILL.md",
];

function sanitizeTestId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/g, "-");
}

async function ensureHostedRuntimeReady(page: Page, projectId: string): Promise<string | null> {
  const ready = await waitForHostedRuntimeReady(page, 10_000).then(() => true).catch(() => false);
  if (!ready) {
    await requestHostedRuntime(page, { projectId }).catch(() => {});
  }
  const hosted = await waitForHostedRuntimeReady(page, 120_000);
  return hosted.runtimeId ?? null;
}

async function setAssistantAutoSync(page: Page, enabled: boolean) {
  await page.evaluate((value) => {
    window.localStorage.setItem("instafy.git.autoSyncAfterApply", value ? "1" : "0");
  }, enabled);
}

async function discardIgnoredGeneratedChanges(page: Page) {
  for (const path of IGNORED_GENERATED_CHANGE_PATHS) {
    const discardButton = page.getByRole("button", { name: `Discard changes for ${path}` }).first();
    if (!(await discardButton.isVisible().catch(() => false))) {
      continue;
    }
    page.once("dialog", async (dialog) => {
      await dialog.accept();
    });
    await discardButton.click();
    await page.waitForTimeout(200).catch(() => {});
  }
}

async function waitForCleanSourceControl(page: Page, options?: { timeoutMs?: number }) {
  const timeoutMs = options?.timeoutMs ?? 120_000;
  const drawer = await ensureSourceControlDrawerVisible(page);
  const refreshButton = page.getByTestId("source-control-refresh");

  await expect
    .poll(
      async () => {
        await discardIgnoredGeneratedChanges(page);
        if (await refreshButton.isVisible().catch(() => false)) {
          await refreshButton.click().catch(() => {});
        }
        return (await drawer.innerText().catch(() => "")).replace(/\s+/g, " ").trim();
      },
      { timeout: timeoutMs, intervals: [500, 1_000, 2_000] }
    )
    .toContain("No pending changes.");
}

async function ensureSourceControlDrawerVisible(page: Page, options?: { timeoutMs?: number }) {
  const drawer = page.getByTestId("source-control-drawer");
  if (!(await drawer.isVisible().catch(() => false))) {
    await page.getByTestId("sidebar-nav-sourceControl").click();
  }
  await expect(drawer).toBeVisible({ timeout: options?.timeoutMs ?? 30_000 });
  return drawer;
}

async function waitForSourceControlHistoryEntry(
  page: Page,
  commitMessage: string,
  options?: { timeoutMs?: number },
) {
  await ensureSourceControlDrawerVisible(page, options);
  const history = page.getByTestId("source-control-history");
  const refreshButton = page.getByTestId("source-control-refresh");
  await expect
    .poll(
      async () => {
        if (await refreshButton.isVisible().catch(() => false)) {
          await refreshButton.click().catch(() => {});
        }
        const text = (await history.textContent().catch(() => "")) ?? "";
        return text.includes(commitMessage);
      },
      {
        timeout: options?.timeoutMs ?? 30_000,
        intervals: [500, 1_000, 2_000],
      },
    )
    .toBe(true);
  return history;
}

async function measureLargeChangeSetRendering(
  page: Page,
  options: {
    projectId: string;
    unique: string;
    fileCount: number;
    badgeTimeoutMs: number;
    requireBadge: boolean;
    maxDrawerRenderMs: number;
    maxDiffRenderMs: number;
  }
): Promise<{ badgeRenderMs: number | null; drawerRenderMs: number; diffRenderMs: number; firstFilePath: string }> {
  const files = Array.from({ length: options.fileCount }, (_, index) => ({
    path: `playwright/large-dirty-${options.unique}/file-${String(index).padStart(4, "0")}.txt`,
    content: `bulk ${index} ${options.unique}\n`,
  }));
  const firstFilePath = files[0]?.path ?? "";
  if (!firstFilePath) {
    throw new Error("Expected at least one dirty file for large change-set measurement.");
  }

  await syncGitRemote(page, {
    projectId: options.projectId,
    message: `playwright: ensure clean large ${options.unique}`,
  });
  await writeWorkspaceFiles(page, files, { projectId: options.projectId });

  let badgeRenderMs: number | null = null;
  const badgeStartedAt = Date.now();
  try {
    await expect(page.getByTestId("sidebar-nav-sourceControl-badge")).toHaveAttribute(
      "title",
      `${options.fileCount} uncommitted changes`,
      { timeout: options.badgeTimeoutMs }
    );
    badgeRenderMs = Date.now() - badgeStartedAt;
  } catch (error) {
    if (options.requireBadge) {
      throw error;
    }
  }

  const drawerStartedAt = Date.now();
  await page.getByTestId("sidebar-nav-sourceControl").click();
  await expect(page.getByTestId("source-control-drawer")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("source-control-large-changes-note")).toBeVisible({ timeout: 30_000 });
  const changesList = page.getByTestId("source-control-changes");
  await expect(changesList).toBeVisible({ timeout: 30_000 });
  const topLevelPrefix = firstFilePath.split("/")[0] ?? "";
  if (!topLevelPrefix) {
    throw new Error("Unable to derive top-level group for large change-set measurement.");
  }
  const topLevelGroup = page.getByTestId(`source-control-group-${topLevelPrefix}`);
  const topLevelFileRow = changesList.getByRole("button", { name: firstFilePath, exact: true });
  await expect
    .poll(
      async () => {
        if (await topLevelGroup.isVisible().catch(() => false)) {
          return "group";
        }
        if (await topLevelFileRow.isVisible().catch(() => false)) {
          return "file";
        }
        return "pending";
      },
      { timeout: 30_000, intervals: [250, 500, 1_000] },
    )
    .not.toBe("pending");
  await expect(page.getByText("No pending changes.")).toHaveCount(0);
  const drawerRenderMs = Date.now() - drawerStartedAt;
  expect(drawerRenderMs).toBeLessThan(options.maxDrawerRenderMs);

  const diffStartedAt = Date.now();
  const pathSegments = firstFilePath.split("/").filter(Boolean);
  for (let index = 0; index < pathSegments.length - 1; index += 1) {
    const prefix = pathSegments.slice(0, index + 1).join("/");
    const groupButton = page.getByTestId(`source-control-group-${prefix.replace(/[^a-zA-Z0-9_-]+/g, "-")}`);
    if (await groupButton.isVisible().catch(() => false)) {
      await groupButton.click();
    }
  }
  await expect(changesList).toContainText(firstFilePath, {
    timeout: 30_000,
  });
  await changesList.getByRole("button", { name: firstFilePath, exact: true }).click();
  await expect(page.getByTestId("source-control-diff-header")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("source-control-diff-header-new")).toContainText(`b/${firstFilePath}`, {
    timeout: 30_000,
  });
  const diffRenderMs = Date.now() - diffStartedAt;
  expect(diffRenderMs).toBeLessThan(options.maxDiffRenderMs);

  await ensureSourceControlDrawerVisible(page);
  await page.getByTestId("source-control-refresh").click();
  await expect(page.getByTestId("source-control-large-changes-note")).toBeVisible({ timeout: 30_000 });
  await expect
    .poll(
      async () => {
        if (await page.getByTestId(`source-control-group-${topLevelPrefix}`).isVisible().catch(() => false)) {
          return "group";
        }
        if (await changesList.getByRole("button", { name: firstFilePath, exact: true }).isVisible().catch(() => false)) {
          return "file";
        }
        return "pending";
      },
      { timeout: 30_000, intervals: [250, 500, 1_000] },
    )
    .not.toBe("pending");
  await expect(page.getByText("No pending changes.")).toHaveCount(0);

  return { badgeRenderMs, drawerRenderMs, diffRenderMs, firstFilePath };
}

test.describe("Source Control UI (git-canonical)", () => {
  test.skip(
    (process.env.GIT_CANONICAL ?? "").trim() !== "1",
    "Requires git-canonical stack (start with GIT_CANONICAL=1)."
  );

  test.describe.configure({ timeout: 240_000 });
  let activeProjectId: string | null = null;

  test.beforeEach(async ({ page }, testInfo) => {
    page.setDefaultTimeout(60_000);
    const projectId = await prepareStudio(page);
    // Guest sessions have no AI access in the BYOC stack; onboard the
    // canonical local Codex login so the AI-targeted send is actually enabled.
    await ensureRealDefaultCodexCredentialWhenRequired(page);
    activeProjectId = projectId;
    await clearRuntimePreference(page, { projectId, source: "source-control-ui" });
    const title = testInfo.title.toLowerCase();
    const largeChangeBenchmark =
      title.includes("large change sets") ||
      title.includes("one-thousand-plus meaningful file changes");
    if (projectId && !largeChangeBenchmark) {
      const runtimeId = await ensureHostedRuntimeReady(page, projectId);
      if (runtimeId) {
        await setRuntimePreference(page, projectId, runtimeId, "source-control-ui");
      }
    }
    await setAssistantAutoSync(page, true);
  });

  test.afterEach(async ({ page }) => {
    await resetRuntimeUserState(page, { source: "source-control-ui:cleanup" }).catch(() => {});
  });

  test("does not surface Instafy scaffold as uncommitted changes after the first agent job", async ({ page }) => {
    if (!activeProjectId) {
      throw new Error("Active project id missing for source control scaffold test.");
    }

    await page.getByTestId("sidebar-nav-chat").click();
    await page.getByTestId("chat-input").fill("/learn collect");
    await expect(page.getByTestId("chat-send-button")).toBeEnabled({ timeout: 120_000 });
    await page.getByTestId("chat-send-button").click();
    await page.getByTestId("assistant-typing-indicator").waitFor({ state: "detached", timeout: 180_000 }).catch(() => {});
    await waitForCleanSourceControl(page, { timeoutMs: 180_000 });
  });

  test("assistant-created file auto-syncs and clears Changes by default", async ({ page }) => {
    test.skip(
      (process.env.PLAYWRIGHT_SKIP_CODEX ?? "").trim() === "1",
      "Requires a live Codex backend to create the workspace file.",
    );
    if (!activeProjectId) {
      throw new Error("Active project id missing for assistant auto-sync test.");
    }

    const unique = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const filePath = `assistant-autosync-${unique}.txt`;
    const contents = `assistant autosync ${unique}`;

    await syncGitRemote(page, {
      projectId: activeProjectId,
      message: `playwright: ensure clean assistant-autosync ${unique}`,
    });

    await page.getByTestId("sidebar-nav-chat").click();
    await page
      .getByTestId("chat-input")
      .fill(`Create a new text file named "${filePath}" in the workspace that contains exactly "${contents}".`);
    await expect(page.getByTestId("chat-send-button")).toBeEnabled({ timeout: 120_000 });
    await page.getByTestId("chat-send-button").click();

    await expectAssistantReplyOrSkipRateLimit(page, /[\s\S]+/, { timeout: 240_000 });

    await expect
      .poll(
        async () =>
          (await readWorkspaceFileText(page, filePath, { projectId: activeProjectId }))?.trim(),
        { timeout: 120_000 }
      )
      .toBe(contents);

    await assertGitRemoteFileText(page, filePath, {
      projectId: activeProjectId,
      expectedText: contents,
      requireGitRemote: true,
      timeoutMs: 180_000,
    });

    await waitForCleanSourceControl(page, { timeoutMs: 120_000 });
  });

  test("shows dirty badge, lets you stage, and syncs selected changes", async ({ page }) => {
    if (!activeProjectId) {
      throw new Error("Active project id missing for source control UI test.");
    }

    const unique = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const fileA = `playwright/source-control-a-${unique}.txt`;
    const fileB = `playwright/source-control-b-${unique}.txt`;
    const contentsA = `hello A ${unique}`;
    const contentsB = `hello B ${unique}`;

    await syncGitRemote(page, { projectId: activeProjectId, message: `playwright: ensure clean ${unique}` });

    await writeWorkspaceFile(page, fileA, `${contentsA}\n`, { projectId: activeProjectId });
    await writeWorkspaceFile(page, fileB, `${contentsB}\n`, { projectId: activeProjectId });

    await expect(page.getByTestId("sidebar-nav-sourceControl-badge")).toHaveText("2", {
      timeout: 30_000,
    });

    await ensureSourceControlDrawerVisible(page);
    const changesList = page.getByTestId("source-control-changes");
    await expect(changesList).toBeVisible({ timeout: 30_000 });

    await expect(changesList).toContainText(fileA, { timeout: 30_000 });
    await expect(changesList).toContainText(fileB, { timeout: 30_000 });

    await changesList.getByRole("button", { name: fileA, exact: true }).click();
    const diffView = page.getByTestId("source-control-diff-view");
    const diffHeader = page.getByTestId("source-control-diff-header");
    await expect(diffHeader).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("source-control-diff-header-old")).toContainText(`a/${fileA}`);
    await expect(page.getByTestId("source-control-diff-header-new")).toContainText(`b/${fileA}`);
    await expect(diffView).toContainText(contentsA);

    await page.getByTestId("source-control-diff-open-file").focus();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("code-save-button")).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId("code-save-draft-button")).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId("workspace-tabs")).toContainText(fileA.split("/").pop() ?? fileA, { timeout: 60_000 });
    await expect(page.getByText(fileA, { exact: false })).toBeVisible({ timeout: 30_000 });

    const updatedContentsA = `${contentsA}\nupdated ${unique}\n`;
    const dismissToast = page
      .getByTestId("status-toast")
      .getByRole("button", { name: "Dismiss notification" })
      .first();
    if ((await dismissToast.count()) > 0) {
      await dismissToast.click().catch(() => {});
    }
    await writeWorkspaceFile(page, fileA, updatedContentsA, { projectId: activeProjectId });
    const committedFileAContents = await readWorkspaceFileText(page, fileA, { projectId: activeProjectId });
    expect(committedFileAContents).toContain(`updated ${unique}`);

    await ensureSourceControlDrawerVisible(page);
    await page.getByRole("checkbox", { name: fileB }).click();

    await page.getByTestId("source-control-sync").click();
    await expect(page.getByTestId("source-control-sync")).toBeEnabled({ timeout: 120_000 });

    await assertGitRemoteFileText(page, fileA, {
      projectId: activeProjectId,
      expectedText: committedFileAContents,
      requireGitRemote: true,
    });

    await expect(page.getByTestId("sidebar-nav-sourceControl-badge")).toHaveText("1", {
      timeout: 30_000,
    });

    await expect(changesList).toContainText(fileB, { timeout: 30_000 });

    await page
      .getByTestId("source-control-changes")
      .getByRole("button", { name: fileB, exact: true })
      .click();
    await expect(diffHeader).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("source-control-diff-header-old")).toContainText(`a/${fileB}`);
    await expect(page.getByTestId("source-control-diff-header-new")).toContainText(`b/${fileB}`);
    await expect(diffView).toContainText(contentsB);

    await ensureSourceControlDrawerVisible(page);

    const fileBCheckbox = page.getByRole("checkbox", { name: fileB });
    if (!(await fileBCheckbox.isChecked().catch(() => false))) {
      await fileBCheckbox.click();
    }
    await expect(fileBCheckbox).toBeChecked();
    const commitMessage = `playwright: save ${unique}`;
    await page.getByTestId("source-control-commit-message").fill(commitMessage);
    await page.getByTestId("source-control-sync").click();
    await expect(page.getByTestId("source-control-sync")).toBeEnabled({ timeout: 120_000 });

    await assertGitRemoteFileText(page, fileB, {
      projectId: activeProjectId,
      expectedText: contentsB,
      requireGitRemote: true,
    });

    await expect(page.getByTestId("sidebar-nav-sourceControl-badge")).toHaveCount(0, {
      timeout: 30_000,
    });
    const sourceControlDrawer = page.getByTestId("source-control-drawer");
    await expect(sourceControlDrawer).not.toContainText("Review the current working tree");
    await waitForSourceControlHistoryEntry(page, commitMessage, { timeoutMs: 30_000 });
    await expect(page.getByTestId("source-control-history-head-ref")).toContainText("main");
    const historyEntry = page.getByTestId("source-control-history-entry").first();
    await expect(historyEntry).toContainText(commitMessage);
    await historyEntry.getByTestId("source-control-history-toggle").click();
    await expect(historyEntry).toHaveAttribute("data-expanded", "true");

    const dirtyContents = `dirty A ${unique}`;
    await writeWorkspaceFile(page, fileA, `${dirtyContents}\n`, { projectId: activeProjectId });

    await expect(page.getByTestId("sidebar-nav-sourceControl-badge")).toHaveText("1", {
      timeout: 30_000,
    });

    if ((await sourceControlDrawer.count()) === 0) {
      await ensureSourceControlDrawerVisible(page);
    }
    await expect(sourceControlDrawer).toBeVisible();
    await expect(page.getByTestId("source-control-changes")).toContainText(fileA, { timeout: 30_000 });

    page.once("dialog", async (dialog) => {
      await dialog.accept();
    });
    await page.getByTestId("source-control-discard").click();

    await expect(page.getByTestId("sidebar-nav-sourceControl-badge")).toHaveCount(0, {
      timeout: 30_000,
    });

    const revertedText = await readWorkspaceFileText(page, fileA, { projectId: activeProjectId });
    expect(revertedText).toBe(committedFileAContents);
  });

  test("opens Changes review focused on the requested diff path", async ({ page }) => {
    if (!activeProjectId) {
      throw new Error("Active project id missing for source control review-open test.");
    }

    const unique = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const fileA = `playwright/review-open-a-${unique}.txt`;
    const fileB = `playwright/review-open-b-${unique}.txt`;

    await syncGitRemote(page, { projectId: activeProjectId, message: `playwright: ensure clean review-open ${unique}` });
    await writeWorkspaceFile(page, fileA, `review A ${unique}\n`, { projectId: activeProjectId });
    await writeWorkspaceFile(page, fileB, `review B ${unique}\n`, { projectId: activeProjectId });

    await expect(page.getByTestId("sidebar-nav-sourceControl-badge")).toHaveText("2", {
      timeout: 30_000,
    });

    await page.evaluate(
      ({ projectId, previewPath }) => {
        window.dispatchEvent(
          new CustomEvent("instafy:open-source-control", {
            detail: { projectId, previewPath },
          }),
        );
      },
      { projectId: activeProjectId, previewPath: fileB },
    );

    await expect(page.getByTestId("source-control-drawer")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("source-control-review-layout")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("source-control-diff-header-new")).toContainText(`b/${fileB}`, {
      timeout: 30_000,
    });
  });

  test("opens Changes review in rolling all-changes mode when requested", async ({ page }) => {
    if (!activeProjectId) {
      throw new Error("Active project id missing for source control rolling review-open test.");
    }

    const unique = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const fileA = `playwright/review-open-all-a-${unique}.txt`;
    const fileB = `playwright/review-open-all-b-${unique}.txt`;

    await syncGitRemote(page, { projectId: activeProjectId, message: `playwright: ensure clean review-open-all ${unique}` });
    await writeWorkspaceFile(page, fileA, `review all A ${unique}\n`, { projectId: activeProjectId });
    await writeWorkspaceFile(page, fileB, `review all B ${unique}\n`, { projectId: activeProjectId });

    await page.evaluate(
      ({ projectId, previewPath }) => {
        window.dispatchEvent(
          new CustomEvent("instafy:open-source-control", {
            detail: { projectId, previewPath, reviewMode: "all" },
          }),
        );
      },
      { projectId: activeProjectId, previewPath: fileB },
    );

    await expect(page.getByTestId("source-control-drawer")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("source-control-rolling-diff-view")).toBeVisible({ timeout: 30_000 });
    await expect(
      page.getByTestId(`source-control-rolling-diff-item-${sanitizeTestId(fileA)}`),
    ).toContainText(fileA, { timeout: 30_000 });
    await expect(
      page.getByTestId(`source-control-rolling-diff-item-${sanitizeTestId(fileB)}`),
    ).toContainText(fileB, { timeout: 30_000 });
  });

  test("opens a full-screen git review tab when requested", async ({ page }) => {
    if (!activeProjectId) {
      throw new Error("Active project id missing for full-screen review-open test.");
    }

    const unique = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const fileA = `playwright/review-tab-a-${unique}.txt`;
    const fileB = `playwright/review-tab-b-${unique}.txt`;

    await syncGitRemote(page, { projectId: activeProjectId, message: `playwright: ensure clean review-tab ${unique}` });
    await writeWorkspaceFile(page, fileA, `review tab A ${unique}\n`, { projectId: activeProjectId });
    await writeWorkspaceFile(page, fileB, `review tab B ${unique}\n`, { projectId: activeProjectId });

    await page.evaluate(
      ({ fileA: entryA, fileB: entryB }) => {
        window.dispatchEvent(
          new CustomEvent("instafy:open-git-review", {
            detail: {
              review: {
                kind: "workingTree",
                title: "Review changes",
                entries: [
                  { path: entryA, code: "??", embeddedRepoRoot: null },
                  { path: entryB, code: "??", embeddedRepoRoot: null },
                ],
                initialPath: entryB,
                initialMode: "all",
              },
            },
          }),
        );
      },
      { fileA, fileB },
    );

    await expect(page.getByTestId("git-review-view")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("git-review-rolling-diff")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("git-review-meta")).toContainText("2 files");
    await expect(page.getByTestId(`git-review-rolling-diff-item-${sanitizeTestId(fileA)}`)).toContainText(fileA, {
      timeout: 30_000,
    });
    await expect(page.getByTestId(`git-review-rolling-diff-item-${sanitizeTestId(fileB)}`)).toContainText(fileB, {
      timeout: 30_000,
    });
    await page.getByTestId(`git-review-rolling-diff-item-${sanitizeTestId(fileA)}-diff-toggle`).click();
    await expect(page.getByTestId(`git-review-rolling-diff-item-${sanitizeTestId(fileA)}`)).not.toContainText(
      `+review tab A ${unique}`,
      { timeout: 30_000 },
    );
    await page.getByTestId(`git-review-rolling-diff-item-${sanitizeTestId(fileA)}-diff-toggle`).click();
    await expect(page.getByTestId(`git-review-rolling-diff-item-${sanitizeTestId(fileA)}`)).toContainText(
      `+review tab A ${unique}`,
      { timeout: 30_000 },
    );

    await page.getByTestId("git-review-mode-focused").click();
    await expect(page.getByTestId("git-review-layout")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("git-review-diff-header-new")).toContainText(`b/${fileB}`, {
      timeout: 30_000,
    });
    await expect(page.getByTestId("git-review-diff-mode-split")).toBeVisible();
    await page.getByTestId("git-review-diff-mode-split").click();
    await expect(page.getByTestId("git-review-diff-split")).toBeVisible({ timeout: 30_000 });
    await page.getByTestId("git-review-mode-all").click();
    await expect(
      page.getByTestId(`git-review-rolling-diff-item-${sanitizeTestId(fileA)}-diff-split`),
    ).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("git-review-open-source-control")).toBeVisible();
  });

  test("opens a mobile quick-review sheet first and can expand into full review", async ({ page }) => {
    if (!activeProjectId) {
      throw new Error("Active project id missing for mobile quick-review test.");
    }

    await page.setViewportSize({ width: 390, height: 844 });

    const unique = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const fileA = `playwright/review-sheet-a-${unique}.txt`;
    const fileB = `playwright/review-sheet-b-${unique}.txt`;
    const previousUrl = page.url();

    await syncGitRemote(page, { projectId: activeProjectId, message: `playwright: ensure clean review-sheet ${unique}` });
    await writeWorkspaceFile(page, fileA, `review sheet A ${unique}\n`, { projectId: activeProjectId });
    await writeWorkspaceFile(page, fileB, `review sheet B ${unique}\n`, { projectId: activeProjectId });

    await page.evaluate(
      ({ entryA, entryB }) => {
        window.dispatchEvent(
          new CustomEvent("instafy:open-git-review", {
            detail: {
              review: {
                kind: "workingTree",
                title: "Review changes",
                entries: [
                  { path: entryA, code: "??", embeddedRepoRoot: null },
                  { path: entryB, code: "??", embeddedRepoRoot: null },
                ],
                initialPath: entryB,
                initialMode: "all",
              },
            },
          }),
        );
      },
      { entryA: fileA, entryB: fileB },
    );

    await expect(page.getByTestId("mobile-git-review-sheet-overlay")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("git-review-sheet")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("git-review-sheet-rolling-diff")).toContainText(fileA, { timeout: 30_000 });
    await expect(page.getByTestId("git-review-sheet-rolling-diff")).toContainText(fileB, { timeout: 30_000 });
    await expect(page.getByTestId("git-review-view")).toHaveCount(0);
    await expect(page).toHaveURL(previousUrl);

    await page.getByTestId("git-review-sheet-open-full").click();

    await expect(page.getByTestId("mobile-git-review-sheet-overlay")).toHaveCount(0);
    await expect(page.getByTestId("git-review-view")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("git-review-meta")).toContainText("2 files");
    await expect(page).toHaveURL(/reviewTab=workspace-git-review-/);

    await page.goBack();

    await expect(page.getByTestId("git-review-view")).toHaveCount(0);
    await expect(page.getByTestId("mobile-git-review-sheet-overlay")).toHaveCount(0);
    await expect(page.getByTestId("chat-input")).toBeVisible({ timeout: 30_000 });
    await expect(page).toHaveURL(previousUrl);
  });

  test("renders synthetic excluded-file review entries through the diff viewer", async ({ page }) => {
    const unique = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const filePath = `tmp/review-synthetic-${unique}.txt`;
    const previewLine = `synthetic preview ${unique}`;
    const syntheticDiff = [
      `diff --git a/${filePath} b/${filePath}`,
      "new file mode 100644",
      "--- /dev/null",
      `+++ b/${filePath}`,
      "@@ -0,0 +1,1 @@",
      `+${previewLine}`,
    ].join("\n");

    await page.evaluate(({ entryPath, diffText }) => {
      window.dispatchEvent(
        new CustomEvent("instafy:open-git-review", {
          detail: {
            review: {
              kind: "workingTree",
              title: "Review changes",
              entries: [
                {
                  path: entryPath,
                  code: "A",
                  embeddedRepoRoot: null,
                  diffPreview: diffText,
                  previewMode: "diff",
                  synthetic: true,
                },
              ],
              initialPath: entryPath,
              initialMode: "all",
            },
          },
        }),
      );
    }, { entryPath: filePath, diffText: syntheticDiff });

    await expect(page.getByTestId("git-review-view")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("git-review-rolling-diff")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId(`git-review-rolling-diff-item-${sanitizeTestId(filePath)}`)).toContainText(filePath, {
      timeout: 30_000,
    });
    await expect(page.getByTestId("git-review-view")).not.toContainText("Current file contents");
    await expect(page.getByTestId("git-review-view")).toContainText(previewLine);
    await expect(page.getByTestId("git-review-open-source-control")).toHaveCount(0);
  });

  test("browser back leaves full-screen review and returns to the previous tab", async ({ page }) => {
    if (!activeProjectId) {
      throw new Error("Active project id missing for review history test.");
    }

    const unique = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const filePath = `playwright/review-history-${unique}.txt`;

    await syncGitRemote(page, { projectId: activeProjectId, message: `playwright: ensure clean review-history ${unique}` });
    await writeWorkspaceFile(page, filePath, `review history ${unique}\n`, { projectId: activeProjectId });

    await expect(page.getByTestId("chat-input")).toBeVisible({ timeout: 30_000 });
    const previousUrl = page.url();

    await page.evaluate((entryPath) => {
      window.dispatchEvent(
        new CustomEvent("instafy:open-git-review", {
          detail: {
            review: {
              kind: "workingTree",
              title: "Review changes",
              entries: [{ path: entryPath, code: "??", embeddedRepoRoot: null }],
              initialPath: entryPath,
              initialMode: "all",
            },
          },
        }),
      );
    }, filePath);

    await expect(page.getByTestId("git-review-view")).toBeVisible({ timeout: 30_000 });
    await expect(page).toHaveURL(/reviewTab=workspace-git-review-/);

    await page.goBack();

    await expect(page.getByTestId("git-review-view")).toHaveCount(0);
    await expect(page.getByTestId("chat-input")).toBeVisible({ timeout: 30_000 });
    await expect(page).toHaveURL(previousUrl);
  });

  test("hard refresh preserves an open full-screen review tab", async ({ page }) => {
    if (!activeProjectId) {
      throw new Error("Active project id missing for review refresh restore test.");
    }

    const unique = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const filePath = `playwright/review-refresh-${unique}.txt`;
    const previousUrl = page.url();

    await syncGitRemote(page, { projectId: activeProjectId, message: `playwright: ensure clean review-refresh ${unique}` });
    await writeWorkspaceFile(page, filePath, `review refresh ${unique}\n`, { projectId: activeProjectId });

    await page.evaluate((entryPath) => {
      window.dispatchEvent(
        new CustomEvent("instafy:open-git-review", {
          detail: {
            review: {
              kind: "workingTree",
              title: "Review changes",
              entries: [{ path: entryPath, code: "??", embeddedRepoRoot: null }],
              initialPath: entryPath,
              initialMode: "all",
            },
          },
        }),
      );
    }, filePath);

    await expect(page.getByTestId("git-review-view")).toBeVisible({ timeout: 30_000 });
    await expect(page).toHaveURL(/reviewTab=workspace-git-review-/);

    await page.reload();

    await expect(page.getByTestId("git-review-view")).toBeVisible({ timeout: 30_000 });
    await expect(page).toHaveURL(/reviewTab=workspace-git-review-/);
    await expect(page.getByTestId("git-review-meta")).toContainText("1 file");
    await expect(page.getByTestId(`git-review-rolling-diff-item-${sanitizeTestId(filePath)}`)).toContainText(filePath, {
      timeout: 30_000,
    });

    await page.goBack();

    await expect(page.getByTestId("git-review-view")).toHaveCount(0);
    await expect(page.getByTestId("chat-input")).toBeVisible({ timeout: 30_000 });
    await expect(page).toHaveURL(previousUrl);
  });

  test("keeps review diff calm during transient busy refreshes and avoids duplicate file headings", async ({ page }) => {
    if (!activeProjectId) {
      throw new Error("Active project id missing for transient busy review test.");
    }

    const unique = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const filePath = `playwright/review-busy-${unique}.txt`;
    const diffText = `review busy ${unique}`;
    const busyMessage = "Workspace is busy applying/syncing changes. Try again in a moment.";
    let diffRequests = 0;

    await syncGitRemote(page, { projectId: activeProjectId, message: `playwright: ensure clean review-busy ${unique}` });
    await writeWorkspaceFile(page, filePath, `${diffText}\n`, { projectId: activeProjectId });

    await page.route("**/git/diff*", async (route) => {
      const url = new URL(route.request().url());
      if (url.searchParams.get("path") !== filePath) {
        await route.fallback();
        return;
      }
      diffRequests += 1;
      if (diffRequests === 1) {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            supported: true,
            diff: "",
            error: busyMessage,
            truncated: false,
          }),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          supported: true,
          diff: [
            `diff --git a/${filePath} b/${filePath}`,
            "new file mode 100644",
            "index 0000000..1111111",
            "--- /dev/null",
            `+++ b/${filePath}`,
            "@@ -0,0 +1 @@",
            `+${diffText}`,
          ].join("\n"),
          error: null,
          truncated: false,
        }),
      });
    });

    await page.evaluate((entryPath) => {
      window.dispatchEvent(
        new CustomEvent("instafy:open-git-review", {
          detail: {
            review: {
              kind: "workingTree",
              title: "Review changes",
              entries: [{ path: entryPath, code: "??", embeddedRepoRoot: null }],
              initialPath: entryPath,
              initialMode: "focused",
            },
          },
        }),
      );
    }, filePath);

    await expect(page.getByText(busyMessage)).toHaveCount(0);
    await expect(page.getByTestId("git-review-diff")).toContainText(diffText, { timeout: 30_000 });
    await expect(page.getByTestId("git-review-diff").getByText(filePath, { exact: true })).toHaveCount(1);
  });

  test("opens saved versions in the full-screen review tab", async ({ page }) => {
    if (!activeProjectId) {
      throw new Error("Active project id missing for saved version review test.");
    }

    const unique = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const filePath = `playwright/history-review-${unique}.txt`;
    const contents = `history review ${unique}`;
    const commitMessage = `playwright: review saved version ${unique}`;

    await syncGitRemote(page, {
      projectId: activeProjectId,
      message: `playwright: ensure clean history-review ${unique}`,
    });
    await writeWorkspaceFile(page, filePath, `${contents}\n`, { projectId: activeProjectId });
    await syncGitRemote(page, { projectId: activeProjectId, message: commitMessage });

    const history = await waitForSourceControlHistoryEntry(page, commitMessage, {
      timeoutMs: 30_000,
    });

    const historyEntry = history.getByTestId("source-control-history-entry").filter({ hasText: commitMessage }).first();
    await historyEntry.getByTestId("source-control-history-review").click();

    await expect(page.getByTestId("git-review-view")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("git-review-title")).toContainText(commitMessage, { timeout: 30_000 });
    await expect(page.getByTestId("git-review-rolling-diff")).toBeVisible({ timeout: 30_000 });
    await expect(
      page.getByTestId(`git-review-rolling-diff-item-${sanitizeTestId(filePath)}`),
    ).toContainText(filePath, { timeout: 30_000 });
    await expect(page.getByTestId("git-review-rolling-diff")).toContainText(contents);

    await page.getByTestId("git-review-mode-focused").click();
    await expect(page.getByTestId("git-review-files")).toContainText(filePath, { timeout: 30_000 });
    await expect(page.getByTestId("git-review-diff-header-new")).toContainText(`b/${filePath}`, {
      timeout: 30_000,
    });
    await expect(page.getByTestId("git-review-diff")).toContainText(contents);
    await page.getByTestId("git-review-diff-mode-split").click();
    await expect(page.getByTestId("git-review-diff-split")).toBeVisible({ timeout: 30_000 });
  });

  test("preserves current changes and saved versions while the workspace is transiently busy", async ({ page }) => {
    if (!activeProjectId) {
      throw new Error("Active project id missing for source control busy-state test.");
    }

    const unique = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const filePath = `playwright/source-control-busy-${unique}.txt`;
    const committedText = `committed ${unique}`;
    const dirtyText = `dirty ${unique}`;
    const commitMessage = `playwright: busy baseline ${unique}`;
    const busyMessage = "Workspace is busy applying/syncing changes. Try Refresh in a moment.";

    await syncGitRemote(page, { projectId: activeProjectId, message: `playwright: ensure clean busy ${unique}` });
    await writeWorkspaceFile(page, filePath, `${committedText}\n`, { projectId: activeProjectId });
    await syncGitRemote(page, { projectId: activeProjectId, message: commitMessage });
    await writeWorkspaceFile(page, filePath, `${dirtyText}\n`, { projectId: activeProjectId });

    await ensureSourceControlDrawerVisible(page);
    await expect(page.getByTestId("source-control-changes")).toContainText(filePath, { timeout: 30_000 });
    await waitForSourceControlHistoryEntry(page, commitMessage, { timeoutMs: 30_000 });

    await page.route("**/git/status*", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          supported: true,
          dirty_count: 0,
          dirty_paths: [],
          error: busyMessage,
        }),
      });
    });
    await page.route("**/git/history*", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          supported: true,
          entries: [],
          error: busyMessage,
        }),
      });
    });

    await page.getByTestId("source-control-refresh").click();

    await expect(page.getByTestId("source-control-busy-indicator")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(busyMessage)).toHaveCount(0);
    await expect(page.getByTestId("source-control-changes")).toContainText(filePath, { timeout: 30_000 });
    await expect(page.getByTestId("source-control-history")).toContainText(commitMessage, { timeout: 30_000 });
    await expect(page.getByText("No saved versions yet.")).toHaveCount(0);
    await expect(page.getByTestId("source-control-sync")).toBeDisabled();
  });

  test("renders large change sets consistently without falling into an empty state", async ({ page }) => {
    if (!activeProjectId) {
      throw new Error("Active project id missing for large source control test.");
    }

    const unique = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const { badgeRenderMs, drawerRenderMs, diffRenderMs } = await measureLargeChangeSetRendering(page, {
      projectId: activeProjectId,
      unique,
      fileCount: 220,
      badgeTimeoutMs: 30_000,
      requireBadge: true,
      maxDrawerRenderMs: 20_000,
      maxDiffRenderMs: 10_000,
    });
    test.info().annotations.push({
      type: "timing",
      description: `220 dirty files -> badge ${badgeRenderMs ?? -1}ms, drawer ${drawerRenderMs}ms, diff ${diffRenderMs}ms`,
    });
    console.log(
      `[source-control-stress] 220 dirty files -> badge=${badgeRenderMs ?? "n/a"}ms drawer=${drawerRenderMs}ms diff=${diffRenderMs}ms`
    );
  });

  test("keeps one-thousand-plus meaningful file changes usable and renders a diff in time", async ({ page }) => {
    test.slow();
    test.setTimeout(420_000);

    if (!activeProjectId) {
      throw new Error("Active project id missing for large source control stress test.");
    }

    const unique = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const { badgeRenderMs, drawerRenderMs, diffRenderMs } = await measureLargeChangeSetRendering(page, {
      projectId: activeProjectId,
      unique,
      fileCount: 1_000,
      badgeTimeoutMs: 60_000,
      requireBadge: false,
      maxDrawerRenderMs: 90_000,
      maxDiffRenderMs: 20_000,
    });

    test.info().annotations.push({
      type: "timing",
      description: `1000 dirty files -> badge ${badgeRenderMs ?? -1}ms, drawer ${drawerRenderMs}ms, diff ${diffRenderMs}ms`,
    });
    console.log(
      `[source-control-stress] 1000 dirty files -> badge=${badgeRenderMs ?? "n/a"}ms drawer=${drawerRenderMs}ms diff=${diffRenderMs}ms`
    );
  });

  test("keeps diff review inside Changes on desktop", async ({ page }) => {
    if (!activeProjectId) {
      throw new Error("Active project id missing for desktop review test.");
    }

    const unique = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const fileA = `playwright/review-desktop-a-${unique}.txt`;
    const fileB = `playwright/review-desktop-b-${unique}.txt`;

    await syncGitRemote(page, { projectId: activeProjectId, message: `playwright: ensure clean review-desktop ${unique}` });
    await writeWorkspaceFile(page, fileA, `desktop A ${unique}\n`, { projectId: activeProjectId });
    await writeWorkspaceFile(page, fileB, `desktop B ${unique}\n`, { projectId: activeProjectId });

    await ensureSourceControlDrawerVisible(page);
    await expect(page.getByTestId("source-control-review-layout")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("source-control-diff-preview")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("source-control-diff-header-new")).toContainText(`b/${fileA}`, { timeout: 30_000 });

    await page.getByTestId("source-control-changes").getByRole("button", { name: fileB, exact: true }).click();
    await expect(page.getByTestId("source-control-diff-header-new")).toContainText(`b/${fileB}`, { timeout: 30_000 });
    await expect(page).toHaveURL(/workspaceTab=sourceControl/);
  });

  test("uses a bottom-sheet diff preview on mobile with next and previous navigation", async ({ page }) => {
    if (!activeProjectId) {
      throw new Error("Active project id missing for mobile review test.");
    }

    await page.setViewportSize({ width: 390, height: 844 });

    const unique = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const fileA = `playwright/review-mobile-a-${unique}.txt`;
    const fileB = `playwright/review-mobile-b-${unique}.txt`;

    await syncGitRemote(page, { projectId: activeProjectId, message: `playwright: ensure clean review-mobile ${unique}` });
    await writeWorkspaceFile(page, fileA, `mobile A ${unique}\n`, { projectId: activeProjectId });
    await writeWorkspaceFile(page, fileB, `mobile B ${unique}\n`, { projectId: activeProjectId });

    await page.getByTestId("topbar-sidebar-toggle").click();
    await ensureSourceControlDrawerVisible(page);
    await expect(page.getByTestId("source-control-diff-sheet")).toHaveCount(0);

    await page.getByTestId("source-control-changes").getByRole("button", { name: fileA, exact: true }).click();
    await expect(page.getByTestId("source-control-diff-sheet")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("source-control-diff-header-new")).toContainText(`b/${fileA}`, { timeout: 30_000 });

    await page.getByTestId("source-control-diff-next").click({ force: true });
    await expect(page.getByTestId("source-control-diff-header-new")).toContainText(`b/${fileB}`, { timeout: 30_000 });

    await page.getByTestId("source-control-diff-prev").click({ force: true });
    await expect(page.getByTestId("source-control-diff-header-new")).toContainText(`b/${fileA}`, { timeout: 30_000 });

    await page.getByTestId("source-control-diff-close").click();
    await expect(page.getByTestId("source-control-diff-sheet")).toHaveCount(0);
    await expect(page).toHaveURL(/workspaceTab=sourceControl/);
  });

  test("uses a bottom-sheet rolling diff review on mobile", async ({ page }) => {
    if (!activeProjectId) {
      throw new Error("Active project id missing for mobile rolling review test.");
    }

    await page.setViewportSize({ width: 390, height: 844 });

    const unique = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const fileA = `playwright/review-mobile-all-a-${unique}.txt`;
    const fileB = `playwright/review-mobile-all-b-${unique}.txt`;

    await syncGitRemote(page, { projectId: activeProjectId, message: `playwright: ensure clean review-mobile-all ${unique}` });
    await writeWorkspaceFile(page, fileA, `mobile all A ${unique}\n`, { projectId: activeProjectId });
    await writeWorkspaceFile(page, fileB, `mobile all B ${unique}\n`, { projectId: activeProjectId });

    await page.getByTestId("topbar-sidebar-toggle").click();
    await ensureSourceControlDrawerVisible(page);

    await page.getByTestId("source-control-review-mode-all").click();
    await expect(page.getByTestId("source-control-rolling-diff-sheet")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("source-control-rolling-diff-sheet-panel")).toContainText(fileA, { timeout: 30_000 });
    await expect(page.getByTestId("source-control-rolling-diff-sheet-panel")).toContainText(fileB, { timeout: 30_000 });

    await page.getByTestId("source-control-rolling-diff-close").click();
    await expect(page.getByTestId("source-control-rolling-diff-sheet")).toHaveCount(0);
  });

  test("rebases dirty text edits onto the latest remote tip when saving a version", async ({ page }) => {
    if (!activeProjectId) {
      throw new Error("Active project id missing for source control conflict UI test.");
    }

    const unique = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const filePath = `playwright/source-control-conflict-${unique}.txt`;
    const baseText = `base-${unique}`;
    const remoteText = `remote-${unique}`;
    const localText = `local-${unique}`;

    await syncGitRemote(page, { projectId: activeProjectId, message: `playwright: ensure clean ${unique}` });
    await writeWorkspaceFile(page, filePath, `${baseText}\n`, { projectId: activeProjectId });
    await syncGitRemote(page, { projectId: activeProjectId, message: `playwright: seed base ${filePath}` });

    await pushGitRemoteFileText(page, filePath, `${remoteText}\n`, {
      projectId: activeProjectId,
      message: `playwright: remote advance ${filePath}`,
      requireGitRemote: true,
    });

    await writeWorkspaceFile(page, filePath, `${localText}\n`, { projectId: activeProjectId });

    await ensureSourceControlDrawerVisible(page);
    await expect(page.getByTestId("source-control-changes")).toContainText(filePath);

    await page.getByTestId("source-control-sync").click();
    await waitForCleanSourceControl(page, { timeoutMs: 120_000 });
    await expect(page.getByTestId("source-control-conflict")).toHaveCount(0);

    await assertGitRemoteFileText(page, filePath, {
      projectId: activeProjectId,
      expectedText: localText,
      requireGitRemote: true,
    });
    const localAfter = await readWorkspaceFileText(page, filePath, { projectId: activeProjectId });
    expect(localAfter?.trim()).toBe(localText);
  });
});
