import type { RunRecord } from "../../types";
import {
  controllerBaseUrl,
  normalizeUuidParam,
  resolveControllerAccessToken,
  runtimeControllerEnabled,
} from "./core";
import {
  getControllerErrorMessage,
  isAutomationBrowser,
  logControllerRequestError,
} from "./logging";

const RUN_EVENT_KINDS = [
  "run.queued",
  "run.progress",
  "run.preview",
  "run.completed",
] as const;
const RUNTIME_TELEMETRY_EVENT_KINDS = [
  "runtime.strict_mode",
  "runtime.dev_isolation",
  "runtime.unavailable",
  "runtime.login",
] as const;
const TELEMETRY_EVENT_KINDS = ["telemetry.error", "telemetry.warning"] as const;
const RUNTIME_STATUS_EVENT_KINDS = [
  "runtime.registered",
  "runtime.requested",
  "runtime.stopped",
] as const;
const CONVERSATION_EVENT_KINDS = [
  "conversation.message_created",
  "conversation.created",
  "conversation.updated",
  "conversation.sendQueue",
] as const;
const RUNTIME_PREFERENCE_EVENT_KINDS = ["runtime.preference_updated"] as const;
const LOCAL_WORKSPACE_EVENT_KINDS = [
  "local_workspace.registered",
  "local_workspace.heartbeat",
  "local_workspace.unregistered",
  "local_workspace.expired",
] as const;
const ORIGIN_EVENT_KINDS = [
  "origin.registered",
  "origin.heartbeat",
  "origin.expired",
] as const;
const TUNNEL_EVENT_KINDS = [
  "tunnel.grant_requested",
  "tunnel.grant_revoked",
  "tunnel.status_updated",
] as const;
const WORKSPACE_EVENT_KINDS = [
  "workspace.commit",
  "workspace.file_changed",
] as const;
const PROJECT_ACCESS_EVENT_KINDS = ["project.access_changed"] as const;
const FORWARD_EVENT_KINDS = [
  ...RUNTIME_TELEMETRY_EVENT_KINDS,
  ...TELEMETRY_EVENT_KINDS,
  ...RUNTIME_STATUS_EVENT_KINDS,
  ...CONVERSATION_EVENT_KINDS,
  ...RUNTIME_PREFERENCE_EVENT_KINDS,
  ...LOCAL_WORKSPACE_EVENT_KINDS,
  ...ORIGIN_EVENT_KINDS,
  ...TUNNEL_EVENT_KINDS,
  ...WORKSPACE_EVENT_KINDS,
  ...PROJECT_ACCESS_EVENT_KINDS,
] as const;

export interface ControllerEventPayload {
  kind: string;
  project_id?: string | null;
  session_id?: string | null;
  run_id?: string | null;
  job_id?: string | null;
  conversation_id?: string | null;
  channels?: string[] | null;
  data?: Record<string, unknown> | null;
  timestamp?: string;
}

interface ControllerRunSnapshot {
  id: string;
  project_id?: string | null;
  session_id?: string | null;
  conversation_id?: string | null;
  prompt_id?: string | null;
  run_type?: string | null;
  status?: string | null;
  progress?: number | null;
  progress_stage?: string | null;
  preview_url?: string | null;
  last_message?: string | null;
  metadata?: unknown;
  created_at?: string | null;
  updated_at?: string | null;
}

interface RunEventData {
  run?: ControllerRunSnapshot | null;
  percent?: number | null;
  stage?: string | null;
  message?: string | null;
  status?: string | null;
  runStatus?: string | null;
  finalStatus?: string | null;
  previewUrl?: string | null;
}

export interface ControllerRunResultData extends Record<string, unknown> {}

export interface ControllerRunResult {
  runId: string;
  conversationId: string | null;
  status: "ready" | "pending" | "error" | "unavailable";
  result?: ControllerRunResultData | null;
}

