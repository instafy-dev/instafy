// @vitest-environment jsdom
//
// An open Studio tab that nobody uses must not start the space's machine
// again after the controller's idle stop, the second and every later idle
// stop of the same machine included. Production, Oct 24: one idle tab held
// only the first idle stop it saw and started the machine again after each
// later one, every 30 to 60 minutes. This wires the stop notice and the
// recovery listener the way StudioLayout and RuntimeOperationsProvider do:
// - each lifecycle event is dispatched and then the statuses refresh
//   (useRuntimeControllerSync),
// - ensureHostedRuntime changes identity when the statuses refresh, and
//   lifts every hold as a request does (useHostedRuntimeEnsure),
// - the selection comes from the real selectors, with the ready-runtime ref
//   lagging an effect behind as useHostedRuntimeSelectionState and
//   useHostedRuntimePolicy leave it.

import { act, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ControllerRuntimeStatusEntry } from "../../../sdk/instafy";
import {
  clearIdlePaused,
  clearManualStop,
  clearRestoredAwaitingIntent,
  isIdlePaused,
} from "../../idlePauseRegistry";
import type { HostedRuntimeLifecycleEventKind } from "../../unexpectedHostedRuntimeRecovery";
import { isHostedRuntime, runtimeEntryIsBooting, runtimeEntryIsReady } from "../../utils/runtimeEntry";
import {
  resolveEffectiveRuntimeSelection,
  resolveHasLocalRuntime,
  resolveLastReadyHostedRuntime,
  resolvePreferredRuntimeEntry,
  resolveReadyRuntimeEntries,
  resolveRuntimeReady,
  resolveSessionRuntimeEntry,
  resolveWaitingForPreferredRuntime,
} from "../hostedRuntimePolicySelectors";
import { useComposerIntentWake } from "../useComposerIntentWake";
import { useHostedRuntimeRecoveryEffects } from "../useHostedRuntimeRecoveryEffects";
import { useRuntimeStopNotice } from "../useRuntimeStopNotice";

const PROJECT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const RUNTIME_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

/**
 * How the space picks its machine: "auto" has no preferred runtime,
 * "preferred" prefers the hosted one, "session" also pins it for the session.
 */
type Selection = "auto" | "preferred" | "session";

function hostedEntry(status: "ready" | "stopped"): ControllerRuntimeStatusEntry {
  return {
    runtimeId: RUNTIME_ID,
    status,
    provider: "instafy-cloud",
    idleTtlSeconds: 300,
    createdAt: new Date(Date.now() - 86_400_000).toISOString(),
    lastSeenAt: status === "ready" ? new Date().toISOString() : null,
    launchRequestedAt: new Date(Date.now() - 600_000).toISOString(),
    endpointUrl: null,
    taskRef: null,
    isLocal: false,
    isPrivateSelfHosted: false,
    isPreferred: false,
    health: status === "ready" ? "online" : "offline",
  } as ControllerRuntimeStatusEntry;
}

let server: "ready" | "stopped" = "ready";
const ensureCalls: string[] = [];
let phase = "";
const showStatus = vi.fn();
let refreshStatuses: (() => Promise<void>) | null = null;
let requestMachine: (() => Promise<boolean>) | null = null;
let rerender: (() => void) | null = null;

