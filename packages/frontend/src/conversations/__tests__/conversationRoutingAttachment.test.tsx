/** @vitest-environment jsdom */

import { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ControllerConversationCreated,
  ControllerConversationMessage,
  ControllerProjectConversation,
} from "../../services/runtimeController/conversations";
import {
  conversationsReducer,
  createInitialConversation,
  type ConversationsAction,
  type ConversationsState,
} from "../conversationState";
import { createConversationRoutingMetadataPatch } from "../conversationRoutingMetadata";
import { buildHomeAttentionEntries } from "../../screens/studio/homeAttention";

vi.mock("../../sdk/instafy", async () => {
  const actual = await vi.importActual<typeof import("../../sdk/instafy")>("../../sdk/instafy");
  return {
    ...actual,
    controllerClient: {
      ...actual.controllerClient,
      core: { ...actual.controllerClient.core, enabled: true },
    },
  };
});

import { useConversationControllerSync } from "../useConversationControllerSync";
import { usePendingConversationEffects } from "../usePendingConversationEffects";

const PROJECT_ID = "11111111-2222-4333-8444-555555555555";
const CONTROLLER_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const USER_ID = "99999999-8888-4777-8666-555555555555";
const LOCAL_ID = "conversation-local";

function buildState(): ConversationsState {
  const conversation = {
    ...createInitialConversation({ localId: LOCAL_ID }),
    assistantEnabled: false,
    extraAgentHandles: ["reviewer"],
  };
  return {
    projectKey: PROJECT_ID,
    conversations: [conversation],
    activeId: LOCAL_ID,
    sequence: 2,
    runMap: {},
  };
}

function buildRemoteConversation(
  metadata: Record<string, unknown> = { localId: LOCAL_ID },
  createdBy: string | null = USER_ID,
): ControllerProjectConversation {
  return {
    id: CONTROLLER_ID,
    projectId: PROJECT_ID,
    sessionId: null,
    createdBy,
    metadata,
    createdAt: "2026-07-13T20:00:00.000Z",
    updatedAt: "2026-07-13T20:00:00.000Z",
  };
}

function buildConversationCreated(
  metadata: Record<string, unknown> = { localId: LOCAL_ID },
  createdBy: string | null = USER_ID,
): ControllerConversationCreated {
  return {
    conversationId: CONTROLLER_ID,
    projectId: PROJECT_ID,
    sessionId: null,
    createdBy,
    metadata,
    createdAt: "2026-07-13T20:00:00.000Z",
    updatedAt: "2026-07-13T20:00:00.000Z",
  };
}

function ControllerSyncHarness({
  state,
  dispatch,
  fetchProjectConversations,
  currentUserId = USER_ID,
  syncEpoch = 0,
  updateMetadata = vi.fn(),
}: {
  state: ConversationsState;
  dispatch: (action: ConversationsAction) => void;
  fetchProjectConversations: () => Promise<ControllerProjectConversation[] | null>;
  currentUserId?: string | null;
  syncEpoch?: number;
  updateMetadata?: (args: { conversationId: string; metadata: Record<string, unknown> }) => Promise<unknown>;
}) {
  const latestStateRef = useRef(state);
  latestStateRef.current = state;
  useConversationControllerSync({
    state,
    currentUserId,
    controllerProjectMissing: false,
    projectAccessPending: false,
    projectAccessBlocked: false,
    latestStateRef,
    dispatch,
    controllerConversationSyncEpoch: syncEpoch,
    bumpControllerConversationSyncEpoch: vi.fn(),
    fetchProjectConversationsFromController: fetchProjectConversations,
    updateControllerConversationMetadata: updateMetadata,
  });
  return null;
}

