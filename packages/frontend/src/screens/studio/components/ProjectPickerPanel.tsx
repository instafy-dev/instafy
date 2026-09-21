import { Field } from "../../../components/Field";
import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { Copy, MoreHoriz, NavArrowRight, Plus, PlusCircle, Search, Settings, WarningTriangle, Xmark } from "iconoir-react";
import { DialogTrigger } from "react-aria-components";
import { useProjects } from "../../../projects/useProjects";
import { useMergedControllerProjects } from "../../../projects/useMergedControllerProjects";
import { useProject } from "../../../projects/useProject";
import { controllerClient } from "../../../sdk/instafy";
import { useStatus } from "../../../status/useStatus";
import { useWorkspaceTabs } from "../../../workspace/WorkspaceTabsProvider";
import { Badge } from "../../../components/Badge";
import { Button, IconButton } from "../../../components/Button";
import { Card } from "../../../components/Card";
import { EntityRow } from "../../../components/EntityRow";
import { Heading } from "../../../components/Heading";
import { Input } from "../../../components/Input";
import { MenuItemContent } from "../../../components/MenuItemContent";
import { Select } from "../../../components/Select";
import { LoadingStatus } from "../../../components/LoadingStatus";
import { Text } from "../../../components/Text";
import { Surface } from "../../../components/Surface";
import { StudioDialogPopover } from "../../../components/aria/StudioPopover";
import { StudioMenu, StudioMenuItem } from "../../../components/aria/StudioMenu";
import { useRuntime } from "../../../runtime/useRuntime";
import { writeClipboardText } from "../../../runtime/runtimeMenuShared";
import { getOrgDisplayName } from "../../../org/orgNaming";
import { isUUID } from "../../../utils/uuid";
import { useWorkspaceControls } from "../workspaceControls";
import { dispatchOpenBugReport } from "./bugReportEvents";
import { useStudioDesktopLayout } from "../useStudioDesktopLayout";
import { useStudioNavigation } from "../../../navigation/useStudioNavigation";

interface ProjectPickerPanelProps {
  onCreateProject: (
    projectName: string,
    org: { orgId?: string | null; orgName?: string | null }
  ) => Promise<void> | void;
  searchTerm: string;
  onSearchTermChange: (value: string) => void;
}

export const PROJECT_PICKER_DEFAULT_VISIBLE_LIMIT = 40;
export const PROJECT_PICKER_SEARCH_VISIBLE_LIMIT = 80;

export function getVisibleProjectPickerProjects<TProject extends { id: string }>({
  activeProjectId,
  projects,
  visibleLimit,
}: {
  activeProjectId: string | null;
  projects: TProject[];
  visibleLimit: number;
}) {
  const limit = Math.max(1, visibleLimit);
  const visibleProjects = projects.slice(0, limit);
  const activeProject =
    activeProjectId && !visibleProjects.some((project) => project.id === activeProjectId)
      ? projects.find((project) => project.id === activeProjectId) ?? null
      : null;
  const resolvedVisibleProjects = activeProject
    ? [
        activeProject,
        ...visibleProjects.filter((project) => project.id !== activeProject.id),
      ].slice(0, limit)
    : visibleProjects;
  return {
    visibleProjects: resolvedVisibleProjects,
    hiddenProjectCount: Math.max(0, projects.length - resolvedVisibleProjects.length),
  };
}

export function filterUnavailableProjectPickerProjects<TProject extends { id: string }>({
  projects,
  unavailableProjectId,
}: {
  projects: TProject[];
  unavailableProjectId: string | null;
}) {
  if (!unavailableProjectId) {
    return projects;
  }
  return projects.filter((project) => project.id !== unavailableProjectId);
}

