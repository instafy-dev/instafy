import { controllerJsonRequest } from "./client";
import {
  openControllerEventStream,
  type ControllerEventPayload,
  type ControllerStreamAccessDenied,
} from "./runs";
import type {
  ProviderResourceReadEnvelope,
  ProviderToolCallEnvelope,
} from "@instafy/provider-contract";

export type ControllerProviderRequestKind = "tool_call" | "resource_read";
export type ControllerProviderRequestStatus =
  | "pending"
  | "claimed"
  | "completed"
  | "failed"
  | "expired"
  | "canceled";

const REQUEST_STATUSES: readonly ControllerProviderRequestStatus[] = [
  "pending",
  "claimed",
  "completed",
  "failed",
  "expired",
  "canceled",
];

const CANCEL_REASONS = ["steered"] as const;
/**
 * Why a canceled request was canceled: "steered" when a person's words went
 * into its job, which goes on without it. Any other cancel gives no reason.
 */
export type ControllerProviderRequestCancelReason = (typeof CANCEL_REASONS)[number];

export interface ControllerProviderRequestRecord {
  id: string;
  projectId: string;
  providerId: string;
  requestKind: ControllerProviderRequestKind;
  toolName?: string | null;
  resourceUri?: string | null;
  arguments: Record<string, unknown>;
  status: ControllerProviderRequestStatus;
  /** Set on a canceled request. */
  cancelReason?: ControllerProviderRequestCancelReason | null;
  requestedBy?: string | null;
  /** The only device that may claim the request; absent when any device may. */
  targetDeviceId?: string | null;
  /** The agent job the request belongs to; its open requests are canceled when it ends. */
  jobId?: string | null;
  claimedByDeviceId?: string | null;
  claimedByDeviceLabel?: string | null;
  response?: Record<string, unknown> | null;
  error?: string | null;
  createdAt: string;
  claimedAt?: string | null;
  completedAt?: string | null;
  updatedAt: string;
  /** No device may claim the request, or claim it again, after this time. */
  expiresAt?: string | null;
  /** Milliseconds since the request was created, on the controller's clock, when it was read. */
  ageMs?: number | null;
}

interface DispatchProviderToolCallParams {
  projectId: string;
  providerId: string;
  name: string;
  argumentsValue?: Record<string, unknown>;
  timeoutMs?: number | null;
}

interface DispatchProviderResourceReadParams {
  projectId: string;
  providerId: string;
  uri: string;
  timeoutMs?: number | null;
}

interface ListProviderRequestsParams {
  projectId: string;
  providerId: string;
  statuses?: ControllerProviderRequestStatus[];
  limit?: number;
  /** Only the requests this device may act on. */
  deviceId?: string | null;
}

interface ClaimProviderRequestParams {
  projectId: string;
  requestId: string;
  providerId: string;
  deviceId: string;
  deviceLabel?: string | null;
}

interface CompleteProviderRequestParams {
  projectId: string;
  requestId: string;
  providerId: string;
  deviceId: string;
  response: Record<string, unknown>;
}

function normalizeRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function normalizeRequestRecord(value: unknown): ControllerProviderRequestRecord | null {
  const record = normalizeRecord(value);
  if (!record) {
    return null;
  }

  const id = typeof record.id === "string" ? record.id.trim() : "";
  const projectId = typeof record.projectId === "string" ? record.projectId.trim() : "";
  const providerId = typeof record.providerId === "string" ? record.providerId.trim() : "";
  const requestKind =
    record.requestKind === "tool_call" || record.requestKind === "resource_read"
      ? record.requestKind
      : null;
  const status = REQUEST_STATUSES.find((entry) => entry === record.status) ?? null;
  const createdAt = typeof record.createdAt === "string" ? record.createdAt.trim() : "";
  const updatedAt = typeof record.updatedAt === "string" ? record.updatedAt.trim() : "";

  if (!id || !projectId || !providerId || !requestKind || !status || !createdAt || !updatedAt) {
    return null;
  }

  return {
    id,
    projectId,
    providerId,
    requestKind,
    toolName: typeof record.toolName === "string" ? record.toolName : null,
    resourceUri: typeof record.resourceUri === "string" ? record.resourceUri : null,
    arguments: normalizeRecord(record.arguments) ?? {},
    status,
    cancelReason: CANCEL_REASONS.find((reason) => reason === record.cancelReason) ?? null,
    requestedBy: typeof record.requestedBy === "string" ? record.requestedBy : null,
    targetDeviceId: typeof record.targetDeviceId === "string" ? record.targetDeviceId : null,
    jobId: typeof record.jobId === "string" ? record.jobId : null,
    claimedByDeviceId:
      typeof record.claimedByDeviceId === "string" ? record.claimedByDeviceId : null,
    claimedByDeviceLabel:
      typeof record.claimedByDeviceLabel === "string" ? record.claimedByDeviceLabel : null,
    response: normalizeRecord(record.response) ?? null,
    error: typeof record.error === "string" ? record.error : null,
    createdAt,
    claimedAt: typeof record.claimedAt === "string" ? record.claimedAt : null,
    completedAt: typeof record.completedAt === "string" ? record.completedAt : null,
    updatedAt,
    expiresAt: typeof record.expiresAt === "string" ? record.expiresAt : null,
    ageMs:
      typeof record.ageMs === "number" && Number.isFinite(record.ageMs) ? record.ageMs : null,
  };
}

