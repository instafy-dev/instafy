import { useCallback, useMemo } from "react";
import type {
  ControllerOrgInvitation,
  ControllerOrgInviteLink,
} from "../sdk/instafy";
import type { PreparedEmailInvite } from "../sharing/preparedEmailInvite";
import { resolvePublicAppUrl } from "../utils/publicAppUrl";
import { useOrgInviteLinks } from "./useOrgInviteLinks";
import { useOrgInvitations } from "./useOrgInvitations";

export const PROJECT_INVITE_ROLES = ["viewer", "builder"] as const;
export type ProjectInviteRole = (typeof PROJECT_INVITE_ROLES)[number];

export const ORGANIZATION_INVITE_ROLES = [
  ...PROJECT_INVITE_ROLES,
  "admin",
  "owner",
] as const;
export type OrganizationInviteRole = (typeof ORGANIZATION_INVITE_ROLES)[number];

export type OrganizationInviteScope = {
  kind: "organization";
  orgId: string;
};

export type ProjectInviteScope = {
  kind: "project";
  orgId: string;
  projectId: string;
};

export type ConversationInviteScope = {
  kind: "conversation";
  orgId: string;
  projectId: string;
  conversationId: string;
};

export type InviteScope =
  | OrganizationInviteScope
  | ProjectInviteScope
  | ConversationInviteScope;

export type AccessInviteScope = ProjectInviteScope | ConversationInviteScope;

export type InviteRoleForScope<Scope extends InviteScope> =
  Scope extends OrganizationInviteScope ? OrganizationInviteRole : ProjectInviteRole;

type InviteActionFailure = {
  success: false;
  error: string;
};

export type PrepareEmailInviteResult =
  | {
      success: true;
      invitation: ControllerOrgInvitation;
      preparedInvite: PreparedEmailInvite;
    }
  | InviteActionFailure;

export type InviteMutationResult = { success: true } | InviteActionFailure;

export type PrepareInviteLinkResult =
  | {
      success: true;
      link: ControllerOrgInviteLink;
      rotated: boolean;
    }
  | InviteActionFailure;

type NormalizedInviteScope = {
  orgId: string;
  projectId: string | null;
  conversationId: string | null;
};

function normalizeInviteScope(scope: InviteScope | null): NormalizedInviteScope | null {
  if (!scope) {
    return null;
  }
  const orgId = scope.orgId.trim();
  if (!orgId) {
    return null;
  }
  if (scope.kind === "organization") {
    return { orgId, projectId: null, conversationId: null };
  }
  const projectId = scope.projectId.trim();
  if (!projectId) {
    return null;
  }
  if (scope.kind === "project") {
    return { orgId, projectId, conversationId: null };
  }
  const conversationId = scope.conversationId.trim();
  if (!conversationId) {
    return null;
  }
  return { orgId, projectId, conversationId };
}

export function isProjectInviteRole(value: string): value is ProjectInviteRole {
  return PROJECT_INVITE_ROLES.some((role) => role === value);
}

export function isOrganizationInviteRole(value: string): value is OrganizationInviteRole {
  return ORGANIZATION_INVITE_ROLES.some((role) => role === value);
}

export function resolveInviteLinkUrl(
  scope: AccessInviteScope,
  acceptPath: string,
): string {
  const url = new URL(resolvePublicAppUrl(acceptPath));
  if (scope.kind === "conversation") {
    url.searchParams.set("conversationControllerId", scope.conversationId);
  }
  return url.toString();
}

export function useScopedInvitationActions<Scope extends InviteScope>(
  scope: Scope | null,
) {
  const normalizedScope = normalizeInviteScope(scope);
  const {
    invitations,
    loading,
    error,
    refresh,
    createInvitation,
    cancelInvitation,
  } = useOrgInvitations(
    normalizedScope?.orgId ?? null,
    normalizedScope?.projectId ?? null,
    normalizedScope?.conversationId ?? null,
  );

  const prepareEmailInvite = useCallback(
    async (
      email: string,
      role: InviteRoleForScope<Scope>,
    ): Promise<PrepareEmailInviteResult> => {
      const result = await createInvitation(email, role);
      if (!result.success) {
        return {
          success: false,
          error: result.error ?? "Unable to create email invite.",
        };
      }
      if (!result.acceptUrl || !result.invitation) {
        return {
          success: false,
          error: "The server did not return a secure invite link. Try again.",
        };
      }
      return {
        success: true,
        invitation: result.invitation,
        preparedInvite: {
          acceptUrl: result.acceptUrl,
          email: result.invitation.email,
          role: result.invitation.role,
        },
      };
    },
    [createInvitation],
  );

  const cancelPendingInvitation = useCallback(
    async (invitationId: string): Promise<InviteMutationResult> => {
      const result = await cancelInvitation(invitationId);
      if (!result.success) {
        return {
          success: false,
          error: result.error ?? "Unable to cancel invitation.",
        };
      }
      return { success: true };
    },
    [cancelInvitation],
  );

  return {
    invitations,
    loading,
    error,
    refresh,
    prepareEmailInvite,
    cancelPendingInvitation,
  };
}

