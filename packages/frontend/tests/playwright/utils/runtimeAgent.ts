import fs from "node:fs/promises";
import path from "node:path";

export type RuntimeLeaseScope = "exclusive" | "shared" | "tenant";

export interface RuntimeAgentHandle {
  runtimeId: string;
  leaseId: string;
  scope: RuntimeLeaseScope;
  parentLeaseId: string | null;
  controllerUrl: string;
  serviceRoleKey: string;
  workspaceRoot: string | null;
  stop: (options?: { reason?: string }) => Promise<void>;
}

interface StartRuntimeAgentOptions {
  controllerUrl: string;
  serviceRoleKey: string;
  projectId: string;
  provider?: string;
  displayName?: string;
  scope?: RuntimeLeaseScope;
  leaseSeconds?: number;
  runtimeId?: string;
  metadata?: Record<string, unknown> | null;
  env?: Record<string, string> | null;
  tenantProjects?: string[];
  workspaceRoot?: string | null;
}

const DEFAULT_WORKSPACE_ROOT = path.join(
  process.cwd(),
  "tmp",
  "runtime-sandbox",
);

export async function startRuntimeAgent(
  options: StartRuntimeAgentOptions,
): Promise<RuntimeAgentHandle> {
  const controllerUrl = normalizeUrl(options.controllerUrl);
  const serviceRoleKey = options.serviceRoleKey.trim();
  if (!serviceRoleKey) {
    throw new Error("serviceRoleKey is required to start runtime agent");
  }

  const scope: RuntimeLeaseScope = options.scope ?? "exclusive";
  const leaseSeconds = clampLeaseSeconds(options.leaseSeconds);
  const displayName = options.displayName?.trim();

  const workspaceRoot = options.workspaceRoot ?? DEFAULT_WORKSPACE_ROOT;
  if (workspaceRoot) {
    await fs.mkdir(workspaceRoot, { recursive: true }).catch(() => {});
  }

  const tenantProjects =
    options.tenantProjects && options.tenantProjects.length > 0
      ? Array.from(new Set(options.tenantProjects))
      : scope === "tenant" || scope === "shared"
        ? [options.projectId]
        : [];

  const metadata: Record<string, unknown> = {
    harness: "playwright-runtime-agent",
    requestedAt: new Date().toISOString(),
    scope,
    provider: options.provider ?? "self-hosted",
    ...(options.metadata ?? {}),
  };

  if (displayName) {
    metadata.displayName = displayName;
  }
  if (workspaceRoot) {
    metadata.workspaceRoot = workspaceRoot;
  }
  if (tenantProjects.length > 0) {
    metadata.tenants = tenantProjects;
  }
  if (options.env && Object.keys(options.env).length > 0) {
    metadata.env = options.env;
  }

  const payload: Record<string, unknown> = {
    project_id: options.projectId,
    provider: options.provider ?? "self-hosted",
    idle_ttl_seconds: leaseSeconds,
    metadata,
    scope,
  };
  if (displayName) {
    payload.display_name = displayName;
  }
  if (options.runtimeId) {
    payload.runtime_id = options.runtimeId;
  }

  const response = await fetch(`${controllerUrl}/runtime/ensure`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${serviceRoleKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `controller runtime ensure failed (${response.status} ${response.statusText}): ${text}`,
    );
  }

  const body = (await response.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  if (!body) {
    throw new Error("controller runtime ensure returned empty response");
  }

  const runtimeId = extractString(body, ["runtime_id", "runtimeId"]);
  const leaseId = extractString(body, ["lease_id", "leaseId"]);
  if (!runtimeId || !leaseId) {
    throw new Error(
      "controller runtime ensure response missing runtime/lease identifiers",
    );
  }

  const parentLeaseId = extractString(body, [
    "parent_lease_id",
    "parentLeaseId",
  ]);
  const responseScopeRaw = extractString(body, ["scope"]);
  const effectiveScope = normalizeScope(responseScopeRaw) ?? scope;

  const registerPayload: Record<string, unknown> = {
    project_id: options.projectId,
    idleTtlSeconds: leaseSeconds,
    leaseId,
    metadata,
  };
  if (displayName) {
    registerPayload.displayName = displayName;
  }
  if (effectiveScope) {
    registerPayload.leaseScope = effectiveScope;
  }

  const registerResponse = await fetch(`${controllerUrl}/runtime/register`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${serviceRoleKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(registerPayload),
  });

  if (!registerResponse.ok) {
    const text = await registerResponse.text().catch(() => "");
    throw new Error(
      `controller runtime register failed (${registerResponse.status} ${registerResponse.statusText}): ${text}`,
    );
  }

  const activityPayload: Record<string, unknown> = {
    status: "ready",
    idleTtlSeconds: leaseSeconds,
  };
  const activityResponse = await fetch(
    `${controllerUrl}/projects/${encodeURIComponent(options.projectId)}/runtime/activity`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${serviceRoleKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(activityPayload),
    },
  );
  if (!activityResponse.ok) {
    const text = await activityResponse.text().catch(() => "");
    throw new Error(
      `controller runtime activity failed (${activityResponse.status} ${activityResponse.statusText}): ${text}`,
    );
  }

  const handle: RuntimeAgentHandle = {
    runtimeId,
    leaseId,
    scope: effectiveScope,
    parentLeaseId: parentLeaseId ?? null,
    controllerUrl,
    serviceRoleKey,
    workspaceRoot,
    stop: async ({ reason }: { reason?: string } = {}) => {
      await stopRuntime({
        controllerUrl,
        serviceRoleKey,
        runtimeId,
        reason: reason ?? "playwright-runtime-cleanup",
      });
    },
  };

  return handle;
}

function normalizeUrl(url: string): string {
  const trimmed = url.trim();
  if (!trimmed) {
    return "http://127.0.0.1:8788";
  }
  return trimmed.replace(/\/+$/, "");
}

function clampLeaseSeconds(value: number | undefined): number {
  if (!value || !Number.isFinite(value)) {
    return 180;
  }
  return Math.max(60, Math.min(600, Math.floor(value)));
}

function extractString(
  source: Record<string, unknown>,
  keys: string[],
): string | null {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed.length > 0) {
        return trimmed;
      }
    }
  }
  return null;
}

function normalizeScope(raw: string | null): RuntimeLeaseScope | null {
  if (!raw) {
    return null;
  }
  switch (raw.toLowerCase()) {
    case "exclusive":
      return "exclusive";
    case "shared":
      return "shared";
    case "tenant":
      return "tenant";
    default:
      return null;
  }
}

async function stopRuntime(args: {
  controllerUrl: string;
  serviceRoleKey: string;
  runtimeId: string;
  reason: string;
}): Promise<void> {
  const response = await fetch(`${args.controllerUrl}/runtime/stop`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${args.serviceRoleKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ runtime_id: args.runtimeId, reason: args.reason }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    if (response.status !== 401) {
      console.warn(
        `[runtime-agent] runtime stop failed (${response.status} ${response.statusText}): ${text}`,
      );
    }
  }
}
