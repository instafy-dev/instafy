import { useEffect, useMemo, useState } from "react";
import { getOrgDisplayName } from "../org/orgNaming";
import { useAuth } from "../providers/AuthProvider";
import {
  controllerClient,
  type ControllerProjectSummary,
} from "../sdk/instafy";
import type { ProjectListItem } from "./useProjects";
import { PROJECT_ACCESS_REFRESH_EVENT } from "./projectAccessEvents";

const runtimeControllerEnabled = controllerClient.core.enabled;

export interface MergedProjectListItem {
  id: string;
  name: string;
  orgId: string | null;
  orgName: string;
  state: ProjectListItem["state"] | null;
  isRemoteOnly: boolean;
}

export function mergeControllerProjects(
  localProjects: ProjectListItem[],
  remoteProjects: ControllerProjectSummary[],
): MergedProjectListItem[] {
  const byId = new Map<string, MergedProjectListItem>();
  const localById = new Map<string, MergedProjectListItem>();

  localProjects.forEach((project) => {
    const entry = {
      ...project,
      isRemoteOnly: false,
    };
    localById.set(project.id, entry);
    byId.set(project.id, entry);
  });

  remoteProjects.forEach((project) => {
    const local = localById.get(project.projectId);
    const existing = byId.get(project.projectId);
    const remoteName =
      typeof project.projectName === "string" && project.projectName.trim().length > 0
        ? project.projectName.trim()
        : null;
    const name =
      local?.name ?? remoteName ?? existing?.name ?? "Untitled space";
    const orgName = getOrgDisplayName(project.orgName ?? local?.orgName ?? existing?.orgName);
    const orgId = project.orgId ?? local?.orgId ?? existing?.orgId ?? null;
    byId.set(project.projectId, {
      id: project.projectId,
      name,
      orgId,
      orgName,
      state: local?.state ?? existing?.state ?? null,
      isRemoteOnly: !local,
    });
  });

  return Array.from(byId.values());
}

interface UseMergedControllerProjectsOptions {
  localProjects: ProjectListItem[];
  orgId?: string | null;
  includeAllOrgs?: boolean;
  requestedProjectId?: string | null;
}

export function mergeRemoteProjectSources(
  remoteProjects: ControllerProjectSummary[],
  requestedProject: ControllerProjectSummary | null,
): ControllerProjectSummary[] {
  if (!requestedProject) {
    return remoteProjects;
  }
  return [...remoteProjects, requestedProject];
}

export function filterAccessibleProjectsByOrg(
  projects: ControllerProjectSummary[],
  orgId: string | null,
): ControllerProjectSummary[] {
  if (!orgId) {
    return projects;
  }
  return projects.filter((project) => project.orgId === orgId);
}

async function listLegacyControllerProjects(): Promise<ControllerProjectSummary[]> {
  const orgs = await controllerClient.organizations.list({ throwOnError: true });
  const results = await Promise.all(
    orgs.map(async (org) => {
      const result = await controllerClient.projects.listResult({ orgId: org.id });
      if (result.status !== "success") {
        throw new Error("Unable to discover all organization spaces.");
      }
      return result.projects;
    }),
  );
  return results.flat();
}