function PendingCreationHarness({
  state,
  dispatch,
  creation,
  messages = [],
  internalConversationIds,
  updateMetadata = vi.fn(),
}: {
  state: ConversationsState;
  dispatch: (action: ConversationsAction) => void;
  creation?: ControllerConversationCreated;
  messages?: ControllerConversationMessage[];
  internalConversationIds?: Readonly<Record<string, true>>;
  updateMetadata?: (args: { conversationId: string; metadata: Record<string, unknown> }) => Promise<unknown>;
}) {
  const lastBackgroundAtRef = useRef(0);
  const notifiedMessageIdsRef = useRef(new Set<string>());
  usePendingConversationEffects({
    state,
    projectKey: PROJECT_ID,
    currentUserId: USER_ID,
    pendingConversationCreations: creation ? [creation] : [],
    ackConversationCreations: vi.fn(),
    pendingConversationUpdates: [],
    ackConversationUpdates: vi.fn(),
    pendingConversationMessages: messages,
    internalConversationIds,
    ackConversationMessages: vi.fn(),
    lastBackgroundAtRef,
    notifiedMessageIdsRef,
    dispatch,
    updateControllerConversationMetadata: updateMetadata,
  });
  return null;
}

describe("conversation routing during controller attachment", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it.each([false, true])("retires a cached internal anchor's attention while retaining its audit history (audit open: %s)", async (auditOpen) => {
    const initialState = buildState();
    initialState.conversations[0].draft = "Keep my unfinished draft";
    const audit = {
      ...createInitialConversation({ localId: "cached-audit", controllerId: CONTROLLER_ID }),
      title: "Space review", unreadCount: 1, pendingRunIds: ["internal-run"],
      awaitingLeaseRunIds: ["queued-internal-run"], pendingRunSubmittedAt: { "internal-run": 1 },
      messages: [{ id: "audit-message", role: "assistant" as const, content: "Earlier audit evidence", timestamp: 1 }],
    };
    const normal = {
      ...createInitialConversation({ localId: "normal-delivery", controllerId: "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff" }),
      title: "Useful finding", unreadCount: 1,
    };
    initialState.conversations.push(audit, normal);
    initialState.runMap = { "internal-run": audit.localId, "queued-internal-run": audit.localId };
    if (auditOpen) initialState.activeId = audit.localId;
    const attention = (state: ConversationsState) => buildHomeAttentionEntries({
      conversations: state.conversations, inboxItems: [], currentSpaceName: "Space",
    });
    expect(attention(initialState)).toHaveLength(2);
    let nextState = initialState;
    const dispatch = vi.fn<(action: ConversationsAction) => void>((action) => {
      nextState = conversationsReducer(nextState, action);
    });
    const updateMetadata = vi.fn();
    await act(async () => root.render(<PendingCreationHarness state={initialState} dispatch={dispatch}
      internalConversationIds={{ [CONTROLLER_ID]: true }} updateMetadata={updateMetadata}
      creation={buildConversationCreated({ title: "Space review" })}
      messages={[{
        id: "late-internal-message", conversationId: CONTROLLER_ID, projectId: PROJECT_ID,
        sessionId: null, promptId: null, runId: null, role: "assistant", content: "Late queued audit event",
        metadata: null, createdAt: "2026-10-02T12:00:00Z",
      }]} />));

    expect(nextState.conversations).toHaveLength(3);
    expect(nextState.activeId).toBe(initialState.activeId);
    expect(nextState.conversations[0]).toEqual(initialState.conversations[0]);
    expect(nextState.conversations[1]).toMatchObject({
      lifecycleStatus: "hidden", unreadCount: 0, pendingRunIds: [], awaitingLeaseRunIds: [],
      pendingRunSubmittedAt: {}, messages: audit.messages,
    });
    expect(nextState.conversations[2]).toEqual(normal);
    expect(nextState.runMap).toEqual({});
    expect(attention(nextState).map((entry) => entry.title)).toEqual(["Useful finding"]);
    expect(dispatch.mock.calls.map(([action]) => action.type)).toEqual(["RETIRE_INTERNAL"]);
    expect(updateMetadata).not.toHaveBeenCalled();
  });

  it.each([
    ["history", ""], ["history", "My unsent work"],
    ["creation", ""], ["creation", "My unsent work"],
    ["message", ""], ["message", "My unsent work"],
    ["batched creation/message", ""], ["batched creation/message", "My unsent work"],
  ])("keeps a proactive %s separate without claiming or focusing the draft '%s'", async (source, draft) => {
    const initialState = buildState();
    initialState.conversations[0].draft = draft;
    initialState.conversations[0].draftEditorState = draft ? '{"draft":"editor-state"}' : null;
    let nextState = initialState;
    const dispatch = vi.fn<(action: ConversationsAction) => void>((action) => {
      nextState = conversationsReducer(nextState, action);
    });
    const metadata = {
      recommendationId: "12345678-1234-4234-8234-123456789012",
      title: "Check mobile signup",
      visibility: "private",
    };
    const updateMetadata = vi.fn();
    const message: ControllerConversationMessage = {
      id: "12345678-1234-4234-8234-123456789013",
      conversationId: CONTROLLER_ID, projectId: PROJECT_ID, sessionId: null,
      createdBy: null, promptId: null, runId: null, role: "assistant",
      content: "Mobile signup is still unchecked. Shall we try it next?", metadata,
      createdAt: "2026-10-02T12:00:00.000Z",
    };
    await act(async () => {
      root.render(source === "history" ? (
        <ControllerSyncHarness state={initialState} dispatch={dispatch}
          fetchProjectConversations={async () => [buildRemoteConversation(metadata)]}
          updateMetadata={updateMetadata} />
      ) : (
        <PendingCreationHarness state={initialState} dispatch={dispatch}
          creation={source === "message" ? undefined : buildConversationCreated(metadata)}
          messages={source === "creation" ? [] : [message]} />
      ));
    });

    expect(nextState.conversations).toHaveLength(2);
    expect(nextState.activeId).toBe(LOCAL_ID);
    expect(nextState.conversations[0]).toEqual(initialState.conversations[0]);
    const delivered = nextState.conversations[1];
    expect(delivered).toMatchObject({
      controllerId: CONTROLLER_ID, visibility: "private", draft: "", draftEditorState: null,
      assistantEnabled: true, extraAgentHandles: [], runtimePreference: null,
    });
    expect(delivered.localId).not.toBe(LOCAL_ID);
    expect(updateMetadata).not.toHaveBeenCalled();
    expect(dispatch.mock.calls.map(([action]) => action.type)).not.toContain("SET_CONTROLLER");
    expect(dispatch.mock.calls.map(([action]) => action.type)).not.toContain("SELECT");
    expect(dispatch.mock.calls.map(([action]) => action.type)).not.toContain("CLOSE");
    if (source === "message" || source === "batched creation/message") {
      expect(delivered.messages.map((entry) => entry.content)).toEqual([message.content]);
      expect(delivered.unreadCount).toBe(1);
    }
    if (source === "message") {
      // A delayed creation event must not add another chat or steal focus.
      await act(async () => root.render(<PendingCreationHarness state={nextState} dispatch={dispatch}
        creation={buildConversationCreated(metadata)} />));
      expect(nextState.conversations).toHaveLength(2);
      expect(nextState.activeId).toBe(LOCAL_ID);
    }
  });

  it("preserves local routing when history attaches a remote conversation without routing metadata", async () => {
    const dispatch = vi.fn<(action: ConversationsAction) => void>();
    const fetchProjectConversations = vi.fn().mockResolvedValue([buildRemoteConversation()]);

    await act(async () => {
      root.render(
        <ControllerSyncHarness
          state={buildState()}
          dispatch={dispatch}
          fetchProjectConversations={fetchProjectConversations}
        />,
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(dispatch).toHaveBeenCalledWith({
      type: "SET_CONTROLLER",
      id: LOCAL_ID,
      controllerId: CONTROLLER_ID,
    });
    expect(dispatch.mock.calls.map(([action]) => action.type)).not.toContain(
      "SET_ROUTING_PREFERENCES",
    );
  });

  it.each([
    { name: "active placeholder", firstMetadata: {}, secondMetadata: {} },
    { name: "single placeholder", firstMetadata: { title: "Chat 1" }, secondMetadata: { title: "Chat 2" } },
    { name: "duplicate remote local IDs", firstMetadata: { localId: LOCAL_ID }, secondMetadata: { localId: LOCAL_ID } },
  ])("hydrates both remote chats immediately with a $name", async ({ firstMetadata, secondMetadata }) => {
    const secondControllerId = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff";
    const initialState = buildState();
    let hydratedState = initialState;
    const dispatch = vi.fn<(action: ConversationsAction) => void>((action) => {
      hydratedState = conversationsReducer(hydratedState, action);
    });
    const updateMetadata = vi.fn().mockResolvedValue(undefined);
    const fetchProjectConversations = vi.fn().mockResolvedValue([
      buildRemoteConversation(firstMetadata),
      {
        ...buildRemoteConversation(secondMetadata),
        id: secondControllerId,
        // Selecting the newest row must not close the placeholder after it
        // has become the first row's real conversation in this same batch.
        createdAt: "2026-07-14T20:00:00.000Z",
      },
    ]);

    await act(async () => {
      root.render(
        <ControllerSyncHarness
          state={initialState}
          dispatch={dispatch}
          fetchProjectConversations={fetchProjectConversations}
          updateMetadata={updateMetadata}
        />,
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(hydratedState.conversations.map((conversation) => conversation.controllerId)).toEqual([
      CONTROLLER_ID,
      secondControllerId,
    ]);
    expect(new Set(hydratedState.conversations.map((conversation) => conversation.localId)).size).toBe(2);
    expect(hydratedState.activeId).toBe(secondControllerId);
    expect(dispatch.mock.calls.filter(([action]) => action.type === "SET_CONTROLLER")).toHaveLength(1);
    expect(dispatch.mock.calls.map(([action]) => action.type)).not.toContain("CLOSE");
    if ("localId" in firstMetadata) {
      expect(updateMetadata).not.toHaveBeenCalled();
    } else {
      expect(updateMetadata).toHaveBeenCalledTimes(1);
      expect(updateMetadata).toHaveBeenCalledWith({
        conversationId: CONTROLLER_ID,
        metadata: expect.objectContaining({ localId: LOCAL_ID }),
      });
    }
  });

  it("preserves local routing when an SSE creation attaches without routing metadata", async () => {
    const dispatch = vi.fn<(action: ConversationsAction) => void>();

    await act(async () => {
      root.render(
        <PendingCreationHarness
          state={buildState()}
          dispatch={dispatch}
          creation={buildConversationCreated()}
        />,
      );
    });

    expect(dispatch).toHaveBeenCalledWith({
      type: "SET_CONTROLLER",
      id: LOCAL_ID,
      controllerId: CONTROLLER_ID,
    });
    expect(dispatch.mock.calls.map(([action]) => action.type)).not.toContain(
      "SET_ROUTING_PREFERENCES",
    );
  });

  it("applies current-user routing metadata when history attaches a remote conversation", async () => {
    const dispatch = vi.fn<(action: ConversationsAction) => void>();
    const routingPreferences = {
      assistantEnabled: true,
      extraAgentHandles: ["planner"],
    };
    const fetchProjectConversations = vi.fn().mockResolvedValue([
      buildRemoteConversation({
        localId: LOCAL_ID,
        ...createConversationRoutingMetadataPatch(USER_ID, routingPreferences),
      }),
    ]);

    await act(async () => {
      root.render(
        <ControllerSyncHarness
          state={buildState()}
          dispatch={dispatch}
          fetchProjectConversations={fetchProjectConversations}
        />,
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(dispatch).toHaveBeenCalledWith({
      type: "SET_ROUTING_PREFERENCES",
      id: LOCAL_ID,
      ...routingPreferences,
    });
  });

  it("confirms a chat rebuilt from one message once the chat list includes it", async () => {
    const dispatch = vi.fn<(action: ConversationsAction) => void>();
    const rebuilt: ConversationsState = {
      ...buildState(),
      conversations: [{
        ...createInitialConversation({ localId: LOCAL_ID, controllerId: CONTROLLER_ID }),
        title: "Conversation 7",
        remoteSummaryPending: true,
      }],
    };
    const fetchProjectConversations = vi.fn().mockResolvedValue([{
      ...buildRemoteConversation({ localId: LOCAL_ID, title: "Quarterly VAT filing" }),
      lastMessageAt: "2026-07-13T20:05:00.000Z",
    }]);

    await act(async () => {
      root.render(
        <ControllerSyncHarness
          state={rebuilt}
          dispatch={dispatch}
          fetchProjectConversations={fetchProjectConversations}
        />,
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const actions = dispatch.mock.calls.map(([action]) => action);
    expect(actions).toContainEqual({ type: "SET_REMOTE_HISTORY", id: LOCAL_ID, hasMessages: true });
    expect(actions).toContainEqual({ type: "SET_TITLE", id: LOCAL_ID, title: "Quarterly VAT filing" });
    expect(actions).toContainEqual({ type: "SET_REMOTE_SUMMARY_PENDING", id: LOCAL_ID, pending: false });
  });

  it("creates a separate tab when history backfills a teammate conversation", async () => {
    const dispatch = vi.fn<(action: ConversationsAction) => void>();
    const teammateId = "77777777-6666-4555-8444-333333333333";
    const fetchProjectConversations = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        buildRemoteConversation({ title: "Conversation 2" }, teammateId),
      ]);

    await act(async () => {
      root.render(
        <ControllerSyncHarness
          state={buildState()}
          dispatch={dispatch}
          fetchProjectConversations={fetchProjectConversations}
          syncEpoch={0}
        />,
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(fetchProjectConversations).toHaveBeenCalledTimes(1);

    await act(async () => {
      root.render(
        <ControllerSyncHarness
          state={buildState()}
          dispatch={dispatch}
          fetchProjectConversations={fetchProjectConversations}
          syncEpoch={1}
        />,
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(fetchProjectConversations).toHaveBeenCalledTimes(2);
    expect(dispatch).toHaveBeenCalledWith({
      type: "CREATE",
      select: false,
      conversation: expect.objectContaining({
        controllerId: CONTROLLER_ID,
        title: "Conversation 2",
      }),
    });
    expect(dispatch.mock.calls.map(([action]) => action.type)).not.toContain("SET_CONTROLLER");
    expect(dispatch.mock.calls.map(([action]) => action.type)).not.toContain("SELECT");
    expect(dispatch.mock.calls.map(([action]) => action.type)).not.toContain("CLOSE");
  });

  it("selects remote history during the first successful non-empty hydration", async () => {
    const dispatch = vi.fn<(action: ConversationsAction) => void>();
    const teammateId = "77777777-6666-4555-8444-333333333333";
    const fetchProjectConversations = vi.fn().mockResolvedValue([
      buildRemoteConversation({ title: "Shared history" }, teammateId),
    ]);

    await act(async () => {
      root.render(
        <ControllerSyncHarness
          state={buildState()}
          dispatch={dispatch}
          fetchProjectConversations={fetchProjectConversations}
        />,
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(dispatch).toHaveBeenCalledWith({
      type: "CREATE",
      select: false,
      conversation: expect.objectContaining({
        localId: CONTROLLER_ID,
        controllerId: CONTROLLER_ID,
        title: "Shared history",
      }),
    });
    expect(dispatch).toHaveBeenCalledWith({ type: "SELECT", id: CONTROLLER_ID });
    expect(dispatch).toHaveBeenCalledWith({ type: "CLOSE", id: LOCAL_ID });
  });

  it("applies current-user routing metadata when an SSE creation attaches", async () => {
    const dispatch = vi.fn<(action: ConversationsAction) => void>();
    const routingPreferences = {
      assistantEnabled: true,
      extraAgentHandles: ["planner"],
    };

    await act(async () => {
      root.render(
        <PendingCreationHarness
          state={buildState()}
          dispatch={dispatch}
          creation={buildConversationCreated({
            localId: LOCAL_ID,
            ...createConversationRoutingMetadataPatch(USER_ID, routingPreferences),
          })}
        />,
      );
    });

    expect(dispatch).toHaveBeenCalledWith({
      type: "SET_ROUTING_PREFERENCES",
      id: LOCAL_ID,
      ...routingPreferences,
    });
  });

  it("uses default routing for a genuinely new remote conversation without routing metadata", async () => {
    const dispatch = vi.fn<(action: ConversationsAction) => void>();
    const state = buildState();
    state.conversations[0] = {
      ...state.conversations[0],
      controllerId: "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff",
    };

    await act(async () => {
      root.render(
        <PendingCreationHarness
          state={state}
          dispatch={dispatch}
          creation={buildConversationCreated({}, "77777777-6666-4555-8444-333333333333")}
        />,
      );
    });

    expect(dispatch).toHaveBeenCalledWith({
      type: "CREATE",
      select: false,
      conversation: expect.objectContaining({
        controllerId: CONTROLLER_ID,
        assistantEnabled: true,
        extraAgentHandles: [],
      }),
    });
  });
});
