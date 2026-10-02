// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createInitialConversation, type ConversationsState } from "../conversationState";
import { restoreConversationDrafts, saveConversationDrafts } from "../conversationDraftStorage";

function state(projectKey = "space-a"): ConversationsState {
  return { projectKey, conversations: [createInitialConversation({ localId: "new-chat" })],
    activeId: "new-chat", sequence: 2, runMap: {} };
}
beforeEach(() => { sessionStorage.clear(); vi.restoreAllMocks(); });

describe("conversation draft reloads", () => {
  it("restores both a never-sent chat and an established chat without persisting history", () => {
    const original = state();
    original.conversations[0].draft = "Keep my first draft";
    original.conversations[0].draftEditorState = '{"root":{}}';
    original.conversations.push({ ...createInitialConversation({ localId: "saved-chat",
      controllerId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" }), draft: "Next message", title: "Shopping" });
    original.sequence = 3;
    saveConversationDrafts("user-a", original);
    const reloaded = restoreConversationDrafts("user-a", state());
    expect(reloaded.conversations.map(c => [c.localId, c.draft])).toEqual([
      ["new-chat", "Keep my first draft"], ["saved-chat", "Next message"],
    ]);
    expect(reloaded.conversations[0].draftEditorState).toBe('{"root":{}}');
    expect(reloaded.conversations[1].controllerId).toBe("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");
    expect(reloaded.sequence).toBe(3);
    expect(sessionStorage.getItem(sessionStorage.key(0)!)).not.toMatch(/messages|runtime|runMap/);
  });

  it("marks a controller chat rebuilt from a saved draft until the chat list confirms it", () => {
    const original = state();
    original.conversations[0].draft = "Never sent";
    original.conversations.push({ ...createInitialConversation({ localId: "saved-chat",
      controllerId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" }), draft: "Next message" });
    saveConversationDrafts("user-a", original);
    const reloaded = restoreConversationDrafts("user-a", state());
    expect(reloaded.conversations.map(c => [c.localId, c.remoteSummaryPending ?? false])).toEqual([
      ["new-chat", false], ["saved-chat", true],
    ]);
    // A chat already loaded with its controller identity keeps what it has.
    const loaded = state();
    loaded.conversations.push({ ...createInitialConversation({ localId: "saved-chat",
      controllerId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" }), title: "Shopping" });
    const merged = restoreConversationDrafts("user-a", loaded);
    expect(merged.conversations[1]).toMatchObject({ draft: "Next message", title: "Shopping" });
    expect(merged.conversations[1].remoteSummaryPending).toBeUndefined();
  });

  it("isolates accounts and spaces, and removes a sent or cleared draft", () => {
    const original = state(); original.conversations[0].draft = "Private draft";
    saveConversationDrafts("user-a", original);
    expect(restoreConversationDrafts("user-b", state()).conversations[0].draft).toBe("");
    expect(restoreConversationDrafts("user-a", state("space-b")).conversations[0].draft).toBe("");
    original.conversations[0].draft = "";
    saveConversationDrafts("user-a", original);
    expect(restoreConversationDrafts("user-a", state()).conversations[0].draft).toBe("");
    expect(sessionStorage.length).toBe(0);
  });

  it("restores a private controller identity onto the URL's empty placeholder", () => {
    const original = state();
    Object.assign(original.conversations[0], { draft: "Private", visibility: "private",
      controllerId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" });
    saveConversationDrafts("user-a", original);
    expect(restoreConversationDrafts("user-a", state()).conversations[0]).toMatchObject({
      draft: "Private", visibility: "private", controllerId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    });
  });

  it("keeps a newer mounted draft and tolerates blocked or malformed storage", () => {
    const original = state(); original.conversations[0].draft = "Old text";
    saveConversationDrafts("user-a", original);
    const mounted = state(); mounted.conversations[0].draft = "New text";
    expect(restoreConversationDrafts("user-a", mounted).conversations[0].draft).toBe("New text");
    sessionStorage.setItem(sessionStorage.key(0)!, "{broken");
    expect(restoreConversationDrafts("user-a", mounted)).toBe(mounted);
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
    expect(() => saveConversationDrafts("user-a", mounted)).not.toThrow();
  });

  it("keeps closed drafts closed and removes deleted drafts", () => {
    const original = state();
    Object.assign(original.conversations[0], { draft: "Keep closed", lifecycleStatus: "hidden" });
    saveConversationDrafts("user-a", original);
    expect(restoreConversationDrafts("user-a", state()).conversations[0].lifecycleStatus).toBe("hidden");
    original.conversations[0].lifecycleStatus = "deleted";
    saveConversationDrafts("user-a", original);
    expect(sessionStorage.length).toBe(0);
  });
});
