import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { RunRecord, RuntimeState } from "../types";
import {
  type ControllerConversationMessage,
  type ControllerRuntimeStatusEntry,
  type ControllerTunnelGrant,
  type LocalWorkspacePresence,
  controllerClient,
} from "../sdk/instafy";
import { useProject } from "../projects/useProject";
import { useStatus } from "../status/useStatus";
import { useTelemetry } from "../telemetry/useTelemetry";
import { cloneRuntimeState } from "./defaults";
import { useDesktopRuntimeEnsure } from "./hooks/useDesktopRuntimeEnsure";
import { useHostedRuntimeEnsure } from "./hooks/useHostedRuntimeEnsure";
import { useHostedRuntimePolicy } from "./hooks/useHostedRuntimePolicy";
import { useRuntimeControllerSync } from "./hooks/useRuntimeControllerSync";
import { useRuntimeStatusRefresh } from "./hooks/useRuntimeStatusRefresh";
import { useRuntimeStatusToasts } from "./hooks/useRuntimeStatusToasts";
import { useRuntimeStateInternal } from "./RuntimeStateProvider";
import { cloneRunsMap } from "./runtimeStore";
import {
  resolveTunnelHostname,
  resolveTunnelUrl,
  tunnelGrantIsActive,
  writeClipboardText,
} from "./runtimeMenuShared";
import type { TunnelCopyMode } from "./components/RuntimeTunnelDetails";
import type { HostedRuntimeLimitErrorDetails } from "./hostedRuntimeLimitError";

const runtimeControllerEnabled = controllerClient.core.enabled;
interface RuntimeOperationsContextValue {
  setPreferredRuntime: (runtimeId: string | null) => Promise<boolean>;
  refreshRuntimeStatuses: () => Promise<void>;
  setSessionRuntimeOverride: (runtimeId: string | null) => void;
  clearSessionRuntimeOverride: () => void;
  effectiveRuntimeId: string | null;
  effectiveRuntimeSource: "session" | "preference" | "auto";
  runtimeReady: boolean;
  waitingForPreferredRuntime: boolean;
  recommendedCloudRuntimeId: string | null;
  shouldPromptCloudFallback: boolean;
  dismissPreferredRuntimePrompt: () => void;
  runtimeEnsureError: string | null;
  runtimeEnsureLimit: HostedRuntimeLimitErrorDetails | null;
  hostedRuntimeEnsuring: boolean;
  hostedRuntimeTakeoverInProgress: boolean;
  ensureHostedRuntime: () => Promise<boolean>;
  takeOverHostedRuntimeLimit: () => Promise<boolean>;
  desktopRuntimeEnsuring: boolean;
  ensureDesktopRuntime: () => Promise<boolean>;
  showDesktopRuntimeHelp: () => void;
  hideDesktopRuntimeHelp: () => void;
  isDesktopRuntimeHelpVisible: boolean;
  copyTunnelDetails: (
    mode: TunnelCopyMode,
    runtimeId?: string | null,
  ) => Promise<boolean>;
  terminateRuntime: (runtimeId: string | null) => Promise<boolean>;
  removeRuntime: (runtimeId: string | null) => Promise<boolean>;
  startRuntime: (runtimeId: string | null) => Promise<boolean>;
}
const RuntimeOperationsContext =
  createContext<RuntimeOperationsContextValue | null>(null);
