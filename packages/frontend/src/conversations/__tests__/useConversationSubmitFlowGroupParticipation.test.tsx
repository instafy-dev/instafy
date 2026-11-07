/** @vitest-environment jsdom */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { conversationsReducer, createInitialConversation, type ConversationsState, type ConversationState } from "../conversationState";
import { createConversationGoal, type ConversationGoal } from "../conversationGoals";
import {
  didSendFailForPromptSentFromThisPage,
  forgetPromptsSentFromThisPageForTests,
  wasRunStartedByPromptSentFromThisPage,
} from "../sentPromptRegistry";

const resolveParticipationMock = vi.hoisted(() => vi.fn());
const ensureControllerConversationIdMock = vi.hoisted(() => vi.fn());
const recordMessageToControllerMock = vi.hoisted(() => vi.fn());
const sendPromptToControllerMock = vi.hoisted(() => vi.fn());
const updateMetadataMock = vi.hoisted(() => vi.fn());
const setConversationGoalMock = vi.hoisted(() => vi.fn());
const showStatusMock = vi.hoisted(() => vi.fn());
const queueAutoTitleConversationMock = vi.hoisted(() => vi.fn());
const resolveLocalCapabilityHandleMock = vi.hoisted(() => vi.fn());
const runLocalCapabilityConversationFlowMock = vi.hoisted(() => vi.fn());

const controllerDispatchMock = vi.hoisted(() => ({
  resolveProjectId: vi.fn(),
  resolveRuntimeTarget: vi.fn(),
  ensureConversation: vi.fn(),
  handleCreateConversation: vi.fn(),
  handleInputChange: vi.fn(),
  ensureControllerConversationId: ensureControllerConversationIdMock,
  sendPromptToController: sendPromptToControllerMock,
  recordMessageToController: recordMessageToControllerMock,
}));

vi.mock("../../sdk/instafy", async () => {
  const actual = await vi.importActual<typeof import("../../sdk/instafy")>("../../sdk/instafy");
  return {
    ...actual,
    controllerClient: {
      ...actual.controllerClient,
      conversations: {
        ...actual.controllerClient.conversations,
        resolveParticipation: resolveParticipationMock,
        updateMetadata: updateMetadataMock,
      },
    },
  };
});

vi.mock("../useConversationControllerDispatch", () => ({
  useConversationControllerDispatch: () => controllerDispatchMock,
}));

vi.mock("../useConversationAutoTitle", () => ({
  useConversationAutoTitle: () => ({
    maybeAutoTitleConversation: vi.fn(),
    queueAutoTitleConversation: queueAutoTitleConversationMock,
  }),
}));

vi.mock("../../capabilities/localCapabilityRuntime", async () => {
  const actual = await vi.importActual<
    typeof import("../../capabilities/localCapabilityRuntime")
  >("../../capabilities/localCapabilityRuntime");
  return {
    ...actual,
    resolveSingleLocalCapabilityHandleForPrompt: resolveLocalCapabilityHandleMock,
  };
});

vi.mock("../localCapabilityConversationFlow", async () => {
  const actual = await vi.importActual<typeof import("../localCapabilityConversationFlow")>(
    "../localCapabilityConversationFlow",
  );
  return {
    ...actual,
    runLocalCapabilityConversationFlow: runLocalCapabilityConversationFlowMock,
  };
});

import { useConversationSubmitFlow } from "../useConversationSubmitFlow";

const PROJECT_ID = "11111111-2222-4333-8444-555555555555";
const CONTROLLER_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const USER_ID = "99999999-8888-4777-8666-555555555555";

type SubmitFlow = ReturnType<typeof useConversationSubmitFlow>;

function HookHarness({
  conversation,
  appendMessages,
  updateMessage,
  onReady,
}: {
  conversation: ConversationState;
  appendMessages: Mock;
  updateMessage: Mock;
  onReady: (flow: SubmitFlow) => void;
}) {
  const flow = useConversationSubmitFlow({
    conversations: [conversation],
    activeConversation: conversation,
    activeProjectId: PROJECT_ID,
    currentUserId: USER_ID,
    preferredRuntimeId: null,
    runtimeStatuses: [],
    effectiveRuntimeId: null,
    effectiveRuntimeSource: "auto",
    showStatus: showStatusMock,
    createConversation: vi.fn(),
    selectConversation: vi.fn(),
    markConversationRead: vi.fn(),
    setConversationDraft: vi.fn(),
    setConversationControllerId: vi.fn(),
    setConversationTitle: vi.fn(),
    setConversationGoal: setConversationGoalMock,
    appendMessages,
    updateMessage,
    linkRunToConversation: vi.fn(),
  });
  onReady(flow);
  return null;
}

