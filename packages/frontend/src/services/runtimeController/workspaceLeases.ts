import {
  readControllerError,
  resolveControllerRequestContext,
  runtimeControllerEnabled,
  safeJson,
} from "./core";

export interface AcquireWorkspaceLeaseParams {
  projectId: string;
  runtimeId?: string | null;
  leaseSeconds?: number;
  metadata?: Record<string, unknown> | null;
  accessToken?: string | null;
}

export interface RenewWorkspaceLeaseParams {
  projectId: string;
  leaseId: string;
  runtimeId?: string | null;
  leaseSeconds?: number;
  metadata?: Record<string, unknown> | null;
  accessToken?: string | null;
}

export interface ReleaseWorkspaceLeaseParams {
  projectId: string;
  leaseId: string;
  runtimeId?: string | null;
  status?: "released" | "revoked";
  accessToken?: string | null;
}

export interface WorkspaceLease {
  leaseId: string;
  projectId: string;
  userId: string | null;
  runtimeId: string | null;
  status: string;
  acquiredAt: string;
  expiresAt: string;
}

export async function acquireWorkspaceLease(
  params: AcquireWorkspaceLeaseParams,
): Promise<WorkspaceLease> {
  if (!runtimeControllerEnabled) {
    throw new Error("runtime controller disabled");
  }

  const projectId = params.projectId?.trim();
  if (!projectId) {
    throw new Error("projectId is required to acquire a project lock");
  }

  const requestContext = await resolveControllerRequestContext(
    params.accessToken ?? null,
  );
  const accessToken = requestContext.accessToken;
  if (!accessToken) {
    throw new Error("controller session token is required to acquire a project lock");
  }
  const headers: Record<string, string> = {
    "content-type": "application/json",
    authorization: `Bearer ${accessToken}`,
  };

  const body: Record<string, unknown> = {
    projectId,
  };

  const runtimeId = params.runtimeId?.trim();
  if (runtimeId) {
    body.runtimeId = runtimeId;
  }

  const leaseSeconds = normalizeLeaseSeconds(params.leaseSeconds);
  if (leaseSeconds) {
    body.leaseSeconds = leaseSeconds;
  }

  const metadata = safeJson(params.metadata ?? null);
  if (metadata) {
    body.metadata = metadata;
  }

  const response = await fetch(`${requestContext.baseUrl}/lease/acquire`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const message = await readControllerError(
      response,
      "project lock acquisition failed",
      requestContext,
    );
    throw new Error(message);
  }

  const payload = (await response.json()) as Record<string, unknown>;
  return mapLeaseResponse(payload);
}

export async function renewWorkspaceLease(
  params: RenewWorkspaceLeaseParams,
): Promise<WorkspaceLease> {
  if (!runtimeControllerEnabled) {
    throw new Error("runtime controller disabled");
  }

  const projectId = params.projectId?.trim();
  const leaseId = params.leaseId?.trim();
  if (!projectId || !leaseId) {
    throw new Error(
      "projectId and leaseId are required to renew a project lock",
    );
  }

  const requestContext = await resolveControllerRequestContext(
    params.accessToken ?? null,
  );
  const accessToken = requestContext.accessToken;
  if (!accessToken) {
    throw new Error("controller session token is required to renew a project lock");
  }
  const headers: Record<string, string> = {
    "content-type": "application/json",
    authorization: `Bearer ${accessToken}`,
  };

  const body: Record<string, unknown> = {
    projectId,
    leaseId,
  };

  const runtimeId = params.runtimeId?.trim();
  if (runtimeId) {
    body.runtimeId = runtimeId;
  }

  const leaseSeconds = normalizeLeaseSeconds(params.leaseSeconds);
  if (leaseSeconds) {
    body.leaseSeconds = leaseSeconds;
  }

  const metadata = safeJson(params.metadata ?? null);
  if (metadata) {
    body.metadata = metadata;
  }

  const response = await fetch(`${requestContext.baseUrl}/lease/renew`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const message = await readControllerError(
      response,
      "project lock renewal failed",
      requestContext,
    );
    throw new Error(message);
  }

  const payload = (await response.json()) as Record<string, unknown>;
  return mapLeaseResponse(payload);
}

export async function releaseWorkspaceLease(
  params: ReleaseWorkspaceLeaseParams,
): Promise<WorkspaceLease> {
  if (!runtimeControllerEnabled) {
    throw new Error("runtime controller disabled");
  }

  const projectId = params.projectId?.trim();
  const leaseId = params.leaseId?.trim();
  if (!projectId || !leaseId) {
    throw new Error(
      "projectId and leaseId are required to release a project lock",
    );
  }

  const requestContext = await resolveControllerRequestContext(
    params.accessToken ?? null,
  );
  const accessToken = requestContext.accessToken;
  if (!accessToken) {
    throw new Error("controller session token is required to release a project lock");
  }
  const headers: Record<string, string> = {
    "content-type": "application/json",
    authorization: `Bearer ${accessToken}`,
  };

  const body: Record<string, unknown> = {
    projectId,
    leaseId,
  };

  const runtimeId = params.runtimeId?.trim();
  if (runtimeId) {
    body.runtimeId = runtimeId;
  }

  const status = params.status ?? "released";
  body.status = status;

  const response = await fetch(`${requestContext.baseUrl}/lease/release`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const message = await readControllerError(
      response,
      "project lock release failed",
      requestContext,
    );
    throw new Error(message);
  }

  const payload = (await response.json()) as Record<string, unknown>;
  return mapLeaseResponse(payload);
}

function mapLeaseResponse(payload: Record<string, unknown>): WorkspaceLease {
  const leaseIdRaw =
    typeof payload.lease_id === "string"
      ? payload.lease_id
      : typeof payload.leaseId === "string"
        ? payload.leaseId
        : "";
  if (!leaseIdRaw) {
    throw new Error("project lock response missing leaseId");
  }

  const projectIdRaw =
    typeof payload.project_id === "string"
      ? payload.project_id
      : typeof payload.projectId === "string"
        ? payload.projectId
        : "";
  if (!projectIdRaw) {
    throw new Error("project lock response missing projectId");
  }

  const userId =
    typeof payload.user_id === "string"
      ? payload.user_id
      : typeof payload.userId === "string"
        ? payload.userId
        : null;
  const runtimeId =
    typeof payload.runtime_id === "string"
      ? payload.runtime_id
      : typeof payload.runtimeId === "string"
        ? payload.runtimeId
        : null;

  const status =
    typeof payload.status === "string" && payload.status.trim().length > 0
      ? payload.status
      : "unknown";

  const acquiredAt =
    typeof payload.acquired_at === "string"
      ? payload.acquired_at
      : typeof payload.acquiredAt === "string"
        ? payload.acquiredAt
        : new Date().toISOString();

  const expiresAt =
    typeof payload.expires_at === "string"
      ? payload.expires_at
      : typeof payload.expiresAt === "string"
        ? payload.expiresAt
        : acquiredAt;

  return {
    leaseId: leaseIdRaw,
    projectId: projectIdRaw,
    userId,
    runtimeId,
    status,
    acquiredAt,
    expiresAt,
  };
}

function normalizeLeaseSeconds(value: number | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  const clamped = Math.max(30, Math.min(600, Math.floor(value)));
  return clamped;
}
