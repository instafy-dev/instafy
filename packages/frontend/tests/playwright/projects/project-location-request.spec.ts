import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import {
  getSupabaseAuthHeaders,
  getSupabaseUrl,
  prepareStudio,
  resetRuntimeUserState,
} from "../utils/harness.js";
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

test.describe("Location request cards", () => {
  test.setTimeout(120_000);

  test.afterEach(async ({ page }) => {
    await resetRuntimeUserState(page, { source: "project-location-request:cleanup" }).catch(() => {});
  });

  test("shares approximate browser location from an action request card", async ({ page, baseURL }) => {
    const projectId = await prepareStudio(page, { waitForHostedRuntime: false });
    if (!projectId) {
      throw new Error("Project id missing for location request test.");
    }

    if (!baseURL) {
      throw new Error("Missing Playwright baseURL.");
    }

    await page.context().grantPermissions(["geolocation"], { origin: baseURL });
    await page.context().setGeolocation({
      latitude: 48.208174,
      longitude: 16.373819,
      accuracy: 120,
    });

    await page.getByTestId("sidebar-nav-chat").click();
    await disableAssistantIfPossible(page);

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
    const messageId = randomUUID();
    const createdAt = new Date().toISOString();

    await seedControllerConversationMessage(page, {
      id: messageId,
      projectId,
      conversationId: controllerConversationId,
      role: "assistant",
      content: "Share your approximate location so I can continue this nearby request.",
      metadata: {
        messageType: "action_request",
        details: {
          messageType: "action_request",
          details: {
            testId: "location-request-card",
            icon: "location",
            overline: "Location access",
            title: "Share your current location?",
            description: "Share your approximate location so I can continue this nearby request.",
            actions: [
              {
                id: "share-approximate",
                label: "Share approximate location",
                variant: "primary",
                event: "instafy:request-location",
                args: ["approximate"],
                busyLabel: "Requesting…",
                testId: "location-request-primary",
              },
            ],
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
      ({ pid, cid, localId, messageId, createdAt }) => {
        (window as any).__INSTAFY_E2E__?.emitConversationMessage?.({
          id: messageId,
          projectId: pid,
          conversationId: cid,
          role: "assistant",
          content: "Share your approximate location so I can continue this nearby request.",
          metadata: {
            conversationMetadata: { localId },
            messageType: "action_request",
            details: {
              messageType: "action_request",
              details: {
                testId: "location-request-card",
                icon: "location",
                overline: "Location access",
                title: "Share your current location?",
                description: "Share your approximate location so I can continue this nearby request.",
                actions: [
                  {
                    id: "share-approximate",
                    label: "Share approximate location",
                    variant: "primary",
                    event: "instafy:request-location",
                    args: ["approximate"],
                    busyLabel: "Requesting…",
                    testId: "location-request-primary",
                  },
                ],
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
        messageId,
        createdAt,
      },
    );

    await historyFetch;

    const card = page.getByTestId("location-request-card");
    await expect(card).toBeVisible();
    await expect(card).toContainText("Share your current location?");

    await card.getByTestId("location-request-primary").click();

    const userBubbles = page.getByTestId("chat-bubble-user");
    await expect(userBubbles.last()).toContainText("Shared my approximate location.", { timeout: 30_000 });
    await expect(card.getByTestId("location-request-primary")).toContainText("Share approximate location");
  });
});