export async function fetchRunResultFromController(
  runId: string,
  accessToken?: string | null,
): Promise<ControllerRunResult | null> {
  if (!runtimeControllerEnabled) {
    return null;
  }

  const token = await resolveControllerAccessToken(accessToken ?? null);

  try {
    const response = await fetch(`${controllerBaseUrl}/runs/${runId}/result`, {
      method: "GET",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`fetch run result failed (${response.status}): ${text}`);
    }

    const payload = (await response.json()) as {
      runId?: string;
      conversationId?: string | null;
      status?: string;
      result?: unknown;
    };

    const normalizedStatus = (payload.status ?? "pending").toLowerCase();
    const status: ControllerRunResult["status"] =
      normalizedStatus === "ready" ||
      normalizedStatus === "error" ||
      normalizedStatus === "unavailable"
        ? (normalizedStatus as ControllerRunResult["status"])
        : "pending";

    const resultData = isPlainObject(payload.result)
      ? (payload.result as ControllerRunResultData)
      : null;

    return {
      runId: payload.runId ?? runId,
      conversationId: payload.conversationId ?? null,
      status,
      result: resultData,
    };
  } catch (error) {
    logControllerRequestError("[runtime-controller] fetch run result error:", error, {
      suppressLikelyConnectionNoise: true,
    });
    return null;
  }
}

export interface FetchControllerRunsParams {
  projectId?: string;
  sessionId?: string | null;
  runId?: string;
  limit?: number;
  accessToken?: string | null;
}

export interface FetchControllerRunsResult {
  runs: RunRecord[];
  notFound: boolean;
}

export async function fetchRunsFromController(
  params: FetchControllerRunsParams,
): Promise<FetchControllerRunsResult> {
  if (!runtimeControllerEnabled) {
    return { runs: [], notFound: false };
  }

  const search = new URLSearchParams();
  if (params.projectId) {
    search.set("projectId", params.projectId);
  }
  const sessionIdParam = normalizeUuidParam(params.sessionId ?? undefined);
  if (sessionIdParam) {
    search.set("sessionId", sessionIdParam);
  }
  if (params.runId) {
    search.set("runId", params.runId);
  }
  if (typeof params.limit === "number" && Number.isFinite(params.limit)) {
    search.set(
      "limit",
      Math.max(1, Math.min(200, Math.floor(params.limit))).toString(),
    );
  }

  const url = `${controllerBaseUrl}/runs${search.toString() ? `?${search.toString()}` : ""}`;

  const accessToken = await resolveControllerAccessToken(
    params.accessToken ?? null,
  );

  try {
    const response = await fetch(url, {
      headers: accessToken
        ? { authorization: `Bearer ${accessToken}` }
        : undefined,
    });
    if (response.status === 404) {
      return { runs: [], notFound: true };
    }
    if (response.status === 401 || response.status === 403) {
      return { runs: [], notFound: true };
    }
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`fetch runs failed (${response.status}): ${text}`);
    }

    const payload = (await response.json()) as ControllerRunSnapshot[];
    const runs = payload
      .map(mapRunSnapshotToRecord)
      .filter((run): run is RunRecord => Boolean(run));
    return { runs, notFound: false };
  } catch (error) {
    logControllerRequestError("[runtime-controller] fetchRuns error:", error, {
      suppressLikelyConnectionNoise: true,
    });
    return { runs: [], notFound: false };
  }
}

export interface SubscribeControllerRunsParams {
  projectId?: string;
  sessionId?: string | null;
  runId?: string;
  accessToken?: string | null;
  quietErrors?: boolean;
  onRun: (run: RunRecord, event: "INSERT" | "UPDATE") => void;
  onError?: (message: string) => void;
  onEvent?: (event: ControllerEventPayload) => void;
  onOpen?: () => void;
}

