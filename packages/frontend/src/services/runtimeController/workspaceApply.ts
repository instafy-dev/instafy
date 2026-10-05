import { zipSync, strToU8 } from "fflate";
import { runtimeControllerEnabled } from "./core";
import { parseOriginErrorText, type OriginError } from "./originErrors";
import {
  originHeaders,
  withWorkspaceWriteLease,
  type WorkspaceOriginRouting,
} from "./originRequest";
import { fetchOriginSummary, requestOriginAccessToken } from "./origins";
import {
  acquireWorkspaceLease,
  releaseWorkspaceLease,
  type WorkspaceLease,
} from "./workspaceLeases";
import { normalizeWorkspaceRelativePath } from "./workspaceUtils";
import { noteVersioningSignal } from "./workspaceVersioningCache";

export interface OriginApplyFile {
  path: string;
  content?: string;
  bytes?: Uint8Array;
  encoding?: "utf8" | "binary";
}

/** Blob id each path must hold before the write (`null`: the path must not exist). */
export type OriginApplyExpected = Record<string, string | null>;

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
  /** The commit the edit was based on (stateless gateway compare-and-swap). */
  baseRev?: string | null;
  /** Blob ids the paths must still hold; a mismatch answers 409 `head_moved`. */
  expected?: OriginApplyExpected | null;
  /** Commit message; the gateway writes a plain default when absent. */
  commitMessage?: string | null;
  /**
   * `legacy` (default): today's routing (runtime origin when one is
   * preferred, else the default origin's summary). `default`: the pinned or
   * default origin, never `preferRuntime`.
   */
  routing?: WorkspaceOriginRouting;
}

export interface OriginApplyResult {
  ok: boolean;
  rev?: string | null;
  /** `main` the write was applied on, when the origin reports it. */
  baseRev?: string | null;
  /** Present only on origins that commit on apply (stateless gateway). */
  committed?: boolean;
  mode?: string;
  endpoint?: string;
  leaseId?: string | null;
  originId?: string | null;
  originMode?: string | null;
  error?: string;
  errorInfo?: OriginError;
}

export interface OriginApplyRequest {
  projectId: string;
  leaseId: string | null;
  files: OriginApplyFile[];
  deletes: string[];
  baseRev?: string | null;
  expected?: OriginApplyExpected | null;
  commitMessage?: string | null;
}

export type OriginApplyPostResult =
  | { ok: true; rev: string | null; baseRev: string | null; committed?: boolean }
  | { ok: false; status: number; text: string; error: OriginError };

/**
 * POST one apply (manifest + zip archive) through `send` and parse the
 * answer. Shared by the legacy apply, default-routed applies and saves.
 */
export async function postOriginApply(
  send: (init: RequestInit) => Promise<Response>,
  request: OriginApplyRequest,
  options?: {
    /**
     * Treat an accepted (2xx) apply whose JSON body cannot be read as
     * applied, without its details. Saves use this: the write landed, so it
     * must not be reported as not applied. Legacy callers keep throwing.
     */
    tolerateUnreadableBody?: boolean;
  },
): Promise<OriginApplyPostResult> {
  const archive = createOriginArchive(request.files);
  const manifest = buildOriginManifest(request);

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

  const response = await send({ method: "POST", body: formData });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    return {
      ok: false,
      status: response.status,
      text,
      error: parseOriginErrorText(response.status, text, response.headers),
    };
  }

  let rev: string | null = null;
  let baseRev: string | null = null;
  let committed: boolean | undefined;
  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    let body: Record<string, unknown>;
    if (options?.tolerateUnreadableBody) {
      const parsed = (await response.json().catch(() => null)) as unknown;
      body = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
    } else {
      body = (await response.json()) as Record<string, unknown>;
    }
    if (typeof body.rev === "string") {
      rev = body.rev;
    }
    if (typeof body.baseRev === "string") {
      baseRev = body.baseRev;
    }
    if (typeof body.committed === "boolean") {
      committed = body.committed;
    }
  }
  return committed === undefined ? { ok: true, rev, baseRev } : { ok: true, rev, baseRev, committed };
}

