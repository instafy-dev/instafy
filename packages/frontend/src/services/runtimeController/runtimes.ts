import {
  coerceControllerRuntimeIdleTtlSeconds,
  ControllerApiError,
  readControllerApiError,
  readControllerError,
  resolveControllerRequestContext,
  runtimeControllerEnabled,
} from "./core";
import { createControllerReadBudget } from "./readBudget";

export interface FetchRuntimeStatusParams {
  projectId: string;
  accessToken?: string | null;
  signal?: AbortSignal;
  quietOnAbort?: boolean;
}

export interface RuntimeResourceUsage {
  cpuPct?: number | null;
  cpuLimitCores?: number | null;
  memoryUsedBytes?: number | null;
  memoryLimitBytes?: number | null;
  diskUsedBytes?: number | null;
  diskLimitBytes?: number | null;
  updatedAt?: string | null;
}

export interface ControllerRuntimeStatusEntry {
  runtimeId: string;
  status: string;
  provider: string;
  idleTtlSeconds: number;
  createdAt?: string | null;
  lastSeenAt?: string | null;
  /**
   * When the runtime's active lease was requested. Absent when it has no
   * active lease, and from controllers older than the field.
   */
  launchRequestedAt?: string | null;
  endpointUrl?: string | null;
  taskRef?: string | null;
  isLocal: boolean;
  isPrivateSelfHosted?: boolean;
  isPreferred: boolean;
  health: "online" | "idle" | "offline";
  displayName?: string | null;
  origin?: EnsureRuntimeOrigin | null;
  resources?: RuntimeResourceUsage | null;
  runtimeImage?: string | null;
  agentTokenIssuedAt?: string | null;
  agentTokenExpiresAt?: string | null;
  agentTokenTtl?: number | null;
  agentTokenScopes?: string[] | null;
}

export interface FetchRuntimeStatusResult {
  runtimes: ControllerRuntimeStatusEntry[];
  preferredRuntimeId: string | null;
}

