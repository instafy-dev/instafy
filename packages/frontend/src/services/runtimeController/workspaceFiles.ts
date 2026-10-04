import {
  normalizeOriginEndpointForClient,
  runtimeControllerEnabled,
} from "./core";
import {
  originErrorFromException,
  parseOriginErrorText,
  type OriginError,
} from "./originErrors";
import { originHeaders, type WorkspaceOriginRouting } from "./originRequest";
import { requestOriginAccessToken, type OriginAccessTokenResponse } from "./origins";
import { applyWorkspaceChangesViaOrigin } from "./workspaceApply";
import {
  bytesToUtf8,
  decodeBase64,
  extractExtension,
  isTextLikeFile,
  normalizeWorkspaceRelativePath,
} from "./workspaceUtils";

const WORKSPACE_LIST_TIMEOUT_MS = 30_000;
const WORKSPACE_READ_TIMEOUT_MS = 30_000;

/** Response header with the commit a read was served from (stateless gateway). */
export const ORIGIN_REV_HEADER = "x-instafy-rev";
/** Response header with the git blob id of a file read (newer origins). */
export const ORIGIN_BLOB_HEADER = "x-instafy-blob";

export interface ListControllerWorkspaceParams {
  projectId: string;
  path?: string | null;
  accessToken?: string | null;
  runtimeId?: string | null;
  originId?: string | null;
  syncMode?: "background" | "blocking";
}

/** Where to read from: a full commit id (`rev`) or a recovery/salvage ref (`ref`), never both. */
export interface WorkspaceReadPin {
  rev?: string | null;
  ref?: string | null;
}

export interface ListWorkspaceEntriesAtParams extends ListControllerWorkspaceParams, WorkspaceReadPin {
  /** `legacy` (default): runtime origin first, then the default origin. */
  routing?: WorkspaceOriginRouting;
}

export type WorkspaceEntriesAtResult =
  | {
      ok: true;
      entries: ControllerWorkspaceEntry[];
      /** `X-Instafy-Rev` of the listing, when the origin sends it. */
      rev: string | null;
      originId: string | null;
      originMode: string | null;
    }
  | {
      ok: false;
      error: OriginError;
      originId: string | null;
      originMode: string | null;
    };

export type ControllerWorkspaceEntryKind = "file" | "directory" | "other";

export interface ControllerWorkspaceEntry {
  name: string;
  path: string;
  kind: ControllerWorkspaceEntryKind;
  size?: number | null;
  modified?: string | null;
  mimeType?: string | null;
  extension?: string | null;
  hasChildren?: boolean;
  /** Git blob id of a file (newer origins). */
  blobOid?: string | null;
}

export interface ReadControllerWorkspaceFileParams extends WorkspaceReadPin {
  projectId: string;
  path: string;
  accessToken?: string | null;
  runtimeId?: string | null;
  originId?: string | null;
  timeoutMs?: number;
  /** `legacy` (default): prefer the runtime origin as before. */
  routing?: WorkspaceOriginRouting;
}

export interface ControllerWorkspaceFileContent {
  path: string;
  size: number;
  encoding: string;
  mimeType: string | null;
  contentBase64: string;
  contentText: string | null;
  isText: boolean;
  /** `X-Instafy-Blob` (or `blobOid` in the body), when the origin sends it. */
  blobOid?: string | null;
  /** `X-Instafy-Rev` of the read, when the origin sends it. */
  rev?: string | null;
  originId?: string | null;
  originMode?: string | null;
}

export type WorkspaceFileReadResult =
  | { ok: true; file: ControllerWorkspaceFileContent }
  | {
      ok: false;
      /** A plain 404: the path does not exist at this rev. */
      notFound: boolean;
      error: OriginError;
      originId: string | null;
      originMode: string | null;
    };

class OriginResponseError extends Error {
  readonly info: OriginError;

  constructor(message: string, info: OriginError) {
    super(message);
    this.name = "OriginResponseError";
    this.info = info;
  }
}

