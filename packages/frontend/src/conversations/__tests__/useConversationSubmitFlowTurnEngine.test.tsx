/** @vitest-environment jsdom */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { createInitialConversation, type ConversationState } from "../conversationState";
import type { ResolvedPromptAgentSelection } from "../assistantMentions";
import { isTurnEngineSendRefusedError, type TurnEngineSendRefusedError } from "../turnEngineSendRefusal";
import type { ChatMessage } from "../../screens/studio/types";

const resolveParticipationMock = vi.hoisted(() => vi.fn());
const ensureControllerConversationIdMock = vi.hoisted(() => vi.fn());
const recordMessageToControllerMock = vi.hoisted(() => vi.fn());
const sendPromptToControllerMock = vi.hoisted(() => vi.fn());
const queueAutoTitleConversationMock = vi.hoisted(() => vi.fn());
const resolveLocalCapabilityHandleMock = vi.hoisted(() => vi.fn());
const appendMessagesMock = vi.hoisted(() => vi.fn());
const removeUnsentMessageMock = vi.hoisted(() => vi.fn());

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
        updateMetadata: vi.fn(async () => true),
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

import { useConversationSubmitFlow } from "../useConversationSubmitFlow";

const PROJECT_ID = "11111111-2222-4333-8444-555555555555";
const CONTROLLER_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const USER_ID = "99999999-8888-4777-8666-555555555555";
const RUNTIME_ID = "dddddddd-bbbb-4ccc-8ddd-eeeeeeeeeeee";

// What the composer's routing puts on a send it routes to Claude Code.
const ROUTED_METADATA = {
  input: { kind: "person" },
  turnEngine: "claude-code",
  agentSelection: { active: ["octo"], mentions: ["octo"] },
  groupParticipationPreflight: { status: "bypassed" },
};
const ROUTED_RUNTIME = { runtimeId: RUNTIME_ID, runtimeDisplayName: null, preferRuntime: false };

const OCTO_SELECTION: ResolvedPromptAgentSelection = {
  activeHandles: ["octo"],
  explicitMentionedHandles: [],
  mentionedHandles: [],
  targetHandles: ["octo"],
  nextStickyMentionedAgent: null,
  usesDefaultAssistantOnly: true,
};

type SubmitFlow = ReturnType<typeof useConversationSubmitFlow>;

function HookHarness({
  conversation,
  onReady,
}: {
  conversation: ConversationState;
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
    appendMessages: appendMessagesMock,
    removeUnsentMessage: removeUnsentMessageMock,
    updateMessage: vi.fn() as Mock,
    linkRunToConversation: vi.fn(),
  });
  onReady(flow);
  return null;
}

