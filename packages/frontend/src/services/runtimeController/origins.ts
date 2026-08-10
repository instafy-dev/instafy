import type {
  ControllerOriginPresence,
  ControllerOriginSummary,
  LocalWorkspacePresence,
  LocalWorkspaceStatus,
} from "../originTypes";
import {
  controllerBaseUrl,
  normalizeOriginEndpointForClient,
  readControllerError,
  resolveControllerRequestContext,
  runtimeControllerEnabled,
} from "./core";
import { logControllerRequestError } from "./logging";

export type LocalWorkspaceEventKind =
  | "local_workspace.registered"
  | "local_workspace.heartbeat"
  | "local_workspace.unregistered"
  | "local_workspace.expired";

export interface FetchLocalWorkspacePresenceParams {
  projectId: string;
  accessToken?: string | null;
}

export async function fetchLocalWorkspacePresence(
  params: FetchLocalWorkspacePresenceParams,
): Promise<LocalWorkspacePresence | null> {
  if (!runtimeControllerEnabled) {
    return null;
  }

  if (!params.projectId) {
    console.warn(
      "[runtime-controller] fetchLocalWorkspacePresence requires projectId",
    );
    return null;
  }

  const requestContext = await resolveControllerRequestContext(
    params.accessToken ?? null,
  );
  const resolvedAccessToken = requestContext.accessToken;
  if (!resolvedAccessToken) {
    return null;
  }
  const url = `${requestContext.baseUrl}/projects/${encodeURIComponent(params.projectId)}/workspaces/local`;

  try {
    const response = await fetch(url, {
      headers: { authorization: `Bearer ${resolvedAccessToken}` },
    });

    if (response.status === 404) {
      return null;
    }
    if (response.status === 401) {
      await readControllerError(
        response,
        "fetch local workspace failed",
        requestContext,
      );
      return null;
    }
    if (response.status === 403) {
      return null;
    }

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(
        `fetch local workspace failed (${response.status}): ${text}`,
      );
    }

    const payload = (await response.json()) as {
      workspace?: Record<string, unknown> | null;
    };

    let workspace = mapLocalWorkspacePresenceFromPayload(
      payload?.workspace ?? null,
    );
    if (workspace) {
      // If the workspace supplies an explicit presenceStatus, treat it as source of truth
      // for the local device view and skip origin augmentation.
      if (workspace.presenceStatus) {
        return workspace;
      }
      // Otherwise, augment with origin presence to surface degraded/offline promptly.
      try {
        const origin = await fetchOriginSummary({
          projectId: params.projectId,
          protocol: "http",
          accessToken: params.accessToken ?? null,
        });
        if (origin && origin.presence) {
          const originStatus = origin.presence.status;
          workspace = {
            ...workspace,
            presenceStatus:
              originStatus as LocalWorkspacePresence["presenceStatus"],
            status: originStatus === "offline" ? "offline" : workspace.status,
          };
        }
      } catch (_mergeError) {
        // Non-fatal: fall back to controller workspace-only signal.
      }
      return workspace;
    }
    return null;
  } catch (error) {
    logControllerRequestError("[runtime-controller] fetchLocalWorkspacePresence error:", error, {
      suppressLikelyConnectionNoise: true,
    });
    return null;
  }
}

export interface FetchOriginParams {
  projectId: string;
  protocol?: "webdav" | "http" | "smb";
  accessToken?: string | null;
}

export interface RequestOriginAccessTokenParams {
  projectId: string;
  protocol?: "webdav" | "http" | "smb";
  scopes: Array<"fs.read" | "fs.write" | "browser.view" | "browser.control">;
  originId?: string | null;
  preferHosted?: boolean | null;
  leaseId?: string | null;
  preferRuntime?: string | null;
  browserSessionId?: string | null;
  accessToken?: string | null;
  forceRefresh?: boolean;
  timeoutMs?: number;
}

export interface OriginAccessTokenResponse {
  originId: string;
  endpoint: string;
  mode: string;
  token: string;
  expiresIn: number;
  scopes: string[];
  leaseId?: string | null;
}

