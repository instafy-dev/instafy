import { SpaceIdentity } from "../../../components/SpaceIdentity";
import { Plus, Search, Settings } from "iconoir-react";
import { Button, IconButton } from "../../../components/Button";
import { MenuItemContent } from "../../../components/MenuItemContent";
import { SearchInput } from "../../../components/SearchInput";
import { SidebarMenuSection } from "../../../components/SidebarMenuSection";
import { StudioMenu, StudioMenuItem } from "../../../components/aria/StudioMenu";
import { Text } from "../../../components/Text";
import {
  DRAWER_ICON_BUTTON_TONE_CLASS,
  DRAWER_LIST_ROW_TEXT_CLASS,
  PICKER_LIST_ROW_ACTIVE_CLASS,
  PICKER_LIST_ROW_GEOMETRY_CLASS,
  pickerListRowTextClassName,
} from "../../../components/listRowStyles";
import type { MergedProjectListItem } from "../../../projects/useMergedControllerProjects";
import { getOrgInitials } from "../../../org/orgNaming";
import { AttentionBadge } from "../../../components/AttentionBadge";
import { useStudioPerformanceContent } from "../../../telemetry/useStudioPerformanceContent";

const WORKSPACE_SWITCHER_ACTION_BUTTON_CLASS = `h-8 w-8 ${DRAWER_ICON_BUTTON_TONE_CLASS}`;
const WORKSPACE_SWITCHER_ACTION_ICON_CLASS = "h-4 w-4";

export const SIDEBAR_WORKSPACE_SWITCHER_DEFAULT_VISIBLE_LIMIT = 40;
export const SIDEBAR_WORKSPACE_SWITCHER_SEARCH_VISIBLE_LIMIT = 80;

export function getVisibleSidebarWorkspaceProjects<TProject>({
  projects,
  visibleLimit,
}: {
  projects: TProject[];
  visibleLimit: number;
}) {
  const limit = Math.max(1, visibleLimit);
  const visibleProjects = projects.slice(0, limit);
  return {
    visibleProjects,
    hiddenProjectCount: Math.max(0, projects.length - visibleProjects.length),
  };
}

export type SidebarWorkspaceOrgOption = {
  key: string;
  name: string;
  label: string;
  slug: string | null;
  count: number;
  avatarUrl?: string | null;
};

type StudioSidebarWorkspaceSwitcherProps = {
  mode?: "teams-and-spaces" | "spaces";
  orgOptions: SidebarWorkspaceOrgOption[];
  workspaceOrgKey: string;
  activeOrgKey?: string;
  pendingOrgKey?: string | null;
  projectsError?: string | null;
  projectsRefreshing?: boolean;
  onRetryProjects?: () => void;
  onWorkspaceOrgChange: (orgKey: string) => void;
  onOpenOrgSettings?: () => void;
  onCreateOrg?: () => void;
  canSearchSpaces: boolean;
  showProjectSearch: boolean;
  workspaceProjectSearchOpen: boolean;
  workspaceProjectQuery: string;
  onWorkspaceProjectQueryChange: (value: string) => void;
  onToggleProjectSearch: () => void;
  onCreateProject?: () => void;
  currentOrgProject: MergedProjectListItem | null;
  switcherProjects: MergedProjectListItem[];
  onOpenProjectSettings?: () => void;
  onProjectMenuAction: (key: string | number) => void;
  projectAttentionCounts?: Record<string, number>;
  orgAttentionCounts?: Record<string, number>;
};

/**
 * The team & spaces panel — the picker the sidebar's org deck opens. Teams
 * are a short row list (avatar, name, attention), one row per team, with the
 * selected team marked exactly like the current space below; no nested
 * dropdown, no popover inside a popover. Everything below is a single spaces
 * list with the active space as its first, selected row.
 */
