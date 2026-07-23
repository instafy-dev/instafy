import type { APIRequestContext } from "@playwright/test";

import type { ElectronBrowserCleanupConfig } from "./electronBrowserLiveCleanup.js";

const ADMIN_USER_PAGE_SIZE = 100;
const MAX_ADMIN_USER_PAGES = 10_000;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RECOVERY_MARKER_METADATA_KEY = "electronSharedBrowserRecoveryMarker";

export type ElectronBrowserRecoveryIdentity = {
  disposableEmail: string;
  recoveryMarker: string;
};

export type ElectronBrowserRecoveryTarget = {
  orgId?: string | null;
  projectId?: string | null;
  userId?: string | null;
};

type NormalizedRecoveryTarget = Required<ElectronBrowserRecoveryTarget> &
  ElectronBrowserRecoveryIdentity;

type AdminUserSnapshot = {
  id?: unknown;
  email?: unknown;
  user_metadata?: unknown;
};

type OrganizationSnapshot = {
  id?: unknown;
  name?: unknown;
  slug?: unknown;
};

type OrganizationMembershipSnapshot = {
  invited_by?: unknown;
  role?: unknown;
  user_id?: unknown;
};

type ProjectSnapshot = {
  id?: unknown;
  name?: unknown;
  org_id?: unknown;
  owner_user_id?: unknown;
  project_type?: unknown;
};

export class ElectronBrowserRecoveryJournalError extends Error {
  constructor(detail: string) {
    super(`Electron Shared Browser recovery journal ${detail}.`);
    this.name = "ElectronBrowserRecoveryJournalError";
  }
}

export function electronBrowserRecoveryOrgName(recoveryMarker: string): string {
  if (!UUID_PATTERN.test(recoveryMarker.trim())) {
    throw new ElectronBrowserRecoveryJournalError("marker is invalid");
  }
  return `Electron Shared Browser ${recoveryMarker.trim().toLowerCase()}`;
}

