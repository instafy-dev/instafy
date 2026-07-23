import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import {
  type ControllerOrgInviteLink,
  controllerClient,
} from "../sdk/instafy";

interface InviteLinkMutationResult {
  success: boolean;
  error?: string;
  link?: ControllerOrgInviteLink | null;
}

export const ORG_INVITE_LINKS_REFRESH_INTERVAL_MS = 10_000;

export function useOrgInviteLinks(
  orgId: string | null,
  projectId: string | null,
  conversationId?: string | null,
) {
  const {
    createInviteLink: createControllerOrgInviteLink,
    listInviteLinks: listControllerOrgInviteLinks,
    revokeInviteLink: revokeControllerOrgInviteLink,
  } = controllerClient.organizations;
  const queryClient = useQueryClient();
  const enabled = Boolean(orgId && projectId);
  const queryKey = useMemo(
    () => ["org-invite-links", orgId ?? null, projectId ?? null, conversationId ?? null] as const,
    [conversationId, orgId, projectId],
  );

  const linksQuery = useQuery({
    queryKey,
    enabled,
    refetchInterval: enabled ? ORG_INVITE_LINKS_REFRESH_INTERVAL_MS : false,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
    queryFn: async () => {
      if (!orgId || !projectId) {
        return [] as ControllerOrgInviteLink[];
      }
      return await listControllerOrgInviteLinks({ orgId, projectId, conversationId });
    },
  });

  const refresh = useCallback(
    async (options?: { force?: boolean }) => {
      if (!enabled) {
        return [] as ControllerOrgInviteLink[];
      }
      if (options?.force) {
        await queryClient.refetchQueries({ queryKey, exact: true, type: "active" });
      } else {
        await queryClient.invalidateQueries({ queryKey, exact: true });
      }
      return queryClient.getQueryData<ControllerOrgInviteLink[]>(queryKey) ?? [];
    },
    [enabled, queryClient, queryKey],
  );

  const createLinkMutation = useMutation({
    mutationFn: async (payload: { role: string }) => {
      if (!orgId || !projectId) {
        throw new Error("Select a space before creating invite links.");
      }
      return await createControllerOrgInviteLink({
        orgId,
        projectId,
        conversationId,
        role: payload.role,
      });
    },
    onSuccess: async (link) => {
      if (link) {
        queryClient.setQueryData(queryKey, [link]);
      }
      await queryClient.invalidateQueries({ queryKey, exact: true });
    },
  });

  const revokeLinkMutation = useMutation({
    mutationFn: async (payload: { inviteLinkId: string }) => {
      if (!orgId) {
        throw new Error("Select a team before revoking invite links.");
      }
      return await revokeControllerOrgInviteLink({ orgId, inviteLinkId: payload.inviteLinkId });
    },
    onSuccess: async (ok) => {
      if (ok) {
        queryClient.setQueryData(queryKey, []);
      }
      await queryClient.invalidateQueries({ queryKey, exact: true });
    },
  });

  const createLink = useCallback(
    async (role: string): Promise<InviteLinkMutationResult> => {
      try {
        const link = await createLinkMutation.mutateAsync({ role });
        if (!link) {
          return { success: false, error: "Unable to create invite link.", link: null };
        }
        return { success: true, link };
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unable to create invite link.";
        return { success: false, error: message, link: null };
      }
    },
    [createLinkMutation],
  );

  const revokeLink = useCallback(
    async (inviteLinkId: string): Promise<InviteLinkMutationResult> => {
      try {
        const ok = await revokeLinkMutation.mutateAsync({ inviteLinkId });
        if (!ok) {
          return { success: false, error: "Unable to revoke invite link." };
        }
        return { success: true };
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unable to revoke invite link.";
        return { success: false, error: message };
      }
    },
    [revokeLinkMutation],
  );

  return {
    links: linksQuery.data ?? [],
    loading: linksQuery.isFetching,
    error: linksQuery.error instanceof Error ? linksQuery.error.message : null,
    refresh,
    createLink,
    revokeLink,
  };
}
