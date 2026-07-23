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
} from "../utils/harness.js";

async function ensureHostedRuntimeReady(page: Page, projectId: string) {
  const ready = await waitForHostedRuntimeReady(page, 10_000).then(() => true).catch(() => false);
  if (!ready) {
    await requestHostedRuntime(page, { projectId }).catch(() => {});
  }
  await waitForHostedRuntimeReady(page, 120_000);
}

async function setAssistantAutoSync(page: Page, enabled: boolean) {
  await page.evaluate((value) => {
    window.localStorage.setItem("instafy.git.autoSyncAfterApply", value ? "1" : "0");
  }, enabled);
}

async function sendChatAndWait(page: Page, message: string, options?: { timeoutMs?: number }) {
  const assistantResponses = page.locator('[data-testid="chat-bubble-assistant"]');
  const beforeCount = await assistantResponses.count();

  await page.getByTestId("chat-input").fill(message);
  await expect(page.getByTestId("chat-send-button")).toBeEnabled({ timeout: 120_000 });
  await page.getByTestId("chat-send-button").click();

  const timeoutMs = options?.timeoutMs ?? 180_000;
  await assistantResponses.nth(beforeCount).waitFor({ timeout: timeoutMs });
  const text = (await assistantResponses.last().innerText()).trim();

  const typingIndicator = page.getByTestId("assistant-typing-indicator");
  await typingIndicator.waitFor({ state: "detached", timeout: timeoutMs }).catch(() => {});

  return text;
}

test.describe("Agent + Source Control UI (opt-in)", () => {
  test.skip(
    (process.env.GIT_CANONICAL ?? "").trim() !== "1",
    "Requires git-canonical stack (start with GIT_CANONICAL=1)."
  );
  test.skip(
    (process.env.PLAYWRIGHT_SKIP_CODEX ?? "").trim() === "1",
    "Codex backend unavailable (rate limited). Provide Codex auth (OPENAI_API_KEY or tmp/proxy-codex/auth.json)."
  );
  test.skip(
    (process.env.PLAYWRIGHT_AGENT_SOURCE_CONTROL ?? "").trim() !== "1",
    "Enable with PLAYWRIGHT_AGENT_SOURCE_CONTROL=1 (agent compliance can be flaky)."
  );

  test.describe.configure({ timeout: 360_000 });
  let activeProjectId: string | null = null;

  test.beforeEach(async ({ page }) => {
    page.setDefaultTimeout(60_000);
    const projectId = await prepareStudio(page);
    activeProjectId = projectId;
    await clearRuntimePreference(page, { projectId, source: "agent-source-control-ui" });
    if (projectId) {
      await ensureHostedRuntimeReady(page, projectId);
    }
    await setAssistantAutoSync(page, false);
  });

  test.afterEach(async ({ page }) => {
    await resetRuntimeUserState(page, { source: "agent-source-control-ui:cleanup" }).catch(() => {});
  });

  test("agent creates file without syncing; user syncs via UI", async ({ page }) => {
    if (!activeProjectId) {
      throw new Error("Active project id missing in agent source control UI test.");
    }

    const unique = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const filePath = `playwright/agent-nosync-${unique}.md`;
    const contents = `hello nosync ${unique}`;

    await syncGitRemote(page, { projectId: activeProjectId, message: `playwright: ensure clean ${unique}` });

    await sendChatAndWait(
      page,
      [
        `Create a new file named \`${filePath}\` that contains EXACTLY this single line (no extra text):`,
        contents,
        "",
        "IMPORTANT: Do NOT run any git commands and do NOT sync/push anything yet.",
        "Reply with EXACTLY: READY (NO SYNC).",
      ].join("\n"),
      { timeoutMs: 240_000 }
    );

    await expect
      .poll(
        async () =>
          (await readWorkspaceFileText(page, filePath, { projectId: activeProjectId }))?.trim(),
        { timeout: 120_000 }
      )
      .toBe(contents);

    await expect(page.getByTestId("sidebar-nav-sourceControl-badge")).toBeVisible({
      timeout: 30_000,
    });

    await page.getByTestId("sidebar-nav-sourceControl").click();
    await expect(page.getByTestId("source-control-drawer")).toBeVisible();
    await expect(page.getByTestId("source-control-changes")).toContainText(filePath);

    await page.getByTestId("source-control-sync").click();
    await expect(page.getByTestId("source-control-sync")).toBeEnabled({ timeout: 120_000 });

    await assertGitRemoteFileText(page, filePath, {
      projectId: activeProjectId,
      expectedText: contents,
      requireGitRemote: true,
    });

    await expect(page.getByTestId("sidebar-nav-sourceControl-badge")).toHaveCount(0, {
      timeout: 30_000,
    });
  });
});