export function electronBrowserRecoveryOrgSlug(recoveryMarker: string): string {
  return electronBrowserRecoveryOrgName(recoveryMarker)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function electronBrowserRecoveryProjectName(
  recoveryMarker: string,
): string {
  return `${electronBrowserRecoveryOrgName(recoveryMarker)} Project`;
}

function safeResourceId(value: unknown): string | null | undefined {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  return UUID_PATTERN.test(normalized) ? normalized : undefined;
}

function normalizeRecoveryTarget(
  identity: ElectronBrowserRecoveryIdentity,
  target: ElectronBrowserRecoveryTarget,
): NormalizedRecoveryTarget {
  const recoveryMarker = identity.recoveryMarker.trim().toLowerCase();
  const disposableEmail = identity.disposableEmail.trim().toLowerCase();
  const orgId = safeResourceId(target.orgId);
  const projectId = safeResourceId(target.projectId);
  const userId = safeResourceId(target.userId);
  if (
    !UUID_PATTERN.test(recoveryMarker) ||
    disposableEmail !== `electron-shared-browser-${recoveryMarker}@instafy.dev` ||
    orgId === undefined ||
    projectId === undefined ||
    userId === undefined
  ) {
    throw new ElectronBrowserRecoveryJournalError(
      "resource reconciliation target is invalid",
    );
  }
  return { disposableEmail, orgId, projectId, recoveryMarker, userId };
}

function adminUserRecoveryMarker(user: AdminUserSnapshot): string | null {
  if (
    !user.user_metadata ||
    typeof user.user_metadata !== "object" ||
    Array.isArray(user.user_metadata)
  ) {
    return null;
  }
  const marker = (user.user_metadata as Record<string, unknown>)[
    RECOVERY_MARKER_METADATA_KEY
  ];
  return typeof marker === "string" ? marker.trim() : null;
}

function adminUserEmail(user: AdminUserSnapshot): string | null {
  return typeof user.email === "string"
    ? user.email.trim().toLowerCase()
    : null;
}

async function findUserIdByIdentity(
  request: APIRequestContext,
  config: ElectronBrowserCleanupConfig,
  target: NormalizedRecoveryTarget,
): Promise<string | null> {
  const matches: string[] = [];
  let matchingEmailWithWrongMarker = false;
  let matchingMarkerWithWrongEmail = false;
  for (let page = 1; page <= MAX_ADMIN_USER_PAGES; page += 1) {
    let response;
    try {
      response = await request.get(
        `${config.supabaseUrl}/auth/v1/admin/users?page=${page}&per_page=${ADMIN_USER_PAGE_SIZE}`,
        {
          headers: {
            apikey: config.supabaseServiceRoleKey,
            authorization: `Bearer ${config.supabaseServiceRoleKey}`,
            accept: "application/json",
          },
          timeout: 30_000,
        },
      );
    } catch {
      throw new ElectronBrowserRecoveryJournalError(
        "user reconciliation request failed",
      );
    }
    if (!response.ok()) {
      throw new ElectronBrowserRecoveryJournalError(
        `user reconciliation returned HTTP ${response.status()}`,
      );
    }
    let users: AdminUserSnapshot[];
    try {
      const payload = (await response.json()) as { users?: unknown };
      if (
        !Array.isArray(payload.users) ||
        payload.users.some(
          (user) =>
            !user || typeof user !== "object" || Array.isArray(user),
        )
      ) {
        throw new Error("invalid payload");
      }
      users = payload.users as AdminUserSnapshot[];
    } catch {
      throw new ElectronBrowserRecoveryJournalError(
        "user reconciliation response was invalid",
      );
    }
    for (const user of users) {
      const emailMatches = adminUserEmail(user) === target.disposableEmail;
      const markerMatches =
        adminUserRecoveryMarker(user) === target.recoveryMarker;
      if (emailMatches && !markerMatches) {
        matchingEmailWithWrongMarker = true;
        continue;
      }
      if (markerMatches && !emailMatches) {
        matchingMarkerWithWrongEmail = true;
        continue;
      }
      if (!emailMatches || !markerMatches) {
        continue;
      }
      const id = safeResourceId(user.id);
      if (!id) {
        throw new ElectronBrowserRecoveryJournalError(
          "matched user id was invalid",
        );
      }
      matches.push(id);
    }
    if (users.length < ADMIN_USER_PAGE_SIZE) {
      break;
    }
    if (page === MAX_ADMIN_USER_PAGES) {
      throw new ElectronBrowserRecoveryJournalError(
        "user reconciliation exceeded its page limit",
      );
    }
  }
  if (matchingEmailWithWrongMarker || matchingMarkerWithWrongEmail) {
    throw new ElectronBrowserRecoveryJournalError(
      "disposable user identity marker was not unique",
    );
  }
  const uniqueMatches = Array.from(new Set(matches));
  if (uniqueMatches.length > 1) {
    throw new ElectronBrowserRecoveryJournalError(
      "matched more than one disposable user",
    );
  }
  return uniqueMatches[0] ?? null;
}

async function resolveUserId(
  request: APIRequestContext,
  config: ElectronBrowserCleanupConfig,
  target: NormalizedRecoveryTarget,
): Promise<string | null> {
  if (!target.userId) {
    return findUserIdByIdentity(request, config, target);
  }

  let response;
  try {
    response = await request.get(
      `${config.supabaseUrl}/auth/v1/admin/users/${encodeURIComponent(target.userId)}`,
      {
        headers: {
          apikey: config.supabaseServiceRoleKey,
          authorization: `Bearer ${config.supabaseServiceRoleKey}`,
          accept: "application/json",
        },
        timeout: 30_000,
      },
    );
  } catch {
    throw new ElectronBrowserRecoveryJournalError(
      "retained user verification request failed",
    );
  }
  if (response.ok()) {
    let user: AdminUserSnapshot;
    try {
      const payload = (await response.json()) as unknown;
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        throw new Error("invalid payload");
      }
      user = payload as AdminUserSnapshot;
    } catch {
      throw new ElectronBrowserRecoveryJournalError(
        "retained user verification response was invalid",
      );
    }
    const id = safeResourceId(user.id);
    if (
      id !== target.userId ||
      adminUserEmail(user) !== target.disposableEmail ||
      adminUserRecoveryMarker(user) !== target.recoveryMarker
    ) {
      throw new ElectronBrowserRecoveryJournalError(
        "retained user identity could not be verified",
      );
    }
    return id;
  }
  if (response.status() !== 404) {
    throw new ElectronBrowserRecoveryJournalError(
      `retained user verification returned HTTP ${response.status()}`,
    );
  }

  const recoveredId = await findUserIdByIdentity(request, config, target);
  if (recoveredId) {
    throw new ElectronBrowserRecoveryJournalError(
      "retained user id did not match the recovered disposable identity",
    );
  }
  return null;
}