function invalidPinError(): OriginError {
  return {
    status: 0,
    code: "invalid_request",
    message: "rev and ref cannot be combined",
    routeUnavailable: false,
  };
}

function hasPinConflict(pin: WorkspaceReadPin): boolean {
  return Boolean(pin.rev?.trim()) && Boolean(pin.ref?.trim());
}

function applyReadPin(search: URLSearchParams, pin: WorkspaceReadPin): void {
  const rev = pin.rev?.trim();
  if (rev) {
    search.set("rev", rev);
  }
  const ref = pin.ref?.trim();
  if (ref) {
    search.set("ref", ref);
  }
}

function headerValue(headers: Headers, name: string): string | null {
  const value = headers.get(name)?.trim();
  return value ? value : null;
}

function tokenUnavailableError(): OriginError {
  return {
    status: 0,
    code: "token_unavailable",
    message: "failed to obtain origin token",
    routeUnavailable: false,
  };
}

export interface WriteControllerWorkspaceFileParams {
  projectId: string;
  path: string;
  content: string;
  accessToken?: string | null;
  runtimeId?: string | null;
  originId?: string | null;
  leaseId?: string | null;
  leaseSeconds?: number;
  retainLease?: boolean;
}

export interface ControllerWorkspaceWriteResponse {
  ok: boolean;
  path: string;
  size: number;
  rev?: string | null;
  leaseId?: string | null;
  originMode?: string | null;
  originEndpoint?: string | null;
}

export interface DeleteControllerWorkspaceFileParams {
  projectId: string;
  path: string;
  recursive?: boolean;
  accessToken?: string | null;
  runtimeId?: string | null;
  originId?: string | null;
  leaseId?: string | null;
  leaseSeconds?: number;
  retainLease?: boolean;
}

export interface ControllerWorkspaceDeleteResponse {
  ok: boolean;
  path: string;
  deleted: boolean;
  rev?: string | null;
  leaseId?: string | null;
}

export async function listWorkspaceEntriesFromController(
  params: ListControllerWorkspaceParams,
): Promise<ControllerWorkspaceEntry[] | null> {
  const result = await listWorkspaceEntriesAt({
    projectId: params.projectId,
    path: params.path,
    accessToken: params.accessToken,
    runtimeId: params.runtimeId,
    originId: params.originId,
    syncMode: params.syncMode,
    routing: "legacy",
  });
  return result?.ok ? result.entries : null;
}

/**
 * List a folder and report the commit the listing was served from.
 * `routing: "default"` reads the pinned (or default) origin only; `legacy`
 * keeps the runtime-first fallback of `listWorkspaceEntriesFromController`.
 * A 404 is an empty folder, except `rev_not_found`, which is an error so the
 * caller can retry unpinned.
 */