export async function fetchRuntimeStatus(
  params: FetchRuntimeStatusParams,
): Promise<FetchRuntimeStatusResult | null> {
  if (!runtimeControllerEnabled) {
    return null;
  }

  if (params.signal?.aborted) {
    return null;
  }

  const budget = createControllerReadBudget(params.signal);
  try {
    const requestContext = await budget.wait(() => resolveControllerRequestContext(
      params.accessToken ?? null,
    ));
    const accessToken = requestContext.accessToken;
    if (!accessToken) {
      return null;
    }

    const response = await budget.wait(() => fetch(
      `${requestContext.baseUrl}/projects/${encodeURIComponent(params.projectId)}/runtime/status`,
      {
        signal: budget.signal,
        headers: { authorization: `Bearer ${accessToken}` },
      },
    ));

    if (!response.ok) {
      throw new Error(
        await budget.wait(() => readControllerError(
          response,
          "fetch runtime status failed",
          requestContext,
        )),
      );
    }

    const payload = (await budget.wait(() => response.json())) as {
      runtimes?: ControllerRuntimeStatusEntry[];
      preferredRuntimeId?: string | null;
    };

    const runtimes = Array.isArray(payload.runtimes)
      ? payload.runtimes
          .map((entry) => {
            if (!entry || typeof entry !== "object") {
              return null;
            }
            const record = entry as ControllerRuntimeStatusEntry & {
              runtimeImage?: unknown;
            };
            const runtimeImage =
              typeof record.runtimeImage === "string" && record.runtimeImage.trim().length > 0
                ? record.runtimeImage.trim()
                : null;
            return {
              ...record,
              runtimeImage,
            } as ControllerRuntimeStatusEntry;
          })
          .filter((entry): entry is ControllerRuntimeStatusEntry => Boolean(entry))
      : [];

    return {
      runtimes,
      preferredRuntimeId: payload.preferredRuntimeId ?? null,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const lowerMessage = message.toLowerCase();
    const isDomAbort =
      typeof DOMException !== "undefined" &&
      error instanceof DOMException &&
      error.name === "AbortError";
    const abortLike =
      params.signal?.aborted ||
      isDomAbort ||
      lowerMessage.includes("abort") ||
      lowerMessage.includes("failed to fetch");
    if (params.quietOnAbort && abortLike) {
      return null;
    }
    console.warn("[runtime-controller] fetchRuntimeStatus error:", message);
    return null;
  } finally {
    budget.dispose();
  }
}

export type ControllerRuntimeLeaseScope = "exclusive" | "shared" | "tenant";

interface EnsureRuntimeParams {
  projectId: string;
  displayName?: string | null;
  idleTtlSeconds?: number | null;
  metadata?: Record<string, unknown> | null;
  accessToken?: string | null;
  signal?: AbortSignal;
  scope?: ControllerRuntimeLeaseScope | null;
  runtimeId?: string | null;
  originMode?: string | null;
  originProtocols?: string[] | null;
  originMetadata?: Record<string, unknown> | null;
  provider?: string | null;
  /**
   * Ask the controller to replace a launch that has not come up after five
   * minutes instead of handing it back. The controller decides whether the
   * launch qualifies; a younger or live one is reused as usual.
   */
  replaceStalledLaunch?: boolean;
}

export interface StartRuntimeParams {
  projectId: string;
  runtimeId: string;
  displayName?: string | null;
  provider?: string | null;
  originMode?: string | null;
  originProtocols?: string[] | null;
  originMetadata?: Record<string, unknown> | null;
  /** See EnsureRuntimeParams.replaceStalledLaunch. */
  replaceStalledLaunch?: boolean;
}

export async function startRuntime(
  params: StartRuntimeParams,
): Promise<boolean> {
  const result = await ensureRuntime({
    projectId: params.projectId,
    provider: params.provider ?? "instafy-cloud",
    displayName: params.displayName ?? undefined,
    runtimeId: params.runtimeId,
    originMode: params.originMode ?? undefined,
    originProtocols: params.originProtocols ?? undefined,
    originMetadata: params.originMetadata ?? undefined,
    replaceStalledLaunch: params.replaceStalledLaunch,
  });
  return Boolean(result);
}

export interface EnsureRuntimeResult {
  runtimeId: string;
  leaseId: string;
  status: string;
  provider: string;
  scope?: ControllerRuntimeLeaseScope;
  parentLeaseId?: string | null;
  origin?: EnsureRuntimeOrigin | null;
}

export interface EnsureRuntimeOrigin {
  status?: string | null;
  originId?: string | null;
  leaseId?: string | null;
  mode?: string | null;
  protocols: string[];
  endpoint?: string | null;
  metadata?: Record<string, unknown> | null;
}

export async function ensureRuntime(
  params: EnsureRuntimeParams,
): Promise<EnsureRuntimeResult | null> {
  if (!runtimeControllerEnabled) {
    return null;
  }
  const requestContext = await resolveControllerRequestContext(
    params.accessToken ?? null,
  );
  const accessToken = requestContext.accessToken;
  if (!accessToken) {
    return null;
  }
  const idleTtlSeconds = coerceControllerRuntimeIdleTtlSeconds(params.idleTtlSeconds);
  const payload: Record<string, unknown> = {
    project_id: params.projectId,
    provider: params.provider ?? undefined,
    display_name: params.displayName ?? undefined,
    idle_ttl_seconds: idleTtlSeconds,
    metadata: params.metadata ?? undefined,
  };
  if (params.scope) payload.scope = params.scope;
  const runtimeIdTrimmed = params.runtimeId?.trim();
  if (runtimeIdTrimmed) payload.runtime_id = runtimeIdTrimmed;
  if (typeof params.originMode === "string" && params.originMode.trim().length > 0) {
    payload.origin_mode = params.originMode;
  }
  if (Array.isArray(params.originProtocols) && params.originProtocols.length > 0) {
    payload.origin_protocols = params.originProtocols;
  }
  if (params.originMetadata) {
    payload.origin_metadata = params.originMetadata;
  }
  if (params.replaceStalledLaunch === true) {
    payload.replaceStalledLaunch = true;
  }
  try {
    const response = await fetch(`${requestContext.baseUrl}/runtime/ensure`, {
      method: "POST",
      signal: params.signal,
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      const errorPayload = await readControllerApiError(
        response,
        "Unable to ensure runtime",
        requestContext,
      );
      throw new ControllerApiError(errorPayload);
    }
    const body = await response.json().catch(() => null);
    if (!body) {
      return null;
    }
    return mapEnsureRuntimeResult(body, params.scope ?? null);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn("[runtime-controller] ensureRuntime error:", message);
    throw error instanceof Error ? error : new Error(message);
  }
}

export interface StopRuntimeParams {
  runtimeId: string;
  reason?: string | null;
  accessToken?: string | null;
}

/**
 * What a stop did to keep the workspace's work (the controller's `flush`,
 * see docs/Runtime-Machines.md). `status` is `flushed` (the origin
 * answered), `no_writer`, `failed`, `skipped` or `not_running`;
 * `unpushedRefs` counts the recovery refs still only on the machine's disk,
 * null when unknown; `error` is a fixed code such as `origin_timeout`.
 */
export interface RuntimeStopFlush {
  status: string;
  unpushedRefs: number | null;
  error: string | null;
}

export interface StopRuntimeResult {
  /** Null from a controller that predates the flush, or an answer without one. */
  flush: RuntimeStopFlush | null;
}

function parseRuntimeStopFlush(value: unknown): RuntimeStopFlush | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const flush = value as { status?: unknown; unpushedRefs?: unknown; error?: unknown };
  if (typeof flush.status !== "string" || !flush.status.trim()) {
    return null;
  }
  return {
    status: flush.status.trim(),
    unpushedRefs:
      typeof flush.unpushedRefs === "number" && Number.isInteger(flush.unpushedRefs) && flush.unpushedRefs >= 0
        ? flush.unpushedRefs
        : null,
    error: typeof flush.error === "string" && flush.error.trim() ? flush.error.trim() : null,
  };
}

/** Null when nothing was asked (no controller, or signed out). */
export async function stopRuntime(
  params: StopRuntimeParams,
): Promise<StopRuntimeResult | null> {
  if (!runtimeControllerEnabled) {
    return null;
  }
  const requestContext = await resolveControllerRequestContext(
    params.accessToken ?? null,
  );
  const accessToken = requestContext.accessToken;
  if (!accessToken) {
    return null;
  }

  try {
    const response = await fetch(`${requestContext.baseUrl}/runtime/stop`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        runtime_id: params.runtimeId,
        reason: params.reason ?? undefined,
      }),
    });

    if (!response.ok) {
      const releasePending =
        response.status === 502 ? await readReleasePendingStop(response.clone()) : null;
      if (releasePending) {
        throw new ControllerApiError({
          status: response.status,
          message: "runtime provider cleanup is still pending",
          code: RUNTIME_STOP_RELEASE_PENDING,
          details: releasePending,
          url: response.url,
        });
      }
      // Keep status and code on the error so callers can tell a controller
      // refusal (409: nothing left to release) apart from a transport failure.
      throw new ControllerApiError(
        await readControllerApiError(response, "stop runtime failed", requestContext),
      );
    }

    const body = (await response.json().catch(() => null)) as { flush?: unknown } | null;
    return { flush: parseRuntimeStopFlush(body?.flush) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn("[runtime-controller] stopRuntime error:", message);
    throw error;
  }
}