/** Report what an apply answer revealed about how its origin keeps versions. */
export function noteApplyVersioningSignals(
  originId: string | null | undefined,
  result: OriginApplyPostResult,
): void {
  if (result.ok && result.committed === true) {
    noteVersioningSignal(originId, "committed");
  } else if (!result.ok && result.error.code === "delete_requires_base_rev") {
    noteVersioningSignal(originId, "delete_requires_base_rev");
  }
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

  if (params.routing === "default") {
    return applyWithDefaultRouting(params, files, deletes);
  }

  let runtimePreference = params.preferRuntime ?? params.runtimeId ?? null;
  let runtimeId = params.runtimeId ?? runtimePreference ?? null;
  const retainLease = params.retainLease === true;
  let leaseId = params.leaseId ?? null;
  let leaseIdForRelease: string | null = null;
  let acquiredLease: WorkspaceLease | null = null;

  try {
    const requestedOriginId = params.originId?.trim() || null;
    let resolvedOriginId = requestedOriginId;
    // A project summary can describe the hosted gateway or a different runtime.
    // When a runtime is selected, let the controller resolve its exact origin;
    // combining that preference with the default origin is an invalid binding.
    if (!runtimePreference) {
      const origin = await fetchOriginSummary({
        projectId,
        protocol: "http",
        accessToken: params.accessToken ?? null,
      });
      if (!origin) return { ok: false, error: "no origin available" };
      if (origin.presence?.status === "offline") return { ok: false, error: "origin is offline" };
      if (!requestedOriginId || requestedOriginId === origin.originId) {
        resolvedOriginId = origin.originId;
        runtimePreference = origin.runtimeId ?? null;
        runtimeId = runtimePreference;
      }
    }

    if (!leaseId) {
      try {
        acquiredLease = await acquireWorkspaceLease({
          projectId,
          runtimeId,
          leaseSeconds: params.leaseSeconds,
          metadata: null,
          accessToken: params.accessToken ?? null,
        });
        leaseId = acquiredLease.leaseId;
        leaseIdForRelease = leaseId;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(
          "[runtime-controller] acquireWorkspaceLease error:",
          message,
        );
        return { ok: false, error: message };
      }
    } else {
      leaseIdForRelease = leaseId;
    }

    const token = await requestOriginAccessToken({
      projectId,
      protocol: "http",
      scopes: ["fs.write"],
      originId: resolvedOriginId,
      leaseId,
      preferRuntime: runtimePreference,
      accessToken: params.accessToken ?? null,
    });
    if (!token) {
      return { ok: false, error: "failed to obtain origin token" };
    }

    if (token.leaseId) {
      leaseId = token.leaseId;
      leaseIdForRelease = token.leaseId;
    }

    const endpoint = token.endpoint.replace(/\/+$/, "");
    const applyUrl = `${endpoint}/apply`;

    const posted = await postOriginApply(
      (init) =>
        fetch(applyUrl, {
          ...init,
          headers: originHeaders(token.token),
        }),
      {
        projectId,
        files,
        deletes,
        leaseId: leaseId ?? null,
        baseRev: params.baseRev,
        expected: params.expected,
        commitMessage: params.commitMessage,
      },
    );
    noteApplyVersioningSignals(token.originId, posted);

    if (!posted.ok) {
      return {
        ok: false,
        mode: token.mode,
        endpoint: endpoint,
        leaseId: leaseId ?? null,
        originId: token.originId ?? null,
        originMode: token.mode ?? null,
        error: `origin apply failed (${posted.status}): ${posted.text}`,
        errorInfo: posted.error,
      };
    }

    const result: OriginApplyResult = {
      ok: true,
      rev: posted.rev,
      mode: token.mode,
      endpoint,
      leaseId: leaseId ?? null,
      originId: token.originId ?? null,
      originMode: token.mode ?? null,
    };
    if (posted.baseRev) {
      result.baseRev = posted.baseRev;
    }
    if (posted.committed !== undefined) {
      result.committed = posted.committed;
    }
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(
      "[runtime-controller] applyWorkspaceChangesViaOrigin error:",
      message,
    );
    return { ok: false, error: message };
  } finally {
    if (acquiredLease && leaseIdForRelease && !retainLease) {
      try {
        await releaseWorkspaceLease({
          projectId,
          leaseId: leaseIdForRelease,
          runtimeId,
          accessToken: params.accessToken ?? null,
        });
      } catch (releaseError) {
        const releaseMessage =
          releaseError instanceof Error
            ? releaseError.message
            : String(releaseError);
        console.warn(
          "[runtime-controller] releaseWorkspaceLease error:",
          releaseMessage,
        );
      }
    }
  }
}