type OriginAccessTokenCacheEntry = {
  value: OriginAccessTokenResponse;
  expiresAtMs: number;
};

// Studio polls controller-backed origin endpoints (git status, etc) on an interval. Those
// calls mint an origin access token (default TTL is minutes). Cache read-only tokens to avoid
// hammering the controller DB pool with redundant `/access_token` requests.
const ORIGIN_ACCESS_TOKEN_REFRESH_BUFFER_MS = 30_000;
const ORIGIN_ACCESS_TOKEN_REQUEST_TIMEOUT_MS = 20_000;
const originAccessTokenCache = new Map<string, OriginAccessTokenCacheEntry>();
const originAccessTokenInFlight = new Map<
  string,
  Promise<OriginAccessTokenResponse | null>
>();

function buildControllerOriginProxyEndpoint(
  originId: string,
  controllerUrl = controllerBaseUrl,
): string {
  const normalizedOriginId = originId.trim();
  if (!normalizedOriginId) {
    return "";
  }
  const base = controllerUrl.replace(/\/+$/, "");
  if (!base) {
    return "";
  }
  const encodedOriginId = encodeURIComponent(normalizedOriginId);
  try {
    const url = new URL(base);
    url.pathname = `/origin/${encodedOriginId}`;
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/+$/, "");
  } catch (_error) {
    return `${base}/origin/${encodedOriginId}`;
  }
}

function fnv1a32(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16);
}

function shouldCacheOriginAccessToken(params: RequestOriginAccessTokenParams): boolean {
  // Browser control mutates only the ephemeral Chromium session, so it is
  // lease-free and safe to cache like observation/file-read grants. Workspace
  // write tokens remain uncached to avoid lease ownership edge cases.
  if (params.leaseId) {
    return false;
  }
  return params.scopes.length > 0 && !params.scopes.includes("fs.write");
}

function buildOriginAccessTokenCacheKey(params: {
  projectId: string;
  protocol: string;
  scopes: string[];
  originId: string | null;
  preferHosted: boolean;
  preferRuntime: string | null;
  browserSessionId: string | null;
  controllerAccessToken: string | null;
}): string {
  const scopeKey = params.scopes.slice().sort().join(",");
  const accessKey = params.controllerAccessToken
    ? fnv1a32(params.controllerAccessToken)
    : "anon";
  return [
    "v1",
    params.projectId,
    params.protocol,
    scopeKey,
    params.originId ?? "",
    params.preferHosted ? "hosted" : "",
    params.preferRuntime ?? "",
    params.browserSessionId ?? "",
    accessKey,
  ].join("|");
}