export async function dispatchControllerProviderToolCall<TValue = unknown>(
  params: DispatchProviderToolCallParams,
): Promise<ProviderToolCallEnvelope<TValue>> {
  const response = await controllerJsonRequest<unknown>({
    path: `/projects/${encodeURIComponent(params.projectId)}/provider-tools/call`,
    method: "POST",
    body: {
      providerId: params.providerId,
      name: params.name,
      arguments: params.argumentsValue ?? {},
      timeoutMs: params.timeoutMs ?? undefined,
    },
    fallbackError: "Unable to dispatch provider tool call",
  });

  if (!response.success) {
    return {
      ok: false,
      providerId: params.providerId,
      name: params.name,
      error: response.error,
    };
  }

  const value = normalizeRecord(response.value);
  return {
    ok: value?.ok === true,
    providerId:
      typeof value?.providerId === "string" ? value.providerId : params.providerId,
    name: typeof value?.name === "string" ? value.name : params.name,
    value: (value?.value as TValue | undefined) ?? undefined,
    executionContext: normalizeRecord(value?.executionContext) as
      | ProviderToolCallEnvelope<TValue>["executionContext"]
      | undefined,
    statusCode:
      typeof value?.statusCode === "number" && Number.isFinite(value.statusCode)
        ? value.statusCode
        : undefined,
    error: typeof value?.error === "string" ? value.error : undefined,
    stderr: typeof value?.stderr === "string" ? value.stderr : undefined,
  };
}

export async function dispatchControllerProviderResourceRead<TValue = unknown>(
  params: DispatchProviderResourceReadParams,
): Promise<ProviderResourceReadEnvelope<TValue>> {
  const response = await controllerJsonRequest<unknown>({
    path: `/projects/${encodeURIComponent(params.projectId)}/provider-resources/read`,
    method: "POST",
    body: {
      providerId: params.providerId,
      uri: params.uri,
      timeoutMs: params.timeoutMs ?? undefined,
    },
    fallbackError: "Unable to dispatch provider resource read",
  });

  if (!response.success) {
    return {
      ok: false,
      providerId: params.providerId,
      uri: params.uri,
      exists: false,
      error: response.error,
    };
  }

  const value = normalizeRecord(response.value);
  return {
    ok: value?.ok === true,
    providerId:
      typeof value?.providerId === "string" ? value.providerId : params.providerId,
    id: typeof value?.id === "string" ? value.id : undefined,
    uri: typeof value?.uri === "string" ? value.uri : params.uri,
    sourcePath: typeof value?.sourcePath === "string" ? value.sourcePath : undefined,
    exists: value?.exists === true,
    value: (value?.value as TValue | null | undefined) ?? undefined,
    statusCode:
      typeof value?.statusCode === "number" && Number.isFinite(value.statusCode)
        ? value.statusCode
        : undefined,
    error: typeof value?.error === "string" ? value.error : undefined,
    stderr: typeof value?.stderr === "string" ? value.stderr : undefined,
  };
}

export async function listControllerProviderRequests(
  params: ListProviderRequestsParams,
): Promise<ControllerProviderRequestRecord[]> {
  const response = await controllerJsonRequest<unknown>({
    path: `/projects/${encodeURIComponent(params.projectId)}/provider-requests`,
    searchParams: {
      providerId: params.providerId,
      statuses: (params.statuses ?? []).join(","),
      limit: params.limit ?? undefined,
      deviceId: params.deviceId ?? undefined,
    },
    fallbackError: "Unable to list provider requests",
  });

  if (!response.success || !Array.isArray(response.value)) {
    return [];
  }

  return response.value
    .map((entry) => normalizeRequestRecord(entry))
    .filter((entry): entry is ControllerProviderRequestRecord => Boolean(entry));
}

export async function claimControllerProviderRequest(
  params: ClaimProviderRequestParams,
): Promise<ControllerProviderRequestRecord | null> {
  const response = await controllerJsonRequest<unknown>({
    path: `/projects/${encodeURIComponent(params.projectId)}/provider-requests/${encodeURIComponent(params.requestId)}/claim`,
    method: "POST",
    body: {
      providerId: params.providerId,
      deviceId: params.deviceId,
      deviceLabel: params.deviceLabel ?? undefined,
    },
    fallbackError: "Unable to claim provider request",
  });

  return response.success ? normalizeRequestRecord(response.value) : null;
}

