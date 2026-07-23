import { describe, expect, it } from "vitest";

import type { ChatMessage } from "../../screens/studio/types";
import {
  conversationsReducer,
  createInitialConversation,
  type ConversationsState,
} from "../conversationState";

function createMessage(overrides: Partial<ChatMessage>): ChatMessage {
  return {
    id: "message-id",
    role: "user",
    authorId: "teammate",
    content: "Hello from another device",
    timestamp: 1,
    files: null,
    messageType: null,
    metadata: null,
    ...overrides,
  };
}

function createState(): ConversationsState {
  const active = createInitialConversation({ localId: "active" });
  const inactive = createInitialConversation({ localId: "inactive" });
  return {
    projectKey: "project",
    conversations: [active, inactive],
    activeId: active.localId,
    sequence: 3,
    runMap: {},
  };
}

describe("remote message unread state", () => {
  it("increments an inactive conversation for a teammate's message", () => {
    const next = conversationsReducer(createState(), {
      type: "APPLY_REMOTE_MESSAGE",
      conversationId: "inactive",
      message: createMessage({ authorId: "teammate" }),
      currentUserId: "current-user",
    });

    expect(next.conversations[1]?.unreadCount).toBe(1);
  });

  it("does not increment for the current user's message from another device", () => {
    const next = conversationsReducer(createState(), {
      type: "APPLY_REMOTE_MESSAGE",
      conversationId: "inactive",
      message: createMessage({ authorId: "current-user" }),
      currentUserId: "current-user",
    });

    expect(next.conversations[1]?.unreadCount).toBe(0);
  });

  it("preserves assistant unread behavior", () => {
    const next = conversationsReducer(createState(), {
      type: "APPLY_REMOTE_MESSAGE",
      conversationId: "inactive",
      message: createMessage({ role: "assistant", authorId: null }),
      currentUserId: "current-user",
    });

    expect(next.conversations[1]?.unreadCount).toBe(1);
  });

  it("keeps the reducer's current conversation read when a remote assistant message arrives", () => {
    const state = createState();
    state.conversations[0] = {
      ...state.conversations[0]!,
      unreadCount: 1,
    };

    const next = conversationsReducer(state, {
      type: "APPLY_REMOTE_MESSAGE",
      conversationId: "active",
      message: createMessage({ role: "assistant", authorId: null }),
      currentUserId: "current-user",
    });

    expect(next.conversations[0]?.unreadCount).toBe(0);
  });
});
