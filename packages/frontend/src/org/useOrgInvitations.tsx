import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import {
  type ControllerOrgInvitation
} from "../sdk/instafy";
import { controllerClient } from "../sdk/instafy";
import { ControllerApiError } from "../services/runtimeController/core";

export interface OrgInvitationRoleConflict {
  invitationId: string;
  existingRole: string;
  requestedRole: string;
}

interface OrgInvitationMutationResult {
  success: boolean;
  error?: string;
  invitation?: ControllerOrgInvitation;
  acceptUrl?: string;
  // Present when creation was refused because a pending invitation already
  // exists with a different role — the caller can offer an in-place update.
  conflict?: OrgInvitationRoleConflict;
}

function extractRoleConflict(error: unknown): OrgInvitationRoleConflict | null {
  if (
    !(error instanceof ControllerApiError) ||
    error.code !== "invitation_role_conflict" ||
    !error.details ||
    typeof error.details !== "object"
  ) {
    return null;
  }
  const details = error.details as Record<string, unknown>;
  const invitationId = typeof details.invitationId === "string" ? details.invitationId : "";
  const existingRole = typeof details.existingRole === "string" ? details.existingRole : "";
  const requestedRole = typeof details.requestedRole === "string" ? details.requestedRole : "";
  if (!invitationId || !existingRole || !requestedRole) {
    return null;
  }
  return { invitationId, existingRole, requestedRole };
}

export function useOrgInvitations(
  orgId: string | null,
  projectId?: string | null,
  conversationId?: string | null,
) {
  const {
    cancelInvitation: cancelControllerOrgInvitation,
    // Strict so the 409 invitation_role_conflict arrives as a typed error
    // with the existing invitation's id and roles, not a swallowed null.
    createInvitationStrict: createControllerOrgInvitation,
    listInvitations: listControllerOrgInvitations,
    updateInvitationRole: updateControllerOrgInvitationRole,
  } = controllerClient.organizations;
  const queryClient = useQueryClient();
  const enabled = Boolean(orgId);
  const queryKey = useMemo(
    () => ["org-invitations", orgId ?? null, projectId ?? null, conversationId ?? null] as const,
    [conversationId, orgId, projectId],
  );

  const invitationsQuery = useQuery({
    queryKey,
    enabled,
    queryFn: async () => {
      if (!orgId) {
        return [] as ControllerOrgInvitation[];
      }
      return await listControllerOrgInvitations(orgId, projectId, conversationId);
    },
  });

  const refresh = useCallback(
    async (options?: { force?: boolean }) => {
      if (!enabled) {
        return;
      }
      if (options?.force) {
        await queryClient.refetchQueries({ queryKey, exact: true, type: "active" });
      } else {
        await queryClient.invalidateQueries({ queryKey, exact: true });
      }
    },
    [enabled, queryClient, queryKey],
  );

  const createInvitationMutation = useMutation({
    mutationFn: async (payload: { email: string; role: string }) => {
      if (!orgId) {
        throw new Error("Select a team before inviting people.");
      }
      return await createControllerOrgInvitation({
        orgId,
        email: payload.email,
        role: payload.role,
        projectId,
        conversationId,
      });
    },
    onSuccess: async (creation) => {
      if (creation?.id) {
        const invitation: ControllerOrgInvitation & { acceptUrl?: string } = { ...creation };
        delete invitation.acceptUrl;
        queryClient.setQueryData<ControllerOrgInvitation[]>(queryKey, (previous) => {
          const existing = Array.isArray(previous) ? previous : [];
          const duplicate = existing.some((entry) => entry.id === invitation.id);
          if (duplicate) {
            return existing;
          }
          return [invitation, ...existing];
        });
      }
      await queryClient.invalidateQueries({ queryKey, exact: true });
    },
  });

  const cancelInvitationMutation = useMutation({
    mutationFn: async (payload: { invitationId: string }) => {
      if (!orgId) {
        throw new Error("Select a team before canceling invitations.");
      }
      return await cancelControllerOrgInvitation({ orgId, invitationId: payload.invitationId });
    },
    onSuccess: async (_removed, variables) => {
      if (variables?.invitationId) {
        queryClient.setQueryData<ControllerOrgInvitation[]>(queryKey, (previous) => {
          const existing = Array.isArray(previous) ? previous : [];
          return existing.filter((entry) => entry.id !== variables.invitationId);
        });
      }
      await queryClient.invalidateQueries({ queryKey, exact: true });
    },
  });

  const createInvitation = useCallback(
    async (email: string, role: string): Promise<OrgInvitationMutationResult> => {
      try {
        const result = await createInvitationMutation.mutateAsync({ email, role });
        if (!result) {
          return { success: false, error: "Unable to create email invite." };
        }
        const { acceptUrl, ...invitation } = result;
        return { success: true, invitation, acceptUrl };
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unable to create email invite.";
        const conflict = extractRoleConflict(error);
        return conflict
          ? { success: false, error: message, conflict }
          : { success: false, error: message };
      }
    },
    [createInvitationMutation]
  );

  const cancelInvitation = useCallback(
    async (invitationId: string): Promise<OrgInvitationMutationResult> => {
      try {
        const removed = await cancelInvitationMutation.mutateAsync({ invitationId });
        if (!removed) {
          return { success: false, error: "Unable to cancel invitation." };
        }
        return { success: true };
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unable to cancel invitation.";
        return { success: false, error: message };
      }
    },
    [cancelInvitationMutation]
  );

  const updateInvitationRoleMutation = useMutation({
    mutationFn: async (payload: { invitationId: string; role: string }) => {
      if (!orgId) {
        throw new Error("Select a team before updating invitations.");
      }
      // Throws with the server's reason on rejection; the callback below
      // relays it so owner-gating and expiry read as themselves, not as a
      // generic failure.
      return await updateControllerOrgInvitationRole({
        orgId,
        invitationId: payload.invitationId,
        role: payload.role,
      });
    },
    onSuccess: async (updated) => {
      if (updated?.id) {
        // The accept URL is response metadata for the caller, not row state.
        const invitation: ControllerOrgInvitation & { acceptUrl?: string } = { ...updated };
        delete invitation.acceptUrl;
        queryClient.setQueryData<ControllerOrgInvitation[]>(queryKey, (previous) => {
          const existing = Array.isArray(previous) ? previous : [];
          return existing.map((entry) => (entry.id === invitation.id ? invitation : entry));
        });
      }
      await queryClient.invalidateQueries({ queryKey, exact: true });
    },
    // A rejected change often means the row itself is gone (accepted,
    // canceled, expired); resync so the pending list stops showing it.
    onError: async () => {
      await queryClient.invalidateQueries({ queryKey, exact: true });
    },
  });

  const updateInvitationRole = useCallback(
    async (invitationId: string, role: string): Promise<OrgInvitationMutationResult> => {
      try {
        const result = await updateInvitationRoleMutation.mutateAsync({
          invitationId,
          role,
        });
        const { acceptUrl, ...invitation } = result;
        return { success: true, invitation, acceptUrl };
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Unable to update the invitation role.";
        return { success: false, error: message };
      }
    },
    [updateInvitationRoleMutation]
  );

  return {
    invitations: invitationsQuery.data ?? [],
    loading: invitationsQuery.isFetching,
    error: invitationsQuery.error instanceof Error ? invitationsQuery.error.message : null,
    refresh,
    createInvitation,
    cancelInvitation,
    updateInvitationRole
  };
}
