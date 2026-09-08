import { useLayoutEffect, useRef, type ReactNode, type RefObject } from "react";
import { Compass, Plus } from "iconoir-react";
import { HomeIcon } from "../../../components/AppIcons";
import { AttentionBadge } from "../../../components/AttentionBadge";
import { IconButton } from "../../../components/Button";
import { DESKTOP_TITLE_BAR_HEIGHT_PX } from "../../../lib/desktopShell";
import { getOrgInitials } from "../../../org/orgNaming";
import type { SidebarWorkspaceOrgOption } from "./StudioSidebarWorkspaceSwitcher";

export interface StudioOrganizationRailProps {
  organizations: SidebarWorkspaceOrgOption[];
  selectedOrgKey: string;
  pendingOrgKey?: string | null;
  homeActive: boolean;
  homeAttentionCount?: number;
  orgAttentionCounts?: Record<string, number>;
  titleBarFree: boolean;
  onHome: () => void;
  onSelectOrganization: (key: string) => void;
  onCreateOrganization?: () => void;
  onBrowseOrganizations: () => void;
  browseButtonRef: RefObject<HTMLButtonElement | null>;
  account: ReactNode;
}

/** Account scope stays visible while the team's context sidebar collapses. */
export function StudioOrganizationRail({
  organizations,
  selectedOrgKey,
  pendingOrgKey,
  homeActive,
  homeAttentionCount = 0,
  orgAttentionCounts = {},
  titleBarFree,
  onHome,
  onSelectOrganization,
  onCreateOrganization,
  onBrowseOrganizations,
  browseButtonRef,
  account,
}: StudioOrganizationRailProps) {
  const listRef = useRef<HTMLDivElement | null>(null);
  const selectedRef = useRef<HTMLButtonElement | null>(null);
  useLayoutEffect(() => {
    const list = listRef.current;
    const selected = selectedRef.current;
    if (!list || !selected) return;
    // Adjust only this scroller; scrollIntoView can also move the workspace.
    const containerBounds = list.getBoundingClientRect();
    const selectedBounds = selected.getBoundingClientRect();
    if (selectedBounds.top < containerBounds.top + 4) {
      list.scrollTop -= containerBounds.top + 4 - selectedBounds.top;
    } else if (selectedBounds.bottom > containerBounds.bottom - 4) {
      list.scrollTop += selectedBounds.bottom - containerBounds.bottom + 4;
    }
  }, [selectedOrgKey, organizations.length]);

  return (
    <nav
      aria-label="Home and teams"
      data-testid="sidebar-organization-rail"
      className={[
        "relative flex h-full min-h-0 w-16 shrink-0 flex-col items-center pb-4 text-slate-600 dark:text-slate-300",
        titleBarFree
          ? "[&>*:not([data-rail-surface])]:relative [&>*:not([data-rail-surface])]:z-[1]"
          : "border-r border-slate-200/70 bg-slate-50/80 pt-[var(--instafy-safe-area-inset-top)] dark:border-[color:var(--color-studio-dark-divider)] dark:bg-[var(--color-studio-dark-rail)]",
      ].join(" ")}
      style={titleBarFree ? { paddingTop: `${DESKTOP_TITLE_BAR_HEIGHT_PX}px` } : undefined}
    >
      {titleBarFree ? <div aria-hidden="true" data-rail-surface=""
        className="absolute inset-x-0 bottom-0 z-0 border-r border-slate-200/70 bg-slate-50/80 dark:border-[color:var(--color-studio-dark-divider)] dark:bg-[var(--color-studio-dark-rail)]"
        style={{ top: `${DESKTOP_TITLE_BAR_HEIGHT_PX}px` }} /> : null}
      <div className="shrink-0 py-2">
        <IconButton variant="ghost" size="sm" radius="lg" onPress={onHome}
          aria-label="Home, all teams" title="Home" aria-current={homeActive ? "page" : undefined}
          data-testid="sidebar-home-button"
          className="relative h-11 w-11 aria-[current=page]:bg-primary-50 aria-[current=page]:text-primary-600 dark:aria-[current=page]:bg-primary-500/10 dark:aria-[current=page]:text-primary-400">
          <HomeIcon className="h-5 w-5" aria-hidden="true" />
          <AttentionBadge count={homeAttentionCount} aria-hidden testId="sidebar-home-badge"
            className="absolute right-0 top-0 ring-2 ring-slate-50 dark:ring-[color:var(--color-studio-dark-rail)]" />
        </IconButton>
      </div>
      <div ref={listRef} data-testid="sidebar-team-rail-list"
        className="flex min-h-0 w-full flex-1 flex-col items-center gap-2 overflow-y-auto overflow-x-hidden overscroll-contain px-1 py-1 [scrollbar-width:thin]">
        {organizations.filter((org) => org.key !== "all").map((org) => {
          const selected = org.key === selectedOrgKey;
          const pending = org.key === pendingOrgKey;
          const attention = orgAttentionCounts[org.key] ?? 0;
          return <IconButton key={org.key} ref={selected ? selectedRef : undefined}
            variant="ghost" size="sm" radius="lg" onPress={() => onSelectOrganization(org.key)}
            aria-label={`${org.label}${attention > 0 ? `, ${attention} updates` : ""}`}
            title={org.label} aria-current={selected && !homeActive ? "page" : undefined}
            aria-busy={pending || undefined} data-testid={`sidebar-team-${org.key}`}
            className="relative h-11 w-11 shrink-0 aria-[current=page]:bg-primary-50 aria-[current=page]:text-primary-600 dark:aria-[current=page]:bg-primary-500/10 dark:aria-[current=page]:text-primary-400">
            <span className={`flex h-8 w-8 items-center justify-center overflow-hidden rounded-lg bg-slate-200 text-xs font-medium text-slate-700 dark:bg-slate-700 dark:text-slate-100 ${pending ? "animate-pulse" : ""}`}>
              {org.avatarUrl ? <img src={org.avatarUrl} alt="" draggable={false} className="h-full w-full object-cover" /> : getOrgInitials(org.name)}
            </span>
            <AttentionBadge count={attention} aria-hidden testId={`sidebar-team-attention-${org.key}`}
              className="absolute right-0 top-0 ring-2 ring-slate-50 dark:ring-[color:var(--color-studio-dark-rail)]" />
          </IconButton>;
        })}
      </div>
      <div data-testid="sidebar-rail-actions" className="flex w-full shrink-0 flex-col items-center gap-1 border-t border-slate-200/70 pt-2 dark:border-[color:var(--color-studio-dark-divider)]">
        {onCreateOrganization ? <IconButton variant="ghost" size="sm" radius="lg" className="h-11 w-11"
          aria-label="New team" title="New team" data-testid="sidebar-org-new" onPress={onCreateOrganization}>
          <Plus className="h-5 w-5" aria-hidden="true" />
        </IconButton> : null}
        <IconButton ref={browseButtonRef} variant="ghost" size="sm" radius="lg" className="h-11 w-11"
          aria-label="Browse teams" title="Browse teams" data-testid="sidebar-browse-teams" onPress={onBrowseOrganizations}>
          <Compass className="h-5 w-5" aria-hidden="true" />
        </IconButton>
        {account}
      </div>
    </nav>
  );
}
