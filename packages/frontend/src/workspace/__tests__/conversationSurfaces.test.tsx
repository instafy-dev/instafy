// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_CONVERSATION_SURFACES, closeConversationFile, closeConversationPreview, conversationFileLabel, openConversationFile, openConversationPreview, readConversationSurfaces, selectConversationView, useConversationSurfacesOwner } from "../conversationSurfaces";

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
    expect(readConversationSurfaces("test")).toEqual({ activeId: "chat", resourceId: "browser", ratio: .7, split: false, files: [{ id: "file:notes.md", path: "notes.md", line: 1 }], previews: [] });
    sessionStorage.setItem('instafy:conversation-views:test', '{broken');
    expect(readConversationSurfaces("test")).toBe(DEFAULT_CONVERSATION_SURFACES);
  });

  it("opens, refocuses and closes site preview views by id, keeping at most ten", () => {
    const pid = (index: number) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
    let state = openConversationPreview(DEFAULT_CONVERSATION_SURFACES, { previewId: pid(1), title: " Docs site " });
    expect(state).toMatchObject({ activeId: `preview:${pid(1)}`, resourceId: `preview:${pid(1)}`, previews: [{ id: `preview:${pid(1)}`, previewId: pid(1), title: "Docs site" }] });
    state = openConversationPreview(selectConversationView(state, "chat"), { previewId: pid(1), title: "Renamed" });
    expect(state.previews).toEqual([{ id: `preview:${pid(1)}`, previewId: pid(1), title: "Renamed" }]);
    expect(state.activeId).toBe(`preview:${pid(1)}`);
    for (let index = 2; index <= 12; index += 1) state = openConversationPreview(state, { previewId: pid(index), title: `Site ${index}` });
    expect(state.previews).toHaveLength(10);
    expect(state.previews[0].previewId).toBe(pid(3));
    // An address is never a preview id.
    expect(openConversationPreview(state, { previewId: "https://p-abc--def.preview.test/", title: "x" })).toBe(state);
    expect(closeConversationPreview(state, `preview:${pid(12)}`, false).activeId).toBe(`preview:${pid(11)}`);
    expect(closeConversationPreview(state, "preview:missing", false)).toBe(state);
    const withFile = openConversationPreview(openConversationFile(DEFAULT_CONVERSATION_SURFACES, { id: "file:a.md", path: "a.md" }), { previewId: pid(1), title: "One" });
    expect(closeConversationPreview(withFile, `preview:${pid(1)}`, true).activeId).toBe("file:a.md");
    expect(closeConversationFile(selectConversationView(withFile, "file:a.md"), "file:a.md", true).activeId).toBe(`preview:${pid(1)}`);
    const only = openConversationPreview(DEFAULT_CONVERSATION_SURFACES, { previewId: pid(1), title: "One" });
    expect(closeConversationPreview(only, `preview:${pid(1)}`, true).activeId).toBe("browser");
    expect(closeConversationPreview(only, `preview:${pid(1)}`, false).activeId).toBe("chat");
  });

  it("round-trips site preview references and drops bad ids, addresses and extra fields", async () => {
    const previewId = "11111111-1111-4111-8111-111111111111";
    sessionStorage.setItem("instafy:conversation-views:test", JSON.stringify({
      activeId: `preview:${previewId}`, resourceId: `preview:${previewId}`, files: [],
      previews: [
        { id: `preview:${previewId}`, previewId, title: "Docs site", viewerUrl: "https://p-abc--def.preview.test/", label: "p-abc" },
        { id: "preview:https://p-abc--def.preview.test/", previewId: "https://p-abc--def.preview.test/", title: "address" },
        { id: "preview:other", previewId: "22222222-2222-4222-8222-222222222222", title: "mismatch" },
        { id: "preview:33333333-3333-4333-8333-333333333333", previewId: "33333333-3333-4333-8333-333333333333", title: "  " },
      ],
    }));
    const restored = readConversationSurfaces("test");
    expect(restored.previews).toEqual([{ id: `preview:${previewId}`, previewId, title: "Docs site" }]);
    expect(restored.activeId).toBe(`preview:${previewId}`);
    expect(JSON.stringify(restored)).not.toContain("p-abc");
    sessionStorage.setItem("instafy:conversation-views:test", JSON.stringify({ activeId: "preview:gone", resourceId: "preview:gone", files: [] }));
    expect(readConversationSurfaces("test")).toMatchObject({ activeId: "chat", resourceId: "browser", previews: [] });

    // What the owner writes holds the id and title only, whatever the caller passed.
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const node = document.createElement("div"), root = createRoot(node);
    let owner!: ReturnType<typeof useConversationSurfacesOwner>;
    function Owner() { owner = useConversationSurfacesOwner(); return null; }
    await act(async () => root.render(<Owner />));
    const scope = JSON.stringify(["user1", "project1", "chat1"]);
    const extra = { previewId, title: "Docs site", viewerUrl: "https://p-abc--def.preview.test/" };
    await act(async () => owner.update(scope, state => openConversationPreview(state, extra)));
    await act(async () => root.unmount());
    const written = sessionStorage.getItem(`instafy:conversation-views:${scope}`) ?? "";
    expect(JSON.parse(written).previews).toEqual([{ id: `preview:${previewId}`, previewId, title: "Docs site" }]);
    expect(written).not.toContain("p-abc");
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
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
