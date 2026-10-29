// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversationState } from "../../../conversations/ConversationsProvider";
import { NEW_CHAT_GREETING, useStartNewChat } from "../useStartNewChat";

const PROJECT = "11111111-1111-4111-8111-111111111111";

const mocks = vi.hoisted(() => ({
  conversations: [] as ConversationState[],
  activeConversationId: null as string | null,
  createConversation: vi.fn(),
  markConversationRead: vi.fn(),
  selectConversation: vi.fn(),
  setConversationControllerId: vi.fn(),
  createBlank: vi.fn(),
}));

vi.mock("../../../conversations/ConversationsProvider", () => ({
  useConversations: () => ({
    conversations: mocks.conversations,
    activeConversationId: mocks.activeConversationId,
    createConversation: mocks.createConversation,
    markConversationRead: mocks.markConversationRead,
    selectConversation: mocks.selectConversation,
    setConversationControllerId: mocks.setConversationControllerId,
  }),
}));
vi.mock("../../../sdk/instafy", () => ({
  controllerClient: { conversations: { createBlank: mocks.createBlank } },
}));

function chat(overrides: Partial<ConversationState>): ConversationState {
  return {
    localId: "chat", controllerId: null, title: "New chat", visibility: "public", lifecycleStatus: "active",
    parentConversationId: null, threadKind: null, ownerAgent: null, activeGoal: null, originMessageId: null,
    delegatedByAgentId: null, messages: [], draft: "", draftEditorState: null, assistantEnabled: true,
    extraAgentHandles: [], unreadCount: 0, createdAt: 1, pendingRunIds: [], awaitingLeaseRunIds: [],
    pendingRunSubmittedAt: {}, runtimePreference: null, ...overrides,
  } as ConversationState;
}

const greeting = (id: string) => ({
  id, role: "assistant" as const, content: NEW_CHAT_GREETING, timestamp: 1, files: null, messageType: "status", metadata: null,
});

describe("New chat", () => {
  let container: HTMLDivElement;
  let root: Root;
  let start: () => void;
  const beforeOpen = vi.fn();
  const openTab = vi.fn();

  function Probe() {
    start = useStartNewChat({ activeProjectId: PROJECT, beforeOpen, openTab });
    return null;
  }

  async function render() {
    await act(async () => root.render(<Probe />));
  }

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.clearAllMocks();
    mocks.createConversation.mockImplementation(() => chat({ localId: "made" }));
    mocks.createBlank.mockResolvedValue({ conversationId: "22222222-2222-4222-8222-222222222222" });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  // A local test: the space's first, empty "New chat" stayed in the tab bar
  // beside every chat New chat made after it.
  it("stays in an empty chat instead of making another", async () => {
    mocks.conversations = [chat({ localId: "first", controllerId: "33333333-3333-4333-8333-333333333333", messages: [greeting("g")] })];
    mocks.activeConversationId = "first";
    await render();
    await act(async () => start());
    expect(mocks.createConversation).not.toHaveBeenCalled();
    expect(mocks.createBlank).not.toHaveBeenCalled();
    expect(mocks.selectConversation).toHaveBeenCalledWith("first");
    expect(openTab).toHaveBeenCalledWith("first");
    expect(beforeOpen).toHaveBeenCalledOnce();
  });

  it("goes to an empty chat that is open elsewhere", async () => {
    mocks.conversations = [
      chat({ localId: "empty" }),
      chat({ localId: "busy", title: "Plan a weekend", messages: [{ id: "u", role: "user", content: "Plan a weekend", timestamp: 2 }] }),
    ];
    mocks.activeConversationId = "busy";
    await render();
    await act(async () => start());
    expect(mocks.createConversation).not.toHaveBeenCalled();
    expect(openTab).toHaveBeenCalledWith("empty");
  });

  it("makes a chat when every chat has something in it, or a draft", async () => {
    mocks.conversations = [
      chat({ localId: "busy", title: "Plan a weekend", messages: [{ id: "u", role: "user", content: "Plan a weekend", timestamp: 2 }] }),
      chat({ localId: "drafted", draft: "Find a hotel" }),
      chat({ localId: "private", visibility: "private" }),
    ];
    mocks.activeConversationId = "busy";
    await render();
    await act(async () => start());
    expect(mocks.createConversation).toHaveBeenCalledOnce();
    expect(mocks.selectConversation).toHaveBeenCalledWith("made");
    expect(mocks.markConversationRead).toHaveBeenCalledWith("made");
    expect(openTab).toHaveBeenCalledWith("made");
    expect(mocks.createBlank).toHaveBeenCalledWith({ projectId: PROJECT, metadata: { title: "New chat", localId: "made" } });
  });
});
