import { normalizeSpaceIcon, normalizeSpaceColor, type ProjectIdentity, type ProjectIdentityUpdate } from "@instafy/sdk/project-identity";
import {
  ControllerApiError,
  normalizeUuidParam,
  readControllerApiError,
  readControllerError,
  resolveControllerRequestContext,
  runtimeControllerEnabled,
  type ControllerRequestContext,
} from "./core";
export { deriveGithubImportTargetPath } from "./githubImportPath";
import { logControllerRequestError } from "./logging";
import { createControllerReadBudget } from "./readBudget";
import { PERSONAL_ORG_LABEL } from "../../org/orgNaming";

export interface ControllerProjectCreateParams {
  projectType?: "sandbox" | "customer";
  orgSlug?: string | null;
  orgName?: string | null;
  orgId?: string | null;
  projectName?: string | null;
}

export interface ControllerProjectCreateResult {
  projectId: string;
  orgId: string | null;
  orgName: string | null;
  projectName: string | null;
}

export interface ControllerProjectMemoryBootstrapResult {
  ok: boolean;
  seeded: boolean;
  fileCount: number;
  rev: string | null;
  reason: string | null;
}

export interface ControllerOrgSummary {
  id: string;
  slug: string;
  name: string;
  avatarUrl?: string | null;
  accentColor?: string | null;
  role?: string | null;
}

export interface ControllerProjectSummary extends ProjectIdentity {
  projectId: string;
  projectName?: string | null;
  orgId: string | null;
  orgSlug?: string | null;
  orgName?: string | null;
  ownerUserId?: string | null;
  projectType?: string | null;
  status?: string | null;
  effectiveRole?: "viewer" | "builder" | "admin" | "owner" | string | null;
  canWrite?: boolean;
  canShare?: boolean;
  canManage?: boolean;
}

export type ControllerProjectListResult =
  | { status: "success"; projects: ControllerProjectSummary[] }
  | { status: "unsupported" }
  | { status: "error" };

export interface ControllerOrgMember {
  userId: string;
  email?: string | null;
  fullName?: string | null;
  role: string;
  invitedBy?: string | null;
  createdAt: string;
}

export interface ControllerOrgMembersPage {
  members: ControllerOrgMember[];
  nextCursor: string | null;
  hasMore: boolean;
  total: number | null;
}

export interface ControllerProjectMember {
  userId: string;
  email?: string | null;
  fullName?: string | null;
  role: string;
  invitedBy?: string | null;
  createdAt: string;
}

export interface ImportGithubProjectParams {
  projectId: string;
  repo: string;
  ref?: string | null;
  targetPath?: string | null;
  githubToken?: string | null;
  githubDeviceAuthSessionId?: string | null;
  idempotencyKey?: string | null;
  accessToken?: string | null;
}

export interface ImportGithubProjectResult {
  success: boolean;
  rev?: string;
  fileCount?: number;
  bytesWritten?: number;
  targetPath?: string | null;
  error?: string;
  errorCode?: string | null;
  status?: number;
}

// Large repositories (e.g. rust-lang/rust) can take several minutes to
// download, repack, and apply through origin. Keep client timeout aligned
// with backend long-running import behavior.
const GITHUB_IMPORT_TIMEOUT_MS = 15 * 60 * 1000;
const GITHUB_IMPORT_WORKSPACE_BUSY_RETRY_DELAYS_MS = [250, 500, 1_000, 2_000, 4_000, 8_000] as const;
const ORG_INVITATION_TIMEOUT_MS = 12 * 1000;

function isRetryableGithubImportWorkspaceBusy(error: {
  status: number;
  code: string | null;
  details: unknown;
}): boolean {
  if (error.status !== 409 || error.code !== "workspace_busy") {
    return false;
  }
  const details =
    error.details && typeof error.details === "object"
      ? (error.details as Record<string, unknown>)
      : null;
  return details?.retryable === true;
}

export interface ControllerOrgInvitation {
  id: string;
  orgId: string;
  projectId?: string | null;
  conversationId?: string | null;
  email: string;
  role: string;
  invitedBy?: string | null;
  status: string;
  createdAt: string;
  expiresAt?: string | null;
}

export interface ControllerOrgInvitationPreview {
  kind: "invitation" | "inviteLink";
  orgId: string;
  orgSlug: string;
  orgName: string;
  role: string;
  invitedEmailMasked: string | null;
  inviterName: string | null;
  inviterEmail: string | null;
  projectId: string | null;
  projectName: string | null;
  conversationId: string | null;
  conversationName: string | null;
  expiresAt: string | null;
}

export interface ControllerOrgInvitationCreation extends ControllerOrgInvitation {
  /**
   * One-time creation response value. Pending-invitation list responses never
   * include this bearer link, so callers should offer copy/share immediately.
   */
  acceptUrl: string;
}

export interface ControllerOrgInviteLink {
  id: string;
  orgId: string;
  projectId?: string | null;
  conversationId?: string | null;
  role: string;
  status: string;
  createdAt: string;
  expiresAt?: string | null;
  token: string;
  acceptPath: string;
}

type ControllerOrganizationCreateParams = {
  accentColor?: string | null;
  orgSlug?: string | null;
  orgName?: string | null;
};

async function createControllerOrganizationWithContext(
  params: ControllerOrganizationCreateParams | undefined,
  requestContext: ControllerRequestContext,
): Promise<ControllerOrgSummary | null> {
  const accessToken = requestContext.accessToken;
  if (!accessToken) {
    return null;
  }
  const payload: Record<string, unknown> = {};
  if (params?.accentColor) payload.accentColor = params.accentColor;
  if (params?.orgSlug) {
    payload.orgSlug = params.orgSlug;
  }
  if (params?.orgName) {
    payload.orgName = params.orgName;
  }
  try {
    const response = await fetch(`${requestContext.baseUrl}/orgs`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      const message = await readControllerError(
        response,
        "create org failed",
        requestContext,
      );
      throw new Error(message);
    }
    const body = (await response.json().catch(() => null)) as {
      accentColor?: string | null;
      orgId?: string | null;
      orgSlug?: string | null;
      orgName?: string | null;
    } | null;
    const orgId =
      typeof body?.orgId === "string" && body.orgId.length > 0 ? body.orgId : null;
    const orgSlug =
      typeof body?.orgSlug === "string" && body.orgSlug.length > 0 ? body.orgSlug : null;
    const orgName =
      typeof body?.orgName === "string" && body.orgName.length > 0 ? body.orgName : null;
    if (!orgId || !orgSlug || !orgName) {
      return null;
    }
    return { id: orgId, slug: orgSlug, name: orgName, accentColor: body?.accentColor ?? null };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn("[runtime-controller] createControllerOrganization error:", message);
    return null;
  }
}

export async function createControllerOrganization(
  params?: ControllerOrganizationCreateParams,
): Promise<ControllerOrgSummary | null> {
  if (!runtimeControllerEnabled) {
    return null;
  }
  const requestContext = await resolveControllerRequestContext(null);
  return createControllerOrganizationWithContext(params, requestContext);
}

