import { test, expect, type Page } from "@playwright/test";
import {
  ensureWorkspacePathsAbsent,
  readWorkspaceFileText,
  prepareStudio,
  clearRuntimePreference,
  requestHostedRuntime,
  waitForHostedRuntimeReady,
  writeWorkspaceFile,
  resetRuntimeUserState
} from "../utils/harness.js";

test.describe.serial("File explorer focus", () => {
  // Needs a longer timeout because we ensure a hosted runtime in beforeEach.
  test.describe.configure({ timeout: 180_000 });
  test.skip(
    (process.env.PLAYWRIGHT_SKIP_CODEX ?? "").trim() === "1",
    "Codex backend unavailable (rate limited). Provide Codex auth (OPENAI_API_KEY or tmp/proxy-codex/auth.json)."
  );
  let activeProjectId: string | null = null;

  async function ensureHostedRuntimeReady(page: Page, projectId: string) {
    const ready = await waitForHostedRuntimeReady(page, 10_000).then(() => true).catch(() => false);
    if (!ready) {
      await requestHostedRuntime(page, { projectId }).catch(() => {});
    }
    await waitForHostedRuntimeReady(page, 120_000);
  }

  async function ensureExplorerSearchInput(page: Page) {
    const input = page.getByTestId("code-search-input");
    const visible = await input.isVisible().catch(() => false);
    if (!visible) {
      const toggle = page.getByTestId("files-explorer-search-toggle");
      if (await toggle.isVisible().catch(() => false)) {
        await toggle.click();
      }
    }
    await input.waitFor();
    return input;
  }

  test.beforeEach(async ({ page }) => {
    activeProjectId = await prepareStudio(page);
    await clearRuntimePreference(page, { projectId: activeProjectId, source: "file-explorer-focus" }).catch(() => {});
    if (activeProjectId) {
      await ensureHostedRuntimeReady(page, activeProjectId);
    }
    await ensureWorkspacePathsAbsent(page, ["guides/getting-started.md"], {
      projectId: activeProjectId
    }).catch(() => {});
  });

  test.afterEach(async ({ page }) => {
    await resetRuntimeUserState(page, { source: "file-explorer-focus:cleanup" }).catch(() => {});
  });

  test("keeps file visible after open", async ({ page }) => {
    test.setTimeout(120_000);
    page.setDefaultTimeout(60_000);

    const targetPath = "guides/getting-started.md";
    if (!activeProjectId) {
      throw new Error("Active project id missing for file-explorer-focus.");
    }
    await writeWorkspaceFile(page, targetPath, "start here\n", {
      createDirectories: true,
      projectId: activeProjectId,
    });

    await expect
      .poll(
        async () =>
          (await readWorkspaceFileText(page, targetPath))?.trim(),
        {
          timeout: 120_000
        }
      )
      .toBe("start here");

    // The sidebar code button only toggles the explorer drawer; the files
    // workspace (viewer + external open-event listener) mounts for a file tab
    // or the code panel tab, which the router opens from ?panel=code.
    await page.goto(`/studio?projectId=${encodeURIComponent(activeProjectId)}&panel=code`, {
      waitUntil: "domcontentloaded",
    });
    const retryButton = page.getByRole("button", { name: "Retry" }).first();
    for (let attempt = 0; attempt < 3; attempt++) {
      const visible = await retryButton.isVisible().catch(() => false);
      if (!visible) {
        break;
      }
      await retryButton.click();
      await page.waitForTimeout(1_000);
    }
    const storeProjectId = await page.evaluate(
      () => window["__INSTAFY_STORE__"]?.getState().activeProjectId ?? null
    );
    await page.evaluate((pid) => {
      window.dispatchEvent(
        new CustomEvent("instafy:workspace-commit", {
          detail: { projectId: pid }
        })
      );
    }, storeProjectId);

    // Explorer search only walks loaded directories, so surface guides/ first.
    const guidesFolder = page.getByTestId("files-entry-guides");
    await expect(guidesFolder).toBeVisible({ timeout: 45_000 });
    await guidesFolder.click();
    await expect(page.getByTestId("files-entry-guides-getting-started-md")).toBeVisible({
      timeout: 20_000,
    });

    const searchInput = await ensureExplorerSearchInput(page);
    await searchInput.fill("getting-started.md");
    const searchResult = page
      .getByRole("button", { name: /getting-started\.md/ })
      .first();
    await expect(searchResult).toBeVisible({ timeout: 45_000 });
    await searchResult.click();

    await searchInput.fill("");
    await page.evaluate((pid) => {
      // Mirror the app's own open handoff (see ChatMessageContent
      // handleWorkspaceFileClick): the pending global lets the workspace
      // FilesPanel process the request even when it mounts after dispatch —
      // a bare event is lost while only the portal explorer is rendered.
      const detail = {
        projectId: pid,
        path: "guides/getting-started.md"
      };
      const runtimeWindow = window as typeof window & {
        __INSTAFY_PENDING_OPEN_WORKSPACE_FILE__?: typeof detail | null;
      };
      runtimeWindow.__INSTAFY_PENDING_OPEN_WORKSPACE_FILE__ = detail;
      window.dispatchEvent(
        new CustomEvent("instafy:open-workspace-file", { detail })
      );
    }, activeProjectId);
    const editorHeading = page.getByRole("heading", { name: "getting-started.md" });
    await expect(editorHeading).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText("guides/getting-started.md")).toBeVisible({ timeout: 10_000 });
  });

  test("expands markdown sections and jumps to the selected heading", async ({ page }) => {
    test.setTimeout(120_000);
    page.setDefaultTimeout(60_000);

    const targetPath = "guides/getting-started.md";
    if (!activeProjectId) {
      throw new Error("Active project id missing for file-explorer-focus.");
    }

    await writeWorkspaceFile(
      page,
      targetPath,
      [
        "# Getting started",
        "",
        "## Install",
        "",
        "Install steps",
        "",
        "## Usage",
        "",
        "Usage details",
      ].join("\n"),
      {
        createDirectories: true,
        projectId: activeProjectId,
      }
    );

    await expect
      .poll(async () => (await readWorkspaceFileText(page, targetPath))?.includes("## Usage") ?? false, {
        timeout: 120_000
      })
      .toBe(true);

    // See the first test: the files workspace mounts from ?panel=code, not
    // from the sidebar drawer toggle.
    await page.goto(`/studio?projectId=${encodeURIComponent(activeProjectId)}&panel=code`, {
      waitUntil: "domcontentloaded",
    });
    const retryButton = page.getByRole("button", { name: "Retry" }).first();
    for (let attempt = 0; attempt < 3; attempt++) {
      const visible = await retryButton.isVisible().catch(() => false);
      if (!visible) {
        break;
      }
      await retryButton.click();
      await page.waitForTimeout(1_000);
    }

    const storeProjectId = await page.evaluate(
      () => window["__INSTAFY_STORE__"]?.getState().activeProjectId ?? null
    );
    await page.evaluate((pid) => {
      window.dispatchEvent(
        new CustomEvent("instafy:workspace-commit", {
          detail: { projectId: pid }
        })
      );
    }, storeProjectId);

    const guidesFolder = page.getByTestId("files-entry-guides");
    await expect(guidesFolder).toBeVisible({ timeout: 45_000 });
    await guidesFolder.click();

    const fileEntry = page.getByTestId("files-entry-guides-getting-started-md");
    await expect(fileEntry).toBeVisible({ timeout: 20_000 });
    await fileEntry.click();
    await expect(page.getByRole("heading", { name: "getting-started.md" })).toBeVisible({ timeout: 10_000 });

    const outlineToggle = page.getByTestId("files-outline-toggle-guides-getting-started-md");
    await expect(outlineToggle).toBeVisible({ timeout: 20_000 });
    await outlineToggle.click();

    const usageHeading = page.getByTestId("files-markdown-heading-guides-getting-started-md-usage");
    await expect(usageHeading).toBeVisible({ timeout: 20_000 });
    await usageHeading.click();

    await expect(page.getByRole("heading", { name: "getting-started.md" })).toBeVisible({ timeout: 10_000 });

    await expect
      .poll(async () => {
        return await page.evaluate(() => {
          const registry = (window as typeof window & {
            __STUDIO_MONACO__?: Map<string, { editor?: { getSelection?: () => { startLineNumber?: number } | null } }>
          }).__STUDIO_MONACO__;
          const selection = registry?.get("guides/getting-started.md")?.editor?.getSelection?.() ?? null;
          return selection?.startLineNumber ?? null;
        });
      })
      .toBe(7);
  });
});
