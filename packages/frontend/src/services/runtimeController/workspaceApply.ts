import { zipSync, strToU8 } from "fflate";
import { runtimeControllerEnabled } from "./core";
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
}

export interface OriginApplyResult {
  ok: boolean;
  rev?: string | null;
  mode?: string;
  endpoint?: string;
  leaseId?: string | null;
  error?: string;
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

  let runtimePreference = params.preferRuntime ?? params.runtimeId ?? null;
  let runtimeId = params.runtimeId ?? runtimePreference ?? null;
  const retainLease = params.retainLease === true;
  let leaseId = params.leaseId ?? null;
  let leaseIdForRelease: string | null = null;
  let acquiredLease: WorkspaceLease | null = null;

  try {
    const origin = await fetchOriginSummary({
      projectId,
      protocol: "http",
      accessToken: params.accessToken ?? null,
    });
    if (!origin) {
      return { ok: false, error: "no origin available" };
    }
    if (origin.presence?.status === "offline") {
      return { ok: false, error: "origin is offline" };
    }
    const requestedOriginId = params.originId?.trim() || null;
    if (
      !runtimePreference &&
      (!requestedOriginId || requestedOriginId === origin.originId)
    ) {
      runtimePreference = origin.runtimeId ?? null;
      runtimeId = params.runtimeId ?? runtimePreference;
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
      originId: params.originId ?? origin.originId,
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

    const response = await fetch(applyUrl, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token.token}`,
      },
      body: formData,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      return {
        ok: false,
        mode: token.mode,
        endpoint: endpoint,
        leaseId: leaseId ?? null,
        error: `origin apply failed (${response.status}): ${text}`,
      };
    }

    let rev: string | null = null;
    const contentType = response.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      const body = (await response.json()) as Record<string, unknown>;
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
    };
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
