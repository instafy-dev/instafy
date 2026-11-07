/** @vitest-environment jsdom */

import { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunRecord } from "../../types";
import type { ControllerConversationMessage, ControllerConversationUpdated } from "../../services/runtimeController/conversations";
import { createConversationGoal } from "../conversationGoals";
import { conversationsReducer, createInitialConversation, type ConversationsAction, type ConversationsState } from "../conversationState";

const mocks = vi.hoisted(() => ({
  state: null as ConversationsState | null,
  runs: {} as Record<string, RunRecord>,
  setGoal: vi.fn(),
  appendMessages: vi.fn(),
  sendPrompt: vi.fn(),
  updateMetadata: vi.fn(),
  dispatch: vi.fn<(action: ConversationsAction) => void>(),
}));

vi.mock("../../sdk/instafy", async () => {
  const actual = await vi.importActual<typeof import("../../sdk/instafy")>("../../sdk/instafy");
  return { ...actual, controllerClient: {
    ...actual.controllerClient,
    core: { ...actual.controllerClient.core, enabled: true },
    conversations: { ...actual.controllerClient.conversations, updateMetadata: mocks.updateMetadata },
  } };
});
vi.mock("../ConversationsProvider", () => ({ useConversations: () => ({
  conversations: mocks.state!.conversations,
  activeConversationId: mocks.state!.activeId,
  activeConversation: mocks.state!.conversations[0],
  setConversationGoal: mocks.setGoal,
  appendMessages: mocks.appendMessages,
}) }));
vi.mock("../useConversationHistoryState", () => ({ useConversationHistoryState: () => ({
  messages: mocks.state!.conversations[0].messages,
  latestArrivalMessages: [],
  hasResolvedHistory: true,
  hasMoreHistory: false,
}) }));
vi.mock("../useConversationSubmitFlow", () => ({
  buildConversationAgentHandles: () => [],
  useConversationSubmitFlow: () => ({
    sendPromptToController: mocks.sendPrompt,
    pendingAgentEvaluationRunIdsRef: { current: new Set<string>() },
    stickyMentionedAgentByConversationRef: { current: new Map<string, string>() },
  }),
}));
vi.mock("../../status/useStatus", () => ({ useStatus: () => ({ showStatus: vi.fn() }) }));
vi.mock("../../projects/useProject", () => ({ useProject: () => ({ activeProjectId: "11111111-2222-4333-8444-555555555555" }) }));
vi.mock("../../providers/AuthProvider", () => ({ useAuth: () => ({ user: { id: "user-1" } }) }));
vi.mock("../../runtime/useRuntime", () => ({ useRuntime: () => ({ runs: mocks.runs }) }));

import { useConversation } from "../useConversation";
import { useConversationRunEffects } from "../useConversationRunEffects";
import { usePendingConversationEffects } from "../usePendingConversationEffects";

const PROJECT_ID = "11111111-2222-4333-8444-555555555555";
const CONTROLLER_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

function Harness({ messages = [], updates = [] }: {
  messages?: ControllerConversationMessage[];
  updates?: ControllerConversationUpdated[];
}) {
  const state = mocks.state!;
  useConversation();
  useConversationRunEffects({
    conversations: state.conversations, runMap: state.runMap, runs: mocks.runs,
    leasedRunIds: {}, clearRunLease: vi.fn(), processedRunMessagesRef: useRef(new Set<string>()),
    pendingLeaseSweepEpoch: 0, bumpPendingLeaseSweepEpoch: vi.fn(),
    pendingLeaseSweepTimeoutRef: useRef(null), dispatch: mocks.dispatch,
  });
  usePendingConversationEffects({
    state, projectKey: PROJECT_ID, currentUserId: "user-1",
    pendingConversationCreations: [], ackConversationCreations: vi.fn(),
    pendingConversationUpdates: updates, ackConversationUpdates: vi.fn(),
    pendingConversationMessages: messages, ackConversationMessages: vi.fn(),
    lastBackgroundAtRef: useRef(0), notifiedMessageIdsRef: useRef(new Set<string>()),
    dispatch: mocks.dispatch,
  });
  return null;
}

