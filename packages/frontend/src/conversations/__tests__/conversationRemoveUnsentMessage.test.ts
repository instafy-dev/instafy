import { describe, expect, it } from "vitest";

import type { ChatMessage } from "../../screens/studio/types";
import {
  conversationsReducer,
  createInitialConversation,
  type ConversationsState,
} from "../conversationState";

function message(overrides: Partial<ChatMessage>): ChatMessage {
  return {
    id: "message-id",
    role: "user",
    authorId: "user-1",
    content: "Fix the failing login test",
    timestamp: 1,
    files: null,
    messageType: null,
    metadata: null,
    ...overrides,
  };
}

const UNSENT = message({ id: "local-2", metadata: { clientMessageId: "client-2", turnEngine: "claude-code" } });

function stateWith(messages: ChatMessage[]): ConversationsState {
  const chat = { ...createInitialConversation({ localId: "chat" }), messages };
  const other = { ...createInitialConversation({ localId: "other" }), messages: [UNSENT] };
  return { projectKey: "project", conversations: [chat, other], activeId: chat.localId, sequence: 2, runMap: {} };
}

// docs/Local-Engine-Turns.md 5.5: a send the controller refused was never
// recorded, so only this page's copy of the person's message goes.
describe("REMOVE_UNSENT_MESSAGE", () => {
  it("takes the person's unsent message out of that chat only, by its client id", () => {
    const earlier = message({ id: "server-1", metadata: { clientMessageId: "client-1" } });
    const refusal = message({
      id: "error-1",
      role: "assistant",
      content: "Your computer is busy with another turn. Send this when it's done.",
      messageType: "error",
      metadata: { messageType: "error" },
    });
    const next = conversationsReducer(stateWith([earlier, UNSENT, refusal]), {
      type: "REMOVE_UNSENT_MESSAGE",
      id: "chat",
      clientMessageId: "client-2",
    });

    expect(next.conversations[0]?.messages.map((entry) => entry.id)).toEqual(["server-1", "error-1"]);
    // Another chat's message with the same client id stays.
    expect(next.conversations[1]?.messages.map((entry) => entry.id)).toEqual(["local-2"]);
  });

  it("never takes out an assistant message, and changes nothing when no message matches", () => {
    const reply = message({ id: "reply-1", role: "assistant", metadata: { clientMessageId: "client-2" } });
    const state = stateWith([reply]);
    const next = conversationsReducer(state, { type: "REMOVE_UNSENT_MESSAGE", id: "chat", clientMessageId: "client-2" });
    expect(next).toBe(state);
    expect(
      conversationsReducer(state, { type: "REMOVE_UNSENT_MESSAGE", id: "chat", clientMessageId: "client-9" }),
    ).toBe(state);
  });
});