describe("useConversationSubmitFlow", () => {
  let container: HTMLDivElement;
  let root: Root;
  let flow: SubmitFlow | null;
  let conversation: ConversationState;
  let appendMessages: Mock;
  let updateMessage: Mock;

  beforeEach(async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    flow = null;
    conversation = createInitialConversation({
      localId: "conversation-local",
      controllerId: CONTROLLER_ID,
    });
    appendMessages = vi.fn();
    updateMessage = vi.fn();

    resolveParticipationMock.mockReset();
    ensureControllerConversationIdMock.mockReset();
    recordMessageToControllerMock.mockReset();
    sendPromptToControllerMock.mockReset();
    updateMetadataMock.mockReset().mockResolvedValue(true);
    setConversationGoalMock.mockReset();
    showStatusMock.mockReset();
    queueAutoTitleConversationMock.mockReset();
    resolveLocalCapabilityHandleMock.mockReset();
    runLocalCapabilityConversationFlowMock.mockReset();
    controllerDispatchMock.resolveProjectId.mockReset();
    controllerDispatchMock.resolveRuntimeTarget.mockReset();
    controllerDispatchMock.ensureConversation.mockReset();

    controllerDispatchMock.resolveProjectId.mockReturnValue(PROJECT_ID);
    controllerDispatchMock.resolveRuntimeTarget.mockReturnValue({
      runtimeId: null,
      runtimeDisplayName: null,
      preferRuntime: null,
    });
    controllerDispatchMock.ensureConversation.mockReturnValue(conversation);
    ensureControllerConversationIdMock.mockResolvedValue(CONTROLLER_ID);
    recordMessageToControllerMock.mockResolvedValue(null);
    sendPromptToControllerMock.mockResolvedValue({ ok: true, runIds: [], jobIds: [] });
    resolveLocalCapabilityHandleMock.mockReturnValue(null);
    runLocalCapabilityConversationFlowMock.mockImplementation(async (input) => ({
      handled: true,
      promptMetadata: input.promptMetadata,
    }));

    await act(async () => {
      root.render(
        <HookHarness
          conversation={conversation}
          appendMessages={appendMessages}
          updateMessage={updateMessage}
          onReady={(value) => {
            flow = value;
          }}
        />,
      );
    });
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it.each([
    ["/goal Review the changes", null, "active", true],
    ["/goal edit Review the UI", "active", "active", true],
    ["/goal pause", "active", "paused", false],
    ["/goal resume", "paused", "active", true],
    ["/goal clear", "paused", null, false],
  ] as const)("persists explicit %s and dispatches only when requested", async (command, priorStatus, nextStatus, shouldDispatch) => {
    conversation.activeGoal = priorStatus ? {
      ...createConversationGoal("Review the changes", USER_ID), status: priorStatus,
    } : null;
    await act(async () => { await flow!.handleSubmit("conversation-local", command); });
    const expectedGoal = nextStatus ? expect.objectContaining({ status: nextStatus }) : null;
    expect(setConversationGoalMock).toHaveBeenCalledWith("conversation-local", expectedGoal, conversation.activeGoal);
    expect(updateMetadataMock).toHaveBeenCalledTimes(1);
    expect(updateMetadataMock).toHaveBeenCalledWith({
      conversationId: CONTROLLER_ID, metadata: { instafyGoal: expectedGoal },
    });
    expect(sendPromptToControllerMock).toHaveBeenCalledTimes(shouldDispatch ? 1 : 0);
    if (shouldDispatch) {
      expect(sendPromptToControllerMock.mock.calls[0][2]).toMatchObject({
        command: { type: "goal" },
        goal: updateMetadataMock.mock.calls[0][0].metadata.instafyGoal,
        displayContent: command,
      });
      expect(sendPromptToControllerMock.mock.calls[0][4]).toMatchObject({ controllerId: CONTROLLER_ID });
    }
  });

  it("waits for the goal metadata write before starting its run", async () => {
    let finishWrite!: () => void;
    updateMetadataMock.mockReturnValue(new Promise<boolean>((resolve) => { finishWrite = () => resolve(true); }));
    await act(async () => { await flow!.handleSubmit("conversation-local", "/goal Verify the change"); });
    expect(updateMetadataMock).toHaveBeenCalledTimes(1);
    expect(setConversationGoalMock).toHaveBeenCalledTimes(1);
    expect(appendMessages.mock.calls.flatMap(([, messages]) => messages).every((message) => message.role === "user")).toBe(true);
    expect(sendPromptToControllerMock).not.toHaveBeenCalled();
    await act(async () => { finishWrite(); });
    expect(sendPromptToControllerMock).toHaveBeenCalledTimes(1);
    expect(updateMetadataMock).toHaveBeenCalledTimes(1);
  });

  it.each(["conversation", "metadata"] as const)("does not dispatch and restores the goal when %s persistence fails", async (failure) => {
    conversation.activeGoal = createConversationGoal("Previous objective", USER_ID);
    if (failure === "conversation") ensureControllerConversationIdMock.mockResolvedValue(null);
    else updateMetadataMock.mockResolvedValue(null);
    await act(async () => { await flow!.handleSubmit("conversation-local", "/goal edit New objective"); });
    expect(sendPromptToControllerMock).not.toHaveBeenCalled();
    expect(setConversationGoalMock).toHaveBeenLastCalledWith(
      "conversation-local", conversation.activeGoal, expect.objectContaining({ objective: "New objective" }),
    );
    expect(showStatusMock).toHaveBeenCalledWith("Couldn't save the goal. Try again.", "error", 4500);
  });

  function trackGoalState() {
    let state: ConversationsState = {
      projectKey: PROJECT_ID, conversations: [conversation], activeId: conversation.localId,
      sequence: 1, runMap: {},
    };
    setConversationGoalMock.mockImplementation((id, goal, expectedGoal) => {
      state = conversationsReducer(state, { type: "SET_GOAL", id, goal, expectedGoal });
    });
    return {
      current: () => state.conversations[0].activeGoal,
      conversation: () => state.conversations[0],
      receive: (goal: ConversationGoal | null) => {
        state = conversationsReducer(state, { type: "SET_GOAL", id: conversation.localId, goal });
      },
    };
  }

  it.each(["complete", "block", "cancel"] as const)("a failed /goal %s restores the real goal state to active", async (command) => {
    conversation.activeGoal = {
      ...createConversationGoal("Previous objective", USER_ID), updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const state = trackGoalState();
    let failSave!: () => void;
    updateMetadataMock.mockReturnValue(new Promise<null>((resolve) => { failSave = () => resolve(null); }));
    await act(async () => { await flow!.handleSubmit("conversation-local", `/goal ${command}`); });
    expect(state.current()?.status).not.toBe("active");
    await act(async () => { failSave(); });
    expect(state.current()).toEqual(conversation.activeGoal);
    expect(sendPromptToControllerMock).not.toHaveBeenCalled();
    expect(appendMessages.mock.calls.flatMap(([, messages]) => messages).every((message) => message.role === "user")).toBe(true);
    expect(showStatusMock).toHaveBeenCalledWith("Couldn't save the goal. Try again.", "error", 4500);
  });

  it("reports a rejected save without changing goal state or confirming success", async () => {
    conversation.activeGoal = createConversationGoal("Previous objective", USER_ID);
    const state = trackGoalState();
    updateMetadataMock.mockRejectedValue(new Error("Session unavailable"));
    await act(async () => { await flow!.handleSubmit("conversation-local", "/goal cancel"); });
    expect(state.current()).toEqual(conversation.activeGoal);
    expect(sendPromptToControllerMock).not.toHaveBeenCalled();
    expect(appendMessages.mock.calls.flatMap(([, messages]) => messages).every((message) => message.role === "user")).toBe(true);
    expect(showStatusMock).toHaveBeenCalledWith("Couldn't finish the goal command. Try again.", "error", 4500);
  });

  it("a delayed save confirmation cannot replace a newer controller goal", async () => {
    conversation.activeGoal = createConversationGoal("Previous objective", USER_ID);
    const state = trackGoalState();
    let finishSave!: () => void;
    updateMetadataMock.mockReturnValue(new Promise<boolean>((resolve) => { finishSave = () => resolve(true); }));
    await act(async () => { await flow!.handleSubmit("conversation-local", "/goal complete"); });
    const newerGoal = createConversationGoal("A new objective", USER_ID);
    state.receive(newerGoal);
    await act(async () => { finishSave(); });
    expect(state.current()).toEqual(newerGoal);
    expect(sendPromptToControllerMock).not.toHaveBeenCalled();
  });

  it("pauses a pending start and keeps the pause when that start's acknowledgement arrives late", async () => {
    const state = trackGoalState();
    let finishStartSave!: () => void;
    updateMetadataMock.mockImplementationOnce(() => new Promise<boolean>((resolve) => {
      finishStartSave = () => resolve(true);
    }));
    sendPromptToControllerMock.mockResolvedValue({ ok: false, errorMessage: "The goal changed before dispatch" });
    await act(async () => { await flow!.handleSubmit("conversation-local", "/goal Review the changes"); });
    const startedGoal = state.current();
    expect(startedGoal?.status).toBe("active");
    await act(async () => root.render(<HookHarness conversation={state.conversation()}
      appendMessages={appendMessages} updateMessage={updateMessage} onReady={(value) => { flow = value; }} />));
    await act(async () => { await flow!.handleSubmit("conversation-local", "/goal pause"); });
    expect(state.current()).toMatchObject({ id: startedGoal!.id, status: "paused" });
    expect(updateMetadataMock.mock.calls[1][0].metadata.instafyGoal).toMatchObject({ id: startedGoal!.id, status: "paused" });
    await act(async () => { finishStartSave(); });
    expect(sendPromptToControllerMock.mock.calls[0][2].goal).toEqual(startedGoal);
    expect(state.current()?.status).toBe("paused");
    expect(updateMetadataMock).toHaveBeenCalledTimes(2);
  });

  it("a failed save does not roll back a newer controller update", async () => {
    conversation.activeGoal = createConversationGoal("Previous objective", USER_ID);
    const state = trackGoalState();
    let failSave!: () => void;
    updateMetadataMock.mockReturnValue(new Promise<null>((resolve) => { failSave = () => resolve(null); }));
    await act(async () => { await flow!.handleSubmit("conversation-local", "/goal cancel"); });
    const replacement = createConversationGoal("New objective", USER_ID);
    state.receive(replacement);
    await act(async () => { failSave(); });
    expect(state.current()).toEqual(replacement);
    expect(sendPromptToControllerMock).not.toHaveBeenCalled();
  });

  it("a late dispatch refusal cannot overwrite a newer goal or issue another metadata write", async () => {
    const state = trackGoalState();
    let refuseDispatch!: () => void;
    sendPromptToControllerMock.mockReturnValue(new Promise<{ ok: false; errorMessage: string }>((resolve) => {
      refuseDispatch = () => resolve({ ok: false, errorMessage: "The goal changed before dispatch" });
    }));
    await act(async () => { await flow!.handleSubmit("conversation-local", "/goal Review the changes"); });
    expect(state.current()?.status).toBe("active");
    const newerGoal = createConversationGoal("A new objective", USER_ID);
    state.receive(newerGoal);
    await act(async () => { refuseDispatch(); });
    expect(state.current()).toEqual(newerGoal);
    expect(updateMetadataMock).toHaveBeenCalledTimes(1);
  });

  it("records a silent human turn without dispatching or starting a runtime", async () => {
    resolveLocalCapabilityHandleMock.mockReturnValue("octo");
    resolveParticipationMock.mockResolvedValue({
      decision: "silent",
      domain: "human_directed",
      reason: "directed_to_human",
      confidence: 96,
      participantCount: 2,
      policySkillPath: ".agents/skills/instafy-group-participation/SKILL.md",
    });

    await act(async () => {
      await flow!.handleSubmit("conversation-local", "Taylor, take a photo.");
    });

    expect(resolveParticipationMock).toHaveBeenCalledTimes(1);
    expect(recordMessageToControllerMock).toHaveBeenCalledTimes(1);
    expect(sendPromptToControllerMock).not.toHaveBeenCalled();
    expect(runLocalCapabilityConversationFlowMock).not.toHaveBeenCalled();
    expect(queueAutoTitleConversationMock).not.toHaveBeenCalled();
    const metadata = recordMessageToControllerMock.mock.calls[0][2] as Record<string, unknown>;
    expect(metadata.groupParticipation).toMatchObject({
      decision: "silent",
      domain: "human_directed",
      confidence: 96,
      participantCount: 2,
    });

    const appendedMessage = appendMessages.mock.calls[0][1][0];
    const participationPatch = updateMessage.mock.calls
      .map((call) => call[2](appendedMessage))
      .find((message) =>
        Boolean((message.metadata as Record<string, unknown> | null)?.groupParticipation),
      );
    expect(participationPatch?.metadata?.groupParticipation).toMatchObject({
      decision: "silent",
    });
  });

  it("records a human-only turn against the canonical local conversation", async () => {
    conversation.assistantEnabled = false;
    conversation.extraAgentHandles = [];

    await act(async () => {
      await flow!.handleSubmit(CONTROLLER_ID, "Android says hello.");
    });

    expect(appendMessages).toHaveBeenCalledWith(
      "conversation-local",
      expect.arrayContaining([
        expect.objectContaining({ role: "user", content: "Android says hello." }),
      ]),
    );
    expect(recordMessageToControllerMock).toHaveBeenCalledTimes(1);
    expect(recordMessageToControllerMock).toHaveBeenCalledWith(
      "conversation-local",
      "Android says hello.",
      expect.objectContaining({ clientMessageId: expect.any(String) }),
      "user",
      conversation,
    );
    expect(sendPromptToControllerMock).not.toHaveBeenCalled();
  });

  it.each([false, true])("forwards structured human mentions through %s assistant-enabled submissions", async (assistantEnabled) => {
    resolveParticipationMock.mockResolvedValue("unsupported");
    conversation.assistantEnabled = assistantEnabled;
    conversation.extraAgentHandles = [];
    const mentionedUserId = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff";
    const editorState = JSON.stringify({ root: { children: [{
      type: "user-mention", userId: mentionedUserId, handle: "teammate", displayName: "Teammate",
    }] } });
    await act(async () => {
      await flow!.handleSubmit("conversation-local", "@teammate please check this", {
        editorState,
        metadata: { mentionedUserIds: [USER_ID], preserved: true },
      });
    });
    expect(appendMessages.mock.calls[0][1][0].metadata).toMatchObject({ mentionedUserIds: [mentionedUserId], preserved: true });
    const write = assistantEnabled ? sendPromptToControllerMock : recordMessageToControllerMock;
    expect(write).toHaveBeenCalled();
    expect(write.mock.calls[0][2]).toMatchObject({ mentionedUserIds: [mentionedUserId], preserved: true });
  });

  it("rejects too many human mentions before appending or dispatching a message", async () => {
    const editorState = JSON.stringify({ root: { children: Array.from({ length: 33 }, (_, i) => ({
      type: "user-mention", userId: `${i.toString(16).padStart(8, "0")}-bbbb-4ccc-8ddd-eeeeeeeeeeee`, handle: `person${i}`,
    })) } });
    await act(async () => {
      await flow!.handleSubmit("conversation-local", "Please check this", { editorState });
    });
    expect(appendMessages).not.toHaveBeenCalled();
    expect(recordMessageToControllerMock).not.toHaveBeenCalled();
    expect(sendPromptToControllerMock).not.toHaveBeenCalled();
  });

  it("resolves ambient participation for the outer chat preflight", async () => {
    resolveParticipationMock.mockResolvedValue({
      decision: "silent",
      domain: "human_directed",
      reason: "directed_to_human",
      confidence: 99,
      participantCount: 2,
      policySkillPath: ".agents/skills/instafy-group-participation/SKILL.md",
    });

    const result = await flow!.resolveGroupParticipationBeforeSubmit({
      conversationId: "conversation-local",
      displayPrompt: "Taylor, take a photo.",
      dispatchPrompt: "Taylor, take a photo.",
      metadata: null,
      agentSelection: {
        activeHandles: ["octo"],
        explicitMentionedHandles: [],
        mentionedHandles: [],
        targetHandles: ["octo"],
        nextStickyMentionedAgent: null,
        usesDefaultAssistantOnly: true,
      },
      hasTerminalCommand: false,
      hasBrowserTask: false,
    });

    expect(result).toMatchObject({
      mode: "record_only",
      metadata: {
        groupParticipation: { decision: "silent" },
        groupParticipationPreflight: { status: "resolved" },
      },
    });
  });

  it("honors an upstream silent decision before local capabilities or auto-title", async () => {
    resolveLocalCapabilityHandleMock.mockReturnValue("octo");

    await act(async () => {
      await flow!.handleSubmit("conversation-local", "Taylor, take a photo.", {
        metadata: {
          groupParticipation: {
            decision: "silent",
            domain: "human_directed",
            reason: "directed_to_human",
            confidence: 99,
            participantCount: 2,
            policySkillPath: ".agents/skills/instafy-group-participation/SKILL.md",
          },
          groupParticipationPreflight: { status: "resolved" },
        },
      });
    });

    expect(resolveParticipationMock).not.toHaveBeenCalled();
    expect(recordMessageToControllerMock).toHaveBeenCalledTimes(1);
    expect(runLocalCapabilityConversationFlowMock).not.toHaveBeenCalled();
    expect(queueAutoTitleConversationMock).not.toHaveBeenCalled();
    expect(sendPromptToControllerMock).not.toHaveBeenCalled();
  });

  it("dispatches an immediate technical response with the skill metadata", async () => {
    resolveParticipationMock.mockResolvedValue({
      decision: "respond",
      domain: "technical",
      reason: "open_technical_question",
      confidence: 99,
      participantCount: 2,
      policySkillPath: ".agents/skills/instafy-group-participation/SKILL.md",
    });

    await act(async () => {
      await flow!.handleSubmit("conversation-local", "Why is this TypeScript build failing?");
    });

    expect(recordMessageToControllerMock).not.toHaveBeenCalled();
    expect(sendPromptToControllerMock).toHaveBeenCalledTimes(1);
    expect(queueAutoTitleConversationMock).toHaveBeenCalledTimes(1);
    expect(sendPromptToControllerMock.mock.calls[0][2]).toMatchObject({
      groupParticipation: {
        decision: "respond",
        domain: "technical",
        confidence: 99,
        participantCount: 2,
      },
    });
  });

  it("bypasses the resolver for an explicit @octo turn", async () => {
    await act(async () => {
      await flow!.handleSubmit("conversation-local", "@octo verify this answer");
    });

    expect(resolveParticipationMock).not.toHaveBeenCalled();
    expect(sendPromptToControllerMock).toHaveBeenCalledTimes(1);
    expect(queueAutoTitleConversationMock).toHaveBeenCalledTimes(1);
  });

  it("hands the auto title the message it opens a chat with, before the list holds it", async () => {
    await act(async () => {
      await flow!.handleSubmit("conversation-local", "@octo draft the April newsletter");
    });

    expect(queueAutoTitleConversationMock).toHaveBeenCalledWith(
      "conversation-local",
      "@octo draft the April newsletter",
      { content: "@octo draft the April newsletter", authorId: USER_ID },
    );
  });

  it("does not call a message the opening one in a chat loaded from the controller", async () => {
    // Its history lives in the message query, so an empty local list does not
    // mean nobody has written in it.
    await act(async () => {
      root.render(
        <HookHarness
          conversation={{ ...conversation, hasRemoteMessages: true }}
          appendMessages={appendMessages}
          updateMessage={updateMessage}
          onReady={(value) => {
            flow = value;
          }}
        />,
      );
    });
    await act(async () => {
      await flow!.handleSubmit("conversation-local", "@octo yes, that one");
    });

    expect(queueAutoTitleConversationMock).toHaveBeenCalledWith("conversation-local", "@octo yes, that one", null);
  });

  it("runs a local capability only after a responding participation decision", async () => {
    resolveLocalCapabilityHandleMock.mockReturnValue("octo");
    resolveParticipationMock.mockResolvedValue({
      decision: "respond",
      domain: "technical",
      reason: "camera_request",
      confidence: 99,
      participantCount: 2,
      policySkillPath: ".agents/skills/instafy-group-participation/SKILL.md",
    });

    await act(async () => {
      await flow!.handleSubmit("conversation-local", "Take a photo of this device.");
    });

    expect(resolveParticipationMock).toHaveBeenCalledTimes(1);
    expect(runLocalCapabilityConversationFlowMock).toHaveBeenCalledTimes(1);
    expect(queueAutoTitleConversationMock).toHaveBeenCalledTimes(1);
    expect(sendPromptToControllerMock).not.toHaveBeenCalled();
  });

  it("defers resolver outages to the controller without local AI side effects", async () => {
    resolveParticipationMock.mockResolvedValue(null);
    resolveLocalCapabilityHandleMock.mockReturnValue("octo");

    await act(async () => {
      await flow!.handleSubmit("conversation-local", "What is 1 + 1?");
    });

    expect(resolveParticipationMock).toHaveBeenCalledTimes(1);
    expect(recordMessageToControllerMock).not.toHaveBeenCalled();
    expect(sendPromptToControllerMock).toHaveBeenCalledTimes(1);
    expect(runLocalCapabilityConversationFlowMock).not.toHaveBeenCalled();
    expect(queueAutoTitleConversationMock).not.toHaveBeenCalled();
    expect(sendPromptToControllerMock.mock.calls[0][2]).toMatchObject({
      groupParticipationPreflight: {
        status: "controller_deferred",
      },
    });
  });

  it("returns controller-deferred from the outer preflight when the resolver is unavailable", async () => {
    resolveParticipationMock.mockResolvedValue(null);

    const result = await flow!.resolveGroupParticipationBeforeSubmit({
      conversationId: "conversation-local",
      displayPrompt: "What is 1 + 1?",
      dispatchPrompt: "What is 1 + 1?",
      metadata: null,
      agentSelection: {
        activeHandles: ["octo"],
        explicitMentionedHandles: [],
        mentionedHandles: [],
        targetHandles: ["octo"],
        nextStickyMentionedAgent: null,
        usesDefaultAssistantOnly: true,
      },
      hasTerminalCommand: false,
      hasBrowserTask: false,
    });

    expect(result).toEqual({
      mode: "controller_deferred",
      metadata: {
        groupParticipationPreflight: { status: "controller_deferred" },
      },
    });
  });

  it.each([
    {
      label: "correct human answer",
      content: "2",
      reason: "correct_arithmetic_follow_up_covered_by_human",
      coverage: "cancel_active_octo" as const,
    },
    {
      label: "incorrect human answer",
      content: "3",
      reason: "incorrect_arithmetic_follow_up_covered_by_active_octo",
      coverage: "await_active_octo" as const,
    },
  ])(
    "defers authoritative active-Octo coverage for a $label to atomic controller dispatch",
    async ({ content, coverage, reason }) => {
      resolveParticipationMock.mockResolvedValue({
        decision: "silent",
        domain: "arithmetic",
        reason,
        confidence: 100,
        participantCount: 2,
        targetMessageId: "question-message",
        coveredRunId: "run-1",
        coveredJobId: "job-1",
        coverage,
        policySkillPath: ".agents/skills/instafy-group-participation/SKILL.md",
      });

      const result = await flow!.resolveGroupParticipationBeforeSubmit({
        conversationId: "conversation-local",
        displayPrompt: content,
        dispatchPrompt: content,
        metadata: null,
        agentSelection: {
          activeHandles: ["octo"],
          explicitMentionedHandles: [],
          mentionedHandles: [],
          targetHandles: ["octo"],
          nextStickyMentionedAgent: null,
          usesDefaultAssistantOnly: true,
        },
        hasTerminalCommand: false,
        hasBrowserTask: false,
      });

      expect(result).toMatchObject({
        mode: "controller_coverage",
        metadata: {
          groupParticipation: {
            decision: "silent",
            coveredRunId: "run-1",
            coveredJobId: "job-1",
            coverage,
          },
          groupParticipationPreflight: { status: "controller_coverage" },
        },
      });
    },
  );

  it("dispatches authoritative coverage to the controller without local correction work", async () => {
    resolveParticipationMock.mockResolvedValue({
      decision: "silent",
      domain: "arithmetic",
      reason: "incorrect_arithmetic_follow_up_covered_by_active_octo",
      confidence: 100,
      participantCount: 2,
      targetMessageId: "question-message",
      coveredRunId: "run-1",
      coveredJobId: "job-1",
      coverage: "await_active_octo",
      policySkillPath: ".agents/skills/instafy-group-participation/SKILL.md",
    });
    resolveLocalCapabilityHandleMock.mockReturnValue("octo");

    await act(async () => {
      await flow!.handleSubmit("conversation-local", "3");
    });

    expect(recordMessageToControllerMock).not.toHaveBeenCalled();
    expect(runLocalCapabilityConversationFlowMock).not.toHaveBeenCalled();
    expect(queueAutoTitleConversationMock).not.toHaveBeenCalled();
    expect(sendPromptToControllerMock).toHaveBeenCalledTimes(1);
    expect(sendPromptToControllerMock.mock.calls[0][2]).toMatchObject({
      groupParticipation: {
        coverage: "await_active_octo",
        coveredRunId: "run-1",
      },
      groupParticipationPreflight: { status: "controller_coverage" },
    });
  });

  it("bypasses participation for a browser-routed task", async () => {
    const result = await flow!.resolveGroupParticipationBeforeSubmit({
      conversationId: "conversation-local",
      displayPrompt: "click the blue button",
      dispatchPrompt: "click the blue button",
      metadata: null,
      agentSelection: {
        activeHandles: ["octo"],
        explicitMentionedHandles: [],
        mentionedHandles: [],
        targetHandles: ["octo"],
        nextStickyMentionedAgent: null,
        usesDefaultAssistantOnly: true,
      },
      hasTerminalCommand: false,
      hasBrowserTask: true,
    });

    expect(resolveParticipationMock).not.toHaveBeenCalled();
    expect(result).toEqual({
      mode: "unchanged",
      metadata: {
        groupParticipationPreflight: { status: "bypassed" },
      },
    });
  });

  it("preserves the existing dispatch path only when the resolver route is unsupported", async () => {
    resolveParticipationMock.mockResolvedValue("unsupported");

    await act(async () => {
      await flow!.handleSubmit("conversation-local", "What is 1 + 1?");
    });

    expect(resolveParticipationMock).toHaveBeenCalledTimes(1);
    expect(recordMessageToControllerMock).not.toHaveBeenCalled();
    expect(sendPromptToControllerMock).toHaveBeenCalledTimes(1);
    expect(appendMessages).toHaveBeenCalledTimes(1);
  });

  it("skips the resolver and dispatches when the peer directory resolves to a single human", async () => {
    const result = await flow!.resolveGroupParticipationBeforeSubmit({
      conversationId: "conversation-local",
      displayPrompt: "What is 1 + 1?",
      dispatchPrompt: "What is 1 + 1?",
      metadata: null,
      agentSelection: {
        activeHandles: ["octo"],
        explicitMentionedHandles: [],
        mentionedHandles: [],
        targetHandles: ["octo"],
        nextStickyMentionedAgent: null,
        usesDefaultAssistantOnly: true,
      },
      hasTerminalCommand: false,
      hasBrowserTask: false,
      humanPeerContext: { hasHumanPeer: false, resolved: true },
    });

    expect(resolveParticipationMock).not.toHaveBeenCalled();
    expect(result).toEqual({
      mode: "dispatch",
      metadata: {
        groupParticipationPreflight: { status: "single_human" },
      },
    });
  });

  it.each([
    {
      label: "a human peer is present",
      humanPeerContext: { hasHumanPeer: true, resolved: true },
    },
    {
      label: "the peer directory is unresolved",
      humanPeerContext: { hasHumanPeer: false, resolved: false },
    },
  ])("keeps the resolver preflight when $label", async ({ humanPeerContext }) => {
    resolveParticipationMock.mockResolvedValue({
      decision: "respond",
      domain: "arithmetic",
      reason: "open_factual_question",
      confidence: 99,
      participantCount: 2,
      policySkillPath: ".agents/skills/instafy-group-participation/SKILL.md",
    });

    const result = await flow!.resolveGroupParticipationBeforeSubmit({
      conversationId: "conversation-local",
      displayPrompt: "What is 1 + 1?",
      dispatchPrompt: "What is 1 + 1?",
      metadata: null,
      agentSelection: {
        activeHandles: ["octo"],
        explicitMentionedHandles: [],
        mentionedHandles: [],
        targetHandles: ["octo"],
        nextStickyMentionedAgent: null,
        usesDefaultAssistantOnly: true,
      },
      hasTerminalCommand: false,
      hasBrowserTask: false,
      humanPeerContext,
    });

    expect(resolveParticipationMock).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      mode: "dispatch",
      metadata: {
        groupParticipationPreflight: { status: "resolved" },
      },
    });
  });

  it("dispatches a single-human preflight turn without re-resolving participation", async () => {
    await act(async () => {
      await flow!.handleSubmit("conversation-local", "What is 1 + 1?", {
        metadata: {
          groupParticipationPreflight: { status: "single_human" },
        },
      });
    });

    expect(resolveParticipationMock).not.toHaveBeenCalled();
    expect(recordMessageToControllerMock).not.toHaveBeenCalled();
    expect(sendPromptToControllerMock).toHaveBeenCalledTimes(1);
    expect(queueAutoTitleConversationMock).toHaveBeenCalledTimes(1);
  });

  it("stops dispatching to a sticky custom agent once chat-without-AI clears the shared map", async () => {
    conversation.assistantEnabled = false;
    conversation.extraAgentHandles = [];
    // Simulate an earlier "@maria …" turn having established stickiness.
    flow!.stickyMentionedAgentByConversationRef.current.set("conversation-local", "maria");

    await act(async () => {
      await flow!.handleSubmit("conversation-local", "Any update?", {
        agentHandles: ["maria"],
      });
    });

    // Control: while sticky, a plain follow-up still targets @maria.
    expect(sendPromptToControllerMock).toHaveBeenCalledTimes(1);
    expect(sendPromptToControllerMock.mock.calls[0][2]).toMatchObject({
      agentSelection: { mentions: ["maria"] },
    });
    expect(recordMessageToControllerMock).not.toHaveBeenCalled();

    // "Chat without AI" clears the same map handleSubmit consults.
    flow!.stickyMentionedAgentByConversationRef.current.delete("conversation-local");
    sendPromptToControllerMock.mockClear();

    await act(async () => {
      await flow!.handleSubmit("conversation-local", "Thanks everyone!", {
        agentHandles: ["maria"],
      });
    });

    expect(sendPromptToControllerMock).not.toHaveBeenCalled();
    expect(recordMessageToControllerMock).toHaveBeenCalledTimes(1);
    expect(recordMessageToControllerMock).toHaveBeenCalledWith(
      "conversation-local",
      "Thanks everyone!",
      expect.objectContaining({ clientMessageId: expect.any(String) }),
      "user",
      conversation,
    );
  });

  it("classifies replies to humans but bypasses replies to Octo", async () => {
    conversation.messages = [
      {
        id: "human-message",
        role: "user",
        authorId: "other-user",
        content: "I prefer option A.",
        timestamp: 1,
      },
      {
        id: "octo-message",
        role: "assistant",
        authorId: null,
        content: "Option A has lower migration risk.",
        timestamp: 2,
      },
    ];
    resolveParticipationMock.mockResolvedValue({
      decision: "silent",
      domain: "decision",
      reason: "reply_to_human",
      confidence: 90,
      participantCount: 2,
      targetMessageId: "human-message",
      policySkillPath: ".agents/skills/instafy-group-participation/SKILL.md",
    });

    await act(async () => {
      await flow!.handleSubmit("conversation-local", "Agreed.", {
        metadata: { replyContext: { messageId: "human-message" } },
      });
    });
    expect(resolveParticipationMock).toHaveBeenCalledWith(
      expect.objectContaining({
        replyToOcto: false,
        replyToHuman: true,
        metadata: expect.objectContaining({
          replyContext: { messageId: "human-message" },
        }),
      }),
    );

    resolveParticipationMock.mockClear();
    recordMessageToControllerMock.mockClear();
    sendPromptToControllerMock.mockClear();
    await act(async () => {
      await flow!.handleSubmit("conversation-local", "Can you explain that?", {
        metadata: { replyContext: { messageId: "octo-message" } },
      });
    });
    expect(resolveParticipationMock).not.toHaveBeenCalled();
    expect(sendPromptToControllerMock).toHaveBeenCalledTimes(1);
  });

  it("remembers each prompt it sends with the runs it started, so only this page retries it automatically", async () => {
    forgetPromptsSentFromThisPageForTests();
    sendPromptToControllerMock.mockResolvedValue({ ok: true, runIds: ["run-1"], jobIds: ["job-1"] });

    await act(async () => {
      await flow!.handleSubmit("conversation-local", "@octo verify this answer");
    });

    const appendedMessage = appendMessages.mock.calls[0][1][0];
    expect(wasRunStartedByPromptSentFromThisPage(appendedMessage, ["job-1"])).toBe(true);
    expect(wasRunStartedByPromptSentFromThisPage(appendedMessage, ["run-1"])).toBe(true);
    expect(wasRunStartedByPromptSentFromThisPage(appendedMessage, ["run-of-another-prompt"])).toBe(
      false,
    );
    // The copy the controller stores has its own id and keeps the client
    // message id under prompt_metadata.
    const sentMetadata = sendPromptToControllerMock.mock.calls[0][2] as Record<string, unknown>;
    expect(typeof sentMetadata.clientMessageId).toBe("string");
    expect(
      wasRunStartedByPromptSentFromThisPage(
        {
          id: "stored-prompt-id",
          metadata: { prompt_metadata: { clientMessageId: sentMetadata.clientMessageId } },
        },
        ["run-1"],
      ),
    ).toBe(true);
  });

  it("records no run for a note group participation only recorded", async () => {
    forgetPromptsSentFromThisPageForTests();

    await act(async () => {
      await flow!.handleSubmit("conversation-local", "Sam, the staging link is in the doc", {
        metadata: {
          groupParticipation: { decision: "silent" },
          groupParticipationPreflight: { status: "resolved" },
        },
      });
    });

    expect(sendPromptToControllerMock).not.toHaveBeenCalled();
    expect(recordMessageToControllerMock).toHaveBeenCalledTimes(1);
    const appendedMessage = appendMessages.mock.calls[0][1][0];
    // No failed run can be traced back to it, so it is never resent automatically.
    expect(wasRunStartedByPromptSentFromThisPage(appendedMessage, ["run-1"])).toBe(false);
    expect(wasRunStartedByPromptSentFromThisPage(appendedMessage, [])).toBe(false);
  });

  it("records a prompt whose dispatch failed, so a resend of a failed run keeps its Try again", async () => {
    forgetPromptsSentFromThisPageForTests();
    sendPromptToControllerMock.mockResolvedValue({
      ok: false,
      errorMessage: "Controller unavailable. Try again shortly.",
    });

    await act(async () => {
      await flow!.handleSubmit("conversation-local", "@octo verify this answer", {
        metadata: { retryOfMessageId: "failure-1" },
      });
    });

    expect(sendPromptToControllerMock).toHaveBeenCalledTimes(1);
    const appendedMessage = appendMessages.mock.calls[0][1][0];
    expect(didSendFailForPromptSentFromThisPage(appendedMessage)).toBe(true);

    // One that went out is not.
    forgetPromptsSentFromThisPageForTests();
    appendMessages.mockClear();
    sendPromptToControllerMock.mockResolvedValue({ ok: true, runIds: ["run-1"], jobIds: [] });
    await act(async () => {
      await flow!.handleSubmit("conversation-local", "@octo verify this answer");
    });
    expect(didSendFailForPromptSentFromThisPage(appendedMessage)).toBe(false);
    expect(didSendFailForPromptSentFromThisPage(appendMessages.mock.calls[0][1][0])).toBe(false);
  });

  it("records a prompt whose recording failed", async () => {
    const silentNote = {
      metadata: {
        groupParticipation: { decision: "silent" },
        groupParticipationPreflight: { status: "resolved" },
      },
    };
    forgetPromptsSentFromThisPageForTests();
    recordMessageToControllerMock.mockResolvedValue(null);
    await act(async () => {
      await flow!.handleSubmit("conversation-local", "Sam, the staging link is in the doc", silentNote);
    });
    expect(recordMessageToControllerMock).toHaveBeenCalledTimes(1);
    expect(didSendFailForPromptSentFromThisPage(appendMessages.mock.calls[0][1][0])).toBe(true);

    appendMessages.mockClear();
    recordMessageToControllerMock.mockResolvedValue({
      id: "stored-note",
      role: "user",
      authorId: "user-1",
      content: "Sam, the staging link is in the doc",
      timestamp: 1,
      files: null,
      messageType: null,
      metadata: null,
    });
    await act(async () => {
      await flow!.handleSubmit("conversation-local", "Sam, the staging link is in the doc", silentNote);
    });
    expect(didSendFailForPromptSentFromThisPage(appendMessages.mock.calls[0][1][0])).toBe(false);
  });
});