export async function listWorkspaceEntriesAt(
  params: ListWorkspaceEntriesAtParams,
): Promise<WorkspaceEntriesAtResult | null> {
  if (!runtimeControllerEnabled) {
    return null;
  }

  const projectId = params.projectId.trim();
  if (!projectId) {
    return null;
  }
  if (hasPinConflict(params)) {
    return { ok: false, error: invalidPinError(), originId: null, originMode: null };
  }

  const path = (params.path ?? "").trim().replace(/^\/+|\/+$/g, "");
  const routing = params.routing ?? "legacy";
  const runtimeHint = routing === "legacy" ? (params.runtimeId ?? null) : null;
  let lastToken: OriginAccessTokenResponse | null = null;

  try {
    const requestToken = async (preferRuntime: string | null) =>
      requestOriginAccessToken(
        routing === "default"
          ? {
              projectId,
              protocol: "http",
              scopes: ["fs.read"],
              originId: params.originId ?? null,
              accessToken: params.accessToken ?? null,
            }
          : {
              projectId,
              protocol: "http",
              scopes: ["fs.read"],
              originId: params.originId ?? null,
              preferRuntime,
              accessToken: params.accessToken ?? null,
            },
      );

    const fetchEntries = async (token: OriginAccessTokenResponse) => {
      lastToken = token;
      const endpoint = normalizeOriginEndpointForClient(token.endpoint);
      const search = new URLSearchParams();
      if (path.length > 0) {
        search.set("path", path);
      }
      if (params.syncMode === "blocking") {
        search.set("sync", "blocking");
      }
      applyReadPin(search, params);
      const url = `${endpoint}/entries${search.toString() ? `?${search.toString()}` : ""}`;

      const abortController =
        typeof AbortController === "function" ? new AbortController() : null;
      const timeoutHandle =
        abortController !== null
          ? setTimeout(() => {
              abortController.abort();
            }, WORKSPACE_LIST_TIMEOUT_MS)
          : null;

      const response = await fetch(url, {
        headers: originHeaders(token.token, { accept: "application/json" }),
        cache: "no-store",
        signal: abortController?.signal,
      }).finally(() => {
        if (timeoutHandle !== null) {
          clearTimeout(timeoutHandle);
        }
      });
      const rev = headerValue(response.headers, ORIGIN_REV_HEADER);

      if (response.status === 404) {
        const text = await response.text().catch(() => "");
        const info = parseOriginErrorText(response.status, text, response.headers);
        if (info.code === "rev_not_found") {
          throw new OriginResponseError(`origin list failed (404): ${text}`, info);
        }
        return { entries: [] as ControllerWorkspaceEntry[], rev };
      }

      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new OriginResponseError(
          `origin list failed (${response.status}): ${text}`,
          parseOriginErrorText(response.status, text, response.headers),
        );
      }

      const payload = (await response.json()) as Array<Record<string, unknown>>;
      return { entries: payload.map((entry) => normalizeWorkspaceEntry(entry)), rev };
    };

    const success = (
      listing: { entries: ControllerWorkspaceEntry[]; rev: string | null },
      token: OriginAccessTokenResponse,
    ): WorkspaceEntriesAtResult => ({
      ok: true,
      entries: listing.entries,
      rev: listing.rev,
      originId: token.originId ?? null,
      originMode: token.mode ?? null,
    });

    let preferredError: unknown = null;
    if (runtimeHint) {
      const preferredToken = await requestToken(runtimeHint);
      if (preferredToken) {
        try {
          return success(await fetchEntries(preferredToken), preferredToken);
        } catch (error) {
          preferredError = error;
        }
      }
    }

    const fallbackToken = await requestToken(null);
    if (!fallbackToken) {
      if (preferredError) {
        throw preferredError;
      }
      return { ok: false, error: tokenUnavailableError(), originId: null, originMode: null };
    }

    return success(await fetchEntries(fallbackToken), fallbackToken);
  } catch (originError) {
    const message =
      originError instanceof Error && originError.name === "AbortError"
        ? `origin list timed out after ${WORKSPACE_LIST_TIMEOUT_MS}ms`
        : originError instanceof Error
          ? originError.message
          : String(originError);
    console.warn("[runtime-controller] listWorkspaceEntries error:", message);
    const token = lastToken as OriginAccessTokenResponse | null;
    return {
      ok: false,
      error:
        originError instanceof OriginResponseError
          ? originError.info
          : originErrorFromException(originError),
      originId: token?.originId ?? null,
      originMode: token?.mode ?? null,
    };
  }
}

export async function readWorkspaceFileFromController(
  params: ReadControllerWorkspaceFileParams,
): Promise<ControllerWorkspaceFileContent | null> {
  const result = await readWorkspaceFileAt(params);
  return result?.ok ? result.file : null;
}

/**
 * Read a file and report its blob id and the commit it was served from.
 * A plain 404 is `notFound`; `rev_not_found`, 413 `too_large` and other
 * answers come back as errors.
 */
