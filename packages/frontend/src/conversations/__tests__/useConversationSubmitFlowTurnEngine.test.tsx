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

// A person's message: nothing in it says which AI its agent uses
// (docs/Local-Engine-Turns.md 11.3). The controller knows from the agent.
const PERSON_METADATA = { input: { kind: "person" } };
const PINNED_RUNTIME = { runtimeId: RUNTIME_ID, runtimeDisplayName: null, preferRuntime: false };

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

describe("useConversationSubmitFlow and a turn engine's refusal", () => {
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

  // Version 1's claim is gone (11.14): a key of that name gets nothing of what
  // the composer's choice once got.
  it("treats a send whatever its metadata holds as any send: participation, agents and a title", async () => {
    resolveParticipationMock.mockResolvedValue("unsupported");
    const preflight = await flow!.resolveGroupParticipationBeforeSubmit({
      conversationId: "conversation-local",
      displayPrompt: "Fix the failing login test",
      dispatchPrompt: "Fix the failing login test",
      metadata: { turnEngine: "claude-code", input: { kind: "person" } },
      agentSelection: OCTO_SELECTION,
      hasTerminalCommand: false,
      hasBrowserTask: false,
      humanPeerContext: { hasHumanPeer: true, resolved: true },
    });
    expect(preflight.metadata).not.toMatchObject({ groupParticipationPreflight: { status: "bypassed" } });

    await act(async () => {
      await flow!.handleSubmit("conversation-local", "Fix the failing login test", {
        metadata: { ...PERSON_METADATA, turnEngine: "claude-code" },
      });
    });
    expect(sendPromptToControllerMock).toHaveBeenCalledTimes(1);
    expect(queueAutoTitleConversationMock).toHaveBeenCalledTimes(1);
  });

  it("takes a refused send's message out of the chat and says so to the composer", async () => {
    const refusal = {
      engineId: "claude-code",
      code: "claude_code_turn_unsupported",
      sentence: "Claude Code can't take attachments yet. Send your message without them.",
    };
    sendPromptToControllerMock.mockResolvedValue({ ok: false, errorMessage: refusal.sentence, turnEngineRefusal: refusal });

    let thrown: unknown = null;
    await act(async () => {
      await flow!
        .handleSubmit("conversation-local", "@reviewer fix the failing login test", {
          metadata: PERSON_METADATA,
          runtimeOverride: PINNED_RUNTIME,
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
      await flow!.handleSubmit("conversation-local", "@reviewer fix the failing login test", {
        metadata: PERSON_METADATA,
        runtimeOverride: PINNED_RUNTIME,
      });
    });
    expect(sendPromptToControllerMock).toHaveBeenCalledTimes(1);
    expect(removeUnsentMessageMock).not.toHaveBeenCalled();
  });
});
