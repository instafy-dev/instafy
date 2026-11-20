import { useCallback, useState } from "react";
import { controllerClient } from "../sdk/instafy";
import { useStatus } from "../status/useStatus";

/**
 * Starting a space on this computer: Instafy Desktop runs one runtime, for
 * one space, at a time, and starts it for the space and the session Studio
 * names. The connect dialog's Start, a waiting turn's Start and Studio's own
 * start for a turn that waits for this computer (docs/Local-Engine-Turns.md
 * 11.14) all go through here, so they start it the same way.
 */
export type DesktopSpaceStartOutcome =
  | { kind: "started"; status: InstafyDesktopRuntimeStatus | null }
  /** Studio is not in an Instafy Desktop that can start a space. */
  | { kind: "unavailable" }
  /** No session to start it with. */
  | { kind: "signed_out" }
  | { kind: "failed"; message: string };

/** Whether this page runs in an Instafy Desktop that can start a space on this computer. */
export function canStartSpaceOnThisComputer(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.instafyDesktop?.startDesktopRuntime === "function" &&
    typeof window.instafyDesktop?.desktopRuntimeStatus === "function"
  );
}

// One start at a time: a second press, or Studio's own start, while one is
// under way for the same space waits for that one instead of starting again.
let startInFlight: { projectId: string; promise: Promise<DesktopSpaceStartOutcome> } | null = null;

async function runStart(projectId: string): Promise<DesktopSpaceStartOutcome> {
  const desktop = typeof window === "undefined" ? undefined : window.instafyDesktop;
  if (!canStartSpaceOnThisComputer() || !desktop?.startDesktopRuntime) {
    return { kind: "unavailable" };
  }
  try {
    const requestContext = await controllerClient.core.resolveRequestContext(null);
    if (!requestContext.accessToken) {
      return { kind: "signed_out" };
    }
    await desktop.startDesktopRuntime({
      projectId,
      controllerUrl: requestContext.baseUrl,
      controllerAccessToken: requestContext.accessToken,
      controllerCredentialMode: requestContext.credentialSource ?? "fixed",
      displayName: "Instafy Desktop",
    });
    const status = (await desktop.desktopRuntimeStatus?.().catch(() => null)) ?? null;
    return { kind: "started", status };
  } catch (error) {
    return { kind: "failed", message: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Starts `projectId` on this computer, as Instafy Desktop's Start does. When
 * Desktop runs another space, it replaces that runtime, and asks first while
 * work is running there (docs/Local-Engine-Turns.md 4.4).
 */
export function startSpaceOnThisComputer(projectId: string): Promise<DesktopSpaceStartOutcome> {
  if (startInFlight && startInFlight.projectId === projectId) {
    return startInFlight.promise;
  }
  const promise = runStart(projectId).finally(() => {
    if (startInFlight?.promise === promise) {
      startInFlight = null;
    }
  });
  startInFlight = { projectId, promise };
  return promise;
}

/** The status a start's outcome shows, as the Start action words it. */
export function describeDesktopSpaceStartOutcome(outcome: DesktopSpaceStartOutcome): {
  message: string;
  intent: "success" | "warning" | "error";
  durationMs: number;
} {
  switch (outcome.kind) {
    case "started":
      return { message: "Started this space on this computer.", intent: "success", durationMs: 3200 };
    case "unavailable":
      return { message: "Use Instafy Desktop to start this space on your computer.", intent: "warning", durationMs: 4500 };
    case "signed_out":
      return { message: "Sign in again to start this space on this computer.", intent: "error", durationMs: 4500 };
    case "failed":
      return { message: `Couldn't start this space on this computer: ${outcome.message}`, intent: "error", durationMs: 5000 };
  }
}

/**
 * Starting a space on this computer from a control, with the outcome as a
 * status: `available` outside Desktop is false, and `starting` is true while
 * this control's start is under way. `start` resolves to whether it started.
 */
export function useStartSpaceOnThisComputer(): {
  available: boolean;
  starting: boolean;
  start: (projectId: string) => Promise<boolean>;
} {
  const { showStatus } = useStatus();
  const [starting, setStarting] = useState(false);
  const start = useCallback(
    async (projectId: string) => {
      setStarting(true);
      try {
        const outcome = await startSpaceOnThisComputer(projectId);
        const status = describeDesktopSpaceStartOutcome(outcome);
        showStatus(status.message, status.intent, status.durationMs);
        return outcome.kind === "started";
      } finally {
        setStarting(false);
      }
    },
    [showStatus],
  );
  return { available: canStartSpaceOnThisComputer(), starting, start };
}
