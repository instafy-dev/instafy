// @vitest-environment jsdom

import { act, useLayoutEffect, useReducer } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunRecord, RuntimeState } from "../../../types";
import type { ControllerOriginSummary, LocalWorkspacePresence } from "../../../sdk/instafy";
import {
  createInitialRuntimeStoreState,
  runtimeReducer,
  type RuntimeAction,
  type RuntimeStoreState,
} from "../../runtimeStore";
import type {
  ControllerEventPayload,
  FetchControllerRunsResult,
  SubscribeControllerRunsParams,
} from "../../../services/runtimeController/runs";

const controllerMocks = vi.hoisted(() => ({
  fetchRuns: vi.fn(),
  subscribeToRuns: vi.fn(),
  fetchLocalWorkspacePresenceResult: vi.fn(),
  fetchOriginSummaryResult: vi.fn(),
}));

const originMappingMocks = vi.hoisted(() => ({
  mapOriginSummaryFromPayload: vi.fn(),
  mapOriginSummaryToLocalWorkspacePresence: vi.fn(),
}));

vi.mock("../../../sdk/instafy", () => ({
  controllerClient: {
    runs: {
      fetch: controllerMocks.fetchRuns,
      subscribe: controllerMocks.subscribeToRuns,
    },
    workspace: {
      origin: {
        fetchLocalPresenceResult: controllerMocks.fetchLocalWorkspacePresenceResult,
        fetchSummaryResult: controllerMocks.fetchOriginSummaryResult,
      },
    },
  },
  mapOriginSummaryToLocalWorkspacePresence:
    originMappingMocks.mapOriginSummaryToLocalWorkspacePresence,
  mapLocalWorkspacePresenceFromPayload: vi.fn(() => null),
  mapOriginSummaryFromPayload: originMappingMocks.mapOriginSummaryFromPayload,
  mapTunnelGrantFromPayload: vi.fn(() => null),
}));

vi.mock("../../../services/runService", () => ({
  fetchRuns: vi.fn(async () => []),
  runsRealtimeEnabled: false,
  subscribeToRuns: vi.fn(),
}));

vi.mock("../../../services/runtimeController/sendQueue", () => ({
  CONVERSATION_SEND_QUEUE_EVENT: "instafy:conversation-send-queue",
}));

vi.mock("../../utils/runtimeDebug", () => ({
  runtimeDebugLog: vi.fn(),
}));

import { useRuntimeControllerSync } from "../useRuntimeControllerSync";
import { MEMBERS_CHANGED_EVENT } from "../../../projects/projectAccessEvents";
import { CREDITS_UPDATED_EVENT } from "../../../credits/creditsEvents";
import { getStudioWorkspaceOwnerKey } from "../../../screens/studio/useStudioKnownFiles";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function fetchResult(
  overrides: Partial<FetchControllerRunsResult> = {},
): FetchControllerRunsResult {
  return {
    runs: [],
    notFound: false,
    unauthorized: false,
    forbidden: false,
    ...overrides,
  };
}

function runRecord(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id: "run-1",
    projectId: "project-current",
    sessionId: null,
    conversationId: "conversation-1",
    promptId: "prompt-1",
    runType: "prompt",
    status: "in_progress",
    progress: 0.5,
    progressStage: "working",
    previewUrl: null,
    lastMessage: null,
    metadata: null,
    createdAt: "2026-08-10T05:00:00.000Z",
    updatedAt: "2026-08-10T05:01:00.000Z",
    ...overrides,
  };
}

function conversationEvent(
  kind: string,
  conversationId: string,
  metadata: Record<string, unknown> | null = null,
): ControllerEventPayload {
  return {
    kind,
    project_id: "project-current",
    conversation_id: conversationId,
    data: {
      id: `message-${conversationId}`,
      role: "assistant",
      content: "A useful next step",
      metadata,
    },
  };
}

function projectDerivedClearActions(): RuntimeAction[] {
  return [
    { type: "setRunsState", runs: {}, latestRunIds: {} },
    { type: "setInternalConversationIds", conversationIds: [] },
    { type: "setLocalWorkspace", workspace: null },
    {
      type: "applyOriginSummary",
      summary: null,
      derivedPresence: null,
    },
    {
      type: "setRuntimeStatuses",
      statuses: [],
      preferredRuntimeId: null,
    },
    { type: "setSessionRuntime", runtimeId: null },
    { type: "clearConversationMessages", messageIds: [] },
    { type: "clearConversationCreations", conversationIds: [] },
    { type: "clearConversationUpdates", conversationIds: [] },
  ];
}

function createHookDependencies() {
  let runtimeState: RuntimeState = {
    buildLogs: [],
    activeConversationId: null,
    controllerReady: true,
    controllerProjectMissing: true,
    controllerUnavailable: true,
    controllerStreamDisconnected: true,
    controllerStreamDisconnectMessage: "previous stream failure",
  };
  const dispatch = vi.fn<(action: RuntimeAction) => void>();
  const updateRuntime = vi.fn(
    (updater: (current: RuntimeState) => RuntimeState) => {
      runtimeState = updater(runtimeState);
    },
  );

  return {
    dispatch,
    updateRuntime,
    upsertRun: vi.fn(),
    removeRun: vi.fn(),
    markRunLeased: vi.fn(),
    refreshRuntimeStatuses: vi.fn(async () => {}),
    logRunEvent: vi.fn(),
    handleRuntimeTelemetryEvent: vi.fn(),
    markControllerUnavailable: vi.fn(),
    readRuntimeState: () => runtimeState,
  };
}