export async function fetchOriginSummary(
  params: FetchOriginParams,
): Promise<ControllerOriginSummary | null> {
  if (!runtimeControllerEnabled) {
    return null;
  }

  const { projectId } = params;
  if (!projectId || projectId.trim().length === 0) {
    throw new Error("projectId is required to fetch origin summary");
  }

  const search = new URLSearchParams();
  const protocol = params.protocol ?? "webdav";
  if (protocol) {
    search.set("protocol", protocol);
  }

  const requestContext = await resolveControllerRequestContext(
    params.accessToken ?? null,
  );
  const accessToken = requestContext.accessToken;
  if (!accessToken) {
    return null;
  }
  const headers: Record<string, string> = {
    authorization: `Bearer ${accessToken}`,
  };

  const basePath = `${requestContext.baseUrl}/projects/${encodeURIComponent(projectId)}/origin`;
  const query = search.toString();
  const url = query.length > 0 ? `${basePath}?${query}` : basePath;

  try {
    const response = await fetch(url, { headers });
    if (response.status === 404) {
      return null;
    }
    if (response.status === 401) {
      await readControllerError(response, "fetch origin failed", requestContext);
      return null;
    }
    if (response.status === 403) {
      return null;
    }
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`fetch origin failed (${response.status}): ${text}`);
    }

    const payload = (await response.json()) as Record<string, unknown>;
    const originId =
      typeof payload.origin_id === "string"
        ? payload.origin_id
        : typeof payload.originId === "string"
          ? payload.originId
          : "";
    const endpointRaw =
      typeof payload.endpoint === "string" ? payload.endpoint : "";
    const endpointNormalized = normalizeOriginEndpointForClient(endpointRaw);
    const endpoint =
      buildControllerOriginProxyEndpoint(originId, requestContext.baseUrl) ||
      endpointNormalized;
    const mode = typeof payload.mode === "string" ? payload.mode : "unknown";
    const runtimeId =
      typeof payload.runtime_id === "string"
        ? payload.runtime_id
        : typeof payload.runtimeId === "string"
          ? payload.runtimeId
          : null;
    const protocols = Array.isArray(payload.protocols)
      ? (payload.protocols as unknown[]).map((value) => String(value))
      : undefined;
    const region =
      typeof payload.region === "string"
        ? payload.region
        : payload.region === null
          ? null
          : undefined;
    const deviceId =
      typeof payload.device_id === "string"
        ? payload.device_id
        : typeof payload.deviceId === "string"
          ? payload.deviceId
          : undefined;
    const metadata =
      payload.metadata &&
      typeof payload.metadata === "object" &&
      !Array.isArray(payload.metadata)
        ? (payload.metadata as Record<string, unknown>)
        : undefined;
    const presencePayload =
      payload.presence &&
      typeof payload.presence === "object" &&
      !Array.isArray(payload.presence)
        ? (payload.presence as Record<string, unknown>)
        : undefined;

    let presence: ControllerOriginPresence | null = null;
    if (presencePayload) {
      const statusValue =
        typeof presencePayload.status === "string"
          ? presencePayload.status.trim().toLowerCase()
          : "";
      if (
        statusValue === "online" ||
        statusValue === "offline" ||
        statusValue === "degraded"
      ) {
        presence = {
          status: statusValue as ControllerOriginPresence["status"],
          lastHeartbeat:
            typeof presencePayload.last_heartbeat === "string"
              ? presencePayload.last_heartbeat
              : typeof presencePayload.lastHeartbeat === "string"
                ? presencePayload.lastHeartbeat
                : undefined,
          latencyMs:
            typeof presencePayload.latency_ms === "number"
              ? presencePayload.latency_ms
              : typeof presencePayload.latencyMs === "number"
                ? presencePayload.latencyMs
                : undefined,
          region:
            typeof presencePayload.region === "string"
              ? presencePayload.region
              : presencePayload.region === null
                ? null
                : undefined,
          metadata:
            presencePayload.metadata &&
            typeof presencePayload.metadata === "object" &&
            !Array.isArray(presencePayload.metadata)
              ? (presencePayload.metadata as Record<string, unknown>)
              : undefined,
        };
      }
    }

    if (!originId || !endpoint) {
      throw new Error("origin response missing required fields");
    }

    return {
      originId,
      runtimeId,
      endpoint,
      mode,
      protocols,
      region: region ?? null,
      deviceId: deviceId ?? null,
      metadata: metadata ?? null,
      presence,
    };
  } catch (error) {
    logControllerRequestError("[runtime-controller] fetchOriginSummary error:", error, {
      suppressLikelyConnectionNoise: true,
    });
    return null;
  }
}

