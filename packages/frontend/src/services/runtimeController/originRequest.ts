import { Capacitor } from "@capacitor/core";
import { instafyBuildInfo } from "../../config/buildInfo";
import { isDesktopShell } from "../../lib/desktopShell";
import { ControllerApiError, normalizeOriginEndpointForClient } from "./core";
import {
  requestOriginAccessToken,
  type OriginAccessTokenResponse,
  type RequestOriginAccessTokenParams,
} from "./origins";
import {
  isLeaseConflictMessage,
  leaseConflictError,
  originErrorFromException,
  type OriginError,
} from "./originErrors";
import { acquireWorkspaceLease, releaseWorkspaceLease } from "./workspaceLeases";

/**
 * How a workspace call picks its origin.
 *
 * - `legacy`: today's routing. Git calls prefer the hosted gateway
 *   (`preferHosted`), file reads and writes prefer a running hosted runtime
 *   (`preferRuntime`). Requests are unchanged from before versioning.
 * - `default`: the controller's default origin for the project (Desktop when
 *   online, else the gateway), pinned with `originId` when the caller knows
 *   it. No `preferHosted`, no `preferRuntime`.
 */
export type WorkspaceOriginRouting = "legacy" | "default";

export const INSTAFY_CLIENT_HEADER = "x-instafy-client";

let cachedClientHeaderValue: string | null = null;

function sanitizeHeaderToken(value: string): string {
  return value.replace(/[^0-9A-Za-z._+-]/g, "").slice(0, 64);
}

function detectClientPlatform(): string {
  if (isDesktopShell()) {
    return "desktop";
  }
  try {
    const platform = Capacitor.getPlatform();
    if (platform === "ios" || platform === "android") {
      return platform;
    }
  } catch (_error) {
    // Treat an unavailable Capacitor bridge as the web app.
  }
  return "web";
}

/**
 * `X-Instafy-Client` value, e.g. `web/1a2b3c4d`. Diagnostics only: origins
 * log it next to requests from older clients. It carries no user data.
 */
export function instafyClientHeaderValue(): string {
  if (cachedClientHeaderValue) {
    return cachedClientHeaderValue;
  }
  const build =
    sanitizeHeaderToken(instafyBuildInfo.gitCommitShort?.trim() ?? "") ||
    sanitizeHeaderToken(instafyBuildInfo.packageVersion?.trim() ?? "") ||
    "unknown";
  cachedClientHeaderValue = `${detectClientPlatform()}/${build}`;
  return cachedClientHeaderValue;
}

/** Test hook: forget the memoized client header value. */
export function resetInstafyClientHeaderValueForTests(): void {
  cachedClientHeaderValue = null;
}

/** Headers for an origin request: the bearer token plus `X-Instafy-Client`. */
export function originHeaders(
  token: string,
  extra?: Record<string, string>,
): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    ...extra,
    [INSTAFY_CLIENT_HEADER]: instafyClientHeaderValue(),
  };
}

/** Token request fields that select the origin for a routing mode. */
export function originRoutingTokenParams(
  routing: WorkspaceOriginRouting | undefined,
  legacy: Pick<RequestOriginAccessTokenParams, "preferHosted" | "preferRuntime">,
): Pick<RequestOriginAccessTokenParams, "preferHosted" | "preferRuntime"> {
  return routing === "default" ? {} : legacy;
}

export type OriginTokenFetchResult = {
  endpoint: string;
  originToken: OriginAccessTokenResponse;
  response: Response;
};

/**
 * Mint an origin token, run one request with it, and on a 401 mint a fresh
 * token once and retry. Returns null when no token could be minted.
 */
export async function fetchWithOriginToken(
  tokenParams: RequestOriginAccessTokenParams,
  execute: (originToken: OriginAccessTokenResponse, endpoint: string) => Promise<Response>,
): Promise<OriginTokenFetchResult | null> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const originToken = await requestOriginAccessToken({
      ...tokenParams,
      forceRefresh: attempt > 0,
    });

    if (!originToken) {
      return null;
    }

    const endpoint = normalizeOriginEndpointForClient(originToken.endpoint);
    const response = await execute(originToken, endpoint);
    if (response.status === 401 && attempt === 0) {
      continue;
    }

    return { endpoint, originToken, response };
  }

  return null;
}

export interface WorkspaceWriteContext {
  projectId: string;
  leaseId: string;
  originId: string;
  /** The origin's mode as the token reported it (`hosted`, `desktop`, `efs`). */
  originMode: string;
  endpoint: string;
  /**
   * Run a request against the pinned origin with the write token
   * (`path` is relative, e.g. `git/sync`). A 401 mints a fresh token for the
   * same origin and lease once.
   */
  fetch: (path: string, init?: RequestInit) => Promise<Response>;
}

export interface WorkspaceWriteLeaseOptions {
  projectId: string;
  /** Pin the write to this origin; without it the controller's default origin is used. */
  originId?: string | null;
  /** Legacy routing only: mint for the hosted gateway as the legacy git calls do. */
  preferHosted?: boolean;
  runtimeId?: string | null;
  accessToken?: string | null;
  /** A lease the caller already holds: used as is and never released here. */
  leaseId?: string | null;
  leaseSeconds?: number;
  retainLease?: boolean;
  /**
   * When the controller refuses the lease because someone else (usually the
   * agent) holds it, wait this long and try once more.
   */
  leaseConflictRetryDelayMs?: number | null;
}

export type WorkspaceWriteStage = "lease" | "token" | "request";

