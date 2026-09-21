import { useCallback, useEffect, useRef, useState } from "react";
import { useGatedInterval } from "../runtime/pollingGate";
import { controllerClient } from "../sdk/instafy";

/**
 * The sidebar's "N uncommitted changes" badge.
 *
 * The badge used to poll git status every 15 s for as long as the studio was
 * open. It is now driven by the controller stream: `workspace.file_changed`
 * and `workspace.commit` both arrive as `instafy:workspace-change`, so a burst
 * of edits becomes one request after a short trailing debounce. Commits keep
 * their own non-silent refresh, a stream reconnect and window focus refresh
 * once, and a slow gated fallback covers hosted runtimes, which only publish
 * file changes at commit time. After a failed fetch the fallback stays quiet
 * until the next event, project or runtime change, which replaces the old
 * 60 s backoff.
 */
export const GIT_STATUS_CHANGE_DEBOUNCE_MS = 750;
export const GIT_STATUS_FALLBACK_INTERVAL_MS = 120_000;

export const WORKSPACE_CHANGE_EVENT = "instafy:workspace-change";
export const WORKSPACE_COMMIT_EVENT = "instafy:workspace-commit";
export const CONTROLLER_STREAM_RECONNECTED_EVENT = "instafy:controller-stream-reconnected";

export interface StudioGitStatusBadgeInput {
  activeProjectId: string | null;
  controllerProjectMissing: boolean;
  projectReadyForWorkspace: boolean;
  effectiveRuntimeId: string | null | undefined;
  runtimeReady: boolean;
}

export interface StudioGitStatusBadge {
  gitDirtyCount: number;
  gitSupported: boolean;
  refreshGitStatus: (options?: { silent?: boolean }) => Promise<boolean>;
}

function eventTargetsProject(event: Event, activeProjectId: string): boolean {
  const custom = event as CustomEvent<{ projectId?: string | null }>;
  const projectIdFromEvent =
    custom.detail && typeof custom.detail.projectId === "string" ? custom.detail.projectId : null;
  return !projectIdFromEvent || projectIdFromEvent === activeProjectId;
}

