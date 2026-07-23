import { describe, expect, it } from "vitest";

import type { ConversationState } from "../ConversationsProvider";
import {
  findReusableBlankConversation,
  getConversationAutoTitleSeed,
  getStructuredConversationTitle,
  isDefaultConversationTitle,
  isReusableBlankConversation,
  shouldAutoTitleConversation,
} from "../conversationAutoTitle";

function createConversation(overrides: Partial<ConversationState> = {}): ConversationState {
  return {
    localId: "conv-1",
    title: "Conversation 1",
    visibility: "private",
    lifecycleStatus: "active",
    controllerId: null,
    parentConversationId: null,
    threadKind: null,
    ownerAgent: null,
    originMessageId: null,
    delegatedByAgentId: null,
    messages: [],
    draft: "",
    draftEditorState: null,
    assistantEnabled: true,
    extraAgentHandles: [],
    unreadCount: 0,
    createdAt: Date.now(),
    pendingRunIds: [],
    awaitingLeaseRunIds: [],
    pendingRunSubmittedAt: {},
    runtimePreference: null,
    ...overrides,
    activeGoal: overrides.activeGoal ?? null,
  };
}

describe("conversationAutoTitle", () => {
  it("recognizes generated default conversation titles", () => {
    expect(isDefaultConversationTitle("Conversation 1")).toBe(true);
    expect(isDefaultConversationTitle("Conversation 42")).toBe(true);
    expect(isDefaultConversationTitle("Build launch plan")).toBe(false);
  });

  it("only auto-titles root conversations before the first user turn", () => {
    expect(
      shouldAutoTitleConversation(createConversation(), "Can you plan a launch campaign?"),
    ).toBe(true);

    expect(
      shouldAutoTitleConversation(
        createConversation({
          messages: [
            {
              id: "user-1",
              role: "user",
              authorId: null,
              content: "hello",
              timestamp: Date.now(),
              files: null,
              messageType: "user",
              metadata: null,
            },
          ],
        }),
        "Can you plan a launch campaign?",
      ),
    ).toBe(false);

    expect(
      shouldAutoTitleConversation(
        createConversation({ parentConversationId: "parent-1", threadKind: "thread" }),
        "/learn",
      ),
    ).toBe(false);

    expect(
      shouldAutoTitleConversation(
        createConversation({ title: "Launch checklist" }),
        "Can you plan a launch campaign?",
      ),
    ).toBe(false);
  });

  it("extracts the latest user turn as an auto-title seed while the title is still default", () => {
    expect(
      getConversationAutoTitleSeed(
        createConversation({
          messages: [
            {
              id: "user-1",
              role: "user",
              authorId: null,
              content: " Can you plan a launch campaign? ",
              timestamp: Date.now(),
              files: null,
              messageType: "user",
              metadata: null,
            },
          ],
        }),
      ),
    ).toBe("Can you plan a launch campaign?");

    expect(
      getConversationAutoTitleSeed(
        createConversation({
          messages: [
            {
              id: "user-1",
              role: "user",
              authorId: null,
              content: "First",
              timestamp: Date.now(),
              files: null,
              messageType: "user",
              metadata: null,
            },
            {
              id: "user-2",
              role: "user",
              authorId: null,
              content: "Second",
              timestamp: Date.now(),
              files: null,
              messageType: "user",
              metadata: null,
            },
          ],
        }),
      ),
    ).toBe("Second");
  });

  it("does not seed auto-title for manually titled conversations or child threads", () => {
    expect(
      getConversationAutoTitleSeed(
        createConversation({
          title: "Launch checklist",
          messages: [
            {
              id: "user-1",
              role: "user",
              authorId: null,
              content: "Can you plan a launch campaign?",
              timestamp: Date.now(),
              files: null,
              messageType: "user",
              metadata: null,
            },
          ],
        }),
      ),
    ).toBeNull();

    expect(
      getConversationAutoTitleSeed(
        createConversation({
          parentConversationId: "parent-1",
          threadKind: "thread",
          messages: [
            {
              id: "user-1",
              role: "user",
              authorId: null,
              content: "Can you plan a launch campaign?",
              timestamp: Date.now(),
              files: null,
              messageType: "user",
              metadata: null,
            },
          ],
        }),
      ),
    ).toBeNull();
  });

  it("does not invoke AI auto-title from a record-only ambient turn", () => {
    expect(
      getConversationAutoTitleSeed(
        createConversation({
          messages: [
            {
              id: "user-silent",
              role: "user",
              authorId: "user-1",
              content: "Taylor, do you prefer option A?",
              timestamp: Date.now(),
              files: null,
              messageType: "user",
              metadata: {
                groupParticipation: {
                  decision: "silent",
                  reason: "directed_to_human",
                },
                groupParticipationPreflight: { status: "resolved" },
              },
            },
          ],
        }),
      ),
    ).toBeNull();
  });

  it("waits for controller classification before auto-titling a deferred turn", () => {
    const deferredMessage = {
      id: "user-deferred",
      role: "user" as const,
      authorId: "user-1",
      content: "What is 1 + 1?",
      timestamp: Date.now(),
      files: null,
      messageType: "user",
      metadata: {
        groupParticipationPreflight: { status: "controller_deferred" },
      },
    };

    expect(
      getConversationAutoTitleSeed(
        createConversation({ messages: [deferredMessage] }),
      ),
    ).toBeNull();
    expect(
      getConversationAutoTitleSeed(
        createConversation({
          messages: [
            {
              ...deferredMessage,
              metadata: {
                ...deferredMessage.metadata,
                groupParticipation: { decision: "respond" },
              },
            },
          ],
        }),
      ),
    ).toBe("What is 1 + 1?");
  });

  it("derives structured titles from completed GitHub import metadata", () => {
    expect(
      getStructuredConversationTitle([
        {
          id: "assistant-1",
          role: "assistant",
          authorId: null,
          content: "Imported files.",
          timestamp: Date.now(),
          files: null,
          messageType: "assistant",
          metadata: {
            githubImport: {
              repo: "example/device-provider",
            },
          },
        },
      ]),
    ).toBe("Import example/device-provider");
  });

  it("reuses pristine blank conversations, including the default assistant starter state", () => {
    expect(
      isReusableBlankConversation(
        createConversation({
          visibility: "public",
          messages: [
            {
              id: "assistant-1",
              role: "assistant",
              authorId: null,
              content: "How can I help with your space?",
              timestamp: Date.now(),
              files: null,
              messageType: "status",
              metadata: null,
            },
          ],
        }),
      ),
    ).toBe(true);

    expect(
      isReusableBlankConversation(
        createConversation({
          visibility: "public",
          draft: "hello",
          messages: [
            {
              id: "assistant-1",
              role: "assistant",
              authorId: null,
              content: "How can I help with your space?",
              timestamp: Date.now(),
              files: null,
              messageType: "status",
              metadata: null,
            },
          ],
        }),
      ),
    ).toBe(false);

    expect(
      isReusableBlankConversation(
        createConversation({
          visibility: "public",
          messages: [
            {
              id: "user-1",
              role: "user",
              authorId: null,
              content: "Build me a landing page",
              timestamp: Date.now(),
              files: null,
              messageType: "user",
              metadata: null,
            },
          ],
        }),
      ),
    ).toBe(false);
  });

  it("finds the newest reusable blank conversation", () => {
    const reusableOlder = createConversation({
      localId: "conv-older",
      visibility: "public",
      createdAt: 10,
      messages: [
        {
          id: "assistant-1",
          role: "assistant",
          authorId: null,
          content: "How can I help with your project?",
          timestamp: 10,
          files: null,
          messageType: "status",
          metadata: null,
        },
      ],
    });
    const reusableNewer = createConversation({
      localId: "conv-newer",
      visibility: "public",
      createdAt: 20,
      messages: [],
    });

    expect(
      findReusableBlankConversation([
        reusableOlder,
        createConversation({
          localId: "conv-used",
          visibility: "public",
          createdAt: 30,
          draft: "draft",
        }),
        reusableNewer,
      ])?.localId,
    ).toBe("conv-newer");
  });
});
