import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import {
  clearRuntimePreference,
  getSupabaseAuthHeaders,
  getSupabaseUrl,
  prepareStudio,
  resetRuntimeUserState,
} from "../utils/harness.js";
import { clickQueuedSendNowIfAvailable } from "../utils/chatUi.js";
import { ensureProjectCreditsReadyInUi } from "../utils/projectCredits.js";
import { disableAssistantIfPossible } from "../utils/runtimeAi.js";

function conversationTabButtons(page: Page) {
  return page.locator('[data-testid="workspace-tabs"] [data-tab-kind="conversation"]');
}

async function resolveActiveConversationLocalId(page: Page): Promise<string> {
  const tabs = conversationTabButtons(page);
  await expect(tabs).toHaveCount(1);
  const tabId = await tabs.first().getAttribute("data-tab-id");
  if (!tabId) {
    throw new Error("Conversation tab missing data-tab-id.");
  }
  return tabId.startsWith("workspace-conversation-")
    ? tabId.replace("workspace-conversation-", "")
    : tabId;
}

async function createBlankControllerConversationId(params: {
  page: Page;
  projectId: string;
  localConversationId: string;
}): Promise<string> {
  const conversationId = await params.page.evaluate(
    async ({ projectId, localConversationId }) => {
      const e2e = (window as any).__INSTAFY_E2E__;
      if (!e2e?.createBlankConversation) {
        return null;
      }
      return await e2e.createBlankConversation({
        projectId,
        metadata: { localId: localConversationId },
      });
    },
    { projectId: params.projectId, localConversationId: params.localConversationId },
  );

  const normalized = typeof conversationId === "string" ? conversationId.trim() : "";
  if (!normalized) {
    throw new Error("Unable to create blank controller conversation (missing conversationId).");
  }
  return normalized;
}

async function seedControllerConversationMessage(page: Page, input: {
  id?: string;
  projectId: string;
  conversationId: string;
  role: "assistant" | "user";
  content: string;
  metadata?: Record<string, unknown>;
}) {
  const supabaseUrl = getSupabaseUrl().replace(/\/+$/, "");
  const headers = getSupabaseAuthHeaders();
  const serviceRole = headers.authorization ?? "";
  if (!supabaseUrl || !serviceRole) {
    throw new Error("Supabase service role missing; cannot seed conversation messages.");
  }

  const response = await page.context().request.post(`${supabaseUrl}/rest/v1/conversation_messages`, {
    headers: {
      ...headers,
      "content-type": "application/json",
      prefer: "return=minimal",
    },
    data: {
      id: input.id ?? randomUUID(),
      conversation_id: input.conversationId,
      project_id: input.projectId,
      role: input.role,
      content: input.content,
      metadata: input.metadata ?? {},
    },
  });

  if (!response.ok()) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `Failed to seed controller conversation message (${response.status()}): ${body.slice(0, 200)}`,
    );
  }
}

async function expectActiveConversationRoutingState(page: Page, expected: {
  assistantEnabled: boolean;
  extraAgentHandles: string[];
}) {
  await expect
    .poll(
      async () =>
        await page.evaluate(() => {
          const debug = (window as any).__INSTAFY_CONVERSATIONS_DEBUG__;
          return JSON.stringify({
            assistantEnabled: Boolean(debug?.activeConversationAssistantEnabled),
            extraAgentHandles: Array.isArray(debug?.activeConversationExtraAgentHandles)
              ? debug.activeConversationExtraAgentHandles
              : [],
          });
        }),
      { timeout: 15_000 },
    )
    .toBe(JSON.stringify(expected));
}

