import { useProject } from "../projects/useProject";
import { useRuntime } from "../runtime/useRuntime";
import type { ControllerOriginSummary } from "../services/originTypes";
import type { VersioningMode } from "../services/runtimeController/workspaceVersioning";
import { useWorkspaceVersioning, type WorkspaceVersioningState } from "./useWorkspaceVersioning";

export interface ActiveWorkspaceVersioning extends WorkspaceVersioningState {
  projectId: string | null;
  /**
   * What the chrome shows (drawer body, nav label, badge source): the probed
   * mode, else the first-paint guess. `legacy` for a space with no origin;
   * while its origin is still loading, the first-paint guess.
   */
  chromeMode: VersioningMode;
  /**
   * The History UI may send requests: a probe answered `stateless` or
   * `desktop` for the current origin. A first-paint guess never routes.
   */
  historyReady: boolean;
}

export function resolveChromeMode(
  state: Pick<WorkspaceVersioningState, "originId" | "resolved" | "mode" | "firstPaintMode"> & {
    /** The controller has not answered for the space's origin yet (a load or a switch). */
    originPending?: boolean;
  },
): VersioningMode {
  if (!state.originId) {
    // While the origin loads, the mode this device last saw for the space
    // holds the chrome, so the nav item keeps one name through a reload. A
    // space the controller says has no origin is legacy.
    return state.originPending ? state.firstPaintMode : "legacy";
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
  return useWorkspaceVersioningForProject({ projectId: activeProjectId, enabled });
}

/**
 * The same, for a surface that is handed its project instead of reading the
 * active one (the chat change card, which also renders outside the project
 * providers). The store's origin is used only when it belongs to that
 * project. Every caller goes through this guard or the hook above, never
 * through `useWorkspaceVersioning` directly.
 */
export function useWorkspaceVersioningForProject({
  projectId: requestedProjectId,
  enabled = true,
}: {
  projectId: string | null | undefined;
  enabled?: boolean;
}): ActiveWorkspaceVersioning {
  const { desktopOrigin, desktopOriginProjectId, desktopOriginAnsweredProjectId } = useRuntime();
  const projectId = requestedProjectId?.trim() || null;
  const state = useWorkspaceVersioning({
    projectId,
    origin: originForProject(projectId, desktopOrigin, desktopOriginProjectId),
    enabled,
  });
  const chromeMode = resolveChromeMode({
    ...state,
    originPending: projectId !== null && desktopOriginAnsweredProjectId !== projectId,
  });
  return {
    ...state,
    projectId,
    chromeMode,
    historyReady: state.resolved && state.originId !== null && isHistoryMode(state.mode),
  };
}