async function fetchServiceRoleRows(
  request: APIRequestContext,
  config: ElectronBrowserCleanupConfig,
  url: string,
  label: string,
): Promise<Record<string, unknown>[]> {
  let response;
  try {
    response = await request.get(url, {
      headers: {
        apikey: config.supabaseServiceRoleKey,
        authorization: `Bearer ${config.supabaseServiceRoleKey}`,
        accept: "application/json",
      },
      timeout: 30_000,
    });
  } catch {
    throw new ElectronBrowserRecoveryJournalError(
      `${label} reconciliation request failed`,
    );
  }
  if (!response.ok()) {
    throw new ElectronBrowserRecoveryJournalError(
      `${label} reconciliation returned HTTP ${response.status()}`,
    );
  }
  try {
    const payload = (await response.json()) as unknown;
    if (!Array.isArray(payload)) {
      throw new Error("invalid payload");
    }
    const rows = payload.filter(
      (row): row is Record<string, unknown> =>
        Boolean(row) && typeof row === "object" && !Array.isArray(row),
    );
    if (rows.length !== payload.length) {
      throw new Error("invalid row");
    }
    return rows;
  } catch {
    throw new ElectronBrowserRecoveryJournalError(
      `${label} reconciliation response was invalid`,
    );
  }
}

function requiredSnapshotId(value: unknown, label: string): string {
  const id = safeResourceId(value);
  if (!id) {
    throw new ElectronBrowserRecoveryJournalError(
      `${label} reconciliation returned an invalid id`,
    );
  }
  return id;
}

async function resolveOrganizationId(
  request: APIRequestContext,
  config: ElectronBrowserCleanupConfig,
  target: NormalizedRecoveryTarget,
  userId: string | null,
): Promise<string | null> {
  const expectedName = electronBrowserRecoveryOrgName(target.recoveryMarker);
  const expectedSlug = electronBrowserRecoveryOrgSlug(target.recoveryMarker);
  const select = "select=id,slug,name";
  const rows = await fetchServiceRoleRows(
    request,
    config,
    `${config.supabaseUrl}/rest/v1/organizations?slug=eq.${encodeURIComponent(expectedSlug)}&${select}`,
    "organization",
  );
  if (rows.length > 1) {
    throw new ElectronBrowserRecoveryJournalError(
      "matched more than one disposable organization",
    );
  }
  const organizations = new Map<string, OrganizationSnapshot>();
  for (const row of rows) {
    const organization = row as OrganizationSnapshot;
    organizations.set(
      requiredSnapshotId(organization.id, "organization"),
      organization,
    );
  }
  if (target.orgId && !organizations.has(target.orgId)) {
    const retainedRows = await fetchServiceRoleRows(
      request,
      config,
      `${config.supabaseUrl}/rest/v1/organizations?id=eq.${encodeURIComponent(target.orgId)}&${select}`,
      "organization",
    );
    if (retainedRows.length > 1) {
      throw new ElectronBrowserRecoveryJournalError(
        "matched more than one retained organization",
      );
    }
    for (const row of retainedRows) {
      const organization = row as OrganizationSnapshot;
      organizations.set(
        requiredSnapshotId(organization.id, "organization"),
        organization,
      );
    }
  }
  if (organizations.size === 0) {
    return userId ? target.orgId : null;
  }
  if (organizations.size > 1) {
    throw new ElectronBrowserRecoveryJournalError(
      "matched more than one disposable organization",
    );
  }
  const [organizationId, organization] = Array.from(organizations.entries())[0];
  if (
    organization.name !== expectedName ||
    organization.slug !== expectedSlug ||
    (target.orgId !== null && target.orgId !== organizationId)
  ) {
    throw new ElectronBrowserRecoveryJournalError(
      "organization identity could not be verified",
    );
  }
  if (!userId) {
    throw new ElectronBrowserRecoveryJournalError(
      "organization owner could not be verified",
    );
  }
  const memberships = await fetchServiceRoleRows(
    request,
    config,
    `${config.supabaseUrl}/rest/v1/org_memberships?org_id=eq.${encodeURIComponent(organizationId)}&select=user_id,role,invited_by`,
    "organization ownership",
  );
  const membership = memberships[0] as OrganizationMembershipSnapshot | undefined;
  if (
    memberships.length !== 1 ||
    membership?.user_id !== userId ||
    membership.role !== "owner" ||
    (membership.invited_by !== null && membership.invited_by !== undefined)
  ) {
    throw new ElectronBrowserRecoveryJournalError(
      "organization ownership could not be verified",
    );
  }
  return organizationId;
}

