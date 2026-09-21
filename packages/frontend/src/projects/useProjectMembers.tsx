import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo } from "react";
import { useAuth } from "../providers/AuthProvider";
import {
  MEMBERS_CHANGED_EVENT,
  PROJECT_ACCESS_REFRESH_EVENT,
  type MembersChangedEventDetail,
  type ProjectAccessRefreshEventDetail,
} from "./projectAccessEvents";
import {
  type ControllerProjectMember,
  controllerClient,
} from "../sdk/instafy";

interface ProjectMemberMutationResult {
  success: boolean;
  error?: string;
}

export { MEMBERS_CHANGED_EVENT } from "./projectAccessEvents";

export function useProjectMembers(projectId: string | null) {
  const { user } = useAuth();
  const userId = user?.id ?? null;
  const {
    listMembers: listControllerProjectMembers,
    removeMember: removeControllerProjectMember,
    updateMemberRole: updateControllerProjectMemberRole,
  } = controllerClient.projects;
  const queryClient = useQueryClient();
  const enabled = Boolean(projectId && userId);
  const queryKey = useMemo(() => ["project-members", userId, projectId ?? null] as const, [projectId, userId]);

  const membersQuery = useQuery({
    queryKey,
    enabled,
    refetchOnWindowFocus: true,
    queryFn: async () => {
      if (!projectId || !userId) {
        return [] as ControllerProjectMember[];
      }
      return await listControllerProjectMembers(projectId, { throwOnError: true });
    },
  });

  // No timer. The roster refetches on focus and when the controller stream
  // reports an access or membership change for this project (a null project
  // id is an org-wide change), or reopens after a gap.
  useEffect(() => {
    if (!enabled || typeof window === "undefined") {
      return;
    }
    const invalidate = () => {
      void queryClient.invalidateQueries(
        { queryKey, exact: true },
        { cancelRefetch: false },
      );
    };
    const handleScopedChange = (event: Event) => {
      const detail = (
        event as CustomEvent<
          ProjectAccessRefreshEventDetail | MembersChangedEventDetail | undefined
        >
      ).detail;
      const targetProjectId = detail?.projectId ?? null;
      if (targetProjectId === null || targetProjectId === projectId) {
        invalidate();
      }
    };
    window.addEventListener(PROJECT_ACCESS_REFRESH_EVENT, handleScopedChange);
    window.addEventListener(MEMBERS_CHANGED_EVENT, handleScopedChange);
    window.addEventListener("instafy:controller-stream-reconnected", invalidate);
    return () => {
      window.removeEventListener(PROJECT_ACCESS_REFRESH_EVENT, handleScopedChange);
      window.removeEventListener(MEMBERS_CHANGED_EVENT, handleScopedChange);
      window.removeEventListener("instafy:controller-stream-reconnected", invalidate);
    };
  }, [enabled, projectId, queryClient, queryKey]);

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

  const updateMemberRoleMutation = useMutation({
    mutationFn: async (payload: { userId: string; role: string }) => {
      if (!projectId || !userId) {
        throw new Error("Select a project before updating members.");
      }
      return await updateControllerProjectMemberRole({
        projectId,
        userId: payload.userId,
        role: payload.role,
      });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey, exact: true });
    },
  });

  const removeMemberMutation = useMutation({
    mutationFn: async (payload: { userId: string }) => {
      if (!projectId || !userId) {
        throw new Error("Select a project before removing members.");
      }
      return await removeControllerProjectMember({ projectId, userId: payload.userId });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey, exact: true });
    },
  });

  const memberError =
    membersQuery.error instanceof Error ? membersQuery.error.message : null;

  const updateMemberRole = useCallback(
    async (userId: string, role: string): Promise<ProjectMemberMutationResult> => {
      try {
        const result = await updateMemberRoleMutation.mutateAsync({ userId, role });
        if (!result) {
          return { success: false, error: "Unable to update project member role." };
        }
        return { success: true };
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Unable to update project member role.";
        return { success: false, error: message };
      }
    },
    [updateMemberRoleMutation],
  );

  const removeMember = useCallback(
    async (userId: string): Promise<ProjectMemberMutationResult> => {
      try {
        const removed = await removeMemberMutation.mutateAsync({ userId });
        if (!removed) {
          return { success: false, error: "Unable to remove project member." };
        }
        return { success: true };
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Unable to remove project member.";
        return { success: false, error: message };
      }
    },
    [removeMemberMutation],
  );

  return {
    // React Query intentionally retains the last successful data after a
    // refetch error. A protected member directory must fail closed instead of
    // leaving revoked names visible in Chat or Settings.
    members: memberError ? [] : membersQuery.data ?? [],
    loading: membersQuery.isFetching,
    error: memberError,
    refresh,
    updateMemberRole,
    removeMember,
  };
}