export async function readWorkspaceFileAt(
  params: ReadControllerWorkspaceFileParams,
): Promise<WorkspaceFileReadResult | null> {
  if (!runtimeControllerEnabled) {
    return null;
  }

  const projectId = params.projectId.trim();
  const path = params.path.trim();
  if (!projectId || !path) {
    return null;
  }
  if (hasPinConflict(params)) {
    return {
      ok: false,
      notFound: false,
      error: invalidPinError(),
      originId: null,
      originMode: null,
    };
  }

  const normalizedPath = normalizeWorkspaceRelativePath(path);
  const runtimeHint = params.runtimeId ?? null;
  let originToken: OriginAccessTokenResponse | null = null;

  try {
    originToken = await requestOriginAccessToken(
      params.routing === "default"
        ? {
            projectId,
            protocol: "http",
            scopes: ["fs.read"],
            originId: params.originId ?? null,
            accessToken: params.accessToken ?? null,
            timeoutMs: params.timeoutMs,
          }
        : {
            projectId,
            protocol: "http",
            scopes: ["fs.read"],
            originId: params.originId ?? null,
            preferRuntime: runtimeHint,
            accessToken: params.accessToken ?? null,
            timeoutMs: params.timeoutMs,
          },
    );

    if (!originToken) {
      return {
        ok: false,
        notFound: false,
        error: tokenUnavailableError(),
        originId: null,
        originMode: null,
      };
    }

    const endpoint = normalizeOriginEndpointForClient(originToken.endpoint);
    const pathSegments = normalizedPath
      .split("/")
      .filter((segment) => segment.length > 0)
      .map((segment) => encodeURIComponent(segment));
    const encodedPath = pathSegments.join("/");
    const search = new URLSearchParams();
    search.set("encoding", "base64");
    applyReadPin(search, params);
    const url = `${endpoint}/files/${encodedPath}?${search.toString()}`;

    const timeoutMs =
      typeof params.timeoutMs === "number" && Number.isFinite(params.timeoutMs) && params.timeoutMs > 0
        ? params.timeoutMs
        : WORKSPACE_READ_TIMEOUT_MS;
    const abortController =
      typeof AbortController === "function" ? new AbortController() : null;
    const timeoutHandle =
      abortController !== null
        ? setTimeout(() => {
            abortController.abort();
          }, timeoutMs)
        : null;

    const response = await fetch(url, {
      headers: originHeaders(originToken.token, { accept: "application/json" }),
      cache: "no-store",
      signal: abortController?.signal,
    }).finally(() => {
      if (timeoutHandle !== null) {
        clearTimeout(timeoutHandle);
      }
    });

    if (response.status === 404) {
      const text = await response.text().catch(() => "");
      const error = parseOriginErrorText(response.status, text, response.headers);
      return {
        ok: false,
        notFound: error.code !== "rev_not_found",
        error,
        originId: originToken.originId ?? null,
        originMode: originToken.mode ?? null,
      };
    }

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new OriginResponseError(
        `origin read failed (${response.status}): ${text}`,
        parseOriginErrorText(response.status, text, response.headers),
      );
    }

    const payload = (await response.json()) as Record<string, unknown>;
    const resolvedPath =
      typeof payload.path === "string" && payload.path.trim().length > 0
        ? payload.path
        : normalizedPath;
    const encoding =
      typeof payload.encoding === "string" &&
      payload.encoding.trim().length > 0
        ? payload.encoding
        : "base64";
    const contentBase64 =
      typeof payload.content_base64 === "string"
        ? (payload.content_base64 as string)
        : typeof payload.contentBase64 === "string"
          ? (payload.contentBase64 as string)
          : typeof payload.content === "string"
            ? (payload.content as string)
            : "";
    const mimeTypeRaw =
      typeof payload.mime_type === "string"
        ? (payload.mime_type as string)
        : typeof payload.mimeType === "string"
          ? (payload.mimeType as string)
          : null;
    const mimeType =
      mimeTypeRaw && mimeTypeRaw.length > 0 ? mimeTypeRaw : null;
    const bytes = decodeBase64(contentBase64);
    const isText = isTextLikeFile(mimeType, resolvedPath, bytes);
    const contentText = isText ? bytesToUtf8(bytes) : null;
    const sizeRaw =
      typeof payload.size === "number"
        ? payload.size
        : typeof payload.length === "number"
          ? payload.length
          : undefined;
    const size =
      typeof sizeRaw === "number"
        ? sizeRaw
        : isText
          ? (contentText?.length ?? bytes.length)
          : bytes.length;
    const bodyBlobOid =
      typeof payload.blobOid === "string" && payload.blobOid.length > 0
        ? payload.blobOid
        : typeof payload.blob_oid === "string" && payload.blob_oid.length > 0
          ? payload.blob_oid
          : null;

    return {
      ok: true,
      file: {
        path: resolvedPath,
        size,
        encoding,
        mimeType,
        contentBase64,
        contentText,
        isText,
        blobOid: headerValue(response.headers, ORIGIN_BLOB_HEADER) ?? bodyBlobOid,
        rev: headerValue(response.headers, ORIGIN_REV_HEADER),
        originId: originToken.originId ?? null,
        originMode: originToken.mode ?? null,
      },
    };
  } catch (error) {
    const timeoutMs =
      typeof params.timeoutMs === "number" && Number.isFinite(params.timeoutMs) && params.timeoutMs > 0
        ? params.timeoutMs
        : WORKSPACE_READ_TIMEOUT_MS;
    const message =
      error instanceof Error && error.name === "AbortError"
        ? `origin read timed out after ${timeoutMs}ms`
        : error instanceof Error
          ? error.message
          : String(error);
    console.warn("[runtime-controller] readWorkspaceFile error:", message);
    const token = originToken as OriginAccessTokenResponse | null;
    return {
      ok: false,
      notFound: false,
      error: error instanceof OriginResponseError ? error.info : originErrorFromException(error),
      originId: token?.originId ?? null,
      originMode: token?.mode ?? null,
    };
  }
}

