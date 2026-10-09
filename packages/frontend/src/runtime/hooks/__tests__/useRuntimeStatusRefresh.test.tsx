// @vitest-environment jsdom

import { act, useCallback, useReducer, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fetchStatus: vi.fn(),
  setPreference: vi.fn(async () => true),
  fetchRecovery: vi.fn(),
  clearProjectState: vi.fn(),
}));

vi.mock("../../../sdk/instafy", () => ({
  controllerClient: {
    core: { enabled: true },
    runtimes: { fetchStatus: mocks.fetchStatus, setPreference: mocks.setPreference },
    workspace: { git: { fetchRecovery: mocks.fetchRecovery } },
  },
}));

vi.mock("../../../workspace/projectClear", () => ({ clearProjectState: mocks.clearProjectState }));

import type { ControllerRuntimeStatusEntry, WorkspaceRecoveryEntry } from "../../../sdk/instafy";
import type { RuntimeState } from "../../../types";
import {
  getRollingSaveScope,
  resetUnsavedWorkStoreForTests,
  UNSAVED_WORK_STOP_REFETCH_DELAY_MS,
  usePublishUnsavedWorkLiveOrigins,
  useUnsavedWork,
} from "../../../workspace/unsavedWorkStore";
import { clearRestoredAwaitingIntent } from "../../idlePauseRegistry";
import { createInitialRuntimeStoreState, runtimeReducer } from "../../runtimeStore";
import { useHostedRuntimeProjectEffects } from "../useHostedRuntimeProjectEffects";
import { useRuntimeStatusRefresh, type RuntimeStatusAnswer } from "../useRuntimeStatusRefresh";

const SPACE_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SPACE_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const LIVE = "11111111-1111-4111-8111-111111111111";
const LIST_ORIGIN = "o";

function running(originId: string): ControllerRuntimeStatusEntry {
  return {
    runtimeId: `runtime-${originId}`,
    status: "ready",
    provider: "instafy-cloud",
    idleTtlSeconds: 600,
    isLocal: false,
    isPreferred: false,
    health: "online",
    origin: { originId, status: "online", protocols: ["http"] },
  } as ControllerRuntimeStatusEntry;
}

function answer(...statuses: ControllerRuntimeStatusEntry[]) {
  return { runtimes: statuses, preferredRuntimeId: null };
}

/** The working folder's rolling save, last written by LIVE. */
function rollingSave(revision: string): WorkspaceRecoveryEntry {
  return {
    ref: "refs/instafy/recovery/folder-1/working",
    rev: revision.padStart(40, "c"),
    kind: "unsaved",
    subject: "Keep a workspace's unsaved changes",
    date: "2026-10-07T10:00:00Z",
    origin: LIVE,
    paths: ["a.txt"],
    base: null,
    rollingSave: true,
  } as WorkspaceRecoveryEntry;
}

function list(...entries: WorkspaceRecoveryEntry[]) {
  return { status: "ok", entries, originId: LIST_ORIGIN, originMode: "hosted" };
}

interface HarnessProps {
  projectId: string;
  /** The project's access has resolved (`projectReadyForRuntime`). */
  ready: boolean;
}

interface Probe {
  refresh: () => Promise<void>;
  statuses: ControllerRuntimeStatusEntry[];
  answer: RuntimeStatusAnswer | null;
  visibleRevs: string[];
}

let probe: Probe | null = null;

/**
 * The runtime provider's status path as it runs in Studio: the real reducer,
 * status refresh and project effects, feeding the real unsaved-work store.
 */
