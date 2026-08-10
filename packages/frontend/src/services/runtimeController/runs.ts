import type { RunRecord } from "../../types";
import {
  emitControllerAuthErrorForRequest,
  isControllerDocumentReloadPending,
  normalizeUuidParam,
  readControllerError,
  resolveControllerRequestContext,
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

  const requestContext = await resolveControllerRequestContext(accessToken ?? null);
  if (!requestContext.accessToken) {
    return null;
  }

  try {
    const response = await fetch(`${requestContext.baseUrl}/runs/${runId}/result`, {
      method: "GET",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${requestContext.accessToken}`,
      },
    });

    if (!response.ok) {
      throw new Error(
        await readControllerError(
          response,
          "fetch run result failed",
          requestContext,
        ),
      );
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
  unauthorized: boolean;
  forbidden: boolean;
}

export async function fetchRunsFromController(
  params: FetchControllerRunsParams,
): Promise<FetchControllerRunsResult> {
  if (!runtimeControllerEnabled) {
    return { runs: [], notFound: false, unauthorized: false, forbidden: false };
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

  const requestContext = await resolveControllerRequestContext(
    params.accessToken ?? null,
  );
  if (!requestContext.accessToken) {
    return { runs: [], notFound: false, unauthorized: false, forbidden: false };
  }
  const url = `${requestContext.baseUrl}/runs${search.toString() ? `?${search.toString()}` : ""}`;

  try {
    const response = await fetch(url, {
      headers: { authorization: `Bearer ${requestContext.accessToken}` },
    });
    if (response.status === 404) {
      return { runs: [], notFound: true, unauthorized: false, forbidden: false };
    }
    if (response.status === 401 || response.status === 403) {
      await readControllerError(response, "fetch runs failed", requestContext);
      return {
        runs: [],
        notFound: false,
        unauthorized: response.status === 401,
        forbidden: response.status === 403,
      };
    }
    if (!response.ok) {
      throw new Error(
        await readControllerError(response, "fetch runs failed", requestContext),
      );
    }

    const payload = (await response.json()) as ControllerRunSnapshot[];
    const runs = payload
      .map(mapRunSnapshotToRecord)
      .filter((run): run is RunRecord => Boolean(run));
    return { runs, notFound: false, unauthorized: false, forbidden: false };
  } catch (error) {
    logControllerRequestError("[runtime-controller] fetchRuns error:", error, {
      suppressLikelyConnectionNoise: true,
    });
    return { runs: [], notFound: false, unauthorized: false, forbidden: false };
  }
}

export interface SubscribeControllerRunsParams {
  projectId?: string;
  sessionId?: string | null;
  runId?: string;
  accessToken?: string | null;
  quietErrors?: boolean;
  onRun: (run: RunRecord, event: "INSERT" | "UPDATE") => void;
  onAccessDenied?: (denial: ControllerStreamAccessDenied) => void;
  onError?: (message: string) => void;
  onEvent?: (event: ControllerEventPayload) => void;
  onOpen?: () => void;
}

export interface ControllerStreamAccessDenied {
  status: 401 | 403;
  message: string;
}

interface ParsedServerSentEvent {
  data: string;
  event: string;
  lastEventId: string;
}

const MAX_SERVER_SENT_EVENT_DATA_BYTES = 1024 * 1024;
// Axum's SseEvent::json_data emits the complete JSON payload as one `data: `
// line. Let a maximum-size event fit on that line, including a possible UTF-8
// BOM at the start of the stream, while keeping the independent data cap.
const MAX_SERVER_SENT_EVENT_LINE_BYTES =
  MAX_SERVER_SENT_EVENT_DATA_BYTES + "data: ".length + 3;
const DEFAULT_SERVER_SENT_EVENT_RECONNECT_DELAY_MS = 3000;

class ServerSentEventProtocolError extends Error {
  constructor(message: string) {
    super(`event stream protocol error: ${message}`);
    this.name = "ServerSentEventProtocolError";
  }
}

class TerminalServerSentEventError extends Error {
  constructor(readonly denial: ControllerStreamAccessDenied) {
    super(denial.message);
    this.name = "TerminalServerSentEventError";
  }
}

function assertServerSentEventContentType(response: Response) {
  const contentType = response.headers.get("content-type");
  const mediaType = contentType?.split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType === "text/event-stream") {
    return;
  }
  const received =
    contentType === null
      ? "missing Content-Type"
      : `Content-Type ${JSON.stringify(contentType.slice(0, 160))}`;
  throw new ServerSentEventProtocolError(
    `expected Content-Type text/event-stream; received ${received}`,
  );
}

class ServerSentEventParser {
  private readonly lineBuffer = new Uint8Array(
    MAX_SERVER_SENT_EVENT_LINE_BYTES,
  );
  private lineLength = 0;
  private skipLeadingLineFeed = false;
  private atStreamStart = true;
  private readonly decoder = new TextDecoder("utf-8", {
    fatal: true,
    // Preserve a BOM so it can be removed only once, at the start of the
    // stream. Calling decode once per line must not strip later U+FEFF values.
    ignoreBOM: true,
  });
  private readonly encoder = new TextEncoder();
  private dataLines: string[] = [];
  private dataByteLength = 0;
  private eventType = "";
  private lastEventId: string;
  private pendingLastEventId: string | null = null;

  constructor(
    initialLastEventId: string,
    private readonly onEvent: (event: ParsedServerSentEvent) => void,
    private readonly onLastEventId: (lastEventId: string) => void,
    private readonly onRetry: (retryMs: number) => void,
  ) {
    this.lastEventId = initialLastEventId;
  }

  push(chunk: Uint8Array) {
    if (chunk.byteLength === 0) {
      return;
    }

    let offset = 0;
    if (this.skipLeadingLineFeed) {
      this.skipLeadingLineFeed = false;
      if (chunk[0] === 0x0a) {
        offset = 1;
      }
    }

    let segmentStart = offset;
    for (; offset < chunk.byteLength; offset += 1) {
      const byte = chunk[offset];
      if (byte !== 0x0d && byte !== 0x0a) {
        continue;
      }

      this.appendLineBytes(chunk.subarray(segmentStart, offset));
      this.processBufferedLine();

      if (byte === 0x0d) {
        if (offset + 1 < chunk.byteLength && chunk[offset + 1] === 0x0a) {
          offset += 1;
        } else if (offset + 1 === chunk.byteLength) {
          this.skipLeadingLineFeed = true;
        }
      }
      segmentStart = offset + 1;
    }
    this.appendLineBytes(chunk.subarray(segmentStart));
  }

  finish() {
    this.skipLeadingLineFeed = false;
    this.lineLength = 0;
    this.dataLines = [];
    this.dataByteLength = 0;
    this.eventType = "";
    this.pendingLastEventId = null;
  }

  private appendLineBytes(bytes: Uint8Array) {
    if (bytes.byteLength > MAX_SERVER_SENT_EVENT_LINE_BYTES - this.lineLength) {
      throw new ServerSentEventProtocolError(
        `line exceeds ${MAX_SERVER_SENT_EVENT_LINE_BYTES}-byte limit`,
      );
    }
    this.lineBuffer.set(bytes, this.lineLength);
    this.lineLength += bytes.byteLength;
  }

  private processBufferedLine() {
    const bytes = this.lineBuffer.subarray(0, this.lineLength);
    this.lineLength = 0;
    let line: string;
    try {
      line = this.decoder.decode(bytes);
    } catch {
      throw new ServerSentEventProtocolError("stream contains invalid UTF-8");
    }
    if (this.atStreamStart) {
      this.atStreamStart = false;
      if (line.startsWith("\uFEFF")) {
        line = line.slice(1);
      }
    }
    this.processLine(line);
  }

  private processLine(line: string) {
    if (line.length === 0) {
      this.dispatchEvent();
      return;
    }
    if (line.startsWith(":")) {
      return;
    }

    const separator = line.indexOf(":");
    const field = separator >= 0 ? line.slice(0, separator) : line;
    let value = separator >= 0 ? line.slice(separator + 1) : "";
    if (value.startsWith(" ")) {
      value = value.slice(1);
    }

    switch (field) {
      case "event":
        this.eventType = value;
        break;
      case "data": {
        const nextByteLength =
          this.dataByteLength +
          (this.dataLines.length > 0 ? 1 : 0) +
          this.encoder.encode(value).byteLength;
        if (nextByteLength > MAX_SERVER_SENT_EVENT_DATA_BYTES) {
          throw new ServerSentEventProtocolError(
            `event data exceeds ${MAX_SERVER_SENT_EVENT_DATA_BYTES}-byte limit`,
          );
        }
        this.dataLines.push(value);
        this.dataByteLength = nextByteLength;
        break;
      }
      case "id":
        if (!value.includes("\0")) {
          this.pendingLastEventId = value;
        }
        break;
      case "retry":
        if (/^[0-9]+$/.test(value)) {
          const retryMs = Number(value);
          if (
            Number.isSafeInteger(retryMs) &&
            retryMs >= 0 &&
            retryMs <= 2_147_483_647
          ) {
            this.onRetry(retryMs);
          }
        }
        break;
      default:
        break;
    }
  }

  private dispatchEvent() {
    const dataLines = this.dataLines;
    const eventType = this.eventType || "message";
    const pendingLastEventId = this.pendingLastEventId;
    this.dataLines = [];
    this.dataByteLength = 0;
    this.eventType = "";
    this.pendingLastEventId = null;
    if (pendingLastEventId !== null) {
      this.lastEventId = pendingLastEventId;
      this.onLastEventId(pendingLastEventId);
    }
    if (dataLines.length === 0) {
      return;
    }
    this.onEvent({
      data: dataLines.join("\n"),
      event: eventType,
      lastEventId: this.lastEventId,
    });
  }
}

export function subscribeToRunsFromController(
  params: SubscribeControllerRunsParams,
): () => void {
  if (!runtimeControllerEnabled) {
    return () => {};
  }

  if (
    typeof window === "undefined" ||
    typeof fetch === "undefined" ||
    typeof AbortController === "undefined"
  ) {
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

  let currentController: AbortController | null = null;
  let currentReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectDelayMs = DEFAULT_SERVER_SENT_EVENT_RECONNECT_DELAY_MS;
  let lastEventId = "";
  let cancelled = false;

  const scheduleReconnect = (delayMs = reconnectDelayMs) => {
    if (cancelled || reconnectTimer || isControllerDocumentReloadPending()) {
      return;
    }
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void connect();
    }, delayMs);
  };

  const connect = async () => {
    if (cancelled) {
      return;
    }

    const controller = new AbortController();
    currentController = controller;
    let opened = false;
    let url: string | null = null;
    try {
      const requestContext = await resolveControllerRequestContext(
        params.accessToken ?? null,
      );
      if (
        cancelled ||
        currentController !== controller ||
        isControllerDocumentReloadPending() ||
        !requestContext.accessToken
      ) {
        return;
      }

      url = `${requestContext.baseUrl}/events?${baseSearch.toString()}`;
      if (import.meta.env.DEV && !quietErrors) {
        // eslint-disable-next-line no-console
        console.info("[runtime-controller] event-stream url", url);
      }

      if (!quietErrors) {
        console.warn(`[runtime-controller] opening event stream url=${url}`);
      }
      const headers: Record<string, string> = {
        accept: "text/event-stream",
        authorization: `Bearer ${requestContext.accessToken}`,
      };
      if (lastEventId) {
        headers["last-event-id"] = lastEventId;
      }

      const response = await fetch(url, {
        method: "GET",
        headers,
        cache: "no-store",
        signal: controller.signal,
      });
      if (cancelled || currentController !== controller) {
        return;
      }
      // A 204 response is the EventSource protocol's explicit instruction to
      // stop reconnecting. It is not an opened stream and not an error.
      if (response.status === 204) {
        return;
      }
      if (!response.ok) {
        const responseMessage = await readControllerError(
          response,
          "event stream request failed",
        );
        const authStatus =
          response.status === 401 || response.status === 403
            ? response.status
            : null;
        let terminalAuthFailure = authStatus === 403;
        if (response.status === 401) {
          const requestCredentialIsCurrent =
            await emitControllerAuthErrorForRequest(
              {
                status: response.status,
                message: responseMessage,
                url: response.url,
              },
              requestContext,
            );
          // A rejected one-off/fixed credential will be reused unchanged, so
          // it is terminal even though it is not the document's active auth
          // binding. A stale ambient credential may reconnect only when a
          // different ambient token actually replaced it. A missing session
          // or a failed session lookup must remain terminal; otherwise the
          // reconnect resolves no token and silently leaves stale project
          // state visible.
          if (
            requestContext.credentialSource === "ambient" &&
            !requestCredentialIsCurrent
          ) {
            const replacementContext =
              await resolveControllerRequestContext(null);
            const hasReplacementAmbientCredential =
              replacementContext.credentialSource === "ambient" &&
              Boolean(replacementContext.accessToken) &&
              replacementContext.accessToken !== requestContext.accessToken;
            terminalAuthFailure = !hasReplacementAmbientCredential;
          } else {
            terminalAuthFailure = true;
          }
        }
        if (cancelled || currentController !== controller) {
          return;
        }
        if (terminalAuthFailure && authStatus !== null) {
          const denial = {
            status: authStatus,
            message: responseMessage,
          } satisfies ControllerStreamAccessDenied;
          try {
            params.onAccessDenied?.(denial);
          } catch (callbackError) {
            console.warn(
              "[runtime-controller] event stream access-denied callback failed:",
              getControllerErrorMessage(callbackError),
            );
          }
          if (cancelled || currentController !== controller) {
            return;
          }
          throw new TerminalServerSentEventError(denial);
        }
        throw new Error(responseMessage);
      }
      try {
        assertServerSentEventContentType(response);
      } catch (error) {
        void response.body?.cancel(error).catch(() => undefined);
        throw error;
      }
      if (!response.body) {
        throw new Error("event stream response body is unavailable");
      }

      opened = true;
      if (import.meta.env.DEV && !isAutomationBrowser()) {
        console.info("[runtime-controller] sse open", { url });
      }
      params.onOpen?.();
      if (cancelled || currentController !== controller) {
        return;
      }

      const parser = new ServerSentEventParser(
        lastEventId,
        (event) => {
          if (import.meta.env.DEV && !quietErrors && !isAutomationBrowser()) {
            console.info("[runtime-controller] sse message", {
              url,
              event: event.event,
              lastEventId: event.lastEventId,
            });
          }
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
        },
        (value) => {
          lastEventId = value;
        },
        (value) => {
          reconnectDelayMs = value;
        },
      );
      const reader = response.body.getReader();
      currentReader = reader;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) {
            if (cancelled || currentController !== controller) {
              return;
            }
            parser.finish();
            break;
          }
          if (value) {
            parser.push(value);
          }
          if (cancelled || currentController !== controller) {
            return;
          }
        }
      } catch (error) {
        await reader.cancel(error).catch(() => undefined);
        throw error;
      } finally {
        if (currentReader === reader) {
          currentReader = null;
        }
        reader.releaseLock();
      }

      if (!cancelled && currentController === controller) {
        throw new Error("event stream ended");
      }
    } catch (error) {
      if (
        cancelled ||
        controller.signal.aborted ||
        currentController !== controller ||
        isControllerDocumentReloadPending()
      ) {
        return;
      }
      const message = getControllerErrorMessage(error);
      const protocolError = error instanceof ServerSentEventProtocolError;
      const terminalError = error instanceof TerminalServerSentEventError;
      if (opened) {
        if (!quietErrors) {
          console.warn(`[runtime-controller] event stream error [url=${url}]`, message);
        }
        params.onError?.(protocolError ? message : "event stream error");
      } else {
        logControllerRequestError(
          "[runtime-controller] failed to open event stream:",
          error,
          { suppressLikelyConnectionNoise: true },
        );
        params.onError?.(message);
      }
      controller.abort();
      currentController = null;
      if (!terminalError) {
        scheduleReconnect(
          protocolError
            ? DEFAULT_SERVER_SENT_EVENT_RECONNECT_DELAY_MS
            : reconnectDelayMs,
        );
      }
    } finally {
      if (currentController === controller) {
        currentController = null;
      }
    }
  };

  void connect();

  return () => {
    cancelled = true;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
    }
    reconnectTimer = null;
    const reader = currentReader;
    currentReader = null;
    void reader?.cancel().catch(() => undefined);
    currentController?.abort();
    currentController = null;
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