export async function completeControllerProviderRequest(
  params: CompleteProviderRequestParams,
): Promise<ControllerProviderRequestRecord | null> {
  const response = await controllerJsonRequest<unknown>({
    path: `/projects/${encodeURIComponent(params.projectId)}/provider-requests/${encodeURIComponent(params.requestId)}/complete`,
    method: "POST",
    body: {
      providerId: params.providerId,
      deviceId: params.deviceId,
      response: params.response,
    },
    fallbackError: "Unable to complete provider request",
  });

  return response.success ? normalizeRequestRecord(response.value) : null;
}

/**
 * A provider request changed: `created` when it was queued, `updated` when it
 * was claimed, completed, failed, expired or canceled. It carries where the
 * request stands, never its arguments or result: a device reads those with
 * `list` or by claiming the request.
 */
export interface ControllerProviderRequestEvent {
  kind: "created" | "updated";
  requestId: string;
  projectId: string | null;
  providerId: string;
  requestKind: ControllerProviderRequestKind | null;
  toolName: string | null;
  resourceUri: string | null;
  status: ControllerProviderRequestStatus | null;
  /** Set on a canceled request. */
  cancelReason: ControllerProviderRequestCancelReason | null;
  /** The only device that may claim the request; null when any device may. */
  targetDeviceId: string | null;
  /** When the controller published the event. */
  timestamp: string | null;
}

export interface SubscribeControllerProviderRequestsParams {
  projectId: string;
  /** Only this provider's requests; absent, every provider's. */
  providerId?: string | null;
  accessToken?: string | null;
  quietErrors?: boolean;
  onRequest: (event: ControllerProviderRequestEvent) => void;
  /**
   * The stream dropped events, some of which may have been requests: read
   * the requests again (`list`) rather than wait for the next event.
   */
  onResync?: () => void;
  onOpen?: () => void;
  /** The stream is down. It reconnects by itself unless the controller refused the credential. */
  onError?: (message: string) => void;
  /** The controller refused the credential; the stream stays closed. */
  onAccessDenied?: (denial: ControllerStreamAccessDenied) => void;
}

const REQUEST_CREATED = "provider.request.created";
const REQUEST_UPDATED = "provider.request.updated";
const EVENTS_RESYNC = "events.resync";

function eventString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** The provider request event `event` carries, or null for any other event. */
export function normalizeControllerProviderRequestEvent(
  event: ControllerEventPayload,
): ControllerProviderRequestEvent | null {
  const kind =
    event?.kind === REQUEST_CREATED ? "created" : event?.kind === REQUEST_UPDATED ? "updated" : null;
  const data = normalizeRecord(event?.data);
  if (!kind || !data) {
    return null;
  }
  const requestId = eventString(data, "requestId");
  const providerId = eventString(data, "providerId");
  if (!requestId || !providerId) {
    return null;
  }
  const requestKind = data.requestKind;
  return {
    kind,
    requestId,
    projectId: typeof event.project_id === "string" ? event.project_id : null,
    providerId,
    requestKind:
      requestKind === "tool_call" || requestKind === "resource_read" ? requestKind : null,
    toolName: eventString(data, "toolName"),
    resourceUri: eventString(data, "resourceUri"),
    status: REQUEST_STATUSES.find((status) => status === data.status) ?? null,
    cancelReason: CANCEL_REASONS.find((reason) => reason === data.cancelReason) ?? null,
    targetDeviceId: eventString(data, "targetDeviceId"),
    timestamp: typeof event.timestamp === "string" ? event.timestamp : null,
  };
}

/**
 * Subscribes to a space's provider request events over one controller event
 * stream, with the app's own credential (or `accessToken`). The controller
 * sends each event only to streams that may read the request, so an agent
 * job's request reaches its requester's streams alone. Returns the
 * unsubscribe.
 */
export function subscribeToControllerProviderRequests(
  params: SubscribeControllerProviderRequestsParams,
): () => void {
  const search = new URLSearchParams();
  search.set("projectId", params.projectId);
  for (const kind of [REQUEST_CREATED, REQUEST_UPDATED, EVENTS_RESYNC]) {
    search.append("kinds[]", kind);
  }
  return openControllerEventStream({
    search,
    projectId: params.projectId,
    accessToken: params.accessToken,
    quietErrors: params.quietErrors,
    onOpen: params.onOpen,
    onError: params.onError,
    onAccessDenied: params.onAccessDenied,
    onEvent: (event) => {
      if (event?.kind === EVENTS_RESYNC) {
        params.onResync?.();
        return;
      }
      const request = normalizeControllerProviderRequestEvent(event);
      if (!request || (params.providerId && request.providerId !== params.providerId)) {
        return;
      }
      params.onRequest(request);
    },
  });
}