export function useScopedInviteLinkActions(scope: AccessInviteScope | null) {
  const scopeKind = scope?.kind ?? null;
  const scopeOrgId = scope?.orgId ?? null;
  const scopeProjectId = scope?.projectId ?? null;
  const scopeConversationId = scope?.kind === "conversation" ? scope.conversationId : null;
  const normalizedAccessScope = useMemo<AccessInviteScope | null>(() => {
    const candidateScope: AccessInviteScope | null =
      scopeKind === "conversation" && scopeOrgId && scopeProjectId && scopeConversationId
        ? {
            kind: "conversation",
            orgId: scopeOrgId,
            projectId: scopeProjectId,
            conversationId: scopeConversationId,
          }
        : scopeKind === "project" && scopeOrgId && scopeProjectId
          ? { kind: "project", orgId: scopeOrgId, projectId: scopeProjectId }
          : null;
    const normalizedScope = normalizeInviteScope(candidateScope);
    if (!normalizedScope?.projectId) {
      return null;
    }
    if (scopeKind === "conversation" && normalizedScope.conversationId) {
      return {
        kind: "conversation",
        orgId: normalizedScope.orgId,
        projectId: normalizedScope.projectId,
        conversationId: normalizedScope.conversationId,
      };
    }
    if (scopeKind === "project") {
      return {
        kind: "project",
        orgId: normalizedScope.orgId,
        projectId: normalizedScope.projectId,
      };
    }
    return null;
  }, [scopeConversationId, scopeKind, scopeOrgId, scopeProjectId]);
  const {
    links,
    loading,
    error,
    refresh,
    createLink,
    revokeLink,
  } = useOrgInviteLinks(
    normalizedAccessScope?.orgId ?? null,
    normalizedAccessScope?.projectId ?? null,
    normalizedAccessScope?.kind === "conversation"
      ? normalizedAccessScope.conversationId
      : null,
  );
  const currentLink = links[0] ?? null;
  const currentLinkUrl = useMemo(() => {
    if (!normalizedAccessScope || !currentLink?.acceptPath) {
      return null;
    }
    return resolveInviteLinkUrl(normalizedAccessScope, currentLink.acceptPath);
  }, [currentLink, normalizedAccessScope]);

  const rotateInviteLink = useCallback(
    async (role: ProjectInviteRole): Promise<PrepareInviteLinkResult> => {
      if (!normalizedAccessScope) {
        return {
          success: false,
          error: "Select a space before creating invite links.",
        };
      }
      const result = await createLink(role);
      if (!result.success || !result.link?.acceptPath) {
        return {
          success: false,
          error: result.error ?? "Unable to create invite link.",
        };
      }
      return {
        success: true,
        link: result.link,
        rotated: currentLink !== null,
      };
    },
    [createLink, currentLink, normalizedAccessScope],
  );

  const ensureInviteLink = useCallback(
    async (role: ProjectInviteRole): Promise<PrepareInviteLinkResult> => {
      if (!normalizedAccessScope) {
        return {
          success: false,
          error: "Select a space before creating invite links.",
        };
      }
      const refreshedLinks = await refresh({ force: true });
      const refreshedCurrentLink = refreshedLinks[0] ?? null;
      if (refreshedCurrentLink?.role === role && refreshedCurrentLink.acceptPath) {
        return {
          success: true,
          link: refreshedCurrentLink,
          rotated: false,
        };
      }
      const result = await createLink(role);
      if (!result.success || !result.link?.acceptPath) {
        return {
          success: false,
          error: result.error ?? "Unable to create invite link.",
        };
      }
      return {
        success: true,
        link: result.link,
        rotated: refreshedCurrentLink !== null,
      };
    },
    [createLink, normalizedAccessScope, refresh],
  );

  const revokeInviteLink = useCallback(
    async (inviteLinkId: string): Promise<InviteMutationResult> => {
      const result = await revokeLink(inviteLinkId);
      if (!result.success) {
        return {
          success: false,
          error: result.error ?? "Unable to revoke invite link.",
        };
      }
      return { success: true };
    },
    [revokeLink],
  );

  const resolveLinkUrl = useCallback(
    (link: ControllerOrgInviteLink): string | null => {
      if (!normalizedAccessScope || !link.acceptPath) {
        return null;
      }
      return resolveInviteLinkUrl(normalizedAccessScope, link.acceptPath);
    },
    [normalizedAccessScope],
  );

  return {
    links,
    loading,
    error,
    refresh,
    currentLink,
    currentLinkUrl,
    ensureInviteLink,
    rotateInviteLink,
    revokeInviteLink,
    resolveLinkUrl,
  };
}