export function RuntimeOperationsProvider({
  children,
}: {
  children: ReactNode;
}) {
  const { showStatus } = useStatus();
  const { handleRuntimeTelemetryEvent } = useTelemetry();
  const {
    activeProjectId,
    projectInitialized,
    projectAccessPending,
    projectAccessBlocked,
    projectCapabilitiesResolved,
    canWriteProject,
  } = useProject();
  const runtimeMutationEnabled =
    projectCapabilitiesResolved === false ? false : canWriteProject !== false;
  const { state, dispatch, actions } = useRuntimeStateInternal();
  const { updateRuntime, upsertRun, removeRun, markRunLeased } = actions;
  const lastPreferredRuntimeIdRef = useRef<string | null>(
    state.preferredRuntimeId,
  );
  const preferenceClearRequestedRef = useRef(false);
  const [desktopRuntimeHelpVisible, setDesktopRuntimeHelpVisible] =
    useState(false);
  const [runtimeEnsureError, setRuntimeEnsureError] = useState<string | null>(
    null,
  );
  const [runtimeEnsureLimit, setRuntimeEnsureLimit] =
    useState<HostedRuntimeLimitErrorDetails | null>(null);
  const [controllerSyncEpoch, setControllerSyncEpoch] = useState(0);
  const projectAccessResolved = !projectAccessPending && !projectAccessBlocked;
  const projectReadyForRuntime = projectInitialized && projectAccessResolved;
  useEffect(() => {
    if (typeof window !== "undefined") {
      if (!Array.isArray(window.__INSTAFY_RUNTIME_DEBUG__)) {
        window.__INSTAFY_RUNTIME_DEBUG__ = [];
      }
    }
  }, []);
  const debugLog = useCallback((message: string, data?: unknown) => {
    if (typeof window === "undefined") {
      return;
    }
    const bucket =
      window.__INSTAFY_RUNTIME_DEBUG__ ??
      (window.__INSTAFY_RUNTIME_DEBUG__ = []);
    bucket.push({ time: Date.now(), message, data });
    if (bucket.length > 200) {
      bucket.shift();
    }
  }, []);
  const logRunEvent = useCallback((label: string, run: RunRecord) => {
    if (!import.meta.env.DEV) {
      return;
    }
    console.info(`[runtime] ${label}`, {
      id: run.id,
      status: run.status,
      stage: run.progressStage,
      message: run.lastMessage,
    });
  }, []);
  const bumpControllerSyncEpoch = useCallback(() => {
    setControllerSyncEpoch((epoch) => epoch + 1);
  }, []);
  const {
    runtimeStatusesResolved,
    setRuntimeStatusesResolved,
    markControllerUnavailable,
    resolveProjectId,
    refreshRuntimeStatuses,
  } = useRuntimeStatusRefresh({
    activeProjectId,
    projectReadyForRuntime,
    dispatch,
    updateRuntime,
    debugLog,
    bumpControllerSyncEpoch,
    lastPreferredRuntimeIdRef,
    preferenceClearRequestedRef,
    allowPreferenceMutation: runtimeMutationEnabled,
  });
  useRuntimeControllerSync({
    activeProjectId,
    projectInitialized: projectReadyForRuntime,
    runtimeControllerEnabled,
    syncEpoch: controllerSyncEpoch,
    dispatch,
    updateRuntime,
    upsertRun,
    removeRun,
    markRunLeased,
    refreshRuntimeStatuses,
    logRunEvent,
    handleRuntimeTelemetryEvent,
    markControllerUnavailable,
  });
  const setPreferredRuntime = useCallback(
    async (runtimeId: string | null) => {
      if (!runtimeControllerEnabled || !activeProjectId || !runtimeMutationEnabled) {
        return false;
      }
      const clearingPreference = runtimeId === null;
      if (clearingPreference) {
        preferenceClearRequestedRef.current = true;
      }
      try {
        const result = await controllerClient.runtimes.setPreference({
          projectId: activeProjectId,
          runtimeId,
        });
        if (!result) {
          if (!clearingPreference) {
            preferenceClearRequestedRef.current = true;
            const cleared = await controllerClient.runtimes.setPreference({
              projectId: activeProjectId,
              runtimeId: null,
            });
            preferenceClearRequestedRef.current = false;
            if (cleared) {
              await refreshRuntimeStatuses();
              showStatus(
                "Selected runtime is no longer available. Using best available instead.",
                "warning",
                4000,
              );
              return false;
            }
          } else {
            preferenceClearRequestedRef.current = false;
          }
          showStatus("Unable to update runtime preference", "error", 4000);
          return false;
        }
        await refreshRuntimeStatuses();
        return true;
      } catch (error) {
        if (clearingPreference) {
          preferenceClearRequestedRef.current = false;
        }
        const message = error instanceof Error ? error.message : String(error);
        showStatus(`Failed to update runtime: ${message}`, "error", 4000);
        return false;
      }
    },
    [activeProjectId, refreshRuntimeStatuses, runtimeMutationEnabled, showStatus],
  );
  const showDesktopRuntimeHelp = useCallback(() => {
    setDesktopRuntimeHelpVisible(true);
  }, []);
  const {
    hostedRuntimeEnsuring,
    ensureHostedRuntime,
    hasHostedRuntimeInProgress,
  } = useHostedRuntimeEnsure({
    enabled: runtimeControllerEnabled && runtimeMutationEnabled,
    projectId: activeProjectId ?? null,
    runtimeStatuses: state.runtimeStatuses,
    runtimeStatusesResolved,
    refreshRuntimeStatuses,
    showStatus,
    setRuntimeEnsureError,
    setRuntimeEnsureLimit,
    showDesktopRuntimeHelp,
  });
  const { desktopRuntimeEnsuring, ensureDesktopRuntime } =
    useDesktopRuntimeEnsure({
      enabled: runtimeControllerEnabled && runtimeMutationEnabled,
      projectId: activeProjectId ?? null,
      runtimeStatuses: state.runtimeStatuses,
      dispatch,
      refreshRuntimeStatuses,
      showStatus,
      onShowSelfHostHelp: showDesktopRuntimeHelp,
    });
  const localRuntimeEntry = useMemo<ControllerRuntimeStatusEntry | null>(() => {
    if (!state.runtimeStatuses.length) {
      return null;
    }
    const workspaceRuntimeId = state.localWorkspace?.runtimeId ?? null;
    if (workspaceRuntimeId) {
      const match = state.runtimeStatuses.find(
        (entry) => entry.runtimeId === workspaceRuntimeId,
      );
      if (match) {
        return match;
      }
    }
    return state.runtimeStatuses.find((entry) => entry.isLocal) ?? null;
  }, [state.localWorkspace?.runtimeId, state.runtimeStatuses]);
  const localRuntimeTunnelGrant = useMemo(() => {
    const runtimeId = state.localWorkspace?.runtimeId ?? null;
    if (!runtimeId) {
      return null;
    }
    return state.tunnelGrants[runtimeId] ?? null;
  }, [state.localWorkspace?.runtimeId, state.tunnelGrants]);
  const hideDesktopRuntimeHelp = useCallback(() => {
    setDesktopRuntimeHelpVisible(false);
  }, []);
  const {
    preferredPromptDismissed,
    hostedRuntimeTakeoverInProgress,
    setSessionRuntimeOverride,
    clearSessionRuntimeOverride,
    dismissPreferredRuntimePrompt,
    takeOverHostedRuntimeLimit: takeOverHostedRuntimeLimitUnsafe,
    effectiveRuntimeId,
    effectiveRuntimeSource,
    runtimeReady,
    waitingForPreferredRuntime,
    recommendedCloudRuntimeId,
    shouldPromptCloudFallback,
    selectedLocalRuntimeId,
    resolvedPreferredRuntimeId,
  } = useHostedRuntimePolicy({
    activeProjectId,
    projectInitialized,
    projectAccessResolved,
    projectReadyForRuntime,
    state,
    dispatch,
    runtimeStatusesResolved,
    setRuntimeStatusesResolved,
    refreshRuntimeStatuses,
    ensureHostedRuntime,
    hasHostedRuntimeInProgress,
    hostedRuntimeEnsuring,
    runtimeEnsureError,
    runtimeEnsureLimit,
    showStatus,
    setPreferredRuntime,
    debugLog,
    lastPreferredRuntimeIdRef,
    preferenceClearRequestedRef,
    setRuntimeEnsureError,
    setRuntimeEnsureLimit,
    runtimeMutationEnabled,
  });
  const takeOverHostedRuntimeLimit = useCallback(async () => {
    if (!runtimeMutationEnabled) {
      showStatus("This space is read-only. Runtime controls are unavailable.", "warning", 3500);
      return false;
    }
    return takeOverHostedRuntimeLimitUnsafe();
  }, [runtimeMutationEnabled, showStatus, takeOverHostedRuntimeLimitUnsafe]);
  const copyTunnelDetails = useCallback(
    async (mode: TunnelCopyMode, runtimeId?: string | null) => {
      const targetRuntimeId = runtimeId ?? effectiveRuntimeId;
      if (!targetRuntimeId) {
        showStatus(
          "Select a desktop runtime before copying its tunnel link.",
          "warning",
          5000,
        );
        return false;
      }
      const grant = state.tunnelGrants[targetRuntimeId];
      if (!grant) {
        showStatus(
          "Tunnel details are not available yet. Try again once the desktop runtime is online.",
          "warning",
          6000,
          { actionLabel: "How to reconnect", onAction: showDesktopRuntimeHelp },
        );
        return false;
      }
      if (!tunnelGrantIsActive(grant)) {
        const normalizedStatus = (grant.status ?? "").trim().toLowerCase();
        const message =
          normalizedStatus === "revoked"
            ? "Tunnel link was revoked. Reconnect your desktop runtime to refresh it."
            : normalizedStatus === "expired"
              ? "Tunnel link expired. Reconnect your desktop runtime to refresh it."
              : normalizedStatus === "failed"
                ? "Tunnel link failed. Reconnect your desktop runtime or start Instafy Cloud."
                : "Tunnel link is unavailable. Reconnect your desktop runtime to refresh it.";
        showStatus(
          message,
          "warning",
          7000,
          normalizedStatus === "failed"
            ? {
                actionLabel: "Start Instafy Cloud",
                onAction: () => {
                  void ensureHostedRuntime();
                },
              }
            : { actionLabel: "How to reconnect", onAction: showDesktopRuntimeHelp },
        );
        return false;
      }
      const value =
        mode === "host" ? resolveTunnelHostname(grant) : resolveTunnelUrl(grant);
      if (!value) {
        showStatus("Tunnel endpoint is unavailable for this runtime.", "warning", 5000);
        return false;
      }
      try {
        await writeClipboardText(value);
        showStatus(
          mode === "host" ? "Copied tunnel hostname" : "Copied tunnel link",
          "success",
          3200,
          { presentation: "confirmation" },
        );
        return true;
      } catch (error) {
        if (import.meta.env.DEV) {
          console.warn("copyTunnelDetails failed", error);
        }
        showStatus("Unable to copy tunnel details", "error", 4000);
        return false;
      }
    },
    [
      effectiveRuntimeId,
      ensureHostedRuntime,
      showDesktopRuntimeHelp,
      showStatus,
      state.tunnelGrants,
    ],
  );

  const terminateRuntime = useCallback(
    async (runtimeId: string | null) => {
      if (!runtimeMutationEnabled) {
        showStatus("This space is read-only. Runtime controls are unavailable.", "warning", 3500);
        return false;
      }
      if (!runtimeControllerEnabled) {
        showStatus("Runtime control is unavailable.", "warning", 4000);
        return false;
      }
      if (!runtimeId) {
        showStatus("Select a runtime before terminating it.", "warning", 4000);
        return false;
      }
      const entry = state.runtimeStatuses.find(
        (runtime) => runtime.runtimeId === runtimeId,
      );
      if (entry?.isLocal) {
        showStatus(
          "Disconnect desktop runtimes from the agent instead of terminating them here.",
          "warning",
          5000,
        );
        return false;
      }
      try {
        await controllerClient.runtimes.stop({ runtimeId, reason: "user_stop" });
        showStatus("Runtime termination requested", "info", 2500);
        await refreshRuntimeStatuses();
        return true;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        showStatus(`Unable to terminate runtime: ${message}`, "error", 4000);
        return false;
      }
    },
    [refreshRuntimeStatuses, runtimeMutationEnabled, showStatus, state.runtimeStatuses],
  );

  const removeRuntimeEntry = useCallback(
    async (runtimeId: string | null) => {
      if (!runtimeMutationEnabled) {
        showStatus("This space is read-only. Runtime controls are unavailable.", "warning", 3500);
        return false;
      }
      if (!runtimeControllerEnabled) {
        showStatus("Runtime control is unavailable.", "warning", 4000);
        return false;
      }
      if (!runtimeId) {
        showStatus("Select a runtime before removing it.", "warning", 4000);
        return false;
      }
      const entry = state.runtimeStatuses.find(
        (runtime) => runtime.runtimeId === runtimeId,
      );
      if (entry?.isLocal) {
        showStatus(
          "Remove is only available for hosted runtimes.",
          "warning",
          4000,
        );
        return false;
      }
      try {
        await controllerClient.runtimes.remove({
          runtimeId,
          reason: "user_remove",
        });
        showStatus("Runtime removed", "info", 2500);
        if (state.sessionRuntimeId === runtimeId) {
          clearSessionRuntimeOverride();
        }
        if (state.preferredRuntimeId === runtimeId) {
          await setPreferredRuntime(null);
        }
        await refreshRuntimeStatuses();
        return true;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        showStatus(`Unable to remove runtime: ${message}`, "error", 4000);
        return false;
      }
    },
    [
      clearSessionRuntimeOverride,
      refreshRuntimeStatuses,
      runtimeMutationEnabled,
      setPreferredRuntime,
      showStatus,
      state.preferredRuntimeId,
      state.runtimeStatuses,
      state.sessionRuntimeId,
    ],
  );

  const startRuntimeEntry = useCallback(
    async (runtimeId: string | null) => {
      if (!runtimeMutationEnabled) {
        showStatus("This space is read-only. Runtime controls are unavailable.", "warning", 3500);
        return false;
      }
      if (!runtimeControllerEnabled) {
        showStatus("Runtime control is unavailable.", "warning", 4000);
        return false;
      }
      if (!runtimeId) {
        showStatus("Select a runtime before starting it.", "warning", 4000);
        return false;
      }
      const projectId = resolveProjectId();
      if (!projectId) {
        showStatus("Project id is missing; reload and try again.", "warning", 4000);
        return false;
      }
      const entry = state.runtimeStatuses.find(
        (runtime) => runtime.runtimeId === runtimeId,
      );
      if (!entry) {
        showStatus("Runtime not found for this project.", "warning", 4000);
        return false;
      }
      if (entry.isLocal) {
        showStatus("Local/desktop runtimes cannot be started from here.", "warning", 4000);
        return false;
      }
      try {
        await controllerClient.runtimes.start({
          projectId,
          runtimeId,
          displayName: entry.displayName ?? undefined,
          originMode: entry.origin?.mode ?? undefined,
          originProtocols: entry.origin?.protocols ?? undefined,
          originMetadata: entry.origin?.metadata ?? undefined,
        });
        showStatus("Runtime start requested", "info", 2500);
        await refreshRuntimeStatuses();
        return true;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        showStatus(`Unable to start runtime: ${message}`, "error", 4000);
        // If the hosted runtime could not be restarted (stale entry, bad compose state),
        // fall back to launching a fresh cloud runtime so the user can keep working.
        if (!entry.isLocal) {
          const newRuntime = await ensureHostedRuntime();
          if (newRuntime) {
            showStatus("Started a new Instafy Cloud runtime instead.", "info", 3000);
            return true;
          }
        }
        return false;
      }
    },
    [
      ensureHostedRuntime,
      refreshRuntimeStatuses,
      resolveProjectId,
      runtimeMutationEnabled,
      showStatus,
      state.runtimeStatuses,
    ],
  );
  useRuntimeStatusToasts({
    enabled: runtimeControllerEnabled,
    workspace: state.localWorkspace,
    runtimeEntry: localRuntimeEntry,
    selectedLocalRuntimeId,
    tunnel: localRuntimeTunnelGrant,
    showStatus,
    onShowSelfHostHelp: showDesktopRuntimeHelp,
  });
  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    window.__INSTAFY_RUNTIME__ = {
      getSnapshot: () => ({
        runtime: cloneRuntimeState(state.runtime),
        runs: cloneRunsMap(state.runs),
        latestRunIds: { ...state.latestRunIds },
        leasedRunIds: { ...state.leasedRunIds },
        pendingConversationMessages: [...state.pendingConversationMessages],
        localWorkspace: state.localWorkspace
          ? { ...state.localWorkspace }
          : null,
        runtimeStatuses: state.runtimeStatuses.map((entry) => ({ ...entry })),
        preferredRuntimeId: resolvedPreferredRuntimeId,
        sessionRuntimeId: state.sessionRuntimeId,
        runtimeReady,
        runtimeEnsureError,
        runtimeEnsureLimit,
        waitingForPreferredRuntime,
        shouldPromptCloudFallback,
        preferredPromptDismissed,
        runtimeStatusesResolved,
        hostedRuntimeEnsuring,
        hasHostedRuntimeInProgress,
        agentTokens: { ...state.agentTokens },
        tunnelGrants: { ...state.tunnelGrants },
      }),
      refreshRuntimeStatuses: () => refreshRuntimeStatuses(),
    };
    return () => {
      if (typeof window !== "undefined") {
        delete window.__INSTAFY_RUNTIME__;
      }
    };
  }, [
    state.latestRunIds,
    state.leasedRunIds,
    state.localWorkspace,
    state.agentTokens,
    state.pendingConversationMessages,
    state.runs,
    state.runtime,
    state.runtimeStatuses,
    resolvedPreferredRuntimeId,
    state.preferredRuntimeId,
    state.sessionRuntimeId,
    runtimeReady,
    runtimeEnsureError,
    runtimeEnsureLimit,
    shouldPromptCloudFallback,
    waitingForPreferredRuntime,
    preferredPromptDismissed,
    runtimeStatusesResolved,
    hostedRuntimeEnsuring,
    hasHostedRuntimeInProgress,
    state.tunnelGrants,
    refreshRuntimeStatuses,
  ]);

  useEffect(() => {
    if (!import.meta.env.DEV) {
      return;
    }
    if (typeof window === "undefined") {
      return;
    }
    if (!navigator.webdriver) {
      return;
    }

    const runtimeWindow = window as typeof window & {
      __INSTAFY_E2E__?: {
        emitConversationMessage: (input: {
          id?: string;
          projectId: string;
          conversationId: string;
          role?: "assistant" | "user";
          content: string;
          metadata?: Record<string, unknown>;
          createdAt?: string;
        }) => ControllerConversationMessage;
        createBlankConversation: (input: {
          projectId: string;
          metadata?: Record<string, unknown>;
          parentConversationId?: string | null;
          threadKind?: string | null;
        }) => Promise<string | null>;
        ensureHostedRuntime: () => Promise<boolean>;
      };
    };

    const makeUuid = () => {
      if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
        return crypto.randomUUID();
      }
      return `test-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    };

    runtimeWindow.__INSTAFY_E2E__ = {
      emitConversationMessage: (input) => {
        const now = new Date().toISOString();
        const resolvedId =
          typeof input.id === "string" && input.id.trim().length > 0
            ? input.id.trim()
            : makeUuid();
        const message: ControllerConversationMessage = {
          id: resolvedId,
          conversationId: String(input.conversationId),
          projectId: String(input.projectId),
          sessionId: null,
          createdBy: null,
          promptId: null,
          runId: null,
          role: input.role === "user" ? "user" : "assistant",
          content: typeof input.content === "string" ? input.content : "",
          metadata:
            input.metadata && typeof input.metadata === "object" && !Array.isArray(input.metadata)
              ? input.metadata
              : {},
          createdAt:
            typeof input.createdAt === "string" && input.createdAt.trim().length > 0
              ? input.createdAt.trim()
              : now,
        };
        dispatch({ type: "pushConversationMessage", message });
        return message;
      },
      createBlankConversation: async (input) => {
        const projectId = String(input.projectId ?? "").trim();
        if (!projectId) {
          return null;
        }
        const response = await controllerClient.conversations.createBlank({
          projectId,
          metadata:
            input.metadata && typeof input.metadata === "object" && !Array.isArray(input.metadata)
              ? input.metadata
              : {},
          parentConversationId:
            typeof input.parentConversationId === "string"
              ? input.parentConversationId
              : input.parentConversationId === null
                ? null
                : undefined,
          threadKind:
            typeof input.threadKind === "string"
              ? input.threadKind
              : input.threadKind === null
                ? null
                : undefined,
        });
        return response?.conversationId ?? null;
      },
      ensureHostedRuntime: async () => {
        try {
          return await ensureHostedRuntime();
        } catch {
          return false;
        }
      },
    };

    return () => {
      delete runtimeWindow.__INSTAFY_E2E__;
    };
  }, [dispatch, ensureHostedRuntime]);
  const value = useMemo<RuntimeOperationsContextValue>(
    () => ({
      setPreferredRuntime,
      refreshRuntimeStatuses,
      setSessionRuntimeOverride,
      clearSessionRuntimeOverride,
      effectiveRuntimeId,
      effectiveRuntimeSource,
      runtimeReady,
      waitingForPreferredRuntime,
      recommendedCloudRuntimeId,
      shouldPromptCloudFallback,
      dismissPreferredRuntimePrompt,
      runtimeEnsureError,
      runtimeEnsureLimit,
      hostedRuntimeEnsuring,
      hostedRuntimeTakeoverInProgress,
      ensureHostedRuntime,
      takeOverHostedRuntimeLimit,
      desktopRuntimeEnsuring,
      ensureDesktopRuntime,
      showDesktopRuntimeHelp,
      hideDesktopRuntimeHelp,
      isDesktopRuntimeHelpVisible: desktopRuntimeHelpVisible,
      copyTunnelDetails,
      terminateRuntime,
      removeRuntime: removeRuntimeEntry,
      startRuntime: startRuntimeEntry,
    }),
    [
      clearSessionRuntimeOverride,
      copyTunnelDetails,
      desktopRuntimeEnsuring,
      desktopRuntimeHelpVisible,
      dismissPreferredRuntimePrompt,
      effectiveRuntimeId,
      effectiveRuntimeSource,
      ensureDesktopRuntime,
      ensureHostedRuntime,
      takeOverHostedRuntimeLimit,
      hideDesktopRuntimeHelp,
      hostedRuntimeEnsuring,
      hostedRuntimeTakeoverInProgress,
      runtimeEnsureError,
      runtimeEnsureLimit,
      recommendedCloudRuntimeId,
      refreshRuntimeStatuses,
      runtimeReady,
      setPreferredRuntime,
      setSessionRuntimeOverride,
      shouldPromptCloudFallback,
      showDesktopRuntimeHelp,
      waitingForPreferredRuntime,
      terminateRuntime,
      removeRuntimeEntry,
      startRuntimeEntry,
    ],
  );
  return (
    <>
      <RuntimeOperationsContext.Provider value={value}>
        {children}
      </RuntimeOperationsContext.Provider>
    </>
  );
}
export function useRuntimeOperations(): RuntimeOperationsContextValue {
  const context = useContext(RuntimeOperationsContext);
  if (!context) {
    throw new Error(
      "useRuntimeOperations must be used within a RuntimeOperationsProvider",
    );
  }
  return context;
}
declare global {
  interface Window {
    __INSTAFY_RUNTIME__?: {
      getSnapshot: () => {
        runtime: RuntimeState;
        runs: Record<string, RunRecord>;
        latestRunIds: Partial<Record<RunRecord["runType"], string>>;
        leasedRunIds: Record<string, true>;
        pendingConversationMessages: ControllerConversationMessage[];
        localWorkspace: LocalWorkspacePresence | null;
        runtimeStatuses: ControllerRuntimeStatusEntry[];
        preferredRuntimeId: string | null;
        sessionRuntimeId: string | null;
        runtimeReady: boolean;
        runtimeEnsureError: string | null;
        runtimeEnsureLimit: HostedRuntimeLimitErrorDetails | null;
        tunnelGrants: Record<string, ControllerTunnelGrant>;
      };
      refreshRuntimeStatuses: () => Promise<void>;
    };
    __INSTAFY_RUNTIME_DEBUG__?: Array<{
      time: number;
      message: string;
      data?: unknown;
    }>;
  }
}