export async function createControllerProject(
  params: ControllerProjectCreateParams = {},
): Promise<ControllerProjectCreateResult | null> {
  if (!runtimeControllerEnabled) {
    return null;
  }
  const requestContext = await resolveControllerRequestContext(null);
  const accessToken = requestContext.accessToken;
  if (!accessToken) {
    return null;
  }
  const normalizedOrgId = normalizeUuidParam(params.orgId ?? null);
  let resolvedOrgId = normalizedOrgId ?? null;
  let resolvedOrgName = params.orgName ?? null;
  if (!resolvedOrgId) {
    const fallbackOrgName =
      typeof params.orgName === "string" && params.orgName.trim().length > 0
        ? params.orgName.trim()
        : PERSONAL_ORG_LABEL;
    const org = await createControllerOrganizationWithContext(
      {
        orgSlug: params.orgSlug ?? null,
        orgName: fallbackOrgName,
      },
      requestContext,
    );
    resolvedOrgId = org?.id ?? null;
    resolvedOrgName = org?.name ?? resolvedOrgName;
  }
  if (!resolvedOrgId) {
    return null;
  }

  const payload: Record<string, unknown> = {};
  if (params.projectType) {
    payload.projectType = params.projectType;
  }
  if (params.projectName && params.projectName.trim().length > 0) {
    payload.projectName = params.projectName.trim();
  }
  try {
    const response = await fetch(
      `${requestContext.baseUrl}/orgs/${encodeURIComponent(resolvedOrgId)}/projects`,
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
      const message = await readControllerError(
        response,
        "create project failed",
        requestContext,
      );
      throw new Error(message);
    }
    const body = (await response.json().catch(() => null)) as {
      projectId?: string | null;
      projectName?: string | null;
      orgId?: string | null;
      orgName?: string | null;
    } | null;
    const projectId =
      typeof body?.projectId === "string" && body.projectId.length > 0
        ? body.projectId
        : null;
    if (!projectId) {
      return null;
    }
    return {
      projectId,
      projectName:
        typeof body?.projectName === "string" && body.projectName.trim().length > 0
          ? body.projectName.trim()
          : params.projectName?.trim() || null,
      orgId:
        typeof body?.orgId === "string" && body.orgId.length > 0
          ? body.orgId
          : resolvedOrgId,
      orgName:
        typeof body?.orgName === "string" && body.orgName.length > 0
          ? body.orgName
          : resolvedOrgName,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn("[runtime-controller] createControllerProject error:", message);
    return null;
  }
}

export async function bootstrapControllerProjectMemory(params: {
  projectId: string;
  accessToken?: string | null;
}): Promise<ControllerProjectMemoryBootstrapResult | null> {
  if (!runtimeControllerEnabled) {
    return null;
  }

  const projectId = normalizeUuidParam(params.projectId ?? null);
  if (!projectId) {
    return null;
  }

  const requestContext = await resolveControllerRequestContext(params.accessToken ?? null);
  const accessToken = requestContext.accessToken;
  if (!accessToken) {
    return null;
  }

  try {
    const response = await fetch(
      `${requestContext.baseUrl}/projects/${encodeURIComponent(projectId)}/memory/bootstrap`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${accessToken}`,
        },
      },
    );

    if (!response.ok) {
      const message = await readControllerError(
        response,
        "bootstrap memory failed",
        requestContext,
      );
      throw new Error(message);
    }

    const payload = (await response.json().catch(() => null)) as
      | {
          ok?: boolean;
          seeded?: boolean;
          fileCount?: number;
          rev?: string | null;
          reason?: string | null;
        }
      | null;

    return {
      ok: payload?.ok !== false,
      seeded: payload?.seeded === true,
      fileCount: typeof payload?.fileCount === "number" ? payload.fileCount : 0,
      rev: typeof payload?.rev === "string" && payload.rev.trim().length > 0 ? payload.rev.trim() : null,
      reason:
        typeof payload?.reason === "string" && payload.reason.trim().length > 0
          ? payload.reason.trim()
          : null,
    };
  } catch (error) {
    logControllerRequestError("[runtime-controller] bootstrapControllerProjectMemory error:", error, {
      suppressLikelyConnectionNoise: true,
    });
    return null;
  }
}

export async function listControllerProjects(params?: {
  orgId?: string | null;
  signal?: AbortSignal;
}): Promise<ControllerProjectSummary[]> {
  const result = await listControllerProjectsResult(params);
  return result.status === "success" ? result.projects : [];
}

// Cache-aware discovery must distinguish a successful empty access list from
// a failed refresh. Only an unsupported route permits legacy discovery.
export async function listControllerProjectsResult(params?: {
  orgId?: string | null;
  signal?: AbortSignal;
}): Promise<ControllerProjectListResult> {
  if (!runtimeControllerEnabled) {
    return { status: "error" };
  }
  const budget = createControllerReadBudget(params?.signal);
  try {
    const requestContext = await budget.wait(() => resolveControllerRequestContext(null));
    const accessToken = requestContext.accessToken;
    if (!accessToken) {
      return { status: "error" };
    }
    const normalizedOrgId = normalizeUuidParam(params?.orgId ?? null);
    const url = normalizedOrgId
      ? `${requestContext.baseUrl}/orgs/${encodeURIComponent(normalizedOrgId)}/projects`
      : `${requestContext.baseUrl}/projects`;
    const response = await budget.wait(() => fetch(url, {
      signal: budget.signal,
      headers: {
        authorization: `Bearer ${accessToken}`,
      },
    }));
    if (response.status === 404 || response.status === 405) {
      return { status: "unsupported" };
    }
    if (!response.ok) {
      const message = await budget.wait(() => readControllerError(
        response,
        "list projects failed",
        requestContext,
      ));
      throw new Error(message);
    }
    const payload = (await budget.wait(() => response.json().catch(() => null))) as {
      projects?: ControllerProjectSummary[];
    } | null;
    if (payload?.projects && Array.isArray(payload.projects)) {
      return {
        status: "success",
        projects: payload.projects.filter(
          (project) => typeof project.projectId === "string" && project.projectId.length > 0,
        ),
      };
    }
    throw new Error("list projects returned an invalid response");
  } catch (error) {
    params?.signal?.throwIfAborted();
    logControllerRequestError("[runtime-controller] listControllerProjects error:", error, {
      suppressLikelyConnectionNoise: true,
    });
  } finally {
    budget.dispose();
  }
  return { status: "error" };
}

export async function importGithubProject(
  params: ImportGithubProjectParams,
): Promise<ImportGithubProjectResult> {
  if (!runtimeControllerEnabled) {
    return { success: false, error: "Runtime controller is not configured." };
  }
  const projectId = normalizeUuidParam(params.projectId ?? null);
  if (!projectId) {
    return { success: false, error: "projectId must be a valid UUID." };
  }
  const repo = (params.repo ?? "").trim();
  if (!repo) {
    return { success: false, error: "repo is required." };
  }

  const requestContext = await resolveControllerRequestContext(params.accessToken ?? null);
  const accessToken = requestContext.accessToken;
  if (!accessToken) {
    return { success: false, error: "Missing controller session token." };
  }

  const payload: Record<string, unknown> = { repo };
  const refValue = (params.ref ?? "").trim();
  if (refValue) {
    payload.ref = refValue;
  }
  const targetPath = (params.targetPath ?? "").trim().replace(/^\/+|\/+$/g, "");
  if (targetPath) {
    payload.targetPath = targetPath;
  }
  const githubToken = (params.githubToken ?? "").trim();
  if (githubToken) {
    payload.githubToken = githubToken;
  }
  const githubDeviceAuthSessionId = (params.githubDeviceAuthSessionId ?? "").trim();
  if (githubDeviceAuthSessionId) {
    payload.githubDeviceAuthSessionId = githubDeviceAuthSessionId;
  }
  const idempotencyKey = (params.idempotencyKey ?? "").trim();
  if (idempotencyKey) {
    payload.idempotencyKey = idempotencyKey;
  }

  const abortController =
    typeof AbortController === "function" ? new AbortController() : null;
  const timeoutHandle =
    abortController !== null
      ? setTimeout(() => {
          abortController.abort();
        }, GITHUB_IMPORT_TIMEOUT_MS)
      : null;

  try {
    for (let attempt = 0; ; attempt += 1) {
      const response = await fetch(
        `${requestContext.baseUrl}/projects/${encodeURIComponent(projectId)}/import/github`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${accessToken}`,
            accept: "application/json",
            "content-type": "application/json",
          },
          body: JSON.stringify(payload),
          signal: abortController?.signal,
        },
      );

      if (!response.ok) {
        const errorPayload = await readControllerApiError(
          response,
          "GitHub import failed",
          requestContext,
        );
        const retryDelayMs = GITHUB_IMPORT_WORKSPACE_BUSY_RETRY_DELAYS_MS[attempt];
        if (
          idempotencyKey &&
          isRetryableGithubImportWorkspaceBusy(errorPayload) &&
          retryDelayMs !== undefined
        ) {
          await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
          continue;
        }
        return {
          success: false,
          error: errorPayload.message,
          errorCode: errorPayload.code,
          status: errorPayload.status,
        };
      }

      const body = (await response.json().catch(() => null)) as {
        ok?: boolean;
        rev?: string;
        fileCount?: number;
        bytesWritten?: number;
        targetPath?: string | null;
      } | null;
      if (!body?.ok) {
        return { success: false, error: "GitHub import response missing ok." };
      }
      return {
        success: true,
        rev: typeof body.rev === "string" ? body.rev : undefined,
        fileCount: typeof body.fileCount === "number" ? body.fileCount : undefined,
        bytesWritten: typeof body.bytesWritten === "number" ? body.bytesWritten : undefined,
        targetPath:
          typeof body.targetPath === "string" && body.targetPath.trim().length > 0
            ? body.targetPath.trim()
            : null,
      };
    }
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      return {
        success: false,
        error:
          "GitHub import timed out while waiting for the controller. Try again or import a narrower ref.",
      };
    }
    const message = error instanceof Error ? error.message : String(error);
    console.warn("[runtime-controller] importGithubProject error:", message);
    return { success: false, error: message };
  } finally {
    if (timeoutHandle !== null) {
      clearTimeout(timeoutHandle);
    }
  }
}

