import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { ArrowUp, ArrowDown, Compass, Group, Plus, Settings } from "iconoir-react";
import { AttentionBadge } from "../../../components/AttentionBadge";
import { IconButton } from "../../../components/Button";
import { OctoMark } from "../../../components/OctoMark";
import { DESKTOP_TITLE_BAR_HEIGHT_PX } from "../../../lib/desktopShell";
import { OrgIdentity } from "../../../components/OrgIdentity";
import { normalizeOrgAccent } from "../../../org/orgAccent";
import { DARK_RAIL_SURFACE_CLASS } from "../../../theme/darkSurfaces";
import type { SidebarWorkspaceOrgOption } from "./StudioSidebarWorkspaceSwitcher";
import { unreadUpdatesDescription } from "../homeUpdateLabels";
import { StudioPopover } from "../../../components/aria/StudioPopover";
import { StudioMenu, StudioMenuItem } from "../../../components/aria/StudioMenu";
import { MenuItemContent } from "../../../components/MenuItemContent";

import { DndContext, MouseSensor, TouchSensor, closestCenter, useSensor, useSensors } from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useOrganizationRailOrder } from "./useOrganizationRailOrder";

function SortableOrganization({ id, enabled, onPointerStart, children }: {
  id: string;
  enabled: boolean;
  onPointerStart: () => void;
  children: ReactNode;
}) {
  const { setNodeRef, listeners, transform, transition, isDragging } = useSortable({ id, disabled: !enabled });
  return <div ref={setNodeRef}
    onPointerDownCapture={onPointerStart}
    onMouseDownCapture={event => listeners?.onMouseDown?.(event)}
    onTouchStartCapture={event => listeners?.onTouchStart?.(event)}
    style={{ transform: CSS.Transform.toString(transform ? { ...transform, x: 0 } : null), transition }}
    className={`relative flex shrink-0 ${isDragging ? "z-10 cursor-grabbing rounded-xl bg-white shadow-lg dark:bg-slate-800" : ""}`}
    data-dragging={isDragging || undefined}>
    {children}
  </div>;
}

const SELECTION_MARKER_CLASS = "pointer-events-none absolute -left-2 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-r-full bg-current";

export interface StudioOrganizationRailProps {
  organizations: SidebarWorkspaceOrgOption[];
  userId?: string | null;
  selectedOrgKey: string;
  pendingOrgKey?: string | null;
  homeActive: boolean;
  homeAttentionCount?: number;
  orgAttentionCounts?: Record<string, number>;
  titleBarFree: boolean;
  onHome: () => void;
  onSelectOrganization: (key: string) => void;
  onOpenOrganizationOverview?: (key: string) => void;
  onOpenOrganizationSettings?: (key: string, category: "profile" | "members") => void;
  onCreateOrganization?: () => void;
  onBrowseOrganizations: () => void;
  browseButtonRef: RefObject<HTMLButtonElement | null>;
  account: ReactNode;
}