function Studio({ selection }: { selection: Selection }) {
  const [statuses, setStatuses] = useState<ControllerRuntimeStatusEntry[]>(() => [
    hostedEntry(server),
  ]);
  const [, setTick] = useState(0);
  rerender = () => setTick((value) => value + 1);
  const refreshRuntimeStatuses = useCallback(async () => {
    setStatuses([hostedEntry(server)]);
  }, []);
  refreshStatuses = refreshRuntimeStatuses;
  const debugLog = useCallback(() => {}, []);
  const ensureHostedRuntime = useCallback(async () => {
    void statuses;
    clearManualStop(PROJECT_ID);
    clearRestoredAwaitingIntent(PROJECT_ID);
    clearIdlePaused(PROJECT_ID);
    ensureCalls.push(phase);
    return true;
  }, [statuses]);
  requestMachine = ensureHostedRuntime;

  const preferredRuntimeId = selection === "auto" ? null : RUNTIME_ID;
  const sessionRuntimeId = selection === "session" ? RUNTIME_ID : null;
  const preferredRuntimeEntry = useMemo(
    () => resolvePreferredRuntimeEntry(statuses, preferredRuntimeId),
    [statuses, preferredRuntimeId],
  );
  const sessionRuntimeEntry = useMemo(
    () => resolveSessionRuntimeEntry(statuses, sessionRuntimeId),
    [statuses, sessionRuntimeId],
  );
  const readyRuntimeEntries = useMemo(() => resolveReadyRuntimeEntries(statuses), [statuses]);
  const waitingForPreferredRuntime = resolveWaitingForPreferredRuntime({
    preferredRuntimeId,
    sessionRuntimeId,
    preferredRuntimeEntry,
  });
  const { effectiveRuntimeSource } = resolveEffectiveRuntimeSelection({
    sessionRuntimeId,
    preferredRuntimeId,
  });
  const runtimeReady = resolveRuntimeReady({
    waitingForPreferredRuntime,
    effectiveRuntimeSource,
    sessionRuntimeEntry,
    preferredRuntimeEntry,
    readyRuntimeEntries,
  });
  const hasHostedRuntimeInProgress = useMemo(
    () =>
      statuses.some(
        (entry) => isHostedRuntime(entry) && (runtimeEntryIsReady(entry) || runtimeEntryIsBooting(entry)),
      ),
    [statuses],
  );
  const hostedRuntimeOnline = useMemo(
    () => statuses.some((entry) => isHostedRuntime(entry) && runtimeEntryIsReady(entry)),
    [statuses],
  );
  const selectionLastReadyRef = useRef<{ projectId: string; runtimeId: string } | null>(null);
  useEffect(() => {
    selectionLastReadyRef.current = resolveLastReadyHostedRuntime({
      activeProjectId: PROJECT_ID,
      sessionRuntimeEntry,
      preferredRuntimeEntry,
      readyRuntimeEntries,
    });
  }, [preferredRuntimeEntry, readyRuntimeEntries, sessionRuntimeEntry]);
  const latestReadyHostedRuntime = selectionLastReadyRef.current;
  const latestReadyHostedRuntimeRef = useRef<{ projectId: string; runtimeId: string } | null>(null);
  useEffect(() => {
    latestReadyHostedRuntimeRef.current = latestReadyHostedRuntime;
  }, [latestReadyHostedRuntime]);

  const autoEnsureHostedRef = useRef(false);
  const pendingHostedPollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingHostedRuntimeRecoveryRef = useRef<{
    projectId: string;
    runtimeId: string | null;
    kind: HostedRuntimeLifecycleEventKind;
    at: number;
  } | null>(null);
  const openPanelTab = useCallback(() => {}, []);
  const fetchProjectRuns = useCallback(async () => [], []);

  useRuntimeStopNotice({
    activeProjectId: PROJECT_ID,
    hostedRuntimeReady: hostedRuntimeOnline,
    showStatus,
    openPanelTab,
  });
  useComposerIntentWake(PROJECT_ID);
  useHostedRuntimeRecoveryEffects({
    activeProjectId: PROJECT_ID,
    projectInitialized: true,
    projectAccessResolved: true,
    projectReadyForRuntime: true,
    runtimeControllerEnabled: true,
    runtimeStatuses: statuses,
    runtimeReady,
    readyRuntimeCount: readyRuntimeEntries.length,
    runtimeStatusesResolved: true,
    waitingForPreferredRuntime,
    preferredRuntimeEntry,
    hostedRuntimeEnsuring: false,
    hasHostedRuntimeInProgress,
    hasLocalRuntime: resolveHasLocalRuntime(statuses),
    hasPendingProjectWork: false,
    runs: null,
    fetchProjectRuns,
    disableAutoRuntimeEnsure: false,
    resolvedPreferredRuntimeId: preferredRuntimeId,
    ensureHostedRuntime,
    refreshRuntimeStatuses,
    debugLog,
    autoEnsureHostedRef,
    pendingHostedPollTimerRef,
    pendingHostedRuntimeRecoveryRef,
    latestReadyHostedRuntimeRef,
  });
  return <div id="studio-chat-input" contentEditable suppressContentEditableWarning tabIndex={0} />;
}

