import { type RefObject, useId } from "react";
import { Search } from "iconoir-react";
import { AttentionBadge } from "../../../components/AttentionBadge";
import { IconButton } from "../../../components/Button";
import { OctoMark } from "../../../components/OctoMark";
import { DARK_RAIL_BG_CLASS } from "../../../theme/darkSurfaces";
import { useAuth } from "../../../providers/AuthProvider";
import { useProjectRecency } from "../../../projects/useProjectRecency";
import type { ProjectListItem } from "../../../projects/useProjects";
import { StudioRecentSpaces } from "./StudioRecentSpaces";
import { StudioAccountMenu } from "./StudioAccountMenu";
import { StudioSidebarTeamMenu } from "./StudioSidebarTeamMenu";
import { unreadUpdatesDescription } from "../homeUpdateLabels";
import "./StudioMobileContextHeader.css";

export interface StudioMobileContextHeaderProps {
  teamName: string;
  teamAvatarUrl: string | null;
  teamId: string;
  accentColor?: string | null;
  projects: readonly ProjectListItem[];
  activeProjectId: string | null;
  attentionCounts: Record<string, number>;
  homeActive: boolean;
  homeAttentionCount: number;
  searchRef: RefObject<HTMLButtonElement | null>;
  onHome: () => void;
  onSearch: () => void;
  onProfile: () => void;
  onSupport?: () => void;
  onSignOut?: () => void;
  onTeam: () => void;
  onSettings?: () => void;
  onSwitchTeam: () => void;
  onBrowseSpaces?: () => void;
  onSpace: (id: string) => void;
}

/** The same working context stays reachable on Home, team pages and workspace tools. */
export function StudioMobileContextHeader({
  teamName,
  teamAvatarUrl,
  teamId,
  accentColor,
  projects,
  activeProjectId,
  attentionCounts,
  homeActive,
  homeAttentionCount,
  searchRef,
  onHome,
  onSearch,
  onProfile,
  onSupport,
  onSignOut,
  onTeam,
  onSettings,
  onSwitchTeam,
  onBrowseSpaces,
  onSpace,
}: StudioMobileContextHeaderProps) {
  const { user } = useAuth();
  const recency = useProjectRecency(user?.email);
  const homeAttentionId = useId();
  const spaces = projects
    .filter(project => (project.orgId ?? "personal") === teamId)
    .map(project => ({ id: project.id, name: project.name, icon: project.projectIcon, color: project.projectColor, avatarUrl: project.projectAvatarUrl }));
  const selectedSpaceId = spaces.some(space => space.id === activeProjectId) ? activeProjectId : null;
  const unreadCount = Number.isFinite(homeAttentionCount) && homeAttentionCount > 0 ? Math.floor(homeAttentionCount) : 0;

  return (
    <header
      className={`studio-mobile-context-header flex min-h-14 min-w-0 shrink-0 items-center gap-0.5 border-b border-transparent bg-slate-50 pb-1 text-slate-900 dark:text-slate-100 ${DARK_RAIL_BG_CLASS}`}
      style={{
        paddingTop: "calc(var(--instafy-safe-area-inset-top, env(safe-area-inset-top, 0px)) + 4px)",
        paddingLeft: 4,
        paddingRight: 4,
      }}
      aria-label="Working context"
      data-testid="studio-mobile-context-header"
    >
      <IconButton
        variant="ghost" radius="lg" onPress={onHome}
        aria-label="Home — all teams" title="Home — all teams"
        aria-current={homeActive ? "page" : undefined}
        aria-describedby={unreadCount > 0 ? homeAttentionId : undefined}
        data-testid="topbar-home-button"
        className="relative !min-h-12 !min-w-11 shrink-0 data-[pressed]:!translate-y-0 data-[pressed]:!scale-100"
      >
        <OctoMark className="h-6 w-6 text-brand-ink dark:text-brand-paper" aria-hidden="true" />
        {homeActive ? <span aria-hidden="true" className="pointer-events-none absolute bottom-1 left-1/2 h-0.5 w-4 -translate-x-1/2 rounded-full bg-current" /> : null}
        <AttentionBadge count={unreadCount} aria-hidden title={`${unreadUpdatesDescription(unreadCount)} across teams`} className="absolute right-0 top-1" testId="studio-mobile-home-attention" />
      </IconButton>
      {unreadCount > 0 ? <span id={homeAttentionId} className="sr-only">{unreadUpdatesDescription(unreadCount)} across teams</span> : null}
      <div className="flex min-w-0 flex-1 items-center gap-[3px]" role="group" aria-label="Team and space">
        <StudioSidebarTeamMenu
          key={teamId}
          teamName={teamName} teamAvatarUrl={teamAvatarUrl} accentColor={accentColor}
          compact={false} active={false} presentation="path" mobile
          rowClassName="" iconClassName=""
          onOpenOverview={onTeam} onOpenSettings={onSettings} onSwitchTeam={onSwitchTeam}
        />
        <span aria-hidden="true" className="pointer-events-none shrink-0 text-slate-400 dark:text-slate-500">/</span>
        <StudioRecentSpaces
          key={`spaces:${teamId}`}
          spaces={spaces} activeProjectId={selectedSpaceId}
          recency={recency} attentionCounts={attentionCounts}
          collapsed={false} expanded={false} onExpandedChange={() => {}}
          presentation="path"
          rowClassName="!min-h-12 !px-2 [&>[data-testid=sidebar-current-space-attention]]:!static [&>[data-testid=sidebar-current-space-attention]]:order-1 [&>[data-testid=sidebar-current-space-attention]]:shrink-0"
          iconClassName=""
          onSelectSpace={onSpace} onBrowseAll={onBrowseSpaces ?? onSwitchTeam}
        />
      </div>
      <IconButton
        ref={searchRef}
        variant="ghost" onPress={() => { searchRef.current?.focus(); onSearch(); }}
        aria-label="Search" title="Search" data-testid="studio-mobile-search-trigger"
        className="!min-h-12 !min-w-11 shrink-0"
      >
        <Search className="h-[18px] w-[18px]" aria-hidden="true" />
      </IconButton>
      <StudioAccountMenu
        presentation="header"
        onProfile={onProfile}
        onSupport={onSupport}
        onSignOut={onSignOut}
      />
    </header>
  );
}