export function subscribeToRunsFromController(
  params: SubscribeControllerRunsParams,
): () => void {
  if (!runtimeControllerEnabled) {
    return () => {};
  }

  if (typeof window === "undefined" || typeof EventSource === "undefined") {
    return () => {};
  }

  const baseSearch = new URLSearchParams();
  if (params.projectId !== undefined && params.projectId !== null) {
    baseSearch.set("projectId", params.projectId);
  }
  const sessionIdParam = normalizeUuidParam(params.sessionId ?? undefined);
  if (sessionIdParam) {
    baseSearch.set("sessionId", sessionIdParam);
  }
  if (params.runId) {
    baseSearch.set("runId", params.runId);
  }
  const desiredKinds = new Set<string>([
    ...RUN_EVENT_KINDS,
    ...FORWARD_EVENT_KINDS,
  ]);
  desiredKinds.forEach((kind) => {
    baseSearch.append("kinds[]", kind);
  });

  const quietErrors = Boolean(params.quietErrors);

  const buildUrl = async () => {
    const accessToken = await resolveControllerAccessToken(
      params.accessToken ?? null,
    );
    const search = new URLSearchParams(baseSearch);
    if (accessToken) {
      search.set("accessToken", accessToken);
    }
    return `${controllerBaseUrl}/events?${search.toString()}`;
  };
  if (import.meta.env.DEV && !quietErrors) {
    buildUrl().then((url) => {
      // eslint-disable-next-line no-console
      console.info("[runtime-controller] event-stream url", url);
    });
  }

  let currentSource: EventSource | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let cancelled = false;

  const scheduleReconnect = () => {
    if (cancelled || reconnectTimer) {
      return;
    }
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void connect();
    }, 3000);
  };

  const connect = async () => {
    if (cancelled) {
      return;
    }

    const url = await buildUrl();
    try {
      if (!quietErrors) {
        console.warn(`[runtime-controller] opening event stream url=${url}`);
      }
      const source = new EventSource(url);
      currentSource = source;

      source.addEventListener("open", () => {
        if (import.meta.env.DEV && !isAutomationBrowser()) {
          console.info("[runtime-controller] sse open", { url });
        }
        params.onOpen?.();
      });
      if (import.meta.env.DEV && !quietErrors && !isAutomationBrowser()) {
        source.addEventListener("message", (evt) => {
          const preview =
            typeof evt?.data === "string" ? evt.data.slice(0, 200) : null;
          console.info("[runtime-controller] sse message", { url, preview });
        });
        source.addEventListener("error", (error) => {
          console.warn("[runtime-controller] sse error", error);
        });
      }

      source.onmessage = (event) => {
        try {
          const parsed = JSON.parse(event.data) as ControllerEventPayload;
          handleControllerEvent(parsed, params.onRun, params.onEvent);
        } catch (parseError) {
          const message =
            parseError instanceof Error
              ? parseError.message
              : String(parseError);
          console.warn("[runtime-controller] event parse error:", message);
          params.onError?.(message);
        }
      };
      source.onerror = (event) => {
        if (cancelled || currentSource !== source) {
          return;
        }
        if (!quietErrors) {
          console.warn(`[runtime-controller] event stream error [url=${url}]`, event);
        }
        params.onError?.("event stream error");
        source.close();
        currentSource = null;
        scheduleReconnect();
      };
    } catch (error) {
      const message = getControllerErrorMessage(error);
      logControllerRequestError("[runtime-controller] failed to open event stream:", error, {
        suppressLikelyConnectionNoise: true,
      });
      params.onError?.(message);
      scheduleReconnect();
    }
  };

  void connect();

  return () => {
    cancelled = true;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
    }
    currentSource?.close();
    currentSource = null;
  };
}