type HookDependencies = ReturnType<typeof createHookDependencies>;

// Simplified stand-ins for the SDK mappers: an event payload is the summary
// itself (without runtimeId, like the controller's), and the derived
// presence is keyed by the origin id.
function mapOriginSummaryFromTestPayload(
  data: Record<string, unknown> | null,
): ControllerOriginSummary | null {
  const originId = typeof data?.originId === "string" ? data.originId : null;
  if (!originId) {
    return null;
  }
  return {
    originId,
    runtimeId: null,
    endpoint: `https://ctl/origin/${originId}`,
    mode: typeof data?.mode === "string" ? data.mode : "desktop",
    presence: (data?.presence as ControllerOriginSummary["presence"]) ?? null,
  };
}

function mapOriginSummaryToTestPresence(
  summary: ControllerOriginSummary | null,
): LocalWorkspacePresence | null {
  if (!summary) {
    return null;
  }
  return {
    deviceId: summary.originId,
    status: summary.presence?.status === "offline" ? "offline" : "online",
    presenceStatus: summary.presence?.status ?? null,
    lastHeartbeat: summary.presence?.lastHeartbeat ?? undefined,
  };
}

function ownerKey(state: RuntimeStoreState): string {
  return getStudioWorkspaceOwnerKey({
    effectiveRuntimeId: null,
    localWorkspace: state.localWorkspace,
    desktopOrigin: state.desktopOrigin,
  });
}

const gatewayOrigin: ControllerOriginSummary = {
  originId: "gateway",
  runtimeId: null,
  endpoint: "https://ctl/origin/gateway",
  mode: "hosted",
  presence: null,
};

const desktopOrigin: ControllerOriginSummary = {
  originId: "desk-origin",
  runtimeId: "runtime-desk",
  endpoint: "https://ctl/origin/desk-origin",
  mode: "desktop",
  presence: { status: "online", lastHeartbeat: "2026-10-07T10:00:00Z" },
};

/** An answer to GET /projects/:id/origin (`null`: the space has no default origin). */
function found(summary: ControllerOriginSummary | null) {
  return { ok: true as const, summary };
}

function originEvent(kind: string, data: Record<string, unknown>): ControllerEventPayload {
  return { kind, project_id: "project-current", data };
}

async function flushMicrotasks() {
  for (let i = 0; i < 10; i += 1) {
    await Promise.resolve();
  }
}

/** Drives the hook through the real runtime reducer and records each commit. */
function StoreHarness({
  dependencies,
  commits,
}: {
  dependencies: HookDependencies;
  commits: RuntimeStoreState[];
}) {
  const [state, dispatch] = useReducer(
    runtimeReducer,
    undefined,
    createInitialRuntimeStoreState,
  );
  useLayoutEffect(() => {
    commits.push(state);
  });
  useRuntimeControllerSync({
    activeProjectId: "project-current",
    projectInitialized: true,
    runtimeControllerEnabled: true,
    syncEpoch: 0,
    dispatch,
    updateRuntime: dependencies.updateRuntime,
    upsertRun: dependencies.upsertRun,
    removeRun: dependencies.removeRun,
    markRunLeased: dependencies.markRunLeased,
    refreshRuntimeStatuses: dependencies.refreshRuntimeStatuses,
    logRunEvent: dependencies.logRunEvent,
    handleRuntimeTelemetryEvent: dependencies.handleRuntimeTelemetryEvent,
    markControllerUnavailable: dependencies.markControllerUnavailable,
  });
  return null;
}

function Harness({
  projectId,
  dependencies,
}: {
  projectId: string | null;
  dependencies: HookDependencies;
}) {
  useRuntimeControllerSync({
    activeProjectId: projectId,
    projectInitialized: true,
    runtimeControllerEnabled: true,
    syncEpoch: 0,
    dispatch: dependencies.dispatch,
    updateRuntime: dependencies.updateRuntime,
    upsertRun: dependencies.upsertRun,
    removeRun: dependencies.removeRun,
    markRunLeased: dependencies.markRunLeased,
    refreshRuntimeStatuses: dependencies.refreshRuntimeStatuses,
    logRunEvent: dependencies.logRunEvent,
    handleRuntimeTelemetryEvent: dependencies.handleRuntimeTelemetryEvent,
    markControllerUnavailable: dependencies.markControllerUnavailable,
  });
  return null;
}

