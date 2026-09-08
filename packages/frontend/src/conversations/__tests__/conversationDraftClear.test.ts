import { describe, expect, it } from "vitest";
import { conversationsReducer, createInitialConversation, type ConversationsState } from "../conversationState";

function state(): ConversationsState {
  return { projectKey: "project-a", activeId: "chat-b", sequence: 2, runMap: {}, conversations: [
    { ...createInitialConversation({ localId: "chat-a" }), draft: "Inspect image", draftEditorState: "editor-a" },
    { ...createInitialConversation({ localId: "chat-b" }), draft: "Inspect image", draftEditorState: "editor-b" },
  ] };
}
const clear = { type: "CLEAR_SUBMITTED_DRAFT" as const, projectKey: "project-a", id: "chat-a", draft: "Inspect image", editorState: "editor-a" };

describe("conditional submitted draft cleanup", () => {
  it("clears only the unchanged originating draft even when another chat is selected", () => {
    const previous = state();
    const next = conversationsReducer(previous, clear);
    expect(next.conversations[0]).toMatchObject({ draft: "", draftEditorState: null });
    expect(next.conversations[1]).toBe(previous.conversations[1]);
    expect(next.activeId).toBe("chat-b");
  });
  it.each([{ draft: "New text" }, { draftEditorState: "new mention target" }])("preserves a newer draft %j", (change) => {
    const previous = state();
    previous.conversations[0] = { ...previous.conversations[0], ...change };
    expect(conversationsReducer(previous, clear)).toBe(previous);
  });
  it("cannot clear an identical conversation ID in another project", () => {
    const previous = { ...state(), projectKey: "project-b" };
    expect(conversationsReducer(previous, clear)).toBe(previous);
  });
});
