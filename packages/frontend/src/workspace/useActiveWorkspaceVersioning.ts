import { useProject } from "../projects/useProject";
import { useRuntime } from "../runtime/useRuntime";
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

/**
 * The versioning mode of the active project's default origin
 * (`runtimeStore.desktopOrigin`). Instances share the probe cache, so
 * mounting this in several places costs one probe.
 */
export function useActiveWorkspaceVersioning({
  enabled = true,
}: { enabled?: boolean } = {}): ActiveWorkspaceVersioning {
  const { activeProjectId } = useProject();
  const { desktopOrigin } = useRuntime();
  const projectId = activeProjectId?.trim() || null;
  const state = useWorkspaceVersioning({
    projectId,
    origin: desktopOrigin ?? null,
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
