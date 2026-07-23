/** @vitest-environment jsdom */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversationState } from "../conversationState";

const sendMessageMock = vi.hoisted(() => vi.fn());
const recordMessageMock = vi.hoisted(() => vi.fn());
const createBlankMock = vi.hoisted(() => vi.fn());
const setConversationControllerIdMock = vi.hoisted(() => vi.fn());

vi.mock("../../sdk/instafy", async () => {
  const actual = await vi.importActual<typeof import("../../sdk/instafy")>("../../sdk/instafy");
  return {
    ...actual,
    controllerClient: {
      ...actual.controllerClient,
      core: { ...actual.controllerClient.core, enabled: true },
      conversations: {
        ...actual.controllerClient.conversations,
        createBlank: createBlankMock,
        recordMessage: recordMessageMock,
        sendMessage: sendMessageMock,
      },
      runtimes: {
        ...actual.controllerClient.runtimes,
        ensure: vi.fn(),
        fetchStatus: vi.fn(),
      },
    },
  };
});

import { useConversationControllerDispatch } from "../useConversationControllerDispatch";

const PROJECT_ID = "11111111-2222-4333-8444-555555555555";
const CONTROLLER_CONVERSATION_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const showStatusMock = vi.fn();

function buildConversation(): ConversationState {
  return {
    localId: "conversation-local",
    controllerId: CONTROLLER_CONVERSATION_ID,
    title: "Test conversation",
    messages: [],
  } as unknown as ConversationState;
}

type DispatchApi = ReturnType<typeof useConversationControllerDispatch>;

function HookHarness({
  activeConversation = null,
  conversations = [buildConversation()],
  onReady,
}: {
  activeConversation?: ConversationState | null;
  conversations?: ConversationState[];
  onReady: (api: DispatchApi) => void;
}) {
  const api = useConversationControllerDispatch({
    conversations,
    activeConversation,
    activeProjectId: PROJECT_ID,
    currentUserId: "user-1",
    preferredRuntimeId: null,
    runtimeStatuses: [],
    effectiveRuntimeId: null,
    effectiveRuntimeSource: "auto",
    showStatus: showStatusMock,
    createConversation: vi.fn(),
    selectConversation: vi.fn(),
    markConversationRead: vi.fn(),
    setConversationDraft: vi.fn(),
    setConversationControllerId: setConversationControllerIdMock,
    appendMessages: vi.fn(),
    linkRunToConversation: vi.fn(),
  } as unknown as Parameters<typeof useConversationControllerDispatch>[0]);
  onReady(api);
  return null;
}

