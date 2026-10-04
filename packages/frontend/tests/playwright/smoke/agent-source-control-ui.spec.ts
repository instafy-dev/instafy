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

// Which gateway the stack runs, as the person running the suite declares it:
// "legacy" (stateful) or "stateless". Unset means either; the stateless case
// then does not run. A declared mode the stack does not match fails the
// mode-specific assertions instead of skipping them.
function declaredGatewayMode(): "legacy" | "stateless" | null {
  const mode = (process.env.PLAYWRIGHT_GATEWAY_MODE ?? "").trim();
  return mode === "legacy" || mode === "stateless" ? mode : null;
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
  });

  test.afterEach(async ({ page }) => {
    await resetRuntimeUserState(page, { source: "agent-source-control-ui:cleanup" }).catch(() => {});
  });

  test("agent's file change reaches the saved history without a manual save", async ({ page }) => {
    if (!activeProjectId) {
      throw new Error("Active project id missing in agent source control UI test.");
    }

    const unique = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const filePath = `playwright/agent-saved-${unique}.md`;
    const contents = `hello saved ${unique}`;

    await syncGitRemote(page, { projectId: activeProjectId, message: `playwright: ensure clean ${unique}` });

    // Every turn saves: there is no auto-save choice left to turn off.
    await sendChatAndWait(
      page,
      [
        `Create a new file named \`${filePath}\` that contains EXACTLY this single line (no extra text):`,
        contents,
        "",
        "Reply with EXACTLY: READY.",
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

    await assertGitRemoteFileText(page, filePath, {
      projectId: activeProjectId,
      expectedText: contents,
      requireGitRemote: true,
    });

    const card = page.getByTestId("chat-file-change-summary").last();
    // Chip labels are middle-truncated past 28 characters, and this name is
    // longer: the full path is the chip's title.
    await expect(card.locator(`[data-testid="chat-file-change-file-chip"][title="${filePath}"]`)).toBeVisible();
    if (declaredGatewayMode() === "legacy") {
      // The stateful gateway keeps today's card: no saved-version revert.
      await expect(card.getByTestId("chat-file-change-revert")).toHaveCount(0);
    }
  });

  test("stateless gateway: the chat card reverts the agent's change as a new version", async ({ page }) => {
    test.skip(
      declaredGatewayMode() !== "stateless",
      "Run against a stateless gateway with PLAYWRIGHT_GATEWAY_MODE=stateless."
    );
    if (!activeProjectId) {
      throw new Error("Active project id missing in agent source control UI test.");
    }

    const unique = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const filePath = `playwright/agent-revert-${unique}.md`;
    const seedText = `seed before agent ${unique}`;
    const contents = `edited by agent ${unique}`;

    await writeWorkspaceFile(page, filePath, `${seedText}\n`, { projectId: activeProjectId });
    await syncGitRemote(page, { projectId: activeProjectId, message: `playwright: seed ${unique}` });
    await assertGitRemoteFileText(page, filePath, {
      projectId: activeProjectId,
      expectedText: seedText,
      requireGitRemote: true,
    });

    await sendChatAndWait(
      page,
      [
        `Replace the whole contents of \`${filePath}\` with EXACTLY this single line (no extra text):`,
        contents,
        "",
        "Reply with EXACTLY: DONE.",
      ].join("\n"),
      { timeoutMs: 240_000 }
    );
    await assertGitRemoteFileText(page, filePath, {
      projectId: activeProjectId,
      expectedText: contents,
      requireGitRemote: true,
    });

    const card = page.getByTestId("chat-file-change-summary").last();
    const revert = card.getByTestId("chat-file-change-revert");
    // A stack that is not stateless shows no Revert, so this fails rather than skips.
    await expect(revert).toBeVisible({ timeout: 60_000 });
    await expect(revert).toHaveText("Revert this change");
    await expect(card.getByTestId("chat-file-change-undo")).toBeVisible();

    await revert.click();
    await expect(page.getByTestId("chat-file-change-revert-dialog")).toContainText("Revert this change?");
    await page.getByTestId("chat-file-change-revert-confirm").click();
    await expect(page.getByText("Reverted. Saved as a new version.")).toBeVisible({ timeout: 60_000 });

    await assertGitRemoteFileText(page, filePath, {
      projectId: activeProjectId,
      expectedText: seedText,
      requireGitRemote: true,
    });
    await expect(card.getByTestId("chat-file-change-revert")).toHaveCount(0);
  });
});
