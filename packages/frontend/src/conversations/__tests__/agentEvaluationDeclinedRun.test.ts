import { describe, expect, it } from "vitest";

import type { ChatMessage } from "../../screens/studio/types";
import {
  conversationsReducer,
  createInitialConversation,
  type ConversationsState,
} from "../conversationState";
import { countNewUnreadConversationMessages } from "../unreadCount";

// A declined skill-mode evaluation completes as a normal success with zero
// assistant messages: useConversationRunEffects unlinks the run, no message is
// ever appended, and unread accounting is message-driven. These tests pin the
// "record-only settle" contract the declined path relies on.
describe("declined agent evaluation run settle", () => {
  const runId = "run-declined-eval";

  function createState(): ConversationsState {
    const conversation = createInitialConversation({ localId: "shared" });
    conversation.messages = [
      {
        id: "user-ambient",
        role: "user",
        authorId: "teammate",
        content: "What do you two think about lunch?",
        timestamp: 1,
        files: null,
        messageType: null,
        metadata: null,
      } satisfies ChatMessage,
    ];
    return {
      projectKey: "project",
      conversations: [conversation],
      activeId: conversation.localId,
      sequence: 2,
      runMap: {},
    };
  }

  it("link then unlink leaves no pending-run artifact and no unread", () => {
    const initial = createState();
    const linked = conversationsReducer(initial, {
      type: "LINK_RUN",
      runId,
      conversationId: "shared",
    });
    expect(linked.runMap[runId]).toBe("shared");
    expect(linked.conversations[0]?.pendingRunIds).toEqual([runId]);
    expect(linked.conversations[0]?.awaitingLeaseRunIds).toEqual([runId]);

    const settled = conversationsReducer(linked, {
      type: "UNLINK_RUN",
      runId,
    });
    const conversation = settled.conversations[0]!;
    expect(settled.runMap[runId]).toBeUndefined();
    expect(conversation.pendingRunIds).toEqual([]);
    expect(conversation.awaitingLeaseRunIds).toEqual([]);
    expect(conversation.pendingRunSubmittedAt).toEqual({});
    // No assistant bubble, no failure styling, no unread bump: the message
    // list is exactly what a record-only turn leaves behind.
    expect(conversation.messages).toEqual(initial.conversations[0]!.messages);
    expect(conversation.unreadCount).toBe(0);
  });

  it("a run that never speaks contributes nothing to unread accounting", () => {
    const messages = createState().conversations[0]!.messages;
    // Declined evaluation: the message list before and after the run is
    // identical, so no unread increment can occur for the missing reply.
    expect(
      countNewUnreadConversationMessages(messages, messages, "viewer"),
    ).toBe(0);
  });
});