describe("useConversationControllerDispatch write expectations", () => {
  let container: HTMLDivElement;
  let root: Root;
  let api: DispatchApi | null = null;

  beforeEach(async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    window.history.replaceState({}, "", "/");
    sendMessageMock.mockReset();
    sendMessageMock.mockResolvedValue({ runId: "run-1" });
    createBlankMock.mockReset();
    setConversationControllerIdMock.mockReset();
    recordMessageMock.mockReset();
    recordMessageMock.mockResolvedValue({
      id: "message-1",
      conversationId: CONTROLLER_CONVERSATION_ID,
      projectId: PROJECT_ID,
      sessionId: null,
      createdBy: "user-1",
      promptId: null,
      runId: null,
      role: "user",
      content: "hello",
      metadata: { clientMessageId: "client-message-1" },
      createdAt: new Date(0).toISOString(),
    });
    showStatusMock.mockReset();
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
    window.history.replaceState({}, "", "/");
    api = null;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  async function dispatch(
    metadata: Record<string, unknown> | null,
    intent?: string,
  ): Promise<Record<string, unknown>> {
    await act(async () => {
      const result = await api!.sendPromptToController(
        "conversation-local",
        "hello",
        metadata,
        undefined,
        undefined,
        intent,
      );
      expect(result).toEqual({ ok: true });
    });
    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    return sendMessageMock.mock.calls[0][0] as Record<string, unknown>;
  }

  // Contract: interactive chat must dispatch write-capable by default without
  // requiring every turn to mutate the workspace. `workspaceFileChanges` is a
  // success expectation and makes correct Q&A replies fail when no edit occurs.
  it("defaults interactive dispatches to writable without requiring file changes", async () => {
    const sent = await dispatch({ client: { sessionId: "session-1" } });
    const metadata = sent.metadata as Record<string, unknown>;
    expect(metadata.writeIntent).toBe(true);
    expect(metadata.runtimeExpectations).toBeUndefined();
  });

  it("keeps terminal_command dispatch metadata untouched", async () => {
    const sent = await dispatch({ client: { sessionId: "session-1" } }, "terminal_command");
    const metadata = sent.metadata as Record<string, unknown>;
    expect(metadata.runtimeExpectations).toBeUndefined();
  });

  it("honors explicit read-only policy over the writable default", async () => {
    const sent = await dispatch({ writeIntent: false });
    const metadata = sent.metadata as Record<string, unknown>;
    expect(metadata.writeIntent).toBe(false);
    expect(metadata.runtimeExpectations).toBeUndefined();
  });

  it("honors explicit runtime expectations over the writable default", async () => {
    const sent = await dispatch({
      runtimeExpectations: { workspaceFileChanges: false },
    });
    const metadata = sent.metadata as Record<string, unknown>;
    expect(metadata.runtimeExpectations).toEqual({ workspaceFileChanges: false });
  });

  it("records through the route controller id while local hydration is pending", async () => {
    window.history.replaceState(
      {},
      "",
      `/?projectId=${PROJECT_ID}&conversationId=route-local&conversationControllerId=${CONTROLLER_CONVERSATION_ID}`,
    );
    await act(async () => {
      root.render(
        <HookHarness
          conversations={[]}
          onReady={(value) => (api = value)}
        />,
      );
    });

    await act(async () => {
      await api!.recordMessageToController("route-local", "hello", {
        clientMessageId: "client-message-1",
      });
    });

    expect(recordMessageMock).toHaveBeenCalledTimes(1);
    expect(recordMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: CONTROLLER_CONVERSATION_ID,
        projectId: PROJECT_ID,
        content: "hello",
        metadata: { clientMessageId: "client-message-1" },
      }),
    );
    expect(showStatusMock).not.toHaveBeenCalled();
  });

  it("attaches a controller-only route only after its project-scoped record succeeds", async () => {
    const hydratingConversation = {
      ...buildConversation(),
      localId: "hydrating-local",
      controllerId: null,
    };
    window.history.replaceState(
      {},
      "",
      `/?projectId=${PROJECT_ID}&conversationControllerId=${CONTROLLER_CONVERSATION_ID}`,
    );
    await act(async () => {
      root.render(
        <HookHarness
          activeConversation={hydratingConversation}
          conversations={[hydratingConversation]}
          onReady={(value) => (api = value)}
        />,
      );
    });

    await act(async () => {
      await api!.recordMessageToController("hydrating-local", "hello", {
        clientMessageId: "client-message-1",
      });
    });

    expect(setConversationControllerIdMock).toHaveBeenCalledWith(
      "hydrating-local",
      CONTROLLER_CONVERSATION_ID,
    );
    expect(createBlankMock).not.toHaveBeenCalled();
    expect(recordMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: CONTROLLER_CONVERSATION_ID,
        projectId: PROJECT_ID,
        content: "hello",
      }),
    );
    expect(showStatusMock).not.toHaveBeenCalled();
  });

  it("does not poison local state when a route conversation fails project validation", async () => {
    const hydratingConversation = {
      ...buildConversation(),
      localId: "hydrating-local",
      controllerId: null,
    };
    window.history.replaceState(
      {},
      "",
      `/?projectId=${PROJECT_ID}&conversationControllerId=${CONTROLLER_CONVERSATION_ID}`,
    );
    recordMessageMock.mockResolvedValueOnce(null);
    await act(async () => {
      root.render(
        <HookHarness
          activeConversation={hydratingConversation}
          conversations={[hydratingConversation]}
          onReady={(value) => (api = value)}
        />,
      );
    });

    let result: Awaited<ReturnType<DispatchApi["recordMessageToController"]>> | undefined;
    await act(async () => {
      result = await api!.recordMessageToController("hydrating-local", "hello", {
        clientMessageId: "client-message-1",
      });
    });

    expect(result).toBeNull();
    expect(recordMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: CONTROLLER_CONVERSATION_ID,
        projectId: PROJECT_ID,
      }),
    );
    expect(setConversationControllerIdMock).not.toHaveBeenCalled();
    expect(showStatusMock).toHaveBeenCalledWith(
      "Message error: Unable to send message. Try again shortly.",
      "error",
      4000,
    );
  });

  it("visibly fails when a record-only turn cannot be matched to a conversation", async () => {
    window.history.replaceState({}, "", `/?projectId=${PROJECT_ID}`);
    await act(async () => {
      root.render(
        <HookHarness
          conversations={[]}
          onReady={(value) => (api = value)}
        />,
      );
    });

    let result: Awaited<ReturnType<DispatchApi["recordMessageToController"]>> | undefined;
    await act(async () => {
      result = await api!.recordMessageToController("missing-local", "hello", {
        clientMessageId: "client-message-1",
      });
    });

    expect(result!).toBeNull();
    expect(recordMessageMock).not.toHaveBeenCalled();
    expect(showStatusMock).toHaveBeenCalledWith(
      "Message error: Conversation is still syncing. Try again shortly.",
      "error",
      4000,
    );
  });
});