describe("controller-owned conversation goals", () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mocks.dispatch.mockReset();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    mocks.state = {
      projectKey: PROJECT_ID, activeId: "local", sequence: 1, runMap: {},
      conversations: [{
        ...createInitialConversation({ localId: "local", controllerId: CONTROLLER_ID }),
        title: "Review the changes",
        activeGoal: { ...createConversationGoal("Review the changes", "user-1"), id: "goal-1" },
        messages: [
          { id: "prompt", role: "user", content: "/goal Review the changes", timestamp: 1,
            metadata: { runId: "run-1", goal: { id: "goal-1" } } },
          { id: "answer", role: "assistant", content: "I checked the API. Next I will check the UI.", timestamp: 2,
            metadata: { runId: "run-1" } },
        ],
      }],
    };
    mocks.runs = {};
    mocks.updateMetadata.mockResolvedValue(true);
    mocks.sendPrompt.mockResolvedValue({ ok: true, runIds: [], jobIds: [] });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    vi.useRealTimers();
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  function expectNoGoalAuthority() {
    expect(mocks.dispatch.mock.calls.some(([action]) => action.type === "SET_GOAL")).toBe(false);
    expect(mocks.setGoal).not.toHaveBeenCalled();
    expect(mocks.updateMetadata).not.toHaveBeenCalled();
    expect(mocks.sendPrompt).not.toHaveBeenCalled();
    expect(mocks.appendMessages).not.toHaveBeenCalled();
  }

  it.each(["success", "failed", "canceled"] as const)("only unlinks a %s run; mounting or reopening the chat cannot continue or block its goal", async (status) => {
    mocks.runs["run-1"] = {
      id: "run-1", projectId: PROJECT_ID, sessionId: null, conversationId: CONTROLLER_ID,
      promptId: "prompt", runType: "prompt", status, progress: 100, progressStage: null,
      previewUrl: null, lastMessage: null, metadata: { goal: { id: "goal-1" } },
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
    await act(async () => root.render(<Harness />));
    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    await act(async () => root.render(<Harness key="reopened" />));
    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    expect(mocks.dispatch).toHaveBeenCalledWith({ type: "UNLINK_RUN", runId: "run-1" });
    expectNoGoalAuthority();
  });

  it("renders a runtime goal update without deriving or persisting goal metadata", async () => {
    const message: ControllerConversationMessage = {
      id: "goal-update", conversationId: CONTROLLER_ID, projectId: PROJECT_ID,
      sessionId: null, runId: "run-1", promptId: "prompt", role: "assistant", content: "Review complete.",
      metadata: { messageType: "goal_update", details: { goalId: "goal-1", status: "completed" } },
      createdAt: new Date().toISOString(),
    };
    await act(async () => root.render(<Harness messages={[message]} />));
    expect(mocks.dispatch).toHaveBeenCalledWith(expect.objectContaining({
      type: "APPLY_REMOTE_MESSAGE", message: expect.objectContaining({ content: "Review complete." }),
    }));
    expectNoGoalAuthority();
  });

  it("does not persist a goal transition from a restored quota error", async () => {
    mocks.state!.conversations[0].messages.push({
      id: "quota", role: "assistant", content: '429 Too Many Requests: {"error":{"type":"insufficient_quota"}}',
      timestamp: 3, messageType: "error", metadata: { messageType: "error", runId: "run-1" },
    });
    await act(async () => root.render(<Harness />));
    expectNoGoalAuthority();
  });

  it.each(["active", "completed", "blocked", "cleared"] as const)("projects a %s controller goal snapshot without writing it back", async (status) => {
    const goal = status === "cleared" ? null : {
      ...mocks.state!.conversations[0].activeGoal!, status,
      updatedAt: new Date(Date.now() + 1_000).toISOString(), progressSummary: "Controller checkpoint",
    };
    if (status === "active") mocks.state!.conversations[0].activeGoal = null;
    let nextState = mocks.state!;
    mocks.dispatch.mockImplementation((action) => { nextState = conversationsReducer(nextState, action); });
    await act(async () => root.render(<Harness updates={[{
      conversationId: CONTROLLER_ID, projectId: PROJECT_ID, sessionId: null, createdBy: "user-1",
      metadata: { instafyGoal: goal }, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    }]} />));
    expect(nextState.conversations[0].activeGoal).toEqual(goal);
    expect(mocks.updateMetadata).not.toHaveBeenCalled();
    expect(mocks.sendPrompt).not.toHaveBeenCalled();
  });
});
