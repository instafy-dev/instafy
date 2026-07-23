import kleur from "kleur";
import path from "node:path";
import { requestControllerApiJson } from "./api.js";
import { findProjectManifest } from "./project-manifest.js";

type SpaceInviteOptions = {
  email: string;
  role?: string;
  project?: string;
  orgId?: string;
  path?: string;
  controllerUrl?: string;
  accessToken?: string;
  serviceToken?: string;
  json?: boolean;
};

type SpaceRoleOptions = {
  email: string;
  role: string;
  project?: string;
  orgId?: string;
  path?: string;
  controllerUrl?: string;
  accessToken?: string;
  serviceToken?: string;
  json?: boolean;
};

type ProjectSummaryPayload = {
  project_id?: string;
  projectId?: string;
  org_id?: string | null;
  orgId?: string | null;
  org_name?: string | null;
  orgName?: string | null;
  project_name?: string | null;
  projectName?: string | null;
};

type OrgInvitationPayload = {
  id: string;
  orgId?: string;
  org_id?: string;
  email: string;
  role: string;
  status: string;
  createdAt?: string;
  created_at?: string;
  expiresAt?: string | null;
  expires_at?: string | null;
};

type OrgInvitationsResponse = {
  invitations?: OrgInvitationPayload[];
};

type OrgMemberPayload = {
  userId: string;
  email?: string | null;
  fullName?: string | null;
  role: string;
  invitedBy?: string | null;
  invited_by?: string | null;
  createdAt?: string;
  created_at?: string;
};

type OrgMembersResponse = {
  members?: OrgMemberPayload[];
};

type UpdateOrgMemberResponse = {
  member?: OrgMemberPayload;
};

type CreateInvitationResponse = {
  invitation?: OrgInvitationPayload;
};

function resolveStartDir(rawPath: string | undefined): string {
  return path.resolve(rawPath ?? process.cwd());
}

function trimOrNull(value: string | undefined | null): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeLowerEmail(value: string | undefined | null): string | null {
  const trimmed = trimOrNull(value);
  return trimmed ? trimmed.toLowerCase() : null;
}

function normalizeRole(value: string | undefined | null, fallback?: string): string {
  const normalized = trimOrNull(value)?.toLowerCase() ?? fallback ?? "";
  if (!["viewer", "builder", "admin", "owner"].includes(normalized)) {
    throw new Error("Role must be one of viewer, builder, admin, owner.");
  }
  return normalized;
}

function findExactEmailMember(
  members: OrgMemberPayload[],
  email: string,
): OrgMemberPayload | null {
  const normalizedTarget = normalizeLowerEmail(email);
  if (!normalizedTarget) {
    return null;
  }
  return (
    members.find(
      (member) => normalizeLowerEmail(member.email) === normalizedTarget,
    ) ?? null
  );
}

function findExactEmailInvitation(
  invitations: OrgInvitationPayload[],
  email: string,
): OrgInvitationPayload | null {
  const normalizedTarget = normalizeLowerEmail(email);
  if (!normalizedTarget) {
    return null;
  }
  return (
    invitations.find(
      (invitation) => normalizeLowerEmail(invitation.email) === normalizedTarget,
    ) ?? null
  );
}

async function listOrgMembers(
  options: Pick<
    SpaceInviteOptions,
    "orgId" | "controllerUrl" | "accessToken" | "serviceToken"
  >,
  query?: string,
): Promise<OrgMemberPayload[]> {
  const queryParts = ["limit=50"];
  const trimmedQuery = trimOrNull(query);
  if (trimmedQuery) {
    queryParts.push(`q=${trimmedQuery}`);
  }
  const response = await requestControllerApiJson<OrgMembersResponse>({
    method: "GET",
    path: `/orgs/${encodeURIComponent(options.orgId ?? "")}/members`,
    controllerUrl: options.controllerUrl,
    accessToken: options.accessToken,
    serviceToken: options.serviceToken,
    query: queryParts,
  });
  return Array.isArray(response.members) ? response.members : [];
}

