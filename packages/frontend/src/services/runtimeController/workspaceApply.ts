import { zipSync, strToU8 } from "fflate";
import { resolveControllerRequestContext, runtimeControllerEnabled, type ControllerRequestContext } from "./core";
import { fetchOriginSummary, requestOriginAccessToken } from "./origins";
import {
  acquireWorkspaceLease,
  releaseWorkspaceLease,
  type WorkspaceLease,
} from "./workspaceLeases";
import { normalizeWorkspaceRelativePath } from "./workspaceUtils";

export interface OriginApplyFile {
  path: string;
  content?: string;
  bytes?: Uint8Array;
  encoding?: "utf8" | "binary";
}

export interface OriginApplyOptions {
  projectId: string;
  files: OriginApplyFile[];
  deletes?: string[];
  leaseId?: string | null;
  accessToken?: string | null;
  originId?: string | null;
  preferRuntime?: string | null;
  runtimeId?: string | null;
  leaseSeconds?: number;
  retainLease?: boolean;
  /** Keep a related batch on the exact controller, credentials and origin. */
  target?: OriginApplyTarget;
  signal?: AbortSignal;
  timeoutMs?: number;
}

/** Ephemeral request state. Never store this in attachment/message metadata. */
export interface OriginApplyTarget {
  readonly projectId: string;
  readonly originId: string;
  readonly runtimeId: string | null;
  readonly requestContext: ControllerRequestContext;
}

export interface OriginApplyResult {
  ok: boolean;
  rev?: string | null;
  mode?: string;
  endpoint?: string;
  leaseId?: string | null;
  error?: string;
  target?: OriginApplyTarget;
}