export async function writeWorkspaceFileToController(
  params: WriteControllerWorkspaceFileParams,
): Promise<ControllerWorkspaceWriteResponse | null> {
  if (!runtimeControllerEnabled) {
    return null;
  }

  const projectId = params.projectId.trim();
  const path = params.path.trim();
  if (!projectId || !path) {
    return null;
  }

  const normalizedPath = path.replace(/\\+/g, "/");
  const runtimeHint = params.runtimeId ?? null;
  const content = params.content ?? "";
  const size = new TextEncoder().encode(content).length;

  try {
    const result = await applyWorkspaceChangesViaOrigin({
      projectId,
      files: [
        {
          path: normalizedPath,
          content,
          encoding: "utf8",
        },
      ],
      deletes: [],
      leaseId: params.leaseId ?? null,
      leaseSeconds: params.leaseSeconds,
      retainLease: params.retainLease ?? false,
      originId: params.originId ?? null,
      preferRuntime: runtimeHint,
      runtimeId: runtimeHint,
      accessToken: params.accessToken ?? null,
    });

    if (!result.ok) {
      throw new Error(result.error ?? "origin apply failed");
    }

    return {
      ok: true,
      path: normalizedPath,
      size,
      rev: result.rev ?? null,
      leaseId: result.leaseId ?? null,
      originMode: result.mode ?? null,
      originEndpoint: result.endpoint ?? null,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn("[runtime-controller] writeWorkspaceFile error:", message);
    return null;
  }
}

export async function deleteWorkspaceFileFromController(
  params: DeleteControllerWorkspaceFileParams,
): Promise<ControllerWorkspaceDeleteResponse | null> {
  if (!runtimeControllerEnabled) {
    return null;
  }

  const projectId = params.projectId.trim();
  const path = params.path.trim();
  if (!projectId || !path) {
    return null;
  }

  const normalizedPath = path.replace(/\\+/g, "/");
  const runtimeHint = params.runtimeId ?? null;

  try {
    const result = await applyWorkspaceChangesViaOrigin({
      projectId,
      files: [],
      deletes: [normalizedPath],
      leaseId: params.leaseId ?? null,
      leaseSeconds: params.leaseSeconds,
      retainLease: params.retainLease ?? false,
      originId: params.originId ?? null,
      preferRuntime: runtimeHint,
      runtimeId: runtimeHint,
      accessToken: params.accessToken ?? null,
    });

    if (!result.ok) {
      throw new Error(result.error ?? "origin delete failed");
    }

    return {
      ok: true,
      path: normalizedPath,
      deleted: true,
      rev: result.rev ?? null,
      leaseId: result.leaseId ?? null,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn("[runtime-controller] deleteWorkspaceFile error:", message);
    return null;
  }
}

export async function getWorkspaceFileRawUrl(
  params: ReadControllerWorkspaceFileParams,
): Promise<string | null> {
  if (!runtimeControllerEnabled) {
    return null;
  }

  const projectId = params.projectId.trim();
  const path = params.path.trim();
  if (!projectId || !path) {
    return null;
  }

  if (hasPinConflict(params)) {
    return null;
  }

  const normalizedPath = normalizeWorkspaceRelativePath(path);
  const runtimeHint = params.runtimeId ?? null;

  try {
    const originToken = await requestOriginAccessToken(
      params.routing === "default"
        ? {
            projectId,
            protocol: "http",
            scopes: ["fs.read"],
            originId: params.originId ?? null,
            accessToken: params.accessToken ?? null,
          }
        : {
            projectId,
            protocol: "http",
            scopes: ["fs.read"],
            originId: params.originId ?? null,
            preferRuntime: runtimeHint,
            accessToken: params.accessToken ?? null,
          },
    );

    if (!originToken) {
      return null;
    }

    if (originToken) {
      const endpoint = normalizeOriginEndpointForClient(originToken.endpoint);
      const encodedPath = normalizeWorkspaceRelativePath(normalizedPath)
        .split("/")
        .filter((segment) => segment.length > 0)
        .map((segment) => encodeURIComponent(segment))
        .join("/");
      const url = new URL(`${endpoint}/raw/${encodedPath}`);
      url.searchParams.set("token", originToken.token);
      applyReadPin(url.searchParams, params);
      return url.toString();
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn("[runtime-controller] getWorkspaceFileRawUrl error:", message);
    return null;
  }

  // Fallback: no origin token available or non-exceptional fallthrough
  return null;
}

function normalizeWorkspaceEntry(
  entry: Record<string, unknown>,
): ControllerWorkspaceEntry {
  const name =
    typeof entry.name === "string" && entry.name.length > 0 ? entry.name : "";
  const path =
    typeof entry.path === "string" && entry.path.length > 0 ? entry.path : name;
  const kindRaw = typeof entry.kind === "string" ? entry.kind : "other";
  const kind: ControllerWorkspaceEntryKind =
    kindRaw === "file" || kindRaw === "directory" || kindRaw === "other"
      ? kindRaw
      : "other";
  const size =
    typeof entry.size === "number" && Number.isFinite(entry.size)
      ? entry.size
      : null;
  const modified =
    typeof entry.modified === "string" && entry.modified.length > 0
      ? entry.modified
      : null;
  const mimeType =
    typeof entry.mime_type === "string" && entry.mime_type.length > 0
      ? entry.mime_type
      : typeof entry.mimeType === "string" && entry.mimeType.length > 0
        ? entry.mimeType
        : null;
  const extension =
    typeof entry.extension === "string" && entry.extension.length > 0
      ? entry.extension
      : extractExtension(path);
  const hasChildrenValue =
    typeof entry.has_children === "boolean"
      ? entry.has_children
      : typeof entry.hasChildren === "boolean"
        ? entry.hasChildren
        : undefined;
  const blobOid =
    typeof entry.blobOid === "string" && entry.blobOid.length > 0
      ? entry.blobOid
      : typeof entry.blob_oid === "string" && entry.blob_oid.length > 0
        ? entry.blob_oid
        : null;

  const normalized: ControllerWorkspaceEntry = {
    name,
    path,
    kind,
    size,
    modified,
    mimeType,
    extension,
    hasChildren: hasChildrenValue,
  };
  if (blobOid) {
    normalized.blobOid = blobOid;
  }
  return normalized;
}
