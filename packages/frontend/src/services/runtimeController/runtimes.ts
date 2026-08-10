import {
  coerceControllerRuntimeIdleTtlSeconds,
  ControllerApiError,
  readControllerApiError,
  readControllerError,
  resolveControllerRequestContext,
  runtimeControllerEnabled,
} from "./core";

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

  const requestContext = await resolveControllerRequestContext(
    params.accessToken ?? null,
  );
  const accessToken = requestContext.accessToken;
  if (!accessToken) {
    return null;
  }

  try {
    const response = await fetch(
      `${requestContext.baseUrl}/projects/${encodeURIComponent(params.projectId)}/runtime/status`,
      {
        signal: params.signal,
        headers: { authorization: `Bearer ${accessToken}` },
      },
    );

    if (!response.ok) {
      throw new Error(
        await readControllerError(
          response,
          "fetch runtime status failed",
          requestContext,
        ),
      );
    }

    const payload = (await response.json()) as {
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
}

export interface StartRuntimeParams {
  projectId: string;
  runtimeId: string;
  displayName?: string | null;
  provider?: string | null;
  originMode?: string | null;
  originProtocols?: string[] | null;
  originMetadata?: Record<string, unknown> | null;
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

export async function stopRuntime(
  params: StopRuntimeParams,
): Promise<boolean> {
  if (!runtimeControllerEnabled) {
    return false;
  }
  const requestContext = await resolveControllerRequestContext(
    params.accessToken ?? null,
  );
  const accessToken = requestContext.accessToken;
  if (!accessToken) {
    return false;
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
      throw new Error(
        await readControllerError(response, "stop runtime failed", requestContext),
      );
    }

    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn("[runtime-controller] stopRuntime error:", message);
    throw error;
  }
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

export async function removeRuntime(
  params: RemoveRuntimeParams,
): Promise<boolean> {
  if (!runtimeControllerEnabled) {
    return false;
  }
  const requestContext = await resolveControllerRequestContext(
    params.accessToken ?? null,
  );
  const accessToken = requestContext.accessToken;
  if (!accessToken) {
    return false;
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
      throw new Error(
        await readControllerError(response, "remove runtime failed", requestContext),
      );
    }

    return true;
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