/** Account scope stays visible while the team's context sidebar collapses. */
export function StudioOrganizationRail({
  organizations,
  userId,
  selectedOrgKey,
  pendingOrgKey,
  homeActive,
  homeAttentionCount = 0,
  orgAttentionCounts = {},
  titleBarFree,
  onHome,
  onSelectOrganization,
  onOpenOrganizationOverview,
  onOpenOrganizationSettings,
  onCreateOrganization,
  onBrowseOrganizations,
  browseButtonRef,
  account,
}: StudioOrganizationRailProps) {
  const homeAttentionId = useId();
  const reorderDescriptionId = useId();
  const { orderedOrganizations, moveOrganization } = useOrganizationRailOrder(userId, organizations);
  const teams = orderedOrganizations.filter(org => org.key !== "all");
  const reorderEnabled = Boolean(userId) && teams.length > 1;
  const suppressSelection = useRef(false);
  const [reorderStatus, setReorderStatus] = useState("");
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 6 } }),
  );
  const reorder = (activeKey: string, overKey: string) => {
    moveOrganization(activeKey, overKey);
    const team = teams.find(org => org.key === activeKey);
    const position = teams.findIndex(org => org.key === overKey);
    if (team && position >= 0) setReorderStatus(`${team.name} moved to position ${position + 1} of ${teams.length}.`);
  };
  const listRef = useRef<HTMLDivElement | null>(null);
  const selectedRef = useRef<HTMLButtonElement | null>(null);
  const contextTriggerRef = useRef<HTMLButtonElement | null>(null);
  const [contextOrgKey, setContextOrgKey] = useState<string | null>(null);
  const contextOrg = organizations.find(org => org.key === contextOrgKey);
  const hasContextActions = Boolean(onOpenOrganizationOverview || onOpenOrganizationSettings || reorderEnabled);
  const contextIndex = teams.findIndex(org => org.key === contextOrgKey);
  useEffect(() => { setContextOrgKey(null); }, [selectedOrgKey, homeActive]);
  useEffect(() => {
    if (!contextOrg || !hasContextActions) setContextOrgKey(null);
  }, [contextOrg, hasContextActions]);
  const openContextMenu = (key: string, trigger: HTMLButtonElement) => {
    contextTriggerRef.current = trigger;
    // Restore keyboard focus to the right-clicked icon when the menu is dismissed.
    trigger.focus({ preventScroll: true });
    setContextOrgKey(key);
  };
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
          : `border-r border-slate-200/70 bg-slate-50 pt-[var(--instafy-safe-area-inset-top)] ${DARK_RAIL_SURFACE_CLASS}`,
      ].join(" ")}
      style={titleBarFree ? { paddingTop: `var(--studio-context-height, ${DESKTOP_TITLE_BAR_HEIGHT_PX}px)` } : undefined}
    >
      {titleBarFree ? <div aria-hidden="true" data-rail-surface=""
        className={`absolute inset-x-0 bottom-0 z-0 border-r border-slate-200/70 bg-slate-50 ${DARK_RAIL_SURFACE_CLASS}`}
        style={{ top: `var(--studio-context-height, ${DESKTOP_TITLE_BAR_HEIGHT_PX}px)` }} /> : null}
      <div className="flex h-[var(--studio-context-height,60px)] shrink-0 items-center">
        <IconButton variant="ghost" size="sm" radius="lg" onPress={onHome}
          aria-label="Home, all teams" title="Home, all teams" aria-current={homeActive ? "page" : undefined}
          aria-describedby={homeAttentionCount > 0 ? homeAttentionId : undefined}
          data-testid="sidebar-home-button"
          className="relative h-11 w-11">
          {homeActive ? <span aria-hidden="true" className={SELECTION_MARKER_CLASS} /> : null}
          <span aria-hidden="true"><OctoMark className="h-6 w-6 text-brand-ink dark:text-brand-paper" /></span>
          <AttentionBadge count={homeAttentionCount} aria-hidden testId="sidebar-home-badge"
            title={`${unreadUpdatesDescription(homeAttentionCount)} across teams`}
            className="absolute right-0 top-0 ring-2 ring-slate-50 dark:ring-[color:var(--color-studio-dark-rail)]" />
        </IconButton>
        {homeAttentionCount > 0 ? <span id={homeAttentionId} className="sr-only">{unreadUpdatesDescription(homeAttentionCount)} across teams</span> : null}
      </div>
      <span id={reorderDescriptionId} className="sr-only">Drag to reorder. For keyboard controls, open the team menu with Shift+F10 and choose Move up or Move down.</span>
      <span role="status" className="sr-only">{reorderStatus}</span>
      <DndContext sensors={sensors} collisionDetection={closestCenter}
        accessibility={{ announcements: {
          onDragStart: ({ active }) => `Reordering ${teams.find(org => org.key === active.id)?.name ?? "team"}.`,
          onDragOver: ({ over }) => over ? `Position ${teams.findIndex(org => org.key === over.id) + 1} of ${teams.length}.` : undefined,
          onDragEnd: () => undefined,
          onDragCancel: () => "Reordering cancelled.",
        } }}
        onDragStart={() => { suppressSelection.current = true; setContextOrgKey(null); }}
        onDragEnd={({ active, over }) => { if (over && active.id !== over.id) reorder(String(active.id), String(over.id)); }}>
      <SortableContext items={teams.map(org => org.key)} strategy={verticalListSortingStrategy}>
      <div ref={listRef} data-testid="sidebar-team-rail-list"
        onScroll={() => setContextOrgKey(null)}
        className="flex min-h-0 w-full flex-1 flex-col items-center gap-2 overflow-y-auto overflow-x-hidden overscroll-contain px-1 py-1 [scrollbar-width:thin]">
        {teams.map((org) => {
          const selected = org.key === selectedOrgKey;
          const pending = org.key === pendingOrgKey;
          const attention = orgAttentionCounts[org.key] ?? 0;
          return <SortableOrganization key={org.key} id={org.key} enabled={reorderEnabled}
            onPointerStart={() => { suppressSelection.current = false; }}>
          <IconButton ref={selected ? selectedRef : undefined}
            variant="ghost" size="sm" radius="lg" onPress={() => { if (!suppressSelection.current) onSelectOrganization(org.key); }}
            onContextMenu={event => {
              if (!hasContextActions) return;
              event.preventDefault();
              event.stopPropagation();
              openContextMenu(org.key, event.currentTarget);
            }}
            onKeyDown={event => {
              // React Aria otherwise stops Escape before dnd-kit's sensor can cancel.
              if (event.key === "Escape") event.continuePropagation();
              if (event.key === "Enter" || event.key === " ") suppressSelection.current = false;
              if (hasContextActions && (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10"))) {
                event.preventDefault();
                openContextMenu(org.key, event.currentTarget);
              }
            }}
            aria-haspopup={hasContextActions ? "menu" : undefined}
            aria-expanded={hasContextActions ? contextOrgKey === org.key : undefined}
            aria-keyshortcuts={hasContextActions ? "Shift+F10" : undefined}
            aria-describedby={reorderEnabled ? reorderDescriptionId : undefined}
            aria-label={`${org.label}${attention > 0 ? `, ${unreadUpdatesDescription(attention)}` : ""}`}
            title={reorderEnabled ? `${org.label} · Drag to reorder` : org.label} aria-current={selected && !homeActive ? "page" : undefined}
            data-org-accent={normalizeOrgAccent(org.accentColor) ?? "slate"}
            aria-busy={pending || undefined} data-testid={`sidebar-team-${org.key}`}
            className={`org-accent-selection relative h-11 w-11 shrink-0 ${reorderEnabled ? "cursor-grab active:cursor-grabbing" : ""}`}>
            {selected && !homeActive ? <span aria-hidden="true" className="org-accent-marker pointer-events-none absolute -left-2 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-r-full" /> : null}
            <OrgIdentity name={org.name} avatarUrl={org.avatarUrl} accentColor={org.accentColor}
              className={`h-8 w-8 text-xs ${pending ? "animate-pulse" : ""}`} />
            <AttentionBadge count={attention} aria-hidden testId={`sidebar-team-attention-${org.key}`}
              title={unreadUpdatesDescription(attention)}
              className="absolute right-0 top-0 ring-2 ring-slate-50 dark:ring-[color:var(--color-studio-dark-rail)]" />
          </IconButton>
          </SortableOrganization>;
        })}
      </div>
      </SortableContext>
      </DndContext>
      {contextOrg && hasContextActions ? <StudioPopover
        triggerRef={contextTriggerRef} isOpen onOpenChange={open => { if (!open) setContextOrgKey(null); }}
        placement="right top" offset={6} className="w-56 max-w-[calc(100vw-1rem)] p-2"
        data-testid="sidebar-org-context-menu">
        <div className="mb-1 flex min-w-0 items-center gap-2 px-2 py-2 text-sm font-semibold">
          <OrgIdentity name={contextOrg.name} avatarUrl={contextOrg.avatarUrl} accentColor={contextOrg.accentColor} className="h-6 w-6 text-[11px]" />
          <span className="min-w-0 break-words">{contextOrg.name}</span>
        </div>
        <StudioMenu aria-label={`Team actions: ${contextOrg.name}`} autoFocus="first"
          onClose={() => setContextOrgKey(null)} className="space-y-1"
          onAction={key => {
            setContextOrgKey(null);
            if (key === "overview") onOpenOrganizationOverview?.(contextOrg.key);
            if (key === "settings") onOpenOrganizationSettings?.(contextOrg.key, "profile");
            if (key === "members") onOpenOrganizationSettings?.(contextOrg.key, "members");
            if (key === "move-up" && contextIndex > 0) reorder(contextOrg.key, teams[contextIndex - 1].key);
            if (key === "move-down" && contextIndex < teams.length - 1) reorder(contextOrg.key, teams[contextIndex + 1].key);
          }}>
          {onOpenOrganizationOverview ? <StudioMenuItem id="overview" textValue="Team overview" data-testid="sidebar-org-context-overview">
            <MenuItemContent start={<Group className="h-4 w-4" aria-hidden="true" />}>Team overview</MenuItemContent>
          </StudioMenuItem> : null}
          {onOpenOrganizationSettings ? <StudioMenuItem id="settings" textValue="Team settings" data-testid="sidebar-org-context-settings">
            <MenuItemContent start={<Settings className="h-4 w-4" aria-hidden="true" />}>Team settings</MenuItemContent>
          </StudioMenuItem> : null}
          {onOpenOrganizationSettings ? <StudioMenuItem id="members" textValue="Members" data-testid="sidebar-org-context-members">
            <MenuItemContent start={<Group className="h-4 w-4" aria-hidden="true" />}>Members</MenuItemContent>
          </StudioMenuItem> : null}
          {reorderEnabled ? <StudioMenuItem id="move-up" textValue="Move up" isDisabled={contextIndex <= 0} data-testid="sidebar-org-context-move-up">
            <MenuItemContent start={<ArrowUp className="h-4 w-4" aria-hidden="true" />}>Move up</MenuItemContent>
          </StudioMenuItem> : null}
          {reorderEnabled ? <StudioMenuItem id="move-down" textValue="Move down" isDisabled={contextIndex >= teams.length - 1} data-testid="sidebar-org-context-move-down">
            <MenuItemContent start={<ArrowDown className="h-4 w-4" aria-hidden="true" />}>Move down</MenuItemContent>
          </StudioMenuItem> : null}
        </StudioMenu>
      </StudioPopover> : null}
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