function Harness({ projectId, ready }: HarnessProps) {
  const [state, dispatch] = useReducer(runtimeReducer, undefined, createInitialRuntimeStoreState);
  const runtimeRef = useRef<RuntimeState>(state.runtime);
  const updateRuntime = useCallback((updater: (current: RuntimeState) => RuntimeState) => {
    runtimeRef.current = updater(runtimeRef.current);
  }, []);
  const noop = useCallback(() => {}, []);
  const lastPreferredRuntimeIdRef = useRef<string | null>(null);
  const preferenceClearRequestedRef = useRef(false);
  const previousPreferredRuntimeIdRef = useRef<string | null>(null);
  const runtimeOfflineAlertRef = useRef<string | null>(null);
  const autoEnsureHostedRef = useRef(false);
  const previousRuntimeProjectIdRef = useRef<string | null>(null);
  const latestReadyHostedRuntimeRef = useRef<{ projectId: string; runtimeId: string } | null>(null);
  const pendingHostedRuntimeRecoveryRef = useRef<unknown>(null);

  const { setRuntimeStatusesResolved, runtimeStatusAnswer, refreshRuntimeStatuses } = useRuntimeStatusRefresh({
    activeProjectId: projectId,
    projectReadyForRuntime: ready,
    dispatch,
    updateRuntime,
    debugLog: noop,
    bumpControllerSyncEpoch: noop,
    lastPreferredRuntimeIdRef,
    preferenceClearRequestedRef,
    allowPreferenceMutation: false,
  });
  usePublishUnsavedWorkLiveOrigins({ projectId, answer: runtimeStatusAnswer });
  useHostedRuntimeProjectEffects({
    activeProjectId: projectId,
    projectReadyForRuntime: ready,
    runtimeControllerEnabled: true,
    state,
    dispatch,
    runtimeReady: false,
    preferredPromptDismissed: false,
    setPreferredPromptDismissed: noop,
    shouldPromptCloudFallback: false,
    resolvedPreferredRuntimeId: null,
    preferredRuntimeEntry: null,
    refreshRuntimeStatuses,
    setPreferredRuntime: async () => true,
    showStatus: noop,
    previousPreferredRuntimeIdRef,
    runtimeOfflineAlertRef,
    autoEnsureHostedRef,
    previousRuntimeProjectIdRef,
    lastPreferredRuntimeIdRef,
    preferenceClearRequestedRef,
    latestReadyHostedRuntimeRef,
    pendingHostedRuntimeRecoveryRef,
    setRuntimeEnsureError: noop,
    setRuntimeEnsureLimit: noop,
    setRuntimeStatusesResolved,
  });
  const unsavedWork = useUnsavedWork({ projectId, originId: LIST_ORIGIN, enabled: true });
  probe = {
    refresh: refreshRuntimeStatuses,
    statuses: state.runtimeStatuses,
    answer: runtimeStatusAnswer,
    visibleRevs: unsavedWork.visibleEntries.map((item) => item.rev),
  };
  return null;
}

function current(): Probe {
  if (!probe) {
    throw new Error("harness not rendered");
  }
  return probe;
}

