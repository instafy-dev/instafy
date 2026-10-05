import { useProject } from "../projects/useProject";
import { useRuntime } from "../runtime/useRuntime";
import type { ControllerOriginSummary } from "../services/originTypes";
import type { VersioningMode } from "../services/runtimeController/workspaceVersioning";
import { useWorkspaceVersioning, type WorkspaceVersioningState } from "./useWorkspaceVersioning";

export interface ActiveWorkspaceVersioning extends WorkspaceVersioningState {
  projectId: string | null;
  /**
   * What the chrome shows (drawer body, nav label, badge source): the probed
   * mode, else the first-paint guess. Always `legacy` without an origin.
   */
  chromeMode: VersioningMode;
  /**
   * The History UI may send requests: a probe answered `stateless` or
   * `desktop` for the current origin. A first-paint guess never routes.
   */
  historyReady: boolean;
}

export function resolveChromeMode(
  state: Pick<WorkspaceVersioningState, "originId" | "resolved" | "mode" | "firstPaintMode">,
): VersioningMode {
  if (!state.originId) {
    return "legacy";
  }
  return state.resolved ? state.mode : state.firstPaintMode;
}

export function isHistoryMode(mode: VersioningMode): boolean {
  return mode === "stateless" || mode === "desktop";
}

/** The nav label and drawer title: "Changes" in legacy and while unknown. */
export function sourceControlTitle(mode: VersioningMode): "History" | "Changes" {
  return isHistoryMode(mode) ? "History" : "Changes";
}

/**
 * The origin summary only when it belongs to `projectId`. Right after a
 * project switch the store still holds the previous project's summary for a
 * commit; pairing it with the new project would probe (and remember a mode
 * for) the wrong space. An unknown owner keeps the summary.
 */
export function originForProject(
  projectId: string | null,
  origin: ControllerOriginSummary | null | undefined,
  originProjectId: string | null | undefined,
): ControllerOriginSummary | null {
  if (!origin) {
    return null;
  }
  if (originProjectId && projectId && originProjectId !== projectId) {
    return null;
  }
  return origin;
}

/**
 * The versioning mode of the active project's default origin
 * (`runtimeStore.desktopOrigin`). Instances share the probe cache, so
 * mounting this in several places costs one probe.
 */
export function useActiveWorkspaceVersioning({
  enabled = true,
}: { enabled?: boolean } = {}): ActiveWorkspaceVersioning {
  const { activeProjectId } = useProject();
  const { desktopOrigin, desktopOriginProjectId } = useRuntime();
  const projectId = activeProjectId?.trim() || null;
  const state = useWorkspaceVersioning({
    projectId,
    origin: originForProject(projectId, desktopOrigin, desktopOriginProjectId),
    enabled,
  });
  const chromeMode = resolveChromeMode(state);
  return {
    ...state,
    projectId,
    chromeMode,
    historyReady: state.resolved && state.originId !== null && isHistoryMode(state.mode),
  };
}
