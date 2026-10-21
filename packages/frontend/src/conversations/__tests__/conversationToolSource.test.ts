import { describe, expect, it } from "vitest";
import { isToolRootThread, toolSourceOf } from "../conversationMetadata";
import { conversationsReducer, createInitialConversation, type ConversationsState } from "../conversationState";

describe("toolSourceOf", () => {
  it("reads a trimmed tool name from metadata.source", () => {
    expect(toolSourceOf({ source: "  example-tool " })).toBe("example-tool");
  });

  it("treats a missing, empty or non-string source as a person's chat", () => {
    expect(toolSourceOf(null)).toBeNull();
    expect(toolSourceOf(undefined)).toBeNull();
    expect(toolSourceOf({})).toBeNull();
    expect(toolSourceOf({ source: "   " })).toBeNull();
    expect(toolSourceOf({ source: 42 })).toBeNull();
    expect(toolSourceOf({ source: { name: "example-tool" } })).toBeNull();
  });

  it("caps the name at 64 characters", () => {
    expect(toolSourceOf({ source: "x".repeat(100) })).toBe("x".repeat(64));
  });
});

describe("isToolRootThread", () => {
  it("is true only for a tool's thread that is not nested under a chat", () => {
    expect(isToolRootThread({ toolSource: "example-tool", parentConversationId: null })).toBe(true);
    expect(isToolRootThread({ toolSource: "example-tool", parentConversationId: "parent" })).toBe(false);
    expect(isToolRootThread({ toolSource: null, parentConversationId: null })).toBe(false);
    expect(isToolRootThread({})).toBe(false);
  });
});

describe("SET_TOOL_SOURCE", () => {
  it("sets and clears the tool source of one conversation only", () => {
    const state: ConversationsState = {
      projectKey: "space",
      conversations: [createInitialConversation({ localId: "a" }), createInitialConversation({ localId: "b" })],
      activeId: "a",
      sequence: 2,
      runMap: {},
    };
    const marked = conversationsReducer(state, { type: "SET_TOOL_SOURCE", id: "b", toolSource: "example-tool" });
    expect(marked.conversations.map((conversation) => conversation.toolSource ?? null)).toEqual([null, "example-tool"]);
    expect(marked.conversations[0]).toBe(state.conversations[0]);
    const cleared = conversationsReducer(marked, { type: "SET_TOOL_SOURCE", id: "b", toolSource: null });
    expect(cleared.conversations[1].toolSource).toBeNull();
  });
});