describe("live origins come only from a status answer for the current project", () => {
  let container: HTMLDivElement;
  let root: Root;

  async function settle() {
    await act(async () => {
      for (let i = 0; i < 10; i += 1) {
        await Promise.resolve();
      }
    });
  }

  async function render(props: HarnessProps) {
    await act(async () => {
      root.render(<Harness {...props} />);
    });
    await settle();
  }

  async function advance(ms: number) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
    await settle();
  }

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    vi.setSystemTime(new Date("2026-10-07T10:00:00Z"));
    resetUnsavedWorkStoreForTests();
    mocks.fetchStatus.mockReset();
    mocks.fetchRecovery.mockReset();
    mocks.clearProjectState.mockReset();
    probe = null;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    resetUnsavedWorkStoreForTests();
    clearRestoredAwaitingIntent(SPACE_A);
    clearRestoredAwaitingIntent(SPACE_B);
    vi.useRealTimers();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("keeps a running origin's save hidden through a failed status, and shows it after a real stop", async () => {
    mocks.fetchRecovery.mockResolvedValue(list(rollingSave("1")));
    mocks.fetchStatus.mockResolvedValueOnce(answer(running(LIVE)));
    await render({ projectId: SPACE_A, ready: true });
    expect(current().answer?.statuses.map((entry) => entry.origin?.originId)).toEqual([LIVE]);
    expect(current().visibleRevs).toEqual([]);
    expect(mocks.fetchRecovery).toHaveBeenCalledTimes(1);

    // One status request fails (5xx, timeout, network): the statuses read []
    // and resolved, but nothing said the turn stopped.
    mocks.fetchStatus.mockResolvedValueOnce(null);
    await act(async () => {
      await current().refresh();
    });
    expect(current().statuses).toEqual([]);
    await advance(UNSAVED_WORK_STOP_REFETCH_DELAY_MS * 2);
    expect(current().answer?.statuses.map((entry) => entry.origin?.originId)).toEqual([LIVE]);
    expect(current().visibleRevs).toEqual([]);
    expect(mocks.fetchRecovery).toHaveBeenCalledTimes(1);

    // A refresh inside the failure backoff is skipped and changes nothing;
    // it runs once the backoff ends, and the turn is still running.
    await act(async () => {
      await current().refresh();
    });
    expect(mocks.fetchStatus).toHaveBeenCalledTimes(2);
    expect(current().visibleRevs).toEqual([]);
    mocks.fetchStatus.mockResolvedValueOnce(answer(running(LIVE)));
    await advance(5_000);
    expect(mocks.fetchStatus).toHaveBeenCalledTimes(3);
    expect(current().visibleRevs).toEqual([]);

    // The runtime really stops: the list is fetched again and the final save shows.
    mocks.fetchRecovery.mockResolvedValue(list(rollingSave("2")));
    mocks.fetchStatus.mockResolvedValueOnce(answer());
    await act(async () => {
      await current().refresh();
    });
    await advance(UNSAVED_WORK_STOP_REFETCH_DELAY_MS);
    expect(mocks.fetchRecovery).toHaveBeenCalledTimes(2);
    expect(current().visibleRevs).toEqual([rollingSave("2").rev]);
  });

  it("runs a refresh the failure backoff skipped once the backoff ends, so a stop is not lost", async () => {
    mocks.fetchRecovery.mockResolvedValue(list(rollingSave("1")));
    mocks.fetchStatus.mockResolvedValueOnce(answer(running(LIVE)));
    await render({ projectId: SPACE_A, ready: true });
    expect(current().visibleRevs).toEqual([]);

    // One status request fails.
    mocks.fetchStatus.mockResolvedValueOnce(null);
    await act(async () => {
      await current().refresh();
    });
    // Within the backoff the runtime stops: its stop event asks for a
    // refresh, which the backoff skips, and its final save is listed.
    await advance(1_000);
    mocks.fetchRecovery.mockResolvedValue(list(rollingSave("2")));
    mocks.fetchStatus.mockResolvedValueOnce(answer());
    await act(async () => {
      await current().refresh();
      await current().refresh();
    });
    expect(mocks.fetchStatus).toHaveBeenCalledTimes(2);
    expect(current().visibleRevs).toEqual([]);

    // When the backoff ends, the skipped refresh runs once and the save shows.
    await advance(4_000);
    expect(mocks.fetchStatus).toHaveBeenCalledTimes(3);
    await advance(UNSAVED_WORK_STOP_REFETCH_DELAY_MS);
    expect(current().visibleRevs).toEqual([rollingSave("2").rev]);
    await advance(10_000);
    expect(mocks.fetchStatus).toHaveBeenCalledTimes(3);
  });

  it("retries a failed status request, so the stop it was asked for is not lost", async () => {
    mocks.fetchRecovery.mockResolvedValue(list(rollingSave("1")));
    mocks.fetchStatus.mockResolvedValueOnce(answer(running(LIVE)));
    await render({ projectId: SPACE_A, ready: true });
    expect(current().visibleRevs).toEqual([]);

    // The runtime stops and its final save is listed, but the one refresh
    // its stop asks for fails, and nothing else asks again.
    mocks.fetchRecovery.mockResolvedValue(list(rollingSave("2")));
    mocks.fetchStatus.mockResolvedValueOnce(null);
    mocks.fetchStatus.mockResolvedValue(answer());
    await act(async () => {
      await current().refresh();
    });
    expect(mocks.fetchStatus).toHaveBeenCalledTimes(2);
    expect(current().visibleRevs).toEqual([]);

    // The request is retried when the backoff ends, and the save shows.
    await advance(5_000);
    expect(mocks.fetchStatus).toHaveBeenCalledTimes(3);
    await advance(UNSAVED_WORK_STOP_REFETCH_DELAY_MS);
    expect(current().visibleRevs).toEqual([rollingSave("2").rev]);
    await advance(120_000);
    expect(mocks.fetchStatus).toHaveBeenCalledTimes(3);
  });

  it("keeps retrying a status that keeps failing, less often each time, up to once a minute", async () => {
    mocks.fetchRecovery.mockResolvedValue(list(rollingSave("1")));
    mocks.fetchStatus.mockResolvedValueOnce(answer(running(LIVE)));
    await render({ projectId: SPACE_A, ready: true });

    // The runtime stops while the controller is down: its stop's refresh
    // and every retry fail.
    mocks.fetchRecovery.mockResolvedValue(list(rollingSave("2")));
    mocks.fetchStatus.mockResolvedValue(null);
    await act(async () => {
      await current().refresh();
    });
    let calls = 2;
    expect(mocks.fetchStatus).toHaveBeenCalledTimes(calls);
    for (const delay of [5_000, 10_000, 20_000, 40_000, 60_000, 60_000]) {
      await advance(delay - 1);
      expect(mocks.fetchStatus).toHaveBeenCalledTimes(calls);
      await advance(1);
      calls += 1;
      expect(mocks.fetchStatus).toHaveBeenCalledTimes(calls);
    }
    expect(current().visibleRevs).toEqual([]);

    // The controller answers again, and a refresh something else asks for
    // after the backoff gets there before the next retry: the save shows,
    // and the retries stop.
    mocks.fetchStatus.mockResolvedValue(answer());
    await advance(5_000);
    await act(async () => {
      await current().refresh();
    });
    expect(mocks.fetchStatus).toHaveBeenCalledTimes(calls + 1);
    await advance(UNSAVED_WORK_STOP_REFETCH_DELAY_MS);
    expect(current().visibleRevs).toEqual([rollingSave("2").rev]);
    await advance(300_000);
    expect(mocks.fetchStatus).toHaveBeenCalledTimes(calls + 1);
  });

  it("runs a refresh the backoff skipped after a switch away and back", async () => {
    mocks.fetchRecovery.mockResolvedValue(list(rollingSave("1")));
    mocks.fetchStatus.mockResolvedValueOnce(answer(running(LIVE)));
    await render({ projectId: SPACE_A, ready: true });
    mocks.fetchStatus.mockResolvedValueOnce(null);
    await act(async () => {
      await current().refresh();
    });

    // A switch drops the retry; B sends nothing while its access is checked.
    await render({ projectId: SPACE_B, ready: false });
    await advance(1_000);
    // Back in A, still within the backoff: its refresh is skipped, and runs
    // when the backoff ends.
    mocks.fetchRecovery.mockResolvedValue(list(rollingSave("2")));
    mocks.fetchStatus.mockResolvedValue(answer());
    await render({ projectId: SPACE_A, ready: true });
    expect(mocks.fetchStatus).toHaveBeenCalledTimes(2);
    expect(current().visibleRevs).toEqual([]);
    await advance(4_000);
    expect(mocks.fetchStatus).toHaveBeenCalledTimes(3);
    await advance(UNSAVED_WORK_STOP_REFETCH_DELAY_MS);
    expect(current().visibleRevs).toEqual([rollingSave("2").rev]);
  });

  it("drops a refresh the backoff skipped when the space changes", async () => {
    mocks.fetchRecovery.mockResolvedValue(list());
    mocks.fetchStatus.mockResolvedValueOnce(answer(running(LIVE)));
    await render({ projectId: SPACE_A, ready: true });
    mocks.fetchStatus.mockResolvedValueOnce(null);
    await act(async () => {
      await current().refresh();
      await current().refresh();
    });
    expect(mocks.fetchStatus).toHaveBeenCalledTimes(2);

    mocks.fetchStatus.mockResolvedValue(answer());
    await render({ projectId: SPACE_B, ready: true });
    const afterSwitch = mocks.fetchStatus.mock.calls.length;
    await advance(10_000);
    expect(mocks.fetchStatus).toHaveBeenCalledTimes(afterSwitch);
  });

  it("hides every rolling save of the space switched to until its own status answers", async () => {
    // B was open moments ago, with LIVE running; its list is still cached.
    mocks.fetchRecovery.mockResolvedValue(list(rollingSave("1")));
    mocks.fetchStatus.mockResolvedValueOnce(answer(running(LIVE)));
    await render({ projectId: SPACE_B, ready: true });
    expect(current().visibleRevs).toEqual([]);

    mocks.fetchRecovery.mockResolvedValue(list());
    mocks.fetchStatus.mockResolvedValueOnce(answer());
    await render({ projectId: SPACE_A, ready: true });
    expect(getRollingSaveScope(SPACE_A).known).toBe(true);

    // Back to B: its access is checked again first. The not-ready path
    // publishes [] and resolved, which is not B's answer.
    mocks.fetchRecovery.mockResolvedValue(list(rollingSave("1")));
    await render({ projectId: SPACE_B, ready: false });
    expect(current().statuses).toEqual([]);
    expect(current().answer).toBeNull();
    expect(getRollingSaveScope(SPACE_B).known).toBe(false);
    expect(current().visibleRevs).toEqual([]);

    // Access resolves; B's status is on the wire.
    let answerB!: (value: unknown) => void;
    mocks.fetchStatus.mockImplementationOnce(() => new Promise((resolve) => (answerB = resolve)));
    await render({ projectId: SPACE_B, ready: true });
    expect(current().visibleRevs).toEqual([]);

    await act(async () => answerB(answer(running(LIVE))));
    await settle();
    expect(getRollingSaveScope(SPACE_B).known).toBe(true);
    expect(current().visibleRevs).toEqual([]);
  });

  it("drops an answer that lands after the switch away from its space", async () => {
    mocks.fetchRecovery.mockResolvedValue(list(rollingSave("1")));
    let lateAnswerA!: (value: unknown) => void;
    mocks.fetchStatus.mockImplementationOnce(() => new Promise((resolve) => (lateAnswerA = resolve)));
    await render({ projectId: SPACE_A, ready: true });

    // B is still being checked, so nothing aborts A's request.
    await render({ projectId: SPACE_B, ready: false });
    await act(async () => lateAnswerA(answer()));
    await settle();
    expect(current().answer).toBeNull();

    // Back in A, the late answer says nothing about what runs there now.
    await render({ projectId: SPACE_A, ready: false });
    expect(current().answer).toBeNull();
    expect(getRollingSaveScope(SPACE_A).known).toBe(false);
    expect(current().visibleRevs).toEqual([]);
  });
});
