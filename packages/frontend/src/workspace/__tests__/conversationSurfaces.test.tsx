// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_CONVERSATION_SURFACES, closeConversationFile, conversationFileLabel, openConversationFile, readConversationSurfaces, selectConversationView, useConversationSurfacesOwner } from "../conversationSurfaces";

describe("conversation surface ownership", () => {
  beforeEach(() => { sessionStorage.clear(); });
  afterEach(() => { sessionStorage.clear(); });

  it("keeps resource selection when focusing Chat and deduplicates file references", () => {
    const file = { id: "file:notes.md", path: "notes.md", line: 4 };
    const open = openConversationFile(DEFAULT_CONVERSATION_SURFACES, file);
    const chat = selectConversationView(open, "chat");
    expect(chat.resourceId).toBe(file.id);
    expect(openConversationFile(chat, { ...file, line: 9 }).files).toEqual([{ ...file, line: 9 }]);
  });

  it("keeps open-file order and selects an adjacent file when closing", () => {
    const files = ["a.md", "b.md", "c.md"].map(path => ({ id: `file:${path}`, path }));
    let state = files.reduce(openConversationFile, DEFAULT_CONVERSATION_SURFACES);
    state = openConversationFile(state, { ...files[1], line: 12 });
    expect(state.files.map(file => file.id)).toEqual(files.map(file => file.id));
    const closed = closeConversationFile(state, files[1].id, true);
    expect(closed.resourceId).toBe(files[2].id);
    expect(closeConversationFile(closed, files[2].id, true).resourceId).toBe(files[0].id);
    const last = openConversationFile(DEFAULT_CONVERSATION_SURFACES, files[0]);
    expect(closeConversationFile(last, files[0].id, true).activeId).toBe("browser");
    expect(closeConversationFile(last, files[0].id, false).activeId).toBe("chat");
    expect(closeConversationFile(selectConversationView(state, "chat"), files[0].id, true).activeId).toBe("chat");
  });

  it("distinguishes duplicate filenames without changing their identities", () => {
    const files = ["notes.md", "drafts/notes.md"].map(path => ({ id: `file:${path}`, path }));
    expect(conversationFileLabel(files[0], files)).toBe("notes.md · .");
    expect(conversationFileLabel(files[1], files)).toBe("notes.md · drafts");
    expect(conversationFileLabel(files[1], [files[1]])).toBe("notes.md");
  });

  it("restores references and preferences, dropping unknown content and invalid selection", () => {
    sessionStorage.setItem('instafy:conversation-views:test', JSON.stringify({
      activeId: "missing", resourceId: "missing", ratio: 10, split: false,
      files: [{ id: "file:notes.md", path: "notes.md", content: "must not restore", line: -10 }, { id: "bad", path: "bad" }],
    }));
    expect(readConversationSurfaces("test")).toEqual({ activeId: "chat", resourceId: "browser", ratio: .7, split: false, files: [{ id: "file:notes.md", path: "notes.md", line: 1 }] });
    sessionStorage.setItem('instafy:conversation-views:test', '{broken');
    expect(readConversationSurfaces("test")).toBe(DEFAULT_CONVERSATION_SURFACES);
  });

  it("isolates account, project and conversation scopes and targets delayed changes at their original scope", async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const node = document.createElement("div"), root = createRoot(node);
    let owner!: ReturnType<typeof useConversationSurfacesOwner>;
    function Owner() { owner = useConversationSurfacesOwner(); return null; }
    await act(async () => root.render(<Owner />));
    const first = JSON.stringify(["user1", "project1", "chat1"]);
    const others = [["user2", "project1", "chat1"], ["user1", "project2", "chat1"], ["user1", "project1", "chat2"]].map(value => JSON.stringify(value));
    const delayed = () => owner.update(first, state => openConversationFile(state, { id: "file:a.md", path: "a.md" }));
    others.forEach(scope => owner.read(scope));
    await act(async () => delayed());
    expect(owner.read(first).resourceId).toBe("file:a.md");
    others.forEach(scope => expect(owner.read(scope)).toBe(DEFAULT_CONVERSATION_SURFACES));
    await act(async () => root.unmount());
    expect(readConversationSurfaces(first).files).toEqual([{ id: "file:a.md", path: "a.md" }]);
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });
});