async function settle() {
  await act(async () => {
    for (let i = 0; i < 5; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  });
}

/** A controller event as useRuntimeControllerSync forwards it, then the statuses refresh. */
async function controllerEvent(kind: HostedRuntimeLifecycleEventKind, data: Record<string, unknown>) {
  await act(async () => {
    window.dispatchEvent(
      new CustomEvent("instafy:runtime-lifecycle-event", {
        detail: { projectId: PROJECT_ID, kind, data },
      }),
    );
    await refreshStatuses?.();
  });
  await settle();
}

const pausedNotices = () =>
  showStatus.mock.calls.filter(
    (call) => (call[3] as { id?: string } | undefined)?.id === "runtime-paused-idle",
  ).length;

describe("an idle Studio tab and the controller's idle stops", () => {
  let container: HTMLDivElement;
  let root: Root;

  /**
   * The controller stops the idle machine: runtime.stopped (idle) at once,
   * its origin.expired about a minute later.
   */
  async function idleStop({ rerenderBeforeExpiry }: { rerenderBeforeExpiry: boolean }) {
    vi.setSystemTime(Date.now() + 31 * 60_000);
    server = "stopped";
    phase = "idle stop";
    await controllerEvent("runtime.stopped", {
      runtimeId: RUNTIME_ID,
      status: "stopped",
      reason: "idle",
      source: "idle_stop",
    });
    if (rerenderBeforeExpiry) {
      // Any unrelated render of the studio before the origin expires.
      await act(async () => {
        rerender?.();
      });
      await settle();
    }
    vi.setSystemTime(Date.now() + 65_000);
    await controllerEvent("origin.expired", { originId: "origin-1" });
  }

  /** The person comes back and types in the composer. */
  async function personTypes() {
    phase = "person";
    const composer = container.querySelector<HTMLElement>("#studio-chat-input");
    if (!composer) throw new Error("missing composer");
    await act(async () => {
      composer.dispatchEvent(new KeyboardEvent("keydown", { key: "h", bubbles: true }));
    });
    await settle();
  }

  /** The person sends, which asks for the machine. */
  async function personSends() {
    phase = "person";
    await act(async () => {
      await requestMachine?.();
    });
    await settle();
  }

  async function machineComesUp() {
    server = "ready";
    vi.setSystemTime(Date.now() + 20_000);
    phase = "boot";
    await act(async () => {
      await refreshStatuses?.();
    });
    await settle();
  }

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers({ toFake: ["Date"] });
    server = "ready";
    phase = "";
    ensureCalls.length = 0;
    showStatus.mockClear();
    clearIdlePaused(PROJECT_ID);
    clearManualStop(PROJECT_ID);
    clearRestoredAwaitingIntent(PROJECT_ID);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    vi.useRealTimers();
    clearIdlePaused(PROJECT_ID);
    clearManualStop(PROJECT_ID);
    clearRestoredAwaitingIntent(PROJECT_ID);
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  for (const selection of ["auto", "preferred", "session"] as const) {
    it(`holds every idle stop of the same machine (${selection} runtime)`, async () => {
      await act(async () => {
        root.render(<Studio selection={selection} />);
      });
      await settle();

      for (const [stop, rerenderBeforeExpiry] of [
        [1, true],
        [2, false],
        [3, true],
      ] as const) {
        await idleStop({ rerenderBeforeExpiry });
        expect(ensureCalls, `idle stop ${stop}`).toEqual([]);
        expect(isIdlePaused(PROJECT_ID), `idle stop ${stop}`).toBe(true);
        expect(pausedNotices(), `idle stop ${stop}`).toBe(stop);

        // Typing wakes the space. With no runtime pinned for the session
        // that starts the machine; a pinned one waits for Send.
        await personTypes();
        expect(isIdlePaused(PROJECT_ID), `idle stop ${stop}`).toBe(false);
        if (selection === "session" && ensureCalls.length === 0) {
          await personSends();
        }
        expect(ensureCalls, `idle stop ${stop}`).toEqual(["person"]);
        ensureCalls.length = 0;
        await machineComesUp();
      }
    });
  }
});
