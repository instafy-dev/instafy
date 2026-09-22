import { useEffect, useRef, type Dispatch } from "react";
import type { RunRecord, RuntimeState } from "../../types";
import {
  controllerClient,
  mapOriginSummaryToLocalWorkspacePresence,
  type ControllerEventPayload,
  mapLocalWorkspacePresenceFromPayload,
  mapOriginSummaryFromPayload,
  mapTunnelGrantFromPayload,
  type ControllerConversationMessage,
  type ControllerConversationCreated,
  type ControllerConversationUpdated,
} from "../../sdk/instafy";
import {
  fetchRuns,
  runsRealtimeEnabled,
  subscribeToRuns,
} from "../../services/runService";
import type { RuntimeAction } from "../runtimeStore";
import { extractAgentTokenSnapshotFromEvent } from "../runtimeStore";
import { runtimeDebugLog } from "../utils/runtimeDebug";
import { formatRuntimeStreamDisconnectedMessage } from "../controllerConnectionErrors";
import { isAutomationBrowser } from "../../services/runtimeController/logging";
import {
  CONVERSATION_SEND_QUEUE_EVENT,
  type ConversationSendQueueEventDetail,
} from "../../services/runtimeController/sendQueue";
import {
  MEMBERS_CHANGED_EVENT,
  PROJECT_ACCESS_REFRESH_EVENT,
  type MembersChangedEventDetail,
} from "../../projects/projectAccessEvents";
import {
  CREDITS_UPDATED_EVENT,
  type CreditsUpdatedEventDetail,
} from "../../credits/creditsEvents";

const { fetch: fetchRunsFromController, subscribe: subscribeToRunsFromController } = controllerClient.runs;
const { fetchLocalPresence: fetchLocalWorkspacePresence, fetchSummary: fetchOriginSummary } =
  controllerClient.workspace.origin;

interface Options {
  activeProjectId: string | null;
  projectInitialized: boolean;
  runtimeControllerEnabled: boolean;
  syncEpoch: number;
  dispatch: Dispatch<RuntimeAction>;
  updateRuntime: (updater: (current: RuntimeState) => RuntimeState) => void;
  upsertRun: (run: RunRecord) => void;
  removeRun: (runId: string) => void;
  markRunLeased: (runId: string) => void;
  refreshRuntimeStatuses: () => Promise<void>;
  logRunEvent: (label: string, run: RunRecord) => void;
  handleRuntimeTelemetryEvent: (event: ControllerEventPayload) => void;
  markControllerUnavailable: () => void;
}

const RUNTIME_STATUS_EVENT_KINDS = new Set([
  "runtime.preference_updated",
  "runtime.registered",
  "runtime.requested",
  "runtime.stopped",
  "runtime.health_updated",
  "runtime.login",
]);

const ORIGIN_STATUS_EVENT_KINDS = new Set([
  "origin.registered",
  "origin.expired",
]);

