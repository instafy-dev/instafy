import { describe, expect, it } from "vitest";
import { conversationsReducer, type ConversationState, type ConversationsState } from "../conversationState";

function conversation(localId: string): ConversationState {
  return {
    localId,
    controllerId: null,
    title: "New chat",
    messages: [],
    pendingRunIds: [],
    awaitingLeaseRunIds: [],
    pendingRunSubmittedAt: {},
  } as unknown as ConversationState;
}

function state(): ConversationsState {
  return {
    projectKey: "project-1",
    conversations: [conversation("chat-a"), conversation("chat-b")],
    activeId: "chat-a",
    sequence: 2,
    runMap: {},
  };
}

// A send on its way to the controller marks its chat, so the typing row shows
// from the press of Send instead of from the controller's answer.
describe("a chat's sends on their way to the controller", () => {
  it("marks each send of a chat until it ends, and only that chat", () => {
    let next = conversationsReducer(state(), { type: "BEGIN_DISPATCH", conversationId: "chat-a", token: "send-1", at: 100 });
    next = conversationsReducer(next, { type: "BEGIN_DISPATCH", conversationId: "chat-a", token: "send-2", at: 200 });
    expect(next.conversations[0]?.dispatchingSince).toEqual({ "send-1": 100, "send-2": 200 });
    expect(next.conversations[1]?.dispatchingSince).toBeUndefined();

    next = conversationsReducer(next, { type: "END_DISPATCH", conversationId: "chat-a", token: "send-1" });
    expect(next.conversations[0]?.dispatchingSince).toEqual({ "send-2": 200 });
    next = conversationsReducer(next, { type: "END_DISPATCH", conversationId: "chat-a", token: "send-2" });
    expect(next.conversations[0]?.dispatchingSince).toEqual({});
  });

  it("changes nothing for a send it never marked, or a chat it does not hold", () => {
    const before = conversationsReducer(state(), { type: "BEGIN_DISPATCH", conversationId: "chat-a", token: "send-1", at: 100 });
    expect(conversationsReducer(before, { type: "END_DISPATCH", conversationId: "chat-a", token: "other" })).toBe(before);
    expect(conversationsReducer(before, { type: "END_DISPATCH", conversationId: "chat-b", token: "send-1" })).toBe(before);
    expect(conversationsReducer(before, { type: "BEGIN_DISPATCH", conversationId: "gone", token: "send-9", at: 1 })).toBe(before);
  });
});
