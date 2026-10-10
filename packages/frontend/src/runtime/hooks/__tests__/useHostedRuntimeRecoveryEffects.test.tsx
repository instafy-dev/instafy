// @vitest-environment jsdom

import { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ControllerRuntimeStatusEntry } from "../../../sdk/instafy";
import {
  clearIdlePaused,
  clearManualStop,
  isIdlePaused,
  isManualStopHeld,
  markIdlePaused,
  markManualStop,
} from "../../idlePauseRegistry";
import type { HostedRuntimeLifecycleEventKind } from "../../unexpectedHostedRuntimeRecovery";
import { useHostedRuntimeRecoveryEffects } from "../useHostedRuntimeRecoveryEffects";

const PROJECT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const RUNTIME_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OTHER_RUNTIME_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

function hostedEntry(
  status: "ready" | "stopped" | "requested",
  runtimeId = RUNTIME_ID,
): ControllerRuntimeStatusEntry {
  return {
    runtimeId,
    status,
    provider: "instafy-cloud",
    idleTtlSeconds: 300,
    createdAt: new Date(Date.now() - 600_000).toISOString(),
    lastSeenAt: status === "ready" ? new Date().toISOString() : null,
    // The machine's own launch, ten minutes before. A stop's release keeps
    // the runtime `requested` on that lease, never seen since.
    launchRequestedAt: new Date(Date.now() - 600_000).toISOString(),
    endpointUrl: null,
    taskRef: null,
    isLocal: false,
    isPrivateSelfHosted: false,
    isPreferred: false,
    health: status === "ready" ? "online" : "offline",
  } as ControllerRuntimeStatusEntry;
}

interface HarnessProps {
  stopped: boolean;
  preferred: boolean;
  hasPendingProjectWork: boolean;
  /** A second hosted machine in the space that stays ready. */
  otherReady?: boolean;
  /**
   * The stopped machine as a stop's provider release leaves it: `requested`,
   * offline and never seen, on the old launch. The ensure hook reads that
   * row as neither ready nor booting.
   */
  releasing?: boolean;
}

