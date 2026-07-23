import { describe, expect, it } from "vitest";

import type { ConversationState } from "../../../../conversations/ConversationsProvider";
import type { ChatMessage } from "../../types";
import { buildParentConversationThreadMessage } from "../conversationThreadMessages";

function createMessage(overrides: Partial<ChatMessage>): ChatMessage {
  return {
    id: "message",
    role: "assistant",
    authorId: null,
    content: "",
    timestamp: 0,
    files: null,
    messageType: null,
    metadata: null,
    ...overrides,
  };
}

function createConversation(overrides: Partial<ConversationState>): ConversationState {
  return {
    localId: "thread-local",
    title: "",
    visibility: "public",
    lifecycleStatus: "active",
    controllerId: "thread-controller",
    parentConversationId: "parent-controller",
    threadKind: "thread",
    ownerAgent: null,
    originMessageId: null,
    delegatedByAgentId: null,
    messages: [],
    draft: "",
    draftEditorState: null,
    assistantEnabled: true,
    extraAgentHandles: [],
    unreadCount: 0,
    createdAt: 1_000,
    pendingRunIds: [],
    awaitingLeaseRunIds: [],
    pendingRunSubmittedAt: {},
    runtimePreference: null,
    ...overrides,
    activeGoal: overrides.activeGoal ?? null,
  };
}

describe("conversationThreadMessages", () => {
  it("renders slash-seeded child threads as run-thread messages", () => {
    const thread = createConversation({
      messages: [
        createMessage({ id: "seed", role: "user", content: "/learn", timestamp: 1_000 }),
        createMessage({
          id: "assistant-1",
          role: "assistant",
          content: "Checked INSTAFY.md",
          timestamp: 1_200,
          metadata: { jobId: "run-123" },
        }),
      ],
    });

    const preview = buildParentConversationThreadMessage({
      thread,
      parentMessages: [createMessage({ role: "user", content: "/learn", timestamp: 900 })],
      collapsedThreadMessages: thread.messages,
    });

    expect(preview.messageType).toBe("agent_job_thread");
    expect(preview.metadata).toMatchObject({
      messageType: "agent_job_thread",
      jobId: "run-123",
      threadLocalId: "thread-local",
    });
    expect(Array.isArray((preview.metadata as Record<string, unknown>).threadMessages)).toBe(true);
    expect(
      ((preview.metadata as Record<string, unknown>).threadMessages as ChatMessage[]).map((message) => message.id),
    ).toEqual(["assistant-1"]);
  });

  it("keeps non-processing child threads as conversation previews", () => {
    const thread = createConversation({
      messages: [createMessage({ id: "user-only", role: "user", content: "Can you summarize this?", timestamp: 1_000 })],
    });

    const preview = buildParentConversationThreadMessage({
      thread,
      parentMessages: thread.messages,
      collapsedThreadMessages: thread.messages,
    });

    expect(preview.messageType).toBe("conversation_thread");
    expect(preview.metadata).toMatchObject({
      messageType: "conversation_thread",
      threadLocalId: "thread-local",
    });
  });

  it("creates a run-thread placeholder for empty pending child threads", () => {
    const thread = createConversation({
      messages: [],
      pendingRunIds: ["run-pending"],
    });

    const preview = buildParentConversationThreadMessage({
      thread,
      parentMessages: [createMessage({ role: "user", content: "/learn", timestamp: 950 })],
      collapsedThreadMessages: [],
    });

    expect(preview.messageType).toBe("agent_job_thread");
    expect(preview.metadata).toMatchObject({
      messageType: "agent_job_thread",
      jobId: "run-pending",
      threadLocalId: "thread-local",
    });
    const threadMessages = (preview.metadata as Record<string, unknown>).threadMessages as ChatMessage[];
    expect(threadMessages).toHaveLength(1);
    expect(threadMessages[0]).toMatchObject({
      role: "assistant",
      messageType: "status",
      content: "Starting run…",
    });
  });

  it("surfaces linked thread metadata and advisory scope claims on run-thread previews", () => {
    const thread = createConversation({
      threadKind: "agent",
      ownerAgent: { id: "agent-1", handle: "octo" },
      messages: [
        createMessage({
          id: "assistant-1",
          role: "assistant",
          content: "I traced the auth middleware failure.",
          timestamp: 1_200,
          metadata: {
            jobId: "run-456",
            advisoryScopeClaims: [
              {
                kind: "task",
                label: "Investigate auth middleware",
                scope: "Investigate auth middleware",
                advisory: true,
                source: "prompt",
              },
            ],
          },
        }),
      ],
    });

    const preview = buildParentConversationThreadMessage({
      thread,
      parentMessages: [createMessage({ role: "user", content: "@octo investigate auth", timestamp: 900 })],
      collapsedThreadMessages: thread.messages,
    });

    expect(preview.messageType).toBe("agent_job_thread");
    expect(preview.metadata).toMatchObject({
      threadLocalId: "thread-local",
      linkedThreadId: "thread-local",
      agent: {
        handle: "octo",
      },
      advisoryScopeClaims: [
        {
          kind: "task",
          label: "Investigate auth middleware",
        },
      ],
    });
  });
});