export function ProjectPickerPanel({ onCreateProject, searchTerm, onSearchTermChange }: ProjectPickerPanelProps) {
  const isLargeScreen = useStudioDesktopLayout();
  const { projectList, activeProjectId, switchProject, createProject } = useProjects();
  const { projectAccessBlocked } = useProject();
  const { openPanelTab } = useWorkspaceTabs();
  const { showStatus } = useStatus();
  const { runtime } = useRuntime();
  const { onOpenProjectSettings } = useWorkspaceControls();
  const controllerProjectMissing = runtime.controllerProjectMissing || projectAccessBlocked;
  const navigate = useNavigate();
  const navigateToDestination = useStudioNavigation();
  const location = useLocation();
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const [newProjectName, setNewProjectName] = useState("");
  const [createPending, setCreatePending] = useState(false);
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [orgFilterKey, setOrgFilterKey] = useState<string>("all");
  const [mobileSearchOpen, setMobileSearchOpen] = useState(() => searchTerm.trim().length > 0);
  const [openRequestedProjectPending, setOpenRequestedProjectPending] = useState(false);
  const requestedProjectId = useMemo(() => {
    try {
      const params = new URLSearchParams(location.search);
      const projectId = params.get("projectId")?.trim() ?? "";
      return isUUID(projectId) ? projectId : null;
    } catch {
      return null;
    }
  }, [location.search]);

  const activeProject = useMemo(
    () => projectList.find((project) => project.id === activeProjectId) ?? null,
    [activeProjectId, projectList]
  );
  const activeOrgId = activeProject?.orgId ?? null;
  const activeOrgName = getOrgDisplayName(activeProject?.orgName);
  const showAllOrgs = controllerClient.core.enabled && !activeOrgId;
  const { mergedProjects, remoteLoading, remoteError, remoteRefreshing, retryRemoteProjects } = useMergedControllerProjects({
    localProjects: projectList,
    orgId: activeOrgId,
    includeAllOrgs: showAllOrgs,
    requestedProjectId,
  });

  const availableOrgOptions = useMemo(() => {
    const byId = new Map<string, string>();
    for (const project of mergedProjects) {
      if (!project.orgId) {
        continue;
      }
      if (!byId.has(project.orgId)) {
        byId.set(project.orgId, getOrgDisplayName(project.orgName));
      }
    }
    return Array.from(byId.entries())
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [mergedProjects]);

  useEffect(() => {
    if (!showAllOrgs) {
      setOrgFilterKey(activeOrgId ?? "all");
      return;
    }
    if (availableOrgOptions.length === 1) {
      setOrgFilterKey(availableOrgOptions[0].id);
      return;
    }
    setOrgFilterKey((current) => {
      if (current === "all") {
        return current;
      }
      return availableOrgOptions.some((org) => org.id === current) ? current : "all";
    });
  }, [activeOrgId, availableOrgOptions, showAllOrgs]);

  useEffect(() => {
    if (isLargeScreen) {
      setMobileSearchOpen(false);
      return;
    }
    if (searchTerm.trim().length > 0) {
      setMobileSearchOpen(true);
    }
  }, [isLargeScreen, searchTerm]);

  useEffect(() => {
    if (isLargeScreen || !mobileSearchOpen) {
      return;
    }
    const frameId = window.requestAnimationFrame(() => {
      searchInputRef.current?.focus();
    });
    return () => window.cancelAnimationFrame(frameId);
  }, [isLargeScreen, mobileSearchOpen]);

  const selectableProjects = useMemo(
    () =>
      filterUnavailableProjectPickerProjects({
        projects: mergedProjects,
        unavailableProjectId: controllerProjectMissing ? requestedProjectId : null,
      }),
    [controllerProjectMissing, mergedProjects, requestedProjectId],
  );

  const filteredProjects = useMemo(() => {
    const scope = activeOrgId
      ? selectableProjects.filter((project) => project.orgId === activeOrgId)
      : showAllOrgs
        ? orgFilterKey === "all"
          ? selectableProjects
          : selectableProjects.filter((project) => project.orgId === orgFilterKey)
        : selectableProjects.filter((project) => !project.orgId);
    const trimmed = searchTerm.trim().toLowerCase();
    if (!trimmed) {
      return scope;
    }
    return scope.filter((project) => {
      return (
        project.name.toLowerCase().includes(trimmed) ||
        project.id.toLowerCase().includes(trimmed)
      );
    });
  }, [activeOrgId, orgFilterKey, searchTerm, selectableProjects, showAllOrgs]);
  const trimmedSearchTerm = searchTerm.trim();
  const projectVisibleLimit =
    trimmedSearchTerm.length > 0
      ? PROJECT_PICKER_SEARCH_VISIBLE_LIMIT
      : PROJECT_PICKER_DEFAULT_VISIBLE_LIMIT;
  const { visibleProjects, hiddenProjectCount } = useMemo(
    () =>
      getVisibleProjectPickerProjects({
        activeProjectId: controllerProjectMissing ? null : activeProjectId,
        projects: filteredProjects,
        visibleLimit: projectVisibleLimit,
      }),
    [activeProjectId, controllerProjectMissing, filteredProjects, projectVisibleLimit],
  );

  const selectedOrgLabel = useMemo(() => {
    if (!showAllOrgs) {
      return activeOrgName;
    }
    if (orgFilterKey === "all") {
      return "All teams";
    }
    const match = availableOrgOptions.find((org) => org.id === orgFilterKey);
    return match?.name ?? "All teams";
  }, [activeOrgName, availableOrgOptions, orgFilterKey, showAllOrgs]);

  const syncProjectQueryParam = useCallback(
    (projectId: string) => {
      if (!projectId) {
        return;
      }
      try {
        const params = new URLSearchParams(location.search);
        params.set("projectId", projectId);
        // Switching projects invalidates previous conversation context.
        params.delete("conversationId");
        params.delete("conversationControllerId");
        // Keep the UI on chat; avoid stale panel query forcing the picker back open.
        params.delete("panel");
        const search = params.toString();
        navigate(
          {
            pathname: location.pathname,
            search: search.length > 0 ? `?${search}` : ""
          },
          { replace: true }
        );
      } catch (_error) {
        // ignore malformed URLs
      }
    },
    [location.pathname, location.search, navigate]
  );

  const handleSelectProject = useCallback(
    (projectId: string) => {
      if (!projectId) {
        return;
      }
      // Selecting a row leaves a real overview visit to return to. URL-driven
      // access hydration owns local creation, even for a newly discovered space.
      navigateToDestination({ kind: "conversation", projectId });
    },
    [navigateToDestination],
  );

  const handleOpenProjectSettingsFor = useCallback(
    (projectId: string) => {
      if (!projectId) {
        return;
      }
      syncProjectQueryParam(projectId);
      if (!projectList.some((project) => project.id === projectId)) {
        const project = mergedProjects.find((entry) => entry.id === projectId);
        createProject({
          projectId,
          projectName: project?.name ?? "Untitled space",
          orgId: project?.orgId ?? null,
          orgName: getOrgDisplayName(project?.orgName),
        });
      }
      switchProject(projectId);
      onOpenProjectSettings?.();
    },
    [createProject, mergedProjects, onOpenProjectSettings, projectList, switchProject, syncProjectQueryParam],
  );

  const handleOpenRequestedProject = useCallback(async () => {
    if (!requestedProjectId || openRequestedProjectPending) {
      return;
    }
    const existingProject = mergedProjects.find((project) => project.id === requestedProjectId);
    if (existingProject) {
      handleSelectProject(requestedProjectId);
      return;
    }
    setOpenRequestedProjectPending(true);
    try {
      const result = await controllerClient.projects.getSummaryResult(requestedProjectId);
      if (result.summary) {
        createProject({
          projectId: requestedProjectId,
          projectName:
            result.summary.projectName?.trim() || `Space ${requestedProjectId.slice(0, 8)}`,
          orgId: result.summary.orgId ?? null,
          orgName: getOrgDisplayName(result.summary.orgName),
        });
        // Same contract as selecting a row: the URL owns project identity, so
        // access hydration and the routing sync follow this switch too.
        handleSelectProject(requestedProjectId);
        return;
      }
      if (result.forbidden) {
        showStatus("This account no longer has access to that space.", "warning", 3500);
        return;
      }
      if (result.notFound) {
        showStatus("That space is no longer available.", "warning", 3500);
        return;
      }
      if (result.unauthorized) {
        showStatus("Sign in again to open that space.", "warning", 3500);
        return;
      }
      showStatus("Unable to open the requested space right now.", "error", 3500);
    } finally {
      setOpenRequestedProjectPending(false);
    }
  }, [
    createProject,
    handleSelectProject,
    mergedProjects,
    openRequestedProjectPending,
    requestedProjectId,
    showStatus,
  ]);

  const handleProjectMenuAction = useCallback(
    async (projectId: string, action: string) => {
      if (!projectId) {
        return;
      }
      if (action === "copy-id") {
        try {
          await writeClipboardText(projectId);
          showStatus("Space ID copied.", "success", 2200, { presentation: "confirmation" });
        } catch {
          showStatus("Unable to copy space ID.", "error", 3000);
        }
        return;
      }
      if (action === "settings") {
        handleOpenProjectSettingsFor(projectId);
      }
    },
    [handleOpenProjectSettingsFor, showStatus],
  );

  const handleCreateProject = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmedName = newProjectName.trim();
    if (!trimmedName) {
      showStatus("Enter a space name to continue.", "warning", 3000);
      return;
    }
    setCreatePending(true);
    try {
      await onCreateProject(trimmedName, {
        orgId: activeOrgId,
        orgName: activeOrgName
      });
      setNewProjectName("");
      onSearchTermChange("");
      setCreateDialogOpen(false);
      openPanelTab("chat");
    } catch {
      // status is surfaced by the caller
    } finally {
      setCreatePending(false);
    }
  };

  const handleToggleMobileSearch = useCallback(() => {
    if (mobileSearchOpen) {
      if (searchTerm.trim().length > 0) {
        onSearchTermChange("");
      }
      setMobileSearchOpen(false);
      return;
    }
    setMobileSearchOpen(true);
  }, [mobileSearchOpen, onSearchTermChange, searchTerm]);

  return (
    <div className="flex h-full flex-col gap-3 px-3 py-3 sm:px-4">
      {isLargeScreen ? (
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div className="min-w-0">
            <Text variant="overline" tone="subtle">
              Spaces
            </Text>
            <Heading level={2}>{selectedOrgLabel}</Heading>
          </div>
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2 md:justify-end">
            {showAllOrgs ? (
              <Select
                value={orgFilterKey}
                onChange={(event) => setOrgFilterKey(event.target.value)}
                size="sm"
                radius="full"
                className="w-full sm:w-56 md:shrink-0"
                selectClassName="text-sm"
                data-testid="project-picker-org-filter"
                aria-label="Filter spaces by team"
              >
                <option value="all">All teams</option>
                {availableOrgOptions.map((org) => (
                  <option key={org.id} value={org.id}>
                    {org.name}
                  </option>
                ))}
              </Select>
            ) : null}
            <div className="relative min-w-0 flex-1 md:max-w-md">
              <Search
                className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400"
                aria-hidden="true"
              />
              <Input
                ref={searchInputRef}
                value={searchTerm}
                onChange={(event) => onSearchTermChange(event.target.value)}
                placeholder="Search spaces"
                radius="full"
                className="pl-9"
                data-testid="project-picker-search"
              />
            </div>
            <Button
              onPress={() => setCreateDialogOpen(true)}
              variant="outline"
              size="sm"
              radius="full"
              data-testid="project-picker-new-project"
              className="w-full shrink-0 justify-center whitespace-nowrap sm:w-auto"
            >
              <PlusCircle className="h-4 w-4" aria-hidden="true" />
              New space
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-2.5">
          <div className="flex items-center justify-between gap-3">
            <Heading level={2} className="min-w-0 flex-1 truncate leading-tight">
              {selectedOrgLabel}
            </Heading>
            <div className="flex shrink-0 items-center gap-1">
              <IconButton
                onPress={handleToggleMobileSearch}
                variant={mobileSearchOpen ? "secondary" : "ghost"}
                size="md"
                radius="full"
                aria-label={mobileSearchOpen ? "Close search" : "Search spaces"}
                data-testid="project-picker-search-toggle"
                className={[
                  "h-10 w-10 rounded-full shadow-none",
                  mobileSearchOpen
                    ? "bg-slate-100 text-slate-900 dark:bg-slate-900 dark:text-slate-100"
                    : "bg-transparent",
                ].join(" ")}
              >
                {mobileSearchOpen ? (
                  <Xmark className="h-5 w-5" aria-hidden="true" />
                ) : (
                  <Search className="h-5 w-5" aria-hidden="true" />
                )}
              </IconButton>
              <IconButton
                onPress={() => setCreateDialogOpen(true)}
                variant="ghost"
                size="md"
                radius="full"
                data-testid="project-picker-new-project"
                aria-label="Create a new space"
                className="h-10 w-10 rounded-full bg-transparent shadow-none"
              >
                <Plus className="h-5 w-5" aria-hidden="true" />
              </IconButton>
            </div>
          </div>
          {showAllOrgs ? (
            <Select
              // The phone-width twin of the filter above. On a touch device the
              // operating system's own wheel picker is the right control, and
              // this ships as a Capacitor app, so this one stays native.
              native
              value={orgFilterKey}
              onChange={(event) => setOrgFilterKey(event.target.value)}
              size="sm"
              radius="full"
              className="w-full"
              selectClassName="text-sm"
              data-testid="project-picker-org-filter"
              aria-label="Filter spaces by team"
            >
              <option value="all">All teams</option>
              {availableOrgOptions.map((org) => (
                <option key={org.id} value={org.id}>
                  {org.name}
                </option>
              ))}
            </Select>
          ) : null}
          {mobileSearchOpen ? (
            <div className="relative min-w-0">
              <Search
                className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400"
                aria-hidden="true"
              />
              <Input
                ref={searchInputRef}
                value={searchTerm}
                onChange={(event) => onSearchTermChange(event.target.value)}
                placeholder="Search spaces"
                size="md"
                radius="full"
                className="pl-10"
                data-testid="project-picker-search"
              />
            </div>
          ) : null}
        </div>
      )}

      {controllerProjectMissing ? (
        <Card
          tone="warning"
          radius="2xl"
          shadow="none"
          padding="sm"
          className="space-y-3"
          data-testid="project-missing-blocker"
        >
          <div className="flex flex-wrap items-start gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-2xl border border-secondary-200 bg-secondary-50 text-secondary-700">
              <WarningTriangle className="h-5 w-5" aria-hidden="true" />
            </span>
            <div className="min-w-0 flex-1">
              <Heading level={3}>Space not found</Heading>
              <Text variant="body" tone="warning" className="mt-1">
                This space may be gone, the link may be stale, or this account no longer has access.
              </Text>
              {requestedProjectId ? (
                <Text variant="caption" tone="muted" className="mt-1 block truncate text-xxs">
                  Requested: {requestedProjectId.slice(0, 8)}…
                </Text>
              ) : null}
              <Text variant="caption" tone="muted" className="mt-2 block">
                Pick another space below, or report a bug if this should still open.
              </Text>
              <div className="mt-3 flex flex-wrap gap-2">
                {requestedProjectId ? (
                  <Button
                    onPress={() => {
                      void handleOpenRequestedProject();
                    }}
                    variant="primary"
                    size="sm"
                    radius="full"
                    isDisabled={openRequestedProjectPending}
                    data-testid="project-missing-open-requested"
                  >
                    {openRequestedProjectPending ? "Opening requested space…" : "Open requested space"}
                  </Button>
                ) : null}
                <Button
                  onPress={() =>
                    dispatchOpenBugReport({
                      message: "This space should open, but Studio says it is unavailable.",
                      details: requestedProjectId
                        ? `Requested project id: ${requestedProjectId}`
                        : undefined,
                      projectId: requestedProjectId ?? null,
                    })
                  }
                  variant="outline"
                  size="sm"
                  radius="full"
                  data-testid="project-missing-report-bug"
                >
                  Report issue
                </Button>
              </div>
            </div>
          </div>
        </Card>
      ) : null}

      <div className="flex flex-col gap-2 sm:gap-2.5">
        {remoteError ? (
          <Card tone="default" radius="2xl" shadow="none" padding="sm"
            className="flex flex-wrap items-center justify-between gap-2 text-sm text-slate-600"
            data-testid="project-picker-discovery-error">
            <p role="status">{remoteError}</p>
            <Button variant="outline" size="xs" onPress={retryRemoteProjects}
              isDisabled={remoteRefreshing} data-testid="project-picker-discovery-retry">
              {remoteRefreshing ? "Retrying…" : "Retry"}
            </Button>
          </Card>
        ) : null}
        {filteredProjects.length === 0 ? (
          <Card
            tone="default"
            radius="2xl"
            shadow="none"
            padding="sm"
            className="py-3 text-sm text-slate-500"
          >
            {remoteLoading ? (
              <LoadingStatus size="xs">
                Loading spaces…
              </LoadingStatus>
            ) : remoteError ? (
              "Spaces will appear when the connection recovers."
            ) : (
              "No spaces found yet."
            )}
          </Card>
        ) : (
          visibleProjects.map((project) => {
            const isActive = !controllerProjectMissing && project.id === activeProjectId;
            const shortId = `${project.id.slice(0, 8)}…`;
            const secondary = showAllOrgs ? `${project.orgName} · ${shortId}` : shortId;
            return (
              <EntityRow
                key={project.id}
                title={project.name}
                titleEnd={
                  isActive ? (
                    <Badge size="xs" className="shrink-0 border-primary-200 bg-primary-100 text-primary-700">
                      Active
                    </Badge>
                  ) : null
                }
                subtitle={secondary}
                pressable
                selected={isActive}
                density={isLargeScreen ? "compact" : "dense"}
                className="w-full"
                titleClassName="leading-snug"
                subtitleClassName="truncate text-xxs sm:text-xs"
                end={
                  <NavArrowRight
                    className="h-4 w-4 text-slate-400 dark:text-slate-500"
                    aria-hidden="true"
                  />
                }
                onPress={() => handleSelectProject(project.id)}
                data-testid={`project-picker-card-${project.id}`}
                trailingAction={
                  <DialogTrigger>
                    <IconButton
                      variant="ghost"
                      size="xs"
                      radius="full"
                      aria-label="Space actions"
                      className="h-8 w-8 text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100"
                      data-testid={`project-picker-card-menu-button-${project.id}`}
                    >
                      <MoreHoriz className="h-4 w-4" aria-hidden="true" />
                    </IconButton>
                    <StudioDialogPopover
                      placement="bottom end"
                      offset={6}
                      className="w-48 p-1.5"
                      data-testid={`project-picker-card-menu-${project.id}`}
                    >
                      <StudioMenu
                        aria-label={`Space ${project.name} actions`}
                        onAction={(key) => {
                          void handleProjectMenuAction(project.id, String(key));
                        }}
                      >
                        <StudioMenuItem id="copy-id">
                          <MenuItemContent start={<Copy className="h-4 w-4" aria-hidden="true" />}>
                            Copy space ID
                          </MenuItemContent>
                        </StudioMenuItem>
                        <StudioMenuItem id="settings">
                          <MenuItemContent start={<Settings className="h-4 w-4" aria-hidden="true" />}>
                            Settings
                          </MenuItemContent>
                        </StudioMenuItem>
                      </StudioMenu>
                    </StudioDialogPopover>
                  </DialogTrigger>
                }
              />
            );
          })
        )}
        {hiddenProjectCount > 0 ? (
          <Card
            tone="default"
            radius="2xl"
            shadow="none"
            padding="sm"
            className="py-3 text-sm text-slate-500"
            data-testid="project-picker-list-truncated"
          >
            Showing {visibleProjects.length} of {filteredProjects.length} spaces.{" "}
            {trimmedSearchTerm.length > 0
              ? "Refine the search to narrow the results."
              : "Use search to find older spaces."}
          </Card>
        ) : null}
      </div>

      {createDialogOpen ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 pb-[max(var(--instafy-safe-area-inset-bottom),2rem)] pl-[max(var(--instafy-safe-area-inset-left),1rem)] pr-[max(var(--instafy-safe-area-inset-right),1rem)] pt-[max(var(--instafy-safe-area-inset-top),2rem)]"
          onPointerDown={(event) => {
            if (event.target === event.currentTarget) {
              setCreateDialogOpen(false);
            }
          }}
        >
          <Surface
            tone="default"
            radius="3xl"
            shadow="lg"
            className="w-full max-w-md p-4"
            onPointerDown={(event) => event.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <Text variant="overline" tone="subtle">
                  New space
                </Text>
                <Heading level={2}>Create a space</Heading>
              </div>
              <Button
                onPress={() => setCreateDialogOpen(false)}
                variant="ghost"
                size="xs"
                radius="full"
                data-testid="project-picker-create-close"
              >
                Close
              </Button>
            </div>
            <form onSubmit={handleCreateProject} className="mt-4 space-y-3">
              <Field label="Space name" htmlFor="project-picker-new-space-name">
              <Input id="project-picker-new-space-name"
                value={newProjectName}
                onChange={(event) => setNewProjectName(event.target.value)}
                aria-label="Space name"
                disabled={createPending}
                data-testid="project-picker-new-project-name"
              />
              </Field>
              <div className="flex justify-end gap-2">
                <Button
                  onPress={() => setCreateDialogOpen(false)}
                  type="button"
                  variant="outline"
                  size="sm"
                  radius="xl"
                >
                  Cancel
                </Button>
                <Button
                  type="submit"
                  isDisabled={createPending || newProjectName.trim().length === 0}
                  variant="primary"
                  size="sm"
                  radius="xl"
                  data-testid="project-picker-create-project"
                >
                  {createPending ? "Creating…" : "Create"}
                </Button>
              </div>
            </form>
          </Surface>
        </div>
      ) : null}
    </div>
  );
}