export function useMergedControllerProjects({
  localProjects,
  orgId = null,
  includeAllOrgs = false,
  requestedProjectId = null,
}: UseMergedControllerProjectsOptions) {
  const { loading: authLoading, session, user } = useAuth();
  const userId = user?.id ?? null;
  const [discovery, setDiscovery] = useState<{
    userId: string;
    projects: ControllerProjectSummary[];
  } | null>(null);
  const [settledDiscoveryUserId, setSettledDiscoveryUserId] = useState<string | null>(null);
  const [requestedSnapshot, setRequestedSnapshot] = useState<{
    userId: string;
    projectId: string;
    summary: ControllerProjectSummary | null;
  } | null>(null);
  const [requestedProjectLoading, setRequestedProjectLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (!runtimeControllerEnabled || !userId) {
      setDiscovery(null);
      setSettledDiscoveryUserId(null);
      return;
    }
    if (authLoading) {
      return;
    }

    // GET /projects already covers every accessible organization. Keep that
    // snapshot when the selected org changes, so switching never waits for
    // another identical request. Refresh authentication/access changes and
    // foreground visits in the background while retaining the current list.
    let inFlight = false;
    let accessRefreshRequested = false;
    const refresh = async () => {
      if (inFlight || cancelled) {
        return;
      }
      inFlight = true;
      try {
        const result = await controllerClient.projects.listResult();
        if (cancelled) {
          return;
        }
        if (result.status === "error") {
          return;
        }
        // Older controllers expose only org-scoped discovery. Gather all
        // memberships once there too, so switching can use the same snapshot.
        // A successful empty list is authoritative; an unavailable controller
        // must not replace a warm snapshot with an apparent loss of access.
        const projects = result.status === "unsupported"
          ? await listLegacyControllerProjects()
          : result.projects;
        if (!cancelled) {
          setDiscovery({ userId, projects });
        }
      } catch (error) {
        if (!cancelled) {
          console.warn("[projects] failed to refresh accessible spaces:", error);
        }
      } finally {
        inFlight = false;
        if (!cancelled) {
          setSettledDiscoveryUserId(userId);
        }
        if (accessRefreshRequested && !cancelled) {
          accessRefreshRequested = false;
          void refresh();
        }
      }
    };
    const handleRefresh = () => {
      void refresh();
    };
    const handleAccessChanged = () => {
      if (inFlight) {
        accessRefreshRequested = true;
        return;
      }
      handleRefresh();
    };
    const handleVisibility = () => {
      if (document.visibilityState === "visible") {
        handleRefresh();
      }
    };
    handleRefresh();
    window.addEventListener("focus", handleRefresh);
    window.addEventListener(PROJECT_ACCESS_REFRESH_EVENT, handleAccessChanged);
    document.addEventListener("visibilitychange", handleVisibility);

    return () => {
      cancelled = true;
      window.removeEventListener("focus", handleRefresh);
      window.removeEventListener(PROJECT_ACCESS_REFRESH_EVENT, handleAccessChanged);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [authLoading, session?.access_token, userId]);

  useEffect(() => {
    let cancelled = false;

    if (!runtimeControllerEnabled) {
      setRequestedSnapshot(null);
      setRequestedProjectLoading(false);
      return () => {
        cancelled = true;
      };
    }
    if (authLoading) {
      setRequestedProjectLoading(true);
      return () => {
        cancelled = true;
      };
    }
    if (!userId || !requestedProjectId) {
      setRequestedSnapshot(null);
      setRequestedProjectLoading(false);
      return () => {
        cancelled = true;
      };
    }

    let inFlight = false;
    let accessRefreshRequested = false;
    let accessVersion = 0;
    const refresh = async () => {
      if (inFlight || cancelled) {
        return;
      }
      inFlight = true;
      const requestedAccessVersion = accessVersion;
      setRequestedProjectLoading(true);
      try {
        const result = await controllerClient.projects.getSummaryResult(requestedProjectId);
        if (cancelled || requestedAccessVersion !== accessVersion) {
          return;
        }
        // Keep a directly shared space during transient failures, but remove
        // its fallback summary when the controller reports lost access.
        if (result.summary || result.notFound || result.forbidden || result.unauthorized) {
          setRequestedSnapshot({ userId, projectId: requestedProjectId, summary: result.summary ?? null });
        }
      } catch (error) {
        if (!cancelled) {
          console.warn("[projects] failed to refresh requested space:", error);
        }
      } finally {
        inFlight = false;
        if (!cancelled) {
          setRequestedProjectLoading(false);
        }
        if (accessRefreshRequested && !cancelled) {
          accessRefreshRequested = false;
          void refresh();
        }
      }
    };
    const handleRefresh = () => {
      void refresh();
    };
    const handleAccessChanged = (event: Event) => {
      const projectId = (event as CustomEvent<{ projectId?: string }>).detail?.projectId;
      if (projectId && projectId !== requestedProjectId) {
        return;
      }
      accessVersion += 1;
      if (inFlight) {
        accessRefreshRequested = true;
        return;
      }
      handleRefresh();
    };
    const handleVisibility = () => {
      if (document.visibilityState === "visible") {
        handleRefresh();
      }
    };
    handleRefresh();
    window.addEventListener("focus", handleRefresh);
    window.addEventListener(PROJECT_ACCESS_REFRESH_EVENT, handleAccessChanged);
    document.addEventListener("visibilitychange", handleVisibility);

    return () => {
      cancelled = true;
      window.removeEventListener("focus", handleRefresh);
      window.removeEventListener(PROJECT_ACCESS_REFRESH_EVENT, handleAccessChanged);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [authLoading, requestedProjectId, session?.access_token, userId]);

  // Scope the data during render, rather than clearing it in a later effect:
  // neither an account change nor an org click may expose the old scope.
  const accessibleProjects = userId && discovery?.userId === userId ? discovery.projects : null;
  const remoteProjects = useMemo(
    () => filterAccessibleProjectsByOrg(accessibleProjects ?? [], orgId),
    [accessibleProjects, orgId],
  );
  const remoteLoadedScope = accessibleProjects
    ? orgId ?? (includeAllOrgs ? "__all__" : null)
    : null;
  const remoteLoading = !accessibleProjects && (
    authLoading || (runtimeControllerEnabled && Boolean(userId) && settledDiscoveryUserId !== userId)
  );
  const requestedProjectResolved = Boolean(
    userId && requestedSnapshot?.userId === userId && requestedSnapshot.projectId === requestedProjectId,
  );
  const requestedProject = requestedProjectResolved ? requestedSnapshot?.summary ?? null : null;

  const effectiveRemoteProjects = useMemo(
    () => mergeRemoteProjectSources(remoteProjects, requestedProject),
    [remoteProjects, requestedProject],
  );

  const mergedProjects = useMemo(
    () => mergeControllerProjects(localProjects, effectiveRemoteProjects),
    [effectiveRemoteProjects, localProjects],
  );

  return {
    mergedProjects,
    remoteLoading: remoteLoading || (Boolean(requestedProjectId) && requestedProjectLoading && !requestedProjectResolved),
    remoteLoadedScope,
    remoteProjects: effectiveRemoteProjects,
  };
}
