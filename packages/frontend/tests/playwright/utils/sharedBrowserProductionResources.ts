import type { APIRequestContext, APIResponse } from "@playwright/test";

import type {
  ElectronBrowserProvisioningIdentity,
  ElectronBrowserProvisioningRegistration,
  ElectronBrowserStudioConfig,
  ProvisionedElectronBrowserStudio,
} from "./electronBrowserLiveHarness.js";
import type { AuthSessionSnapshot } from "./harness.js";

const REQUEST_TIMEOUT_MS = 30_000;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

type ActorBase = {
  identity: ElectronBrowserProvisioningIdentity;
  recoveryJournalPath: string;
  registration: ElectronBrowserProvisioningRegistration;
  session: AuthSessionSnapshot;
  userId: string;
};

export type SharedBrowserProductionOwnerActor = ActorBase & {
  kind: "owner";
  orgId: string;
  projectId: string;
  provisioned: ProvisionedElectronBrowserStudio;
};

export type SharedBrowserProductionCollaboratorActor = ActorBase & {
  kind: "collaborator";
  orgId: null;
  projectId: null;
};

export type SharedBrowserProductionActor =
  | SharedBrowserProductionOwnerActor
  | SharedBrowserProductionCollaboratorActor;

export type SharedBrowserProductionInviteLinkInput = {
  owner: SharedBrowserProductionOwnerActor;
  inviteLinkId?: string;
  inviteUrl?: string;
  orgId?: string;
  projectId?: string | null;
  conversationId?: string | null;
};

export type SharedBrowserProductionTrackedInviteLink = {
  inviteLinkId: string;
  orgId: string;
  projectId: string | null;
  conversationId: string | null;
};

export type SharedBrowserTrackedInviteState =
  SharedBrowserProductionTrackedInviteLink & {
    owner: SharedBrowserProductionOwnerActor;
  };

export type SharedBrowserProjectSafetyBaseline = {
  projectId: string;
  agentJobIds: readonly string[];
  runIds: readonly string[];
  managedAiPromptLedgerIds: readonly string[];
};

export class SharedBrowserProductionLifecycleError extends Error {
  constructor(detail: string) {
    super(`Shared Browser production lifecycle ${detail}.`);
    this.name = "SharedBrowserProductionLifecycleError";
  }
}

export function normalizedSharedBrowserUuid(value: unknown, label: string): string {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!UUID_PATTERN.test(normalized)) {
    throw new SharedBrowserProductionLifecycleError(`${label} is invalid`);
  }
  return normalized;
}

function serviceHeaders(config: ElectronBrowserStudioConfig) {
  return {
    apikey: config.supabaseServiceRoleKey,
    authorization: `Bearer ${config.supabaseServiceRoleKey}`,
    accept: "application/json",
  };
}

async function checkedResponse(
  label: string,
  requestCall: () => Promise<APIResponse>,
): Promise<APIResponse> {
  let response: APIResponse;
  try {
    response = await requestCall();
  } catch (error) {
    throw new SharedBrowserProductionLifecycleError(
      `${label} failed (${error instanceof Error ? error.name : "unknown error"})`,
    );
  }
  if (!response.ok()) {
    throw new SharedBrowserProductionLifecycleError(
      `${label} returned HTTP ${response.status()}`,
    );
  }
  return response;
}

async function checkedJson(
  label: string,
  requestCall: () => Promise<APIResponse>,
): Promise<unknown> {
  const response = await checkedResponse(label, requestCall);
  try {
    return await response.json();
  } catch {
    throw new SharedBrowserProductionLifecycleError(`${label} returned invalid JSON`);
  }
}

async function fetchProjectIds(
  request: APIRequestContext,
  config: ElectronBrowserStudioConfig,
  table: "agent_jobs" | "runs" | "org_credit_ledger",
  projectId: string,
  reason?: string,
): Promise<string[]> {
  const url = new URL(`/rest/v1/${table}`, config.supabaseUrl);
  url.searchParams.set(
    "project_id",
    `eq.${normalizedSharedBrowserUuid(projectId, "project id")}`,
  );
  if (reason) url.searchParams.set("reason", `eq.${reason}`);
  url.searchParams.set("select", "id");
  url.searchParams.set("order", "id.asc");
  const payload = await checkedJson(`${table} safety query`, () =>
    request.get(url.toString(), {
      headers: serviceHeaders(config),
      timeout: REQUEST_TIMEOUT_MS,
    }),
  );
  if (!Array.isArray(payload)) {
    throw new SharedBrowserProductionLifecycleError(
      `${table} safety query did not return an array`,
    );
  }
  return payload
    .map((row) =>
      normalizedSharedBrowserUuid(
        row && typeof row === "object" && !Array.isArray(row)
          ? (row as Record<string, unknown>).id
          : null,
        `${table} row id`,
      ),
    )
    .sort();
}