/** The controller's `skip_reason` for a stop whose provider release is still pending. */
const RUNTIME_STOP_RELEASE_PENDING = "provider_cleanup_pending";
/** The controller's 502 when a removal's provider release is still pending. */
const RUNTIME_REMOVE_RELEASE_PENDING_MESSAGE = "runtime provider cleanup is still pending; retry removal";
/** The controller's 409 when the machine's lease generation was already released. */
const RUNTIME_LEASE_NO_LONGER_CURRENT = "runtime lease generation is no longer current";

/** What a 502 stop answer kept, when it is the controller's release-pending answer. */
async function readReleasePendingStop(response: Response): Promise<StopRuntimeResult | null> {
  const body = (await response.json().catch(() => null)) as {
    skip_reason?: unknown;
    flush?: unknown;
  } | null;
  return body?.skip_reason === RUNTIME_STOP_RELEASE_PENDING
    ? { flush: parseRuntimeStopFlush(body.flush) }
    : null;
}

/**
 * What a stop or removal that answered `error` still did, or null when it may
 * have changed nothing. The controller commits a stop's quarantine (the
 * machine fenced off, its running turn put back in the queue) before it asks
 * the provider to release the machine, so two error answers follow a stop
 * that took effect: a 502 `provider_cleanup_pending`, when that release
 * failed or ran out of time and the next ensure or a sweep retries it, and a
 * 409 "runtime lease generation is no longer current", when another stop
 * released the same machine first. After any other failure the machine may
 * still be running.
 */