describe("useConversationSubmitFlow for a send that claims a turn engine", () => {
  let container: HTMLDivElement;
  let root: Root;
  let flow: SubmitFlow | null;
  let conversation: ConversationState;

  async function mount() {
    await act(async () => {
      root.render(
        <HookHarness
          conversation={conversation}
          onReady={(value) => {
            flow = value;
          }}
        />,
      );
    });
  }

  beforeEach(async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    flow = null;
    conversation = createInitialConversation({ localId: "conversation-local", controllerId: CONTROLLER_ID });

    for (const mock of [
      resolveParticipationMock,
      ensureControllerConversationIdMock,
      recordMessageToControllerMock,
      sendPromptToControllerMock,
      queueAutoTitleConversationMock,
      resolveLocalCapabilityHandleMock,
      appendMessagesMock,
      removeUnsentMessageMock,
      controllerDispatchMock.resolveProjectId,
      controllerDispatchMock.resolveRuntimeTarget,
      controllerDispatchMock.ensureConversation,
    ]) {
      mock.mockReset();
    }
    controllerDispatchMock.resolveProjectId.mockReturnValue(PROJECT_ID);
    controllerDispatchMock.resolveRuntimeTarget.mockReturnValue({
      runtimeId: null,
      runtimeDisplayName: null,
      preferRuntime: null,
    });
    controllerDispatchMock.ensureConversation.mockImplementation(() => conversation);
    ensureControllerConversationIdMock.mockResolvedValue(CONTROLLER_ID);
    recordMessageToControllerMock.mockResolvedValue(null);
    sendPromptToControllerMock.mockResolvedValue({ ok: true, runIds: [], jobIds: [] });
    resolveParticipationMock.mockResolvedValue("unsupported");
    resolveLocalCapabilityHandleMock.mockReturnValue(null);
    await mount();
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("bypasses the participation preflight, so the send is never only recorded", async () => {
    const result = await flow!.resolveGroupParticipationBeforeSubmit({
      conversationId: "conversation-local",
      displayPrompt: "Fix the failing login test",
      dispatchPrompt: "Fix the failing login test",
      metadata: { turnEngine: "claude-code", input: { kind: "person" } },
      agentSelection: OCTO_SELECTION,
      hasTerminalCommand: false,
      hasBrowserTask: false,
      humanPeerContext: { hasHumanPeer: true, resolved: true },
    });
    expect(result).toEqual({
      mode: "unchanged",
      metadata: {
        turnEngine: "claude-code",
        input: { kind: "person" },
        groupParticipationPreflight: { status: "bypassed" },
      },
    });
    expect(resolveParticipationMock).not.toHaveBeenCalled();
  });

  it("dispatches it as routed: its own agents and runtime, no participation check, no title", async () => {
    await act(async () => {
      await flow!.handleSubmit("conversation-local", "@octo fix the failing login test", {
        metadata: ROUTED_METADATA,
        runtimeOverride: ROUTED_RUNTIME,
        expectedLaneIdle: true,
      });
    });

    expect(sendPromptToControllerMock).toHaveBeenCalledTimes(1);
    const [targetId, prompt, metadata, runtimeOverride, , intent, expectedLaneIdle] =
      sendPromptToControllerMock.mock.calls[0];
    expect(targetId).toBe("conversation-local");
    expect(prompt).toBe("@octo fix the failing login test");
    expect(metadata).toMatchObject({
      turnEngine: "claude-code",
      agentSelection: { active: ["octo"], mentions: ["octo"] },
      groupParticipationPreflight: { status: "bypassed" },
    });
    // The words' own mention never rewrites what the routing chose.
    expect(metadata).not.toHaveProperty("agentCollaboration");
    expect(runtimeOverride).toEqual(ROUTED_RUNTIME);
    expect(intent).toBeUndefined();
    expect(expectedLaneIdle).toBe(true);
    expect(resolveParticipationMock).not.toHaveBeenCalled();
    expect(recordMessageToControllerMock).not.toHaveBeenCalled();
    expect(resolveLocalCapabilityHandleMock).not.toHaveBeenCalled();
    // No title request at send: a title is asked of a model.
    expect(queueAutoTitleConversationMock).not.toHaveBeenCalled();
  });

  it("takes a refused send's message out of the chat and says so to the composer", async () => {
    const refusal = {
      engineId: "claude-code",
      code: "claude_code_machine_busy",
      sentence: "Your computer is busy with another turn. Send this when it's done.",
    };
    sendPromptToControllerMock.mockResolvedValue({ ok: false, errorMessage: refusal.sentence, turnEngineRefusal: refusal });

    let thrown: unknown = null;
    await act(async () => {
      await flow!
        .handleSubmit("conversation-local", "@octo fix the failing login test", {
          metadata: ROUTED_METADATA,
          runtimeOverride: ROUTED_RUNTIME,
          expectedLaneIdle: true,
        })
        .catch((error: unknown) => {
          thrown = error;
        });
    });

    // The message was shown, then taken out again by its own client id: the
    // controller recorded nothing for it.
    const shown = appendMessagesMock.mock.calls.flatMap(([, rows]) => rows as ChatMessage[]);
    const sentMessage = shown.find((row) => row.role === "user");
    const clientMessageId = (sentMessage?.metadata as Record<string, unknown> | null)?.clientMessageId;
    expect(typeof clientMessageId).toBe("string");
    expect(removeUnsentMessageMock).toHaveBeenCalledExactlyOnceWith("conversation-local", clientMessageId);
    expect(isTurnEngineSendRefusedError(thrown)).toBe(true);
    expect((thrown as TurnEngineSendRefusedError).refusal).toEqual(refusal);
  });

  it("leaves a send that failed any other way in the chat", async () => {
    sendPromptToControllerMock.mockResolvedValue({ ok: false, errorMessage: "Controller unavailable. Try again shortly." });
    await act(async () => {
      await flow!.handleSubmit("conversation-local", "@octo fix the failing login test", {
        metadata: ROUTED_METADATA,
        runtimeOverride: ROUTED_RUNTIME,
        expectedLaneIdle: true,
      });
    });
    expect(removeUnsentMessageMock).not.toHaveBeenCalled();
  });

  it("asks for a title for the same first message without the claim", async () => {
    await act(async () => {
      await flow!.handleSubmit("conversation-local", "Fix the failing login test", {
        metadata: { input: { kind: "person" } },
      });
    });
    expect(sendPromptToControllerMock).toHaveBeenCalledTimes(1);
    expect(queueAutoTitleConversationMock).toHaveBeenCalledTimes(1);
  });

  it("dispatches it even when its words name no agent of the chat, and leaves the answer to the controller", async () => {
    conversation = { ...conversation, assistantEnabled: false };
    await mount();
    await act(async () => {
      await flow!.handleSubmit("conversation-local", "Fix the failing login test", {
        metadata: ROUTED_METADATA,
        runtimeOverride: ROUTED_RUNTIME,
        expectedLaneIdle: true,
      });
    });
    expect(sendPromptToControllerMock).toHaveBeenCalledTimes(1);
    expect(recordMessageToControllerMock).not.toHaveBeenCalled();

    // The same words without the claim are only recorded in this chat.
    sendPromptToControllerMock.mockClear();
    await act(async () => {
      await flow!.handleSubmit("conversation-local", "Fix the failing login test", {
        metadata: { input: { kind: "person" } },
      });
    });
    expect(sendPromptToControllerMock).not.toHaveBeenCalled();
    expect(recordMessageToControllerMock).toHaveBeenCalledTimes(1);
  });
});