export async function captureSharedBrowserProjectSafetyBaseline(
  request: APIRequestContext,
  config: ElectronBrowserStudioConfig,
  projectId: string,
): Promise<SharedBrowserProjectSafetyBaseline> {
  const normalizedProjectId = normalizedSharedBrowserUuid(projectId, "project id");
  const [agentJobIds, runIds, managedAiPromptLedgerIds] = await Promise.all([
    fetchProjectIds(request, config, "agent_jobs", normalizedProjectId),
    fetchProjectIds(request, config, "runs", normalizedProjectId),
    fetchProjectIds(
      request,
      config,
      "org_credit_ledger",
      normalizedProjectId,
      "managed_ai_prompt",
    ),
  ]);
  if (agentJobIds.length > 0 || runIds.length > 0) {
    throw new SharedBrowserProductionLifecycleError(
      "fresh project already contains agent jobs or runs",
    );
  }
  return { projectId: normalizedProjectId, agentJobIds, runIds, managedAiPromptLedgerIds };
}

function equalIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export async function assertSharedBrowserProjectSafetyUnchanged(
  request: APIRequestContext,
  config: ElectronBrowserStudioConfig,
  baseline: SharedBrowserProjectSafetyBaseline,
): Promise<void> {
  const [agentJobIds, runIds, managedAiPromptLedgerIds] = await Promise.all([
    fetchProjectIds(request, config, "agent_jobs", baseline.projectId),
    fetchProjectIds(request, config, "runs", baseline.projectId),
    fetchProjectIds(
      request,
      config,
      "org_credit_ledger",
      baseline.projectId,
      "managed_ai_prompt",
    ),
  ]);
  if (!equalIds(agentJobIds, baseline.agentJobIds)) {
    throw new SharedBrowserProductionLifecycleError(
      "created an agent job during a no-AI collaboration canary",
    );
  }
  if (!equalIds(runIds, baseline.runIds)) {
    throw new SharedBrowserProductionLifecycleError(
      "created an agent run during a no-AI collaboration canary",
    );
  }
  if (!equalIds(managedAiPromptLedgerIds, baseline.managedAiPromptLedgerIds)) {
    throw new SharedBrowserProductionLifecycleError(
      "changed the managed_ai_prompt credit ledger during a no-AI collaboration canary",
    );
  }
}

export async function provisionSharedBrowserCollaborator(
  request: APIRequestContext,
  config: ElectronBrowserStudioConfig,
  identity: ElectronBrowserProvisioningIdentity,
  registration: ElectronBrowserProvisioningRegistration,
  recoveryJournalPath: string,
  checkpoint: () => void,
): Promise<SharedBrowserProductionCollaboratorActor> {
  const createPayload = await checkedJson("collaborator user creation", () =>
    request.post(`${config.supabaseUrl}/auth/v1/admin/users`, {
      headers: { ...serviceHeaders(config), "content-type": "application/json" },
      timeout: REQUEST_TIMEOUT_MS,
      data: {
        email: identity.disposableEmail,
        password: identity.password,
        email_confirm: true,
        user_metadata: {
          e2e: "shared-browser-production-collaboration",
          electronSharedBrowserRecoveryMarker: identity.recoveryMarker,
        },
      },
    }),
  );
  const userId = normalizedSharedBrowserUuid(
    createPayload && typeof createPayload === "object" && !Array.isArray(createPayload)
      ? (createPayload as Record<string, unknown>).id
      : null,
    "collaborator user id",
  );
  registration.userId = userId;
  checkpoint();

  const tokenPayload = await checkedJson("collaborator login", () =>
    request.post(`${config.supabaseUrl}/auth/v1/token?grant_type=password`, {
      headers: { apikey: config.supabaseAnonKey, "content-type": "application/json" },
      timeout: REQUEST_TIMEOUT_MS,
      data: { email: identity.disposableEmail, password: identity.password },
    }),
  );
  const token =
    tokenPayload && typeof tokenPayload === "object" && !Array.isArray(tokenPayload)
      ? (tokenPayload as Record<string, unknown>)
      : null;
  const accessToken = typeof token?.access_token === "string" ? token.access_token.trim() : "";
  const refreshToken = typeof token?.refresh_token === "string" ? token.refresh_token.trim() : "";
  if (!accessToken || !refreshToken) {
    throw new SharedBrowserProductionLifecycleError(
      "collaborator login returned an incomplete session",
    );
  }
  const session = { accessToken, refreshToken, userId };
  registration.session = session;
  return {
    kind: "collaborator",
    identity,
    recoveryJournalPath,
    registration,
    session,
    userId,
    orgId: null,
    projectId: null,
  };
}