export async function requestOriginAccessToken(
  params: RequestOriginAccessTokenParams,
): Promise<OriginAccessTokenResponse | null> {
  if (!runtimeControllerEnabled) {
    return null;
  }

  const { projectId, scopes } = params;
  if (!projectId || projectId.trim().length === 0) {
    throw new Error("projectId is required to request an origin access token");
  }
  if (!scopes || scopes.length === 0) {
    throw new Error("scopes are required to request an origin access token");
  }

  const protocol = params.protocol ?? "webdav";
  const requestContext = await resolveControllerRequestContext(
    params.accessToken ?? null,
  );
  const accessToken = requestContext.accessToken;
  if (!accessToken) {
    return null;
  }

  const cacheKey = shouldCacheOriginAccessToken(params)
    ? buildOriginAccessTokenCacheKey({
        projectId: projectId.trim(),
        protocol,
        scopes,
        originId: params.originId ?? null,
        preferHosted: params.preferHosted === true,
        preferRuntime: params.preferRuntime ?? null,
        browserSessionId: params.browserSessionId ?? null,
        controllerAccessToken: accessToken,
      })
    : null;

  const requestTimeoutMs =
    typeof params.timeoutMs === "number" && Number.isFinite(params.timeoutMs) && params.timeoutMs > 0
      ? params.timeoutMs
      : ORIGIN_ACCESS_TOKEN_REQUEST_TIMEOUT_MS;
  const inFlightKey = cacheKey ? `${cacheKey}|timeout:${requestTimeoutMs}` : null;

  if (cacheKey && params.forceRefresh !== true) {
    const cached = originAccessTokenCache.get(cacheKey);
    if (
      cached &&
      cached.expiresAtMs - Date.now() > ORIGIN_ACCESS_TOKEN_REFRESH_BUFFER_MS
    ) {
      const remainingSeconds = Math.max(
        0,
        Math.floor((cached.expiresAtMs - Date.now()) / 1000),
      );
      return { ...cached.value, expiresIn: remainingSeconds };
    }

    const inFlight = inFlightKey ? originAccessTokenInFlight.get(inFlightKey) : null;
    if (inFlight) {
      return await inFlight;
    }
  } else if (cacheKey) {
    originAccessTokenCache.delete(cacheKey);
  }

  const headers: Record<string, string> = {
    "content-type": "application/json",
    authorization: `Bearer ${accessToken}`,
  };

  const body: Record<string, unknown> = {
    projectId,
    protocol,
    scopes,
  };
  if (params.originId) {
    body.originId = params.originId;
  }
  if (params.preferHosted === true) {
    body.preferHosted = true;
  }
  if (params.leaseId) {
    body.leaseId = params.leaseId;
  }
  if (params.preferRuntime) {
    body.preferRuntime = params.preferRuntime;
  }
  if (params.browserSessionId) {
    body.browserSessionId = params.browserSessionId;
  }

  const run = async (): Promise<OriginAccessTokenResponse | null> => {
    try {
      const abortController =
        typeof AbortController === "function" ? new AbortController() : null;
      const timeoutHandle =
        abortController !== null
          ? setTimeout(() => {
              abortController.abort();
            }, requestTimeoutMs)
          : null;

      const response = await fetch(`${requestContext.baseUrl}/access_token`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: abortController?.signal,
      }).finally(() => {
        if (timeoutHandle !== null) {
          clearTimeout(timeoutHandle);
        }
      });

      if (response.status === 404) {
        return null;
      }
      if (!response.ok) {
        throw new Error(
          await readControllerError(
            response,
            "request origin access token failed",
            requestContext,
          ),
        );
      }

      const payload = (await response.json()) as Record<string, unknown>;
      const originId =
        typeof payload.origin_id === "string"
          ? payload.origin_id
          : typeof payload.originId === "string"
            ? payload.originId
            : "";
      const endpointRaw = typeof payload.endpoint === "string" ? payload.endpoint : "";
      const endpointNormalized = normalizeOriginEndpointForClient(endpointRaw);
      // Always route browser requests through the controller origin proxy so the UI never
      // talks to private runtime hosts directly (avoids mixed-content/CORS regressions).
      const endpoint =
        buildControllerOriginProxyEndpoint(originId, requestContext.baseUrl) ||
        endpointNormalized;
      const mode = typeof payload.mode === "string" ? payload.mode : "unknown";
      const tokenValue = typeof payload.token === "string" ? payload.token : "";
      const expiresIn =
        typeof payload.expires_in === "number"
          ? payload.expires_in
          : typeof payload.expiresIn === "number"
            ? payload.expiresIn
            : 0;
      const leaseId =
        typeof payload.lease_id === "string"
          ? payload.lease_id
          : typeof payload.leaseId === "string"
            ? payload.leaseId
            : null;
      const scopesResponse = Array.isArray(payload.scopes)
        ? (payload.scopes as unknown[]).map((value) => String(value))
        : undefined;

      if (!originId || !endpoint || !tokenValue) {
        throw new Error("origin access token response missing required fields");
      }

      const value: OriginAccessTokenResponse = {
        originId,
        endpoint,
        mode,
        token: tokenValue,
        expiresIn:
          typeof expiresIn === "number" && Number.isFinite(expiresIn) ? expiresIn : 0,
        scopes: scopesResponse ?? scopes,
        leaseId: leaseId ?? null,
      };

      if (cacheKey && value.expiresIn > 0) {
        originAccessTokenCache.set(cacheKey, {
          value,
          expiresAtMs: Date.now() + value.expiresIn * 1000,
        });
      }

      return value;
    } catch (error) {
      const message =
        error instanceof Error && error.name === "AbortError"
          ? `request origin access token timed out after ${requestTimeoutMs}ms`
          : error instanceof Error
            ? error.message
            : String(error);
      console.warn("[runtime-controller] requestOriginAccessToken error:", message);
      return null;
    }
  };

  if (inFlightKey && params.forceRefresh !== true) {
    const promise = run().finally(() => {
      originAccessTokenInFlight.delete(inFlightKey);
    });
    originAccessTokenInFlight.set(inFlightKey, promise);
    return await promise;
  }

  return await run();
}

