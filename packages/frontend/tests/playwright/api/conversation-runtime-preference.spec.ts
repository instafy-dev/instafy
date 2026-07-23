import { randomUUID } from "node:crypto";
import { expect } from "@playwright/test";

import {
  privateRuntimeTest as test,
  registerPrivateRuntime,
} from "../utils/privateRuntimeHarness.js";

test.describe("Conversation runtime preference", () => {
  test("stale runtime preference metadata is ignored when dispatching new messages", async ({
    request,
    privateRuntimeOwnerProject,
  }) => {
    const {
      accessToken,
      controllerUrl: controller,
      projectId,
    } = privateRuntimeOwnerProject;
    await privateRuntimeOwnerProject.connectCodex();

    const staleRuntimeId = randomUUID();
    const createConversationResponse = await request.post(
      `${controller}/projects/${encodeURIComponent(projectId)}/conversations/blank`,
      {
        headers: {
          authorization: `Bearer ${accessToken}`,
          "content-type": "application/json",
        },
        data: {
          metadata: {
            runtimePreference: {
              runtimeId: staleRuntimeId,
              source: "session",
              updatedAt: new Date().toISOString(),
              displayName: "Stale Runtime",
            },
          },
        },
      },
    );
    expect(createConversationResponse.ok()).toBeTruthy();
    const createConversationPayload = (await createConversationResponse.json()) as {
      conversationId?: string;
      conversation_id?: string;
    };
    const conversationId =
      createConversationPayload.conversationId ?? createConversationPayload.conversation_id ?? null;
    expect(conversationId).toBeTruthy();

    const { runtimeId, agentToken } = await registerPrivateRuntime(request, {
      controllerUrl: controller,
      accessToken,
      projectId,
      displayName: "Playwright Runtime",
    });

    const postMessageResponse = await request.post(
      `${controller}/conversations/${encodeURIComponent(conversationId as string)}/messages`,
      {
        headers: {
          authorization: `Bearer ${accessToken}`,
          "content-type": "application/json",
        },
        data: {
          promptText: "Say hello from playwright.",
          intent: "question",
          runtimeType: "self-hosted",
        },
      },
    );
    expect(postMessageResponse.ok()).toBeTruthy();
    const postMessagePayload = (await postMessageResponse.json()) as {
      jobId?: string;
      jobIds?: string[];
    };
    const jobId =
      typeof postMessagePayload.jobId === "string"
        ? postMessagePayload.jobId
        : Array.isArray(postMessagePayload.jobIds) && typeof postMessagePayload.jobIds[0] === "string"
          ? postMessagePayload.jobIds[0]
          : null;
    expect(jobId).toBeTruthy();

    const leaseResponse = await request.post(`${controller}/agent/lease`, {
      headers: {
        authorization: `Bearer ${agentToken}`,
        "content-type": "application/json",
      },
      data: {
        runtime_id: runtimeId,
        max: 1,
        lease_seconds: 120,
      },
    });
    expect(leaseResponse.ok()).toBeTruthy();
    const leasePayload = (await leaseResponse.json()) as { jobs?: Array<{ id?: string }> };
    expect(Array.isArray(leasePayload.jobs)).toBeTruthy();
    expect(leasePayload.jobs?.length ?? 0).toBe(1);
    expect(leasePayload.jobs?.[0]?.id).toBe(jobId);

    const listConversationsResponse = await request.get(
      `${controller}/projects/${encodeURIComponent(projectId)}/conversations?limit=100`,
      {
        headers: {
          authorization: `Bearer ${accessToken}`,
        },
      },
    );
    expect(listConversationsResponse.ok()).toBeTruthy();
    const conversations = (await listConversationsResponse.json()) as Array<{
      id?: string;
      metadata?: Record<string, unknown>;
    }>;
    const updatedConversation = conversations.find((entry) => entry.id === conversationId);
    expect(updatedConversation).toBeTruthy();
    expect(updatedConversation?.metadata?.runtimePreference).toBeUndefined();

    const completeResponse = await request.post(`${controller}/agent/complete`, {
      headers: {
        authorization: `Bearer ${agentToken}`,
        "content-type": "application/json",
      },
      data: {
        job_id: jobId,
        outcome: "succeeded",
        summary: "playwright stale runtime preference guard",
      },
    });
    expect(completeResponse.ok()).toBeTruthy();
  });
});