async function listOrgInvitations(
  options: Pick<
    SpaceInviteOptions,
    "orgId" | "controllerUrl" | "accessToken" | "serviceToken"
  >,
): Promise<OrgInvitationPayload[]> {
  const response = await requestControllerApiJson<OrgInvitationsResponse>({
    method: "GET",
    path: `/orgs/${encodeURIComponent(options.orgId ?? "")}/invitations`,
    controllerUrl: options.controllerUrl,
    accessToken: options.accessToken,
    serviceToken: options.serviceToken,
  });
  return Array.isArray(response.invitations) ? response.invitations : [];
}

async function updateOrgMemberRole(options: {
  orgId: string;
  userId: string;
  role: string;
  controllerUrl?: string;
  accessToken?: string;
  serviceToken?: string;
}): Promise<OrgMemberPayload> {
  const response = await requestControllerApiJson<UpdateOrgMemberResponse>({
    method: "PATCH",
    path: `/orgs/${encodeURIComponent(options.orgId)}/members/${encodeURIComponent(options.userId)}`,
    controllerUrl: options.controllerUrl,
    accessToken: options.accessToken,
    serviceToken: options.serviceToken,
    jsonBody: {
      role: options.role,
    },
  });
  if (!response.member?.userId) {
    throw new Error("Role update response missing member details.");
  }
  return response.member;
}

async function resolveOrgContext(options: SpaceInviteOptions): Promise<{
  orgId: string;
  orgName: string | null;
  projectId: string | null;
}> {
  const explicitOrgId = trimOrNull(options.orgId);
  if (explicitOrgId) {
    return {
      orgId: explicitOrgId,
      orgName: null,
      projectId: trimOrNull(options.project),
    };
  }

  const startDir = resolveStartDir(options.path);
  const { manifest } = findProjectManifest(startDir);
  const manifestOrgId = trimOrNull(manifest?.orgId);
  const projectId = trimOrNull(options.project) ?? trimOrNull(manifest?.spaceId);

  if (manifestOrgId) {
    return {
      orgId: manifestOrgId,
      orgName: trimOrNull(manifest?.orgName),
      projectId,
    };
  }

  if (!projectId) {
    throw new Error(
      "No linked space found. Run `instafy space init`, or pass --space <id> or --team-id <uuid>.",
    );
  }

  const project = await requestControllerApiJson<ProjectSummaryPayload>({
    method: "GET",
    path: `/projects/${encodeURIComponent(projectId)}`,
    controllerUrl: options.controllerUrl,
    accessToken: options.accessToken,
    serviceToken: options.serviceToken,
  });
  const resolvedOrgId = trimOrNull(project.org_id) ?? trimOrNull(project.orgId);
  if (!resolvedOrgId) {
    throw new Error(
      `Space ${projectId} is not linked to a team. Pass --team-id <uuid> explicitly.`,
    );
  }

  return {
    orgId: resolvedOrgId,
    orgName: trimOrNull(project.org_name) ?? trimOrNull(project.orgName),
    projectId,
  };
}

export async function inviteSpaceMember(options: SpaceInviteOptions) {
  const email = trimOrNull(options.email);
  if (!email) {
    throw new Error("Email is required.");
  }

  const { orgId, orgName, projectId } = await resolveOrgContext(options);
  const normalized = await sendSpaceInvitation({
    email,
    role: trimOrNull(options.role) ? normalizeRole(options.role) : null,
    orgId,
    orgName,
    projectId,
    controllerUrl: options.controllerUrl,
    accessToken: options.accessToken,
    serviceToken: options.serviceToken,
  });

  if (options.json) {
    console.log(JSON.stringify({ invitation: normalized }, null, 2));
    return normalized;
  }

  const scopeLabel = orgName ? `${orgName}` : "this space";
  console.log(kleur.green(`Invitation sent to ${normalized.email}`));
  console.log(`Scope: ${scopeLabel}`);
  console.log(`Role: ${normalized.role}`);
  if (normalized.expiresAt) {
    console.log(`Expires: ${normalized.expiresAt}`);
  }
  return normalized;
}