export function committedRuntimeStop(error: unknown): StopRuntimeResult | null {
  if (!(error instanceof ControllerApiError)) {
    return null;
  }
  if (error.code === RUNTIME_STOP_RELEASE_PENDING) {
    const details = error.details as Partial<StopRuntimeResult> | null;
    return { flush: details?.flush ?? null };
  }
  if (error.status === 409 && error.message.trim().toLowerCase() === RUNTIME_LEASE_NO_LONGER_CURRENT) {
    return { flush: null };
  }
  return null;
}

export interface StopRuntimeIfIdleResult {
  statusChanged: boolean;
  skipReason: string | null;
}

export interface StopRuntimeIfIdleParams extends StopRuntimeParams {
  expectedProjectId: string;
  expectedProvider: string;
  expectedDisplayName: string;
}

export async function stopRuntimeIfIdle(
  params: StopRuntimeIfIdleParams,
): Promise<StopRuntimeIfIdleResult | null> {
  if (!runtimeControllerEnabled) {
    return null;
  }
  const requestContext = await resolveControllerRequestContext(
    params.accessToken ?? null,
  );
  const accessToken = requestContext.accessToken;
  if (!accessToken) {
    return null;
  }

  try {
    const response = await fetch(`${requestContext.baseUrl}/runtime/stop`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        runtime_id: params.runtimeId,
        reason: params.reason ?? undefined,
        skip_if_active_jobs: true,
        expected_project_id: params.expectedProjectId,
        expected_provider: params.expectedProvider,
        expected_display_name: params.expectedDisplayName,
      }),
    });

    if (!response.ok) {
      throw new Error(
        await readControllerError(
          response,
          "stop idle runtime failed",
          requestContext,
        ),
      );
    }

    const body = (await response.json().catch(() => null)) as {
      status_changed?: unknown;
      skip_reason?: unknown;
    } | null;
    if (!body || typeof body.status_changed !== "boolean") {
      throw new Error("stop idle runtime returned an invalid response");
    }
    const skipReason =
      typeof body.skip_reason === "string" && body.skip_reason.trim().length > 0
        ? body.skip_reason.trim()
        : null;

    return {
      statusChanged: body.status_changed,
      skipReason,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn("[runtime-controller] stopRuntimeIfIdle error:", message);
    throw error;
  }
}

export interface RemoveRuntimeParams {
  runtimeId: string;
  reason?: string | null;
  accessToken?: string | null;
}