export async function applyWorkspaceChangesViaOrigin(
  params: OriginApplyOptions,
): Promise<OriginApplyResult> {
  if (!runtimeControllerEnabled) {
    return { ok: false, error: "runtime controller disabled" };
  }

  const { projectId } = params;
  const files = params.files ?? [];
  const deletes = params.deletes ?? [];
  if (!projectId || projectId.trim().length === 0) {
    return { ok: false, error: "projectId is required" };
  }
  if (files.length === 0 && deletes.length === 0) {
    return { ok: false, error: "no changes supplied" };
  }
  if (params.target && params.target.projectId !== projectId) {
    return { ok: false, error: "origin apply target belongs to another project" };
  }

  let runtimePreference = params.target ? params.target.runtimeId : params.preferRuntime ?? params.runtimeId ?? null;
  let runtimeId = params.target ? params.target.runtimeId : params.runtimeId ?? runtimePreference ?? null;
  const retainLease = params.retainLease === true;
  let leaseId = params.leaseId ?? null;
  let leaseIdForRelease: string | null = null;
  let acquiredLease: WorkspaceLease | null = null;
  let target = params.target;
  let tokenFailureStatus: number | null = null;
  let requestContext = target?.requestContext;
  const applyAbort = new AbortController();
  const forwardAbort = () => applyAbort.abort(params.signal?.reason);
  params.signal?.addEventListener("abort", forwardAbort, { once: true });
  if (params.signal?.aborted) forwardAbort();
  const timeoutMs = Number.isFinite(params.timeoutMs)
    ? Math.max(1, Math.min(params.timeoutMs!, 30_000))
    : 30_000;
  let applyTimedOut = false;
  const applyTimeout = setTimeout(() => {
    applyTimedOut = true;
    applyAbort.abort();
  }, timeoutMs);
  const { signal } = applyAbort;

  try {
    requestContext ??= await untilAborted(resolveControllerRequestContext(params.accessToken ?? null), signal);
    signal.throwIfAborted();
    // Pinned writes must not rediscover a replacement default after an org or
    // runtime switch. Use the original authorization context for every stage.
    const origin = target ? null : await untilAborted(fetchOriginSummary({
      projectId,
      protocol: "http",
      accessToken: params.accessToken ?? null,
      requestContext,
      signal,
    }), signal);
    signal.throwIfAborted();
    if (!origin && !runtimePreference && !params.originId && !target) {
      return { ok: false, error: "no origin available" };
    }
    const requestedOriginId = target?.originId ?? (params.originId?.trim() || null);
    // A project's default origin may belong to a different runtime. Let the
    // controller resolve the requested runtime instead of pinning that default.
    const selectedOriginId = requestedOriginId ?? (
      !runtimePreference || origin?.runtimeId === runtimePreference
        ? origin?.originId ?? null
        : null
    );
    if (selectedOriginId === origin?.originId && origin?.presence?.status === "offline") {
      return { ok: false, error: "origin is offline" };
    }
    if (
      origin &&
      !runtimePreference &&
      (!requestedOriginId || requestedOriginId === origin.originId)
    ) {
      runtimePreference = origin.runtimeId ?? null;
      runtimeId = params.runtimeId ?? runtimePreference;
    }

    if (!leaseId) {
      try {
        acquiredLease = await untilAborted(acquireWorkspaceLease({
          projectId,
          runtimeId,
          leaseSeconds: params.leaseSeconds,
          metadata: null,
          accessToken: params.accessToken ?? null,
          requestContext,
          signal,
        }), signal);
        leaseId = acquiredLease.leaseId;
        leaseIdForRelease = leaseId;
        signal.throwIfAborted();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(
          "[runtime-controller] acquireWorkspaceLease error:",
          message,
        );
        throw error;
      }
    } else {
      leaseIdForRelease = leaseId;
    }

    const token = await untilAborted(requestOriginAccessToken({
      projectId,
      protocol: "http",
      scopes: ["fs.write"],
      originId: selectedOriginId,
      leaseId,
      preferRuntime: runtimePreference,
      accessToken: params.accessToken ?? null,
      throwOnError: true,
      requestContext,
      signal,
      onErrorResponse: (status) => { tokenFailureStatus = status; },
    }), signal);
    signal.throwIfAborted();
    if (!token) {
      return { ok: false, error: "failed to obtain origin token", target };
    }
    if (target && token.originId !== target.originId) {
      return { ok: false, error: "origin apply target changed", target };
    }
    target = Object.freeze({ projectId, originId: token.originId, runtimeId, requestContext });

    if (token.leaseId) {
      leaseId = token.leaseId;
      leaseIdForRelease = token.leaseId;
    }

    const archive = createOriginArchive(files);
    const manifest = buildOriginManifest({
      projectId,
      files,
      deletes,
      leaseId: leaseId ?? null,
    });

    const endpoint = token.endpoint.replace(/\/+$/, "");
    const applyUrl = `${endpoint}/apply`;

    const formData = new FormData();
    formData.append(
      "manifest",
      new Blob([JSON.stringify(manifest)], { type: "application/json" }),
      "manifest.json",
    );
    const archiveBuffer = archive.buffer.slice(
      archive.byteOffset,
      archive.byteOffset + archive.byteLength,
    ) as ArrayBuffer;
    formData.append(
      "archive",
      new Blob([archiveBuffer], { type: "application/zip" }),
      "workspace.zip",
    );

    signal.throwIfAborted();
    const response = await untilAborted(fetch(applyUrl, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token.token}`,
      },
      body: formData,
      signal,
    }), signal);

    if (!response.ok) {
      // The status is already authoritative even if its diagnostic body stalls.
      // Keep permanent rejections distinguishable from retryable transport errors.
      const text = await untilAborted(response.text(), signal).catch(() => "error response body unavailable");
      return {
        ok: false,
        mode: token.mode,
        endpoint: endpoint,
        leaseId: leaseId ?? null,
        error: `origin apply failed (${response.status}): ${text}`,
        target,
      };
    }

    let rev: string | null = null;
    const contentType = response.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      const body = (await untilAborted(response.json(), signal)) as Record<string, unknown>;
      if (typeof body.rev === "string") {
        rev = body.rev;
      }
    }

    return {
      ok: true,
      rev,
      mode: token.mode,
      endpoint,
      leaseId: leaseId ?? null,
      target,
    };
  } catch (error) {
    const detail = applyTimedOut
      ? `origin apply timed out after ${timeoutMs}ms`
      : error instanceof Error ? error.message : String(error);
    // The overall deadline can fire before the token client's own body timer.
    // Preserve a rejection whose headers already arrived in either ordering.
    const tokenFailurePrefix = tokenFailureStatus === null
      ? null : `request origin access token failed (${tokenFailureStatus}): `;
    const message = tokenFailurePrefix && !detail.startsWith(tokenFailurePrefix)
      ? tokenFailurePrefix + detail : detail;
    console.warn(
      "[runtime-controller] applyWorkspaceChangesViaOrigin error:",
      message,
    );
    return { ok: false, error: message, target };
  } finally {
    clearTimeout(applyTimeout);
    params.signal?.removeEventListener("abort", forwardAbort);
    if (acquiredLease && leaseIdForRelease && !retainLease) {
      const releaseAbort = new AbortController();
      const releaseTimeout = setTimeout(() => releaseAbort.abort(), 1_000);
      try {
        await untilAborted(releaseWorkspaceLease({
          projectId,
          leaseId: leaseIdForRelease,
          runtimeId,
          accessToken: params.accessToken ?? null,
          requestContext,
          signal: releaseAbort.signal,
        }), releaseAbort.signal);
      } catch (releaseError) {
        const releaseMessage =
          releaseError instanceof Error
            ? releaseError.message
            : String(releaseError);
        console.warn(
          "[runtime-controller] releaseWorkspaceLease error:",
          releaseMessage,
        );
      } finally {
        clearTimeout(releaseTimeout);
      }
    }
  }
}

// Resolving browser auth (or a non-cooperative transport) can stall without
// honoring AbortSignal. Bound the wait as well; each subsequent network stage
// checks the same signal before it can issue a request.
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    };
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

function buildOriginManifest(input: {
  projectId: string;
  files: OriginApplyFile[];
  deletes: string[];
  leaseId: string | null;
}) {
  const files = input.files.map((file) => {
    const normalizedPath = normalizeWorkspaceRelativePath(file.path);
    const size =
      file.bytes && file.bytes.byteLength > 0
        ? file.bytes.byteLength
        : new TextEncoder().encode(file.content ?? "").length;
    return {
      path: normalizedPath,
      size,
      encoding: file.encoding ?? "utf8",
    };
  });

  const deletes = (input.deletes ?? []).map((path) =>
    normalizeWorkspaceRelativePath(path),
  );

  return {
    projectId: input.projectId,
    leaseId: input.leaseId,
    files,
    deletes,
    generatedAt: new Date().toISOString(),
  };
}

function createOriginArchive(files: OriginApplyFile[]): Uint8Array {
  const entries: Record<string, Uint8Array> = {};
  files.forEach((file) => {
    const normalizedPath = normalizeWorkspaceRelativePath(file.path);
    const bytes =
      file.bytes ??
      (typeof file.content === "string" ? strToU8(file.content) : strToU8(""));
    entries[normalizedPath] = bytes;
  });
  return zipSync(entries, { level: 9 });
}
