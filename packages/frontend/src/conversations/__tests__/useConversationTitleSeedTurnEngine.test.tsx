/** @vitest-environment jsdom */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "../../screens/studio/types";

const state = vi.hoisted(() => ({
  messages: [] as unknown[],
  maybeAutoTitleConversation: vi.fn(),
}));

const ACTIVE_CONVERSATION = {
  localId: "conversation-local",
  controllerId: "controller-1",
  title: "New chat",
  parentConversationId: null,
  threadKind: null,
  remoteSummaryPending: false,
  draft: "",
  draftEditorState: null,
  assistantEnabled: true,
  extraAgentHandles: [],
  pendingRunIds: [],
  awaitingLeaseRunIds: [],
  pendingRunSubmittedAt: {},
  activeGoal: null,
  messages: [],
};

vi.mock("../ConversationsProvider", () => ({
  useConversations: () => ({
    conversations: [ACTIVE_CONVERSATION],
    activeConversationId: ACTIVE_CONVERSATION.localId,
    activeConversation: ACTIVE_CONVERSATION,
    createConversation: vi.fn(),
    selectConversation: vi.fn(),
    closeConversation: vi.fn(),
    setConversationDraft: vi.fn(),
    setConversationAssistantEnabled: vi.fn(),
    addConversationAgentHandle: vi.fn(),
    removeConversationAgentHandle: vi.fn(),
    appendMessages: vi.fn(),
    replaceMessages: vi.fn(),
    updateMessage: vi.fn(),
    markConversationRead: vi.fn(),
    setConversationControllerId: vi.fn(),
    setConversationTitle: vi.fn(),
    setConversationGoal: vi.fn(),
    linkRunToConversation: vi.fn(),
  }),
}));
vi.mock("../../status/useStatus", () => ({ useStatus: () => ({ showStatus: vi.fn() }) }));
vi.mock("../../projects/useProject", () => ({ useProject: () => ({ activeProjectId: "project-1" }) }));
vi.mock("../../providers/AuthProvider", () => ({ useAuth: () => ({ user: { id: "user-a" } }) }));
vi.mock("../../runtime/useRuntime", () => ({
  useRuntime: () => ({
    preferredRuntimeId: null,
    runtimeStatuses: [],
    effectiveRuntimeId: null,
    effectiveRuntimeSource: "auto",
    runs: {},
  }),
}));
vi.mock("../useConversationHistoryState", () => ({
  useConversationHistoryState: () => ({
    messages: state.messages,
    latestArrivalMessages: [],
    hasMoreHistory: false,
    hasResolvedHistory: true,
    isHistoryLoading: false,
    isInitialHistoryLoading: false,
    initialHistoryError: null,
    retryInitialHistory: vi.fn(),
    loadOlderMessages: vi.fn(),
  }),
}));
vi.mock("../useConversationSubmitFlow", () => ({
  buildConversationAgentHandles: () => ["octo"],
  useConversationSubmitFlow: () => ({
    ensureConversation: vi.fn(),
    handleCreateConversation: vi.fn(),
    handleInputChange: vi.fn(),
    recordMessageToController: vi.fn(),
    maybeAutoTitleConversation: state.maybeAutoTitleConversation,
    resolveGroupParticipationBeforeSubmit: vi.fn(),
    handleSubmit: vi.fn(),
    stickyMentionedAgentByConversationRef: { current: new Map() },
    pendingAgentEvaluationRunIdsRef: { current: new Set() },
  }),
}));

import { useConversation } from "../useConversation";

function userMessage(content: string, index: number, metadata: Record<string, unknown> | null = null): ChatMessage {
  return {
    id: `user-${index}`,
    role: "user",
    authorId: "user-a",
    content,
    timestamp: 1_786_000_000_000 + index,
    files: null,
    messageType: "user",
    metadata,
  };
}

function Harness() {
  useConversation();
  return null;
}

describe("useConversation's title seed and turn-engine turns", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    state.maybeAutoTitleConversation.mockReset();
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("never takes a turn-engine message as the chat's title seed", async () => {
    state.messages = [
      userMessage("Fix the failing login test", 0, { aiAccessMode: "claude-code" }),
      userMessage("Rename the settings page", 1, { turnEngine: "claude-code" }),
    ];
    await act(async () => root.render(<Harness />));
    expect(state.maybeAutoTitleConversation).not.toHaveBeenCalled();
  });

  it("takes the latest message of the chat's own instead", async () => {
    state.messages = [
      userMessage("Plan the spring launch", 0),
      userMessage("Fix the failing login test", 1, { aiAccessMode: "claude-code" }),
    ];
    await act(async () => root.render(<Harness />));
    expect(state.maybeAutoTitleConversation).toHaveBeenCalledTimes(1);
    expect(state.maybeAutoTitleConversation.mock.calls[0]?.[1]).toBe("Plan the spring launch");
  });

  // A Studio built without an engine's module still passes over its turns.
  it("also passes over a message of an engine this Studio was not built with", async () => {
    state.messages = [
      userMessage("Plan the autumn launch", 0, { aiAccessMode: "byoc" }),
      userMessage("Fix the failing login test", 1, { aiAccessMode: "future-engine" }),
    ];
    await act(async () => root.render(<Harness />));
    expect(state.maybeAutoTitleConversation).toHaveBeenCalledTimes(1);
    expect(state.maybeAutoTitleConversation.mock.calls[0]?.[1]).toBe("Plan the autumn launch");
  });
});