/**
 * Null when nothing was asked (no controller, or signed out). A removal stops
 * the machine first, so it answers what that stop kept, and its error answers
 * read like a stop's (committedRuntimeStop).
 */
export async function removeRuntime(
  params: RemoveRuntimeParams,
): Promise<StopRuntimeResult | null> {
  if (!runtimeControllerEnabled) {
    return null;
  }
  const requestContext = await resolveControllerRequestContext(
    params.accessToken ?? null,
  );
  const accessToken = requestContext.accessToken;
  if (!accessToken) {
    return null;
  }

  try {
    const response = await fetch(`${requestContext.baseUrl}/runtime/remove`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        runtimeId: params.runtimeId,
        reason: params.reason ?? undefined,
      }),
    });

    if (!response.ok) {
      const failure = await readControllerApiError(response, "remove runtime failed", requestContext);
      // The controller names a removal whose release is still pending only in
      // its message; give it the code a stop's answer carries.
      throw new ControllerApiError(
        response.status === 502 && failure.message === RUNTIME_REMOVE_RELEASE_PENDING_MESSAGE
          ? { ...failure, code: RUNTIME_STOP_RELEASE_PENDING, details: { flush: null } }
          : failure,
      );
    }

    const body = (await response.json().catch(() => null)) as { flush?: unknown } | null;
    return { flush: parseRuntimeStopFlush(body?.flush) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn("[runtime-controller] removeRuntime error:", message);
    throw error;
  }
}

function parseEnsureOrigin(raw: unknown): EnsureRuntimeOrigin | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const value = raw as Record<string, unknown>;
  const status = typeof value.status === "string" ? value.status : null;
  const originId =
    typeof value.originId === "string"
      ? value.originId
      : typeof value.origin_id === "string"
        ? value.origin_id
        : null;
  const leaseId =
    typeof value.leaseId === "string"
      ? value.leaseId
      : typeof value.lease_id === "string"
        ? value.lease_id
        : null;
  const mode = typeof value.mode === "string" ? value.mode : null;
  const endpoint = typeof value.endpoint === "string" ? value.endpoint : null;
  const protocols = Array.isArray(value.protocols)
    ? value.protocols.filter((item): item is string => typeof item === "string")
    : [];
  const metadata =
    value.metadata && typeof value.metadata === "object"
      ? (value.metadata as Record<string, unknown>)
      : null;
  if (!status && !originId && !leaseId && !mode && !endpoint && protocols.length === 0 && !metadata) {
    return null;
  }
  return {
    status,
    originId,
    leaseId,
    mode,
    protocols,
    endpoint,
    metadata,
  };
}

function mapEnsureRuntimeResult(
  raw: unknown,
  fallbackScope: ControllerRuntimeLeaseScope | null,
): EnsureRuntimeResult | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const value = raw as Record<string, unknown>;
  const runtimeIdRaw =
    typeof value.runtime_id === "string"
      ? value.runtime_id
      : typeof value.runtimeId === "string"
        ? value.runtimeId
        : "";
  const leaseIdRaw =
    typeof value.leaseId === "string"
      ? value.leaseId
      : typeof value.lease_id === "string"
        ? value.lease_id
        : "";
  const runtimeId = runtimeIdRaw?.trim?.() ?? "";
  const leaseId = leaseIdRaw?.trim?.() ?? "";
  if (!runtimeId || !leaseId) {
    return null;
  }
  const statusRaw = typeof value.status === "string" ? value.status : "";
  const provider =
    typeof value.provider === "string" && value.provider.trim().length > 0
      ? value.provider.trim()
      : "runtime";
  const scopeRaw =
    typeof value.scope === "string" &&
    (value.scope === "exclusive" ||
      value.scope === "shared" ||
      value.scope === "tenant")
      ? (value.scope as ControllerRuntimeLeaseScope)
      : fallbackScope ?? undefined;
  const parentLeaseIdRaw =
    typeof value.parentLeaseId === "string"
      ? value.parentLeaseId
      : typeof value.parent_lease_id === "string"
        ? value.parent_lease_id
        : null;
  const originInfo = parseEnsureOrigin(value.origin);
  return {
    runtimeId,
    leaseId,
    status: statusRaw,
    provider,
    scope: scopeRaw,
    parentLeaseId: parentLeaseIdRaw ?? null,
    origin: originInfo,
  };
}

