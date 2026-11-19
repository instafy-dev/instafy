/** @vitest-environment jsdom */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ControllerApiError } from "../../services/runtimeController/core";
import type { ChatMessage } from "../../screens/studio/types";
import type { ConversationState } from "../conversationState";

const sendMessageMock = vi.hoisted(() => vi.fn());
const appendMessagesMock = vi.hoisted(() => vi.fn());

vi.mock("../../sdk/instafy", async () => {
  const actual = await vi.importActual<typeof import("../../sdk/instafy")>("../../sdk/instafy");
  return {
    ...actual,
    controllerClient: {
      ...actual.controllerClient,
      core: { ...actual.controllerClient.core, enabled: true },
      conversations: {
        ...actual.controllerClient.conversations,
        createBlank: vi.fn(),
        recordMessage: vi.fn(),
        sendMessage: sendMessageMock,
      },
      runtimes: { ...actual.controllerClient.runtimes, ensure: vi.fn(), fetchStatus: vi.fn() },
    },
  };
});

import { useConversationControllerDispatch } from "../useConversationControllerDispatch";

const PROJECT_ID = "11111111-2222-4333-8444-555555555555";
const CONTROLLER_CONVERSATION_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const RUNTIME_ID = "99999999-8888-4777-8666-555555555555";
// A person's message to an agent whose AI is Claude Code: nothing in it says
// so. The controller knows from the agent (docs/Local-Engine-Turns.md 11.3).
const TO_AGENT = {
  agentSelection: { active: ["reviewer"], mentions: ["reviewer"] },
  input: { kind: "person" },
};
const PIN = { runtimeId: RUNTIME_ID, runtimeDisplayName: null, preferRuntime: false };

type DispatchApi = ReturnType<typeof useConversationControllerDispatch>;

function HookHarness({ onReady }: { onReady: (api: DispatchApi) => void }) {
  const api = useConversationControllerDispatch({
    conversations: [
      {
        localId: "conversation-local",
        controllerId: CONTROLLER_CONVERSATION_ID,
        title: "Test conversation",
        messages: [],
      } as unknown as ConversationState,
    ],
    activeConversation: null,
    activeProjectId: PROJECT_ID,
    currentUserId: "user-1",
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
    appendMessages: appendMessagesMock,
    linkRunToConversation: vi.fn(),
  } as unknown as Parameters<typeof useConversationControllerDispatch>[0]);
  onReady(api);
  return null;
}

function refusal(status: number, code: string, message: string, details: unknown = null) {
  return new ControllerApiError({ status, code, message, details });
}

describe("a send refused because a turn it would start runs on a turn engine", () => {
  let container: HTMLDivElement;
  let root: Root;
  let api: DispatchApi | null = null;

  beforeEach(async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    sendMessageMock.mockReset();
    appendMessagesMock.mockReset();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(<HookHarness onReady={(value) => (api = value)} />);
    });
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    api = null;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  async function send(
    metadata: Record<string, unknown> | null,
    requirements?: { callerReportsErrors?: boolean },
  ): Promise<Record<string, unknown>> {
    let result: Record<string, unknown> = {};
    await act(async () => {
      result = (await api!.sendPromptToController(
        "conversation-local",
        "Fix the failing login test",
        metadata,
        PIN,
        undefined,
        undefined,
        true,
        requirements,
      )) as unknown as Record<string, unknown>;
    });
    return result;
  }

  function appendedRows(): ChatMessage[] {
    return appendMessagesMock.mock.calls.flatMap((call) => call[1] as ChatMessage[]);
  }

  it("keeps its code through ControllerApiError and shows its engine's sentence in place of the raw text", async () => {
    sendMessageMock.mockRejectedValue(
      refusal(422, "claude_code_turn_unsupported", "claude_code_turn_unsupported: attachments on a lane turn", {
        reason: "attachments",
      }),
    );
    const result = await send(TO_AGENT);
    const sentence = "Claude Code can't take attachments yet. Send your message without them.";
    expect(result).toEqual({
      ok: false,
      errorMessage: sentence,
      turnEngineRefusal: { engineId: "claude-code", code: "claude_code_turn_unsupported", sentence },
    });
    const rows = appendedRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.content).toBe(sentence);
    expect(rows[0]?.messageType).toBe("error");
    expect(JSON.stringify(rows)).not.toContain("lane turn");
  });

  it("words the switch's refusal, and any other Claude Code code plainly", async () => {
    sendMessageMock.mockRejectedValueOnce(refusal(403, "claude_code_turn_not_allowed", "not allowed"));
    expect((await send(TO_AGENT)).errorMessage).toBe(
      "Claude Code turns aren't on for your account. Choose another AI for this agent in Your AI.",
    );
    sendMessageMock.mockRejectedValueOnce(refusal(409, "claude_code_machine_busy", "runtime has a leased job"));
    expect((await send(TO_AGENT)).errorMessage).toBe("Claude Code couldn't take this message.");
  });

  it("adds no row when the caller reports what became of the send", async () => {
    sendMessageMock.mockRejectedValue(refusal(403, "claude_code_turn_not_allowed", "not allowed"));
    const result = await send(TO_AGENT, { callerReportsErrors: true });
    expect(result.errorMessage).toBe(
      "Claude Code turns aren't on for your account. Choose another AI for this agent in Your AI.",
    );
    expect(appendMessagesMock).not.toHaveBeenCalled();
  });

  it("leaves every other failed send as it was", async () => {
    // A busy chat is not Claude Code's to word, whatever the send.
    sendMessageMock.mockRejectedValueOnce(refusal(409, "dispatch_lane_busy", "Octo is busy in this chat (409)"));
    expect(await send(TO_AGENT)).toEqual({
      ok: false,
      errorMessage: "Octo is busy in this chat (409)",
    });
    // A send that failed without a refusal code keeps its own text.
    sendMessageMock.mockRejectedValueOnce(new Error("Controller unavailable. Try again shortly."));
    expect(await send(TO_AGENT)).toEqual({ ok: false, errorMessage: "Controller unavailable. Try again shortly." });
    expect(appendedRows().map((row) => row.content)).toEqual([
      "Octo is busy in this chat (409)",
      "Controller unavailable. Try again shortly.",
    ]);
  });
});
