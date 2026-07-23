import { test, expect } from "@playwright/test";
import {
  clearRuntimePreference,
  deleteDisposableTestUser,
  ensureRealDefaultCodexCredentialWhenRequired,
  expectAssistantReplyOrSkipRateLimit,
  getActiveOrgName,
  loginAsGuest,
  prepareStudio,
  requestHostedRuntime,
  purgeRealUserCredential,
  waitForHostedRuntimeReady,
  resetRuntimeUserState,
  selectPrimaryAgentModel,
  waitForStoreProjectId,
} from "../utils/harness.js";
import { ensureProjectCreditsReadyForChat } from "../utils/projectCredits.js";

// This spec onboards the machine's real Codex credential for a secondary
// user. Disable Playwright tracing so neither the credential nor the browser
// session token can enter a retained trace archive.
test.use({ trace: "off" });

const INVITE_CHAT_MODEL =
  (process.env.PLAYWRIGHT_INVITE_CHAT_MODEL ?? "gpt-5.5").trim() || "gpt-5.5";

async function openProjectSettings(page: import("@playwright/test").Page) {
  await page.getByTestId("sidebar-project-button").click();
  await page.getByTestId("sidebar-project-settings").click();
  await expect(page.getByTestId("settings-panel")).toBeVisible();
  await page.getByTestId("settings-category-project-access").click();
  await expect(page).toHaveURL((url) =>
    url.searchParams.get("panel") === "settings" &&
    url.searchParams.get("settingsTab") === "project" &&
    url.searchParams.get("settingsCategory") === "access"
  );
  await expect(page.getByTestId("project-access-section")).toBeVisible();
}

async function ensureHostedRuntimeReady(page: import("@playwright/test").Page, projectId: string) {
  const ready = await waitForHostedRuntimeReady(page, 10_000, { projectId })
    .then(() => true)
    .catch(() => false);
  if (!ready) {
    await requestHostedRuntime(page, { projectId }).catch(() => {});
  }
  await waitForHostedRuntimeReady(page, 120_000, { projectId });
}

async function waitForAssistantReply(
  page: import("@playwright/test").Page,
  options: {
    projectId: string;
    expectedText: RegExp;
    initialTimeoutMs?: number;
    recoveryTimeoutMs?: number;
  }
) {
  const initialTimeoutMs = options.initialTimeoutMs ?? 120_000;
  const recoveryTimeoutMs = options.recoveryTimeoutMs ?? 120_000;

  try {
    await expectAssistantReplyOrSkipRateLimit(page, options.expectedText, { timeout: initialTimeoutMs });
    return;
  } catch {
    // Runtime churn can occasionally drop the first turn (SSE reconnect / runtime restart).
    // Re-ensure + reload once, then assert again.
  }

  await requestHostedRuntime(page, { projectId: options.projectId, source: "chat" }).catch(() => {});
  const url = page.url();
  await page.reload({ waitUntil: "domcontentloaded" }).catch(async () => {
    await page.goto(url, { waitUntil: "domcontentloaded" }).catch(() => {});
  });
  await page.waitForURL((next) => next.pathname.includes("/studio"), { timeout: 60_000 }).catch(() => {});
  await waitForStoreProjectId(page, options.projectId, 20_000).catch(() => {});
  await page.getByTestId("sidebar-nav-chat").click().catch(() => {});

  await expectAssistantReplyOrSkipRateLimit(page, options.expectedText, { timeout: recoveryTimeoutMs });
}