async function resolveProjectId(
  request: APIRequestContext,
  config: ElectronBrowserCleanupConfig,
  target: NormalizedRecoveryTarget,
  userId: string | null,
  orgId: string | null,
): Promise<string | null> {
  const select = "select=id,org_id,name,owner_user_id,project_type";
  if (!orgId) {
    if (!target.projectId) {
      return null;
    }
    const rows = await fetchServiceRoleRows(
      request,
      config,
      `${config.supabaseUrl}/rest/v1/projects?id=eq.${encodeURIComponent(target.projectId)}&${select}`,
      "project",
    );
    if (rows.length > 0) {
      throw new ElectronBrowserRecoveryJournalError(
        "project organization could not be verified",
      );
    }
    return userId ? target.projectId : null;
  }
  if (!userId) {
    throw new ElectronBrowserRecoveryJournalError(
      "project owner could not be verified",
    );
  }
  const expectedName = electronBrowserRecoveryProjectName(target.recoveryMarker);
  const rows = await fetchServiceRoleRows(
    request,
    config,
    `${config.supabaseUrl}/rest/v1/projects?org_id=eq.${encodeURIComponent(orgId)}&${select}`,
    "project",
  );
  if (rows.length > 1) {
    throw new ElectronBrowserRecoveryJournalError(
      "matched more than one disposable project",
    );
  }
  const project = rows[0] as ProjectSnapshot | undefined;
  if (!project) {
    if (target.projectId) {
      const retainedRows = await fetchServiceRoleRows(
        request,
        config,
        `${config.supabaseUrl}/rest/v1/projects?id=eq.${encodeURIComponent(target.projectId)}&${select}`,
        "project",
      );
      if (retainedRows.length > 0) {
        throw new ElectronBrowserRecoveryJournalError(
          "project identity could not be verified",
        );
      }
      return userId ? target.projectId : null;
    }
    return null;
  }
  const projectId = requiredSnapshotId(project.id, "project");
  if (
    project.org_id !== orgId ||
    project.name !== expectedName ||
    project.owner_user_id !== userId ||
    project.project_type !== "customer" ||
    (target.projectId !== null && target.projectId !== projectId)
  ) {
    throw new ElectronBrowserRecoveryJournalError(
      "project identity or ownership could not be verified",
    );
  }
  return projectId;
}

export async function reconcileElectronBrowserRecoveryTarget(
  request: APIRequestContext,
  config: ElectronBrowserCleanupConfig,
  identity: ElectronBrowserRecoveryIdentity,
  target: ElectronBrowserRecoveryTarget,
): Promise<Required<ElectronBrowserRecoveryTarget>> {
  const normalized = normalizeRecoveryTarget(identity, target);
  const userId = await resolveUserId(request, config, normalized);
  const orgId = await resolveOrganizationId(
    request,
    config,
    normalized,
    userId,
  );
  const projectId = await resolveProjectId(
    request,
    config,
    normalized,
    userId,
    orgId,
  );
  return { orgId, projectId, userId };
}