function handleControllerEvent(
  event: ControllerEventPayload,
  onRun: (run: RunRecord, event: "INSERT" | "UPDATE") => void,
  onEvent?: (event: ControllerEventPayload) => void,
) {
  if (!event || typeof event !== "object") {
    return;
  }

  const kind = typeof event.kind === "string" ? event.kind : "";

  if (onEvent && (FORWARD_EVENT_KINDS as readonly string[]).includes(kind)) {
    onEvent(event);
  }

  if (!RUN_EVENT_KINDS.includes(kind as (typeof RUN_EVENT_KINDS)[number])) {
    return;
  }

  const data = (event.data ?? null) as RunEventData | null;
  let runRecord: RunRecord | null = null;

  if (data && data.run) {
    runRecord = mapRunSnapshotToRecord(data.run);
    if (runRecord) {
      if (typeof event.conversation_id === "string") {
        runRecord.conversationId = event.conversation_id;
      }
      if (typeof data.percent === "number") {
        runRecord.progress = data.percent;
      }
      if (typeof data.stage === "string") {
        runRecord.progressStage = data.stage || null;
      }
      if (typeof data.message === "string") {
        runRecord.lastMessage = data.message || null;
      }
      const statusOverride = data.runStatus ?? data.finalStatus ?? data.status;
      if (
        typeof statusOverride === "string" &&
        statusOverride.trim().length > 0
      ) {
        runRecord.status = normalizeRunStatus(statusOverride, runRecord.status);
      }
      if (typeof data.previewUrl === "string") {
        runRecord.previewUrl = data.previewUrl;
      }
      if (event.timestamp && typeof event.timestamp === "string") {
        runRecord.updatedAt = event.timestamp;
      }
    }
  }

  if (!runRecord && event.run_id) {
    runRecord = {
      id: event.run_id,
      projectId: event.project_id ?? null,
      sessionId: event.session_id ?? null,
      conversationId: event.conversation_id ?? null,
      promptId: null,
      runType: "prompt",
      status: normalizeRunStatus(
        data?.runStatus ?? data?.finalStatus ?? data?.status,
        "queued",
      ),
      progress: typeof data?.percent === "number" ? data.percent : 0,
      progressStage: typeof data?.stage === "string" ? data.stage : null,
      previewUrl: typeof data?.previewUrl === "string" ? data.previewUrl : null,
      lastMessage: typeof data?.message === "string" ? data.message : null,
      metadata: null,
      createdAt: null,
      updatedAt: event.timestamp ?? null,
    };
  }

  if (!runRecord) {
    return;
  }

  const eventType: "INSERT" | "UPDATE" =
    kind === "run.queued" ? "INSERT" : "UPDATE";
  onRun(runRecord, eventType);
}

function mapRunSnapshotToRecord(
  snapshot: ControllerRunSnapshot | null | undefined,
): RunRecord | null {
  if (!snapshot) {
    return null;
  }

  const progressValue =
    typeof snapshot.progress === "number"
      ? snapshot.progress
      : Number(snapshot.progress ?? 0) || 0;
  const metadataValue = isPlainObject(snapshot.metadata)
    ? (snapshot.metadata as Record<string, unknown>)
    : null;

  return {
    id: snapshot.id ?? "",
    projectId: snapshot.project_id ?? null,
    sessionId: snapshot.session_id ?? null,
    conversationId: snapshot.conversation_id ?? null,
    promptId: snapshot.prompt_id ?? null,
    runType: normalizeRunType(snapshot.run_type),
    status: normalizeRunStatus(snapshot.status, "queued"),
    progress: progressValue,
    progressStage: snapshot.progress_stage ?? null,
    previewUrl: snapshot.preview_url ?? null,
    lastMessage: snapshot.last_message ?? null,
    metadata: metadataValue,
    createdAt: snapshot.created_at ?? null,
    updatedAt: snapshot.updated_at ?? null,
  };
}

function normalizeRunType(
  value: string | null | undefined,
): RunRecord["runType"] {
  if (value === "prompt" || value === "editor" || value === "build") {
    return value;
  }
  return "build";
}

function normalizeRunStatus(
  value: string | null | undefined,
  fallback: RunRecord["status"],
): RunRecord["status"] {
  const normalized = (value ?? "").trim().toLowerCase();
  switch (normalized) {
    case "queued":
    case "in_progress":
    case "success":
    case "failed":
    case "canceled":
    case "awaiting_approval":
    case "expired":
    case "merged":
      return normalized as RunRecord["status"];
    case "completed":
      return "awaiting_approval";
    default:
      return fallback;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
