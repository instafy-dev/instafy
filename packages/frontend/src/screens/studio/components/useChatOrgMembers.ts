import { useEffect, useMemo, useState } from "react";
import {
  controllerClient,
  type ControllerProjectMember,
} from "../../../sdk/instafy";

export const CHAT_ORG_MEMBERS_REFRESH_INTERVAL_MS = 10_000;

export function canShareProjectForOrgRole(
  role: string | null | undefined,
): boolean {
  return role === "owner" || role === "admin" || role === "builder";
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
  const [members, setMembers] = useState<ControllerProjectMember[]>([]);
  const [currentUserRole, setCurrentUserRole] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [resolvedRequestKey, setResolvedRequestKey] = useState<string | null>(
    null,
  );
  const requestKey = activeOrgId
    ? `${activeOrgId}:${currentUserId ?? "anonymous"}`
    : null;

  useEffect(() => {
    if (!enabled || !activeOrgId) {
      setMembers([]);
      setCurrentUserRole(null);
      setError(null);
      setLoading(false);
      setResolvedRequestKey(null);
      return;
    }

    let cancelled = false;
    let requestInFlight = false;
    setMembers([]);
    setCurrentUserRole(null);
    setError(null);

    const refresh = async () => {
      if (requestInFlight) {
        return;
      }
      requestInFlight = true;
      try {
        const organizations = await controllerClient.organizations.list({
          throwOnError: true,
        });
        if (cancelled) {
          return;
        }
        const activeOrganization = organizations.find(
          (entry) => entry.id === activeOrgId,
        );
        if (!activeOrganization) {
          setMembers([]);
          setCurrentUserRole(null);
          setError(null);
          return;
        }

        const nextMembers = await controllerClient.organizations.listMembers(
          activeOrgId,
          { throwOnError: true },
        );
        if (cancelled) {
          return;
        }
        const organizationRole = activeOrganization.role;
        const memberRole = currentUserId
          ? nextMembers.find((entry) => entry.userId === currentUserId)?.role
          : null;
        setMembers(nextMembers);
        setCurrentUserRole(
          typeof organizationRole === "string" && organizationRole.trim()
            ? organizationRole.trim()
            : typeof memberRole === "string" && memberRole.trim()
              ? memberRole.trim()
              : null,
        );
        setError(null);
      } catch (refreshError) {
        if (!cancelled) {
          setMembers([]);
          setCurrentUserRole(null);
          setError(
            refreshError instanceof Error
              ? refreshError.message
              : "Unable to refresh organization members.",
          );
        }
      } finally {
        requestInFlight = false;
        if (!cancelled) {
          setLoading(false);
          setResolvedRequestKey(requestKey);
        }
      }
    };

    setLoading(true);
    void refresh();

    const intervalId = window.setInterval(
      () => void refresh(),
      CHAT_ORG_MEMBERS_REFRESH_INTERVAL_MS,
    );
    const handleFocus = () => void refresh();
    window.addEventListener("focus", handleFocus);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
      window.removeEventListener("focus", handleFocus);
    };
  }, [activeOrgId, currentUserId, enabled, requestKey]);

  const requestIsCurrent = Boolean(
    enabled && requestKey && resolvedRequestKey === requestKey,
  );
  const visibleCurrentUserRole = requestIsCurrent ? currentUserRole : null;
  const visibleMembers = requestIsCurrent ? members : [];
  const canShareProject = useMemo(
    () => canShareProjectForOrgRole(visibleCurrentUserRole),
    [visibleCurrentUserRole],
  );

  return {
    canShareProject,
    currentUserRole: visibleCurrentUserRole,
    error: requestIsCurrent ? error : null,
    loading:
      loading ||
      Boolean(enabled && requestKey && resolvedRequestKey !== requestKey),
    members: visibleMembers,
  };
}
