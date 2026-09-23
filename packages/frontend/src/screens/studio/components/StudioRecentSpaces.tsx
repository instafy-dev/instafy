import { useEffect, useId, useState, type RefObject } from "react";
import { DialogTrigger, Heading } from "react-aria-components";
import { Check, Folder } from "iconoir-react";
import { AttentionBadge } from "../../../components/AttentionBadge";
import { Button } from "../../../components/Button";
import { ControlChevron } from "../../../components/ControlChevron";
import { SpaceIdentity } from "../../../components/SpaceIdentity";
import { StudioDialogPopover } from "../../../components/aria/StudioPopover";
import { DARK_FLOATING_SELECTION_CLASS } from "../../../theme/darkSurfaces";
import type { ProjectRecencyMap } from "../../../projects/projectRecency";
import { unreadUpdatesDescription as unreadDescription } from "../homeUpdateLabels";

export const SIDEBAR_RECENT_SPACE_LIMIT = 6;

export interface RecentSpace {
  id: string;
  name: string;
  icon?: string | null;
  color?: string | null;
  avatarUrl?: string | null;
}

const spaceName = (space: RecentSpace) => space.name.trim() || "Untitled space";
const compareSpaceNames = (a: RecentSpace, b: RecentSpace) =>
  spaceName(a).localeCompare(spaceName(b)) || a.id.localeCompare(b.id);

/** Recency selects the shortcuts; alphabetical order keeps their positions predictable. */
export function selectRecentSpaces(
  spaces: readonly RecentSpace[],
  recency: Readonly<ProjectRecencyMap>,
  activeProjectId: string | null,
): RecentSpace[] {
  const visitedAt = (id: string) => {
    const at = recency[id];
    return Number.isFinite(at) && at > 0 ? at : 0;
  };
  return spaces
    .filter((space) => space.id === activeProjectId || visitedAt(space.id) > 0)
    .sort((a, b) => Number(b.id === activeProjectId) - Number(a.id === activeProjectId)
      || visitedAt(b.id) - visitedAt(a.id)
      || compareSpaceNames(a, b))
    .slice(0, SIDEBAR_RECENT_SPACE_LIMIT)
    .sort(compareSpaceNames);
}


export interface StudioRecentSpacesProps {
  spaces: readonly RecentSpace[];
  recency: Readonly<ProjectRecencyMap>;
  activeProjectId: string | null;
  attentionCounts?: Readonly<Record<string, number>>;
  onSelectSpace: (id: string) => void;
  onBrowseAll: () => void;
  collapsed: boolean;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  rowClassName: string;
  iconClassName: string;
  triggerRef?: RefObject<HTMLButtonElement | null>;
  presentation?: "inline" | "path";
}

