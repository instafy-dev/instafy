import {
  normalizeOriginEndpointForClient,
  runtimeControllerEnabled,
} from "./core";
import { requestOriginAccessToken } from "./origins";
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

export interface ListControllerWorkspaceParams {
  projectId: string;
  path?: string | null;
  accessToken?: string | null;
  runtimeId?: string | null;
  originId?: string | null;
  syncMode?: "background" | "blocking";
}

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
}

export interface ReadControllerWorkspaceFileParams {
  projectId: string;
  path: string;
  accessToken?: string | null;
  runtimeId?: string | null;
  originId?: string | null;
  timeoutMs?: number;
}

export interface ControllerWorkspaceFileContent {
  path: string;
  size: number;
  encoding: string;
  mimeType: string | null;
  contentBase64: string;
  contentText: string | null;
  isText: boolean;
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
  if (!runtimeControllerEnabled) {
    return null;
  }

  const projectId = params.projectId.trim();
  if (!projectId) {
    return null;
  }

  const path = (params.path ?? "").trim().replace(/^\/+|\/+$/g, "");
  const runtimeHint = params.runtimeId ?? null;

  try {
    const requestToken = async (preferRuntime: string | null) =>
      requestOriginAccessToken({
        projectId,
        protocol: "http",
        scopes: ["fs.read"],
        originId: params.originId ?? null,
        preferRuntime,
        accessToken: params.accessToken ?? null,
      });

    const fetchEntries = async (
      token: NonNullable<Awaited<ReturnType<typeof requestToken>>>,
    ) => {
      const endpoint = normalizeOriginEndpointForClient(token.endpoint);
      const search = new URLSearchParams();
      if (path.length > 0) {
        search.set("path", path);
      }
      if (params.syncMode === "blocking") {
        search.set("sync", "blocking");
      }
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
        headers: {
          authorization: `Bearer ${token.token}`,
          accept: "application/json",
        },
        cache: "no-store",
        signal: abortController?.signal,
      }).finally(() => {
        if (timeoutHandle !== null) {
          clearTimeout(timeoutHandle);
        }
      });

      if (response.status === 404) {
        return [] as ControllerWorkspaceEntry[];
      }

      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new Error(`origin list failed (${response.status}): ${text}`);
      }

      const payload = (await response.json()) as Array<Record<string, unknown>>;
      return payload.map((entry) => normalizeWorkspaceEntry(entry));
    };

    let preferredError: unknown = null;
    if (runtimeHint) {
      const preferredToken = await requestToken(runtimeHint);
      if (preferredToken) {
        try {
          return await fetchEntries(preferredToken);
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
      return null;
    }

    return await fetchEntries(fallbackToken);
  } catch (originError) {
    const message =
      originError instanceof Error && originError.name === "AbortError"
        ? `origin list timed out after ${WORKSPACE_LIST_TIMEOUT_MS}ms`
        : originError instanceof Error
          ? originError.message
          : String(originError);
    console.warn("[runtime-controller] listWorkspaceEntries error:", message);
    return null;
  }
}

export async function readWorkspaceFileFromController(
  params: ReadControllerWorkspaceFileParams,
): Promise<ControllerWorkspaceFileContent | null> {
  if (!runtimeControllerEnabled) {
    return null;
  }

  const projectId = params.projectId.trim();
  const path = params.path.trim();
  if (!projectId || !path) {
    return null;
  }

  const normalizedPath = normalizeWorkspaceRelativePath(path);
  const runtimeHint = params.runtimeId ?? null;

  try {
    const originToken = await requestOriginAccessToken({
      projectId,
      protocol: "http",
      scopes: ["fs.read"],
      originId: params.originId ?? null,
      preferRuntime: runtimeHint,
      accessToken: params.accessToken ?? null,
      timeoutMs: params.timeoutMs,
    });

    if (!originToken) {
      return null;
    }

    if (originToken) {
      const endpoint = normalizeOriginEndpointForClient(originToken.endpoint);
      const pathSegments = normalizedPath
        .split("/")
        .filter((segment) => segment.length > 0)
        .map((segment) => encodeURIComponent(segment));
      const encodedPath = pathSegments.join("/");
      const url = `${endpoint}/files/${encodedPath}?encoding=base64`;

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
        headers: {
          authorization: `Bearer ${originToken.token}`,
          accept: "application/json",
        },
        cache: "no-store",
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
        const text = await response.text().catch(() => "");
        throw new Error(`origin read failed (${response.status}): ${text}`);
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

      return {
        path: resolvedPath,
        size,
        encoding,
        mimeType,
        contentBase64,
        contentText,
        isText,
      };
    }
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
    return null;
  }

  // Fallback: no origin token available or non-exceptional fallthrough
  return null;
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

  const normalizedPath = normalizeWorkspaceRelativePath(path);
  const runtimeHint = params.runtimeId ?? null;

  try {
    const originToken = await requestOriginAccessToken({
      projectId,
      protocol: "http",
      scopes: ["fs.read"],
      originId: params.originId ?? null,
      preferRuntime: runtimeHint,
      accessToken: params.accessToken ?? null,
    });

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

  return {
    name,
    path,
    kind,
    size,
    modified,
    mimeType,
    extension,
    hasChildren: hasChildrenValue,
  };
}