export type WorkspaceWriteLeaseResult<T> =
  | {
      ok: true;
      value: T;
      leaseId: string;
      originId: string;
      originMode: string;
      endpoint: string;
    }
  | {
      ok: false;
      stage: WorkspaceWriteStage;
      error: OriginError;
      leaseId: string | null;
      originId: string | null;
      originMode: string | null;
      endpoint: string | null;
    };

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function leaseFailure(error: unknown): OriginError {
  const status = error instanceof ControllerApiError ? error.status : 0;
  const message = error instanceof Error ? error.message : String(error);
  if (status === 409 || isLeaseConflictMessage(message)) {
    return leaseConflictError();
  }
  return {
    status,
    code: "lease_failed",
    message,
    routeUnavailable: false,
  };
}

/**
 * The shared lease-and-token helper for workspace writes: acquire a project
 * lease (unless the caller holds one), mint an `fs.write` token for one
 * origin, run `fn`, release the lease. Every request `fn` makes goes to the
 * same origin with the same lease.
 */
export async function withWorkspaceWriteLease<T>(
  options: WorkspaceWriteLeaseOptions,
  fn: (context: WorkspaceWriteContext) => Promise<T>,
): Promise<WorkspaceWriteLeaseResult<T>> {
  const projectId = options.projectId.trim();
  const runtimeId = options.runtimeId ?? null;
  const accessToken = options.accessToken ?? null;
  let leaseId = options.leaseId?.trim() || null;
  let acquiredLeaseId: string | null = null;
  let originId: string | null = null;
  let originMode: string | null = null;
  let endpoint: string | null = null;

  const failure = (stage: WorkspaceWriteStage, error: OriginError): WorkspaceWriteLeaseResult<T> => ({
    ok: false,
    stage,
    error,
    leaseId,
    originId,
    originMode,
    endpoint,
  });

  try {
    if (!leaseId) {
      const acquire = () =>
        acquireWorkspaceLease({
          projectId,
          runtimeId,
          leaseSeconds: options.leaseSeconds,
          metadata: null,
          accessToken,
        });
      try {
        leaseId = (await acquire()).leaseId;
      } catch (error) {
        const mapped = leaseFailure(error);
        const retryDelay = options.leaseConflictRetryDelayMs;
        if (mapped.code !== "lease_conflict" || !retryDelay || retryDelay <= 0) {
          return failure("lease", mapped);
        }
        await delay(retryDelay);
        try {
          leaseId = (await acquire()).leaseId;
        } catch (retryError) {
          return failure("lease", leaseFailure(retryError));
        }
      }
      acquiredLeaseId = leaseId;
    }

    const mintParams: RequestOriginAccessTokenParams = {
      projectId,
      protocol: "http",
      scopes: ["fs.write"],
      ...(options.preferHosted ? { preferHosted: true } : {}),
      originId: options.originId?.trim() || null,
      leaseId,
      accessToken,
    };

    const minted = await requestOriginAccessToken(mintParams);
    if (!minted) {
      return failure("token", {
        status: 0,
        code: "token_unavailable",
        message: "failed to obtain origin token",
        routeUnavailable: false,
      });
    }
    let token: OriginAccessTokenResponse = minted;
    const adoptToken = (next: OriginAccessTokenResponse) => {
      token = next;
      originId = next.originId;
      originMode = next.mode;
      endpoint = normalizeOriginEndpointForClient(next.endpoint);
      if (next.leaseId) {
        leaseId = next.leaseId;
        if (acquiredLeaseId) {
          acquiredLeaseId = next.leaseId;
        }
      }
    };
    adoptToken(token);

    const context: WorkspaceWriteContext = {
      projectId,
      get leaseId() {
        return leaseId ?? "";
      },
      get originId() {
        return originId ?? "";
      },
      get originMode() {
        return originMode ?? "unknown";
      },
      get endpoint() {
        return endpoint ?? "";
      },
      fetch: async (path, init) => {
        for (let attempt = 0; attempt < 2; attempt += 1) {
          const relative = path.replace(/^\/+/, "");
          const response = await fetch(`${endpoint}/${relative}`, {
            ...init,
            headers: {
              ...((init?.headers as Record<string, string> | undefined) ?? {}),
              ...originHeaders(token.token),
            },
          });
          if (response.status !== 401 || attempt > 0) {
            return response;
          }
          // Same origin and lease: a fresh mint must never move the write.
          const refreshed = await requestOriginAccessToken({
            ...mintParams,
            originId: mintParams.originId ?? (options.preferHosted ? null : originId),
            leaseId,
            forceRefresh: true,
          });
          if (!refreshed || (originId && refreshed.originId !== originId)) {
            return response;
          }
          adoptToken(refreshed);
        }
        throw new Error("unreachable");
      },
    };

    try {
      const value = await fn(context);
      return {
        ok: true,
        value,
        leaseId: leaseId ?? "",
        originId: originId ?? "",
        originMode: originMode ?? "unknown",
        endpoint: endpoint ?? "",
      };
    } catch (error) {
      return failure("request", originErrorFromException(error));
    }
  } finally {
    if (acquiredLeaseId && !options.retainLease) {
      await releaseWorkspaceLease({
        projectId,
        leaseId: acquiredLeaseId,
        runtimeId,
        accessToken,
      }).catch((releaseError: unknown) => {
        const message = releaseError instanceof Error ? releaseError.message : String(releaseError);
        console.warn("[runtime-controller] releaseWorkspaceLease error:", message);
      });
    }
  }
}