export function StudioRecentSpaces({
  spaces,
  recency,
  activeProjectId,
  attentionCounts,
  onSelectSpace,
  onBrowseAll,
  collapsed,
  expanded,
  onExpandedChange,
  rowClassName,
  iconClassName,
  triggerRef,
  presentation = "inline",
}: StudioRecentSpacesProps) {
  const listId = useId();
  const [popoverOpen, setPopoverOpen] = useState(false);
  useEffect(() => {
    // Width changes move the anchor; external project changes replace its context.
    setPopoverOpen(false);
  }, [collapsed, activeProjectId, presentation]);
  const pathPresentation = presentation === "path" && !collapsed;
  const usePopover = collapsed || pathPresentation;
  const currentSpace = spaces.find((space) => space.id === activeProjectId);
  const attentionFor = (id: string) => {
    const count = attentionCounts?.[id] ?? 0;
    return Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
  };
  const currentAttention = currentSpace ? attentionFor(currentSpace.id) : 0;
  const triggerLabel = [
    currentSpace ? `Choose space: ${spaceName(currentSpace)}` : "Choose space",
    currentAttention > 0 ? unreadDescription(currentAttention) : null,
  ].filter(Boolean).join(", ");
  const visibleSpaces = selectRecentSpaces(spaces, recency, activeProjectId);

  const recentList = (
    <div id={listId} data-testid="sidebar-recent-spaces-list">
      {visibleSpaces.length > 0 ? (
        <ul aria-label="Recent spaces" className="flex flex-col gap-1">
          {visibleSpaces.map((space) => {
            const selected = space.id === activeProjectId;
            const name = spaceName(space);
            const attention = attentionFor(space.id);
            const details = [name, selected ? "Current" : null, attention > 0 ? unreadDescription(attention) : null].filter(Boolean);
            return (
              <li key={space.id} className="min-w-0">
                <Button
                  variant="ghost"
                  size="sm"
                  radius="lg"
                  fullWidth
                  data-testid={`sidebar-recent-space-${space.id}`}
                  aria-label={details.join(", ")}
                  aria-current={selected ? "page" : undefined}
                  title={details.join(" · ")}
                  onPress={() => {
                    setPopoverOpen(false);
                    onSelectSpace(space.id);
                  }}
                  className={`min-h-11 min-w-0 !justify-start gap-2.5 text-left focus-visible:ring-offset-0 data-[pressed]:!translate-y-0 data-[pressed]:!scale-100 aria-[current=page]:bg-slate-100 ${DARK_FLOATING_SELECTION_CLASS}`}
                >
                  <SpaceIdentity name={name} icon={space.icon} color={space.color} avatarUrl={space.avatarUrl} className="!h-7 !w-7 shrink-0 !rounded-md !text-sm" />
                  <span className={`min-w-0 flex-1 truncate text-sm ${selected ? "font-medium text-slate-900 dark:text-slate-100" : "font-normal text-slate-700 dark:text-slate-300"}`}>{name}</span>
                  <AttentionBadge count={attention} aria-hidden testId={`sidebar-recent-space-attention-${space.id}`}
                    title={unreadDescription(attention)} className="shrink-0" />
                  <span aria-hidden="true" className="h-4 w-4 shrink-0 text-slate-600 dark:text-slate-300">
                    {selected ? <Check className="h-4 w-4" /> : null}
                  </span>
                </Button>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="px-2.5 py-3 text-xs text-slate-500 dark:text-slate-400">No recent spaces in this team.</p>
      )}
      <Button
        variant="ghost"
        size="sm"
        radius="lg"
        fullWidth
        data-testid="sidebar-browse-all-spaces"
        className="mt-1 min-h-9 px-2.5 text-left focus-visible:ring-offset-0"
        onPress={() => {
          setPopoverOpen(false);
          onBrowseAll();
        }}
      >
        <span className="flex w-full min-w-0 items-center justify-between gap-2 text-sm font-normal text-slate-600 dark:text-slate-400">
          <span className="truncate">Browse all spaces</span>
          <ControlChevron direction="right" />
        </span>
      </Button>
    </div>
  );

  const trigger = (
    <Button
      ref={triggerRef}
      variant="ghost"
      size="sm"
      radius="lg"
      fullWidth={!pathPresentation}
      data-testid="sidebar-space-button"
      aria-label={triggerLabel}
      title={triggerLabel}
      aria-expanded={usePopover ? popoverOpen : expanded}
      aria-controls={!usePopover && expanded ? listId : undefined}
      onPress={usePopover ? undefined : () => onExpandedChange(!expanded)}
      className={`${pathPresentation ? "studio-breadcrumb-trigger" : ""} group/item relative min-w-0 py-1.5 transition focus-visible:ring-offset-0 data-[pressed]:!translate-y-0 data-[pressed]:!scale-100 ${rowClassName}`}
    >
      {pathPresentation && currentSpace ? <SpaceIdentity
        name={spaceName(currentSpace)} icon={currentSpace.icon} color={currentSpace.color} avatarUrl={currentSpace.avatarUrl}
        className="!h-5 !w-5 !rounded-md !text-xs"
      /> : null}
      {!pathPresentation ? <span className={`relative ${iconClassName}`}>
        {currentSpace ? <SpaceIdentity name={spaceName(currentSpace)} icon={currentSpace.icon} color={currentSpace.color} avatarUrl={currentSpace.avatarUrl}
          />
          : <Folder className="h-5 w-5" aria-hidden="true" />}
        <AttentionBadge count={currentAttention} aria-hidden testId="sidebar-current-space-attention"
          title={unreadDescription(currentAttention)} className="absolute -right-1 -top-1" />
      </span> : null}
      {pathPresentation && currentAttention > 0 ? <AttentionBadge count={currentAttention} aria-hidden testId="sidebar-current-space-attention"
        title={unreadDescription(currentAttention)} className="absolute -right-1 -top-1" /> : null}
      {!collapsed ? (
        <span className={`flex min-w-0 flex-1 items-center text-sm ${pathPresentation ? "justify-start gap-1 font-semibold" : "justify-between gap-2 font-medium"}`}>
          <span className="truncate">{currentSpace ? spaceName(currentSpace) : "Choose space"}</span>
          <ControlChevron direction={usePopover || expanded ? "down" : "right"} />
        </span>
      ) : null}
    </Button>
  );

  if (usePopover) {
    return (
      <DialogTrigger isOpen={popoverOpen} onOpenChange={setPopoverOpen}>
        {trigger}
        <StudioDialogPopover
          placement={pathPresentation ? "bottom start" : "right top"}
          offset={8}
          className="w-72 max-w-[calc(100vw-1rem)] p-2"
          data-testid="sidebar-recent-spaces-popover"
        >
          <div className="mb-2 px-2.5 py-1">
            <Heading slot="title" className="text-sm font-semibold text-slate-900 dark:text-slate-100">Recent spaces</Heading>
          </div>
          {recentList}
        </StudioDialogPopover>
      </DialogTrigger>
    );
  }

  return (
    <>
      {trigger}
      {expanded ? <div className="px-1 py-2">{recentList}</div> : null}
    </>
  );
}