export interface DesktopRuntimeRequestOptions {
  projectId: string;
  /**
   * The already-registered self-hosted runtime this request is about. The
   * controller refuses a self-hosted request that names no runtime — such a
   * machine only exists once it has called POST /runtime/register itself — so
   * omitting this is a guaranteed 400, not a way to ask for a new one.
   */
  runtimeId?: string | null;
  displayName?: string | null;
  idleTtlSeconds?: number | null;
  metadata?: Record<string, unknown> | null;
  originMetadata?: Record<string, unknown> | null;
  tunnelMetadata?: Record<string, unknown> | null;
  accessToken?: string | null;
}

export interface ControllerTunnelGrant {
  id: string;
  projectId: string | null;
  runtimeId: string | null;
  runtimeLeaseId: string | null;
  provider: string;
  tunnelId: string;
  hostname: string | null;
  url: string | null;
  status: string;
  expiresAt: string | null;
  metadata?: Record<string, unknown> | null;
  credentials?: Record<string, unknown> | null;
}

export interface DesktopRuntimeRequestResult {
  runtime: EnsureRuntimeResult;
  tunnel: ControllerTunnelGrant | null;
}

export async function requestDesktopRuntime(
  params: DesktopRuntimeRequestOptions,
): Promise<DesktopRuntimeRequestResult | null> {
  if (!runtimeControllerEnabled) {
    return null;
  }
  const requestContext = await resolveControllerRequestContext(
    params.accessToken ?? null,
  );
  const accessToken = requestContext.accessToken;
  if (!accessToken) {
    return null;
  }
  const idleTtlSeconds = coerceControllerRuntimeIdleTtlSeconds(params.idleTtlSeconds);
  const payload: Record<string, unknown> = {
    provider: "self-hosted",
    runtimeId: params.runtimeId ?? undefined,
    display_name: params.displayName ?? undefined,
    idle_ttl_seconds: idleTtlSeconds,
    metadata: params.metadata ?? undefined,
    origin_metadata: params.originMetadata ?? undefined,
    tunnel_metadata: params.tunnelMetadata ?? undefined,
  };
  try {
    const response = await fetch(
      `${requestContext.baseUrl}/projects/${params.projectId}/runtime/request`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${accessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(payload),
      },
    );
    if (!response.ok) {
      const errorMessage = await readControllerError(
        response,
        "Unable to request desktop runtime",
        requestContext,
      );
      throw new Error(errorMessage);
    }
    const body = await response.json().catch(() => null);
    if (!body || typeof body !== "object") {
      return null;
    }
    const runtimeResult = mapEnsureRuntimeResult(
      (body as Record<string, unknown>)["runtime"],
      "exclusive",
    );
    if (!runtimeResult) {
      return null;
    }
    const tunnel = mapTunnelGrantFromPayload(
      readRecord((body as Record<string, unknown>)["tunnel"]),
    );
    return { runtime: runtimeResult, tunnel };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn("[runtime-controller] requestDesktopRuntime error:", message);
    throw error;
  }
}

export interface SetRuntimePreferenceParams {
  projectId: string;
  runtimeId: string | null;
  accessToken?: string | null;
}

export interface ControllerRuntimePreference {
  projectId: string;
  runtimeId: string | null;
  source: string | null;
  updatedAt: string | null;
  displayName: string | null;
}