export function mapLocalWorkspacePresenceFromPayload(
  payload: Record<string, unknown> | null | undefined,
  fallbackStatus?: LocalWorkspaceStatus,
): LocalWorkspacePresence | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const data = payload as Record<string, unknown>;
  const deviceId =
    typeof data.deviceId === "string" ? data.deviceId.trim() : "";
  if (!deviceId) {
    return null;
  }

  const path = typeof data.path === "string" ? data.path : undefined;
  const hostname =
    typeof data.hostname === "string" ? data.hostname : undefined;
  const platform =
    typeof data.platform === "string" ? data.platform : undefined;
  const release = typeof data.release === "string" ? data.release : undefined;
  const arch = typeof data.arch === "string" ? data.arch : undefined;
  const lastHeartbeat =
    typeof data.lastHeartbeat === "string" ? data.lastHeartbeat : undefined;
  const expiresAt =
    typeof data.expiresAt === "string" ? data.expiresAt : undefined;
  const runtimeId =
    typeof data.runtimeId === "string" ? data.runtimeId : undefined;
  const region = typeof data.region === "string" ? data.region : undefined;
  const latencyMs =
    typeof data.latencyMs === "number" ? data.latencyMs : undefined;
  const metadata =
    data.metadata &&
    typeof data.metadata === "object" &&
    !Array.isArray(data.metadata)
      ? (data.metadata as Record<string, unknown>)
      : undefined;
  const presenceStatus = normalizeOriginPresenceStatusValue(
    typeof data.presenceStatus !== "undefined"
      ? data.presenceStatus
      : metadata && typeof metadata.presenceStatus === "string"
        ? metadata.presenceStatus
        : undefined,
  );
  const statusRaw = normalizeLocalWorkspaceStatusValue(data.status);
  const status = determineLocalWorkspaceStatus(
    statusRaw,
    fallbackStatus,
    expiresAt,
  );

  return {
    deviceId,
    path,
    hostname,
    platform,
    release,
    arch,
    lastHeartbeat,
    expiresAt,
    runtimeId,
    region,
    latencyMs,
    metadata: metadata ?? null,
    presenceStatus: presenceStatus ?? null,
    status,
  };
}

function normalizeLocalWorkspaceStatusValue(
  value: unknown,
): LocalWorkspaceStatus | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (
    normalized === "online" ||
    normalized === "offline" ||
    normalized === "expired"
  ) {
    return normalized as LocalWorkspaceStatus;
  }
  return undefined;
}

