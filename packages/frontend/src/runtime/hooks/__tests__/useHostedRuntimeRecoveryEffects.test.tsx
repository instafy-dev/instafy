// @vitest-environment jsdom

import { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ControllerRuntimeStatusEntry } from "../../../sdk/instafy";
import { clearIdlePaused, isIdlePaused } from "../../idlePauseRegistry";
import type { HostedRuntimeLifecycleEventKind } from "../../unexpectedHostedRuntimeRecovery";
import { useHostedRuntimeRecoveryEffects } from "../useHostedRuntimeRecoveryEffects";

const PROJECT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const RUNTIME_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

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
  stopped: boolean;
  preferred: boolean;
  hasPendingProjectWork: boolean;
}

describe("useHostedRuntimeRecoveryEffects after a runtime-limit reclaim", () => {
  let container: HTMLDivElement;
  let root: Root;
  const ensureHostedRuntime = vi.fn(async () => true);

  function Harness({ stopped, preferred, hasPendingProjectWork }: HarnessProps) {
    const entry = hostedEntry(stopped ? "stopped" : "ready");
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
      runtimeStatuses: [entry],
      runtimeReady: !stopped,
      readyRuntimeCount: stopped ? 0 : 1,
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

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    ensureHostedRuntime.mockClear();
    clearIdlePaused(PROJECT_ID);
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
  });
});
