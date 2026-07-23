import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  type ControllerOrgMember,
  controllerClient,
} from "../sdk/instafy";

interface OrgMemberMutationResult {
  success: boolean;
  error?: string;
}

export function useOrgMembers(orgId: string | null) {
  const {
    addMember: addControllerOrgMember,
    listMembersPage: listControllerOrgMembersPage,
    removeMember: removeControllerOrgMember,
    updateMemberRole: updateControllerOrgMemberRole,
  } = controllerClient.organizations;
  const queryClient = useQueryClient();
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");

  useEffect(() => {
    setQuery("");
    setDebouncedQuery("");
  }, [orgId]);

  useEffect(() => {
    const handle = setTimeout(() => {
      setDebouncedQuery(query.trim());
    }, 250);
    return () => {
      clearTimeout(handle);
    };
  }, [query]);

  const enabled = Boolean(orgId);
  const queryKey = useMemo(
    () => ["org-members", orgId ?? null, debouncedQuery] as const,
    [debouncedQuery, orgId],
  );

  const orgMembersQuery = useInfiniteQuery({
    queryKey,
    enabled,
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam }) => {
      if (!orgId) {
        return { members: [], nextCursor: null, hasMore: false, total: null };
      }
      return await listControllerOrgMembersPage(orgId, {
        limit: 50,
        cursor: pageParam,
        query: debouncedQuery || null,
      });
    },
    getNextPageParam: (lastPage) => {
      if (lastPage?.hasMore && lastPage?.nextCursor) {
        return lastPage.nextCursor;
      }
      return undefined;
    },
  });

  const members = useMemo(() => {
    const pages = orgMembersQuery.data?.pages ?? [];
    if (pages.length === 0) {
      return [];
    }
    const seen = new Set<string>();
    const merged: ControllerOrgMember[] = [];
    for (const page of pages) {
      for (const member of page.members ?? []) {
        const userId = member?.userId;
        if (typeof userId !== "string" || userId.length === 0 || seen.has(userId)) {
          continue;
        }
        seen.add(userId);
        merged.push(member);
      }
    }
    return merged;
  }, [orgMembersQuery.data?.pages]);

  const total = useMemo(() => {
    const pages = orgMembersQuery.data?.pages ?? [];
    if (pages.length === 0) {
      return null;
    }
    const first = pages[0];
    return typeof first?.total === "number" && Number.isFinite(first.total) ? first.total : null;
  }, [orgMembersQuery.data?.pages]);

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

  const loadMore = useCallback(async () => {
    if (!enabled || !orgMembersQuery.hasNextPage || orgMembersQuery.isFetchingNextPage) {
      return;
    }
    await orgMembersQuery.fetchNextPage();
  }, [enabled, orgMembersQuery]);

  const mutationKey = useMemo(() => ["org-members", orgId ?? null] as const, [orgId]);

  const addMemberMutation = useMutation({
    mutationFn: async (payload: { email: string; role: string }) => {
      if (!orgId) {
        throw new Error("Select a team before adding people.");
      }
      return await addControllerOrgMember({ orgId, email: payload.email, role: payload.role });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: mutationKey, exact: false });
    },
  });

  const updateMemberRoleMutation = useMutation({
    mutationFn: async (payload: { userId: string; role: string }) => {
      if (!orgId) {
        throw new Error("Select a team before updating roles.");
      }
      return await updateControllerOrgMemberRole({ orgId, userId: payload.userId, role: payload.role });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: mutationKey, exact: false });
    },
  });

  const removeMemberMutation = useMutation({
    mutationFn: async (payload: { userId: string }) => {
      if (!orgId) {
        throw new Error("Select a team before removing people.");
      }
      return await removeControllerOrgMember({ orgId, userId: payload.userId });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: mutationKey, exact: false });
    },
  });

  const addMember = useCallback(
    async (email: string, role: string): Promise<OrgMemberMutationResult> => {
      try {
        const result = await addMemberMutation.mutateAsync({ email, role });
        if (!result) {
          return { success: false, error: "Unable to add member." };
        }
        return { success: true };
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unable to add member.";
        return { success: false, error: message };
      }
    },
    [addMemberMutation]
  );

  const updateMemberRole = useCallback(
    async (userId: string, role: string): Promise<OrgMemberMutationResult> => {
      try {
        const result = await updateMemberRoleMutation.mutateAsync({ userId, role });
        if (!result) {
          return { success: false, error: "Unable to update member role." };
        }
        return { success: true };
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unable to update member role.";
        return { success: false, error: message };
      }
    },
    [updateMemberRoleMutation]
  );

  const removeMember = useCallback(
    async (userId: string): Promise<OrgMemberMutationResult> => {
      try {
        const removed = await removeMemberMutation.mutateAsync({ userId });
        if (!removed) {
          return { success: false, error: "Unable to remove member." };
        }
        return { success: true };
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unable to remove member.";
        return { success: false, error: message };
      }
    },
    [removeMemberMutation]
  );

  return {
    members,
    loading: orgMembersQuery.isLoading || (orgMembersQuery.isFetching && !orgMembersQuery.isFetchingNextPage),
    loadingMore: orgMembersQuery.isFetchingNextPage,
    error: orgMembersQuery.error instanceof Error ? orgMembersQuery.error.message : null,
    query,
    setQuery,
    hasMore: orgMembersQuery.hasNextPage ?? false,
    total,
    refresh,
    loadMore,
    addMember,
    updateMemberRole,
    removeMember
  };
}