describe("useRuntimeControllerSync controller access results", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
      true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    Object.values(controllerMocks).forEach((mock) => mock.mockReset());
    controllerMocks.fetchLocalWorkspacePresenceResult.mockResolvedValue({ ok: true, workspace: null });
    controllerMocks.fetchOriginSummaryResult.mockResolvedValue(found(null));
    originMappingMocks.mapOriginSummaryFromPayload
      .mockReset()
      .mockReturnValue(null);
    originMappingMocks.mapOriginSummaryToLocalWorkspacePresence
      .mockReset()
      .mockReturnValue(null);
    delete (
      window as typeof window & { __INSTAFY_ACTIVE_PROJECT_ID__?: string | null }
    ).__INSTAFY_ACTIVE_PROJECT_ID__;
    delete (
      window as typeof window & { __INSTAFY_PROJECT_INITIALIZED__?: boolean | null }
    ).__INSTAFY_PROJECT_INITIALIZED__;
  });

  afterEach(async () => {
    vi.useRealTimers();
    await act(async () => root.unmount());
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
      .IS_REACT_ACT_ENVIRONMENT;
  });

  it.each([
    ["conversation.created", "pushConversationCreation"],
    ["conversation.updated", "pushConversationUpdate"],
    ["conversation.message_created", "pushConversationMessage"],
  ])("keeps internal %s events out of chat hydration without hiding delivered chats", async (kind, actionType) => {
    const dependencies = createHookDependencies();
    controllerMocks.fetchRuns.mockResolvedValue(fetchResult());
    controllerMocks.subscribeToRuns.mockReturnValue(() => {});
    await act(async () => root.render(<Harness projectId="project-current" dependencies={dependencies} />));
    const subscription = controllerMocks.subscribeToRuns.mock.calls[0][0] as SubscribeControllerRunsParams;
    dependencies.dispatch.mockClear();

    // A message can be the first event observed after reconnect: hiding only
    // the anchor's creation would still let it claim an empty composer.
    await act(async () => subscription.onEvent?.(conversationEvent(kind, "internal-review", {
      internalPurpose: "space_review",
    })));
    expect(dependencies.dispatch).toHaveBeenCalledExactlyOnceWith({
      type: "setInternalConversationIds", conversationIds: ["internal-review"],
    });
    dependencies.dispatch.mockClear();

    await act(async () => subscription.onEvent?.(conversationEvent(kind, "delivered-chat", {
      recommendationId: "12345678-1234-4234-8234-123456789012",
    })));
    expect(dependencies.dispatch).toHaveBeenCalledOnce();
    expect(dependencies.dispatch.mock.calls[0][0].type).toBe(actionType);
  });

  it.each(["snapshot", "live", "patch"])("uses internal %s run markers to keep later messages out of automatic chat hydration", async (source) => {
    const dependencies = createHookDependencies();
    const internalRun = runRecord({
      conversationId: "internal-review",
      metadata: { spaceReview: { automationId: "automation-1", enforcedBy: "runtime-controller" } },
    });
    controllerMocks.fetchRuns.mockResolvedValue(fetchResult({ runs: source === "snapshot" ? [internalRun] : [] }));
    controllerMocks.subscribeToRuns.mockReturnValue(() => {});
    await act(async () => root.render(<Harness projectId="project-current" dependencies={dependencies} />));
    const subscription = controllerMocks.subscribeToRuns.mock.calls[0][0] as SubscribeControllerRunsParams;
    await act(async () => {
      if (source === "live") subscription.onRun(internalRun, "INSERT");
      if (source === "patch") subscription.onRunPatch(internalRun);
    });
    // Audit status still receives its authorized run; only automatic chat
    // creation/message queues are suppressed.
    if (source === "patch") {
      expect(dependencies.dispatch).toHaveBeenCalledWith({ type: "patchRun", patch: internalRun });
    } else {
      expect(dependencies.upsertRun).toHaveBeenCalledWith(internalRun);
    }
    dependencies.dispatch.mockClear();
    await act(async () => subscription.onEvent?.(conversationEvent("conversation.message_created", "internal-review")));
    expect(dependencies.dispatch).not.toHaveBeenCalled();
  });

  it("remembers internal anchors across live events without carrying them into another project", async () => {
    const dependencies = createHookDependencies();
    controllerMocks.fetchRuns.mockResolvedValue(fetchResult());
    controllerMocks.subscribeToRuns.mockReturnValue(() => {});
    await act(async () => root.render(<Harness projectId="project-current" dependencies={dependencies} />));
    const subscription = controllerMocks.subscribeToRuns.mock.calls[0][0] as SubscribeControllerRunsParams;
    dependencies.dispatch.mockClear();
    await act(async () => {
      subscription.onEvent?.(conversationEvent("conversation.created", "internal-review", { internalPurpose: "space_review" }));
      subscription.onEvent?.(conversationEvent("conversation.message_created", "internal-review"));
      subscription.onEvent?.(conversationEvent("conversation.updated", "internal-review"));
    });
    expect(dependencies.dispatch).toHaveBeenCalledExactlyOnceWith({
      type: "setInternalConversationIds", conversationIds: ["internal-review"],
    });

    await act(async () => root.render(<Harness projectId="another-project" dependencies={dependencies} />));
    const nextSubscription = controllerMocks.subscribeToRuns.mock.calls[1][0] as SubscribeControllerRunsParams;
    dependencies.dispatch.mockClear();
    await act(async () => nextSubscription.onEvent?.({
      ...conversationEvent("conversation.message_created", "internal-review"),
      project_id: "another-project",
    }));
    expect(dependencies.dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "pushConversationMessage" }));
  });

  it("records which project a hydrated origin summary belongs to", async () => {
    const dependencies = createHookDependencies();
    const summary = { originId: "desk-origin", mode: "desktop", endpoint: "http://desk" };
    controllerMocks.fetchRuns.mockResolvedValue(fetchResult());
    controllerMocks.subscribeToRuns.mockReturnValue(() => {});
    controllerMocks.fetchOriginSummaryResult.mockResolvedValue(found(summary));
    await act(async () => root.render(<Harness projectId="project-current" dependencies={dependencies} />));
    await act(async () => {
      for (let i = 0; i < 6; i += 1) {
        await Promise.resolve();
      }
    });
    expect(dependencies.dispatch).toHaveBeenCalledWith({
      type: "applyOriginHydration",
      workspace: null,
      summary,
      derivedPresence: null,
      projectId: "project-current",
    });
  });

  async function renderStore() {
    const dependencies = createHookDependencies();
    const commits: RuntimeStoreState[] = [];
    let subscription: SubscribeControllerRunsParams | null = null;
    originMappingMocks.mapOriginSummaryFromPayload.mockImplementation(
      mapOriginSummaryFromTestPayload,
    );
    originMappingMocks.mapOriginSummaryToLocalWorkspacePresence.mockImplementation(
      mapOriginSummaryToTestPresence,
    );
    controllerMocks.fetchRuns.mockResolvedValue(fetchResult());
    controllerMocks.subscribeToRuns.mockImplementation(
      (params: SubscribeControllerRunsParams) => {
        subscription = params;
        return vi.fn();
      },
    );
    await act(async () => {
      root.render(<StoreHarness dependencies={dependencies} commits={commits} />);
      await flushMicrotasks();
    });
    expect(dependencies.refreshRuntimeStatuses).toHaveBeenCalledOnce();
    const emit = (event: ControllerEventPayload) =>
      act(async () => {
        subscription?.onEvent?.(event);
        await flushMicrotasks();
      });
    return { commits, emit, latest: () => commits[commits.length - 1] };
  }

  it("keeps the default origin when another origin of the project heartbeats", async () => {
    controllerMocks.fetchOriginSummaryResult
      .mockResolvedValueOnce(found(gatewayOrigin))
      .mockReturnValueOnce(new Promise(() => {}));
    const { emit, latest } = await renderStore();
    const before = latest();
    expect(before.desktopOrigin).toEqual(gatewayOrigin);

    // A hosted runtime's own origin heartbeats every 20 s; the controller
    // still resolves the gateway as the default.
    await emit(originEvent("origin.heartbeat", {
      originId: "runtime-origin",
      mode: "hosted",
      presence: { status: "online" },
    }));

    expect(latest().desktopOrigin).toBe(before.desktopOrigin);
    expect(ownerKey(latest())).toBe(ownerKey(before));
    expect(controllerMocks.fetchOriginSummaryResult).toHaveBeenCalledTimes(2);
  });

  it("takes presence from the default origin's heartbeat and keeps its runtime and endpoint", async () => {
    controllerMocks.fetchOriginSummaryResult
      .mockResolvedValueOnce(found(desktopOrigin))
      .mockReturnValueOnce(new Promise(() => {}));
    const { emit, latest } = await renderStore();
    const before = latest();

    await emit(originEvent("origin.heartbeat", {
      originId: "desk-origin",
      mode: "desktop",
      presence: { status: "online", lastHeartbeat: "2026-10-07T10:00:20Z" },
    }));

    expect(latest().desktopOrigin).toEqual({
      ...desktopOrigin,
      presence: { status: "online", lastHeartbeat: "2026-10-07T10:00:20Z" },
    });
    expect(latest().localWorkspace?.lastHeartbeat).toBe("2026-10-07T10:00:20Z");
    expect(ownerKey(latest())).toBe(ownerKey(before));
  });

  it("lands origin hydration in one owner key while another origin heartbeats", async () => {
    const secondHydration = deferred<ReturnType<typeof found>>();
    controllerMocks.fetchOriginSummaryResult
      .mockResolvedValueOnce(found(gatewayOrigin))
      .mockReturnValueOnce(secondHydration.promise);
    const { commits, emit, latest } = await renderStore();
    const firstHydrated = commits.length - 1;
    expect(latest().desktopOrigin).toEqual(gatewayOrigin);

    await emit(originEvent("origin.heartbeat", {
      originId: "runtime-origin",
      mode: "hosted",
      presence: { status: "online" },
    }));
    await act(async () => {
      secondHydration.resolve(found({ ...gatewayOrigin }));
      await flushMicrotasks();
    });

    expect(controllerMocks.fetchOriginSummaryResult).toHaveBeenCalledTimes(2);
    expect(latest().desktopOrigin).toEqual(gatewayOrigin);
    expect(new Set(commits.slice(firstHydrated).map(ownerKey)).size).toBe(1);
  });

  it.each(["origin", "local workspace"])(
    "keeps the default origin and the owner key when a hydration's %s fetch gets no answer",
    async (failing) => {
      // The SDK answers a 502, a timeout or a missing session with ok: false;
      // only a 404 means the space has none.
      const folder: LocalWorkspacePresence = {
        deviceId: "device-1",
        path: "/Users/me/space",
        runtimeId: "runtime-desk",
        status: "online",
      };
      controllerMocks.fetchLocalWorkspacePresenceResult
        .mockResolvedValueOnce({ ok: true, workspace: folder })
        .mockResolvedValueOnce(failing === "local workspace" ? { ok: false } : { ok: true, workspace: folder });
      controllerMocks.fetchOriginSummaryResult
        .mockResolvedValueOnce(found(desktopOrigin))
        .mockResolvedValueOnce(failing === "origin" ? { ok: false } : found(desktopOrigin));
      const { emit, latest } = await renderStore();
      const before = latest();
      expect(before.desktopOrigin).toEqual(desktopOrigin);
      expect(before.localWorkspace?.path).toBe("/Users/me/space");

      await emit(originEvent("origin.heartbeat", { originId: "runtime-origin", mode: "hosted" }));

      expect(controllerMocks.fetchOriginSummaryResult).toHaveBeenCalledTimes(2);
      expect(latest()).toBe(before);
      expect(ownerKey(latest())).toBe(ownerKey(before));
    },
  );

  it("marks an expired Desktop default origin offline without resolving a new default", async () => {
    controllerMocks.fetchOriginSummaryResult.mockResolvedValue(found(desktopOrigin));
    const { emit, latest } = await renderStore();
    const before = latest();

    await emit(originEvent("origin.expired", {
      originId: "desk-origin",
      mode: "desktop",
      presence: { status: "offline", lastHeartbeat: "2026-10-07T10:00:00Z" },
    }));

    expect(latest().desktopOrigin).toMatchObject({
      originId: "desk-origin",
      runtimeId: "runtime-desk",
      presence: { status: "offline" },
    });
    expect(latest().localWorkspace?.status).toBe("offline");
    expect(ownerKey(latest())).toBe(ownerKey(before));
    expect(controllerMocks.fetchOriginSummaryResult).toHaveBeenCalledOnce();
  });

  it("ignores an origin.expired payload it cannot read", async () => {
    controllerMocks.fetchOriginSummaryResult.mockResolvedValue(found(desktopOrigin));
    const { emit, latest } = await renderStore();
    const before = latest();

    await emit(originEvent("origin.expired", { status: "offline" }));

    expect(latest()).toBe(before);
  });

  it("hydrates once at the end of the throttle window when an origin registers inside it", async () => {
    controllerMocks.fetchOriginSummaryResult
      .mockResolvedValueOnce(found(gatewayOrigin))
      .mockResolvedValueOnce(found(gatewayOrigin))
      .mockResolvedValueOnce(found(desktopOrigin));
    const { emit, latest } = await renderStore();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });

    await emit(originEvent("origin.heartbeat", { originId: "runtime-origin", mode: "hosted" }));
    expect(controllerMocks.fetchOriginSummaryResult).toHaveBeenCalledTimes(2);

    // The Desktop app comes online right after that hydration.
    await emit(originEvent("origin.registered", { originId: "desk-origin", mode: "desktop" }));
    await emit(originEvent("origin.heartbeat", { originId: "desk-origin", mode: "desktop" }));
    expect(controllerMocks.fetchOriginSummaryResult).toHaveBeenCalledTimes(2);

    await act(async () => {
      vi.advanceTimersByTime(2_000);
      await flushMicrotasks();
    });
    expect(controllerMocks.fetchOriginSummaryResult).toHaveBeenCalledTimes(3);
    expect(latest().desktopOrigin).toEqual(desktopOrigin);

    await act(async () => {
      vi.advanceTimersByTime(10_000);
      await flushMicrotasks();
    });
    expect(controllerMocks.fetchOriginSummaryResult).toHaveBeenCalledTimes(3);
  });

  it("clears every project-derived runtime slice when there is no active project", async () => {
    const dependencies = createHookDependencies();

    await act(async () => {
      root.render(<Harness projectId={null} dependencies={dependencies} />);
    });

    expect(dependencies.dispatch.mock.calls.map(([action]) => action)).toEqual(
      projectDerivedClearActions(),
    );
    expect(dependencies.readRuntimeState()).toMatchObject({
      controllerReady: false,
      controllerProjectMissing: false,
      controllerUnavailable: false,
      controllerStreamDisconnected: false,
      controllerStreamDisconnectMessage: null,
    });
    expect(controllerMocks.fetchRuns).not.toHaveBeenCalled();
    expect(controllerMocks.subscribeToRuns).not.toHaveBeenCalled();
  });

  it("clears every project-derived runtime slice before a switched project's fetch resolves", async () => {
    const oldRequest = deferred<FetchControllerRunsResult>();
    const currentRequest = deferred<FetchControllerRunsResult>();
    const dependencies = createHookDependencies();
    controllerMocks.fetchRuns.mockImplementation(
      ({ projectId }: { projectId?: string }) =>
        projectId === "project-old" ? oldRequest.promise : currentRequest.promise,
    );

    await act(async () => {
      root.render(
        <Harness projectId="project-old" dependencies={dependencies} />,
      );
    });
    dependencies.dispatch.mockClear();

    await act(async () => {
      root.render(
        <Harness projectId="project-current" dependencies={dependencies} />,
      );
    });

    expect(dependencies.dispatch.mock.calls.map(([action]) => action)).toEqual(
      projectDerivedClearActions(),
    );
    expect(controllerMocks.fetchRuns).toHaveBeenLastCalledWith({
      projectId: "project-current",
    });
    expect(dependencies.readRuntimeState()).toMatchObject({
      controllerReady: false,
      controllerProjectMissing: false,
      controllerUnavailable: false,
      controllerStreamDisconnected: false,
      controllerStreamDisconnectMessage: null,
    });
    expect(controllerMocks.subscribeToRuns).not.toHaveBeenCalled();
  });

  it("scrubs hydrated project state when an open stream reports terminal access denial", async () => {
    const dependencies = createHookDependencies();
    const unsubscribe = vi.fn();
    let subscription: SubscribeControllerRunsParams | null = null;
    controllerMocks.fetchRuns.mockResolvedValue(fetchResult());
    controllerMocks.subscribeToRuns.mockImplementation(
      (params: SubscribeControllerRunsParams) => {
        subscription = params;
        return unsubscribe;
      },
    );

    await act(async () => {
      root.render(
        <Harness projectId="project-current" dependencies={dependencies} />,
      );
    });
    await vi.waitFor(() => {
      expect(dependencies.refreshRuntimeStatuses).toHaveBeenCalledOnce();
      expect(subscription).not.toBeNull();
    });
    await act(async () => {
      subscription?.onOpen?.();
    });
    expect(dependencies.readRuntimeState().controllerReady).toBe(true);
    const dispatchCount = dependencies.dispatch.mock.calls.length;

    await act(async () => {
      subscription?.onAccessDenied?.({
        status: 403,
        message: "project membership was revoked",
      });
    });

    expect(
      dependencies.dispatch.mock.calls
        .slice(dispatchCount)
        .map(([action]) => action),
    ).toEqual(projectDerivedClearActions());
    expect(dependencies.readRuntimeState()).toMatchObject({
      controllerReady: false,
      controllerProjectMissing: false,
      controllerUnavailable: false,
      controllerStreamDisconnected: false,
      controllerStreamDisconnectMessage: null,
    });
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(dependencies.markControllerUnavailable).not.toHaveBeenCalled();
  });

  it("forwards roster and credit signals as window events", async () => {
    const dependencies = createHookDependencies();
    let subscription: SubscribeControllerRunsParams | null = null;
    controllerMocks.fetchRuns.mockResolvedValue(fetchResult());
    controllerMocks.subscribeToRuns.mockImplementation(
      (params: SubscribeControllerRunsParams) => {
        subscription = params;
        return vi.fn();
      },
    );
    const membersChanged = vi.fn<(event: Event) => void>();
    const creditsUpdated = vi.fn<(event: Event) => void>();
    window.addEventListener(MEMBERS_CHANGED_EVENT, membersChanged);
    window.addEventListener(CREDITS_UPDATED_EVENT, creditsUpdated);

    try {
      await act(async () => {
        root.render(
          <Harness projectId="project-current" dependencies={dependencies} />,
        );
      });
      await vi.waitFor(() => expect(subscription).not.toBeNull());

      await act(async () => {
        subscription?.onEvent?.({
          kind: "telemetry.warning",
          project_id: "project-current",
          data: { message: "unrelated" },
        });
      });
      expect(membersChanged).not.toHaveBeenCalled();
      expect(creditsUpdated).not.toHaveBeenCalled();

      await act(async () => {
        subscription?.onEvent?.({
          kind: "project.members_changed",
          project_id: "project-current",
          data: { reason: "org_membership" },
        });
        subscription?.onEvent?.({
          kind: "credits.updated",
          project_id: "project-current",
          data: { reason: "ledger" },
        });
      });

      expect(membersChanged).toHaveBeenCalledOnce();
      expect((membersChanged.mock.calls[0][0] as CustomEvent).detail).toEqual({
        projectId: "project-current",
      });
      expect(creditsUpdated).toHaveBeenCalledOnce();
      expect((creditsUpdated.mock.calls[0][0] as CustomEvent).detail).toEqual({
        projectId: "project-current",
      });
    } finally {
      window.removeEventListener(MEMBERS_CHANGED_EVENT, membersChanged);
      window.removeEventListener(CREDITS_UPDATED_EVENT, creditsUpdated);
    }
  });

  it("reconciles runs after a disconnected stream reopens", async () => {
    const dependencies = createHookDependencies();
    const running = runRecord();
    const completed = runRecord({
      status: "success",
      progress: 1,
      progressStage: "completed",
      updatedAt: "2026-08-10T05:02:00.000Z",
    });
    let subscription: SubscribeControllerRunsParams | null = null;
    controllerMocks.fetchRuns
      .mockResolvedValueOnce(fetchResult({ runs: [running] }))
      .mockResolvedValueOnce(fetchResult({ runs: [completed] }));
    controllerMocks.subscribeToRuns.mockImplementation(
      (params: SubscribeControllerRunsParams) => {
        subscription = params;
        return vi.fn();
      },
    );

    await act(async () => {
      root.render(
        <Harness projectId="project-current" dependencies={dependencies} />,
      );
    });
    await vi.waitFor(() => {
      expect(subscription).not.toBeNull();
      expect(dependencies.upsertRun).toHaveBeenCalledWith(running);
    });
    dependencies.upsertRun.mockClear();

    await act(async () => {
      subscription?.onOpen?.();
      subscription?.onError?.("event stream error");
      subscription?.onOpen?.();
    });

    await vi.waitFor(() => {
      expect(controllerMocks.fetchRuns).toHaveBeenCalledTimes(2);
      expect(dependencies.upsertRun).toHaveBeenCalledWith(completed);
    });
    expect(controllerMocks.fetchRuns).toHaveBeenLastCalledWith({
      projectId: "project-current",
    });
  });

  it.each(["snapshot", "patch"])("orders reconnect snapshots against a %s received in flight", async (eventShape) => {
    const reconciliation = deferred<FetchControllerRunsResult>();
    const dependencies = createHookDependencies();
    const staleSnapshot = runRecord();
    const liveCompletion = runRecord({
      status: "success",
      progress: 1,
      progressStage: "completed",
      updatedAt: "2026-08-10T05:02:00.000Z",
    });
    const liveProgress = runRecord({
      id: "run-2",
      updatedAt: "2026-08-10T05:02:00.000Z",
    });
    const authoritativeCompletion = runRecord({
      id: "run-2",
      status: "success",
      progress: 1,
      progressStage: "completed",
      updatedAt: "2026-08-10T05:03:00.000Z",
    });
    let subscription: SubscribeControllerRunsParams | null = null;
    controllerMocks.fetchRuns
      .mockResolvedValueOnce(fetchResult({ runs: [staleSnapshot] }))
      .mockReturnValueOnce(reconciliation.promise);
    controllerMocks.subscribeToRuns.mockImplementation(
      (params: SubscribeControllerRunsParams) => {
        subscription = params;
        return vi.fn();
      },
    );

    await act(async () => {
      root.render(
        <Harness projectId="project-current" dependencies={dependencies} />,
      );
    });
    await vi.waitFor(() => expect(subscription).not.toBeNull());
    dependencies.upsertRun.mockClear();

    await act(async () => {
      subscription?.onOpen?.();
      subscription?.onError?.("event stream error");
      subscription?.onOpen?.();
    });
    await vi.waitFor(() =>
      expect(controllerMocks.fetchRuns).toHaveBeenCalledTimes(2),
    );

    await act(async () => {
      if (eventShape === "patch") {
        subscription?.onRunPatch({
          id: liveCompletion.id,
          status: liveCompletion.status,
          progress: liveCompletion.progress,
          updatedAt: liveCompletion.updatedAt,
        });
      } else {
        subscription?.onRun(liveCompletion, "UPDATE");
      }
      subscription?.onRun(liveProgress, "UPDATE");
      reconciliation.resolve(
        fetchResult({ runs: [staleSnapshot, authoritativeCompletion] }),
      );
      await reconciliation.promise;
    });

    expect(dependencies.upsertRun).toHaveBeenCalledTimes(eventShape === "patch" ? 2 : 3);
    if (eventShape === "patch") {
      expect(dependencies.dispatch).toHaveBeenCalledWith({
        type: "patchRun",
        patch: {
          id: liveCompletion.id,
          status: liveCompletion.status,
          progress: liveCompletion.progress,
          updatedAt: liveCompletion.updatedAt,
        },
      });
    } else {
      expect(dependencies.upsertRun).toHaveBeenCalledWith(liveCompletion);
    }
    expect(dependencies.upsertRun).toHaveBeenCalledWith(liveProgress);
    expect(dependencies.upsertRun).toHaveBeenCalledWith(authoritativeCompletion);
    expect(dependencies.upsertRun).not.toHaveBeenCalledWith(staleSnapshot);
  });

  it.each([
    ["401", fetchResult({ unauthorized: true }), false],
    ["403", fetchResult({ forbidden: true }), false],
    ["404", fetchResult({ notFound: true }), true],
  ])(
    "clears project-derived state when reconnect reconciliation receives %s",
    async (_status, terminalResult, projectMissing) => {
      const dependencies = createHookDependencies();
      const unsubscribe = vi.fn();
      let subscription: SubscribeControllerRunsParams | null = null;
      controllerMocks.fetchRuns
        .mockResolvedValueOnce(fetchResult())
        .mockResolvedValueOnce(terminalResult);
      controllerMocks.subscribeToRuns.mockImplementation(
        (params: SubscribeControllerRunsParams) => {
          subscription = params;
          return unsubscribe;
        },
      );

      await act(async () => {
        root.render(
          <Harness projectId="project-current" dependencies={dependencies} />,
        );
      });
      await vi.waitFor(() => expect(subscription).not.toBeNull());
      const dispatchCount = dependencies.dispatch.mock.calls.length;

      await act(async () => {
        subscription?.onOpen?.();
        subscription?.onError?.("event stream error");
        subscription?.onOpen?.();
      });
      await vi.waitFor(() => expect(unsubscribe).toHaveBeenCalledOnce());

      expect(
        dependencies.dispatch.mock.calls
          .slice(dispatchCount)
          .map(([action]) => action),
      ).toEqual(projectDerivedClearActions());
      expect(dependencies.readRuntimeState()).toMatchObject({
        controllerReady: false,
        controllerProjectMissing: projectMissing,
        controllerUnavailable: false,
        controllerStreamDisconnected: false,
        controllerStreamDisconnectMessage: null,
      });
      expect(dependencies.markControllerUnavailable).not.toHaveBeenCalled();
    },
  );

  it("ignores a late reconnect reconciliation from the prior project", async () => {
    const oldReconciliation = deferred<FetchControllerRunsResult>();
    const dependencies = createHookDependencies();
    const oldUnsubscribe = vi.fn();
    const currentUnsubscribe = vi.fn();
    let oldFetches = 0;
    let oldSubscription: SubscribeControllerRunsParams | null = null;
    controllerMocks.fetchRuns.mockImplementation(
      ({ projectId }: { projectId?: string }) => {
        if (projectId === "project-old") {
          oldFetches += 1;
          return oldFetches === 1
            ? Promise.resolve(fetchResult())
            : oldReconciliation.promise;
        }
        return Promise.resolve(fetchResult());
      },
    );
    controllerMocks.subscribeToRuns.mockImplementation(
      (params: SubscribeControllerRunsParams) => {
        if (params.projectId === "project-old") {
          oldSubscription = params;
          return oldUnsubscribe;
        }
        return currentUnsubscribe;
      },
    );

    await act(async () => {
      root.render(
        <Harness projectId="project-old" dependencies={dependencies} />,
      );
    });
    await vi.waitFor(() => expect(oldSubscription).not.toBeNull());
    await act(async () => {
      oldSubscription?.onOpen?.();
      oldSubscription?.onError?.("event stream error");
      oldSubscription?.onOpen?.();
    });
    await vi.waitFor(() => expect(oldFetches).toBe(2));

    await act(async () => {
      root.render(
        <Harness projectId="project-current" dependencies={dependencies} />,
      );
    });
    await vi.waitFor(() => {
      expect(controllerMocks.subscribeToRuns).toHaveBeenCalledTimes(2);
      expect(dependencies.refreshRuntimeStatuses).toHaveBeenCalledTimes(2);
    });
    const dispatchCount = dependencies.dispatch.mock.calls.length;
    const updateCount = dependencies.updateRuntime.mock.calls.length;
    const upsertCount = dependencies.upsertRun.mock.calls.length;

    await act(async () => {
      oldReconciliation.resolve(fetchResult({ forbidden: true }));
      await oldReconciliation.promise;
    });

    expect(dependencies.dispatch).toHaveBeenCalledTimes(dispatchCount);
    expect(dependencies.updateRuntime).toHaveBeenCalledTimes(updateCount);
    expect(dependencies.upsertRun).toHaveBeenCalledTimes(upsertCount);
    expect(oldUnsubscribe).toHaveBeenCalledOnce();
    expect(currentUnsubscribe).not.toHaveBeenCalled();
  });

  it.each([
    ["401", fetchResult({ unauthorized: true })],
    ["403", fetchResult({ forbidden: true })],
  ])(
    "clears project-derived runtime state for a current %s response without marking the project missing",
    async (_status, deniedResult) => {
      const request = deferred<FetchControllerRunsResult>();
      const dependencies = createHookDependencies();
      controllerMocks.fetchRuns.mockReturnValue(request.promise);

      await act(async () => {
        root.render(
          <Harness projectId="project-current" dependencies={dependencies} />,
        );
      });
      const initialDispatchCount = dependencies.dispatch.mock.calls.length;

      await act(async () => {
        request.resolve(deniedResult);
        await request.promise;
      });

      expect(
        dependencies.dispatch.mock.calls
          .slice(initialDispatchCount)
          .map(([action]) => action),
      ).toEqual(projectDerivedClearActions());
      expect(dependencies.readRuntimeState()).toMatchObject({
        controllerReady: false,
        controllerProjectMissing: false,
        controllerUnavailable: false,
        controllerStreamDisconnected: false,
        controllerStreamDisconnectMessage: null,
      });
      expect(controllerMocks.subscribeToRuns).not.toHaveBeenCalled();
      expect(controllerMocks.fetchLocalWorkspacePresenceResult).not.toHaveBeenCalled();
      expect(dependencies.refreshRuntimeStatuses).not.toHaveBeenCalled();
      expect(dependencies.markControllerUnavailable).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["401", fetchResult({ unauthorized: true })],
    ["403", fetchResult({ forbidden: true })],
    ["404", fetchResult({ notFound: true })],
  ])(
    "ignores a late %s response from the prior project without disturbing the current subscription",
    async (_status, staleResult) => {
      const oldRequest = deferred<FetchControllerRunsResult>();
      const currentRequest = deferred<FetchControllerRunsResult>();
      const currentUnsubscribe = vi.fn();
      const dependencies = createHookDependencies();
      controllerMocks.fetchRuns.mockImplementation(
        ({ projectId }: { projectId?: string }) =>
          projectId === "project-old" ? oldRequest.promise : currentRequest.promise,
      );
      controllerMocks.subscribeToRuns.mockReturnValue(currentUnsubscribe);

      await act(async () => {
        root.render(
          <Harness projectId="project-old" dependencies={dependencies} />,
        );
      });
      await act(async () => {
        root.render(
          <Harness projectId="project-current" dependencies={dependencies} />,
        );
      });
      await act(async () => {
        currentRequest.resolve(fetchResult());
        await currentRequest.promise;
      });
      await vi.waitFor(() => {
        expect(controllerMocks.subscribeToRuns).toHaveBeenCalledTimes(1);
        expect(dependencies.refreshRuntimeStatuses).toHaveBeenCalledTimes(1);
      });

      const dispatchCount = dependencies.dispatch.mock.calls.length;
      const updateCount = dependencies.updateRuntime.mock.calls.length;

      await act(async () => {
        oldRequest.resolve(staleResult);
        await oldRequest.promise;
      });

      expect(dependencies.dispatch).toHaveBeenCalledTimes(dispatchCount);
      expect(dependencies.updateRuntime).toHaveBeenCalledTimes(updateCount);
      expect(currentUnsubscribe).not.toHaveBeenCalled();
      expect(dependencies.markControllerUnavailable).not.toHaveBeenCalled();
    },
  );
});
