import { ChatBubble, Download, LogOut, Refresh, Settings, SmartphoneDevice, User, Xmark } from "iconoir-react";
import { DialogTrigger } from "react-aria-components";
import { useId, type MouseEvent, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import { Button, IconButton } from "../../../components/Button";
import { ControlChevron } from "../../../components/ControlChevron";
import { MenuItemContent } from "../../../components/MenuItemContent";
import { Text } from "../../../components/Text";
import { StudioDialogPopover } from "../../../components/aria/StudioPopover";
import { StudioMenu, StudioMenuItem } from "../../../components/aria/StudioMenu";
import { DRAWER_SECTION_LABEL_CLASS } from "../../../components/listRowStyles";
import { DARK_RAIL_HOVER_CLASS } from "../../../theme/darkSurfaces";
import { StudioDialogModal } from "../../../components/aria/StudioModal";
import { useNativeBackButtonAction } from "../../../native/useNativeBackButtonAction";
import type { AppReleaseMetadata, AppUpdatePresentation } from "../../../updates/releaseMetadata";
import { UpdateStatusDialog } from "./UpdateStatusDialog";

type CollapsedSidebarDensity = "comfortable" | "compact" | "dense";

type StudioSidebarAccountSectionProps = {
  footerRef: RefObject<HTMLDivElement | null>;
  presentation?: "sidebar" | "header";
  showLabels: boolean;
  collapsedSidebarDensity: CollapsedSidebarDensity;
  profileMenuOpen: boolean;
  onProfileMenuOpenChange: (open: boolean) => void;
  avatarUrl: string | null;
  initials: string;
  displayName: string;
  accountSubtitle: string | null;
  installEntry: { kind: "desktop"; version: string } | { kind: "mobile-soon" } | null;
  isLargeScreen: boolean;
  shouldRenderUpdateEntry: boolean;
  updatePresentation: AppUpdatePresentation | null;
  onUpdateEntryClick: () => void;
  onUpdateEntryContextMenu: (event: MouseEvent<HTMLButtonElement>) => void;
  onUpdateEntryPointerDown: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  clearUpdateLongPress: () => void;
  onOpenProfileSettings?: () => void;
  onOpenSupport?: () => void;
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
  presentation = "sidebar",
  showLabels,
  collapsedSidebarDensity,
  profileMenuOpen,
  onProfileMenuOpenChange,
  avatarUrl,
  initials,
  displayName,
  accountSubtitle,
  installEntry,
  isLargeScreen,
  shouldRenderUpdateEntry,
  updatePresentation,
  onUpdateEntryClick,
  onUpdateEntryContextMenu,
  onUpdateEntryPointerDown,
  clearUpdateLongPress,
  onOpenProfileSettings,
  onOpenSupport,
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
  const header = presentation === "header";
  const sheet = !isLargeScreen;
  const showFooterInstall = !header && installEntry?.kind === "desktop" && isLargeScreen;
  useNativeBackButtonAction(profileMenuOpen, () => onProfileMenuOpenChange(false), 250);
  const accessibleUpdateStatus =
    shouldRenderUpdateEntry &&
    (updatePresentation?.emphasis === "attention" || updatePresentation?.emphasis === "danger")
      ? `${updatePresentation.title}. ${updatePresentation.detail}.`
      : null;
  const profileStatusDescriptionIds = accessibleUpdateStatus ? updateStatusDescriptionId : undefined;

  const menuContent = (
    <>
      <div className="flex items-center gap-3 pr-1">
        <div className={`${avatarShellClassName("h-10 w-10")} shrink-0`}>
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
        {sheet ? <IconButton variant="ghost" aria-label="Close account menu" onPress={() => onProfileMenuOpenChange(false)} className="ml-auto !min-h-11 !min-w-11 shrink-0"><Xmark className="h-5 w-5" aria-hidden="true" /></IconButton> : null}
      </div>

      <div className="mt-3 space-y-2">

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
              className="flex min-h-11 w-full items-center justify-between rounded-lg px-2.5 py-1.5 text-left text-sm text-slate-600 transition hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 dark:text-slate-300 dark:hover:bg-[var(--color-studio-dark-rail-hover)]"
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
            if (action === "profile:support") {
              onProfileMenuOpenChange(false);
              onOpenSupport?.();
              return;
            }
            if (action === "profile:signout") {
              onProfileMenuOpenChange(false);
              onSignOut?.();
            }
          }}
          className={sheet ? "space-y-1 [&>[role=menuitem]]:min-h-12" : "space-y-1"}
        >
          {onOpenProfileSettings ? (
            <StudioMenuItem id="profile:settings" data-testid="profile-settings-button">
              <MenuItemContent start={<User aria-hidden="true" />}>
                Your settings
              </MenuItemContent>
            </StudioMenuItem>
          ) : null}
          {installEntry && !showFooterInstall ? (
            <StudioMenuItem
              id="profile:install"
              href={installEntry.kind === "mobile-soon" ? "/install#mobile" : "/install#desktop"}
              target="_blank"
              rel="noreferrer"
              data-testid="profile-install-button"
            >
              <MenuItemContent
                start={installEntry.kind === "mobile-soon" ? <SmartphoneDevice aria-hidden="true" /> : <Download aria-hidden="true" />}
                end={installEntry.kind === "mobile-soon" ? <Text as="span" variant="caption" tone="muted">Soon</Text> : undefined}
              >
                {installEntry.kind === "mobile-soon" ? "Get the app" : "Get desktop app"}
              </MenuItemContent>
            </StudioMenuItem>
          ) : null}
          {onOpenSupport ? (
            <StudioMenuItem id="profile:support" data-testid="profile-support-button">
              <MenuItemContent start={<ChatBubble aria-hidden="true" />}>
                Support
              </MenuItemContent>
            </StudioMenuItem>
          ) : null}
          <StudioMenuItem id="profile:signout" isDisabled={!onSignOut}>
            <MenuItemContent start={<LogOut aria-hidden="true" />}>
              Sign out
            </MenuItemContent>
          </StudioMenuItem>
        </StudioMenu>
      </div>
      <details className="group/profile-advanced mt-2 border-t border-slate-200/70 pt-2 dark:border-[color:var(--color-studio-dark-divider)]">
        <summary className="flex min-h-11 cursor-pointer items-center rounded-lg px-2.5 py-2 text-xs text-slate-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/40 pointer-coarse:min-h-11 dark:text-slate-400">Advanced<span className="ml-auto transition-transform group-open/profile-advanced:rotate-180 motion-reduce:transition-none"><ControlChevron /></span></summary>
        <Button variant="ghost" fullWidth className="!justify-start px-2.5 pointer-coarse:min-h-11" data-testid="profile-diagnostics-button" onPress={() => { onProfileMenuOpenChange(false); onOpenDiagnostics(); }}>
          <Settings className="h-4 w-4" aria-hidden="true" />Diagnostics
          {hasAppLogErrors ? <span className="ml-auto text-xs text-slate-500 dark:text-slate-400">Errors recorded</span> : null}
        </Button>
      </details>
    </>
  );

  return (
    <div
      ref={footerRef}
      className={header ? "shrink-0" : [
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
      {showFooterInstall ? (
        <a
          href="/install#desktop"
          target="_blank"
          rel="noreferrer"
          aria-label="Get desktop app"
          title={`Get desktop app · v${installEntry.version}`}
          data-testid="sidebar-get-desktop"
          className={[
            "inline-flex min-h-10 items-center rounded-lg text-sm font-medium text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-400/60 dark:text-slate-400 dark:hover:text-slate-100 pointer-coarse:min-h-11",
            DARK_RAIL_HOVER_CLASS,
            showLabels ? "w-full gap-3 px-3" : "w-10 justify-center",
          ].join(" ")}
        >
          <span className={showLabels ? "flex h-9 w-9 shrink-0 items-center justify-center" : undefined}>
            <Download className="h-5 w-5" aria-hidden="true" />
          </span>
          {showLabels ? <span className="min-w-0 truncate">Get desktop app</span> : null}
        </a>
      ) : null}
      <DialogTrigger
        isOpen={profileMenuOpen}
        onOpenChange={(open) => onProfileMenuOpenChange(open)}
      >
        {header ? (
          <IconButton variant="ghost" radius="full" aria-label="Open profile menu" title="Open profile menu"
            data-testid="topbar-profile-button" aria-describedby={profileStatusDescriptionIds}
            className="!min-h-12 !min-w-11 shrink-0 p-1">
            <span className={avatarShellClassName("h-8 w-8")} aria-hidden="true">
              {avatarUrl ? <img src={avatarUrl} alt="" draggable={false} className="h-full w-full object-cover" /> : initials}
              {shouldRenderUpdateEntry ? <ProfileUpdateIndicator presentation={updatePresentation} /> : null}
            </span>
          </IconButton>
        ) : showLabels ? (
          <Button
            variant="ghost"
            size="sm"
            radius="lg"
            className="w-full justify-start gap-3 text-left"
            data-testid="sidebar-profile-menu"
            aria-haspopup="dialog"
            aria-label="Open profile menu"
            aria-describedby={profileStatusDescriptionIds}
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
            aria-describedby={profileStatusDescriptionIds}
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
        {sheet ? (
          <StudioDialogModal isDismissable dialogAriaLabel="Your account" data-testid="profile-account-sheet"
            className="!items-end !p-0" modalClassName="!max-w-lg !rounded-b-none max-h-[90dvh] overflow-y-auto"
            dialogClassName="p-4 pb-[max(1rem,var(--instafy-safe-area-inset-bottom,0px))]">
            {menuContent}
          </StudioDialogModal>
        ) : (
          <StudioDialogPopover placement="top start" offset={10} className="w-72 max-w-[calc(100vw-1rem)] p-3 text-sm">
            {menuContent}
          </StudioDialogPopover>
        )}
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
