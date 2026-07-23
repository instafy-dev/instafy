/** @vitest-environment jsdom */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createInitialConversation, type ConversationState } from "../conversationState";

const resolveParticipationMock = vi.hoisted(() => vi.fn());
const ensureControllerConversationIdMock = vi.hoisted(() => vi.fn());
const recordMessageToControllerMock = vi.hoisted(() => vi.fn());
const sendPromptToControllerMock = vi.hoisted(() => vi.fn());
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
  appendMessages: ReturnType<typeof vi.fn>;
  updateMessage: ReturnType<typeof vi.fn>;
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
    showStatus: vi.fn(),
    createConversation: vi.fn(),
    selectConversation: vi.fn(),
    markConversationRead: vi.fn(),
    setConversationDraft: vi.fn(),
    setConversationControllerId: vi.fn(),
    setConversationTitle: vi.fn(),
    setConversationGoal: vi.fn(),
    appendMessages,
    updateMessage,
    linkRunToConversation: vi.fn(),
  });
  onReady(flow);
  return null;
}

describe("useConversationSubmitFlow group participation", () => {
  let container: HTMLDivElement;
  let root: Root;
  let flow: SubmitFlow | null;
  let conversation: ConversationState;
  let appendMessages: ReturnType<typeof vi.fn>;
  let updateMessage: ReturnType<typeof vi.fn>;

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
    sendPromptToControllerMock.mockResolvedValue({ ok: true });
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
});