test.describe("Org invite link chat", () => {
  test.skip(
    (process.env.PLAYWRIGHT_SKIP_CODEX ?? "").trim() === "1",
    "Codex backend unavailable (rate limited). Provide Codex auth (OPENAI_API_KEY or tmp/proxy-codex/auth.json)."
  );
  test.setTimeout(360_000);

  test.afterEach(async ({ page }) => {
    await resetRuntimeUserState(page, { source: "org-invite-link-chat:cleanup" }).catch(() => {});
  });

  test("invite link lets another user continue the conversation", async ({ page, browser }) => {
    page.setDefaultTimeout(60_000);
    const projectId = await prepareStudio(page);
    if (!projectId) {
      throw new Error("Project id missing for invite link chat test.");
    }
    await ensureRealDefaultCodexCredentialWhenRequired(page);
    const orgName = await getActiveOrgName(page);

    await clearRuntimePreference(page, { projectId, source: "org-invite-link-chat" });
    await ensureHostedRuntimeReady(page, projectId);
    await selectPrimaryAgentModel(page, INVITE_CHAT_MODEL);
    await ensureProjectCreditsReadyForChat(page, projectId);

    const firstPrompt = "What is 1+1? Reply with just the number.";
    const createConversationResponse = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.ok() &&
        response.url().includes(`/projects/${projectId}/conversations`)
    );
    await page.getByTestId("chat-input").fill(firstPrompt);
    await page.getByTestId("chat-send-button").click();
    await createConversationResponse;

    await expect(page.getByTestId("assistant-typing-indicator")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId("assistant-setup-indicator")).toHaveCount(0, { timeout: 120_000 });
    await expect(page.getByTestId("assistant-typing-indicator")).toHaveCount(0, { timeout: 180_000 });
    await waitForAssistantReply(page, { projectId, expectedText: /\b2\b/ });

    await openProjectSettings(page);
    await page.getByTestId("org-invite-link-create").click();
    const inviteLinkInput = page.getByTestId("org-invite-link-url");
    await expect(inviteLinkInput).toBeVisible();
    const inviteLinkUrl = await inviteLinkInput.inputValue();
    if (!inviteLinkUrl) {
      throw new Error("Invite link URL missing.");
    }
    expect(new URL(inviteLinkUrl).searchParams.has("conversationControllerId")).toBe(false);

    await page.evaluate(() => {
      const win = window as typeof window & { __playwrightClipboardText?: string };
      win.__playwrightClipboardText = "";
      const setClipboardText = (value: unknown) => {
        win.__playwrightClipboardText = typeof value === "string" ? value : String(value ?? "");
      };

      try {
        const clipboard = navigator.clipboard as typeof navigator.clipboard & {
          writeText?: (value: string) => Promise<void>;
        };
        if (clipboard && typeof clipboard.writeText === "function") {
          try {
            clipboard.writeText = async (value: string) => {
              setClipboardText(value);
            };
          } catch {
            Object.defineProperty(clipboard, "writeText", {
              value: async (value: string) => setClipboardText(value),
              configurable: true,
            });
          }
        }
      } catch {
        void 0;
      }

      try {
        const originalExec = document.execCommand?.bind(document);
        if (originalExec) {
          document.execCommand = ((command: string, ...args: unknown[]) => {
            if (command === "copy") {
              const element = document.activeElement as HTMLTextAreaElement | null;
              if (element && typeof element.value === "string") {
                setClipboardText(element.value);
              }
              return true;
            }
            return originalExec(command, ...(args as []));
          }) as typeof document.execCommand;
        }
      } catch {
        void 0;
      }
    });

    await page.getByTestId("org-invite-link-copy").click();
    const copiedInviteLinkUrl = await page.evaluate(() => {
      const win = window as typeof window & { __playwrightClipboardText?: string };
      return win.__playwrightClipboardText ?? "";
    });
    expect(copiedInviteLinkUrl).toContain("/invite?token=");
    expect(copiedInviteLinkUrl).toBe(inviteLinkUrl);

    const memberContext = await browser.newContext();
    const memberPage = await memberContext.newPage();
    let memberCredentialId: string | null = null;
    let memberDisposableUserId: string | null = null;
    let memberFlowError: unknown = null;
    let credentialCleanupFailed = false;
    try {
      memberPage.setDefaultTimeout(60_000);
      const memberLogin = await loginAsGuest(memberPage);
      memberDisposableUserId = memberLogin.disposableUserId;
      const memberCredential = await ensureRealDefaultCodexCredentialWhenRequired(memberPage);
      memberCredentialId = memberCredential?.created
        ? memberCredential.credentialId
        : null;
      await memberPage.goto(copiedInviteLinkUrl, { waitUntil: "domcontentloaded" });
      await memberPage.waitForURL((url) => url.pathname.includes("/studio"), { timeout: 60_000 });
      await memberPage
        .getByText("Preparing your studio workspace…", { exact: false })
        .waitFor({ state: "detached", timeout: 60_000 })
        .catch(() => {});
      const memberProjectButton = memberPage.getByTestId("sidebar-project-button");
      await memberProjectButton.waitFor({ state: "visible", timeout: 60_000 });
      let switcherOpened = false;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        await memberProjectButton.click().catch(() => {});
        if (await memberPage.getByTestId("sidebar-project-switcher-menu").isVisible().catch(() => false)) {
          switcherOpened = true;
          break;
        }
        await memberPage.waitForTimeout(150).catch(() => {});
      }
      if (switcherOpened) {
        await expect(memberPage.getByTestId("sidebar-org-selector")).toContainText(orgName, { timeout: 60_000 });
        await memberPage.keyboard.press("Escape").catch(() => {});
        await expect(memberPage.getByTestId("sidebar-project-switcher-menu")).toHaveCount(0);
      }

      const memberUserBubble = memberPage
        .locator('[data-testid="chat-bubble-user"]')
        .filter({ hasText: /what is 1\+1/i })
        .first();
      await expect(memberUserBubble).toBeVisible({ timeout: 60_000 });

      await ensureHostedRuntimeReady(memberPage, projectId);
      await selectPrimaryAgentModel(memberPage, INVITE_CHAT_MODEL);
      await ensureProjectCreditsReadyForChat(memberPage, projectId);

      const followUpPrompt = "Now add 3 to the result. Reply with just the number no other text.";
      await memberPage.getByTestId("chat-input").fill(followUpPrompt);
      await memberPage.getByTestId("chat-send-button").click();
      await expect(memberPage.getByTestId("assistant-typing-indicator")).toBeVisible({ timeout: 10_000 });
      await waitForAssistantReply(memberPage, { projectId, expectedText: /\b5\b/, recoveryTimeoutMs: 180_000 });

      await page.getByTestId("sidebar-nav-chat").click();
      await expect(
        page.locator('[data-testid="chat-bubble-user"]').filter({ hasText: /now add 3/i }).first()
      ).toBeVisible({ timeout: 60_000 });
      await waitForAssistantReply(page, { projectId, expectedText: /\b5\b/, recoveryTimeoutMs: 180_000 });
    } catch (error) {
      memberFlowError = error;
    } finally {
      if (memberCredentialId) {
        try {
          await purgeRealUserCredential(memberPage, memberCredentialId);
        } catch {
          credentialCleanupFailed = true;
        }
      }
      await memberContext.close().catch(() => {
        credentialCleanupFailed = true;
      });
      if (memberDisposableUserId) {
        try {
          await deleteDisposableTestUser(memberDisposableUserId);
        } catch {
          credentialCleanupFailed = true;
        }
      }
    }
    if (memberFlowError) {
      if (credentialCleanupFailed) {
        throw new AggregateError(
          [memberFlowError, new Error("Disposable invite-member credential cleanup failed.")],
          "Invite-member flow and credential cleanup both failed."
        );
      }
      throw memberFlowError;
    }
    if (credentialCleanupFailed) {
      throw new Error("Disposable invite-member credential cleanup failed.");
    }
  });
});