export function useRuntimeControllerSync({
  activeProjectId,
  projectInitialized,
  runtimeControllerEnabled,
  syncEpoch,
  dispatch,
  updateRuntime,
  upsertRun,
  removeRun,
  markRunLeased,
  refreshRuntimeStatuses,
  logRunEvent,
  handleRuntimeTelemetryEvent,
  markControllerUnavailable,
}: Options) {
  const resolvedProjectId =
    activeProjectId ||
    (typeof window !== "undefined"
      ? ((window as typeof window & { __INSTAFY_ACTIVE_PROJECT_ID__?: string | null })
          .__INSTAFY_ACTIVE_PROJECT_ID__ ?? null)
      : null);
  const projectReady =
    projectInitialized ||
    (typeof window !== "undefined"
      ? Boolean(
          (window as typeof window & { __INSTAFY_PROJECT_INITIALIZED__?: boolean | null })
            .__INSTAFY_PROJECT_INITIALIZED__
        )
      : false);
  const lastStreamErrorRef = useRef(0);
  const initialStreamErrorNotifiedRef = useRef(false);
  const streamOpenedRef = useRef(false);
  const receivedRunEventRef = useRef(false);
  const streamErrorSinceLastOpenRef = useRef(false);
  const streamDisconnectNotifiedRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    let controllerSyncTerminated = false;
    let unsubscribe: () => void = () => {};
    let lastOriginHydrationAt = 0;
    let runEventSequence = 0;
    let runReconciliationGeneration = 0;
    const latestRunEvents = new Map<
      string,
      { run: RunRecord; sequence: number }
    >();
    streamOpenedRef.current = false;
    initialStreamErrorNotifiedRef.current = false;
    lastStreamErrorRef.current = 0;
    receivedRunEventRef.current = false;
    streamErrorSinceLastOpenRef.current = false;
    streamDisconnectNotifiedRef.current = false;

    const resetRuns = () => {
      dispatch({ type: "setRunsState", runs: {}, latestRunIds: {} });
    };

    const clearProjectDerivedRuntimeState = () => {
      resetRuns();
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
      dispatch({ type: "setSessionRuntime", runtimeId: null });
      dispatch({ type: "clearConversationMessages", messageIds: [] });
      dispatch({ type: "clearConversationCreations", conversationIds: [] });
      dispatch({ type: "clearConversationUpdates", conversationIds: [] });
    };

    if (!projectReady || !resolvedProjectId) {
      runtimeDebugLog("runtime-sync:skipped", {
        reason: projectReady ? "no-project-id" : "not-initialized",
        projectId: resolvedProjectId ?? activeProjectId ?? null
      });
      clearProjectDerivedRuntimeState();
      updateRuntime((current) => ({
        ...current,
        controllerReady: false,
        controllerProjectMissing: false,
        controllerUnavailable: false,
        controllerStreamDisconnected: false,
        controllerStreamDisconnectMessage: null,
      }));
      return () => {
        cancelled = true;
        unsubscribe();
      };
    }

    runtimeDebugLog("runtime-sync:start", {
      projectId: resolvedProjectId,
      controllerEnabled: runtimeControllerEnabled,
      syncEpoch
    });
    const projectId = resolvedProjectId as string;

    const hydrateWorkspaceOriginState = async () => {
      const localWorkspacePresence = await fetchLocalWorkspacePresence({
        projectId,
      });
      if (cancelled) {
        return;
      }
      dispatch({
        type: "setLocalWorkspace",
        workspace: localWorkspacePresence,
      });

      try {
        const originSummary = await fetchOriginSummary({
          projectId,
          protocol: "http",
        });
        if (!cancelled) {
          const originPresence =
            mapOriginSummaryToLocalWorkspacePresence(originSummary);
          dispatch({
            type: "applyOriginSummary",
            summary: originSummary,
            derivedPresence: originPresence,
          });
        }
      } catch (originError) {
        if (import.meta.env.DEV) {
          console.warn("fetch origin summary failed", originError);
        }
      }
    };

    const scheduleOriginHydration = () => {
      const now = Date.now();
      if (now - lastOriginHydrationAt < 2_000) {
        return;
      }
      lastOriginHydrationAt = now;
      void hydrateWorkspaceOriginState();
    };

    const handleStreamError = (message: string) => {
      if (controllerSyncTerminated) {
        return;
      }
      const now = Date.now();
      const sinceLast = now - lastStreamErrorRef.current;
      lastStreamErrorRef.current = now;
      streamErrorSinceLastOpenRef.current = true;
      const isStreamError = message === "event stream error";
      if (!(isStreamError && (streamOpenedRef.current || isAutomationBrowser()))) {
        const log = isStreamError ? console.debug : console.warn;
        log("runtime controller subscription error", message, {
          streamOpened: streamOpenedRef.current,
          sinceLastMs: sinceLast > 0 ? sinceLast : null,
        });
      }
      if (!streamOpenedRef.current) {
        if (initialStreamErrorNotifiedRef.current) {
          return;
        }
        initialStreamErrorNotifiedRef.current = true;
        markControllerUnavailable();
        return;
      }
      if (streamDisconnectNotifiedRef.current) {
        return;
      }
      streamDisconnectNotifiedRef.current = true;
      updateRuntime((current) => ({
        ...current,
        controllerStreamDisconnected: true,
        controllerStreamDisconnectMessage:
          formatRuntimeStreamDisconnectedMessage(message),
      }));
    };

    const handleControllerAccessDenied = (status: 401 | 403) => {
      if (cancelled) {
        return;
      }
      controllerSyncTerminated = true;
      runReconciliationGeneration += 1;
      unsubscribe();
      runtimeDebugLog("runtime-sync:controller-access-denied", {
        projectId,
        status,
      });
      clearProjectDerivedRuntimeState();
      updateRuntime((current) => ({
        ...current,
        controllerReady: false,
        controllerProjectMissing: false,
        controllerUnavailable: false,
        controllerStreamDisconnected: false,
        controllerStreamDisconnectMessage: null,
      }));
    };

    const handleControllerProjectMissing = () => {
      if (cancelled) {
        return;
      }
      controllerSyncTerminated = true;
      runReconciliationGeneration += 1;
      unsubscribe();
      runtimeDebugLog("runtime-sync:controller-not-found", {
        projectId,
      });
      clearProjectDerivedRuntimeState();
      updateRuntime((current) => ({
        ...current,
        controllerReady: false,
        controllerProjectMissing: true,
        controllerUnavailable: false,
        controllerStreamDisconnected: false,
        controllerStreamDisconnectMessage: null,
      }));
    };

    const reconcileRunsAfterReconnect = async () => {
      const reconciliationGeneration = ++runReconciliationGeneration;
      const eventSequenceAtStart = runEventSequence;
      try {
        const result = await fetchRunsFromController({ projectId });
        if (
          cancelled ||
          controllerSyncTerminated ||
          reconciliationGeneration !== runReconciliationGeneration
        ) {
          return;
        }
        if (result.unauthorized || result.forbidden) {
          handleControllerAccessDenied(result.unauthorized ? 401 : 403);
          return;
        }
        if (result.notFound) {
          handleControllerProjectMissing();
          return;
        }
        result.runs.forEach((run) => {
          const latestRunEvent = latestRunEvents.get(run.id);
          const snapshotUpdatedAt = Date.parse(run.updatedAt ?? "");
          const eventUpdatedAt = Date.parse(latestRunEvent?.run.updatedAt ?? "");
          // Prefer an SSE update received while this request was in flight
          // unless the authoritative snapshot proves it is at least as new.
          if (
            !latestRunEvent ||
            latestRunEvent.sequence <= eventSequenceAtStart ||
            (Number.isFinite(snapshotUpdatedAt) &&
              Number.isFinite(eventUpdatedAt) &&
              snapshotUpdatedAt >= eventUpdatedAt)
          ) {
            upsertRun(run);
          }
        });
      } catch (error) {
        if (
          cancelled ||
          controllerSyncTerminated ||
          reconciliationGeneration !== runReconciliationGeneration
        ) {
          return;
        }
        runtimeDebugLog("runtime-sync:run-reconciliation-error", {
          projectId,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    };

    const connectControllerStream = () => {
      unsubscribe();
      unsubscribe = subscribeToRunsFromController({
        projectId,
        quietErrors: true,
        onRun: (run) => {
          logRunEvent("controller:onRun", run);
          receivedRunEventRef.current = true;
          runEventSequence += 1;
          latestRunEvents.set(run.id, {
            run,
            sequence: runEventSequence,
          });
          upsertRun(run);
        },
        onAccessDenied: ({ status }) => {
          handleControllerAccessDenied(status);
        },
        onError: handleStreamError,
        onOpen: () => {
          streamOpenedRef.current = true;
          initialStreamErrorNotifiedRef.current = false;
          updateRuntime((current) =>
            current.controllerStreamDisconnected ||
            current.controllerStreamDisconnectMessage !== null
              ? {
                  ...current,
                  controllerStreamDisconnected: false,
                  controllerStreamDisconnectMessage: null,
                }
              : current,
          );
          if (streamErrorSinceLastOpenRef.current) {
            streamErrorSinceLastOpenRef.current = false;
            streamDisconnectNotifiedRef.current = false;
            void reconcileRunsAfterReconnect();
            if (typeof window !== "undefined") {
              window.dispatchEvent(
                new CustomEvent("instafy:controller-stream-reconnected", {
                  detail: { projectId },
                }),
              );
            }
          }
        },
        onEvent: (event) => {
          if (import.meta.env.DEV && !isAutomationBrowser()) {
            if (event.kind !== "runtime.dev_isolation") {
              console.info("[runtime] controller:event", {
                kind: event.kind,
                runId: event.run_id ?? null,
                conversationId: event.conversation_id ?? null,
                stage: event.data?.stage ?? null,
                status: event.data?.runStatus ?? event.data?.status ?? null,
              });
            }
          }
          handleRuntimeTelemetryEvent(event);
          if (
            event.kind === "project.access_changed" &&
            typeof window !== "undefined"
          ) {
            window.dispatchEvent(
              new CustomEvent(PROJECT_ACCESS_REFRESH_EVENT, {
                // A null project id is an org-wide access invalidation and
                // must refresh whichever project is active now, not whichever
                // project this stream captured before a navigation switch.
                detail: { projectId: event.project_id ?? null },
              }),
            );
          }
          // Roster and credit signals carry no data; listeners refetch
          // through their own authorized endpoints.
          if (
            event.kind === "project.members_changed" &&
            typeof window !== "undefined"
          ) {
            window.dispatchEvent(
              new CustomEvent<MembersChangedEventDetail>(MEMBERS_CHANGED_EVENT, {
                detail: { projectId: event.project_id ?? null },
              }),
            );
          }
          if (event.kind === "credits.updated" && typeof window !== "undefined") {
            window.dispatchEvent(
              new CustomEvent<CreditsUpdatedEventDetail>(CREDITS_UPDATED_EVENT, {
                detail: { projectId: event.project_id ?? null },
              }),
            );
          }
          if (event.kind === "runtime.login") {
            const dataRecord =
              (event.data ?? null) as Record<string, unknown> | null;
            const runtimeId = sanitizeString(
              dataRecord ? dataRecord["runtimeId"] : null,
            );
            if (runtimeId) {
              const snapshot = extractAgentTokenSnapshotFromEvent(
                dataRecord,
                null,
              );
              if (snapshot) {
                dispatch({
                  type: "upsertAgentToken",
                  runtimeId,
                  snapshot,
                });
              }
            }
          }
          if (
            RUNTIME_STATUS_EVENT_KINDS.has(event.kind) ||
            ORIGIN_STATUS_EVENT_KINDS.has(event.kind)
          ) {
            if (
              typeof window !== "undefined" &&
              (event.kind === "runtime.stopped" || event.kind === "origin.expired")
            ) {
              const detail = {
                projectId: event.project_id ?? null,
                kind: event.kind,
                data: event.data ?? null,
              } as const;
              window.dispatchEvent(
                new CustomEvent("instafy:runtime-lifecycle-event", { detail }),
              );
            }
            void refreshRuntimeStatuses();
          }
          if (event.kind?.startsWith("local_workspace.")) {
            if (event.kind === "local_workspace.unregistered") {
              dispatch({ type: "setLocalWorkspace", workspace: null });
              dispatch({
                type: "applyOriginSummary",
                summary: null,
                derivedPresence: null,
              });
            } else {
              const presence = mapLocalWorkspacePresenceFromPayload(
                event.data ?? null,
              );
              dispatch({ type: "setLocalWorkspace", workspace: presence });
            }
          }
          if (event.kind?.startsWith("origin.")) {
            const originSummary = mapOriginSummaryFromPayload(
              event.data ?? null,
            );
            if (originSummary) {
              const originPresence =
                mapOriginSummaryToLocalWorkspacePresence(originSummary);
              dispatch({
                type: "applyOriginSummary",
                summary: originSummary,
                derivedPresence: originPresence,
              });
            } else if (event.kind === "origin.expired") {
              dispatch({
                type: "applyOriginSummary",
                summary: null,
                derivedPresence: null,
              });
            }
            if (
              event.kind === "origin.registered" ||
              event.kind === "origin.heartbeat"
            ) {
              scheduleOriginHydration();
            }
          }
          if (
            (event.kind === "workspace.commit" ||
              event.kind === "workspace.file_changed") &&
            typeof window !== "undefined"
          ) {
            const detail = {
              projectId: event.project_id ?? null,
              kind: event.kind,
              data: event.data ?? null,
            } as const;
            window.dispatchEvent(
              new CustomEvent("instafy:workspace-change", { detail }),
            );
            if (event.kind === "workspace.commit") {
              window.dispatchEvent(
                new CustomEvent("instafy:workspace-commit", { detail }),
              );
            }
          }
          if (
            event.kind === "runtime.dev_isolation" &&
            event.data &&
            typeof event.data === "object" &&
            (event.data as Record<string, unknown>).action ===
              "job_payload_tagged"
          ) {
            const data = event.data as Record<string, unknown>;
            const runId =
              typeof event.run_id === "string"
                ? event.run_id
                : typeof event.job_id === "string"
                  ? event.job_id
                  : typeof data.runId === "string"
                    ? (data.runId as string)
                    : typeof data.jobId === "string"
                      ? (data.jobId as string)
                      : null;
            if (runId) {
              markRunLeased(runId);
            }
          }
          if (event.kind === "conversation.message_created" && event.data) {
            const message = parseConversationEvent(event);
            if (message) {
              dispatch({ type: "pushConversationMessage", message });
            }
          }
          if (event.kind === "conversation.created") {
            const creation = parseConversationCreatedEvent(event);
            if (creation) {
              dispatch({ type: "pushConversationCreation", creation });
            }
          }
          if (event.kind === "conversation.updated") {
            const update = parseConversationUpdatedEvent(event);
            if (update) {
              dispatch({ type: "pushConversationUpdate", update });
            }
          }
          if (
            event.kind === "conversation.sendQueue" &&
            typeof window !== "undefined"
          ) {
            window.dispatchEvent(
              new CustomEvent(CONVERSATION_SEND_QUEUE_EVENT, {
                detail: {
                  projectId: event.project_id ?? null,
                  conversationId: event.conversation_id ?? null,
                  data: (event.data ?? null) as Record<string, unknown> | null,
                } satisfies ConversationSendQueueEventDetail,
              }),
            );
          }
          if (event.kind?.startsWith("tunnel.")) {
            const grant = mapTunnelGrantFromPayload(
              (event.data ?? null) as Record<string, unknown> | null,
            );
            if (grant) {
              dispatch({ type: "upsertTunnelGrant", grant });
            }
          }
        },
      });
    };

    const hydrateFromController = async () => {
      if (!projectId) {
        return;
      }
      try {
        const result = await fetchRunsFromController({
          projectId,
        });
        if (cancelled) {
          return;
        }
        if (result.unauthorized || result.forbidden) {
          handleControllerAccessDenied(result.unauthorized ? 401 : 403);
          return;
        }
        if (result.notFound) {
          handleControllerProjectMissing();
          return;
        }
        connectControllerStream();
        const shouldReset = !receivedRunEventRef.current;
        if (shouldReset) {
          resetRuns();
        }
        result.runs.forEach((run) => {
          upsertRun(run);
        });
        updateRuntime((current) => ({
          ...current,
          controllerProjectMissing: result.notFound,
          controllerUnavailable: false,
          controllerReady: !result.notFound,
          controllerStreamDisconnected: false,
          controllerStreamDisconnectMessage: null,
        }));
        await hydrateWorkspaceOriginState();
        await refreshRuntimeStatuses();
        if (cancelled) {
          return;
        }
      } catch (error) {
        if (cancelled) {
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        console.warn("hydrateFromController failed", message);
        runtimeDebugLog("runtime-sync:controller-error", {
          projectId: resolvedProjectId,
          message
        });
        markControllerUnavailable();
      }
    };

    const hydrateFromSupabase = async () => {
      try {
        dispatch({ type: "setLocalWorkspace", workspace: null });
        dispatch({
          type: "applyOriginSummary",
          summary: null,
          derivedPresence: null,
        });
        const runs = await fetchRuns({ projectId });
        if (cancelled) {
          return;
        }
        resetRuns();
        runs.forEach((run) => upsertRun(run));
        updateRuntime((current) => ({
          ...current,
          controllerProjectMissing: false,
          controllerUnavailable: false,
          controllerReady: runs.length > 0,
          controllerStreamDisconnected: false,
          controllerStreamDisconnectMessage: null,
        }));
        if (!runsRealtimeEnabled) {
          return;
        }
        unsubscribe = subscribeToRuns({
          projectId,
          onRun: (run) => upsertRun(run),
          onDelete: (runId) => removeRun(runId),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn("hydrateFromSupabase failed", message);
        updateRuntime((current) => ({
          ...current,
          controllerReady: false,
          controllerUnavailable: false,
          controllerStreamDisconnected: false,
          controllerStreamDisconnectMessage: null,
        }));
      }
    };

    clearProjectDerivedRuntimeState();
    updateRuntime((current) => ({
      ...current,
      controllerReady: false,
      controllerProjectMissing: false,
      controllerUnavailable: false,
      controllerStreamDisconnected: false,
      controllerStreamDisconnectMessage: null,
    }));
    if (runtimeControllerEnabled) {
      void hydrateFromController();
    } else {
      runtimeDebugLog("runtime-sync:controller-disabled", {
        projectId: resolvedProjectId
      });
      void hydrateFromSupabase();
    }

    return () => {
      cancelled = true;
      runReconciliationGeneration += 1;
      unsubscribe();
    };
  }, [
    activeProjectId,
    dispatch,
    handleRuntimeTelemetryEvent,
    markControllerUnavailable,
    markRunLeased,
    projectInitialized,
    refreshRuntimeStatuses,
    removeRun,
    resolvedProjectId,
    runtimeControllerEnabled,
    projectReady,
    syncEpoch,
    updateRuntime,
    upsertRun,
    logRunEvent,
  ]);
}

function parseConversationEvent(
  event: ControllerEventPayload,
): ControllerConversationMessage | null {
  if (!event || event.kind !== "conversation.message_created") {
    return null;
  }
  const data = (event.data ?? {}) as Record<string, unknown>;
  const id = typeof data.id === "string" ? data.id : null;
  const conversationId =
    typeof data.conversationId === "string"
      ? data.conversationId
      : typeof event.conversation_id === "string"
        ? event.conversation_id
        : null;
  const projectId =
    typeof data.projectId === "string"
      ? data.projectId
      : typeof event.project_id === "string"
        ? event.project_id
        : null;
  if (!id || !conversationId || !projectId) {
    return null;
  }
  const sessionId =
    typeof data.sessionId === "string"
      ? data.sessionId
      : (event.session_id ?? null);
  const createdBy =
    typeof data.createdBy === "string"
      ? data.createdBy
      : typeof data.created_by === "string"
        ? (data.created_by as string)
        : null;
  const promptId = typeof data.promptId === "string" ? data.promptId : null;
  const runId =
    typeof data.runId === "string"
      ? data.runId
      : typeof event.run_id === "string"
        ? event.run_id
        : null;
  const role = data.role === "assistant" ? "assistant" : "user";
  const content = typeof data.content === "string" ? data.content : "";
  const metadata =
    data.metadata &&
    typeof data.metadata === "object" &&
    !Array.isArray(data.metadata)
      ? (data.metadata as Record<string, unknown>)
      : {};
  const createdAt =
    typeof data.createdAt === "string"
      ? data.createdAt
      : new Date().toISOString();
  return {
    id,
    conversationId,
    projectId,
    sessionId,
    createdBy,
    promptId,
    runId,
    role,
    content,
    metadata,
    createdAt,
  };
}

function parseConversationCreatedEvent(
  event: ControllerEventPayload,
): ControllerConversationCreated | null {
  if (!event || event.kind !== "conversation.created") {
    return null;
  }

  const data = (event.data ?? {}) as Record<string, unknown>;
  const conversationId =
    typeof data.conversationId === "string"
      ? data.conversationId
      : typeof event.conversation_id === "string"
        ? event.conversation_id
        : null;
  const projectId =
    typeof data.projectId === "string"
      ? data.projectId
      : typeof event.project_id === "string"
        ? event.project_id
        : null;
  if (!conversationId || !projectId) {
    return null;
  }

  const sessionId =
    typeof data.sessionId === "string"
      ? data.sessionId
      : (event.session_id ?? null);
  const createdBy =
    typeof data.createdBy === "string"
      ? data.createdBy
      : typeof data.created_by === "string"
        ? (data.created_by as string)
        : null;
  const visibility = typeof data.visibility === "string" ? data.visibility : null;
  const metadata =
    data.metadata &&
    typeof data.metadata === "object" &&
    !Array.isArray(data.metadata)
      ? (data.metadata as Record<string, unknown>)
      : null;
  const createdAt =
    typeof data.createdAt === "string"
      ? data.createdAt
      : typeof event.timestamp === "string"
        ? event.timestamp
        : new Date().toISOString();
  const updatedAt = typeof data.updatedAt === "string" ? data.updatedAt : null;
  const runId =
    typeof data.runId === "string"
      ? data.runId
      : typeof event.run_id === "string"
        ? event.run_id
        : null;
  const promptId = typeof data.promptId === "string" ? data.promptId : null;

  return {
    conversationId,
    projectId,
    sessionId,
    createdBy,
    visibility,
    metadata,
    createdAt,
    updatedAt,
    runId,
    promptId,
  };
}

function parseConversationUpdatedEvent(
  event: ControllerEventPayload,
): ControllerConversationUpdated | null {
  if (!event || event.kind !== "conversation.updated") {
    return null;
  }

  const data = (event.data ?? {}) as Record<string, unknown>;
  const conversationId =
    typeof data.conversationId === "string"
      ? data.conversationId
      : typeof event.conversation_id === "string"
        ? event.conversation_id
        : null;
  const projectId =
    typeof data.projectId === "string"
      ? data.projectId
      : typeof event.project_id === "string"
        ? event.project_id
        : null;
  if (!conversationId || !projectId) {
    return null;
  }

  const sessionId =
    typeof data.sessionId === "string"
      ? data.sessionId
      : (event.session_id ?? null);
  const createdBy =
    typeof data.createdBy === "string"
      ? data.createdBy
      : typeof data.created_by === "string"
        ? (data.created_by as string)
        : null;
  const visibility = typeof data.visibility === "string" ? data.visibility : null;
  const metadata =
    data.metadata &&
    typeof data.metadata === "object" &&
    !Array.isArray(data.metadata)
      ? (data.metadata as Record<string, unknown>)
      : null;
  const createdAt =
    typeof data.createdAt === "string"
      ? data.createdAt
      : typeof event.timestamp === "string"
        ? event.timestamp
        : new Date().toISOString();
  const updatedAt = typeof data.updatedAt === "string" ? data.updatedAt : null;

  return {
    conversationId,
    projectId,
    sessionId,
    createdBy,
    visibility,
    metadata,
    createdAt,
    updatedAt,
  };
}

function sanitizeString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
