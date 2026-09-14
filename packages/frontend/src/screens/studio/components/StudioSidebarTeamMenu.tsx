import { useState, type RefObject } from "react";
import { MenuTrigger } from "react-aria-components";
import { Group, Settings } from "iconoir-react";
import { Button } from "../../../components/Button";
import { ControlChevron } from "../../../components/ControlChevron";
import { OrgIdentity } from "../../../components/OrgIdentity";
import { normalizeOrgAccent } from "../../../org/orgAccent";
import { MenuItemContent } from "../../../components/MenuItemContent";
import { StudioMenu, StudioMenuItem } from "../../../components/aria/StudioMenu";
import { StudioPopover } from "../../../components/aria/StudioPopover";

interface StudioSidebarTeamMenuProps {
  teamName: string;
  teamAvatarUrl?: string | null;
  accentColor?: string | null;
  presentation?: "standard" | "path";
  compact: boolean;
  active: boolean;
  rowClassName: string;
  iconClassName: string;
  onOpenOverview: () => void;
  onOpenSettings?: () => void;
  onSwitchTeam?: () => void;
  mobile?: boolean;
  touchTargets?: boolean;
  triggerRef?: RefObject<HTMLButtonElement | null>;
}

const MENU_ICON_CLASS = "shrink-0 text-slate-600 dark:text-slate-300 [&>svg]:h-4 [&>svg]:w-4";

/** Team actions stay anchored to the header or its compact rail equivalent. */
export function StudioSidebarTeamMenu({
  teamName,
  teamAvatarUrl,
  accentColor,
  presentation = "standard",
  compact,
  active,
  rowClassName,
  iconClassName,
  onOpenOverview,
  onOpenSettings,
  onSwitchTeam,
  mobile = false,
  touchTargets = false,
  triggerRef,
}: StudioSidebarTeamMenuProps) {
  const [open, setOpen] = useState(false);
  const path = presentation === "path" && !compact;
  const menuItemClassName = mobile ? "min-h-12" : touchTargets ? "min-h-11" : undefined;
  return (
    <MenuTrigger isOpen={open} onOpenChange={setOpen}>
      <Button
        ref={triggerRef}
        variant="ghost" size="sm" radius="lg" fullWidth={compact}
        data-testid="sidebar-team-menu-trigger"
        aria-label={`Team menu: ${teamName}`} title={`Team menu: ${teamName}`}
        data-org-accent={normalizeOrgAccent(accentColor) ?? "slate"}
        aria-haspopup="menu"
        className={`${path ? "org-accent-chip" : ""} ${path ? `shrink-0 !px-0 ${mobile || touchTargets ? "!min-w-11 !w-11" : "!min-w-8 !w-8"}` : compact ? rowClassName : "min-w-0 flex-1 justify-between gap-1 py-2 pl-2 pr-3"} ${mobile ? "!min-h-12" : touchTargets ? "!min-h-11" : ""} data-[pressed]:!translate-y-0 data-[pressed]:!scale-100`}
      >
        {path ? (
          <OrgIdentity name={teamName} avatarUrl={teamAvatarUrl} accentColor={accentColor}
            className={mobile ? "h-7 w-7 text-xs" : "h-6 w-6 text-[11px]"} />
        ) : compact ? (
          <span className={iconClassName} data-active={active || undefined}>
            <Group className="h-5 w-5" aria-hidden="true" />
          </span>
        ) : (
          <>
            <OrgIdentity name={teamName} avatarUrl={teamAvatarUrl} accentColor={accentColor} className="h-5 w-5 text-[10px]" />
            <span className="min-w-0 truncate text-sm font-medium">{teamName}</span>
            <ControlChevron direction="down" />
          </>
        )}
      </Button>
      <StudioPopover placement={compact ? "right top" : mobile || path ? "bottom start" : "bottom end"} offset={6}
        className={`${mobile ? "w-56" : "w-52"} max-w-[calc(100vw-1rem)] p-2`} data-testid="sidebar-team-menu">
        {path ? <div className="mb-1 break-words px-2 py-2 text-sm font-semibold text-slate-900 dark:text-slate-100">{teamName}</div> : null}
        <StudioMenu aria-label={`Team actions: ${teamName}`} className="space-y-1"
          onAction={(key) => {
            setOpen(false);
            if (key === "overview") onOpenOverview();
            if (key === "settings") onOpenSettings?.();
            if (key === "switch") onSwitchTeam?.();
          }}>
          {onSwitchTeam ? <StudioMenuItem id="switch" textValue="Switch team" data-testid="sidebar-team-menu-switch"
            className={menuItemClassName}>
            <MenuItemContent startClassName={MENU_ICON_CLASS} start={<Group aria-hidden="true" />}>Switch team</MenuItemContent>
          </StudioMenuItem> : null}
          <StudioMenuItem id="overview" textValue="Team overview" data-testid="sidebar-team-menu-overview"
            className={menuItemClassName}>
            <MenuItemContent startClassName={MENU_ICON_CLASS} start={<Group aria-hidden="true" />}>Team overview</MenuItemContent>
          </StudioMenuItem>
          {onOpenSettings ? <StudioMenuItem id="settings" textValue="Team settings" data-testid="sidebar-team-menu-settings"
            className={menuItemClassName}>
            <MenuItemContent startClassName={MENU_ICON_CLASS} start={<Settings aria-hidden="true" />}>Team settings</MenuItemContent>
          </StudioMenuItem> : null}
        </StudioMenu>
      </StudioPopover>
    </MenuTrigger>
  );
}