function determineLocalWorkspaceStatus(
  explicit: LocalWorkspaceStatus | undefined,
  fallback: LocalWorkspaceStatus | undefined,
  expiresAt?: string,
): LocalWorkspaceStatus {
  if (explicit) {
    return explicit;
  }
  if (fallback) {
    return fallback;
  }
  if (expiresAt) {
    const timestamp = Date.parse(expiresAt);
    if (!Number.isNaN(timestamp)) {
      return timestamp > Date.now() ? "online" : "expired";
    }
  }
  return "online";
}

function normalizeOriginPresenceStatusValue(
  value: unknown,
): ControllerOriginPresence["status"] | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (
    normalized === "online" ||
    normalized === "offline" ||
    normalized === "degraded"
  ) {
    return normalized as ControllerOriginPresence["status"];
  }
  return undefined;
}

export function mapOriginSummaryFromPayload(
  payload: Record<string, unknown> | null | undefined,
): ControllerOriginSummary | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const data = payload as Record<string, unknown>;
  const originIdSource =
    typeof data["originId"] === "string"
      ? (data["originId"] as string)
      : typeof data["origin_id"] === "string"
        ? (data["origin_id"] as string)
        : "";
  const originIdRaw = originIdSource.trim();
  const endpointRaw =
    typeof data["endpoint"] === "string"
      ? (data["endpoint"] as string)
      : typeof data["originEndpoint"] === "string"
        ? (data["originEndpoint"] as string)
        : "";
  const endpointNormalized = normalizeOriginEndpointForClient(endpointRaw);
  const endpointForClient =
    buildControllerOriginProxyEndpoint(originIdRaw) || endpointNormalized;
  if (!originIdRaw || !endpointForClient) {
    return null;
  }

  const modeRaw =
    typeof data["mode"] === "string"
      ? (data["mode"] as string).trim()
      : typeof data["originMode"] === "string"
        ? (data["originMode"] as string).trim()
        : "";
  const mode = modeRaw || "desktop";
  const runtimeId =
    typeof data["runtimeId"] === "string"
      ? (data["runtimeId"] as string).trim() || null
      : typeof data["runtime_id"] === "string"
        ? (data["runtime_id"] as string).trim() || null
        : null;

  const protocolsSourceValue = Array.isArray(data["protocols"])
    ? (data["protocols"] as unknown[])
    : Array.isArray(data["originProtocols"])
      ? (data["originProtocols"] as unknown[])
      : [];
  const protocols = protocolsSourceValue
    .map((value) => {
      if (typeof value === "string") {
        return value.trim();
      }
      if (value == null) {
        return "";
      }
      return String(value).trim();
    })
    .filter((value) => value.length > 0);

  const region =
    typeof data["region"] === "string"
      ? (data["region"] as string)
      : data["region"] === null
        ? null
        : undefined;
  const deviceId =
    typeof data["deviceId"] === "string"
      ? (data["deviceId"] as string)
      : typeof data["device_id"] === "string"
        ? (data["device_id"] as string)
        : undefined;
  const metadata =
    data["metadata"] &&
    typeof data["metadata"] === "object" &&
    !Array.isArray(data["metadata"])
      ? (data["metadata"] as Record<string, unknown>)
      : undefined;

  const presencePayload =
    data["presence"] &&
    typeof data["presence"] === "object" &&
    !Array.isArray(data["presence"])
      ? (data["presence"] as Record<string, unknown>)
      : undefined;
  let presence: ControllerOriginPresence | null = null;
  if (presencePayload) {
    const status = normalizeOriginPresenceStatusValue(
      presencePayload["status"],
    );
    const lastHeartbeat =
      typeof presencePayload["lastHeartbeat"] === "string"
        ? (presencePayload["lastHeartbeat"] as string)
        : typeof presencePayload["last_heartbeat"] === "string"
          ? (presencePayload["last_heartbeat"] as string)
          : undefined;
    const latencyMs =
      typeof presencePayload["latencyMs"] === "number"
        ? (presencePayload["latencyMs"] as number)
        : typeof presencePayload["latency_ms"] === "number"
          ? (presencePayload["latency_ms"] as number)
          : undefined;
    const presenceRegion =
      typeof presencePayload["region"] === "string"
        ? (presencePayload["region"] as string)
        : presencePayload["region"] === null
          ? null
          : undefined;
    const presenceMetadata =
      presencePayload["metadata"] &&
      typeof presencePayload["metadata"] === "object" &&
      !Array.isArray(presencePayload["metadata"])
        ? (presencePayload["metadata"] as Record<string, unknown>)
        : undefined;

    if (status) {
      presence = {
        status,
        lastHeartbeat: lastHeartbeat ?? null,
        latencyMs: latencyMs ?? null,
        region: presenceRegion ?? null,
        metadata: presenceMetadata ?? null,
      };
    }
  }

  return {
    originId: originIdRaw,
    runtimeId,
    endpoint: endpointForClient,
    mode,
    protocols,
    region: region ?? null,
    deviceId: deviceId ?? null,
    metadata: metadata ?? null,
    presence,
  };
}

