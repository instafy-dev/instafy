// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createInitialConversation } from "../../conversations/conversationState";
import { useRecentConversations, type UseRecentConversationsOptions } from "../useRecentConversations";

function conversation(id: string, overrides: Partial<ReturnType<typeof createInitialConversation>> = {}) {
  return {
    ...createInitialConversation({ localId: id }),
    title: `Chat ${id}`,
    controllerId: `remote-${id}`,
    ...overrides,
  };
}

function Probe(props: UseRecentConversationsOptions) {
  const recent = useRecentConversations(props);
  return <div>{recent.map((chat) => (
    <span key={chat.localId} data-id={chat.localId} data-draft={chat.draft} data-unread={chat.unreadCount} data-runs={chat.pendingRunIds.join(",")}>
      {chat.title}
    </span>
  ))}</div>;
}

describe("useRecentConversations", () => {
  let root: Root;
  let container: HTMLDivElement;
  let options: UseRecentConversationsOptions;

  const ids = () => [...container.querySelectorAll("[data-id]")].map((row) => row.getAttribute("data-id"));
  const storedVisits = () => Object.entries(window.localStorage)
    .filter(([key]) => key.startsWith("instafy.workspace.recent-conversations:"))
    .map(([key, value]) => ({ scope: JSON.parse(key.slice(key.indexOf(":") + 1)), ids: JSON.parse(value) }));
  async function render(next: Partial<UseRecentConversationsOptions> = {}) {
    options = { ...options, ...next };
    await act(async () => root.render(<Probe {...options} />));
  }

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    window.localStorage.clear();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    options = {
      conversations: [conversation("a"), conversation("b"), conversation("c")],
      activeConversationId: null,
      userId: "user-1",
      projectKey: "space-1",
      historyResolved: true,
    };
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("keeps visible rows stable while persisting true visit order as IDs", async () => {
    await render();
    expect(ids()).toEqual(["a", "b", "c"]);
    await render({ activeConversationId: "b" });
    await render({ activeConversationId: "c" });
    await render({ activeConversationId: "b" });
    expect(ids()).toEqual(["a", "b", "c"]);
    expect(storedVisits()).toEqual([{ scope: ["user-1", "space-1"], ids: ["b", "c"] }]);
  });

  it("keeps a conversation recent after closing its tab or visiting a non-chat panel", async () => {
    await render({ activeConversationId: "b" });
    await render({ activeConversationId: "c" });
    await render({ activeConversationId: null });
    expect(ids()).toEqual(["b", "a", "c"]);
    await act(async () => root.unmount());
    root = createRoot(container);
    await render();
    expect(ids()).toEqual(["c", "b", "a"]);
  });

  it("isolates visits by account, guest, and space even when local IDs overlap", async () => {
    await render({ activeConversationId: "c" });
    await render({ projectKey: "space-2", activeConversationId: null });
    expect(ids()).toEqual(["a", "b", "c"]);
    await render({ activeConversationId: "b" });
    await render({ projectKey: "space-1", userId: "user-2", activeConversationId: null });
    expect(ids()).toEqual(["a", "b", "c"]);
    await render({ activeConversationId: "a" });
    await render({ userId: null, activeConversationId: null });
    expect(ids()).toEqual(["a", "b", "c"]);
    await render({ activeConversationId: "b" });
    await render({ userId: "user-1", activeConversationId: null });
    expect(ids()).toEqual(["c", "a", "b"]);
    await render({ projectKey: "space-2" });
    expect(ids()).toEqual(["b", "a", "c"]);
    expect(storedVisits()).toHaveLength(4);
  });

  it("retains current selection and visit order during incomplete history refreshes", async () => {
    await render({ activeConversationId: "b" });
    await render({ activeConversationId: "c" });
    await render({ conversations: [], historyResolved: false });
    expect(ids()).toEqual(["c"]);
    expect(storedVisits()[0].ids).toEqual(["c", "b"]);
    await render({ conversations: [conversation("c", { title: "Updated title" }), conversation("a"), conversation("b")], historyResolved: true });
    expect(ids()).toEqual(["b", "a", "c"]);
    expect(container.querySelector('[data-id="c"]')?.textContent).toBe("Updated title");
    await render({ conversations: [conversation("a"), conversation("b")] });
    expect(ids()).toEqual(["b", "a"]);
    expect(storedVisits()[0].ids).toEqual(["b"]);
  });

  it("does not restore another scope's cached active chat while history loads", async () => {
    await render({ activeConversationId: "c" });
    await render({ conversations: [], projectKey: "space-2", historyResolved: false });
    expect(ids()).toEqual([]);
    await render({ conversations: [conversation("c", { title: "Space two chat" })], historyResolved: true });
    expect(container.textContent).toBe("Space two chat");
    await render({ conversations: [], userId: "user-2", historyResolved: false });
    expect(ids()).toEqual([]);
  });

  it("excludes archived, hidden, deleted, and inactive empty placeholders", async () => {
    await render({
      conversations: [
        conversation("archived", { lifecycleStatus: "archived" }),
        conversation("hidden", { lifecycleStatus: "hidden" }),
        conversation("deleted", { lifecycleStatus: "deleted" }),
        conversation("placeholder", { controllerId: null }),
        conversation("draft", { controllerId: null, draft: "Keep my draft" }),
        conversation("remote"),
      ],
      activeConversationId: "archived",
    });
    expect(ids()).toEqual(["draft", "remote"]);
    await render({ activeConversationId: "remote" });
    await render({ conversations: [conversation("remote", { lifecycleStatus: "deleted" })], historyResolved: false });
    expect(ids()).toEqual([]);
  });

  it("hides the initial unresolved placeholder but keeps a legitimate active blank chat", async () => {
    await render({ conversations: [conversation("blank", { controllerId: null })], activeConversationId: "blank", historyResolved: false });
    expect(ids()).toEqual([]);
    await render({ historyResolved: true });
    expect(ids()).toEqual(["blank"]);
    await render({ historyResolved: false });
    expect(ids()).toEqual(["blank"]);
    await render({ activeConversationId: null, historyResolved: true });
    expect(ids()).toEqual([]);
  });

  it("limits visible chats to six and bounds persisted visits independently", async () => {
    const conversations = Array.from({ length: 55 }, (_, index) => conversation(`chat-${index}`));
    await render({ conversations });
    expect(ids()).toHaveLength(6);
    for (const chat of conversations) await render({ activeConversationId: chat.localId });
    expect(ids()).toEqual(["chat-54", "chat-53", "chat-52", "chat-51", "chat-50", "chat-49"]);
    expect(storedVisits()[0].ids).toHaveLength(50);
    await render({ limit: 3 });
    expect(ids()).toEqual(["chat-54", "chat-53", "chat-52"]);
  });

  it("initializes from the active chat, persisted visits, and provider fallback in that order", async () => {
    window.localStorage.setItem('instafy.workspace.recent-conversations:["user-1","space-1"]', JSON.stringify(["c", "b"]));
    await render({ conversations: [conversation("a"), conversation("b"), conversation("c"), conversation("d")], activeConversationId: "a" });
    expect(ids()).toEqual(["a", "c", "b", "d"]);
    await render({ activeConversationId: "b" });
    expect(ids()).toEqual(["a", "c", "b", "d"]);
    expect(storedVisits()[0].ids).toEqual(["b", "a", "c"]);
  });

  it("updates visible chat content without moving rows when provider order or activity changes", async () => {
    await render({ activeConversationId: "b" });
    await render({
      conversations: [
        conversation("c", { title: "Renamed chat", unreadCount: 4, pendingRunIds: ["run-c"] }),
        conversation("b", { draft: "unfinished", awaitingLeaseRunIds: ["run-b"] }),
        conversation("a"),
      ],
      activeConversationId: "c",
    });
    expect(ids()).toEqual(["b", "a", "c"]);
    expect(container.querySelector('[data-id="c"]')?.textContent).toBe("Renamed chat");
    expect(container.querySelector('[data-id="c"]')?.getAttribute("data-unread")).toBe("4");
    expect(container.querySelector('[data-id="c"]')?.getAttribute("data-runs")).toBe("run-c");
    expect(container.querySelector('[data-id="b"]')?.getAttribute("data-draft")).toBe("unfinished");
    expect(storedVisits()[0].ids).toEqual(["c", "b"]);
    await render({ conversations: [conversation("d"), ...options.conversations] });
    expect(ids()).toEqual(["b", "a", "c", "d"]);
  });

  it("inserts an outside selection first and evicts the least recently visited visible chat", async () => {
    const conversations = "abcdefgh".split("").map((id) => conversation(id));
    await render({ conversations });
    for (const id of "abcdef") await render({ activeConversationId: id });
    await render({ activeConversationId: "a" });
    expect(ids()).toEqual(["a", "b", "c", "d", "e", "f"]);
    expect(storedVisits()[0].ids).toEqual(["a", "f", "e", "d", "c", "b"]);
    await render({ activeConversationId: "g" });
    expect(ids()).toEqual(["g", "a", "c", "d", "e", "f"]);
    expect(storedVisits()[0].ids).toEqual(["g", "a", "f", "e", "d", "c", "b"]);
    await render({ activeConversationId: "f" });
    expect(ids()).toEqual(["g", "a", "c", "d", "e", "f"]);
  });

  it("fills removed-chat vacancies from visits then history without moving surviving rows", async () => {
    const conversations = "abcdefgh".split("").map((id) => conversation(id));
    await render({ conversations });
    for (const id of "abcdefag") await render({ activeConversationId: id });
    expect(ids()).toEqual(["g", "a", "c", "d", "e", "f"]);
    await render({ conversations: conversations.map((chat) =>
      chat.localId === "c" || chat.localId === "e"
        ? { ...chat, lifecycleStatus: "archived" as const }
        : chat),
    });
    expect(ids()).toEqual(["g", "a", "d", "f", "b", "h"]);
    expect(storedVisits()[0].ids).toEqual(["g", "a", "f", "d", "b"]);
  });

  it.each(["invalid JSON", JSON.stringify({ ids: ["b"] }), JSON.stringify([null, 3, "", "b", "b", "c"])])(
    "tolerates malformed storage (%s)", async (value) => {
      window.localStorage.setItem('instafy.workspace.recent-conversations:["user-1","space-1"]', value);
      await render();
      expect(ids()).toEqual(value.startsWith("[") ? ["b", "c", "a"] : ["a", "b", "c"]);
    },
  );

  it("keeps visits in memory when browser storage is unavailable", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("Unavailable"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("Unavailable"); });
    await render({ activeConversationId: "c" });
    await render({ activeConversationId: "b" });
    await render({ activeConversationId: null });
    expect(ids()).toEqual(["c", "a", "b"]);
  });
});
