import { MoreHoriz } from "iconoir-react";
import type { RefObject } from "react";
import { DialogTrigger } from "react-aria-components";
import { Button } from "../../../components/Button";
import { MenuItemContent } from "../../../components/MenuItemContent";
import { StudioDialogPopover } from "../../../components/aria/StudioPopover";
import { StudioMenu, StudioMenuItem } from "../../../components/aria/StudioMenu";
import type { StudioNavItem, StudioPanel } from "../types";

type StudioSidebarMorePanelsProps = {
  triggerRef?: RefObject<HTMLButtonElement | null>;
  resolvedMoreItems: StudioNavItem[];
  showInlineMoreItems: boolean;
  inlineMoreItems: StudioNavItem[];
  collapsedMoreItems: StudioNavItem[];
  activePanel: StudioPanel;
  showLabels: boolean;
  isLargeScreen: boolean;
  sidebarRowLayoutClass: string;
  moreMenuOpen: boolean;
  onMoreMenuOpenChange: (open: boolean) => void;
  onMobileMoreToggle: () => void;
  onMoreMenuAction: (key: string | number) => void;
  getSidebarRowToneClass: (active: boolean) => string;
  getSidebarNavIconClass: (active: boolean, accentClass?: string) => string;
  isMorePanelActive: boolean;
  moreSwitcherOpen: boolean;
  moreIndicator: StudioNavItem["indicator"] | null;
  selectedMoreKeys: string[];
};

function renderIndicator(indicator: StudioNavItem["indicator"] | null, testId?: string) {
  if (!indicator) {
    return null;
  }
  if (indicator.tone === "danger") {
    return (
      <span
        aria-hidden="true"
        title={indicator.label}
        data-testid={testId}
        className="absolute -right-0.5 -top-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-rose-500 text-3xs font-semibold text-white ring-2 ring-slate-50 dark:ring-[color:var(--color-studio-dark-rail)]"
      >
        !
      </span>
    );
  }
  return (
    <span
      aria-hidden="true"
      title={indicator.label}
      data-testid={testId}
      className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-amber-400 ring-2 ring-slate-50 dark:ring-[color:var(--color-studio-dark-rail)]"
    />
  );
}

