/**
 * Projects whose hosted machine was deliberately paused for inactivity.
 *
 * The state-driven auto-ensure would otherwise see "no ready runtime" and
 * relaunch the machine ~10 seconds after every idle stop, turning the pause
 * into a stop/restart billing loop for any open tab. A pause holds until a
 * genuine user interaction (or an explicit start) clears it.
 */
export const IDLE_PAUSE_CLEARED_EVENT = "instafy:idle-pause-cleared";

const paused = new Set<string>();

export function markIdlePaused(projectId: string) {
  if (projectId) {
    paused.add(projectId);
  }
}

export function clearIdlePaused(projectId: string | null | undefined) {
  if (!projectId || !paused.delete(projectId)) {
    return;
  }
  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent(IDLE_PAUSE_CLEARED_EVENT, { detail: { projectId } }),
    );
  }
}

export function isIdlePaused(projectId: string | null | undefined): boolean {
  return Boolean(projectId && paused.has(projectId));
}
