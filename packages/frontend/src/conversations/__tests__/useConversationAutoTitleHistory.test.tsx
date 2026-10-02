/** @vitest-environment jsdom */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversationState } from "../conversationState";
import type { ChatMessage } from "../../screens/studio/types";

const mocks = vi.hoisted(() => ({
  activeConversation: null as unknown,
  history: {
    messages: [] as unknown[],
    hasMoreHistory: false,
    hasResolvedHistory: true,
  },
  maybeAutoTitle: vi.fn(),
  setConversationTitle: vi.fn(),
}));

vi.mock("../ConversationsProvider", () => ({
  useConversations: () => ({
    conversations: mocks.activeConversation ? [mocks.activeConversation] : [],
    activeConversationId: (mocks.activeConversation as { localId?: string } | null)?.localId ?? null,
    activeConversation: mocks.activeConversation,
    setConversationTitle: mocks.setConversationTitle,
  }),
}));
vi.mock("../useConversationHistoryState", () => ({
  useConversationHistoryState: () => ({
    latestArrivalMessages: [],
    isHistoryLoading: false,
    isInitialHistoryLoading: false,
    initialHistoryError: null,
    retryInitialHistory: vi.fn(),
    loadOlderMessages: vi.fn(),
    ...mocks.history,
  }),
}));
vi.mock("../useConversationSubmitFlow", () => ({
  buildConversationAgentHandles: () => [],
  useConversationSubmitFlow: () => ({
    maybeAutoTitleConversation: mocks.maybeAutoTitle,
    ensureConversation: vi.fn(),
    pendingAgentEvaluationRunIdsRef: { current: new Set<string>() },
    stickyMentionedAgentByConversationRef: { current: new Map<string, string>() },
  }),
}));
vi.mock("../useConversationGoalContinuationEffects", () => ({ useConversationGoalContinuationEffects: () => undefined }));
vi.mock("../../status/useStatus", () => ({ useStatus: () => ({ showStatus: vi.fn() }) }));
vi.mock("../../projects/useProject", () => ({ useProject: () => ({ activeProjectId: "space-1" }) }));
vi.mock("../../providers/AuthProvider", () => ({ useAuth: () => ({ user: { id: "user-a" } }) }));
vi.mock("../../runtime/useRuntime", () => ({
  useRuntime: () => ({
    preferredRuntimeId: null,
    runtimeStatuses: {},
    effectiveRuntimeId: null,
    effectiveRuntimeSource: null,
    runs: {},
  }),
}));

import { useConversation } from "../useConversation";

function message(id: string, role: ChatMessage["role"], content: string): ChatMessage {
  return { id, role, authorId: "user-a", content, timestamp: 1, files: null, messageType: role, metadata: null };
}

function Harness() {
  useConversation();
  return null;
}

describe("useConversation auto-title seed", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    // A chat loaded from the controller: its messages live in the history query.
    mocks.activeConversation = {
      localId: "conversation-1",
      controllerId: "controller-1",
      title: "Conversation 2",
      parentConversationId: null,
      threadKind: null,
      hasRemoteMessages: true,
      messages: [],
    } as unknown as ConversationState;
    mocks.history = {
      messages: [
        message("m-1", "user", "Plan the spring launch"),
        message("m-2", "assistant", "Which date?"),
        message("m-3", "user", "Yes, that one"),
      ],
      hasMoreHistory: false,
      hasResolvedHistory: true,
    };
    mocks.maybeAutoTitle.mockReset().mockResolvedValue(undefined);
    mocks.setConversationTitle.mockReset();
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("names the opening message once every history page is in", async () => {
    await act(async () => root.render(<Harness />));
    expect(mocks.maybeAutoTitle).toHaveBeenCalledWith(
      "conversation-1",
      "Yes, that one",
      { content: "Plan the spring launch", authorId: "user-a" },
    );
  });

  it("leaves a chat rebuilt from one message alone until the chat list confirms it", async () => {
    mocks.activeConversation = { ...(mocks.activeConversation as object), remoteSummaryPending: true };
    mocks.history.messages = [
      message("m-1", "user", "/skills import https://github.com/instafy-dev/skills/tree/main/packs/bookkeeping --start"),
    ];
    await act(async () => root.render(<Harness />));
    expect(mocks.maybeAutoTitle).not.toHaveBeenCalled();
    expect(mocks.setConversationTitle).not.toHaveBeenCalled();
  });

  it("leaves the opening message unknown while older pages or the first page are missing", async () => {
    mocks.history.hasMoreHistory = true;
    await act(async () => root.render(<Harness />));
    expect(mocks.maybeAutoTitle).toHaveBeenLastCalledWith("conversation-1", "Yes, that one", undefined);
    mocks.history = { ...mocks.history, hasMoreHistory: false, hasResolvedHistory: false };
    await act(async () => root.render(<Harness key="unresolved" />));
    expect(mocks.maybeAutoTitle).toHaveBeenLastCalledWith("conversation-1", "Yes, that one", undefined);
  });
});