export async function discoverSharedBrowserInviteLink(
  request: APIRequestContext,
  config: ElectronBrowserStudioConfig,
  input: SharedBrowserProductionInviteLinkInput,
): Promise<SharedBrowserTrackedInviteState> {
  const orgId = normalizedSharedBrowserUuid(input.orgId ?? input.owner.orgId, "invite org id");
  const projectId = input.projectId === undefined
    ? input.owner.projectId
    : input.projectId === null
      ? null
      : normalizedSharedBrowserUuid(input.projectId, "invite project id");
  const conversationId = input.conversationId == null
    ? null
    : normalizedSharedBrowserUuid(input.conversationId, "invite conversation id");
  const requestedId = input.inviteLinkId
    ? normalizedSharedBrowserUuid(input.inviteLinkId, "invite link id")
    : null;
  let requestedToken: string | null = null;
  if (input.inviteUrl) {
    try {
      requestedToken = normalizedSharedBrowserUuid(
        new URL(input.inviteUrl, config.appBaseUrl).searchParams.get("token"),
        "invite token",
      );
    } catch (error) {
      if (error instanceof SharedBrowserProductionLifecycleError) throw error;
      throw new SharedBrowserProductionLifecycleError("invite URL is invalid");
    }
  }
  if (!requestedId && !requestedToken) {
    throw new SharedBrowserProductionLifecycleError("invite tracking requires an id or URL");
  }

  const url = new URL(`/orgs/${encodeURIComponent(orgId)}/invite-links`, config.controllerUrl);
  if (projectId) url.searchParams.set("projectId", projectId);
  if (conversationId) url.searchParams.set("conversationId", conversationId);
  const payload = await checkedJson("invite discovery", () =>
    request.get(url.toString(), {
      headers: { authorization: `Bearer ${input.owner.session.accessToken}` },
      timeout: REQUEST_TIMEOUT_MS,
    }),
  );
  const links = payload && typeof payload === "object" && !Array.isArray(payload)
    ? (payload as Record<string, unknown>).inviteLinks
    : null;
  if (!Array.isArray(links)) {
    throw new SharedBrowserProductionLifecycleError("invite discovery returned no links");
  }
  const matches = links.filter((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const link = value as Record<string, unknown>;
    return (!requestedId || link.id === requestedId) && (!requestedToken || link.token === requestedToken);
  });
  if (matches.length !== 1) {
    throw new SharedBrowserProductionLifecycleError(
      "invite discovery did not find exactly one active link",
    );
  }
  return {
    owner: input.owner,
    inviteLinkId: normalizedSharedBrowserUuid(
      (matches[0] as Record<string, unknown>).id,
      "discovered invite link id",
    ),
    orgId,
    projectId,
    conversationId,
  };
}

export async function revokeAndVerifySharedBrowserInviteLink(
  request: APIRequestContext,
  config: ElectronBrowserStudioConfig,
  invite: SharedBrowserTrackedInviteState,
): Promise<void> {
  await checkedResponse("invite revocation", () =>
    request.delete(
      `${config.controllerUrl}/orgs/${encodeURIComponent(invite.orgId)}/invite-links/${encodeURIComponent(invite.inviteLinkId)}`,
      {
        headers: { authorization: `Bearer ${invite.owner.session.accessToken}` },
        timeout: REQUEST_TIMEOUT_MS,
      },
    ),
  );
  const url = new URL("/rest/v1/org_invite_links", config.supabaseUrl);
  url.searchParams.set("id", `eq.${invite.inviteLinkId}`);
  url.searchParams.set("org_id", `eq.${invite.orgId}`);
  url.searchParams.set("select", "id,status,revoked_at");
  const rows = await checkedJson("invite verification", () =>
    request.get(url.toString(), {
      headers: serviceHeaders(config),
      timeout: REQUEST_TIMEOUT_MS,
    }),
  );
  if (!Array.isArray(rows) || rows.length !== 1) {
    throw new SharedBrowserProductionLifecycleError(
      "invite verification did not find exactly one audit row",
    );
  }
  const row = rows[0];
  if (!row || typeof row !== "object" || Array.isArray(row)) {
    throw new SharedBrowserProductionLifecycleError("invite verification returned an invalid row");
  }
  const record = row as Record<string, unknown>;
  if (
    normalizedSharedBrowserUuid(record.id, "revoked invite id") !== invite.inviteLinkId ||
    record.status !== "revoked" ||
    typeof record.revoked_at !== "string" ||
    !Number.isFinite(Date.parse(record.revoked_at))
  ) {
    throw new SharedBrowserProductionLifecycleError(
      "invite revocation was not durably recorded",
    );
  }
}