export async function getControllerProjectSummary(
  projectId: string,
  options: { signal?: AbortSignal } = {},
): Promise<ControllerProjectSummary | null> {
  const result = await getControllerProjectSummaryResult(projectId, options);
  return result.summary;
}

export interface ControllerProjectSummaryResult {
  summary: ControllerProjectSummary | null;
  notFound: boolean;
  forbidden: boolean;
  unauthorized: boolean;
}

export async function getControllerProjectSummaryResult(
  projectId: string,
  options: { signal?: AbortSignal } = {},
): Promise<ControllerProjectSummaryResult> {
  if (!runtimeControllerEnabled) {
    return { summary: null, notFound: false, forbidden: false, unauthorized: false };
  }
  const normalizedProjectId = normalizeUuidParam(projectId);
  if (!normalizedProjectId) {
    return { summary: null, notFound: false, forbidden: false, unauthorized: false };
  }
  const budget = createControllerReadBudget(options.signal);
  try {
    const requestContext = await budget.wait(() => resolveControllerRequestContext(null));
    const accessToken = requestContext.accessToken;
    if (!accessToken) {
      return { summary: null, notFound: false, forbidden: false, unauthorized: false };
    }
    const response = await budget.wait(() => fetch(
      `${requestContext.baseUrl}/projects/${encodeURIComponent(normalizedProjectId)}`,
      {
        headers: {
          authorization: `Bearer ${accessToken}`,
        },
        signal: budget.signal,
      },
    ));
    if (response.status === 404) {
      return { summary: null, notFound: true, forbidden: false, unauthorized: false };
    }
    if (response.status === 403) {
      void response.body?.cancel().catch(() => undefined);
      return { summary: null, notFound: false, forbidden: true, unauthorized: false };
    }
    if (response.status === 401) {
      // Preserve the known authorization result if its error body or recovery
      // handler stalls; callers must not mistake a denial for unavailable access.
      try {
        await budget.wait(() => readControllerError(response, "get project failed", requestContext));
      } catch {
        options.signal?.throwIfAborted();
      }
      return { summary: null, notFound: false, forbidden: false, unauthorized: true };
    }
    if (!response.ok) {
      const message = await budget.wait(() => readControllerError(
        response,
        "get project failed",
        requestContext,
      ));
      throw new Error(message);
    }
    const body = (await budget.wait(() => response.json().catch(() => null))) as
      | ControllerProjectSummary
      | null;
    if (!body || typeof body.projectId !== "string" || !body.projectId.trim()) {
      return { summary: null, notFound: false, forbidden: false, unauthorized: false };
    }
    return {
      summary: {
        ...body,
        projectId: body.projectId.trim(),
        projectName:
          typeof body.projectName === "string" && body.projectName.trim().length > 0
            ? body.projectName.trim()
            : body.projectName ?? null,
      },
      notFound: false,
      forbidden: false,
      unauthorized: false,
    };
  } catch (error) {
    options.signal?.throwIfAborted();
    const message = error instanceof Error ? error.message : String(error);
    console.warn("[runtime-controller] getControllerProjectSummary error:", message);
    return { summary: null, notFound: false, forbidden: false, unauthorized: false };
  } finally {
    budget.dispose();
  }
}