// Treat origins as offline when the controller has not seen a heartbeat for 20s.
// Default heartbeat interval is 5s, so this covers four missed beats before we demote.
const ORIGIN_PRESENCE_STALE_THRESHOLD_MS = 20_000;

export function mapOriginSummaryToLocalWorkspacePresence(
  summary: ControllerOriginSummary | null | undefined,
): LocalWorkspacePresence | null {
  if (!summary) {
    return null;
  }

  const metadata = summary.metadata ?? null;
  const summaryDeviceId =
    typeof summary.deviceId === "string" ? summary.deviceId.trim() : "";
  const metadataDeviceId =
    metadata && typeof metadata.deviceId === "string"
      ? (metadata.deviceId as string).trim()
      : "";
  const deviceId = summaryDeviceId || metadataDeviceId || summary.originId;
  if (!deviceId) {
    return null;
  }

  const hostname =
    metadata && typeof metadata.hostname === "string"
      ? (metadata.hostname as string)
      : undefined;
  const platform =
    metadata && typeof metadata.platform === "string"
      ? (metadata.platform as string)
      : undefined;
  const release =
    metadata && typeof metadata.release === "string"
      ? (metadata.release as string)
      : undefined;
  const arch =
    metadata && typeof metadata.arch === "string"
      ? (metadata.arch as string)
      : undefined;
  const runtimeId =
    metadata && typeof metadata.runtimeId === "string"
      ? (metadata.runtimeId as string)
      : undefined;
  const path =
    metadata && typeof metadata.path === "string"
      ? (metadata.path as string)
      : undefined;

  const presence = summary.presence ?? null;
  const lastHeartbeat =
    typeof presence?.lastHeartbeat === "string"
      ? presence.lastHeartbeat
      : undefined;
  const heartbeatIsStale =
    typeof lastHeartbeat === "string" &&
    isOriginPresenceHeartbeatStale(lastHeartbeat);
  const effectivePresenceStatus: ControllerOriginPresence["status"] | null =
    heartbeatIsStale && presence?.status !== "offline"
      ? "offline"
      : (presence?.status ?? null);
  const status = mapOriginStatusToLocalWorkspaceStatus(effectivePresenceStatus);

  return {
    deviceId,
    path,
    hostname,
    platform,
    release,
    arch,
    lastHeartbeat,
    expiresAt: null,
    runtimeId,
    region: summary.region ?? presence?.region ?? null,
    latencyMs: presence?.latencyMs ?? null,
    metadata,
    presenceStatus: effectivePresenceStatus,
    status,
  };
}

function mapOriginStatusToLocalWorkspaceStatus(
  status: ControllerOriginPresence["status"] | null | undefined,
): LocalWorkspaceStatus {
  if (status === "offline") {
    return "offline";
  }
  if (status === "degraded" || status === "online") {
    return "online";
  }
  return "online";
}

function isOriginPresenceHeartbeatStale(lastHeartbeat: string): boolean {
  const timestamp = Date.parse(lastHeartbeat);
  if (Number.isNaN(timestamp)) {
    return false;
  }
  return Date.now() - timestamp > ORIGIN_PRESENCE_STALE_THRESHOLD_MS;
}
