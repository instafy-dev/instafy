import { describe, expect, it } from "vitest";

import type { ChatMessage } from "../../types";
import { shouldSuppressOuterAvatarForConversationThread } from "../conversationThreadPreviewLayout";

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

describe("conversationThreadPreviewLayout", () => {
  it("suppresses the outer avatar for conversation thread previews", () => {
    const threadMessage = createMessage({
      messageType: "conversation_thread",
      metadata: { threadLocalId: "thread-local" },
    });

    expect(shouldSuppressOuterAvatarForConversationThread(threadMessage)).toBe(true);
  });

  it("keeps the outer avatar for non-thread assistant messages", () => {
    const plainMessage = createMessage({
      messageType: "assistant",
      content: "Opened bbc.com.",
    });

    expect(shouldSuppressOuterAvatarForConversationThread(plainMessage)).toBe(false);
  });
});
