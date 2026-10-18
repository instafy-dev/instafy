// @vitest-environment jsdom

import { act, useCallback, useLayoutEffect, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeState } from "../../../types";
import type {
  FetchControllerRunsResult,
  SubscribeControllerRunsParams,
} from "../../../services/runtimeController/runs";

const mocks = vi.hoisted(() => ({
  fetchRuns: vi.fn(),
  subscribeToRuns: vi.fn(),
  fetchStatus: vi.fn(),
}));

vi.mock("../../../sdk/instafy", () => ({
  controllerClient: {
    core: { enabled: true },
    runs: { fetch: mocks.fetchRuns, subscribe: mocks.subscribeToRuns },
    runtimes: { fetchStatus: mocks.fetchStatus, setPreference: vi.fn() },
    workspace: {
      origin: {
        fetchLocalPresenceResult: vi.fn(async () => ({ ok: true, workspace: null })),
        fetchSummaryResult: vi.fn(async () => ({ ok: true, summary: null })),
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

vi.mock("../../utils/runtimeDebug", () => ({ runtimeDebugLog: vi.fn() }));

vi.mock("../../../workspace/projectClear", () => ({ clearProjectState: vi.fn() }));

import { RuntimeStateProvider, useRuntimeStateInternal } from "../../RuntimeStateProvider";
import { useRuntimeControllerSync } from "../useRuntimeControllerSync";
import { useRuntimeStatusRefresh } from "../useRuntimeStatusRefresh";

const PROJECT_ID = "project-current";

let latestRuntime: RuntimeState | null = null;

/**
 * The runtime provider's controller path as Studio wires it: the real store
 * (whose `updateRuntime` applies an updater during the next render, not at
 * once), the real `markControllerUnavailable` and status refresh, and the
 * sync hook on a mocked event stream.
 */
function ProviderSync() {
  const { state, dispatch, actions } = useRuntimeStateInternal();
  const [syncEpoch, setSyncEpoch] = useState(0);
  const lastPreferredRuntimeIdRef = useRef<string | null>(null);
  const preferenceClearRequestedRef = useRef(false);
  const noop = useCallback(() => {}, []);
  const bumpControllerSyncEpoch = useCallback(() => {
    setSyncEpoch((epoch) => epoch + 1);
  }, []);
  const { markControllerUnavailable, refreshRuntimeStatuses } = useRuntimeStatusRefresh({
    activeProjectId: PROJECT_ID,
    projectReadyForRuntime: true,
    dispatch,
    updateRuntime: actions.updateRuntime,
    debugLog: noop,
    bumpControllerSyncEpoch,
    lastPreferredRuntimeIdRef,
    preferenceClearRequestedRef,
    allowPreferenceMutation: false,
  });
  useRuntimeControllerSync({
    activeProjectId: PROJECT_ID,
    projectInitialized: true,
    runtimeControllerEnabled: true,
    syncEpoch,
    dispatch,
    updateRuntime: actions.updateRuntime,
    upsertRun: actions.upsertRun,
    removeRun: actions.removeRun,
    markRunLeased: actions.markRunLeased,
    refreshRuntimeStatuses,
    logRunEvent: noop,
    handleRuntimeTelemetryEvent: noop,
    markControllerUnavailable,
  });
  useLayoutEffect(() => {
    latestRuntime = state.runtime;
  });
  return null;
}

function fetchResult(): FetchControllerRunsResult {
  return { runs: [], notFound: false, unauthorized: false, forbidden: false };
}

async function flushMicrotasks() {
  for (let i = 0; i < 10; i += 1) {
    await Promise.resolve();
  }
}

describe("useRuntimeControllerSync first event stream", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    latestRuntime = null;
    Object.values(mocks).forEach((mock) => mock.mockReset());
    mocks.fetchRuns.mockResolvedValue(fetchResult());
    mocks.subscribeToRuns.mockReturnValue(() => {});
    mocks.fetchStatus.mockResolvedValue({ runtimes: [], preferredRuntimeId: null });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  async function renderHydrated(): Promise<SubscribeControllerRunsParams> {
    await act(async () => {
      root.render(
        <RuntimeStateProvider>
          <ProviderSync />
        </RuntimeStateProvider>,
      );
      await flushMicrotasks();
    });
    await vi.waitFor(() => {
      expect(mocks.fetchStatus).toHaveBeenCalledOnce();
      expect(latestRuntime).toMatchObject({
        controllerReady: true,
        controllerUnavailable: false,
      });
    });
    expect(mocks.subscribeToRuns).toHaveBeenCalledOnce();
    return mocks.subscribeToRuns.mock.calls[0][0] as SubscribeControllerRunsParams;
  }

  async function during(callback: () => void) {
    await act(async () => {
      callback();
      await flushMicrotasks();
    });
  }

  it("does not call the controller unavailable when its first stream is refused (429)", async () => {
    const subscription = await renderHydrated();
    const reconnected = vi.fn();
    window.addEventListener("instafy:controller-stream-reconnected", reconnected);
    try {
      expect(subscription.onRefused).toBeTypeOf("function");
      await during(() =>
        subscription.onRefused?.(
          "Too many open event streams. Close other Instafy tabs and try again.",
        ),
      );
      expect(latestRuntime).toMatchObject({
        controllerReady: true,
        controllerUnavailable: false,
        controllerStreamDisconnected: true,
      });
      // The stream backs off on its own; subscribing again would start its
      // refusal count over.
      expect(mocks.subscribeToRuns).toHaveBeenCalledOnce();

      await during(() => subscription.onOpen?.());
      expect(latestRuntime).toMatchObject({
        controllerReady: true,
        controllerUnavailable: false,
        controllerStreamDisconnected: false,
        controllerStreamDisconnectMessage: null,
      });
      // What the tab missed while refused is fetched again.
      await vi.waitFor(() => expect(mocks.fetchRuns).toHaveBeenCalledTimes(2));
      expect(reconnected).toHaveBeenCalledOnce();
      expect(mocks.subscribeToRuns).toHaveBeenCalledOnce();
    } finally {
      window.removeEventListener("instafy:controller-stream-reconnected", reconnected);
    }
  });

  it("clears the unavailable mark of a failed first attempt once the stream opens", async () => {
    const subscription = await renderHydrated();

    await during(() => subscription.onError?.("Failed to fetch"));
    expect(latestRuntime).toMatchObject({
      controllerReady: false,
      controllerUnavailable: true,
    });

    // The stream's own retry opens it; the mark must not outlive that.
    await during(() => subscription.onOpen?.());
    expect(latestRuntime).toMatchObject({
      controllerReady: true,
      controllerUnavailable: false,
      controllerStreamDisconnected: false,
    });
  });
});
