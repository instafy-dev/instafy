// @vitest-environment jsdom

import { act, useMemo, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ControllerRuntimeStatusEntry } from "../../../sdk/instafy";
import {
  clearIdlePaused,
  clearManualStop,
  clearRestoredAwaitingIntent,
  isRestoredAwaitingIntent,
} from "../../idlePauseRegistry";
import { createInitialRuntimeStoreState } from "../../runtimeStore";
import type { HostedRuntimeLifecycleEventKind } from "../../unexpectedHostedRuntimeRecovery";
import { useHostedRuntimeProjectEffects } from "../useHostedRuntimeProjectEffects";
import { useHostedRuntimeRecoveryEffects } from "../useHostedRuntimeRecoveryEffects";

const SPACE_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SPACE_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const RUNTIME_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

function hostedEntry(status: "ready" | "stopped"): ControllerRuntimeStatusEntry {
  return {
    runtimeId: RUNTIME_ID,
    status,
    provider: "instafy-cloud",
    idleTtlSeconds: 300,
    createdAt: new Date(Date.now() - 600_000).toISOString(),
    lastSeenAt: status === "ready" ? new Date().toISOString() : null,
    endpointUrl: null,
    taskRef: null,
    isLocal: false,
    isPrivateSelfHosted: false,
    isPreferred: false,
    health: status === "ready" ? "online" : "offline",
  } as ControllerRuntimeStatusEntry;
}

interface HarnessProps {
  projectId: string;
  statuses: ControllerRuntimeStatusEntry[];
  statusesResolved: boolean;
  preferred?: boolean;
}

