import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import type { ControllerOriginSummary } from "../services/originTypes";
import {
  getCachedWorkspaceVersioning,
  probeWorkspaceVersioning,
  readLastVersioningMode,
  subscribeWorkspaceVersioning,
  versioningOriginMode,
  type OriginVersioning,
  type RecoverySupport,
  type VersioningMode,
  type VersioningOriginMode,
} from "../services/runtimeController/workspaceVersioning";

const CONTROLLER_STREAM_RECONNECTED_EVENT = "instafy:controller-stream-reconnected";

export interface UseWorkspaceVersioningInput {
  projectId: string | null | undefined;
  /** The controller's default-origin summary (`runtimeStore.desktopOrigin`). */
  origin: Pick<ControllerOriginSummary, "originId" | "mode"> | null | undefined;
  /** Set false to stop probing (for example while the project is not ready). */
  enabled?: boolean;
}

export interface WorkspaceVersioningState {
  /**
   * The probed mode. `legacy` until a probe answers (unknown is legacy), so
   * routing and write decisions can rely on it.
   */
  mode: VersioningMode;
  /** A probe result for the current origin is known. */
  resolved: boolean;
  /**
   * For first paint only: the probed mode, or the mode the summary implies,
   * or the last mode seen for this project. Never use it to route a request.
   */
  firstPaintMode: VersioningMode;
  originId: string | null;
  originMode: VersioningOriginMode;
  stateless: boolean;
  recovery: RecoverySupport;
  checkedAt: number | null;
  /** Probe again now, ignoring the cache (the History drawer opening). */
  refresh: () => Promise<OriginVersioning | null>;
}

/**
 * How the active project's default origin keeps versions (`legacy`,
 * `stateless` or `desktop`). Probes on mount and when the project or origin
 * changes, again on focus or a controller stream reconnect when the result is
 * older than 60 s, and at once when a response contradicts it. Instances
 * share one cache, so mounting the hook in several places costs one probe.
 */
export function useWorkspaceVersioning({
  projectId,
  origin,
  enabled = true,
}: UseWorkspaceVersioningInput): WorkspaceVersioningState {
  const projectKey = projectId?.trim() || null;
  const originId = origin?.originId?.trim() || null;
  const originModeRaw = origin?.mode ?? null;
  const originMode = versioningOriginMode(originModeRaw);
  const active = enabled && projectKey !== null && originId !== null;

  const getSnapshot = useCallback(
    () => getCachedWorkspaceVersioning(projectKey, originId),
    [projectKey, originId],
  );
  const cached = useSyncExternalStore(subscribeWorkspaceVersioning, getSnapshot, getSnapshot);
  const entry = cached && cached.originMode === originMode ? cached : null;

  const probe = useCallback(
    async (force: boolean): Promise<OriginVersioning | null> => {
      if (!active || !projectKey || !originId) {
        return null;
      }
      try {
        return await probeWorkspaceVersioning({
          projectId: projectKey,
          origin: { originId, mode: originModeRaw ?? "unknown" },
          force,
        });
      } catch (error) {
        console.warn("[workspace-versioning] probe failed:", error);
        return null;
      }
    },
    [active, projectKey, originId, originModeRaw],
  );

  // Mount, project change, origin change: a fresh shared result is reused.
  useEffect(() => {
    void probe(false);
  }, [probe]);

  // A response contradicted the cached mode: probe again at once.
  const stale = entry?.stale === true;
  useEffect(() => {
    if (stale) {
      void probe(true);
    }
  }, [stale, probe]);

  // Focus and stream reconnects re-check results older than 60 s.
  useEffect(() => {
    if (!active || typeof window === "undefined") {
      return undefined;
    }
    const wake = () => {
      void probe(false);
    };
    window.addEventListener("focus", wake);
    window.addEventListener(CONTROLLER_STREAM_RECONNECTED_EVENT, wake);
    return () => {
      window.removeEventListener("focus", wake);
      window.removeEventListener(CONTROLLER_STREAM_RECONNECTED_EVENT, wake);
    };
  }, [active, probe]);

  const refresh = useCallback(() => probe(true), [probe]);
  const storedGuess = useMemo(() => readLastVersioningMode(projectKey), [projectKey]);
  const impliedMode: VersioningMode | null =
    originMode === "desktop" || originMode === "efs" ? "desktop" : null;

  return {
    mode: entry?.mode ?? "legacy",
    resolved: entry !== null,
    firstPaintMode: entry?.mode ?? impliedMode ?? storedGuess ?? "legacy",
    originId,
    originMode,
    stateless: entry?.stateless ?? false,
    recovery: entry?.recovery ?? "unknown",
    checkedAt: entry?.checkedAt ?? null,
    refresh,
  };
}
