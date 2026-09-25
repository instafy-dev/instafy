/**
 * Projects whose hosted machine was deliberately paused for inactivity.
 *
 * The state-driven auto-ensure would otherwise see "no ready runtime" and
 * relaunch the machine ~10 seconds after every idle stop, turning the pause
 * into a stop/restart billing loop for any open tab. A pause holds until a
 * genuine user interaction (or an explicit start) clears it.
 */
export const IDLE_PAUSE_CLEARED_EVENT = "instafy:idle-pause-cleared";

/**
 * Projects whose hosted machine the user stopped on purpose.
 *
 * Unlike the idle pause, a manual stop must survive pointer and keyboard
 * activity: the user is still working in the tab, they just do not want the
 * machine back. The hold lifts only on an explicit start, reconnect or send.
 */
export const MANUAL_STOP_CHANGED_EVENT = "instafy:manual-stop-changed";

const paused = new Set<string>();
const manualStops = new Set<string>();
/**
 * Spaces that startup reopened from memory rather than the person choosing
 * them. On a plan with one hosted machine, starting that machine at sign-in
 * took the only slot before the person had done anything there, and the
 * space they actually went on to use then waited behind it. The hold lifts on
 * the first intent in that space (the composer, a send, an explicit Start),
 * and nothing else about auto-start changes.
 */
const restoredAwaitingIntent = new Set<string>();

function dispatchProjectEvent(eventName: string, projectId: string) {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(eventName, { detail: { projectId } }));
  }
}

export function markIdlePaused(projectId: string) {
  if (projectId) {
    paused.add(projectId);
  }
}

export function clearIdlePaused(projectId: string | null | undefined) {
  if (!projectId || !paused.delete(projectId)) {
    return;
  }
  dispatchProjectEvent(IDLE_PAUSE_CLEARED_EVENT, projectId);
}

export function isIdlePaused(projectId: string | null | undefined): boolean {
  return Boolean(projectId && paused.has(projectId));
}

export function markManualStop(projectId: string | null | undefined) {
  if (!projectId || manualStops.has(projectId)) {
    return;
  }
  manualStops.add(projectId);
  dispatchProjectEvent(MANUAL_STOP_CHANGED_EVENT, projectId);
}

export function clearManualStop(projectId: string | null | undefined) {
  if (!projectId || !manualStops.delete(projectId)) {
    return;
  }
  dispatchProjectEvent(MANUAL_STOP_CHANGED_EVENT, projectId);
}

export function isManualStopHeld(projectId: string | null | undefined): boolean {
  return Boolean(projectId && manualStops.has(projectId));
}

export function markRestoredAwaitingIntent(projectId: string | null | undefined) {
  if (projectId) {
    restoredAwaitingIntent.add(projectId);
  }
}

export function clearRestoredAwaitingIntent(projectId: string | null | undefined) {
  if (!projectId || !restoredAwaitingIntent.delete(projectId)) {
    return;
  }
  // Same re-evaluation signal as an idle pause lifting: the auto-start
  // effects listen for it and run again.
  dispatchProjectEvent(IDLE_PAUSE_CLEARED_EVENT, projectId);
}

export function isRestoredAwaitingIntent(projectId: string | null | undefined): boolean {
  return Boolean(projectId && restoredAwaitingIntent.has(projectId));
}

/** True when any deliberate hold says the machine must not be relaunched. */
export function isAutoEnsureHeld(projectId: string | null | undefined): boolean {
  return isIdlePaused(projectId) || isManualStopHeld(projectId) || isRestoredAwaitingIntent(projectId);
}