describe("useHostedRuntimeRecoveryEffects after a stop", () => {
  let container: HTMLDivElement;
  let root: Root;
  // Like the real request, asking for a machine lifts the space's holds.
  const ensureHostedRuntime = vi.fn(async () => {
    clearManualStop(PROJECT_ID);
    clearIdlePaused(PROJECT_ID);
    return true;
  });

  function Harness({
    stopped,
    preferred,
    hasPendingProjectWork,
    otherReady = false,
    releasing = false,
  }: HarnessProps) {
    const entry = hostedEntry(stopped ? (releasing ? "requested" : "stopped") : "ready");
    const statuses = otherReady ? [entry, hostedEntry("ready", OTHER_RUNTIME_ID)] : [entry];
    const readyRuntimeCount = (stopped ? 0 : 1) + (otherReady ? 1 : 0);
    const autoEnsureHostedRef = useRef(false);
    const pendingHostedPollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const pendingHostedRuntimeRecoveryRef = useRef<{
      projectId: string;
      runtimeId: string | null;
      kind: HostedRuntimeLifecycleEventKind;
      at: number;
    } | null>(null);
    // The studio had this machine ready before the stop.
    const latestReadyHostedRuntimeRef = useRef<{ projectId: string; runtimeId: string } | null>({
      projectId: PROJECT_ID,
      runtimeId: RUNTIME_ID,
    });
    useHostedRuntimeRecoveryEffects({
      activeProjectId: PROJECT_ID,
      projectInitialized: true,
      projectAccessResolved: true,
      projectReadyForRuntime: true,
      runtimeControllerEnabled: true,
      runtimeStatuses: statuses,
      runtimeReady: readyRuntimeCount > 0,
      readyRuntimeCount,
      runtimeStatusesResolved: true,
      waitingForPreferredRuntime: preferred && stopped,
      preferredRuntimeEntry: preferred ? entry : null,
      hostedRuntimeEnsuring: false,
      hasHostedRuntimeInProgress: false,
      hasLocalRuntime: false,
      hasPendingProjectWork,
      disableAutoRuntimeEnsure: false,
      resolvedPreferredRuntimeId: preferred ? RUNTIME_ID : null,
      ensureHostedRuntime,
      refreshRuntimeStatuses: async () => {},
      debugLog: () => {},
      autoEnsureHostedRef,
      pendingHostedPollTimerRef,
      pendingHostedRuntimeRecoveryRef,
      latestReadyHostedRuntimeRef,
    });
    return null;
  }

  async function render(props: HarnessProps) {
    await act(async () => {
      root.render(<Harness {...props} />);
    });
  }

  /** The controller event as useRuntimeControllerSync forwards it. */
  async function publishStop(data: Record<string, unknown>) {
    await act(async () => {
      window.dispatchEvent(
        new CustomEvent("instafy:runtime-lifecycle-event", {
          detail: {
            projectId: PROJECT_ID,
            kind: "runtime.stopped",
            data: { runtimeId: RUNTIME_ID, status: "stopped", ...data },
          },
        }),
      );
    });
  }

  /** The machine's origin went away, as useRuntimeControllerSync forwards it. */
  async function publishOriginExpired() {
    await act(async () => {
      window.dispatchEvent(
        new CustomEvent("instafy:runtime-lifecycle-event", {
          detail: {
            projectId: PROJECT_ID,
            kind: "origin.expired",
            data: { runtimeId: RUNTIME_ID },
          },
        }),
      );
    });
  }

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    ensureHostedRuntime.mockClear();
    clearIdlePaused(PROJECT_ID);
    clearManualStop(PROJECT_ID);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    clearIdlePaused(PROJECT_ID);
    clearManualStop(PROJECT_ID);
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it.each([
    ["fallback", false],
    ["preferred", true],
  ])(
    "does not take the slot back without work of its own (%s runtime)",
    async (_label, preferred) => {
      const idle = { preferred, hasPendingProjectWork: false };
      await render({ ...idle, stopped: false });
      await publishStop({ reason: "runtime_limit_reclaim", queuedJobCount: 0 });
      // The status refresh that follows the event shows the machine stopped.
      await render({ ...idle, stopped: true });

      expect(ensureHostedRuntime).not.toHaveBeenCalled();
      expect(isIdlePaused(PROJECT_ID)).toBe(true);

      // The person comes back (StudioLayout clears the pause on input): the
      // ordinary auto-ensure may ask for a machine again.
      await act(async () => {
        clearIdlePaused(PROJECT_ID);
      });
      expect(ensureHostedRuntime).toHaveBeenCalledTimes(1);
    },
  );

  it("asks again at once when this tab has a queued message or open turn there", async () => {
    const busy = { preferred: false, hasPendingProjectWork: true };
    await render({ ...busy, stopped: false });
    await publishStop({ reason: "runtime_limit_reclaim", queuedJobCount: 0 });
    await render({ ...busy, stopped: true });

    expect(ensureHostedRuntime).toHaveBeenCalledTimes(1);
    expect(isIdlePaused(PROJECT_ID)).toBe(false);
  });

  it("treats work the controller reports queued there as this space's own", async () => {
    const idle = { preferred: false, hasPendingProjectWork: false };
    await render({ ...idle, stopped: false });
    await publishStop({ reason: "runtime_limit_reclaim", queuedJobCount: 1 });
    await render({ ...idle, stopped: true });

    expect(ensureHostedRuntime).toHaveBeenCalledTimes(1);
    expect(isIdlePaused(PROJECT_ID)).toBe(false);
  });

  it("still recovers an unexpected loss straight away", async () => {
    const idle = { preferred: false, hasPendingProjectWork: false };
    await render({ ...idle, stopped: false });
    await publishStop({ reason: "heartbeat_timeout" });
    await render({ ...idle, stopped: true });

    expect(ensureHostedRuntime).toHaveBeenCalledTimes(1);
    expect(isIdlePaused(PROJECT_ID)).toBe(false);
    expect(isManualStopHeld(PROJECT_ID)).toBe(false);
  });

  it.each([
    ["user_stop", false],
    ["user_remove", false],
    ["runtime_limit_takeover", false],
    ["browser_session_runtime_limit_takeover", false],
    ["user_stop", true],
  ])(
    "does not undo a %s made in another tab once the controller reports it (preferred runtime: %s)",
    async (reason, preferred) => {
      // This tab did not press Stop, so nothing marked a hold before the
      // event; without one it saw no ready machine and started it again.
      // The controller records these stops without publishing runtime.stopped
      // today, so this pins the listener's side for when it does.
      const idle = { preferred, hasPendingProjectWork: false };
      await render({ ...idle, stopped: false });
      await publishStop({ reason });
      await render({ ...idle, stopped: true });

      expect(ensureHostedRuntime).not.toHaveBeenCalled();
      expect(isManualStopHeld(PROJECT_ID)).toBe(true);
    },
  );

  it("does not hold the space when another hosted machine stays live", async () => {
    // Stopping one of two machines elsewhere is not "no machine here", the
    // same rule the tab that pressed Stop follows.
    const busy = { preferred: false, hasPendingProjectWork: false, otherReady: true };
    await render({ ...busy, stopped: false });
    await publishStop({ reason: "user_stop" });
    await render({ ...busy, stopped: true });

    expect(isManualStopHeld(PROJECT_ID)).toBe(false);
    expect(isIdlePaused(PROJECT_ID)).toBe(false);
  });

  it.each(["oom_killed", "credits_exhausted"])(
    "holds a %s stop like an idle pause",
    async (reason) => {
      const idle = { preferred: false, hasPendingProjectWork: false };
      await render({ ...idle, stopped: false });
      await publishStop({ reason });
      await render({ ...idle, stopped: true });

      expect(ensureHostedRuntime).not.toHaveBeenCalled();
      expect(isIdlePaused(PROJECT_ID)).toBe(true);
      expect(isManualStopHeld(PROJECT_ID)).toBe(false);

      // Writing in the chat there lifts the pause and the machine starts.
      await act(async () => {
        clearIdlePaused(PROJECT_ID);
      });
      expect(ensureHostedRuntime).toHaveBeenCalledTimes(1);
    },
  );
  it("keeps this tab's Stop when the stopped machine's origin expires during its release", async () => {
    // Production, Oct 10: Machines > Stop in the only open tab. While the
    // provider released the machine the runtime read `requested`, offline,
    // never seen, on its old launch; its origin then expired and the tab
    // started the machine again, lifting the Stop.
    const idle = { preferred: false, hasPendingProjectWork: true };
    await render({ ...idle, stopped: false });
    await act(async () => {
      markManualStop(PROJECT_ID);
    });
    await publishOriginExpired();
    await render({ ...idle, stopped: true, releasing: true });

    expect(ensureHostedRuntime).not.toHaveBeenCalled();
    expect(isManualStopHeld(PROJECT_ID)).toBe(true);

    // The release finishes; the loss is still the stop.
    await render({ ...idle, stopped: true });
    expect(ensureHostedRuntime).not.toHaveBeenCalled();
    expect(isManualStopHeld(PROJECT_ID)).toBe(true);
  });

  it("does not undo an idle pause when the paused machine's origin expires", async () => {
    const idle = { preferred: false, hasPendingProjectWork: false };
    await render({ ...idle, stopped: false });
    await publishStop({ reason: "idle" });
    // StudioLayout pauses the space when it explains the idle stop.
    await act(async () => {
      markIdlePaused(PROJECT_ID);
    });
    await publishOriginExpired();
    await render({ ...idle, stopped: true });

    expect(ensureHostedRuntime).not.toHaveBeenCalled();
    expect(isIdlePaused(PROJECT_ID)).toBe(true);
  });

  it("still recovers a machine whose origin expired without a stop", async () => {
    const idle = { preferred: false, hasPendingProjectWork: false };
    await render({ ...idle, stopped: false });
    await publishOriginExpired();
    await render({ ...idle, stopped: true });

    expect(ensureHostedRuntime).toHaveBeenCalledTimes(1);
    expect(isManualStopHeld(PROJECT_ID)).toBe(false);
  });

  it.each([
    ["before", true],
    ["after", false],
  ])(
    "never starts the machine again when a person's runtime.stopped arrives %s origin.expired",
    async (_label, stoppedFirst) => {
      const idle = { preferred: false, hasPendingProjectWork: true };
      await render({ ...idle, stopped: false });
      if (stoppedFirst) {
        await publishStop({ reason: "user_stop" });
        await publishOriginExpired();
      } else {
        await publishOriginExpired();
        await publishStop({ reason: "user_stop" });
      }
      await render({ ...idle, stopped: true, releasing: true });
      await render({ ...idle, stopped: true });

      expect(ensureHostedRuntime).not.toHaveBeenCalled();
      expect(isManualStopHeld(PROJECT_ID)).toBe(true);
    },
  );
});
