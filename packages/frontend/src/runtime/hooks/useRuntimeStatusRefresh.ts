import { useCallback, useEffect, useRef, useState, type Dispatch, type MutableRefObject } from "react";
import type { RuntimeAction } from "../runtimeStore";
import type { RuntimeState } from "../../types";
import { controllerClient, type ControllerRuntimeStatusEntry } from "../../sdk/instafy";
import { clearProjectState } from "../../workspace/projectClear";
import { recordRuntimeResourceSample } from "../runtimeResourceHistory";

const runtimeControllerEnabled = controllerClient.core.enabled;

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
  }>({ projectId: null, at: 0 });
  const runtimeStatusAbortRef = useRef<AbortController | null>(null);
  const [runtimeStatusesResolved, setRuntimeStatusesResolved] = useState(false);

  useEffect(
    () => () => {
      runtimeStatusAbortRef.current?.abort();
    },
    [],
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
        Date.now() - lastFailure.at < 5000
      ) {
        debugLog("runtime-status:skip-backoff", { projectId: effectiveProjectId });
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
        lastRuntimeStatusFailureRef.current = { projectId: null, at: 0 };
      } else {
        dispatch({
          type: "setRuntimeStatuses",
          statuses: [],
          preferredRuntimeId: null,
        });
        lastRuntimeStatusFailureRef.current = {
          projectId: effectiveProjectId,
          at: Date.now(),
        };
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
    debugLog,
    dispatch,
    lastPreferredRuntimeIdRef,
    markControllerUnavailable,
    preferenceClearRequestedRef,
    projectReadyForRuntime,
    resolveProjectId,
    updateRuntime,
  ]);

  return {
    runtimeStatusesResolved,
    setRuntimeStatusesResolved,
    markControllerUnavailable,
    resolveProjectId,
    refreshRuntimeStatuses,
  };
}
