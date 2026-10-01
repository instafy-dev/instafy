// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createInitialConversation } from "../../conversations/conversationState";
import { useStartConversationThread } from "../useStartConversationThread";

const mocks = vi.hoisted(() => ({
  projectId: "11111111-1111-4111-8111-111111111111",
  conversations: [] as ReturnType<typeof createInitialConversation>[],
  createConversation: vi.fn(), setConversationControllerId: vi.fn(),
  createBlank: vi.fn(), showStatus: vi.fn(), openConversationTab: vi.fn(), requestUrlPush: vi.fn(),
}));
vi.mock("../../conversations/ConversationsProvider", () => ({ useConversations: () => mocks }));
vi.mock("../../projects/useProject", () => ({ useProject: () => ({ activeProjectId: mocks.projectId }) }));
vi.mock("../../sdk/instafy", () => ({ controllerClient: { conversations: { createBlank: mocks.createBlank } } }));
vi.mock("../../status/useStatus", () => ({ useStatus: () => mocks }));
vi.mock("../WorkspaceTabsProvider", () => ({ useWorkspaceTabs: () => mocks }));

describe("starting a conversation thread", () => {
  let root: Root;
  let container: HTMLDivElement;
  let start: (id: string) => Promise<void>;
  const onStarted = vi.fn();
  function Harness() { start = useStartConversationThread(onStarted); return null; }
  beforeEach(async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.clearAllMocks();
    mocks.projectId = "11111111-1111-4111-8111-111111111111";
    mocks.conversations = [{ ...createInitialConversation({ localId: "parent" }), title: "Private chat", visibility: "private" }];
    mocks.createConversation.mockImplementation(options => ({ ...createInitialConversation({ localId: "child" }), ...options }));
    mocks.createBlank.mockReset();
    container = document.createElement("div");
    root = createRoot(container);
    await act(async () => root.render(<Harness />));
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });
  it("keeps parent privacy and opens the registered child before closing mobile navigation", async () => {
    mocks.createBlank.mockResolvedValueOnce({ conversationId: "parent-controller" }).mockResolvedValueOnce({ conversationId: "child-controller" });
    await act(async () => start("parent"));
    expect(mocks.createConversation).toHaveBeenCalledWith(expect.objectContaining({ visibility: "private", parentConversationId: "parent-controller", select: false }));
    expect(mocks.createBlank).toHaveBeenLastCalledWith(expect.objectContaining({ parentConversationId: "parent-controller", metadata: { title: "Thread 1", localId: "child", visibility: "private" } }));
    expect(mocks.setConversationControllerId).toHaveBeenLastCalledWith("child", "child-controller");
    expect(mocks.openConversationTab).toHaveBeenCalledWith("child");
    expect(onStarted).toHaveBeenCalledTimes(1);
  });
  it("does not create or navigate a thread in a different space after a delayed parent response", async () => {
    let resolve!: (value: { conversationId: string }) => void;
    mocks.createBlank.mockImplementation(() => new Promise(done => { resolve = done; }));
    let pending!: Promise<void>;
    await act(async () => { pending = start("parent"); });
    mocks.projectId = "22222222-2222-4222-8222-222222222222";
    await act(async () => root.render(<Harness />));
    await act(async () => { resolve({ conversationId: "parent-controller" }); await pending; });
    expect(mocks.createConversation).not.toHaveBeenCalled();
    expect(mocks.openConversationTab).not.toHaveBeenCalled();
  });
  it("reports a controller failure without opening a missing thread", async () => {
    mocks.createBlank.mockRejectedValue(new Error("offline"));
    await act(async () => start("parent"));
    expect(mocks.showStatus).toHaveBeenCalledWith(expect.stringContaining("Could not create"), "error", 4000);
    expect(mocks.openConversationTab).not.toHaveBeenCalled();
  });
});