async function applyWithDefaultRouting(
  params: OriginApplyOptions,
  files: OriginApplyFile[],
  deletes: string[],
): Promise<OriginApplyResult> {
  const outcome = await withWorkspaceWriteLease(
    {
      projectId: params.projectId,
      originId: params.originId ?? null,
      runtimeId: params.runtimeId ?? null,
      accessToken: params.accessToken ?? null,
      leaseId: params.leaseId ?? null,
      leaseSeconds: params.leaseSeconds,
      retainLease: params.retainLease,
    },
    async (context) => {
      const posted = await postOriginApply((init) => context.fetch("apply", init), {
        projectId: params.projectId,
        files,
        deletes,
        leaseId: context.leaseId,
        baseRev: params.baseRev,
        expected: params.expected,
        commitMessage: params.commitMessage,
      });
      noteApplyVersioningSignals(context.originId, posted);
      return posted;
    },
  );

  if (!outcome.ok) {
    return {
      ok: false,
      mode: outcome.originMode ?? undefined,
      endpoint: outcome.endpoint ?? undefined,
      leaseId: outcome.leaseId,
      originId: outcome.originId,
      originMode: outcome.originMode,
      error: outcome.error.message,
      errorInfo: outcome.error,
    };
  }
  const posted = outcome.value;
  if (!posted.ok) {
    return {
      ok: false,
      mode: outcome.originMode,
      endpoint: outcome.endpoint,
      leaseId: outcome.leaseId,
      originId: outcome.originId,
      originMode: outcome.originMode,
      error: `origin apply failed (${posted.status}): ${posted.text}`,
      errorInfo: posted.error,
    };
  }
  const result: OriginApplyResult = {
    ok: true,
    rev: posted.rev,
    mode: outcome.originMode,
    endpoint: outcome.endpoint,
    leaseId: outcome.leaseId,
    originId: outcome.originId,
    originMode: outcome.originMode,
  };
  if (posted.baseRev) {
    result.baseRev = posted.baseRev;
  }
  if (posted.committed !== undefined) {
    result.committed = posted.committed;
  }
  return result;
}

function normalizeExpected(
  expected: OriginApplyExpected | null | undefined,
): Record<string, string | null> | null {
  if (!expected) {
    return null;
  }
  const normalized: Record<string, string | null> = {};
  for (const [path, oid] of Object.entries(expected)) {
    const normalizedPath = normalizeWorkspaceRelativePath(path);
    if (!normalizedPath) {
      continue;
    }
    normalized[normalizedPath] = typeof oid === "string" && oid.trim().length > 0 ? oid.trim() : null;
  }
  return Object.keys(normalized).length > 0 ? normalized : null;
}

function buildOriginManifest(input: OriginApplyRequest) {
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

  const manifest: Record<string, unknown> = {
    projectId: input.projectId,
    leaseId: input.leaseId,
    files,
    deletes,
    generatedAt: new Date().toISOString(),
  };
  // Newer fields are added only when set, so legacy manifests stay as they were.
  const baseRev = input.baseRev?.trim();
  if (baseRev) {
    manifest.baseRev = baseRev;
  }
  const expected = normalizeExpected(input.expected);
  if (expected) {
    manifest.expected = expected;
  }
  const commitMessage = input.commitMessage?.trim();
  if (commitMessage) {
    manifest.commitMessage = commitMessage;
  }
  return manifest;
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
