import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";
import {
  MEMBERS_CHANGED_EVENT,
  PROJECT_ACCESS_REFRESH_EVENT,
} from "../../../projects/projectAccessEvents";
import { invalidateAfterInFlight } from "../../../projects/invalidateAfterInFlight";
import {
  controllerClient,
  type ControllerProjectMember,
} from "../../../sdk/instafy";

export const CONTROLLER_ORGANIZATIONS_QUERY_KEY = "controller-organizations";
export const ORG_DIRECTORY_QUERY_KEY = "org-directory";
const CONTROLLER_ORGANIZATIONS_STALE_TIME_MS = 60_000;

// The roster has no timer. It is refetched on mount, when the window regains
// focus, and on these window events. The controller stream feeds the access
// and members-changed events; profile edits feed orgs-updated.
export const CHAT_ORG_MEMBERS_REFRESH_EVENTS = [
  "focus",
  PROJECT_ACCESS_REFRESH_EVENT,
  "instafy:controller-stream-reconnected",
  "instafy:orgs-updated",
  MEMBERS_CHANGED_EVENT,
] as const;

export function canShareProjectForOrgRole(
  role: string | null | undefined,
): boolean {
  return role === "owner" || role === "admin" || role === "builder";
}

function describeError(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

export function useChatOrgMembers({
  activeOrgId,
  currentUserId,
  enabled,
}: {
  activeOrgId: string | null;
  currentUserId: string | null;
  enabled: boolean;
}) {
  const queryClient = useQueryClient();
  const userKey = currentUserId ?? "anonymous";
  const active = enabled && Boolean(activeOrgId);

  const organizationsQuery = useQuery({
    queryKey: [CONTROLLER_ORGANIZATIONS_QUERY_KEY, userKey],
    enabled: active,
    staleTime: CONTROLLER_ORGANIZATIONS_STALE_TIME_MS,
    refetchOnWindowFocus: true,
    queryFn: async () =>
      await controllerClient.organizations.list({ throwOnError: true }),
  });

  // A refetch error keeps the last data in the cache. The directory is
  // protected, so an errored organization list must not keep authorizing it.
  const activeOrganization =
    active && !organizationsQuery.isError && activeOrgId
      ? (organizationsQuery.data?.find((entry) => entry.id === activeOrgId) ??
        null)
      : null;
  const directoryEnabled = active && activeOrganization !== null;

  const directoryQuery = useQuery({
    queryKey: [ORG_DIRECTORY_QUERY_KEY, userKey, activeOrgId],
    enabled: directoryEnabled,
    refetchOnWindowFocus: true,
    queryFn: async () => {
      if (!activeOrgId) {
        return [] as ControllerProjectMember[];
      }
      return await controllerClient.organizations.listMembers(activeOrgId, {
        throwOnError: true,
      });
    },
  });

  useEffect(() => {
    if (!active || typeof window === "undefined") {
      return;
    }
    const invalidate = () => {
      void queryClient.invalidateQueries(
        { queryKey: [CONTROLLER_ORGANIZATIONS_QUERY_KEY] },
        { cancelRefetch: false },
      );
      void queryClient.invalidateQueries(
        { queryKey: [ORG_DIRECTORY_QUERY_KEY] },
        { cancelRefetch: false },
      );
    };
    // A change signal may arrive while a fetch that read the old roster is
    // still in flight; focus and reconnect joining that fetch is enough.
    const invalidateAfterChange = () => {
      void invalidateAfterInFlight(queryClient, {
        queryKey: [CONTROLLER_ORGANIZATIONS_QUERY_KEY],
      });
      void invalidateAfterInFlight(queryClient, {
        queryKey: [ORG_DIRECTORY_QUERY_KEY],
      });
    };
    const handlerFor = (eventName: string) =>
      eventName === MEMBERS_CHANGED_EVENT || eventName === PROJECT_ACCESS_REFRESH_EVENT
        ? invalidateAfterChange
        : invalidate;
    for (const eventName of CHAT_ORG_MEMBERS_REFRESH_EVENTS) {
      window.addEventListener(eventName, handlerFor(eventName));
    }
    return () => {
      for (const eventName of CHAT_ORG_MEMBERS_REFRESH_EVENTS) {
        window.removeEventListener(eventName, handlerFor(eventName));
      }
    };
  }, [active, queryClient]);

  const resolved = useMemo(() => {
    if (!active) {
      return { members: [], role: null, error: null, loading: false };
    }
    if (organizationsQuery.isError) {
      return {
        members: [],
        role: null,
        error: describeError(
          organizationsQuery.error,
          "Unable to refresh organization members.",
        ),
        loading: false,
      };
    }
    if (organizationsQuery.isPending) {
      return { members: [], role: null, error: null, loading: true };
    }
    if (!activeOrganization) {
      // A project guest is not in the organization and must not read its
      // member directory.
      return { members: [], role: null, error: null, loading: false };
    }
    if (directoryQuery.isError) {
      return {
        members: [],
        role: null,
        error: describeError(
          directoryQuery.error,
          "Unable to refresh organization members.",
        ),
        loading: false,
      };
    }
    if (directoryQuery.isPending) {
      return { members: [], role: null, error: null, loading: true };
    }
    const members = directoryQuery.data;
    const organizationRole = activeOrganization.role;
    const memberRole = currentUserId
      ? members.find((entry) => entry.userId === currentUserId)?.role
      : null;
    const role =
      typeof organizationRole === "string" && organizationRole.trim()
        ? organizationRole.trim()
        : typeof memberRole === "string" && memberRole.trim()
          ? memberRole.trim()
          : null;
    return { members, role, error: null, loading: false };
  }, [
    active,
    activeOrganization,
    currentUserId,
    directoryQuery.data,
    directoryQuery.error,
    directoryQuery.isError,
    directoryQuery.isPending,
    organizationsQuery.error,
    organizationsQuery.isError,
    organizationsQuery.isPending,
  ]);

  const canShareProject = useMemo(
    () => canShareProjectForOrgRole(resolved.role),
    [resolved.role],
  );

  return {
    canShareProject,
    currentUserRole: resolved.role,
    error: resolved.error,
    loading: resolved.loading,
    members: resolved.members,
  };
}
