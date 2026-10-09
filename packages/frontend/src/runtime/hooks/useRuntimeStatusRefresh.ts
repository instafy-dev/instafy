import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type Dispatch,
  type MutableRefObject,
} from "react";
import type { RuntimeAction } from "../runtimeStore";
import type { RuntimeState } from "../../types";
import { controllerClient, type ControllerRuntimeStatusEntry } from "../../sdk/instafy";
import { clearProjectState } from "../../workspace/projectClear";
import { recordRuntimeResourceSample } from "../runtimeResourceHistory";

const runtimeControllerEnabled = controllerClient.core.enabled;

/** No status request is sent this long after one fails. */
const STATUS_FAILURE_BACKOFF_MS = 5_000;
/** A failed request is retried after the backoff, doubling with each failure in a row up to this. */
const STATUS_RETRY_MAX_MS = 60_000;

/**
 * The runtime status of one project, as the controller last answered it. A
 * failed, skipped or not-yet-sent request leaves the previous answer in
 * place; a project switch clears it.
 */
export interface RuntimeStatusAnswer {
  projectId: string;
  statuses: readonly ControllerRuntimeStatusEntry[];
}

interface UseRuntimeStatusRefreshArgs {
  activeProjectId: string | null;
  projectReadyForRuntime: boolean;
  dispatch: Dispatch<RuntimeAction>;
  updateRuntime: (updater: (current: RuntimeState) => RuntimeState) => void;
  debugLog: (message: string, data?: unknown) => void;
  bumpControllerSyncEpoch: () => void;
  lastPreferredRuntimeIdRef: MutableRefObject<string | null>;
  preferenceClearRequestedRef: MutableRefObject<boolean>;
  allowPreferenceMutation: boolean;
}

