// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createInitialConversation, type ConversationState } from "../../../../conversations/conversationState";
import { useConversationPreviewThreads } from "../useConversationPreviewThreads";

let threads: readonly ConversationState[];
function Probe({ conversations, parentId }: { conversations: ConversationState[]; parentId: string | null }) {
  threads = useConversationPreviewThreads(conversations, parentId);
  return null;
}

describe("useConversationPreviewThreads", () => {
  let root: Root;
  let container: HTMLDivElement;
  const parent = {
    ...createInitialConversation({ localId: "parent" }), controllerId: "parent-controller",
  };
  const child = {
    ...createInitialConversation({ localId: "child" }), controllerId: "child-controller",
    parentConversationId: "parent-controller", createdAt: 100,
  };

  async function render(conversations: ConversationState[], parentId: string | null = "parent-controller") {
    await act(async () => { root.render(<Probe conversations={conversations} parentId={parentId} />); });
  }

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("retains list identity for active or child draft-only updates", async () => {
    await render([parent, child]);
    const first = threads;
    await render([{ ...parent, draft: "New parent draft", draftEditorState: "serialized" }, child]);
    expect(threads).toBe(first);
    await render([parent, { ...child, draft: "New child draft", draftEditorState: "serialized", unreadCount: 2 }]);
    expect(threads).toBe(first);
    await render([parent, { ...child, pendingRunIds: [], awaitingLeaseRunIds: [], extraAgentHandles: ["other-agent"] }]);
    expect(threads).toBe(first);
  });

  it.each<Partial<ConversationState>>([
    { messages: [{ id: "message-1", role: "assistant", content: "New reply", timestamp: 200 }] },
    { pendingRunIds: ["run-1"] },
    { awaitingLeaseRunIds: ["run-1"] },
    { ownerAgent: { id: "agent-1", handle: "worker" } },
    { parentConversationId: "other-parent" },
    { lifecycleStatus: "hidden" },
    { controllerId: "replacement-controller" },
    { localId: "replacement-local" },
    { createdAt: 101 },
  ])("updates when preview input changes: %j", async (change) => {
    await render([parent, child]);
    const first = threads;
    const updated = { ...child, ...change };
    await render([parent, updated]);
    expect(threads).not.toBe(first);
    expect(threads).toEqual(updated.parentConversationId === "parent-controller" ? [updated] : []);
  });

  it("keeps chronological order and updates additions, deletion, and parent selection", async () => {
    const earlier = { ...child, localId: "earlier", controllerId: "earlier-controller", createdAt: 50 };
    const anotherParent = { ...child, localId: "other", parentConversationId: "other-parent", createdAt: 1 };
    await render([child, anotherParent, earlier, parent]);
    expect(threads.map((thread) => thread.localId)).toEqual(["earlier", "child"]);
    const first = threads;
    await render([parent, earlier, anotherParent, child]);
    expect(threads).toBe(first);

    const middle = { ...child, localId: "middle", controllerId: "middle-controller", createdAt: 75 };
    await render([child, middle, parent, earlier]);
    expect(threads.map((thread) => thread.localId)).toEqual(["earlier", "middle", "child"]);

    await render([parent, earlier, { ...child, lifecycleStatus: "deleted" }, anotherParent]);
    expect(threads.map((thread) => thread.localId)).toEqual(["earlier"]);
    await render([parent, earlier, child, anotherParent], "other-parent");
    expect(threads).toEqual([anotherParent]);
    await render([parent, earlier, child, anotherParent], null);
    expect(threads).toEqual([]);
  });

  it("observes run order and owner changes without treating equal copies as updates", async () => {
    const running = { ...child, pendingRunIds: ["run-1", "run-2"], ownerAgent: { id: "agent-1", handle: "worker" } };
    await render([running]);
    const first = threads;
    await render([{ ...running, pendingRunIds: ["run-1", "run-2"], ownerAgent: { ...running.ownerAgent } }]);
    expect(threads).toBe(first);
    await render([{ ...running, pendingRunIds: ["run-2", "run-1"] }]);
    expect(threads).not.toBe(first);
    await render([{ ...running, ownerAgent: { id: "agent-1", handle: "renamed-worker" } }]);
    expect(threads[0].ownerAgent?.handle).toBe("renamed-worker");
  });
});