export function useStudioGitStatusBadge({
  activeProjectId,
  controllerProjectMissing,
  projectReadyForWorkspace,
  effectiveRuntimeId,
  runtimeReady,
}: StudioGitStatusBadgeInput): StudioGitStatusBadge {
  const [gitDirtyCount, setGitDirtyCount] = useState(0);
  const [gitSupported, setGitSupported] = useState(false);
  const epochRef = useRef(0);
  // A refresh that is already on the wire. Wake-style triggers (focus, the
  // gate's wake run, reconnect, the fallback tick) join it instead of
  // starting a second request in the same instant.
  const inflightRef = useRef<Promise<boolean> | null>(null);
  // Set after a failed fetch so the fallback timer stops retrying a runtime
  // that is not there; cleared by any event-driven refresh.
  const fallbackSuppressedRef = useRef(false);

  const enabled = Boolean(activeProjectId) && !controllerProjectMissing && projectReadyForWorkspace;

  useEffect(() => {
    epochRef.current += 1;
  }, [activeProjectId, controllerProjectMissing, effectiveRuntimeId, projectReadyForWorkspace, runtimeReady]);

  const refreshGitStatus = useCallback(
    async (options?: { silent?: boolean }): Promise<boolean> => {
      const epoch = epochRef.current;
      if (!activeProjectId || controllerProjectMissing || !projectReadyForWorkspace) {
        if (!options?.silent) {
          setGitDirtyCount(0);
          setGitSupported(false);
        }
        return false;
      }
      const result = await controllerClient.workspace.git
        .fetchStatus({
          projectId: activeProjectId,
          runtimeId: effectiveRuntimeId ?? null,
          limit: 1,
        })
        .catch(() => null);

      if (epochRef.current !== epoch) {
        return false;
      }

      if (!result) {
        fallbackSuppressedRef.current = true;
        if (!options?.silent) {
          setGitDirtyCount(0);
          setGitSupported(false);
        }
        return false;
      }
      fallbackSuppressedRef.current = false;
      setGitSupported(result.supported);
      const count = result.supported
        ? Math.max(0, typeof result.dirtyCount === "number" ? result.dirtyCount : result.dirtyPaths.length)
        : 0;
      setGitDirtyCount(count);
      return true;
    },
    [activeProjectId, controllerProjectMissing, effectiveRuntimeId, projectReadyForWorkspace],
  );

  const refreshGitStatusRef = useRef(refreshGitStatus);
  refreshGitStatusRef.current = refreshGitStatus;

  const joinSilentRefresh = useCallback((): Promise<boolean> => {
    if (inflightRef.current) {
      return inflightRef.current;
    }
    const request = refreshGitStatusRef.current({ silent: true }).finally(() => {
      if (inflightRef.current === request) {
        inflightRef.current = null;
      }
    });
    inflightRef.current = request;
    return request;
  }, []);

  useEffect(() => {
    setGitDirtyCount(0);
    setGitSupported(false);
  }, [activeProjectId]);

  // One fetch when the project becomes ready, and again when the runtime it
  // reads from changes or comes online.
  useEffect(() => {
    if (!enabled) {
      return;
    }
    fallbackSuppressedRef.current = false;
    void refreshGitStatus({ silent: true });
  }, [enabled, refreshGitStatus, runtimeReady]);

  useEffect(() => {
    if (!enabled || !activeProjectId || typeof window === "undefined") {
      return;
    }
    let debounce: number | null = null;
    const cancelDebounce = () => {
      if (debounce !== null) {
        window.clearTimeout(debounce);
        debounce = null;
      }
    };
    const handleWorkspaceChange = (event: Event) => {
      if (!eventTargetsProject(event, activeProjectId)) {
        return;
      }
      cancelDebounce();
      debounce = window.setTimeout(() => {
        debounce = null;
        fallbackSuppressedRef.current = false;
        void refreshGitStatusRef.current({ silent: true });
      }, GIT_STATUS_CHANGE_DEBOUNCE_MS);
    };
    const handleWorkspaceCommit = (event: Event) => {
      if (!eventTargetsProject(event, activeProjectId)) {
        return;
      }
      cancelDebounce();
      fallbackSuppressedRef.current = false;
      void refreshGitStatusRef.current({ silent: false });
    };
    const handleWake = () => {
      fallbackSuppressedRef.current = false;
      void joinSilentRefresh();
    };
    window.addEventListener(WORKSPACE_CHANGE_EVENT, handleWorkspaceChange);
    window.addEventListener(WORKSPACE_COMMIT_EVENT, handleWorkspaceCommit);
    window.addEventListener(CONTROLLER_STREAM_RECONNECTED_EVENT, handleWake);
    window.addEventListener("focus", handleWake);
    return () => {
      cancelDebounce();
      window.removeEventListener(WORKSPACE_CHANGE_EVENT, handleWorkspaceChange);
      window.removeEventListener(WORKSPACE_COMMIT_EVENT, handleWorkspaceCommit);
      window.removeEventListener(CONTROLLER_STREAM_RECONNECTED_EVENT, handleWake);
      window.removeEventListener("focus", handleWake);
    };
  }, [activeProjectId, enabled, joinSilentRefresh]);

  // Slow fallback for runtimes that never publish file changes. The gate
  // also runs this once when the tab becomes visible or the user returns
  // after being idle, which covers the visibility wake path.
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  useGatedInterval(() => {
    if (!enabledRef.current || fallbackSuppressedRef.current) {
      return;
    }
    void joinSilentRefresh();
  }, GIT_STATUS_FALLBACK_INTERVAL_MS);

  return { gitDirtyCount, gitSupported, refreshGitStatus };
}