export function useRuntimeStatusRefresh({
  activeProjectId,
  projectReadyForRuntime,
  dispatch,
  updateRuntime,
  debugLog,
  bumpControllerSyncEpoch,
  lastPreferredRuntimeIdRef,
  preferenceClearRequestedRef,
  allowPreferenceMutation,
}: UseRuntimeStatusRefreshArgs) {
  const lastRuntimeStatusFailureRef = useRef<{
    projectId: string | null;
    at: number;
    failures: number;
  }>({ projectId: null, at: 0, failures: 0 });
  const runtimeStatusAbortRef = useRef<AbortController | null>(null);
  // After a failed request one refresh stays scheduled until a request
  // succeeds (a space switch or unmount drops it): a runtime's stop asks for
  // a single refresh, which may fail or fall in the backoff. A refresh the
  // backoff skips brings it forward to the backoff's end.
  const scheduledRefreshRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refreshRuntimeStatusesRef = useRef<() => Promise<void>>(async () => {});
  const [runtimeStatusesResolved, setRuntimeStatusesResolved] = useState(false);
  // `runtimeStatuses` also reads [] after a failure, a skip or a switch, so
  // a reader that must tell "nothing runs" from "not known" uses this.
  const answerProjectId = activeProjectId?.trim() || null;
  const answerProjectIdRef = useRef(answerProjectId);
  const [runtimeStatusAnswer, setRuntimeStatusAnswer] = useState<RuntimeStatusAnswer | null>(null);

  const cancelScheduledRefresh = useCallback(() => {
    if (scheduledRefreshRef.current !== null) {
      clearTimeout(scheduledRefreshRef.current);
      scheduledRefreshRef.current = null;
    }
  }, []);

  const scheduleRefresh = useCallback(
    (at: number) => {
      cancelScheduledRefresh();
      scheduledRefreshRef.current = setTimeout(() => {
        scheduledRefreshRef.current = null;
        void refreshRuntimeStatusesRef.current();
      }, Math.max(0, at - Date.now()));
    },
    [cancelScheduledRefresh],
  );

  useLayoutEffect(() => {
    if (answerProjectIdRef.current === answerProjectId) {
      return;
    }
    answerProjectIdRef.current = answerProjectId;
    cancelScheduledRefresh();
    setRuntimeStatusAnswer(null);
  }, [answerProjectId, cancelScheduledRefresh]);

  useEffect(
    () => () => {
      runtimeStatusAbortRef.current?.abort();
      cancelScheduledRefresh();
    },
    [cancelScheduledRefresh],
  );

  const markControllerUnavailable = useCallback(() => {
    let changed = false;
    updateRuntime((current) => {
      const next = {
        ...current,
        controllerReady: false,
        controllerUnavailable: true,
        controllerStreamDisconnected: false,
        controllerStreamDisconnectMessage: null,
      };
      if (
        !current.controllerReady &&
        current.controllerUnavailable &&
        !current.controllerStreamDisconnected &&
        current.controllerStreamDisconnectMessage === null
      ) {
        return current;
      }
      changed = true;
      return next;
    });
    if (!changed) {
      return;
    }
    dispatch({
      type: "setRuntimeStatuses",
      statuses: [],
      preferredRuntimeId: null,
    });
    lastPreferredRuntimeIdRef.current = null;
    setRuntimeStatusesResolved(true);
    bumpControllerSyncEpoch();
  }, [
    bumpControllerSyncEpoch,
    dispatch,
    lastPreferredRuntimeIdRef,
    updateRuntime,
  ]);

  const resolveProjectId = useCallback((): string | null => {
    if (activeProjectId && activeProjectId.trim().length > 0) {
      return activeProjectId.trim();
    }
    if (typeof window !== "undefined") {
      const runtimeWindow = window as typeof window & {
        __INSTAFY_ACTIVE_PROJECT_ID__?: string | null;
        __INSTAFY_STORE__?: {
          getState?: () => { activeProjectId?: string | null } & Record<string, unknown>;
        };
      };
      const fromWindow = runtimeWindow.__INSTAFY_ACTIVE_PROJECT_ID__;
      if (fromWindow && fromWindow.trim().length > 0) {
        return fromWindow.trim();
      }
      const storeProjectId =
        runtimeWindow.__INSTAFY_STORE__?.getState?.()?.activeProjectId ?? null;
      if (typeof storeProjectId === "string" && storeProjectId.trim().length > 0) {
        return storeProjectId.trim();
      }
    }
    return null;
  }, [activeProjectId]);

  const refreshRuntimeStatuses = useCallback(async () => {
    runtimeStatusAbortRef.current?.abort();
    const abortController = new AbortController();
    runtimeStatusAbortRef.current = abortController;
    const effectiveProjectId = resolveProjectId();
    if (!runtimeControllerEnabled || !effectiveProjectId || !projectReadyForRuntime) {
      dispatch({
        type: "setRuntimeStatuses",
        statuses: [],
        preferredRuntimeId: null,
      });
      lastPreferredRuntimeIdRef.current = null;
      preferenceClearRequestedRef.current = false;
      setRuntimeStatusesResolved(true);
      debugLog("runtime-status:skip", {
        controllerEnabled: runtimeControllerEnabled,
        activeProjectId: effectiveProjectId ?? null,
        projectReadyForRuntime,
      });
      runtimeStatusAbortRef.current = null;
      return;
    }
    try {
      debugLog("runtime-status:start", {
        projectId: effectiveProjectId,
      });
      const lastFailure = lastRuntimeStatusFailureRef.current;
      if (
        lastFailure.projectId === effectiveProjectId &&
        Date.now() - lastFailure.at < STATUS_FAILURE_BACKOFF_MS
      ) {
        debugLog("runtime-status:skip-backoff", { projectId: effectiveProjectId });
        scheduleRefresh(lastFailure.at + STATUS_FAILURE_BACKOFF_MS);
        setRuntimeStatusesResolved(true);
        runtimeStatusAbortRef.current = null;
        return;
      }
      const result = await controllerClient.runtimes.fetchStatus({
        projectId: effectiveProjectId,
        signal: abortController.signal,
        quietOnAbort: true,
      });
      if (abortController.signal.aborted) {
        return;
      }
      if (result) {
        const rawStatuses = Array.isArray(result.runtimes)
          ? (result.runtimes.filter(Boolean) as ControllerRuntimeStatusEntry[])
          : [];
        const availableRuntimeIds = new Set(
          rawStatuses
            .map((entry) => entry.runtimeId)
            .filter((runtimeId): runtimeId is string => Boolean(runtimeId)),
        );
        const normalizedPreferred =
          typeof result.preferredRuntimeId === "string" &&
          result.preferredRuntimeId.trim().length > 0
            ? result.preferredRuntimeId.trim()
            : null;
        let effectivePreferred = normalizedPreferred;
        if (effectivePreferred && !availableRuntimeIds.has(effectivePreferred)) {
          effectivePreferred = null;
          if (allowPreferenceMutation) {
            preferenceClearRequestedRef.current = true;
            void controllerClient.runtimes.setPreference({
              projectId: effectiveProjectId,
              runtimeId: null,
            }).catch((error) => {
              if (import.meta.env.DEV) {
                console.warn("[runtime] failed to clear stale preferred runtime", error);
              }
            });
          }
        }
        // Record BEFORE dispatching so the render this dispatch triggers
        // already sees the samples it delivered (the runtime menu reads the
        // history during render).
        for (const entry of rawStatuses) {
          recordRuntimeResourceSample(entry.runtimeId, entry.resources ?? null);
        }
        dispatch({
          type: "setRuntimeStatuses",
          statuses: rawStatuses,
          preferredRuntimeId: effectivePreferred,
        });
        lastPreferredRuntimeIdRef.current = effectivePreferred;
        preferenceClearRequestedRef.current = false;
        // An answer that lands after a switch belongs to the project left.
        if (answerProjectIdRef.current === effectiveProjectId) {
          setRuntimeStatusAnswer({ projectId: effectiveProjectId, statuses: rawStatuses });
        }
        debugLog("runtime-status:success", {
          projectId: effectiveProjectId,
          count: rawStatuses.length,
          preferredRuntimeId: effectivePreferred,
          statuses: rawStatuses.map((s) => ({
            id: s.runtimeId,
            status: s.status,
            health: s.health,
            provider: s.provider,
          })),
        });
        lastRuntimeStatusFailureRef.current = { projectId: null, at: 0, failures: 0 };
        cancelScheduledRefresh();
      } else {
        dispatch({
          type: "setRuntimeStatuses",
          statuses: [],
          preferredRuntimeId: null,
        });
        const previous = lastRuntimeStatusFailureRef.current;
        const failures = previous.projectId === effectiveProjectId ? previous.failures + 1 : 1;
        const at = Date.now();
        lastRuntimeStatusFailureRef.current = { projectId: effectiveProjectId, at, failures };
        scheduleRefresh(
          at + Math.min(STATUS_FAILURE_BACKOFF_MS * 2 ** (failures - 1), STATUS_RETRY_MAX_MS),
        );
        lastPreferredRuntimeIdRef.current = null;
        preferenceClearRequestedRef.current = false;
      }
      setRuntimeStatusesResolved(true);
    } catch (error) {
      if (import.meta.env.DEV) {
        console.warn("refreshRuntimeStatuses failed", error);
      }
      const message =
        error instanceof Error ? error.message : String(error ?? "unknown");
      debugLog("runtime-status:error", {
        projectId: activeProjectId,
        resolvedProjectId: effectiveProjectId,
        message,
      });
      if (message.includes("403") || message.includes("401")) {
        clearProjectState({ resetWorkspace: false });
        dispatch({ type: "setLocalWorkspace", workspace: null });
        dispatch({
          type: "applyOriginSummary",
          summary: null,
          derivedPresence: null,
        });
        dispatch({
          type: "setRuntimeStatuses",
          statuses: [],
          preferredRuntimeId: null,
        });
        updateRuntime((current) => ({
          ...current,
          controllerReady: false,
          controllerProjectMissing: true,
          controllerUnavailable: false,
        }));
        setRuntimeStatusesResolved(true);
        return;
      }
      markControllerUnavailable();
      setRuntimeStatusesResolved(true);
    } finally {
      if (runtimeStatusAbortRef.current === abortController) {
        runtimeStatusAbortRef.current = null;
      }
    }
  }, [
    activeProjectId,
    allowPreferenceMutation,
    cancelScheduledRefresh,
    debugLog,
    dispatch,
    lastPreferredRuntimeIdRef,
    markControllerUnavailable,
    preferenceClearRequestedRef,
    projectReadyForRuntime,
    resolveProjectId,
    scheduleRefresh,
    updateRuntime,
  ]);

  useLayoutEffect(() => {
    refreshRuntimeStatusesRef.current = refreshRuntimeStatuses;
  }, [refreshRuntimeStatuses]);

  return {
    runtimeStatusesResolved,
    setRuntimeStatusesResolved,
    runtimeStatusAnswer,
    markControllerUnavailable,
    resolveProjectId,
    refreshRuntimeStatuses,
  };
}
