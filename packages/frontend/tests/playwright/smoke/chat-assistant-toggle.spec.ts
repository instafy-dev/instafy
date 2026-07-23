import { test, expect, type Page } from "@playwright/test";
import {
  clearRuntimePreference,
  prepareStudio,
  requestHostedRuntime,
  resetRuntimeUserState,
  waitForHostedRuntimeReady,
} from "../utils/harness.js";
import {
  DEFAULT_MOCK_CREDENTIAL_ID,
  mockDefaultAiCredential,
} from "../utils/credentialMocks.js";
import { ensureProjectCreditsReadyForChat } from "../utils/projectCredits.js";
import { openRuntimeAiMenu } from "../utils/runtimeAi.js";

const LARGE_OCTO_PROMPT =
  "@octo Review the current auth flow, inspect the relevant files, and summarize the likely bug source.";
const SPLIT_OCTO_PROMPT =
  "@octo Split this into a separate work thread: review the current auth flow, inspect the relevant files, and summarize the likely bug source.";

async function ensureHostedRuntimeReady(projectId: string, page: Page) {
  const ready = await waitForHostedRuntimeReady(page, 10_000).then(() => true).catch(() => false);
  if (!ready) {
    await requestHostedRuntime(page, { projectId }).catch(() => {});
  }
  await waitForHostedRuntimeReady(page, 120_000);
}

type AgentThreadDebugState = {
  activeConversationLocalId: string | null;
  activeConversationControllerId: string | null;
  threadLocalId: string | null;
  threadControllerId: string | null;
};

async function readAgentThreadDebugState(
  page: Page,
  ownerAgentHandle: string,
): Promise<AgentThreadDebugState> {
  return await page.evaluate((expectedHandle) => {
    const debug = (window as Window & {
      __INSTAFY_CONVERSATIONS_DEBUG__?: {
        activeConversationLocalId?: string | null;
        activeConversationControllerId?: string | null;
        conversations?: Array<{
          localId: string;
          controllerId: string | null;
          parentConversationId?: string | null;
          threadKind?: string | null;
          ownerAgentHandle?: string | null;
        }>;
      };
    }).__INSTAFY_CONVERSATIONS_DEBUG__;
    const thread =
      debug?.conversations?.find(
        (conversation) =>
          conversation.parentConversationId &&
          conversation.threadKind === "agent" &&
          conversation.ownerAgentHandle === expectedHandle,
      ) ?? null;
    return {
      activeConversationLocalId: debug?.activeConversationLocalId ?? null,
      activeConversationControllerId: debug?.activeConversationControllerId ?? null,
      threadLocalId: thread?.localId ?? null,
      threadControllerId: thread?.controllerId ?? null,
    };
  }, ownerAgentHandle);
}

async function expectAgentThreadDebugState(page: Page, ownerAgentHandle: string) {
  await expect
    .poll(
      async () => {
        const state = await readAgentThreadDebugState(page, ownerAgentHandle);
        return Boolean(
          state.activeConversationControllerId &&
          state.threadLocalId &&
          state.threadControllerId,
        );
      },
      { timeout: 30_000 },
    )
    .toBe(true);
}

async function expectNoAgentThreadDebugState(page: Page, ownerAgentHandle: string) {
  await expect
    .poll(
      async () => {
        const state = await readAgentThreadDebugState(page, ownerAgentHandle);
        return Boolean(state.threadLocalId);
      },
      { timeout: 10_000 },
    )
    .toBe(false);
}

async function ensureAiCreditsAndReturnToChat(page: Page, projectId: string) {
  await ensureProjectCreditsReadyForChat(page, projectId, 25);
}

function trackAssistantDispatch(page: Page): () => boolean {
  let sawAssistantDispatch = false;
  page.on("request", (request) => {
    if (request.method() !== "POST") {
      return;
    }
    let url: URL;
    try {
      url = new URL(request.url());
    } catch {
      return;
    }
    const pathname = url.pathname;
    if (
      /\/projects\/[^/]+\/conversations$/.test(pathname) ||
      /\/conversations\/[^/]+\/messages$/.test(pathname)
    ) {
      sawAssistantDispatch = true;
    }
  });
  return () => sawAssistantDispatch;
}

async function disableAssistant(page: Page) {
  const toggle = page.getByTestId("chat-assistant-toggle");
  await openRuntimeAiMenu(page);
  await expect(toggle).toBeVisible();
  await toggle.click();
  await page.keyboard.press("Escape").catch(() => {});
}

async function prepareAssistantDisabledChat(
  page: Page,
  source: string,
  options?: { ensureCredits?: boolean; agents?: Array<Record<string, unknown>> },
): Promise<string> {
  await mockDefaultAiCredential(page, options?.agents ? { agents: options.agents } : undefined);
  const projectId = await prepareStudio(page);
  if (options?.ensureCredits ?? true) {
    await ensureAiCreditsAndReturnToChat(page, projectId);
  }
  await clearRuntimePreference(page, { projectId, source });
  await ensureHostedRuntimeReady(projectId, page);
  await disableAssistant(page);
  return projectId;
}

