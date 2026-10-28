import { controllerJsonRequest } from "./client";
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
  /**
   * For a request an agent job made: milliseconds since the controller received
   * what started the job (a queued message's time in the queue included), on
   * its clock, when the request was read. A device judges how old the ask is by it.
   */
  triggerAgeMs?: number | null;
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
    triggerAgeMs:
      typeof record.triggerAgeMs === "number" && Number.isFinite(record.triggerAgeMs)
        ? record.triggerAgeMs
        : null,
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