export function StudioSidebarMorePanels({
  triggerRef,
  resolvedMoreItems,
  showInlineMoreItems,
  inlineMoreItems,
  collapsedMoreItems,
  activePanel,
  showLabels,
  isLargeScreen,
  sidebarRowLayoutClass,
  moreMenuOpen,
  onMoreMenuOpenChange,
  onMobileMoreToggle,
  onMoreMenuAction,
  getSidebarRowToneClass,
  getSidebarNavIconClass,
  isMorePanelActive,
  moreSwitcherOpen,
  moreIndicator,
  selectedMoreKeys,
}: StudioSidebarMorePanelsProps) {
  if (resolvedMoreItems.length === 0) {
    return null;
  }

  return (
    <li>
      <div className="space-y-1">
        {showInlineMoreItems ? (
          <ul className="space-y-1" aria-label="More panels">
            {inlineMoreItems.map((item) => {
              const IconComponent = item.icon;
              const isActive = item.id === activePanel;
              const badgeCount = item.badge?.count ?? 0;
              const badgeText = badgeCount > 9 ? "9+" : badgeCount.toString();
              return (
                <li key={`panel:${item.id}`}>
                  <Button
                    onPress={() => onMoreMenuAction(`panel:${item.id}`)}
                    variant="ghost"
                    size="sm"
                    radius="lg"
                    fullWidth
                    data-testid={`sidebar-more-item-${item.id}`}
                    className={[
                      "group/item relative transition focus-visible:ring-offset-0",
                      sidebarRowLayoutClass,
                      getSidebarRowToneClass(isActive),
                    ].join(" ")}
                    aria-current={isActive ? "page" : undefined}
                    aria-label={showLabels ? undefined : item.label}
                    title={showLabels ? undefined : item.label}
                  >
                    <span className={getSidebarNavIconClass(isActive, item.accent)}>
                      <IconComponent className="text-base" aria-hidden="true" />
                      {renderIndicator(item.indicator)}
                    </span>
                    {showLabels ? (
                      <span className="flex flex-1 items-center justify-between gap-2 text-sm font-medium text-slate-700 dark:text-slate-200">
                        <span>{item.label}</span>
                        {item.badge && badgeCount > 0 ? (
                          <span className="rounded-full bg-slate-900/5 px-2 py-0.5 text-xxs font-semibold text-slate-600 dark:bg-white/10 dark:text-slate-200">
                            {badgeText}
                          </span>
                        ) : null}
                      </span>
                    ) : null}
                  </Button>
                </li>
              );
            })}
          </ul>
        ) : null}
        {collapsedMoreItems.length > 0 ? (
          isLargeScreen ? (
            <DialogTrigger isOpen={moreMenuOpen} onOpenChange={onMoreMenuOpenChange}>
              <Button
                variant="ghost"
                size="sm"
                radius="lg"
                fullWidth
                data-testid="sidebar-nav-more"
                aria-label="More"
                title={showLabels ? undefined : "More"}
                className={[
                  "group/item relative py-1.5 transition focus-visible:ring-offset-0",
                  sidebarRowLayoutClass,
                  getSidebarRowToneClass(moreSwitcherOpen || isMorePanelActive),
                ].join(" ")}
                aria-current={isMorePanelActive ? "page" : undefined}
                aria-haspopup="dialog"
              >
                <span className={getSidebarNavIconClass(moreSwitcherOpen || isMorePanelActive)}>
                  <MoreHoriz className="text-base" aria-hidden="true" />
                  {renderIndicator(moreIndicator, "sidebar-nav-more-indicator")}
                </span>
                {showLabels ? (
                  <span className="flex flex-1 items-center justify-between gap-2 text-sm font-medium text-slate-700 dark:text-slate-200">
                    <span>More</span>
                  </span>
                ) : null}
              </Button>
              <StudioDialogPopover
                placement="right bottom"
                offset={8}
                className="w-60 p-3 text-sm"
                data-testid="sidebar-more-menu"
              >
                <p className="px-1 text-3xs uppercase tracking-wide text-slate-500 dark:text-slate-400">
                  More
                </p>
                <StudioMenu
                  aria-label="More panels"
                  selectionMode="single"
                  selectedKeys={selectedMoreKeys}
                  onAction={onMoreMenuAction}
                  className="mt-2 space-y-1"
                >
                  {collapsedMoreItems.map((item) => {
                    const IconComponent = item.icon;
                    return (
                      <StudioMenuItem
                        key={`panel:${item.id}`}
                        id={`panel:${item.id}`}
                        data-testid={`sidebar-more-item-${item.id}`}
                        className="text-sm"
                      >
                        <MenuItemContent start={<IconComponent aria-hidden="true" />}>
                          {item.label}
                        </MenuItemContent>
                      </StudioMenuItem>
                    );
                  })}
                </StudioMenu>
              </StudioDialogPopover>
            </DialogTrigger>
          ) : (
            <Button
              ref={triggerRef}
              variant="ghost"
              size="sm"
              radius="lg"
              fullWidth
              data-testid="sidebar-nav-more"
              aria-label="More"
              title={showLabels ? undefined : "More"}
              onPress={onMobileMoreToggle}
              className={[
                "group/item relative py-1.5 transition focus-visible:ring-offset-0",
                sidebarRowLayoutClass,
                getSidebarRowToneClass(moreSwitcherOpen || isMorePanelActive),
              ].join(" ")}
              aria-current={isMorePanelActive ? "page" : undefined}
              aria-haspopup="dialog"
            >
              <span className={getSidebarNavIconClass(moreSwitcherOpen || isMorePanelActive)}>
                <MoreHoriz className="text-base" aria-hidden="true" />
                {renderIndicator(moreIndicator, "sidebar-nav-more-indicator")}
              </span>
              {showLabels ? (
                <span className="flex flex-1 items-center justify-between gap-2 text-sm font-medium text-slate-700 dark:text-slate-200">
                  <span>More</span>
                </span>
              ) : null}
            </Button>
          )
        ) : null}
      </div>
    </li>
  );
}