test.describe("Chat assistant toggle", () => {
  test.setTimeout(180_000);

  test.afterEach(async ({ page }) => {
    await resetRuntimeUserState(page, { source: "chat-assistant-toggle:cleanup" }).catch(() => {});
  });

  test("sends a human-only message without invoking the assistant", async ({ page }) => {
    await prepareAssistantDisabledChat(page, "assistant-toggle", { ensureCredits: false });
    const sawAssistantDispatch = trackAssistantDispatch(page);

    const message = `Hello teammate ${Date.now()}`;
    await page.getByTestId("chat-input").fill(message);
    await page.getByTestId("chat-send-button").click();

    await expect(page.getByTestId("chat-bubble-user").last()).toContainText(message);
    await expect(page.getByTestId("assistant-typing-indicator")).toHaveCount(0, { timeout: 5_000 });
    await page.waitForTimeout(1_500);
    expect(sawAssistantDispatch()).toBeFalsy();
  });

  test("allows @octo override while assistant is disabled", async ({ page }) => {
    await prepareAssistantDisabledChat(page, "assistant-toggle-ai-override");
    const sawAssistantDispatch = trackAssistantDispatch(page);

    const prompt = "@octo What is 1+1? Reply with just the number.";
    await page.getByTestId("chat-input").fill(prompt);
    await page.getByTestId("chat-send-button").click();

    await expect.poll(sawAssistantDispatch, { timeout: 30_000 }).toBe(true);
    await expect(page.getByTestId("agent-job-thread-preview")).toHaveCount(0);
    await expectNoAgentThreadDebugState(page, "octo");
  });

  test("keeps deeper same-agent work inline by default while assistant is disabled", async ({ page }) => {
    await prepareAssistantDisabledChat(page, "assistant-toggle-ai-inline-deeper");
    const sawAssistantDispatch = trackAssistantDispatch(page);

    await page.getByTestId("chat-input").fill(LARGE_OCTO_PROMPT);
    await page.getByTestId("chat-send-button").click();

    await expect.poll(sawAssistantDispatch, { timeout: 30_000 }).toBe(true);
    await expect(page.getByTestId("agent-job-thread-preview")).toHaveCount(0);
    await expectNoAgentThreadDebugState(page, "octo");
  });

  test("keeps simple multi-agent asks inline while assistant is disabled", async ({ page }) => {
    const now = new Date().toISOString();
    await prepareAssistantDisabledChat(page, "assistant-toggle-multi-agent-inline", {
      agents: [
        {
          id: "33333333-3333-4333-8333-333333333333",
          handle: "octo",
          displayName: "Octo",
          description: null,
          avatarSeed: "octo",
          provider: "assistant",
          model: null,
          credentialId: DEFAULT_MOCK_CREDENTIAL_ID,
          runtimeId: null,
          createdAt: now,
          updatedAt: now,
        },
        {
          id: "44444444-4444-4444-8444-444444444444",
          handle: "ben",
          displayName: "Ben",
          description: null,
          avatarSeed: "ben",
          provider: "assistant",
          model: null,
          credentialId: DEFAULT_MOCK_CREDENTIAL_ID,
          runtimeId: null,
          createdAt: now,
          updatedAt: now,
        },
      ],
    });
    const sawAssistantDispatch = trackAssistantDispatch(page);

    const prompt = "@ben What is 1+1? Reply with just the number. @octo Can you write a two-line poem?";
    await page.getByTestId("chat-input").fill(prompt);
    await page.getByTestId("chat-send-button").click();

    await expect.poll(sawAssistantDispatch, { timeout: 30_000 }).toBe(true);
    await expect(page.getByTestId("agent-job-thread-preview")).toHaveCount(0);
    await expectNoAgentThreadDebugState(page, "ben");
    await expectNoAgentThreadDebugState(page, "octo");
  });

  test("keeps mixed explicit split wording inline for runtime routing", async ({ page }) => {
    const now = new Date().toISOString();
    await prepareAssistantDisabledChat(page, "assistant-toggle-mixed-agent-routing", {
      agents: [
        {
          id: "33333333-3333-4333-8333-333333333333",
          handle: "octo",
          displayName: "Octo",
          description: null,
          avatarSeed: "octo",
          provider: "assistant",
          model: null,
          credentialId: DEFAULT_MOCK_CREDENTIAL_ID,
          runtimeId: null,
          createdAt: now,
          updatedAt: now,
        },
        {
          id: "44444444-4444-4444-8444-444444444444",
          handle: "ben",
          displayName: "Ben",
          description: null,
          avatarSeed: "ben",
          provider: "assistant",
          model: null,
          credentialId: DEFAULT_MOCK_CREDENTIAL_ID,
          runtimeId: null,
          createdAt: now,
          updatedAt: now,
        },
      ],
    });
    const sawAssistantDispatch = trackAssistantDispatch(page);

    const prompt =
      "@ben What is 1+1? Reply with just the number. " +
      "@octo Split this into a separate work thread: inspect routing and summarize the likely issue.";
    await page.getByTestId("chat-input").fill(prompt);
    await page.getByTestId("chat-send-button").click();

    await expect.poll(sawAssistantDispatch, { timeout: 30_000 }).toBe(true);
    await expect(page.getByTestId("agent-job-thread-preview")).toHaveCount(0);
    await expectNoAgentThreadDebugState(page, "ben");
    await expectNoAgentThreadDebugState(page, "octo");
  });

  test("keeps explicit split @octo wording inline while assistant is disabled", async ({ page }) => {
    const sawAssistantDispatch = trackAssistantDispatch(page);
    await prepareAssistantDisabledChat(page, "assistant-toggle-ai-thread");
    await page.getByTestId("chat-input").fill(SPLIT_OCTO_PROMPT);
    await page.getByTestId("chat-send-button").click();

    await expect.poll(sawAssistantDispatch, { timeout: 30_000 }).toBe(true);
    await expect(page.getByTestId("agent-job-thread-preview")).toHaveCount(0);
    await expectNoAgentThreadDebugState(page, "octo");
  });
});
