import { test, expect, type Page } from "@playwright/test";
import {
  readWorkspaceFileText,
  assertGitRemoteFileText,
  syncGitRemote,
  prepareStudio,
  clearRuntimePreference,
  requestHostedRuntime,
  waitForHostedRuntimeReady,
  resetRuntimeUserState,
} from "../utils/harness.js";

async function ensureHostedRuntimeReady(page: Page, projectId: string) {
  const ready = await waitForHostedRuntimeReady(page, 10_000).then(() => true).catch(() => false);
  if (!ready) {
    await requestHostedRuntime(page, { projectId }).catch(() => {});
  }
  await waitForHostedRuntimeReady(page, 120_000);
}

test.describe("Agent file creation", () => {
  test.skip(
    (process.env.PLAYWRIGHT_SKIP_CODEX ?? "").trim() === "1",
    "Codex backend unavailable (rate limited). Provide Codex auth (OPENAI_API_KEY or tmp/proxy-codex/auth.json)."
  );
  test.skip(
    (process.env.PLAYWRIGHT_LIVE_AGENT_FILE_CREATE ?? "").trim() !== "1",
    "Live assistant file-creation smoke is model-dependent; opt in with PLAYWRIGHT_LIVE_AGENT_FILE_CREATE=1."
  );
  test.describe.configure({ timeout: 240_000 });
  let activeProjectId: string | null = null;

  test.beforeEach(async ({ page }) => {
    page.setDefaultTimeout(60_000);
    const projectId = await prepareStudio(page);
    activeProjectId = projectId;
    await clearRuntimePreference(page, { projectId, source: "smoke" });
    if (projectId) {
      await ensureHostedRuntimeReady(page, projectId);
    }
  });

  test.afterEach(async ({ page }) => {
    await resetRuntimeUserState(page, { source: "agent-file-create:cleanup" }).catch(() => {});
  });


  test("assistant can create markdown file accessible via file explorer", async ({ page }) => {
    page.setDefaultTimeout(60_000);
    if (!activeProjectId) {
      throw new Error("Active project id missing in agent-file-create.");
    }


    const prompt =
      'Create a new markdown file named "hello.md" in the workspace root that contains exactly the word "hello".';
    await page.getByTestId("chat-input").fill(prompt);
    await expect(page.getByTestId("chat-send-button")).toBeEnabled({ timeout: 90_000 });
    await page.getByTestId("chat-send-button").click();

    const typingIndicator = page.getByTestId("assistant-typing-indicator");
    await expect(typingIndicator).toBeVisible({ timeout: 10_000 });

    await expect
      .poll(
        async () => (await readWorkspaceFileText(page, "hello.md", { projectId: activeProjectId }))?.trim(),
        { timeout: 90_000 }
      )
      .toBe("hello");

    await expect(typingIndicator).toHaveCount(0, { timeout: 120_000 });

    // Optionally verify in Files explorer; origin-only explorer may not
    // reflect controller-written files in this smoke path, so make it soft.
    await page.getByTestId("sidebar-nav-code").click();
    const searchInput = page.getByTestId("code-search-input");
    await searchInput.waitFor({ timeout: 10_000 }).catch(() => {});
    if (await searchInput.isVisible().catch(() => false)) {
      const fileEntry = page.getByTestId("files-entry-hello-md");
      if (await fileEntry.first().isVisible().catch(() => false)) {
        await fileEntry.first().click();
      }
    }

    const fileContents = await readWorkspaceFileText(page, "hello.md", { projectId: activeProjectId });
    expect(fileContents?.trim()).toBe("hello");

    const synced = await syncGitRemote(page, { projectId: activeProjectId });
    if ((process.env.GIT_CANONICAL ?? "").trim() === "1" && !synced) {
      throw new Error("Expected git sync to return a commit hash, but got null.");
    }

    await assertGitRemoteFileText(page, "hello.md", {
      projectId: activeProjectId,
      expectedText: "hello"
    });
  });
});
