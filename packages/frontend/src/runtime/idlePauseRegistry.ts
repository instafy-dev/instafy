import type { RuntimeStopFlush } from "../services/runtimeController/runtimes";

/**
 * Projects whose hosted machine was deliberately paused for inactivity.
 *
 * The state-driven auto-ensure would otherwise see "no ready runtime" and
 * relaunch the machine ~10 seconds after every idle stop, turning the pause
 * into a stop/restart billing loop for any open tab. A pause holds until the
 * person writes in or clicks into the composer, sends, or starts the machine.
 */
export const IDLE_PAUSE_CLEARED_EVENT = "instafy:idle-pause-cleared";

/**
 * Projects whose hosted machine the user stopped on purpose.
 *
 * Unlike the idle pause, a manual stop must survive typing in the composer:
 * the user is still working in the tab, they just do not want the machine
 * back. The hold lifts only on an explicit start, reconnect or send.
 */
export const MANUAL_STOP_CHANGED_EVENT = "instafy:manual-stop-changed";

/** The Stop behind a manual hold. */
export interface ManualStopHold {
  /** When the latest Stop that left no machine was made, on this tab's clock. */
  readonly at: number;
  /** What that stop did to keep the workspace's work, once it answered. */
  flush: RuntimeStopFlush | null;
}

const paused = new Set<string>();
const manualStops = new Map<string, ManualStopHold>();
/**
 * Spaces whose machine waits for the person to ask for it. Every time a space
 * becomes the active one (startup, a switch, a link, a Machines deep link) it
 * is marked here: opening a space is not a request for its machine. On a plan
 * with one hosted machine an automatic start took the only slot, from another
 * space when that one looked idle, before the person had done anything. The
 * hold lifts on the first intent in that space (writing in or clicking into
 * the composer, a send, an explicit Start), and nothing else about auto-start
 * changes.
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

/**
 * Holds the space after a Stop and returns the hold. A hold already set is
 * stamped again without a change event: it may be left over from an earlier
 * Stop when a machine came back without asking through this tab (a Desktop
 * runtime, another tab), and this Stop is the one that cut off what runs now.
 */
export function markManualStop(projectId: string | null | undefined): ManualStopHold | null {
  if (!projectId) {
    return null;
  }
  const held = manualStops.has(projectId);
  const hold: ManualStopHold = { at: Date.now(), flush: null };
  manualStops.set(projectId, hold);
  if (!held) {
    dispatchProjectEvent(MANUAL_STOP_CHANGED_EVENT, projectId);
  }
  return hold;
}

/**
 * The stop's answer for the hold it set. Nothing once the hold was lifted or
 * a later Stop stamped it again.
 */
export function recordManualStopFlush(
  projectId: string | null | undefined,
  hold: ManualStopHold | null,
  flush: RuntimeStopFlush | null,
) {
  if (!projectId || !hold || manualStops.get(projectId) !== hold) {
    return;
  }
  hold.flush = flush;
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

export function manualStopHold(projectId: string | null | undefined): ManualStopHold | null {
  return (projectId && manualStops.get(projectId)) || null;
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