export async function setRuntimePreference(
  params: SetRuntimePreferenceParams,
): Promise<ControllerRuntimePreference | null> {
  if (!runtimeControllerEnabled) {
    return null;
  }

  const requestContext = await resolveControllerRequestContext(
    params.accessToken ?? null,
  );
  const accessToken = requestContext.accessToken;
  if (!accessToken) {
    return null;
  }

  try {
    const response = await fetch(
      `${requestContext.baseUrl}/projects/${encodeURIComponent(params.projectId)}/runtime/preference`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ runtimeId: params.runtimeId }),
      },
    );

    if (!response.ok) {
      throw new Error(
        await readControllerError(
          response,
          "set runtime preference failed",
          requestContext,
        ),
      );
    }

    const payload = (await response.json()) as ControllerRuntimePreference;
    return {
      projectId: payload.projectId,
      runtimeId: payload.runtimeId ?? null,
      source: payload.source ?? null,
      updatedAt: payload.updatedAt ?? null,
      displayName: payload.displayName ?? null,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn("[runtime-controller] setRuntimePreference error:", message);
    return null;
  }
}

export interface UpdateRuntimeActivityParams {
  projectId: string;
  status: "active" | "idle";
  idleTtlSeconds?: number;
  lastInteractionAt?: string | Date;
  accessToken?: string | null;
}

export async function updateRuntimeActivity(
  params: UpdateRuntimeActivityParams,
): Promise<boolean> {
  if (!runtimeControllerEnabled) {
    return false;
  }

  const requestContext = await resolveControllerRequestContext(
    params.accessToken ?? null,
  );
  const sessionToken = requestContext.accessToken;

  if (!sessionToken) {
    return false;
  }

  const lastInteractionAt = (() => {
    const value = params.lastInteractionAt;
    if (!value) {
      return new Date().toISOString();
    }
    if (value instanceof Date) {
      return value.toISOString();
    }
    const trimmed = value.trim();
    if (!trimmed) {
      return new Date().toISOString();
    }
    return trimmed;
  })();

  const body = {
    status: params.status,
    idleTtlSeconds: params.idleTtlSeconds,
    lastInteractionAt,
  };

  try {
    const response = await fetch(
      `${requestContext.baseUrl}/projects/${params.projectId}/runtime/activity`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${sessionToken}`,
        },
        body: JSON.stringify(body),
      },
    );

    if (!response.ok) {
      throw new Error(
        await readControllerError(
          response,
          "update runtime activity failed",
          requestContext,
        ),
      );
    }

    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(
      "[runtime-controller] update runtime activity error:",
      message,
    );
    return false;
  }
}

function readString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

export function mapTunnelGrantFromPayload(
  payload: Record<string, unknown> | null | undefined,
): ControllerTunnelGrant | null {
  const data = readRecord(payload);
  if (!data) {
    return null;
  }
  const id = readString(data["id"]) ?? readString(data["tunnelId"]);
  const tunnelId = readString(data["tunnelId"]) ?? id;
  if (!id || !tunnelId) {
    return null;
  }
  const provider = readString(data["provider"]) ?? "self_hosted";
  const hostname = readString(data["hostname"]) ?? null;
  const url = readString(data["url"]) ?? null;
  const status = (readString(data["status"]) ?? "").toLowerCase();
  const expiresAt = readString(data["expiresAt"]) ?? null;
  const metadata = readRecord(data["metadata"] ?? null);
  const credentials = readRecord(data["credentials"] ?? null);
  return {
    id,
    projectId:
      readString(data["projectId"]) ?? readString(data["project_id"]) ?? null,
    runtimeId: readString(data["runtimeId"]) ?? null,
    runtimeLeaseId:
      readString(data["runtimeLeaseId"]) ?? readString(data["leaseId"]) ?? null,
    provider,
    tunnelId,
    hostname,
    url,
    status,
    expiresAt,
    metadata,
    credentials,
  };
}