describe("opening a space does not start its machine", () => {
  let container: HTMLDivElement;
  let root: Root;
  const ensureHostedRuntime = vi.fn(async () => true);
  const dispatch = vi.fn();
  const noop = () => {};

  // The two hooks useHostedRuntimePolicy composes, in the same order, so the
  // project-change layout effect and the auto-start effects share a commit.
  function Harness({ projectId, statuses, statusesResolved, preferred = false }: HarnessProps) {
    const state = useMemo(
      () => ({ ...createInitialRuntimeStoreState(), runtimeStatuses: statuses }),
      [statuses],
    );
    const readyRuntimeCount = statuses.filter((entry) => entry.status === "ready").length;
    const preferredEntry = preferred ? statuses[0] ?? null : null;
    const autoEnsureHostedRef = useRef(false);
    const pendingHostedPollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const pendingHostedRuntimeRecoveryRef = useRef<{
      projectId: string;
      runtimeId: string | null;
      kind: HostedRuntimeLifecycleEventKind;
      at: number;
    } | null>(null);
    const latestReadyHostedRuntimeRef = useRef<{ projectId: string; runtimeId: string } | null>(null);
    const previousPreferredRuntimeIdRef = useRef<string | null>(null);
    const runtimeOfflineAlertRef = useRef<string | null>(null);
    const previousRuntimeProjectIdRef = useRef<string | null>(null);
    const lastPreferredRuntimeIdRef = useRef<string | null>(null);
    const preferenceClearRequestedRef = useRef(false);

    useHostedRuntimeRecoveryEffects({
      activeProjectId: projectId,
      projectInitialized: true,
      projectAccessResolved: true,
      // A switch commits the new space while access still reads ready from
      // the space being left.
      projectReadyForRuntime: true,
      runtimeControllerEnabled: true,
      runtimeStatuses: statuses,
      runtimeReady: readyRuntimeCount > 0,
      readyRuntimeCount,
      runtimeStatusesResolved: statusesResolved,
      waitingForPreferredRuntime: Boolean(preferredEntry) && readyRuntimeCount === 0,
      preferredRuntimeEntry: preferredEntry,
      hostedRuntimeEnsuring: false,
      hasHostedRuntimeInProgress: readyRuntimeCount > 0,
      hasLocalRuntime: false,
      disableAutoRuntimeEnsure: false,
      resolvedPreferredRuntimeId: preferredEntry?.runtimeId ?? null,
      ensureHostedRuntime,
      refreshRuntimeStatuses: async () => {},
      debugLog: noop,
      autoEnsureHostedRef,
      pendingHostedPollTimerRef,
      pendingHostedRuntimeRecoveryRef,
      latestReadyHostedRuntimeRef,
    });
    useHostedRuntimeProjectEffects({
      activeProjectId: projectId,
      projectReadyForRuntime: true,
      runtimeControllerEnabled: true,
      state,
      dispatch,
      runtimeReady: readyRuntimeCount > 0,
      preferredPromptDismissed: false,
      setPreferredPromptDismissed: noop,
      shouldPromptCloudFallback: false,
      resolvedPreferredRuntimeId: preferredEntry?.runtimeId ?? null,
      preferredRuntimeEntry: preferredEntry,
      refreshRuntimeStatuses: async () => {},
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
      setRuntimeStatusesResolved: noop,
    });
    return null;
  }

  async function render(props: HarnessProps) {
    await act(async () => {
      root.render(<Harness {...props} />);
    });
  }

  function clearHolds() {
    for (const projectId of [SPACE_A, SPACE_B]) {
      clearRestoredAwaitingIntent(projectId);
      clearIdlePaused(projectId);
      clearManualStop(projectId);
    }
  }

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    ensureHostedRuntime.mockClear();
    dispatch.mockClear();
    clearHolds();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    clearHolds();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it.each([
    ["no machine yet (empty state)", [], true, false],
    ["statuses still loading (fallback)", [], false, false],
    ["a stopped machine and no preference (fallback)", [hostedEntry("stopped")], true, false],
    ["a stopped preferred machine", [hostedEntry("stopped")], true, true],
  ] as const)(
    "waits for intent with %s",
    async (_label, statuses, statusesResolved, preferred) => {
      const props = { projectId: SPACE_A, statuses: [...statuses], statusesResolved, preferred };
      await render(props);

      expect(ensureHostedRuntime).not.toHaveBeenCalled();
      expect(isRestoredAwaitingIntent(SPACE_A)).toBe(true);

      // A later status refresh is not intent either.
      await render({ ...props, statuses: [...statuses] });
      expect(ensureHostedRuntime).not.toHaveBeenCalled();

      // The person writes in the composer: the machine starts, once.
      await act(async () => {
        clearRestoredAwaitingIntent(SPACE_A);
      });
      expect(ensureHostedRuntime).toHaveBeenCalledTimes(1);
    },
  );

  it("does not start the machine of the space switched to", async () => {
    await render({ projectId: SPACE_A, statuses: [hostedEntry("ready")], statusesResolved: true });
    expect(ensureHostedRuntime).not.toHaveBeenCalled();

    // The switcher, a link or `?projectId=B&panel=machines`: B commits with
    // its statuses not yet loaded.
    await render({ projectId: SPACE_B, statuses: [], statusesResolved: false });
    expect(ensureHostedRuntime).not.toHaveBeenCalled();
    expect(isRestoredAwaitingIntent(SPACE_B)).toBe(true);

    // Its statuses arrive: a stopped machine, still not started.
    await render({ projectId: SPACE_B, statuses: [hostedEntry("stopped")], statusesResolved: true });
    expect(ensureHostedRuntime).not.toHaveBeenCalled();
  });

  it("holds a space again each time it is opened", async () => {
    await render({ projectId: SPACE_A, statuses: [], statusesResolved: true });
    await act(async () => {
      clearRestoredAwaitingIntent(SPACE_A);
    });
    expect(ensureHostedRuntime).toHaveBeenCalledTimes(1);
    ensureHostedRuntime.mockClear();

    await render({ projectId: SPACE_B, statuses: [], statusesResolved: true });
    await render({ projectId: SPACE_A, statuses: [], statusesResolved: true });

    expect(ensureHostedRuntime).not.toHaveBeenCalled();
    expect(isRestoredAwaitingIntent(SPACE_A)).toBe(true);
  });
});
