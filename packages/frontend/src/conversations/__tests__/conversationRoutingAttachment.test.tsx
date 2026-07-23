/** @vitest-environment jsdom */

import { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ControllerConversationCreated,
  ControllerProjectConversation,
} from "../../services/runtimeController/conversations";
import {
  createInitialConversation,
  type ConversationsAction,
  type ConversationsState,
} from "../conversationState";
import { createConversationRoutingMetadataPatch } from "../conversationRoutingMetadata";

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
}: {
  state: ConversationsState;
  dispatch: (action: ConversationsAction) => void;
  fetchProjectConversations: () => Promise<ControllerProjectConversation[] | null>;
  currentUserId?: string | null;
  syncEpoch?: number;
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
    updateControllerConversationMetadata: vi.fn(),
  });
  return null;
}

function PendingCreationHarness({
  state,
  dispatch,
  creation,
}: {
  state: ConversationsState;
  dispatch: (action: ConversationsAction) => void;
  creation: ControllerConversationCreated;
}) {
  const lastBackgroundAtRef = useRef(0);
  const notifiedMessageIdsRef = useRef(new Set<string>());
  usePendingConversationEffects({
    state,
    projectKey: PROJECT_ID,
    currentUserId: USER_ID,
    pendingConversationCreations: [creation],
    ackConversationCreations: vi.fn(),
    pendingConversationUpdates: [],
    ackConversationUpdates: vi.fn(),
    pendingConversationMessages: [],
    ackConversationMessages: vi.fn(),
    lastBackgroundAtRef,
    notifiedMessageIdsRef,
    dispatch,
    updateControllerConversationMetadata: vi.fn(),
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