export async function updateControllerProjectIdentity(params: ProjectIdentityUpdate): Promise<ControllerProjectSummary | null> {
  if (!runtimeControllerEnabled) return null;
  const projectId = normalizeUuidParam(params.projectId);
  if (!projectId) return null;
  const payload: ProjectIdentity = {};
  for (const key of ["projectIcon", "projectColor"] as const) {
    if (params[key] === undefined) continue;
    const normalize = key === "projectIcon" ? normalizeSpaceIcon : normalizeSpaceColor;
    if (params[key] !== null && normalize(params[key]) === null) {
      throw new Error(`Unsupported ${key}.`);
    }
    Object.assign(payload, { [key]: params[key] });
  }
  if (Object.keys(payload).length === 0) throw new Error("Choose an icon or color to update.");
  const context = await resolveControllerRequestContext(null);
  if (!context.accessToken) return null;
  const response = await fetch(`${context.baseUrl}/projects/${encodeURIComponent(projectId)}`, {
    method: "PATCH",
    headers: { authorization: `Bearer ${context.accessToken}`, "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) throw new Error(await readControllerError(response, "Unable to save space appearance", context));
  const body = await response.json() as ControllerProjectSummary;
  if (body.projectId !== projectId) throw new Error("Space appearance response did not match this space.");
  return body;
}

export async function updateControllerProjectName(params: {
  projectId: string;
  projectName: string;
}): Promise<ControllerProjectSummary | null> {
  if (!runtimeControllerEnabled) {
    return null;
  }
  const normalizedProjectId = normalizeUuidParam(params.projectId);
  if (!normalizedProjectId) {
    return null;
  }
  const projectName = params.projectName.trim();
  if (!projectName) {
    throw new Error("projectName is required");
  }
  const requestContext = await resolveControllerRequestContext(null);
  const accessToken = requestContext.accessToken;
  if (!accessToken) {
    return null;
  }
  try {
    const response = await fetch(
      `${requestContext.baseUrl}/projects/${encodeURIComponent(normalizedProjectId)}`,
      {
        method: "PATCH",
        headers: {
          authorization: `Bearer ${accessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ projectName }),
      },
    );
    if (!response.ok) {
      const message = await readControllerError(
        response,
        "update project failed",
        requestContext,
      );
      throw new Error(message);
    }
    const body = (await response.json().catch(() => null)) as ControllerProjectSummary | null;
    if (!body || typeof body.projectId !== "string" || !body.projectId.trim()) {
      return null;
    }
    return {
      ...body,
      projectId: body.projectId.trim(),
      projectName:
        typeof body.projectName === "string" && body.projectName.trim().length > 0
          ? body.projectName.trim()
          : body.projectName ?? null,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn("[runtime-controller] updateControllerProjectName error:", message);
    return null;
  }
}

export async function deleteControllerProject(projectId: string): Promise<boolean> {
  if (!runtimeControllerEnabled) {
    return false;
  }
  const normalizedProjectId = normalizeUuidParam(projectId);
  if (!normalizedProjectId) {
    return false;
  }
  const requestContext = await resolveControllerRequestContext(null);
  const accessToken = requestContext.accessToken;
  if (!accessToken) {
    return false;
  }
  try {
    const response = await fetch(
      `${requestContext.baseUrl}/projects/${encodeURIComponent(normalizedProjectId)}`,
      {
        method: "DELETE",
        headers: {
          authorization: `Bearer ${accessToken}`,
        },
      },
    );
    if (!response.ok) {
      const message = await readControllerError(
        response,
        "delete project failed",
        requestContext,
      );
      throw new Error(message);
    }
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn("[runtime-controller] deleteControllerProject error:", message);
    return false;
  }
}

export async function deleteControllerOrganization(orgId: string): Promise<boolean> {
  if (!runtimeControllerEnabled) {
    return false;
  }
  const trimmed = orgId.trim();
  if (!trimmed) {
    return false;
  }
  const requestContext = await resolveControllerRequestContext(null);
  const accessToken = requestContext.accessToken;
  if (!accessToken) {
    return false;
  }
  try {
    const response = await fetch(
      `${requestContext.baseUrl}/orgs/${encodeURIComponent(trimmed)}`,
      {
        method: "DELETE",
        headers: {
          authorization: `Bearer ${accessToken}`,
        },
      },
    );
    if (!response.ok) {
      const message = await readControllerError(
        response,
        "delete org failed",
        requestContext,
      );
      throw new Error(message);
    }
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn("[runtime-controller] deleteControllerOrganization error:", message);
    return false;
  }
}

export async function listControllerProjectMembers(
  projectId: string,
  options: { throwOnError?: boolean } = {},
): Promise<ControllerProjectMember[]> {
  if (!runtimeControllerEnabled) {
    if (options.throwOnError) {
      throw new Error("Runtime controller is disabled.");
    }
    return [];
  }
  const normalizedProjectId = normalizeUuidParam(projectId);
  if (!normalizedProjectId) {
    if (options.throwOnError) {
      throw new Error("Project id is required.");
    }
    return [];
  }
  const requestContext = await resolveControllerRequestContext(null);
  const accessToken = requestContext.accessToken;
  if (!accessToken) {
    if (options.throwOnError) {
      throw new Error("Controller authentication is unavailable.");
    }
    return [];
  }
  try {
    const response = await fetch(
      `${requestContext.baseUrl}/projects/${encodeURIComponent(normalizedProjectId)}/members`,
      {
        headers: {
          authorization: `Bearer ${accessToken}`,
        },
      },
    );
    if (!response.ok) {
      const message = await readControllerError(
        response,
        "list project members failed",
        requestContext,
      );
      throw new Error(message);
    }
    const payload = (await response.json().catch(() => null)) as {
      members?: ControllerProjectMember[];
    } | null;
    if (payload?.members && Array.isArray(payload.members)) {
      return payload.members.filter(
        (member) => typeof member.userId === "string" && member.userId.length > 0,
      );
    }
    if (options.throwOnError) {
      throw new Error("list project members returned an invalid response");
    }
  } catch (error) {
    logControllerRequestError("[runtime-controller] listControllerProjectMembers error:", error, {
      suppressLikelyConnectionNoise: true,
    });
    if (options.throwOnError) {
      throw error;
    }
  }
  return [];
}

export async function updateControllerProjectMemberRole(params: {
  projectId: string;
  userId: string;
  role: string;
}): Promise<ControllerProjectMember | null> {
  if (!runtimeControllerEnabled) {
    return null;
  }
  const normalizedProjectId = normalizeUuidParam(params.projectId);
  const trimmedUser = params.userId.trim();
  if (!normalizedProjectId || !trimmedUser) {
    return null;
  }
  const requestContext = await resolveControllerRequestContext(null);
  const accessToken = requestContext.accessToken;
  if (!accessToken) {
    return null;
  }
  try {
    const response = await fetch(
      `${requestContext.baseUrl}/projects/${encodeURIComponent(normalizedProjectId)}/members/${encodeURIComponent(
        trimmedUser,
      )}`,
      {
        method: "PATCH",
        headers: {
          authorization: `Bearer ${accessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ role: params.role }),
      },
    );
    if (!response.ok) {
      const message = await readControllerError(
        response,
        "update project member failed",
        requestContext,
      );
      throw new Error(message);
    }
    const body = (await response.json().catch(() => null)) as {
      member?: ControllerProjectMember;
    } | null;
    const member = body?.member;
    if (member && typeof member.userId === "string") {
      return member;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn("[runtime-controller] updateControllerProjectMemberRole error:", message);
  }
  return null;
}

export async function removeControllerProjectMember(params: {
  projectId: string;
  userId: string;
}): Promise<boolean> {
  if (!runtimeControllerEnabled) {
    return false;
  }
  const normalizedProjectId = normalizeUuidParam(params.projectId);
  const trimmedUser = params.userId.trim();
  if (!normalizedProjectId || !trimmedUser) {
    return false;
  }
  const requestContext = await resolveControllerRequestContext(null);
  const accessToken = requestContext.accessToken;
  if (!accessToken) {
    return false;
  }
  try {
    const response = await fetch(
      `${requestContext.baseUrl}/projects/${encodeURIComponent(normalizedProjectId)}/members/${encodeURIComponent(
        trimmedUser,
      )}`,
      {
        method: "DELETE",
        headers: {
          authorization: `Bearer ${accessToken}`,
        },
      },
    );
    if (!response.ok) {
      const message = await readControllerError(
        response,
        "remove project member failed",
        requestContext,
      );
      throw new Error(message);
    }
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn("[runtime-controller] removeControllerProjectMember error:", message);
  }
  return false;
}

export async function listControllerOrganizations(
  options: { throwOnError?: boolean; signal?: AbortSignal } = {},
): Promise<ControllerOrgSummary[]> {
  if (!runtimeControllerEnabled) {
    if (options.throwOnError) {
      throw new Error("Runtime controller is disabled.");
    }
    return [];
  }
  const budget = createControllerReadBudget(options.signal);
  try {
    const requestContext = await budget.wait(() => resolveControllerRequestContext(null));
    const accessToken = requestContext.accessToken;
    if (!accessToken) {
      if (options.throwOnError) {
        throw new Error("Controller authentication is unavailable.");
      }
      return [];
    }
    const response = await budget.wait(() => fetch(`${requestContext.baseUrl}/orgs`, {
      signal: budget.signal,
      headers: {
        authorization: `Bearer ${accessToken}`,
      },
    }));
    if (!response.ok) {
      const message = await budget.wait(() => readControllerError(
        response,
        "list orgs failed",
        requestContext,
      ));
      throw new Error(message);
    }
    const payload = (await budget.wait(() => response.json().catch(() => null))) as {
      orgs?: ControllerOrgSummary[];
    } | null;
    if (payload?.orgs && Array.isArray(payload.orgs)) {
      return payload.orgs.filter(
        (org) => typeof org.id === "string" && org.id.length > 0,
      );
    }
    if (options.throwOnError) {
      throw new Error("list orgs returned an invalid response");
    }
  } catch (error) {
    options.signal?.throwIfAborted();
    logControllerRequestError("[runtime-controller] listControllerOrganizations error:", error, {
      suppressLikelyConnectionNoise: true,
    });
    if (options.throwOnError) {
      throw error;
    }
  } finally {
    budget.dispose();
  }
  return [];
}

/**
 * Owner/admin-only org profile update (display name and/or avatar URL).
 * Pass an empty string as avatarUrl to clear it.
 */
export async function updateControllerOrganization(
  orgId: string,
  updates: { name?: string; avatarUrl?: string; accentColor?: string | null },
): Promise<boolean> {
  if (!runtimeControllerEnabled) {
    return false;
  }
  const trimmed = orgId.trim();
  if (!trimmed) {
    return false;
  }
  const requestContext = await resolveControllerRequestContext(null);
  const accessToken = requestContext.accessToken;
  if (!accessToken) {
    return false;
  }
  const response = await fetch(`${requestContext.baseUrl}/orgs/${encodeURIComponent(trimmed)}`, {
    method: "PATCH",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(updates),
  });
  if (!response.ok) {
    const message = await readControllerError(
      response,
      "update org failed",
      requestContext,
    );
    throw new Error(message);
  }
  return true;
}

export async function listControllerOrgMembers(
  orgId: string,
  options: { throwOnError?: boolean } = {},
): Promise<ControllerOrgMember[]> {
  const page = await listControllerOrgMembersPage(orgId, {
    limit: 200,
    throwOnError: options.throwOnError,
  });
  return page.members;
}

export async function listControllerOrgMembersPage(
  orgId: string,
  options: {
    limit?: number;
    cursor?: string | null;
    query?: string | null;
    throwOnError?: boolean;
  } = {},
): Promise<ControllerOrgMembersPage> {
  if (!runtimeControllerEnabled) {
    if (options.throwOnError) {
      throw new Error("Runtime controller is disabled.");
    }
    return { members: [], nextCursor: null, hasMore: false, total: null };
  }
  const trimmed = orgId.trim();
  if (!trimmed) {
    if (options.throwOnError) {
      throw new Error("Organization id is required.");
    }
    return { members: [], nextCursor: null, hasMore: false, total: null };
  }
  const requestContext = await resolveControllerRequestContext(null);
  const accessToken = requestContext.accessToken;
  if (!accessToken) {
    if (options.throwOnError) {
      throw new Error("Controller authentication is unavailable.");
    }
    return { members: [], nextCursor: null, hasMore: false, total: null };
  }

  const searchParams = new URLSearchParams();
  const normalizedLimit =
    typeof options.limit === "number" && Number.isFinite(options.limit)
      ? Math.max(1, Math.min(200, Math.floor(options.limit)))
      : null;
  if (normalizedLimit) {
    searchParams.set("limit", String(normalizedLimit));
  }
  if (typeof options.cursor === "string" && options.cursor.trim().length > 0) {
    searchParams.set("cursor", options.cursor.trim());
  }
  if (typeof options.query === "string" && options.query.trim().length > 0) {
    searchParams.set("q", options.query.trim());
  }
  const queryString = searchParams.toString();

  try {
    const response = await fetch(
      `${requestContext.baseUrl}/orgs/${encodeURIComponent(trimmed)}/members${
        queryString ? `?${queryString}` : ""
      }`,
      {
        headers: {
          authorization: `Bearer ${accessToken}`,
        },
      },
    );
    if (!response.ok) {
      const message = await readControllerError(
        response,
        "list team members failed",
        requestContext,
      );
      throw new Error(message);
    }
    const payload = (await response.json().catch(() => null)) as {
      members?: ControllerOrgMember[];
      nextCursor?: string | null;
      hasMore?: boolean;
      total?: number | null;
    } | null;
    const members =
      payload?.members && Array.isArray(payload.members)
        ? payload.members.filter(
            (member) => typeof member.userId === "string" && member.userId.length > 0,
          )
        : [];
    if (options.throwOnError && !Array.isArray(payload?.members)) {
      throw new Error("list team members returned an invalid response");
    }
    const nextCursor =
      typeof payload?.nextCursor === "string" && payload.nextCursor.trim().length > 0
        ? payload.nextCursor.trim()
        : null;
    const hasMore = payload?.hasMore === true;
    const total = typeof payload?.total === "number" && Number.isFinite(payload.total) ? payload.total : null;
    return { members, nextCursor, hasMore, total };
  } catch (error) {
    logControllerRequestError("[runtime-controller] listControllerOrgMembersPage error:", error, {
      suppressLikelyConnectionNoise: true,
    });
    if (options.throwOnError) {
      throw error;
    }
    return { members: [], nextCursor: null, hasMore: false, total: null };
  }
}

export async function addControllerOrgMember(params: {
  orgId: string;
  email?: string;
  userId?: string;
  role?: string;
}): Promise<ControllerOrgMember | null> {
  if (!runtimeControllerEnabled) {
    return null;
  }
  const trimmedOrg = params.orgId.trim();
  if (!trimmedOrg) {
    return null;
  }
  const requestContext = await resolveControllerRequestContext(null);
  const accessToken = requestContext.accessToken;
  if (!accessToken) {
    return null;
  }
  const payload: Record<string, unknown> = {};
  if (params.email) {
    payload.email = params.email;
  }
  if (params.userId) {
    payload.userId = params.userId;
  }
  if (params.role) {
    payload.role = params.role;
  }
  try {
    const response = await fetch(
      `${requestContext.baseUrl}/orgs/${encodeURIComponent(trimmedOrg)}/members`,
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
      const message = await readControllerError(
        response,
        "add team member failed",
        requestContext,
      );
      throw new Error(message);
    }
    const body = (await response.json().catch(() => null)) as {
      member?: ControllerOrgMember;
    } | null;
    const member = body?.member;
    if (member && typeof member.userId === "string") {
      return member;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn("[runtime-controller] addControllerOrgMember error:", message);
  }
  return null;
}

export async function updateControllerOrgMemberRole(params: {
  orgId: string;
  userId: string;
  role: string;
}): Promise<ControllerOrgMember | null> {
  if (!runtimeControllerEnabled) {
    return null;
  }
  const trimmedOrg = params.orgId.trim();
  const trimmedUser = params.userId.trim();
  if (!trimmedOrg || !trimmedUser) {
    return null;
  }
  const requestContext = await resolveControllerRequestContext(null);
  const accessToken = requestContext.accessToken;
  if (!accessToken) {
    return null;
  }
  try {
    const response = await fetch(
      `${requestContext.baseUrl}/orgs/${encodeURIComponent(trimmedOrg)}/members/${encodeURIComponent(
        trimmedUser,
      )}`,
      {
        method: "PATCH",
        headers: {
          authorization: `Bearer ${accessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ role: params.role }),
      },
    );
    if (!response.ok) {
      const message = await readControllerError(
        response,
        "update team member failed",
        requestContext,
      );
      throw new Error(message);
    }
    const body = (await response.json().catch(() => null)) as {
      member?: ControllerOrgMember;
    } | null;
    const member = body?.member;
    if (member && typeof member.userId === "string") {
      return member;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(
      "[runtime-controller] updateControllerOrgMemberRole error:",
      message,
    );
  }
  return null;
}

export async function removeControllerOrgMember(params: {
  orgId: string;
  userId: string;
}): Promise<boolean> {
  if (!runtimeControllerEnabled) {
    return false;
  }
  const trimmedOrg = params.orgId.trim();
  const trimmedUser = params.userId.trim();
  if (!trimmedOrg || !trimmedUser) {
    return false;
  }
  const requestContext = await resolveControllerRequestContext(null);
  const accessToken = requestContext.accessToken;
  if (!accessToken) {
    return false;
  }
  try {
    const response = await fetch(
      `${requestContext.baseUrl}/orgs/${encodeURIComponent(trimmedOrg)}/members/${encodeURIComponent(
        trimmedUser,
      )}`,
      {
        method: "DELETE",
        headers: {
          authorization: `Bearer ${accessToken}`,
        },
      },
    );
    if (!response.ok) {
      const message = await readControllerError(
        response,
        "remove team member failed",
        requestContext,
      );
      throw new Error(message);
    }
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn("[runtime-controller] removeControllerOrgMember error:", message);
  }
  return false;
}

export async function listControllerOrgInvitations(
  orgId: string,
  projectId?: string | null,
  conversationId?: string | null,
): Promise<ControllerOrgInvitation[]> {
  if (!runtimeControllerEnabled) {
    return [];
  }
  const trimmed = orgId.trim();
  if (!trimmed) {
    return [];
  }
  const requestContext = await resolveControllerRequestContext(null);
  const accessToken = requestContext.accessToken;
  if (!accessToken) {
    return [];
  }
  try {
    const url = new URL(`${requestContext.baseUrl}/orgs/${encodeURIComponent(trimmed)}/invitations`);
    const normalizedProjectId = normalizeUuidParam(projectId ?? null);
    if (normalizedProjectId) {
      url.searchParams.set("projectId", normalizedProjectId);
    }
    const normalizedConversationId = normalizeUuidParam(conversationId ?? null);
    if (normalizedConversationId) {
      url.searchParams.set("conversationId", normalizedConversationId);
    }
    const response = await fetch(url.toString(), {
      headers: {
        authorization: `Bearer ${accessToken}`,
      },
    });
    if (!response.ok) {
      const message = await readControllerError(
        response,
        "list team invitations failed",
        requestContext,
      );
      throw new Error(message);
    }
    const payload = (await response.json().catch(() => null)) as {
      invitations?: ControllerOrgInvitation[];
    } | null;
    if (payload?.invitations && Array.isArray(payload.invitations)) {
      return payload.invitations.filter(
        (invite) => typeof invite.id === "string" && invite.id.length > 0,
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn("[runtime-controller] listControllerOrgInvitations error:", message);
  }
  return [];
}

export async function createControllerOrgInvitation(params: {
  orgId: string;
  email: string;
  role?: string;
  projectId?: string | null;
  conversationId?: string | null;
}): Promise<ControllerOrgInvitationCreation | null> {
  try {
    return await createControllerOrgInvitationStrict(params);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn("[runtime-controller] createControllerOrgInvitation error:", message);
  }
  return null;
}

export async function createControllerOrgInvitationStrict(params: {
  orgId: string;
  email: string;
  role?: string;
  projectId?: string | null;
  conversationId?: string | null;
}): Promise<ControllerOrgInvitationCreation> {
  if (!runtimeControllerEnabled) {
    throw new Error("Runtime controller is unavailable.");
  }
  const trimmedOrg = params.orgId.trim();
  const trimmedEmail = params.email.trim();
  if (!trimmedOrg || !trimmedEmail) {
    throw new Error("Team id and email are required.");
  }
  const requestContext = await resolveControllerRequestContext(null);
  const accessToken = requestContext.accessToken;
  if (!accessToken) {
    throw new Error("You need to sign in before inviting people.");
  }
  const payload: Record<string, unknown> = { email: trimmedEmail };
  if (params.role) {
    payload.role = params.role;
  }
  const normalizedProjectId = normalizeUuidParam(params.projectId ?? null);
  if (normalizedProjectId) {
    payload.projectId = normalizedProjectId;
  }
  const normalizedConversationId = normalizeUuidParam(params.conversationId ?? null);
  if (normalizedConversationId) {
    payload.conversationId = normalizedConversationId;
  }
  const abortController =
    typeof AbortController === "function" ? new AbortController() : null;
  const timeoutHandle =
    abortController !== null
      ? setTimeout(() => {
          abortController.abort();
        }, ORG_INVITATION_TIMEOUT_MS)
      : null;
  let response: Response;
  try {
    response = await fetch(
      `${requestContext.baseUrl}/orgs/${encodeURIComponent(trimmedOrg)}/invitations`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${accessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(payload),
        signal: abortController?.signal,
      },
    );
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("Invitation request timed out. Try again.");
    }
    throw error;
  } finally {
    if (timeoutHandle !== null) {
      clearTimeout(timeoutHandle);
    }
  }
  if (!response.ok) {
    // A typed error, not a flattened message: the 409
    // invitation_role_conflict carries the existing invitation's id and
    // roles in details, which the invite form uses to offer an in-place
    // role update instead of forcing cancel-and-recreate.
    throw new ControllerApiError(
      await readControllerApiError(
        response,
        "Unable to create email invite",
        requestContext,
      ),
    );
  }
  const body = (await response.json().catch(() => null)) as {
    invitation?: ControllerOrgInvitation;
    acceptUrl?: string;
  } | null;
  const invitation = body?.invitation;
  const acceptUrl = typeof body?.acceptUrl === "string" ? body.acceptUrl.trim() : "";
  if (invitation && typeof invitation.id === "string" && acceptUrl) {
    return { ...invitation, acceptUrl };
  }
  throw new Error("Invitation response was missing its secure accept link.");
}

export async function listControllerOrgInviteLinks(params: {
  orgId: string;
  projectId?: string | null;
  conversationId?: string | null;
}): Promise<ControllerOrgInviteLink[]> {
  if (!runtimeControllerEnabled) {
    return [];
  }
  const trimmedOrg = params.orgId.trim();
  if (!trimmedOrg) {
    return [];
  }
  const requestContext = await resolveControllerRequestContext(null);
  const accessToken = requestContext.accessToken;
  if (!accessToken) {
    return [];
  }
  const url = new URL(
    `${requestContext.baseUrl}/orgs/${encodeURIComponent(trimmedOrg)}/invite-links`,
  );
  const normalizedProjectId = normalizeUuidParam(params.projectId ?? null);
  if (normalizedProjectId) {
    url.searchParams.set("projectId", normalizedProjectId);
  }
  const normalizedConversationId = normalizeUuidParam(params.conversationId ?? null);
  if (normalizedConversationId) {
    url.searchParams.set("conversationId", normalizedConversationId);
  }
  try {
    const response = await fetch(url.toString(), {
      headers: {
        authorization: `Bearer ${accessToken}`,
      },
    });
    if (!response.ok) {
      const message = await readControllerError(
        response,
        "list invite links failed",
        requestContext,
      );
      throw new Error(message);
    }
    const payload = (await response.json().catch(() => null)) as {
      inviteLinks?: ControllerOrgInviteLink[];
    } | null;
    if (payload?.inviteLinks && Array.isArray(payload.inviteLinks)) {
      return payload.inviteLinks.filter(
        (invite) => typeof invite.id === "string" && invite.id.length > 0,
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn("[runtime-controller] listControllerOrgInviteLinks error:", message);
  }
  return [];
}

export async function revokeControllerOrgInviteLink(params: {
  orgId: string;
  inviteLinkId: string;
}): Promise<boolean> {
  if (!runtimeControllerEnabled) {
    return false;
  }
  const trimmedOrg = params.orgId.trim();
  const trimmedLink = params.inviteLinkId.trim();
  if (!trimmedOrg || !trimmedLink) {
    return false;
  }
  const requestContext = await resolveControllerRequestContext(null);
  const accessToken = requestContext.accessToken;
  if (!accessToken) {
    return false;
  }
  try {
    const response = await fetch(
      `${requestContext.baseUrl}/orgs/${encodeURIComponent(trimmedOrg)}/invite-links/${encodeURIComponent(
        trimmedLink,
      )}`,
      {
        method: "DELETE",
        headers: {
          authorization: `Bearer ${accessToken}`,
        },
      },
    );
    if (!response.ok) {
      const message = await readControllerError(
        response,
        "revoke invite link failed",
        requestContext,
      );
      throw new Error(message);
    }
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn("[runtime-controller] revokeControllerOrgInviteLink error:", message);
  }
  return false;
}

export async function createControllerOrgInviteLink(params: {
  orgId: string;
  role?: string;
  projectId?: string | null;
  conversationId?: string | null;
}): Promise<ControllerOrgInviteLink | null> {
  if (!runtimeControllerEnabled) {
    return null;
  }
  const trimmedOrg = params.orgId.trim();
  if (!trimmedOrg) {
    return null;
  }
  const requestContext = await resolveControllerRequestContext(null);
  const accessToken = requestContext.accessToken;
  if (!accessToken) {
    return null;
  }
  const payload: Record<string, unknown> = {};
  if (params.role) {
    payload.role = params.role;
  }
  const normalizedProjectId = normalizeUuidParam(params.projectId ?? null);
  if (normalizedProjectId) {
    payload.projectId = normalizedProjectId;
  }
  const normalizedConversationId = normalizeUuidParam(params.conversationId ?? null);
  if (normalizedConversationId) {
    payload.conversationId = normalizedConversationId;
  }
  try {
    const response = await fetch(
      `${requestContext.baseUrl}/orgs/${encodeURIComponent(trimmedOrg)}/invite-links`,
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
      const message = await readControllerError(
        response,
        "create team invite link failed",
        requestContext,
      );
      throw new Error(message);
    }
    const body = (await response.json().catch(() => null)) as {
      inviteLink?: ControllerOrgInviteLink;
    } | null;
    const inviteLink = body?.inviteLink;
    if (inviteLink && typeof inviteLink.id === "string") {
      return inviteLink;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn("[runtime-controller] createControllerOrgInviteLink error:", message);
  }
  return null;
}

export async function cancelControllerOrgInvitation(params: {
  orgId: string;
  invitationId: string;
}): Promise<boolean> {
  if (!runtimeControllerEnabled) {
    return false;
  }
  const trimmedOrg = params.orgId.trim();
  const trimmedInvitation = params.invitationId.trim();
  if (!trimmedOrg || !trimmedInvitation) {
    return false;
  }
  const requestContext = await resolveControllerRequestContext(null);
  const accessToken = requestContext.accessToken;
  if (!accessToken) {
    return false;
  }
  try {
    const response = await fetch(
      `${requestContext.baseUrl}/orgs/${encodeURIComponent(trimmedOrg)}/invitations/${encodeURIComponent(
        trimmedInvitation,
      )}`,
      {
        method: "DELETE",
        headers: {
          authorization: `Bearer ${accessToken}`,
        },
      },
    );
    if (!response.ok) {
      const message = await readControllerError(
        response,
        "cancel team invitation failed",
        requestContext,
      );
      throw new Error(message);
    }
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn("[runtime-controller] cancelControllerOrgInvitation error:", message);
  }
  return false;
}

// Throws with the server's message on failure (like the strict create):
// role-change rejections carry reasons the inviter must actually read --
// "Only organization owners can assign the owner role.", "This invitation
// has expired." -- and a swallowed null would flatten them all into one
// generic toast.
export async function updateControllerOrgInvitationRole(params: {
  orgId: string;
  invitationId: string;
  role: string;
}): Promise<ControllerOrgInvitation & { acceptUrl?: string }> {
  if (!runtimeControllerEnabled) {
    throw new Error("Runtime controller is unavailable.");
  }
  const trimmedOrg = params.orgId.trim();
  const trimmedInvitation = params.invitationId.trim();
  if (!trimmedOrg || !trimmedInvitation) {
    throw new Error("Team id and invitation id are required.");
  }
  const requestContext = await resolveControllerRequestContext(null);
  const accessToken = requestContext.accessToken;
  if (!accessToken) {
    throw new Error("You need to sign in before updating invitations.");
  }
  const response = await fetch(
    `${requestContext.baseUrl}/orgs/${encodeURIComponent(trimmedOrg)}/invitations/${encodeURIComponent(
      trimmedInvitation,
    )}`,
    {
      method: "PATCH",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ role: params.role }),
    },
  );
  if (!response.ok) {
    throw new Error(
      await readControllerError(
        response,
        "Unable to update the invitation role",
        requestContext,
      ),
    );
  }
  const body = (await response.json().catch(() => null)) as {
    invitation?: ControllerOrgInvitation;
    acceptUrl?: string;
  } | null;
  const invitation = body?.invitation;
  if (invitation && typeof invitation.id === "string") {
    // The token survives a role change by design, so the response's accept
    // URL lets a retargeted invite re-surface the SAME shareable link.
    const acceptUrl =
      typeof body?.acceptUrl === "string" && body.acceptUrl.trim()
        ? body.acceptUrl.trim()
        : undefined;
    return acceptUrl ? { ...invitation, acceptUrl } : invitation;
  }
  throw new Error("The server did not return the updated invitation.");
}

export async function acceptControllerOrgInvitation(params: {
  token: string;
}): Promise<
  | {
      orgId: string;
      orgSlug: string;
      orgName: string;
      role: string;
      projectId: string | null;
      conversationId: string | null;
    }
  | null
> {
  if (!runtimeControllerEnabled) {
    return null;
  }
  const trimmedToken = params.token.trim();
  if (!trimmedToken) {
    return null;
  }
  const requestContext = await resolveControllerRequestContext(null);
  const accessToken = requestContext.accessToken;
  if (!accessToken) {
    return null;
  }
  try {
    const response = await fetch(`${requestContext.baseUrl}/org-invitations/accept`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ token: trimmedToken }),
    });
    if (!response.ok) {
      const message = await readControllerError(
        response,
        "accept team invitation failed",
        requestContext,
      );
      throw new Error(message);
    }
    const body = (await response.json().catch(() => null)) as
      | {
          orgId?: string | null;
          orgSlug?: string | null;
          orgName?: string | null;
          role?: string | null;
          projectId?: string | null;
          conversationId?: string | null;
        }
      | null;
    const orgId =
      typeof body?.orgId === "string" && body.orgId.length > 0 ? body.orgId : null;
    const orgSlug =
      typeof body?.orgSlug === "string" && body.orgSlug.length > 0
        ? body.orgSlug
        : null;
    const orgName =
      typeof body?.orgName === "string" && body.orgName.length > 0
        ? body.orgName
        : null;
    const role = typeof body?.role === "string" && body.role.length > 0 ? body.role : null;
    const projectId =
      typeof body?.projectId === "string" && body.projectId.length > 0
        ? body.projectId
        : null;
    const conversationId =
      typeof body?.conversationId === "string" && body.conversationId.length > 0
        ? body.conversationId
        : null;
    if (!orgId || !orgSlug || !orgName || !role) {
      return null;
    }
    return { orgId, orgSlug, orgName, role, projectId, conversationId };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn("[runtime-controller] acceptControllerOrgInvitation error:", message);
    // Rethrow instead of returning null: the backend's messages are precise
    // and human ("invitation has expired", "You must be signed in with the
    // invited email address...") and the accept page renders err.message.
    // Swallowing here collapsed every failure into one generic dead end --
    // the wrong-account user got no hint email was the issue.
    throw error instanceof Error ? error : new Error(message);
  }
}

export async function previewControllerOrgInvitation(params: {
  token: string;
}): Promise<ControllerOrgInvitationPreview | null> {
  const trimmedToken = params.token.trim();
  if (!trimmedToken) {
    return null;
  }
  const requestContext = await resolveControllerRequestContext(null);
  const accessToken = requestContext.accessToken;
  if (!accessToken) {
    return null;
  }
  const response = await fetch(
    `${requestContext.baseUrl}/org-invitations/preview?token=${encodeURIComponent(trimmedToken)}`,
    { headers: { authorization: `Bearer ${accessToken}` } },
  );
  if (!response.ok) {
    // Same rationale as accept: the backend messages ("invitation has
    // expired", "invitation is no longer valid") ARE the UI copy.
    const message = await readControllerError(
      response,
      "preview team invitation failed",
      requestContext,
    );
    throw new Error(message);
  }
  const body = (await response.json().catch(() => null)) as Partial<ControllerOrgInvitationPreview> | null;
  const text = (value: unknown): string | null =>
    typeof value === "string" && value.length > 0 ? value : null;
  const orgId = text(body?.orgId);
  const orgSlug = text(body?.orgSlug);
  const orgName = text(body?.orgName);
  const role = text(body?.role);
  if (!orgId || !orgSlug || !orgName || !role) {
    return null;
  }
  return {
    kind: body?.kind === "inviteLink" ? "inviteLink" : "invitation",
    orgId,
    orgSlug,
    orgName,
    role,
    invitedEmailMasked: text(body?.invitedEmailMasked),
    inviterName: text(body?.inviterName),
    inviterEmail: text(body?.inviterEmail),
    projectId: text(body?.projectId),
    projectName: text(body?.projectName),
    conversationId: text(body?.conversationId),
    conversationName: text(body?.conversationName),
    expiresAt: text(body?.expiresAt),
  };
}