export function StudioSidebarWorkspaceSwitcher({
  mode = "teams-and-spaces",
  orgOptions,
  workspaceOrgKey,
  activeOrgKey = workspaceOrgKey,
  pendingOrgKey = null,
  projectsError = null,
  projectsRefreshing = false,
  onRetryProjects,
  onWorkspaceOrgChange,
  onOpenOrgSettings,
  onCreateOrg,
  canSearchSpaces,
  showProjectSearch,
  workspaceProjectSearchOpen,
  workspaceProjectQuery,
  onWorkspaceProjectQueryChange,
  onToggleProjectSearch,
  onCreateProject,
  currentOrgProject,
  switcherProjects,
  onOpenProjectSettings,
  onProjectMenuAction,
  projectAttentionCounts = {},
  orgAttentionCounts = {},
}: StudioSidebarWorkspaceSwitcherProps) {
  useStudioPerformanceContent({
    projectId: null,
    organizationId: pendingOrgKey === "personal" ? null : pendingOrgKey,
    conversationId: null,
    messageCount: 0,
    // Discovery retains an earlier error while Retry is running. Observe the
    // new attempt as loading until its settled result is visible again.
    loading: projectsRefreshing || !projectsError,
    error: Boolean(projectsError) && !projectsRefreshing,
  }, Boolean(pendingOrgKey));
  const trimmedWorkspaceProjectQuery = workspaceProjectQuery.trim();
  const projectVisibleLimit =
    trimmedWorkspaceProjectQuery.length > 0
      ? SIDEBAR_WORKSPACE_SWITCHER_SEARCH_VISIBLE_LIMIT
      : SIDEBAR_WORKSPACE_SWITCHER_DEFAULT_VISIBLE_LIMIT;
  const { visibleProjects, hiddenProjectCount } = getVisibleSidebarWorkspaceProjects({
    projects: switcherProjects,
    visibleLimit: projectVisibleLimit,
  });

  // The Team section always renders: with a single team its row names where
  // you are and its settings entry is the only path to members/invites/leave
  // (invited users land in exactly one team). A single row is not a choice,
  // so it is marked current and never reads as a control.
  const selectedOrgKey =
    orgOptions.some((org) => org.key === workspaceOrgKey)
      ? workspaceOrgKey
      : (orgOptions[0]?.key ?? workspaceOrgKey);
  const totalOrgAttention = Object.values(orgAttentionCounts).reduce(
    (sum, value) => sum + value,
    0,
  );

  const renderTeamRow = (org: SidebarWorkspaceOrgOption) => {
    const isSelected = org.key === selectedOrgKey;
    const isCurrent = org.key === activeOrgKey && org.key !== "all";
    const isPending = org.key === pendingOrgKey && !projectsError;
    const isAll = org.key === "all";
    const attention = isAll ? totalOrgAttention : (orgAttentionCounts[org.key] ?? 0);
    return (
      <button
        key={org.key}
        type="button"
        aria-label={`Show team ${org.label}`}
        aria-pressed={isSelected}
        aria-busy={isPending || undefined}
        data-testid={`sidebar-org-chip-${org.key}`}
        onClick={() => onWorkspaceOrgChange(org.key)}
        className={[
          "flex w-full items-center gap-2.5 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-400/60",
          DRAWER_LIST_ROW_TEXT_CLASS,
          PICKER_LIST_ROW_GEOMETRY_CLASS,
          pickerListRowTextClassName(isSelected),
          isSelected
            ? PICKER_LIST_ROW_ACTIVE_CLASS
            : "hover:bg-slate-100 dark:hover:bg-[var(--color-studio-dark-active)]",
        ].join(" ")}
      >
        <span
          aria-hidden="true"
          className={[
            "flex h-7 w-7 shrink-0 items-center justify-center overflow-hidden rounded-lg text-xxs font-semibold",
            isSelected
              ? "bg-primary-600 text-white dark:bg-primary-500"
              : "bg-slate-200/80 text-slate-600 dark:bg-white/[0.08] dark:text-slate-300",
          ].join(" ")}
        >
          {isAll ? (
            "All"
          ) : org.avatarUrl ? (
            <img
              src={org.avatarUrl}
              alt=""
              aria-hidden="true"
              className="h-full w-full object-cover"
              draggable={false}
            />
          ) : (
            getOrgInitials(org.name)
          )}
        </span>
        <span className="min-w-0 flex-1 truncate">{isAll ? "All teams" : org.label}</span>
        <span className="flex shrink-0 items-center gap-1.5">
          {isCurrent || isSelected ? (
            <span className="text-3xs font-medium uppercase tracking-[0.08em] text-slate-600 dark:text-slate-500">
              {isCurrent ? "Current" : isPending ? "Switching…" : "Selected"}
            </span>
          ) : null}
          <AttentionBadge
            count={attention}
            aria-hidden
            testId={`sidebar-org-attention-${org.key}`}
            className="shrink-0"
          />
        </span>
      </button>
    );
  };

  const renderProjectRow = (project: MergedProjectListItem, options: { current: boolean }) => (
    <StudioMenuItem
      key={`project:${project.id}`}
      id={`project:${project.id}`}
      data-testid={
        options.current
          ? `sidebar-project-current-${project.id}`
          : `sidebar-project-switcher-item-${project.id}`
      }
      className={[
        DRAWER_LIST_ROW_TEXT_CLASS,
        PICKER_LIST_ROW_GEOMETRY_CLASS,
        pickerListRowTextClassName(options.current),
        options.current ? PICKER_LIST_ROW_ACTIVE_CLASS : "",
        "data-[selected]:bg-slate-100 dark:data-[selected]:bg-[var(--color-studio-dark-active)]",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <MenuItemContent>
        <span className="flex w-full items-center justify-between gap-2">
          <span className="flex min-w-0 items-center gap-2"><SpaceIdentity name={project.name} icon={project.projectIcon} color={project.projectColor} className="h-6 w-6 shrink-0" /><span className="truncate">{project.name || "Untitled space"}</span></span>
          <span className="flex shrink-0 items-center gap-1.5">
            {options.current ? (
              <span className="text-3xs font-medium uppercase tracking-[0.08em] text-slate-600 dark:text-slate-500">
                Current
              </span>
            ) : null}
            <AttentionBadge
              count={projectAttentionCounts[project.id] ?? 0}
              className="shrink-0"
              testId={`sidebar-project-attention-${project.id}`}
            />
          </span>
        </span>
      </MenuItemContent>
    </StudioMenuItem>
  );

  return (
    <>
      {mode === "teams-and-spaces" ? <SidebarMenuSection
        label="Team"
        headerClassName="pr-0"
        actions={
          <div className="flex items-center gap-1">
            <IconButton
              variant="ghost"
              size="sm"
              radius="full"
              aria-label="Team settings"
              data-testid="sidebar-org-settings-button"
              isDisabled={!onOpenOrgSettings}
              onPress={onOpenOrgSettings}
              className={`shrink-0 ${WORKSPACE_SWITCHER_ACTION_BUTTON_CLASS}`}
            >
              <Settings className={WORKSPACE_SWITCHER_ACTION_ICON_CLASS} aria-hidden="true" />
            </IconButton>
            {onCreateOrg ? (
              // The section's real job for a one-team user: the door to a
              // second team. Mirrors the "New space" action below.
              <IconButton
                variant="ghost"
                size="sm"
                radius="full"
                aria-label="New team"
                data-testid="sidebar-org-new"
                onPress={onCreateOrg}
                className={`shrink-0 ${WORKSPACE_SWITCHER_ACTION_BUTTON_CLASS}`}
              >
                <Plus className={WORKSPACE_SWITCHER_ACTION_ICON_CLASS} aria-hidden="true" />
              </IconButton>
            ) : null}
          </div>
        }
      >
        <div className="mt-2 space-y-1" data-testid="sidebar-org-selector">
          {orgOptions.map(renderTeamRow)}
        </div>
      </SidebarMenuSection> : null}

      {projectsError ? (
        <div className="mx-3.5 mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-slate-600 dark:text-slate-300"
          data-testid="sidebar-project-discovery-error">
          <p role="status">{projectsError}</p>
          {onRetryProjects ? (
            <Button variant="outline" size="xs" onPress={onRetryProjects}
              isDisabled={projectsRefreshing} data-testid="sidebar-project-discovery-retry">
              {projectsRefreshing ? "Retrying…" : "Retry"}
            </Button>
          ) : null}
        </div>
      ) : null}

      <SidebarMenuSection
        className="mt-4"
        label="Spaces"
        headerClassName="pr-0"
        actions={
          <div className="flex items-center gap-1">
            {canSearchSpaces ? (
              <IconButton
                variant="ghost"
                size="sm"
                radius="full"
                aria-label={showProjectSearch ? "Clear space search" : "Search spaces"}
                data-testid="sidebar-project-search-toggle"
                onPress={onToggleProjectSearch}
                className={WORKSPACE_SWITCHER_ACTION_BUTTON_CLASS}
              >
                <Search className={WORKSPACE_SWITCHER_ACTION_ICON_CLASS} aria-hidden="true" />
              </IconButton>
            ) : null}
            {onOpenProjectSettings && currentOrgProject ? (
              <IconButton
                variant="ghost"
                size="sm"
                radius="full"
                aria-label="Current space settings"
                data-testid="sidebar-project-settings"
                onPress={onOpenProjectSettings}
                className={WORKSPACE_SWITCHER_ACTION_BUTTON_CLASS}
              >
                <Settings className={WORKSPACE_SWITCHER_ACTION_ICON_CLASS} aria-hidden="true" />
              </IconButton>
            ) : null}
            {onCreateProject ? (
              <IconButton
                variant="ghost"
                size="sm"
                radius="full"
                aria-label="New space"
                data-testid="sidebar-project-new"
                onPress={onCreateProject}
                className={WORKSPACE_SWITCHER_ACTION_BUTTON_CLASS}
              >
                <Plus className={WORKSPACE_SWITCHER_ACTION_ICON_CLASS} aria-hidden="true" />
              </IconButton>
            ) : null}
          </div>
        }
      >
        {showProjectSearch && canSearchSpaces ? (
          <div className="mt-2">
            <SearchInput
              id="sidebar-project-switcher-search"
              label="Search spaces"
              value={workspaceProjectQuery}
              onChange={(event) => onWorkspaceProjectQueryChange(event.target.value)}
              placeholder="Search spaces…"
              data-testid="sidebar-project-search"
              autoFocus={workspaceProjectSearchOpen}
            />
          </div>
        ) : null}
      </SidebarMenuSection>

      {!currentOrgProject && switcherProjects.length === 0 ? (
        <Text as="p" variant="body" tone="muted" className="mt-2 px-3.5">
          {trimmedWorkspaceProjectQuery.length > 0 ? "No matching spaces." : "No spaces yet."}
        </Text>
      ) : (
        <>
          <StudioMenu
            aria-label="Spaces"
            selectionMode="single"
            onAction={onProjectMenuAction}
            className="mt-2 space-y-1"
          >
            {currentOrgProject ? renderProjectRow(currentOrgProject, { current: true }) : null}
            {visibleProjects.map((project) => renderProjectRow(project, { current: false }))}
          </StudioMenu>
          {hiddenProjectCount > 0 ? (
            // Keep the truncation note in the list's text column.
            <Text
              as="p"
              variant="caption"
              tone="muted"
              className="mt-3 px-3.5"
              data-testid="sidebar-project-switcher-list-truncated"
            >
              Showing {visibleProjects.length} of {switcherProjects.length} spaces.{" "}
              {trimmedWorkspaceProjectQuery.length > 0
                ? "Refine the search to narrow the results."
                : "Use search to find older spaces."}
            </Text>
          ) : null}
        </>
      )}
    </>
  );
}
