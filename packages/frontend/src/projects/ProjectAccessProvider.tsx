import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useLocation } from "react-router-dom";
import { hasSupabaseConfig } from "../lib/supabaseClient";
import { controllerClient } from "../sdk/instafy";
import { useWorkspaceStore } from "../store";
import { isUUID } from "../utils/uuid";
import { useProjectState } from "./ProjectStateProvider";
import { useAuth } from "../providers/AuthProvider";
import { clearProjectState } from "../workspace/projectClear";
import { getOrgDisplayName } from "../org/orgNaming";
import {
  clearPendingProjectSwitch,
  readPendingProjectSwitch,
} from "../screens/pendingProjectSwitch";
import {
  clearProjectAutoCreateSuppression,
  isProjectAutoCreateSuppressed,
} from "./projectAutoCreate";
import { recordProjectOpened } from "./projectRecency";
import {
  ownerProjectCapabilities,
  resolveProjectCapabilities,
  type EffectiveProjectRole,
  type ProjectCapabilities,
} from "./projectCapabilities";
import {
  PROJECT_ACCESS_REFRESH_EVENT,
  type ProjectAccessRefreshEventDetail,
} from "./projectAccessEvents";

export { PROJECT_ACCESS_REFRESH_EVENT } from "./projectAccessEvents";

const LAST_PROJECT_STORAGE_KEY = "instafy.lastProjectId";
const PROJECT_SUMMARY_RETRY_BACKOFF_MS = 5_000;
const PROJECT_CAPABILITY_REFRESH_INTERVAL_MS = 60_000;

export interface ProjectAccessContextValue {
  projectInitialized: boolean;
  projectAccessPending: boolean;
  projectAccessBlocked: boolean;
  projectAccessUnavailable: boolean;
  projectCapabilitiesResolved: boolean;
  effectiveProjectRole: EffectiveProjectRole | null;
  canWriteProject: boolean;
  canShareProject: boolean;
  canManageProject: boolean;
}

const ProjectAccessContext = createContext<ProjectAccessContextValue | null>(null);

/**
 * A device that remembers nothing is not a new account. Before a space is
 * minted, the controller is asked which ones this account already has, and
 * the first live one is opened; minting is for an account with none. Found on
 * the first sign-in from a second device, which opened a fresh "Untitled
 * Space" instead of the one with the work in it. A list that fails or is
 * unsupported reads as "none", which is what happened before.
 */
async function findExistingProjectId(
  listProjects: typeof controllerClient.projects.listResult,
  signal: AbortSignal,
  exclude: string | null = null,
): Promise<string | null> {
  try {
    const result = await listProjects({ signal });
    if (result.status !== "success") {
      return null;
    }
    const live = result.projects.find(
      (project) =>
        isUUID(project.projectId) &&
        project.projectId !== exclude &&
        project.projectType !== "sandbox" &&
        project.status !== "archived",
    );
    return live?.projectId ?? null;
  } catch {
    return null;
  }
}

function readStoredProjectId(): string | null {
  try {
    if (typeof window === "undefined" || !window.localStorage) {
      return null;
    }
    const value = window.localStorage.getItem(LAST_PROJECT_STORAGE_KEY);
    return value && isUUID(value) ? value : null;
  } catch {
    return null;
  }
}

function writeStoredProjectId(projectId: string | null | undefined) {
  try {
    if (typeof window === "undefined" || !window.localStorage) {
      return;
    }
    if (projectId && isUUID(projectId)) {
      window.localStorage.setItem(LAST_PROJECT_STORAGE_KEY, projectId);
    } else {
      window.localStorage.removeItem(LAST_PROJECT_STORAGE_KEY);
    }
  } catch {
    // ignore storage failures
  }
}

