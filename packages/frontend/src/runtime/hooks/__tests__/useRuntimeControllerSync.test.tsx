// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunRecord, RuntimeState } from "../../../types";
import type { RuntimeAction } from "../../runtimeStore";
import type {
  FetchControllerRunsResult,
  SubscribeControllerRunsParams,
} from "../../../services/runtimeController/runs";

const controllerMocks = vi.hoisted(() => ({
  fetchRuns: vi.fn(),
  subscribeToRuns: vi.fn(),
  fetchLocalWorkspacePresence: vi.fn(),
  fetchOriginSummary: vi.fn(),
}));

vi.mock("../../../sdk/instafy", () => ({
  controllerClient: {
    runs: {
      fetch: controllerMocks.fetchRuns,
      subscribe: controllerMocks.subscribeToRuns,
    },
    workspace: {
      origin: {
        fetchLocalPresence: controllerMocks.fetchLocalWorkspacePresence,
        fetchSummary: controllerMocks.fetchOriginSummary,
      },
    },
  },
  mapOriginSummaryToLocalWorkspacePresence: vi.fn(() => null),
  mapLocalWorkspacePresenceFromPayload: vi.fn(() => null),
  mapOriginSummaryFromPayload: vi.fn(() => null),
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

function projectDerivedClearActions(): RuntimeAction[] {
  return [
    { type: "setRunsState", runs: {}, latestRunIds: {} },
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
    controllerMocks.fetchLocalWorkspacePresence.mockResolvedValue(null);
    controllerMocks.fetchOriginSummary.mockResolvedValue(null);
    delete (
      window as typeof window & { __INSTAFY_ACTIVE_PROJECT_ID__?: string | null }
    ).__INSTAFY_ACTIVE_PROJECT_ID__;
    delete (
      window as typeof window & { __INSTAFY_PROJECT_INITIALIZED__?: boolean | null }
    ).__INSTAFY_PROJECT_INITIALIZED__;
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
      .IS_REACT_ACT_ENVIRONMENT;
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

  it("orders reconnect snapshots against stream updates received in flight", async () => {
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
      subscription?.onRun(liveCompletion, "UPDATE");
      subscription?.onRun(liveProgress, "UPDATE");
      reconciliation.resolve(
        fetchResult({ runs: [staleSnapshot, authoritativeCompletion] }),
      );
      await reconciliation.promise;
    });

    expect(dependencies.upsertRun).toHaveBeenCalledTimes(3);
    expect(dependencies.upsertRun).toHaveBeenCalledWith(liveCompletion);
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
      expect(controllerMocks.fetchLocalWorkspacePresence).not.toHaveBeenCalled();
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