export async function setSpaceMemberRole(options: SpaceRoleOptions) {
  const email = trimOrNull(options.email);
  if (!email) {
    throw new Error("Email is required.");
  }
  const role = normalizeRole(options.role);
  const { orgId, orgName, projectId } = await resolveOrgContext(options);
  const [members, invitations] = await Promise.all([
    listOrgMembers(
      {
        orgId,
        controllerUrl: options.controllerUrl,
        accessToken: options.accessToken,
        serviceToken: options.serviceToken,
      },
      email,
    ),
    listOrgInvitations({
      orgId,
      controllerUrl: options.controllerUrl,
      accessToken: options.accessToken,
      serviceToken: options.serviceToken,
    }),
  ]);

  const existingMember = findExactEmailMember(members, email);
  if (existingMember) {
    const currentRole = normalizeRole(existingMember.role, "viewer");
    const normalized = {
      targetType: "member" as const,
      status: currentRole === role ? "unchanged" as const : "updated" as const,
      orgId,
      orgName,
      projectId,
      email: trimOrNull(existingMember.email) ?? email,
      userId: existingMember.userId,
      role,
    };
    if (currentRole !== role) {
      await updateOrgMemberRole({
        orgId,
        userId: existingMember.userId,
        role,
        controllerUrl: options.controllerUrl,
        accessToken: options.accessToken,
        serviceToken: options.serviceToken,
      });
    }
    if (options.json) {
      console.log(JSON.stringify({ access: normalized }, null, 2));
      return normalized;
    }
    console.log(
      kleur.green(
        normalized.status === "updated"
          ? `Updated ${normalized.email} to ${normalized.role}`
          : `${normalized.email} already has role ${normalized.role}`,
      ),
    );
    console.log(`Scope: ${orgName ? orgName : "this space"}`);
    console.log("Target: member");
    console.log(`Role: ${normalized.role}`);
    return normalized;
  }

  const existingInvitation = findExactEmailInvitation(invitations, email);
  if (existingInvitation) {
    const currentRole = normalizeRole(existingInvitation.role, "viewer");
    const normalized = {
      targetType: "pending_invitation" as const,
      status: currentRole === role ? "unchanged" as const : "updated" as const,
      orgId,
      orgName,
      projectId,
      email: existingInvitation.email,
      invitationId: existingInvitation.id,
      role,
    };
    if (currentRole !== role) {
      await sendSpaceInvitation({
        email,
        role,
        orgId,
        orgName,
        projectId,
        controllerUrl: options.controllerUrl,
        accessToken: options.accessToken,
        serviceToken: options.serviceToken,
      });
    }
    if (options.json) {
      console.log(JSON.stringify({ access: normalized }, null, 2));
      return normalized;
    }
    console.log(
      kleur.green(
        normalized.status === "updated"
          ? `Updated pending invite for ${normalized.email} to ${normalized.role}`
          : `Pending invite for ${normalized.email} already has role ${normalized.role}`,
      ),
    );
    console.log(`Scope: ${orgName ? orgName : "this space"}`);
    console.log("Target: pending invitation");
    console.log(`Role: ${normalized.role}`);
    return normalized;
  }

  throw new Error(
    `No existing member or pending invite found for ${email}. Invite them first with \`instafy space invite ${email} --role ${role}\`.`,
  );
}

async function sendSpaceInvitation(options: {
  email: string;
  role: string | null;
  orgId: string;
  orgName: string | null;
  projectId: string | null;
  controllerUrl?: string;
  accessToken?: string;
  serviceToken?: string;
}) {
  const payload: Record<string, unknown> = { email: options.email };
  if (options.role) {
    payload.role = options.role;
  }
  if (options.projectId) {
    payload.projectId = options.projectId;
  }

  const response = await requestControllerApiJson<CreateInvitationResponse>({
    method: "POST",
    path: `/orgs/${encodeURIComponent(options.orgId)}/invitations`,
    controllerUrl: options.controllerUrl,
    accessToken: options.accessToken,
    serviceToken: options.serviceToken,
    jsonBody: payload,
  });

  const invitation = response.invitation;
  if (!invitation?.id) {
    throw new Error("Invitation response missing invitation details.");
  }

  return {
    id: invitation.id,
    orgId: trimOrNull(invitation.orgId) ?? trimOrNull(invitation.org_id) ?? options.orgId,
    orgName: options.orgName,
    projectId: options.projectId,
    email: invitation.email,
    role: invitation.role,
    status: invitation.status,
    createdAt: trimOrNull(invitation.createdAt) ?? trimOrNull(invitation.created_at),
    expiresAt: trimOrNull(invitation.expiresAt) ?? trimOrNull(invitation.expires_at),
  };
}
