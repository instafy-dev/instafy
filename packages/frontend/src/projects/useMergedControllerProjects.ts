import { useEffect, useMemo, useState } from "react";
import { getOrgDisplayName } from "../org/orgNaming";
import { useAuth } from "../providers/AuthProvider";
import {
  controllerClient,
  type ControllerProjectSummary,
} from "../sdk/instafy";
import type { ProjectListItem } from "./useProjects";

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

async function listLegacyControllerProjects(
  orgId: string | null,
): Promise<ControllerProjectSummary[]> {
  if (orgId) {
    return controllerClient.projects.list({ orgId });
  }

  const orgs = await controllerClient.organizations.list();
  const results = await Promise.allSettled(
    orgs.map(async (org) => controllerClient.projects.list({ orgId: org.id })),
  );
  return results.flatMap((result) =>
    result.status === "fulfilled" ? result.value : [],
  );
}

export function useMergedControllerProjects({
  localProjects,
  orgId = null,
  includeAllOrgs = false,
  requestedProjectId = null,
}: UseMergedControllerProjectsOptions) {
  const { loading: authLoading, session, user } = useAuth();
  const [remoteProjects, setRemoteProjects] = useState<ControllerProjectSummary[]>([]);
  const [requestedProject, setRequestedProject] = useState<ControllerProjectSummary | null>(null);
  const [remoteLoading, setRemoteLoading] = useState(false);
  // Which scope the CURRENT remoteProjects were fetched for. Consumers that
  // act on "this org has no projects" must check this: right after an org
  // switch, remoteProjects still holds the previous scope's results for a
  // render, and remoteLoading may not have flipped yet in their closure.
  const [remoteLoadedScope, setRemoteLoadedScope] = useState<string | null>(null);
  const [requestedProjectLoading, setRequestedProjectLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;

    if (!runtimeControllerEnabled) {
      setRemoteProjects([]);
      setRemoteLoading(false);
      return () => {
        cancelled = true;
      };
    }
    if (authLoading) {
      setRemoteProjects([]);
      setRemoteLoading(true);
      return () => {
        cancelled = true;
      };
    }
    if (!user) {
      setRemoteProjects([]);
      setRemoteLoading(false);
      return () => {
        cancelled = true;
      };
    }
    setRemoteLoading(true);
    (async () => {
      let accessibleProjects = await controllerClient.projects.list();
      // Keep ordinary org-backed discovery working while controller nodes are
      // rolling out the unscoped endpoint. Direct project memberships still
      // appear as soon as GET /projects is available.
      if (accessibleProjects.length === 0) {
        accessibleProjects = await listLegacyControllerProjects(orgId);
      }
      return filterAccessibleProjectsByOrg(accessibleProjects, orgId);
    })()
      .then((projects) => {
        if (!cancelled) {
          setRemoteProjects(projects);
          setRemoteLoadedScope(orgId ?? (includeAllOrgs ? "__all__" : null));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setRemoteLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [authLoading, includeAllOrgs, orgId, session?.access_token, user]);

  useEffect(() => {
    let cancelled = false;

    if (!runtimeControllerEnabled) {
      setRequestedProject(null);
      setRequestedProjectLoading(false);
      return () => {
        cancelled = true;
      };
    }
    if (authLoading) {
      setRequestedProject(null);
      setRequestedProjectLoading(true);
      return () => {
        cancelled = true;
      };
    }
    if (!user || !requestedProjectId) {
      setRequestedProject(null);
      setRequestedProjectLoading(false);
      return () => {
        cancelled = true;
      };
    }

    setRequestedProjectLoading(true);
    controllerClient.projects
      .getSummaryResult(requestedProjectId)
      .then((result) => {
        if (cancelled) {
          return;
        }
        setRequestedProject(result.summary ?? null);
      })
      .finally(() => {
        if (!cancelled) {
          setRequestedProjectLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [authLoading, requestedProjectId, session?.access_token, user]);

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
    remoteLoading: remoteLoading || requestedProjectLoading,
    remoteLoadedScope,
    remoteProjects: effectiveRemoteProjects,
  };
}