function syncProjectIdQueryParam(
  projectId: string | null | undefined,
  options?: { clearConversation?: boolean }
) {
  if (!projectId || !isUUID(projectId)) {
    return;
  }
  try {
    if (typeof window === "undefined") {
      return;
    }
    const url = new URL(window.location.href);
    let changed = false;
    if (url.searchParams.get("projectId") !== projectId) {
      url.searchParams.set("projectId", projectId);
      changed = true;
    }
    if (options?.clearConversation) {
      if (url.searchParams.has("conversationId")) {
        url.searchParams.delete("conversationId");
        changed = true;
      }
      if (url.searchParams.has("conversationControllerId")) {
        url.searchParams.delete("conversationControllerId");
        changed = true;
      }
      if (url.searchParams.has("panel")) {
        url.searchParams.delete("panel");
        changed = true;
      }
    }
    if (!changed) {
      return;
    }
    const search = url.searchParams.toString();
    const next = `${url.pathname}${search ? `?${search}` : ""}${url.hash}`;
    window.history.replaceState(window.history.state, document.title, next);
  } catch {
    // ignore navigation failures (e.g., malformed URLs)
  }
}

export function ProjectAccessProvider({ children }: { children: ReactNode }) {
  const {
    create: createControllerProject,
    getSummaryResult: getControllerProjectSummaryResult,
    listResult: listControllerProjectsResult,
  } = controllerClient.projects;
  const {
    projects,
    activeProjectId,
    createProject,
    switchProject,
    setProjectOrg,
    setProjectName,
    removeProject,
  } = useProjectState();
  const { user } = useAuth();
  const location = useLocation();
  const [projectInitialized, setProjectInitialized] = useState(false);
  const [projectAccessPending, setProjectAccessPending] = useState(false);
  const [projectAccessBlocked, setProjectAccessBlocked] = useState(false);
  const [projectAccessUnavailable, setProjectAccessUnavailable] = useState(false);
  const [projectCapabilities, setProjectCapabilities] = useState<{
    projectId: string;
    value: ProjectCapabilities;
  } | null>(null);
  const projectsRef = useRef(projects);
  const projectAccessPendingRef = useRef(projectAccessPending);
  const lastUrlProjectIdRef = useRef<string | null>(null);
  const lastResolvedProjectIdRef = useRef<string | null>(null);
  const blockedProjectIdRef = useRef<string | null>(null);
  const projectSummaryRetryBackoffRef = useRef<{ projectId: string; until: number } | null>(null);
  const activeRequestRef = useRef<symbol | null>(null);
  const orgHydrationRef = useRef<{ key: string; token: symbol } | null>(null);
  const storedProjectIdRef = useRef<string | null>(null);
  const lastUserIdRef = useRef<string | null>(user?.id ?? null);

  useEffect(() => {
    projectsRef.current = projects;
  }, [projects]);

  useEffect(() => {
    // The account-reset effect below clears old workspace state. Do not copy
    // its active space into a newly signed-in account before that reset runs.
    if (lastUserIdRef.current !== (user?.id ?? null) || (hasSupabaseConfig && !projectInitialized)) return;
    if (activeProjectId && isUUID(activeProjectId)) {
      recordProjectOpened(activeProjectId, undefined, user?.email ?? null);
    }
  }, [activeProjectId, projectInitialized, user?.email, user?.id]);

  useEffect(() => {
    projectAccessPendingRef.current = projectAccessPending;
  }, [projectAccessPending]);

  useEffect(() => {
    if (storedProjectIdRef.current !== null) {
      return;
    }
    storedProjectIdRef.current = readStoredProjectId();
  }, []);

  useEffect(() => {
    const normalizedUserId = user?.id ?? null;
    const previousUserId = lastUserIdRef.current;
    if (normalizedUserId === previousUserId) {
      return;
    }
    lastUserIdRef.current = normalizedUserId;
    if (previousUserId && normalizedUserId !== previousUserId) {
      clearProjectState();
      storedProjectIdRef.current = null;
      lastResolvedProjectIdRef.current = null;
      lastUrlProjectIdRef.current = null;
      activeRequestRef.current = null;
      projectSummaryRetryBackoffRef.current = null;
      writeStoredProjectId(null);
      clearProjectAutoCreateSuppression();
      setProjectAccessBlocked(false);
      setProjectAccessUnavailable(false);
      setProjectAccessPending(false);
      setProjectCapabilities(null);
      setProjectInitialized(false);
    }
  }, [user?.id]);

  useEffect(() => {
    if (!hasSupabaseConfig) {
      if (!projectInitialized) {
        setProjectInitialized(true);
      }
      setProjectAccessPending(false);
      setProjectAccessBlocked(false);
      setProjectAccessUnavailable(false);
      if (activeProjectId) {
        setProjectCapabilities((current) =>
          current?.projectId === activeProjectId
            ? current
            : { projectId: activeProjectId, value: ownerProjectCapabilities() },
        );
      }
      return;
    }

    let urlProjectId: string | null = null;
    try {
      const params = new URLSearchParams(location.search);
      const fromUrl = params.get("projectId");
      if (fromUrl && isUUID(fromUrl.trim())) {
        urlProjectId = fromUrl.trim();
      }
    } catch {
      // ignore malformed URLs
    }

    const pending = readPendingProjectSwitch();
    if (pending && urlProjectId && pending.projectId === urlProjectId) {
      clearPendingProjectSwitch();
    } else if (
      pending &&
      urlProjectId &&
      pending.projectId === activeProjectId &&
      urlProjectId !== activeProjectId &&
      typeof pending.at === "number" &&
      Date.now() - pending.at < 1500
    ) {
      clearPendingProjectSwitch();
    }

    if (
      projectInitialized &&
      !projectAccessPendingRef.current &&
      urlProjectId === lastUrlProjectIdRef.current
    ) {
      return;
    }
    if (projectInitialized && urlProjectId && blockedProjectIdRef.current === urlProjectId) {
      setProjectAccessPending(false);
      setProjectAccessBlocked(true);
      return;
    }
    const retryBackoff = projectSummaryRetryBackoffRef.current;
    if (
      urlProjectId &&
      retryBackoff?.projectId === urlProjectId &&
      retryBackoff.until > Date.now()
    ) {
      setProjectAccessPending(false);
      return;
    }

    if (urlProjectId) {
      setProjectCapabilities((current) =>
        current?.projectId === urlProjectId ? current : null,
      );
      setProjectAccessBlocked(false);
      const existing = projectsRef.current[urlProjectId];
      if (!existing) {
        createProject({
          projectId: urlProjectId,
        });
      } else if (activeProjectId !== urlProjectId) {
        switchProject(urlProjectId);
      }
      lastUrlProjectIdRef.current = urlProjectId;
      if (typeof window !== "undefined") {
        const runtimeWindow = window as typeof window & {
          __INSTAFY_ACTIVE_PROJECT_ID__?: string | null;
          __INSTAFY_PROJECT_INITIALIZED__?: boolean;
        };
        runtimeWindow.__INSTAFY_ACTIVE_PROJECT_ID__ = urlProjectId;
        runtimeWindow.__INSTAFY_PROJECT_INITIALIZED__ = false;
      }
    }

    let cancelled = false;
    const abortController = new AbortController();
    const requestId = Symbol("project-bootstrap");
    activeRequestRef.current = requestId;

    const selectRecoveryProject = (projectId: string) => {
      // A remembered UUID can outlive the user-scoped workspace snapshot. Keep
      // its local identity available for Retry without granting access or
      // creating a replacement project on the controller.
      if (!projectsRef.current[projectId]) {
        createProject({ projectId });
      } else if (activeProjectId !== projectId) {
        switchProject(projectId);
      }
      if (typeof window !== "undefined") {
        (window as Window & { __INSTAFY_ACTIVE_PROJECT_ID__?: string }).__INSTAFY_ACTIVE_PROJECT_ID__ = projectId;
      }
    };

    const resolveProject = async () => {
      let targetProjectIdForBackoff: string | null = urlProjectId;
      setProjectAccessPending(true);
      setProjectAccessBlocked(false);
      setProjectAccessUnavailable(false);
      try {
        let mintedProject: Awaited<ReturnType<typeof createControllerProject>> | null = null;
        let targetProjectId: string | null =
          urlProjectId ??
          lastResolvedProjectIdRef.current ??
          storedProjectIdRef.current ??
          (activeProjectId || null);

        if (!targetProjectId || !isUUID(targetProjectId)) {
          if (isProjectAutoCreateSuppressed()) {
            storedProjectIdRef.current = null;
            lastResolvedProjectIdRef.current = null;
            lastUrlProjectIdRef.current = urlProjectId;
            writeStoredProjectId(null);
            projectSummaryRetryBackoffRef.current = null;
            setProjectAccessPending(false);
            if (typeof window !== "undefined") {
              const runtimeWindow = window as typeof window & {
                __INSTAFY_ACTIVE_PROJECT_ID__?: string | null;
                __INSTAFY_PROJECT_INITIALIZED__?: boolean;
              };
              runtimeWindow.__INSTAFY_ACTIVE_PROJECT_ID__ = null;
              runtimeWindow.__INSTAFY_PROJECT_INITIALIZED__ = true;
            }
            setProjectInitialized(true);
            return;
          }
          const existingProjectId = await findExistingProjectId(
            listControllerProjectsResult,
            abortController.signal,
          );
          if (cancelled || activeRequestRef.current !== requestId) {
            return;
          }
          if (existingProjectId) {
            targetProjectId = existingProjectId;
          } else {
            mintedProject = await createControllerProject({
              projectType: "customer",
            });
            if (cancelled || activeRequestRef.current !== requestId) {
              return;
            }
            targetProjectId = mintedProject?.projectId ?? null;
          }
        }

        targetProjectIdForBackoff = targetProjectId;

        if (!targetProjectId || !isUUID(targetProjectId)) {
          throw new Error("Unable to resolve active project id");
        }

        let createdBecauseMissing = false;
        let projectSummaryResult = mintedProject
          ? { summary: null, notFound: false, forbidden: false, unauthorized: false }
          : await getControllerProjectSummaryResult(targetProjectId, { signal: abortController.signal });

        if (cancelled || activeRequestRef.current !== requestId) {
          return;
        }

        const projectBlocked =
          !mintedProject &&
          !projectSummaryResult.summary &&
          (projectSummaryResult.notFound ||
            projectSummaryResult.forbidden ||
            projectSummaryResult.unauthorized);
        if (projectBlocked && !urlProjectId) {
          blockedProjectIdRef.current = null;
          removeProject(targetProjectId);
          storedProjectIdRef.current = null;
          lastResolvedProjectIdRef.current = null;
          writeStoredProjectId(null);
          if (isProjectAutoCreateSuppressed()) {
            setProjectInitialized(true);
            return;
          }
          // The remembered space is gone or closed to this account; another
          // of its spaces comes before a new one.
          const fallbackProjectId = await findExistingProjectId(
            listControllerProjectsResult,
            abortController.signal,
            targetProjectId,
          );
          if (cancelled || activeRequestRef.current !== requestId) {
            return;
          }
          if (fallbackProjectId) {
            targetProjectId = fallbackProjectId;
            projectSummaryResult = await getControllerProjectSummaryResult(targetProjectId, {
              signal: abortController.signal,
            });
            if (cancelled || activeRequestRef.current !== requestId) {
              return;
            }
          } else {
            mintedProject = await createControllerProject({
              projectType: "customer",
            });
            if (cancelled || activeRequestRef.current !== requestId) {
              return;
            }
            targetProjectId = mintedProject?.projectId ?? null;
            if (!targetProjectId || !isUUID(targetProjectId)) {
              throw new Error("Unable to resolve active project id");
            }
            projectSummaryResult = { summary: null, notFound: false, forbidden: false, unauthorized: false };
          }
          createdBecauseMissing = true;
        }

        const projectSummary = projectSummaryResult.summary;
        if (cancelled || activeRequestRef.current !== requestId) {
          return;
        }

        const projectSummaryUnavailable =
          !mintedProject &&
          !projectSummary &&
          !projectSummaryResult.notFound &&
          !projectSummaryResult.forbidden &&
          !projectSummaryResult.unauthorized;

        if (projectBlocked && urlProjectId) {
          blockedProjectIdRef.current = targetProjectId;
          projectSummaryRetryBackoffRef.current = null;
          removeProject(targetProjectId);
          if (storedProjectIdRef.current === targetProjectId) {
            storedProjectIdRef.current = null;
            writeStoredProjectId(null);
          }
          if (lastResolvedProjectIdRef.current === targetProjectId) {
            lastResolvedProjectIdRef.current = null;
          }
          setProjectAccessPending(false);
          setProjectAccessBlocked(true);
          setProjectCapabilities(null);
          if (typeof window !== "undefined") {
            const runtimeWindow = window as typeof window & {
              __INSTAFY_PROJECT_INITIALIZED__?: boolean;
            };
            runtimeWindow.__INSTAFY_PROJECT_INITIALIZED__ = true;
          }
          setProjectInitialized(true);
          return;
        }
        if (projectSummaryUnavailable) {
          selectRecoveryProject(targetProjectId);
          setProjectAccessUnavailable(true);
          projectSummaryRetryBackoffRef.current = {
            projectId: targetProjectId,
            until: Date.now() + PROJECT_SUMMARY_RETRY_BACKOFF_MS,
          };
          setProjectAccessPending(false);
          if (typeof window !== "undefined") {
            const runtimeWindow = window as typeof window & {
              __INSTAFY_PROJECT_INITIALIZED__?: boolean;
            };
            runtimeWindow.__INSTAFY_PROJECT_INITIALIZED__ = true;
          }
          setProjectInitialized(true);
          return;
        }
        if (cancelled || activeRequestRef.current !== requestId) {
          return;
        }
        blockedProjectIdRef.current = null;
        projectSummaryRetryBackoffRef.current = null;

        const currentProjects = projectsRef.current;
        const resolvedProjectName =
          mintedProject?.projectName?.trim() ||
          projectSummary?.projectName?.trim() ||
          null;
        clearProjectAutoCreateSuppression();
        setProjectAccessBlocked(false);

        if (currentProjects[targetProjectId]) {
          if (activeProjectId !== targetProjectId) {
            switchProject(targetProjectId);
          }
        } else {
          createProject({
            projectId: targetProjectId,
            projectName: resolvedProjectName ?? undefined,
            orgId: mintedProject?.orgId ?? projectSummary?.orgId ?? null,
            orgName: mintedProject?.orgName ?? projectSummary?.orgName ?? null,
          });
        }

        if (projectSummary) useWorkspaceStore.getState().setProjectIdentity(targetProjectId, projectSummary);
        const resolvedOrgId = mintedProject?.orgId ?? projectSummary?.orgId ?? null;
        const resolvedOrgName = mintedProject?.orgName ?? projectSummary?.orgName ?? null;
        if (resolvedOrgId) {
          setProjectOrg(targetProjectId, {
            id: resolvedOrgId,
            name: getOrgDisplayName(resolvedOrgName),
          });
        }
        if (resolvedProjectName) {
          setProjectName(targetProjectId, resolvedProjectName);
        }

        const resolvedCapabilities = mintedProject
          ? ownerProjectCapabilities()
          : resolveProjectCapabilities(projectSummary, user?.id ?? null);
        if (resolvedCapabilities) {
          setProjectCapabilities({ projectId: targetProjectId, value: resolvedCapabilities });
        } else {
          setProjectCapabilities(null);
        }

        lastResolvedProjectIdRef.current = targetProjectId;
        lastUrlProjectIdRef.current = urlProjectId;
        storedProjectIdRef.current = targetProjectId;
        writeStoredProjectId(targetProjectId);
        syncProjectIdQueryParam(targetProjectId, {
          clearConversation: createdBecauseMissing || Boolean(mintedProject && !urlProjectId),
        });
        if (typeof window !== "undefined") {
          const runtimeWindow = window as typeof window & {
            __INSTAFY_ACTIVE_PROJECT_ID__?: string | null;
            __INSTAFY_PROJECT_INITIALIZED__?: boolean;
          };
          runtimeWindow.__INSTAFY_ACTIVE_PROJECT_ID__ = targetProjectId;
          runtimeWindow.__INSTAFY_PROJECT_INITIALIZED__ = true;
        }
        setProjectAccessPending(false);
        setProjectInitialized(true);
      } catch (error) {
        if (!cancelled && import.meta.env.DEV) {
          console.warn("Failed to resolve runtime project id", error);
        }
        if (!cancelled && activeRequestRef.current === requestId) {
          if (targetProjectIdForBackoff && isUUID(targetProjectIdForBackoff)) {
            selectRecoveryProject(targetProjectIdForBackoff);
            projectSummaryRetryBackoffRef.current = {
              projectId: targetProjectIdForBackoff,
              until: Date.now() + PROJECT_SUMMARY_RETRY_BACKOFF_MS,
            };
          }
          setProjectAccessPending(false);
          setProjectAccessBlocked(false);
          setProjectAccessUnavailable(Boolean(targetProjectIdForBackoff));
          if (typeof window !== "undefined") {
            const runtimeWindow = window as typeof window & {
              __INSTAFY_PROJECT_INITIALIZED__?: boolean;
            };
            runtimeWindow.__INSTAFY_PROJECT_INITIALIZED__ = true;
          }
          setProjectInitialized(true);
        }
      } finally {
        if (activeRequestRef.current === requestId) {
          activeRequestRef.current = null;
        }
      }
    };

    void resolveProject();

    return () => {
      cancelled = true;
      abortController.abort();
    };
  }, [
    activeProjectId,
    createProject,
    createControllerProject,
    getControllerProjectSummaryResult,
    listControllerProjectsResult,
    location.search,
    projectInitialized,
    removeProject,
    setProjectName,
    setProjectOrg,
    switchProject,
    user?.id,
  ]);

  useEffect(() => {
    if (!hasSupabaseConfig) {
      return;
    }
    if (!projectInitialized) {
      return;
    }
    const currentUserId = user?.id ?? "guest";

    let urlProjectId: string | null = null;
    try {
      const params = new URLSearchParams(location.search);
      const fromUrl = params.get("projectId");
      if (fromUrl && isUUID(fromUrl.trim())) {
        urlProjectId = fromUrl.trim();
      }
    } catch {
      // ignore malformed URLs
    }

    const targetProjectId = urlProjectId ?? (activeProjectId && isUUID(activeProjectId) ? activeProjectId : null);
    if (!targetProjectId) {
      return;
    }
    if (blockedProjectIdRef.current === targetProjectId) {
      setProjectAccessBlocked(true);
      return;
    }
    const retryBackoff = projectSummaryRetryBackoffRef.current;
    if (
      retryBackoff?.projectId === targetProjectId &&
      retryBackoff.until > Date.now()
    ) {
      return;
    }

    const currentProject = projectsRef.current[targetProjectId];
    if (!currentProject || currentProject.org?.id) {
      return;
    }

    const key = `${currentUserId}:${targetProjectId}`;
    if (orgHydrationRef.current?.key === key) {
      return;
    }

    const token = Symbol("org-hydration");
    const abortController = new AbortController();
    orgHydrationRef.current = { key, token };

    void (async () => {
      try {
        const result = await getControllerProjectSummaryResult(targetProjectId, { signal: abortController.signal });
        if (orgHydrationRef.current?.token !== token) {
          return;
        }
        if (result.notFound || result.forbidden || result.unauthorized) {
          blockedProjectIdRef.current = targetProjectId;
          setProjectAccessBlocked(true);
          return;
        }
        const summary = result.summary;
        if (!summary) {
          projectSummaryRetryBackoffRef.current = {
            projectId: targetProjectId,
            until: Date.now() + PROJECT_SUMMARY_RETRY_BACKOFF_MS,
          };
          return;
        }
        const resolvedCapabilities = resolveProjectCapabilities(summary, user?.id ?? null);
        if (resolvedCapabilities) {
          setProjectCapabilities({ projectId: targetProjectId, value: resolvedCapabilities });
        }
        useWorkspaceStore.getState().setProjectIdentity(targetProjectId, summary);
        const resolvedName = summary.projectName?.trim() ?? "";
        if (resolvedName) {
          setProjectName(targetProjectId, resolvedName);
        }
        if (!summary.orgId) {
          return;
        }
        blockedProjectIdRef.current = null;
        projectSummaryRetryBackoffRef.current = null;
        setProjectAccessBlocked(false);
        const storeSnapshot = useWorkspaceStore.getState();
        if (!storeSnapshot.projects?.[targetProjectId]) {
          createProject({
            projectId: targetProjectId,
            orgId: summary.orgId,
            orgName: summary.orgName ?? null,
          });
          return;
        }

        setProjectOrg(targetProjectId, {
          id: summary.orgId,
          name: getOrgDisplayName(summary.orgName),
        });
      } catch (error) {
        if (!abortController.signal.aborted && import.meta.env.DEV) {
          console.warn("Failed to hydrate project organization", error);
        }
      } finally {
        if (orgHydrationRef.current?.token === token) {
          orgHydrationRef.current = null;
        }
      }
    })();
    return () => {
      abortController.abort();
      if (orgHydrationRef.current?.token === token) {
        orgHydrationRef.current = null;
      }
    };
  }, [
    activeProjectId,
    createProject,
    getControllerProjectSummaryResult,
    location.search,
    projectInitialized,
    setProjectName,
    setProjectOrg,
    user?.id,
  ]);

  useEffect(() => {
    if (
      !hasSupabaseConfig ||
      !projectInitialized ||
      !activeProjectId ||
      !isUUID(activeProjectId) ||
      !user?.id
    ) {
      return;
    }

    const targetProjectId = activeProjectId;
    let cancelled = false;
    let refreshInFlight = false;
    let refreshRequested = false;
    let accessInvalidationVersion = 0;
    let retryTimer: number | null = null;
    let requestController: AbortController | null = null;

    const scheduleRetry = (delayMs = PROJECT_SUMMARY_RETRY_BACKOFF_MS) => {
      if (retryTimer !== null) {
        window.clearTimeout(retryTimer);
      }
      retryTimer = window.setTimeout(() => {
        retryTimer = null;
        if (document.visibilityState !== "hidden") {
          void refreshCapabilities();
        }
      }, delayMs);
    };

    const refreshCapabilities = async () => {
      if (cancelled) {
        return;
      }
      if (refreshInFlight) {
        refreshRequested = true;
        return;
      }
      if (retryTimer !== null) {
        window.clearTimeout(retryTimer);
        retryTimer = null;
      }
      refreshInFlight = true;
      const abortController = new AbortController();
      requestController = abortController;
      const refreshVersion = accessInvalidationVersion;
      try {
        const result = await getControllerProjectSummaryResult(targetProjectId, { signal: abortController.signal });
        if (cancelled || refreshVersion !== accessInvalidationVersion) {
          return;
        }
        if (result.notFound || result.forbidden || result.unauthorized) {
          blockedProjectIdRef.current = targetProjectId;
          projectSummaryRetryBackoffRef.current = null;
          setProjectAccessUnavailable(false);
          setProjectCapabilities((current) =>
            current?.projectId === targetProjectId ? null : current,
          );
          setProjectAccessBlocked(true);
          removeProject(targetProjectId);
          return;
        }

        if (!result.summary) {
          setProjectAccessUnavailable(true);
          scheduleRetry();
          return;
        }

        useWorkspaceStore.getState().setProjectIdentity(targetProjectId, result.summary);
        const refreshedCapabilities = resolveProjectCapabilities(result.summary, user.id);
        setProjectCapabilities(
          refreshedCapabilities
            ? { projectId: targetProjectId, value: refreshedCapabilities }
            : null,
        );
        if (projectSummaryRetryBackoffRef.current?.projectId === targetProjectId) {
          const projectName = result.summary.projectName?.trim();
          if (projectName) {
            setProjectName(targetProjectId, projectName);
          }
          if (result.summary.orgId) {
            setProjectOrg(targetProjectId, {
              id: result.summary.orgId,
              name: getOrgDisplayName(result.summary.orgName),
            });
          }
        }
        blockedProjectIdRef.current = null;
        projectSummaryRetryBackoffRef.current = null;
        setProjectAccessBlocked(false);
        setProjectAccessUnavailable(false);
      } catch (error) {
        if (!abortController.signal.aborted && import.meta.env.DEV) {
          console.warn("Failed to refresh project access", error);
        }
        if (!cancelled && !abortController.signal.aborted) {
          setProjectAccessUnavailable(true);
          scheduleRetry();
        }
      } finally {
        if (requestController === abortController) requestController = null;
        refreshInFlight = false;
        if (refreshRequested && !cancelled) {
          refreshRequested = false;
          void refreshCapabilities();
        }
      }
    };

    const handleFocus = () => {
      void refreshCapabilities();
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        void refreshCapabilities();
      }
    };
    const handleAccessChanged = (event: Event) => {
      const detail = (event as CustomEvent<ProjectAccessRefreshEventDetail>).detail;
      if (detail?.projectId && detail.projectId !== targetProjectId) {
        return;
      }
      accessInvalidationVersion += 1;
      requestController?.abort();
      setProjectCapabilities((current) =>
        current?.projectId === targetProjectId ? null : current,
      );
      void refreshCapabilities();
    };
    const handleStreamReconnected = () => {
      void refreshCapabilities();
    };
    const intervalId = window.setInterval(() => {
      if (document.visibilityState !== "hidden") {
        void refreshCapabilities();
      }
    }, PROJECT_CAPABILITY_REFRESH_INTERVAL_MS);

    // An unavailable initial lookup releases the full-screen loader without
    // granting capabilities. Recover promptly through this same access check.
    const initialRetry = projectSummaryRetryBackoffRef.current;
    if (initialRetry?.projectId === targetProjectId) {
      scheduleRetry(Math.max(0, initialRetry.until - Date.now()));
    }

    window.addEventListener("focus", handleFocus);
    window.addEventListener(PROJECT_ACCESS_REFRESH_EVENT, handleAccessChanged);
    window.addEventListener("instafy:controller-stream-reconnected", handleStreamReconnected);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      cancelled = true;
      requestController?.abort();
      window.clearInterval(intervalId);
      if (retryTimer !== null) {
        window.clearTimeout(retryTimer);
      }
      window.removeEventListener("focus", handleFocus);
      window.removeEventListener(PROJECT_ACCESS_REFRESH_EVENT, handleAccessChanged);
      window.removeEventListener("instafy:controller-stream-reconnected", handleStreamReconnected);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [
    activeProjectId,
    getControllerProjectSummaryResult,
    projectInitialized,
    removeProject,
    setProjectName,
    setProjectOrg,
    user?.id,
  ]);

  const activeCapabilities =
    activeProjectId && projectCapabilities?.projectId === activeProjectId
      ? projectCapabilities.value
      : null;
  const capabilitiesResolved = !hasSupabaseConfig || activeCapabilities !== null;

  const value = useMemo<ProjectAccessContextValue>(
    () => ({
      projectInitialized,
      projectAccessPending,
      projectAccessBlocked,
      projectAccessUnavailable,
      projectCapabilitiesResolved: capabilitiesResolved,
      effectiveProjectRole: activeCapabilities?.effectiveRole ?? null,
      canWriteProject: activeCapabilities?.canWrite ?? !hasSupabaseConfig,
      canShareProject: activeCapabilities?.canShare ?? !hasSupabaseConfig,
      canManageProject: activeCapabilities?.canManage ?? !hasSupabaseConfig,
    }),
    [activeCapabilities, capabilitiesResolved, projectAccessBlocked, projectAccessUnavailable, projectAccessPending, projectInitialized]
  );

  return <ProjectAccessContext.Provider value={value}>{children}</ProjectAccessContext.Provider>;
}

export function useProjectAccess(): ProjectAccessContextValue {
  const context = useContext(ProjectAccessContext);
  if (!context) {
    throw new Error("useProjectAccess must be used within a ProjectAccessProvider");
  }
  return context;
}

export function useOptionalProjectAccess(): ProjectAccessContextValue | null {
  return useContext(ProjectAccessContext);
}
