import { normalizeOriginEndpointForClient, runtimeControllerEnabled } from "./core";
import { isOriginRetryLaterCode, parseOriginError, type OriginError } from "./originErrors";
import { originHeaders, type WorkspaceOriginRouting } from "./originRequest";
import { requestOriginAccessTokenResult } from "./origins";

export type WorkspaceAvailabilityKind =
  | "available"
  | "connection"
  | "unavailable"
  | "access"
  | "unknown";

export interface WorkspaceAvailabilityProbeParams {
  projectId: string;
  originId?: string | null;
  runtimeId?: string | null;
  routing?: WorkspaceOriginRouting;
}

export interface WorkspaceAvailabilityProbeResult {
  kind: WorkspaceAvailabilityKind;
}

const PROBE_TIMEOUT_MS = 10_000;
const ATTEMPT_TIMEOUT_MS = 4_000;
const MISSING_ORIGIN_MESSAGES = new Set([
  "no origin available for requested protocol",
  "no hosted origin available for requested protocol",
  "origin not registered",
  "workspace_root is not configured",
]);

function classifyFailure(error: OriginError): WorkspaceAvailabilityProbeResult {
  if (error.status === 401 || error.status === 403) return { kind: "access" };
  if (error.code === "network_error" || error.code === "timeout") return { kind: "connection" };
  // A missing path/unsupported route is not evidence of a workspace outage.
  // Older controllers do not send codes for missing workspace configuration.
  if (
    error.code === "workspace_unavailable" ||
    error.code === "workspace_not_configured" ||
    error.code === "origin_not_registered" ||
    MISSING_ORIGIN_MESSAGES.has(error.message.trim().toLowerCase())
  ) return { kind: "unavailable" };
  // Capacity and canonical-mirror operations can be retried locally. They do
  // not mean the browser has lost its workspace connection.
  if (
    isOriginRetryLaterCode(error.code) ||
    error.code === "workspace_stopping" ||
    error.code === "push_rejected" ||
    error.code === "not_supported"
  ) return { kind: "unknown" };
  if (error.status === 502 || error.status === 503 || error.status === 504) return { kind: "connection" };
  return { kind: "unknown" };
}

/**
 * Read-only root probe using the same runtime/default routing as workspace reads.
 * Never equates stopped compute, missing paths, or an opaque failed request with
 * workspace unavailability. Fresh grants let recovery follow a changed origin.
 */
export async function probeWorkspaceAvailability(
  params: WorkspaceAvailabilityProbeParams,
): Promise<WorkspaceAvailabilityProbeResult> {
  const projectId = params.projectId.trim();
  if (!runtimeControllerEnabled || !projectId) return { kind: "unknown" };

  const overall = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<WorkspaceAvailabilityProbeResult>((resolve) => {
    timeout = setTimeout(() => {
      overall.abort();
      resolve({ kind: "connection" });
    }, PROBE_TIMEOUT_MS);
  });

  const attempt = async (preferRuntime: string | null): Promise<WorkspaceAvailabilityProbeResult> => {
    if (overall.signal.aborted) return { kind: "connection" };
    const abort = new AbortController();
    const abortAttempt = () => abort.abort();
    overall.signal.addEventListener("abort", abortAttempt, { once: true });
    const attemptTimeout = setTimeout(abortAttempt, ATTEMPT_TIMEOUT_MS);
    let fetching = false;
    try {
      const grant = await requestOriginAccessTokenResult({
        projectId,
        protocol: "http",
        scopes: ["fs.read"],
        originId: params.originId ?? null,
        ...(params.routing === "default" ? {} : { preferRuntime }),
        forceRefresh: true,
        timeoutMs: ATTEMPT_TIMEOUT_MS,
        signal: abort.signal,
      });
      if (!grant.ok) return classifyFailure(grant.error);
      abort.signal.throwIfAborted();
      fetching = true;
      const response = await fetch(`${normalizeOriginEndpointForClient(grant.token.endpoint)}/entries`, {
        headers: originHeaders(grant.token.token, { accept: "application/json" }),
        cache: "no-store",
        signal: abort.signal,
      });
      fetching = false;
      if (!response.ok) return classifyFailure(await parseOriginError(response));
      const entries: unknown = await response.json();
      const validListing = Array.isArray(entries) && entries.every((entry) =>
        entry !== null && typeof entry === "object" && !Array.isArray(entry) &&
        typeof entry.name === "string" && typeof entry.kind === "string",
      );
      return { kind: validListing ? "available" : "unknown" };
    } catch {
      return { kind: abort.signal.aborted || fetching ? "connection" : "unknown" };
    } finally {
      clearTimeout(attemptTimeout);
      overall.signal.removeEventListener("abort", abortAttempt);
    }
  };

  const run = async (): Promise<WorkspaceAvailabilityProbeResult> => {
    const runtimeHint = params.routing === "default" ? null : params.runtimeId;
    const preferred = runtimeHint ? await attempt(runtimeHint) : null;
    if (preferred?.kind === "available") return preferred;
    const fallback = await attempt(null);
    // A missing default origin does not rule out temporary loss of a bound runtime.
    if (fallback.kind === "unavailable" && preferred?.kind === "connection") return preferred;
    return fallback;
  };

  try {
    return await Promise.race([run(), deadline]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}
