import { describe, expect, it } from "vitest";

import type { ChatMessage } from "../../screens/studio/types";
import {
  countNewUnreadAssistantMessages,
  countNewUnreadConversationMessages,
  isUnreadEligibleAssistantMessage,
  isUnreadEligibleConversationMessage,
} from "../unreadCount";

function createMessage(overrides: Partial<ChatMessage>): ChatMessage {
  return {
    id: "message-id",
    role: "assistant",
    authorId: null,
    content: "",
    timestamp: Date.now(),
    files: null,
    messageType: null,
    metadata: null,
    ...overrides,
  };
}

describe("isUnreadEligibleAssistantMessage", () => {
  it("accepts assistant replies and rejects timeline/status messages", () => {
    expect(isUnreadEligibleAssistantMessage(createMessage({ role: "assistant", messageType: null }))).toBe(true);
    expect(isUnreadEligibleAssistantMessage(createMessage({ role: "assistant", messageType: "runtime_switch" }))).toBe(
      false,
    );
    expect(isUnreadEligibleAssistantMessage(createMessage({ role: "user", messageType: null }))).toBe(false);
  });
});

describe("isUnreadEligibleConversationMessage", () => {
  it("accepts messages from a teammate and rejects the current user's messages", () => {
    expect(
      isUnreadEligibleConversationMessage(
        createMessage({ role: "user", authorId: "teammate" }),
        "current-user",
      ),
    ).toBe(true);
    expect(
      isUnreadEligibleConversationMessage(
        createMessage({ role: "user", authorId: "current-user" }),
        "current-user",
      ),
    ).toBe(false);
  });

  it("does not treat a user message as unread when its ownership is unknown", () => {
    expect(
      isUnreadEligibleConversationMessage(
        createMessage({ role: "user", authorId: null }),
        "current-user",
      ),
    ).toBe(false);
    expect(
      isUnreadEligibleConversationMessage(
        createMessage({ role: "user", authorId: "teammate" }),
        null,
      ),
    ).toBe(false);
  });

  it("preserves assistant eligibility regardless of the current user", () => {
    expect(
      isUnreadEligibleConversationMessage(
        createMessage({ role: "assistant", authorId: null }),
        "current-user",
      ),
    ).toBe(true);
    expect(
      isUnreadEligibleConversationMessage(
        createMessage({
          role: "assistant",
          authorId: null,
          messageType: "runtime_switch",
        }),
        "current-user",
      ),
    ).toBe(false);
  });
});

describe("countNewUnreadAssistantMessages", () => {
  it("counts only new non-timeline assistant messages", () => {
    const previous = [
      createMessage({ id: "u-1", role: "user", content: "hi", timestamp: 1 }),
      createMessage({ id: "a-1", role: "assistant", messageType: "runtime_switch", content: "switching", timestamp: 2 }),
    ];
    const next = [
      ...previous,
      createMessage({ id: "a-2", role: "assistant", content: "Here is your poem", timestamp: 3 }),
      createMessage({ id: "a-3", role: "assistant", messageType: "todo_list", content: "plan", timestamp: 4 }),
    ];

    expect(countNewUnreadAssistantMessages(previous, next)).toBe(1);
  });

  it("does not recount messages with the same id", () => {
    const previous = [createMessage({ id: "a-1", content: "existing", timestamp: 1 })];
    const next = [...previous, createMessage({ id: "a-1", content: "existing", timestamp: 1 })];
    expect(countNewUnreadAssistantMessages(previous, next)).toBe(0);
  });

  it("uses fallback signature when id is missing", () => {
    const previous = [createMessage({ id: "", content: "same", timestamp: 10 })];
    const next = [
      ...previous,
      createMessage({ id: "", content: "same", timestamp: 10 }),
      createMessage({ id: "", content: "new", timestamp: 11 }),
    ];
    expect(countNewUnreadAssistantMessages(previous, next)).toBe(1);
  });
});

describe("countNewUnreadConversationMessages", () => {
  it("counts a new teammate message and assistant reply, but not the current user's message", () => {
    const previous = [
      createMessage({
        id: "existing",
        role: "user",
        authorId: "teammate",
        content: "Existing",
        timestamp: 1,
      }),
    ];
    const next = [
      ...previous,
      createMessage({
        id: "teammate-new",
        role: "user",
        authorId: "teammate",
        content: "From the other phone",
        timestamp: 2,
      }),
      createMessage({
        id: "own-new",
        role: "user",
        authorId: "current-user",
        content: "From this account",
        timestamp: 3,
      }),
      createMessage({
        id: "assistant-new",
        role: "assistant",
        content: "Assistant reply",
        timestamp: 4,
      }),
    ];

    expect(
      countNewUnreadConversationMessages(previous, next, "current-user"),
    ).toBe(2);
  });
});
