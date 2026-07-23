import { describe, expect, it } from "vitest";

import type { ConversationState } from "../../../../conversations/ConversationsProvider";
import type { ChatMessage } from "../../types";
import {
  buildAgentThreadBranchRows,
  collectReferencedThreadTargets,
  shouldHideStandaloneConversationThreadPreview,
} from "../agentThreadBranchRows";

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
    title: "Child thread",
    visibility: "public",
    lifecycleStatus: "active",
    controllerId: "thread-controller",
    parentConversationId: "parent-controller",
    threadKind: "agent",
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

describe("agentThreadBranchRows", () => {
  it("collects thread refs from agent run thread messages", () => {
    const targets = collectReferencedThreadTargets([
      createMessage({
        messageType: "agent_job_thread",
        metadata: {
          messageType: "agent_job_thread",
          threadMessages: [
            createMessage({
              id: "summary",
              content: "See [[thread:thread-controller|Preview cleanup smoke]].",
            }),
          ],
        },
      }),
    ]);

    expect(Array.from(targets)).toEqual(["thread-controller"]);
  });

  it("hides standalone child thread cards when empty or already referenced", () => {
    const emptyThread = createConversation({ messages: [] });
    const referencedThread = createConversation({
      localId: "referenced-local",
      controllerId: "referenced-controller",
      messages: [createMessage({ id: "seed", role: "user", content: "@ben What is 6+7?" })],
    });
    const preview = createMessage({
      messageType: "conversation_thread",
      metadata: { messageType: "conversation_thread", threadLocalId: "thread-local" },
    });

    expect(
      shouldHideStandaloneConversationThreadPreview({
        thread: emptyThread,
        preview,
        referencedThreadTargets: new Set(),
      }),
    ).toBe(true);
    expect(
      shouldHideStandaloneConversationThreadPreview({
        thread: referencedThread,
        preview,
        referencedThreadTargets: new Set(["referenced-controller"]),
      }),
    ).toBe(true);
  });

  it("builds compact branch rows with participants, count, and running state", () => {
    const childThread = createConversation({
      localId: "child-local",
      controllerId: "child-controller",
      title: "Preview cleanup smoke",
      ownerAgent: { id: "agent-octo", handle: "octo" },
      pendingRunIds: ["run-1"],
      messages: [
        createMessage({ id: "seed", role: "user", content: "@ben What is 6+7?" }),
        createMessage({
          id: "reply",
          role: "assistant",
          content: "13",
          metadata: { agent: { handle: "ben", avatarSeed: "ben" } },
        }),
      ],
    });
    const runThread = createMessage({
      messageType: "agent_job_thread",
      metadata: {
        messageType: "agent_job_thread",
        threadMessages: [
          createMessage({
            id: "summary",
            content: "Opened [[thread:child-controller|Preview cleanup smoke]].",
          }),
        ],
      },
    });

    expect(buildAgentThreadBranchRows({ message: runThread, conversations: [childThread] })).toEqual([
      {
        threadLocalId: "child-local",
        title: "Preview cleanup smoke",
        hiddenActivityCount: 2,
        isRunning: true,
        participants: [
          { handle: "octo", avatarSeed: "octo", avatarUrl: null },
          { handle: "ben", avatarSeed: "ben", avatarUrl: null },
        ],
      },
    ]);
  });
});