test.describe("Secret request cards", () => {
  test.setTimeout(120_000);

  test.afterEach(async ({ page }) => {
    await resetRuntimeUserState(page, { source: "project-secret-request:cleanup" }).catch(() => {});
  });

  test("opens secrets manager from a secret_request message", async ({ page }) => {
    const projectId = await prepareStudio(page, { waitForHostedRuntime: false });
    if (!projectId) {
      throw new Error("Project id missing for secret request test.");
    }

    await clearRuntimePreference(page, { projectId, source: "project-secret-request" }).catch(() => {});
    await page.getByTestId("sidebar-nav-chat").click();
    await disableAssistantIfPossible(page);
    await expectActiveConversationRoutingState(page, {
      assistantEnabled: false,
      extraAgentHandles: [],
    });

    await expect
      .poll(
        async () =>
          await page.evaluate(
            () =>
              Boolean(
                (window as any).__INSTAFY_E2E__?.emitConversationMessage &&
                  (window as any).__INSTAFY_E2E__?.createBlankConversation,
              ),
          ),
        { timeout: 10_000 },
      )
      .toBeTruthy();

    const conversationLocalId = await resolveActiveConversationLocalId(page);
    const controllerConversationId = await createBlankControllerConversationId({
      page,
      projectId,
      localConversationId: conversationLocalId,
    });
    const suggestedReply = "I added CLOUDFLARE_API_TOKEN. Please try again.";
    const messageId = randomUUID();
    const createdAt = new Date().toISOString();

    await seedControllerConversationMessage(page, {
      id: messageId,
      projectId,
      conversationId: controllerConversationId,
      role: "assistant",
      content: "Cloudflare API token used for deployments.",
      metadata: {
        messageType: "secret_request",
        details: {
          messageType: "secret_request",
          ui: { suggestedReply },
          kind: "runtime_selection",
          runtimeId: "runtime-test-id",
          displayName: "Hosted Runtime",
          details: {
            name: "CLOUDFLARE_API_TOKEN",
            description: "Cloudflare API token used for deployments.",
            agentHandles: ["octo"],
          },
        },
      },
    });

    const historyFetch = page
      .waitForResponse(
        (response) =>
          response.request().method() === "GET" &&
          response.url().includes(`/conversations/${controllerConversationId}/messages`),
        { timeout: 30_000 },
      )
      .catch(() => null);

    await page.evaluate(
      ({ pid, cid, localId, suggestedReply, messageId, createdAt }) => {
        (window as any).__INSTAFY_E2E__?.emitConversationMessage?.({
          id: messageId,
          projectId: pid,
          conversationId: cid,
          role: "assistant",
          content: "Cloudflare API token used for deployments.",
          metadata: {
            conversationMetadata: { localId },
            messageType: "secret_request",
            details: {
              messageType: "secret_request",
              ui: { suggestedReply },
              kind: "runtime_selection",
              runtimeId: "runtime-test-id",
              displayName: "Hosted Runtime",
              details: {
                name: "CLOUDFLARE_API_TOKEN",
                description: "Cloudflare API token used for deployments.",
                agentHandles: ["octo"],
              },
            },
          },
          createdAt,
        });
      },
      {
        pid: projectId,
        cid: controllerConversationId,
        localId: conversationLocalId,
        suggestedReply,
        messageId,
        createdAt,
      },
    );

    await historyFetch;

    const card = page.getByTestId("secret-request-card");
    await expect(card).toBeVisible();
    await expect(card).toContainText("CLOUDFLARE_API_TOKEN");

    await card.getByTestId("secret-request-open").click();

    await expect(page.getByTestId("secrets-panel")).toBeVisible();
    await expect(page.getByTestId("project-secret-modal")).toBeVisible();
    await expect(page.getByTestId("project-secret-name-input")).toHaveValue("CLOUDFLARE_API_TOKEN");
    await expect(page.getByTestId("project-secret-description-input")).toHaveValue(
      "Cloudflare API token used for deployments.",
    );
    await expect(page.getByTestId("project-secret-value-input")).toBeFocused({ timeout: 10_000 });

    await page.getByTestId("project-secret-value-input").fill("playwright-dummy-secret");
    await page.getByTestId("project-secret-save").click();
    await expect(page.getByTestId("project-secret-modal")).toBeHidden({ timeout: 30_000 });

    // Secret requests return to chat after saving so the user can continue the flow.
    await expect.poll(() => new URL(page.url()).searchParams.get("panel")).toBeNull();

    // Ensure the secret is visible in the secrets list (panel tab stays open).
    const secretsTab = page.locator('[data-tab-id="workspace-tab-secrets"]');
    await secretsTab.scrollIntoViewIfNeeded();
    await secretsTab.click();
    await expect.poll(() => new URL(page.url()).searchParams.get("panel")).toBe("secrets");
    await expect(page.getByTestId("project-secrets-card")).toContainText("CLOUDFLARE_API_TOKEN", { timeout: 30_000 });

    const conversationTab = page.locator(`[data-tab-id="workspace-conversation-${conversationLocalId}"]`);
    await conversationTab.scrollIntoViewIfNeeded();
    await conversationTab.click();
    await expect.poll(() => new URL(page.url()).searchParams.get("panel")).toBeNull();

    await expect(page.getByTestId("secret-request-card")).toBeVisible();

    const renderedSuggestedReply = page.getByText(suggestedReply, { exact: true }).last();
    const sendQueue = page.getByTestId("chat-send-queue");
    const chatInput = page.getByTestId("chat-input");
    await ensureProjectCreditsReadyInUi(page, projectId);
    await conversationTab.scrollIntoViewIfNeeded();
    await conversationTab.click();
    await expect.poll(() => new URL(page.url()).searchParams.get("panel")).toBeNull();
    await page.getByTestId("chat-input").fill(suggestedReply);
    await expect(page.getByTestId("chat-send-button")).toBeEnabled({ timeout: 15_000 });
    await page.getByTestId("chat-send-button").click();
    await expect
      .poll(
        async () => {
          const queued = await sendQueue.isVisible().catch(() => false);
          if (queued) {
            await clickQueuedSendNowIfAvailable(page);
          }
          const renderedVisible = await renderedSuggestedReply.isVisible().catch(() => false);
          const inputValue = await chatInput.textContent().catch(() => "");
          return renderedVisible && !inputValue.includes(suggestedReply);
        },
        { timeout: 60_000 },
      )
      .toBeTruthy();
    await expect(renderedSuggestedReply).toBeVisible();
  });
});
