import { useState } from "react";
import { MenuTrigger } from "react-aria-components";
import { Group, Settings } from "iconoir-react";
import { Button } from "../../../components/Button";
import { ControlChevron } from "../../../components/ControlChevron";
import { MenuItemContent } from "../../../components/MenuItemContent";
import { StudioMenu, StudioMenuItem } from "../../../components/aria/StudioMenu";
import { StudioPopover } from "../../../components/aria/StudioPopover";

interface StudioSidebarTeamMenuProps {
  teamName: string;
  compact: boolean;
  active: boolean;
  rowClassName: string;
  iconClassName: string;
  onOpenOverview: () => void;
  onOpenSettings?: () => void;
}

const MENU_ICON_CLASS = "shrink-0 text-slate-600 dark:text-slate-300 [&>svg]:h-4 [&>svg]:w-4";

/** Team actions stay anchored to the header or its compact rail equivalent. */
export function StudioSidebarTeamMenu({
  teamName,
  compact,
  active,
  rowClassName,
  iconClassName,
  onOpenOverview,
  onOpenSettings,
}: StudioSidebarTeamMenuProps) {
  const [open, setOpen] = useState(false);
  return (
    <MenuTrigger isOpen={open} onOpenChange={setOpen}>
      <Button
        variant="ghost" size="sm" radius="lg" fullWidth={compact}
        data-testid="sidebar-team-menu-trigger"
        aria-label={`Team menu: ${teamName}`} title={`Team menu: ${teamName}`}
        aria-haspopup="menu"
        className={`${compact ? rowClassName : "min-w-0 flex-1 justify-between gap-1 py-2 pl-2 pr-3"} data-[pressed]:!translate-y-0 data-[pressed]:!scale-100`}
      >
        {compact ? (
          <span className={iconClassName} data-active={active || undefined}>
            <Group className="h-5 w-5" aria-hidden="true" />
          </span>
        ) : (
          <>
            <span className="min-w-0 truncate text-sm font-medium">{teamName}</span>
            <ControlChevron direction="down" />
          </>
        )}
      </Button>
      <StudioPopover placement={compact ? "right top" : "bottom end"} offset={6}
        className="w-52 max-w-[calc(100vw-1rem)] p-2" data-testid="sidebar-team-menu">
        <StudioMenu aria-label={`Team actions: ${teamName}`} className="space-y-1"
          onAction={(key) => {
            setOpen(false);
            if (key === "overview") onOpenOverview();
            if (key === "settings") onOpenSettings?.();
          }}>
          <StudioMenuItem id="overview" textValue="Team overview" data-testid="sidebar-team-menu-overview">
            <MenuItemContent startClassName={MENU_ICON_CLASS} start={<Group aria-hidden="true" />}>Team overview</MenuItemContent>
          </StudioMenuItem>
          {onOpenSettings ? <StudioMenuItem id="settings" textValue="Team settings" data-testid="sidebar-team-menu-settings">
            <MenuItemContent startClassName={MENU_ICON_CLASS} start={<Settings aria-hidden="true" />}>Team settings</MenuItemContent>
          </StudioMenuItem> : null}
        </StudioMenu>
      </StudioPopover>
    </MenuTrigger>
  );
}
