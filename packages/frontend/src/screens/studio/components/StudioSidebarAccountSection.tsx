import { BellNotification, BellOff, Download, HalfMoon, LogOut, Refresh, Settings, SunLight, User } from "iconoir-react";
import { DialogTrigger } from "react-aria-components";
import { useId, type MouseEvent, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import { Button, IconButton } from "../../../components/Button";
import { MenuItemContent } from "../../../components/MenuItemContent";
import { SegmentedControl } from "../../../components/SegmentedControl";
import { Text } from "../../../components/Text";
import { StudioDialogPopover } from "../../../components/aria/StudioPopover";
import { StudioMenu, StudioMenuItem } from "../../../components/aria/StudioMenu";
import { DRAWER_SECTION_LABEL_CLASS } from "../../../components/listRowStyles";
import type { ResolvedTheme } from "../../../theme/ThemeProvider";
import type { AppReleaseMetadata, AppUpdatePresentation } from "../../../updates/releaseMetadata";
import { UpdateStatusDialog } from "./UpdateStatusDialog";

type CollapsedSidebarDensity = "comfortable" | "compact" | "dense";

type StudioSidebarAccountSectionProps = {
  footerRef: RefObject<HTMLDivElement | null>;
  showLabels: boolean;
  collapsedSidebarDensity: CollapsedSidebarDensity;
  profileMenuOpen: boolean;
  onProfileMenuOpenChange: (open: boolean) => void;
  avatarUrl: string | null;
  initials: string;
  displayName: string;
  accountSubtitle: string | null;
  resolvedTheme: ResolvedTheme;
  onThemeModeChange: (value: ResolvedTheme) => void;
  showInstallEntry: boolean;
  shouldRenderUpdateEntry: boolean;
  updatePresentation: AppUpdatePresentation | null;
  onUpdateEntryClick: () => void;
  onUpdateEntryContextMenu: (event: MouseEvent<HTMLButtonElement>) => void;
  onUpdateEntryPointerDown: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  clearUpdateLongPress: () => void;
  onOpenProfileSettings?: () => void;
  notificationsPending: boolean;
  notificationsEnabled: boolean;
  onToggleNotifications: () => void;
  onOpenDiagnostics: () => void;
  hasAppLogErrors: boolean;
  onSignOut?: () => void;
  updateDialogOpen: boolean;
  onUpdateDialogOpenChange: (open: boolean) => void;
  updateMetadata: AppReleaseMetadata | null;
  updateDialogShowDetails: boolean;
  onUpdateDialogShowDetailsChange: (next: boolean) => void;
  onUpdatePrimaryAction: () => void;
  updateActionPending: boolean;
};

function avatarShellClassName(sizeClass: string) {
  return `relative flex ${sizeClass} items-center justify-center overflow-hidden rounded-full border border-slate-200 bg-slate-50 text-sm font-medium text-slate-700 dark:border-[color:var(--color-studio-dark-raised-control-border)] dark:bg-[var(--color-studio-dark-raised-control)] dark:text-slate-200`;
}

function ProfileUpdateIndicator({
  presentation,
}: {
  presentation: AppUpdatePresentation | null;
}) {
  const tone =
    presentation?.emphasis === "danger"
      ? "danger"
      : presentation?.emphasis === "attention"
        ? "attention"
        : null;
  if (!tone) {
    return null;
  }
  return (
    <span
      className={[
        "absolute right-0.5 top-0.5 z-10 inline-flex h-2.5 w-2.5 rounded-full ring-2 ring-white dark:ring-[var(--color-studio-dark-rail)]",
        tone === "danger" ? "bg-rose-500" : "bg-amber-500",
      ].join(" ")}
      data-testid="profile-update-indicator"
      data-tone={tone}
      title={presentation?.title}
      aria-hidden="true"
    />
  );
}

export function StudioSidebarAccountSection({
  footerRef,
  showLabels,
  collapsedSidebarDensity,
  profileMenuOpen,
  onProfileMenuOpenChange,
  avatarUrl,
  initials,
  displayName,
  accountSubtitle,
  resolvedTheme,
  onThemeModeChange,
  showInstallEntry,
  shouldRenderUpdateEntry,
  updatePresentation,
  onUpdateEntryClick,
  onUpdateEntryContextMenu,
  onUpdateEntryPointerDown,
  clearUpdateLongPress,
  onOpenProfileSettings,
  notificationsPending,
  notificationsEnabled,
  onToggleNotifications,
  onOpenDiagnostics,
  hasAppLogErrors,
  onSignOut,
  updateDialogOpen,
  onUpdateDialogOpenChange,
  updateMetadata,
  updateDialogShowDetails,
  onUpdateDialogShowDetailsChange,
  onUpdatePrimaryAction,
  updateActionPending,
}: StudioSidebarAccountSectionProps) {
  const updateStatusDescriptionId = useId();
  const accessibleUpdateStatus =
    shouldRenderUpdateEntry &&
    (updatePresentation?.emphasis === "attention" || updatePresentation?.emphasis === "danger")
      ? `${updatePresentation.title}. ${updatePresentation.detail}.`
      : null;

  return (
    <div
      ref={footerRef}
      className={[
        "shrink-0 flex flex-col",
        showLabels
          ? "gap-3 pt-6"
          : collapsedSidebarDensity === "dense"
            ? "gap-1.5 pt-2"
            : collapsedSidebarDensity === "compact"
              ? "gap-2 pt-3"
              : "gap-3 pt-6",
        showLabels ? "items-stretch px-2" : "items-center",
      ].join(" ")}
    >
      <span
        id={updateStatusDescriptionId}
        className="sr-only"
        role="status"
        aria-live="polite"
      >
        {accessibleUpdateStatus}
      </span>
      <DialogTrigger
        isOpen={profileMenuOpen}
        onOpenChange={(open) => onProfileMenuOpenChange(open)}
      >
        {showLabels ? (
          <Button
            variant="ghost"
            size="sm"
            radius="lg"
            className="w-full justify-start gap-3 text-left"
            data-testid="sidebar-profile-menu"
            aria-haspopup="dialog"
            aria-describedby={accessibleUpdateStatus ? updateStatusDescriptionId : undefined}
          >
            <span className={avatarShellClassName("h-9 w-9")}>
              {avatarUrl ? (
                <img src={avatarUrl} alt="" className="h-full w-full object-cover" />
              ) : (
                initials
              )}
              {shouldRenderUpdateEntry ? (
                <ProfileUpdateIndicator presentation={updatePresentation} />
              ) : null}
            </span>
            <span className="min-w-0 flex-1">
              <Text as="span" variant="bodyStrong" tone="primary" className="block truncate">
                {displayName}
              </Text>
              {accountSubtitle ? (
                <Text as="span" variant="caption" tone="muted" className="block truncate">
                  {accountSubtitle}
                </Text>
              ) : null}
            </span>
          </Button>
        ) : (
          <IconButton
            variant="ghost"
            size={collapsedSidebarDensity === "dense" ? "xs" : "sm"}
            radius="lg"
            className="relative overflow-hidden"
            data-testid="sidebar-profile-menu"
            aria-haspopup="dialog"
            aria-label="Open profile menu"
            aria-describedby={accessibleUpdateStatus ? updateStatusDescriptionId : undefined}
          >
            {avatarUrl ? (
              <img src={avatarUrl} alt="" className="h-full w-full object-cover" />
            ) : (
              initials
            )}
            {shouldRenderUpdateEntry ? (
              <ProfileUpdateIndicator presentation={updatePresentation} />
            ) : null}
          </IconButton>
        )}
        <StudioDialogPopover placement="top start" offset={10} className="w-64 p-3 text-sm">
          <div className="flex items-center gap-3">
            <div className={avatarShellClassName("h-10 w-10")}>
              {avatarUrl ? (
                <img src={avatarUrl} alt="" className="h-full w-full object-cover" />
              ) : (
                initials
              )}
            </div>
            <div className="min-w-0">
              <Text
                as="p"
                variant="label"
                tone="subtle"
                className={["truncate", DRAWER_SECTION_LABEL_CLASS].join(" ")}
              >
                Signed in
              </Text>
              <Text as="p" variant="bodyStrong" tone="primary" className="truncate">
                {displayName}
              </Text>
              {accountSubtitle ? (
                <Text as="p" variant="caption" tone="muted" className="truncate">
                  {accountSubtitle}
                </Text>
              ) : null}
            </div>
          </div>

          <div className="mt-3 space-y-2">
            <div className="px-1">
              <SegmentedControl<ResolvedTheme>
                value={resolvedTheme}
                onChange={onThemeModeChange}
                options={[
                  {
                    value: "light",
                    ariaLabel: "Theme: Light",
                    label: <SunLight className="h-4 w-4" aria-hidden="true" />,
                  },
                  {
                    value: "dark",
                    ariaLabel: "Theme: Dark",
                    label: <HalfMoon className="h-4 w-4" aria-hidden="true" />,
                  },
                ]}
                size="sm"
              />
            </div>

            {shouldRenderUpdateEntry ? (
              <div className="px-1">
                <button
                  type="button"
                  onClick={onUpdateEntryClick}
                  onContextMenu={onUpdateEntryContextMenu}
                  onPointerDown={onUpdateEntryPointerDown}
                  onPointerUp={clearUpdateLongPress}
                  onPointerCancel={clearUpdateLongPress}
                  onPointerLeave={clearUpdateLongPress}
                  className="flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 text-left text-sm text-slate-600 transition hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 dark:text-slate-300 dark:hover:bg-[var(--color-studio-dark-rail-hover)]"
                  data-testid="profile-updates-button"
                >
                  <span className="flex min-w-0 flex-1 items-center gap-2">
                    <span className="shrink-0 text-slate-400 dark:text-slate-300">
                      <Refresh className="h-4 w-4" aria-hidden="true" />
                    </span>
                    <span className="min-w-0 flex-1 truncate">
                      {updatePresentation?.title ?? "Updates"}
                    </span>
                  </span>
                  <span className="flex shrink-0 items-center gap-2">
                    {updatePresentation?.emphasis === "attention" ? (
                      <span className="inline-flex h-2 w-2 rounded-full bg-amber-500" aria-hidden="true" />
                    ) : updatePresentation?.emphasis === "danger" ? (
                      <span className="inline-flex h-2 w-2 rounded-full bg-rose-500" aria-hidden="true" />
                    ) : null}
                    <span className="text-xs text-slate-400 dark:text-slate-500">
                      {updatePresentation?.detail ?? "Check now"}
                    </span>
                  </span>
                </button>
              </div>
            ) : null}

            <StudioMenu
              aria-label="Account menu"
              onAction={(key) => {
                const action = String(key);
                if (action === "profile:settings") {
                  onProfileMenuOpenChange(false);
                  onOpenProfileSettings?.();
                  return;
                }
                if (action === "profile:notifications") {
                  void onToggleNotifications();
                  return;
                }
                if (action === "profile:diagnostics") {
                  onProfileMenuOpenChange(false);
                  onOpenDiagnostics();
                  return;
                }
                if (action === "profile:signout") {
                  onProfileMenuOpenChange(false);
                  onSignOut?.();
                }
              }}
              className="space-y-1"
            >
              {onOpenProfileSettings ? (
                <StudioMenuItem id="profile:settings" data-testid="profile-settings-button">
                  <MenuItemContent start={<User aria-hidden="true" />}>
                    Profile settings
                  </MenuItemContent>
                </StudioMenuItem>
              ) : null}
              {showInstallEntry ? (
                <StudioMenuItem
                  id="profile:install"
                  href="/install#desktop"
                  target="_blank"
                  rel="noreferrer"
                  data-testid="profile-install-button"
                >
                  <MenuItemContent start={<Download aria-hidden="true" />}>
                    Install Instafy
                  </MenuItemContent>
                </StudioMenuItem>
              ) : null}
              <StudioMenuItem
                id="profile:notifications"
                isDisabled={notificationsPending}
                data-testid="notifications-toggle-button"
              >
                <MenuItemContent
                  start={
                    notificationsEnabled ? (
                      <BellOff aria-hidden="true" />
                    ) : (
                      <BellNotification aria-hidden="true" />
                    )
                  }
                >
                  {notificationsEnabled ? "Disable notifications" : "Enable notifications"}
                </MenuItemContent>
              </StudioMenuItem>
              <StudioMenuItem id="profile:diagnostics" data-testid="profile-diagnostics-button">
                <MenuItemContent
                  start={<Settings aria-hidden="true" />}
                  end={
                    hasAppLogErrors ? (
                      <span className="inline-flex h-2 w-2 rounded-full bg-rose-500" aria-hidden="true" />
                    ) : undefined
                  }
                  endClassName="shrink-0"
                >
                  Diagnostics
                </MenuItemContent>
              </StudioMenuItem>
              <StudioMenuItem id="profile:signout" isDisabled={!onSignOut}>
                <MenuItemContent start={<LogOut aria-hidden="true" />}>
                  Sign out
                </MenuItemContent>
              </StudioMenuItem>
            </StudioMenu>
          </div>
        </StudioDialogPopover>
      </DialogTrigger>
      <UpdateStatusDialog
        isOpen={updateDialogOpen}
        onOpenChange={onUpdateDialogOpenChange}
        metadata={updateMetadata}
        showDetails={updateDialogShowDetails}
        onShowDetailsChange={onUpdateDialogShowDetailsChange}
        onPrimaryAction={onUpdatePrimaryAction}
        actionPending={updateActionPending}
      />
    </div>
  );
}
