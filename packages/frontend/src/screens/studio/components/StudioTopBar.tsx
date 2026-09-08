import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { desktopTitleBarFree } from "../../../lib/desktopShell";
import { DialogTrigger } from "react-aria-components";
import {
  Cube,
  MoreHoriz,
  NavArrowLeft,
  Pin,
  SidebarCollapse,
  SidebarExpand,
  Xmark
} from "iconoir-react";
import { Button, IconButton } from "../../../components/Button";
import { Badge } from "../../../components/Badge";
import { Text } from "../../../components/Text";
import { HomeIcon } from "../../../components/AppIcons";
import { ControlChevron } from "../../../components/ControlChevron";
import { StudioDialogPopover } from "../../../components/aria/StudioPopover";
import { useProfile } from "../../../profile/ProfileProvider";
import { getOrgInitials } from "../../../org/orgNaming";
import { useProject } from "../../../projects/useProject";
import { useProjects } from "../../../projects/useProjects";
import { useRuntime } from "../../../runtime/useRuntime";
import { WorkspaceTabs } from "../../../workspace/WorkspaceTabs";
import { useWorkspaceTabs } from "../../../workspace/WorkspaceTabsProvider";
import { useConversations } from "../../../conversations/ConversationsProvider";
import {
  desktopSpeechTunnelBridgeAvailable,
  readDesktopSpeechTunnelStatus,
  type DesktopSpeechTunnelBridgeStatus,
} from "../../../desktop/voiceTunnel/client";
import {
  desktopVoiceHostBridgeAvailable,
  readDesktopVoiceHostStatus,
  type DesktopVoiceHostBridgeStatus,
} from "../../../desktop/voiceHost/client";
import { describeDesktopVoiceStatusSummary } from "../../../desktop/voiceStatusSummary";
import {
  DARK_CANVAS_CLASS,
  DARK_CONTROL_HOVER_CLASS,
  DARK_DIVIDER_BORDER_CLASS,
  DARK_RAIL_BLUR_BG_CLASS,
  DARK_RAIL_HOVER_CLASS,
  DARK_RAIL_MUTED_BG_CLASS,
} from "../../../theme/darkSurfaces";
import { useWorkspaceControls } from "../workspaceControls";
import { useStudioNavigationPosture } from "../useStudioNavigationPosture";
import { StudioNewChatButton } from "./StudioNewChatButton";

const COMPACT_TAB_SELECTOR_CLASS =
  "h-10 min-w-0 justify-between gap-2 rounded-xl !border-transparent !bg-slate-100 px-2.5 !text-slate-950 !shadow-none hover:!bg-slate-100 data-[hovered]:!bg-slate-100 focus-visible:ring-white/16 focus-visible:ring-offset-white max-[375px]:min-h-11 dark:!bg-white/[0.06] dark:!text-slate-50 dark:hover:!bg-white/[0.09] dark:data-[hovered]:!bg-white/[0.09] dark:focus-visible:ring-white/16 dark:focus-visible:ring-offset-[var(--color-studio-dark-rail)]";

export function StudioTopBar({ notificationBell }: { notificationBell?: ReactNode } = {}) {
  const {
    activeProjectName,
    onStartNewConversation,
    showChatActions = false,
    onToggleSidebar,
    sidebarCollapsed,
    sidebarOpen,
    onOpenProjectSettings,
    onOpenProfileSettings,
    onOpenHome,
    onOpenTeamSwitcher,
    onNavigateBack,
    navigationPage = "workspace",
    activeTeamName,
    activeTeamAvatarUrl,
    userEmail,
    topbarLocationOverride,
  } = useWorkspaceControls();
  const { activeProjectId } = useProjects();
  const { projectAccessBlocked } = useProject();
  const { profile } = useProfile();

  const [tabMenuOpen, setTabMenuOpen] = useState(false);
  const [desktopVoiceHostStatus, setDesktopVoiceHostStatus] = useState<DesktopVoiceHostBridgeStatus | null>(null);
  const [desktopSpeechTunnelStatus, setDesktopSpeechTunnelStatus] = useState<DesktopSpeechTunnelBridgeStatus | null>(null);
  const [desktopVoiceStatusLoading, setDesktopVoiceStatusLoading] = useState(false);

  const { tabs: workspaceTabs, activeTabId, focusTab, closeTab, keepTabOpen, requestUrlPush, openConversationTab } = useWorkspaceTabs();
  const { conversations } = useConversations();
  const { runtime } = useRuntime();
  const controllerProjectMissing = runtime.controllerProjectMissing || projectAccessBlocked;
  const shouldShowNewChat = showChatActions && Boolean(onStartNewConversation);
  const { isLargeScreen } = useStudioNavigationPosture();
  const isGlobalPage = navigationPage !== "workspace";

  const activeWorkspaceTab = useMemo(() => {
    if (!activeTabId) {
      return null;
    }
    return workspaceTabs.find((tab) => tab.id === activeTabId) ?? null;
  }, [activeTabId, workspaceTabs]);
  const activeConversation = useMemo(() => {
    if (activeWorkspaceTab?.kind !== "conversation") {
      return null;
    }
    return conversations.find((conversation) => conversation.localId === activeWorkspaceTab.conversationId) ?? null;
  }, [activeWorkspaceTab, conversations]);
  const parentConversation = useMemo(() => {
    const parentId = activeConversation?.parentConversationId?.trim() ?? "";
    if (!parentId) {
      return null;
    }
    return conversations.find((conversation) => conversation.controllerId === parentId || conversation.localId === parentId) ?? null;
  }, [activeConversation?.parentConversationId, conversations]);
  const topbarLocationTitle = topbarLocationOverride?.title ?? activeWorkspaceTab?.title ?? "Space";
  const handleOpenParentConversation = useCallback(() => {
    if (!parentConversation) {
      return;
    }
    requestUrlPush();
    openConversationTab(parentConversation.localId);
  }, [openConversationTab, parentConversation, requestUrlPush]);
  const desktopVoiceStatusEnabled =
    isLargeScreen &&
    Boolean(activeProjectId?.trim()) &&
    (desktopVoiceHostBridgeAvailable() || desktopSpeechTunnelBridgeAvailable());

  useEffect(() => {
    if (!desktopVoiceStatusEnabled) {
      setDesktopVoiceHostStatus(null);
      setDesktopSpeechTunnelStatus(null);
      setDesktopVoiceStatusLoading(false);
      return;
    }

    let cancelled = false;
    const refresh = async (initial: boolean) => {
      if (initial) {
        setDesktopVoiceStatusLoading(true);
      }
      try {
        const [hostStatus, tunnelStatus] = await Promise.all([
          desktopVoiceHostBridgeAvailable() ? readDesktopVoiceHostStatus() : Promise.resolve(null),
          desktopSpeechTunnelBridgeAvailable() ? readDesktopSpeechTunnelStatus() : Promise.resolve(null),
        ]);
        if (!cancelled) {
          setDesktopVoiceHostStatus(hostStatus);
          setDesktopSpeechTunnelStatus(tunnelStatus);
        }
      } finally {
        if (initial && !cancelled) {
          setDesktopVoiceStatusLoading(false);
        }
      }
    };

    void refresh(true);
    const intervalId = window.setInterval(() => {
      void refresh(false);
    }, 15000);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [desktopVoiceStatusEnabled]);

  const desktopVoiceStatusSummary = useMemo(
    () =>
      describeDesktopVoiceStatusSummary({
        activeProjectId,
        hostStatus: desktopVoiceHostStatus,
        tunnelStatus: desktopSpeechTunnelStatus,
        loading: desktopVoiceStatusLoading,
      }),
    [activeProjectId, desktopSpeechTunnelStatus, desktopVoiceHostStatus, desktopVoiceStatusLoading],
  );

  const handleSelectWorkspaceTab = useCallback(
    (tabId: string) => {
      if (!tabId) {
        return;
      }
      if (tabId === activeTabId) {
        setTabMenuOpen(false);
        return;
      }
      requestUrlPush();
      focusTab(tabId);
      setTabMenuOpen(false);
    },
    [activeTabId, focusTab, requestUrlPush],
  );

  const tabsMenu = (
    <StudioDialogPopover
      placement="bottom end"
      offset={8}
      className="w-72 p-2 text-sm"
      data-testid="topbar-tab-selector-menu"
    >
      <div className="max-h-80 space-y-1 overflow-auto">
        {workspaceTabs.map((tab) => {
          const isActive = tab.id === activeTabId;
          return (
            <div key={tab.id} className="flex items-center gap-2">
              <Button
                onPress={() => handleSelectWorkspaceTab(tab.id)}
                variant="ghost"
                size="sm"
                radius="xl"
                fullWidth
                data-testid={`topbar-tab-item-${tab.id}`}
                className={[
                  "flex-1 justify-start gap-2 focus-visible:ring-offset-0",
                  isActive
                    ? "bg-slate-100 text-slate-900 dark:bg-white/[0.07] dark:text-slate-50"
                    : `text-slate-600 hover:bg-slate-100 data-[hovered]:bg-slate-100 dark:text-slate-200 ${DARK_CONTROL_HOVER_CLASS}`,
                ].join(" ")}
                aria-current={isActive ? "page" : undefined}
              >
                <span aria-hidden="true" className="shrink-0 text-slate-400 dark:text-slate-400">
                  {tab.icon}
                </span>
                <span className={`min-w-0 flex-1 truncate text-left ${isLargeScreen && tab.kind === "conversation" && tab.preview ? "italic" : ""}`}>{tab.title}</span>
                {tab.badge ? (
                  <span
                    className="inline-flex h-4 min-w-[1rem] shrink-0 items-center justify-center rounded-full bg-primary-500/90 px-1 text-3xs font-semibold leading-none text-white dark:bg-primary-500/85"
                    aria-label={`${tab.badge} unread messages`}
                  >
                    {tab.badge}
                  </span>
                ) : null}
              </Button>
              {tab.kind === "conversation" && tab.preview ? (
                <IconButton
                  onPress={() => keepTabOpen(tab.id)}
                  variant="ghost"
                  size="xs"
                  radius="full"
                  aria-label={`Keep ${tab.title} open`}
                  title="Keep open"
                  data-testid={`topbar-tab-keep-open-${tab.id}`}
                  className={`text-slate-400 hover:bg-slate-100 data-[hovered]:bg-slate-100 dark:text-slate-400 ${DARK_CONTROL_HOVER_CLASS}`}
                >
                  <Pin className="h-4 w-4" aria-hidden="true" />
                </IconButton>
              ) : null}
              {tab.closable ? (
                <IconButton
                  onPress={() => closeTab(tab.id)}
                  variant="ghost"
                  size="xs"
                  radius="full"
                  aria-label={`Close ${tab.title}`}
                  data-testid={`topbar-tab-close-${tab.id}`}
                  className={`text-slate-400 hover:bg-slate-100 data-[hovered]:bg-slate-100 dark:text-slate-400 ${DARK_CONTROL_HOVER_CLASS}`}
                >
                  <Xmark className="h-4 w-4" aria-hidden="true" />
                </IconButton>
              ) : null}
            </div>
          );
        })}
      </div>
    </StudioDialogPopover>
  );

  const useDesktopTabChrome = isLargeScreen && !controllerProjectMissing;
  // Only the integrated macOS layout: elsewhere the header keeps the inset
  // (a real notch on iOS) and the shell keeps owning the drag strip.
  const titleBarFree = useDesktopTabChrome && desktopTitleBarFree();
  const hasDesktopTabs = useDesktopTabChrome && workspaceTabs.length > 0;
  const resolvedProjectName = activeProjectName || "Untitled Space";
  const resolvedTeamName = activeTeamName?.trim() || "Team & spaces";
  const profileInitials = (profile?.fullName?.trim() || userEmail?.trim() || "Account")
    .split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toUpperCase();
  const projectNameText = (
    <Text as="span" variant="bodyStrong" tone="primary" className="truncate">
      {resolvedProjectName}
    </Text>
  );
  const projectNameLabel = (
    <div className="flex min-w-0 items-center gap-2">
      <Cube className="text-base text-slate-400 dark:text-slate-400" aria-hidden="true" />
      {projectNameText}
      {desktopVoiceStatusSummary ? (
        <Button
          variant="ghost"
          size="xs"
          radius="full"
          onPress={() => {
            onOpenProjectSettings?.();
          }}
          isDisabled={!onOpenProjectSettings}
          data-testid="topbar-desktop-voice-status"
          className="h-7 min-w-0 gap-1 rounded-full px-2 shadow-none"
          title={desktopVoiceStatusSummary.detail}
        >
          <Badge tone={desktopVoiceStatusSummary.tone}>{desktopVoiceStatusSummary.label}</Badge>
        </Button>
      ) : null}
    </div>
  );
  const desktopEmptyStateTab = (
    <div
      className="inline-flex h-[48px] items-center gap-2 px-4 text-sm font-medium text-slate-900 dark:text-slate-50"
      data-testid="workspace-tabs-empty-state"
    >
      <Cube className="text-base text-slate-400 dark:text-slate-400" aria-hidden="true" />
      <span className="truncate">{resolvedProjectName}</span>
    </div>
  );
  const parentConversationButton = parentConversation ? (
    <IconButton
      onPress={handleOpenParentConversation}
      variant="ghost"
      radius="full"
      size="md"
      aria-label={`Back to parent conversation: ${parentConversation.title || "Conversation"}`}
      title={`Back to ${parentConversation.title || "parent conversation"}`}
      data-testid="topbar-parent-conversation-button"
      className={`h-10 w-10 bg-transparent text-slate-600 shadow-none max-[375px]:h-11 max-[375px]:w-11 dark:text-slate-200 ${DARK_RAIL_HOVER_CLASS}`}
    >
      <NavArrowLeft className="h-5 w-5" aria-hidden="true" />
    </IconButton>
  ) : null;

  const desktopTabActionButtonClassName =
    `h-[48px] w-12 flex-none rounded-none border border-transparent px-0 text-slate-500 transition-colors hover:bg-slate-100/80 hover:text-slate-900 data-[hovered]:bg-slate-100/80 data-[hovered]:text-slate-900 focus-visible:ring-white/16 focus-visible:ring-offset-white dark:text-slate-300 dark:hover:text-slate-50 dark:data-[hovered]:text-slate-50 dark:focus-visible:ring-white/16 dark:focus-visible:ring-offset-[var(--color-studio-dark-rail)] [aria-expanded=true]:dark:bg-white/[0.05] ${DARK_RAIL_HOVER_CLASS}`;
  const desktopParentConversationButton = parentConversation ? (
    <IconButton
      onPress={handleOpenParentConversation}
      variant="ghost"
      radius="none"
      size="sm"
      aria-label={`Back to parent conversation: ${parentConversation.title || "Conversation"}`}
      title={`Back to ${parentConversation.title || "parent conversation"}`}
      data-testid="topbar-parent-conversation-button"
      className={desktopTabActionButtonClassName}
    >
      <NavArrowLeft className="h-5 w-5" aria-hidden="true" />
    </IconButton>
  ) : null;
  const desktopSidebarButton = onToggleSidebar && navigationPage !== "home" && navigationPage !== "account" ? (
    <IconButton
      onPress={onToggleSidebar}
      variant="ghost"
      radius="none"
      size="sm"
      aria-label={sidebarCollapsed ? "Expand space navigation" : "Collapse space navigation"}
      aria-expanded={!sidebarCollapsed}
      data-testid="topbar-sidebar-toggle"
      className={desktopTabActionButtonClassName}
    >
      {sidebarCollapsed ? <SidebarExpand className="h-5 w-5" aria-hidden="true" />
        : <SidebarCollapse className="h-5 w-5" aria-hidden="true" />}
    </IconButton>
  ) : null;
  const mobileBackButton = parentConversationButton ?? (
    <IconButton
      onPress={onNavigateBack}
      isDisabled={!onNavigateBack}
      variant="ghost"
      radius="full"
      size="md"
      aria-label="Back"
      data-testid="topbar-back-button"
      className={`h-10 w-10 shrink-0 text-slate-600 max-[375px]:h-11 max-[375px]:w-11 dark:text-slate-200 ${DARK_RAIL_HOVER_CLASS}`}
    >
      <NavArrowLeft className="h-5 w-5" aria-hidden="true" />
    </IconButton>
  );

  return (
      <header
        aria-label={isGlobalPage ? "Team navigation" : `${resolvedProjectName} workspace navigation`}
        className={[
          "sticky top-0 z-40",
          // On a shell that has vacated the title bar the tab strip IS the
          // title bar, so the header must not pad itself clear of the window
          // buttons -- that padding is what produced an empty band across the
          // full width when only the leftmost ~70px was ever obstructed. The
          // rail absorbs the buttons instead. Everywhere else (iOS notches,
          // older shells) the inset still applies and must: it is the same
          // variable.
          titleBarFree ? "" : "pt-[var(--instafy-safe-area-inset-top)]",
          // With the shell's drag strip reduced to a corner, this row is the
          // window's drag handle. The class also opts interactive descendants
          // back out of dragging -- see instafy-titlebar-drag in tailwind.css.
          titleBarFree ? "instafy-titlebar-drag" : "",
          isLargeScreen
            ? useDesktopTabChrome
              ? `bg-white ${DARK_CANVAS_CLASS}`
              : `bg-white/95 ${DARK_RAIL_MUTED_BG_CLASS}`
            : `bg-white/70 backdrop-blur-md ${DARK_RAIL_BLUR_BG_CLASS}`,
          isLargeScreen
            ? useDesktopTabChrome
              // No bottom border in tab-chrome mode: the tab strip draws its own
              // baseline, and a 1px transparent border here still occupies a row
              // that the header's background paints through — which lands between
              // the active tab and the panel it fuses into and reads as a hairline
              // seam. The strip's baseline provides the divider instead.
              ? ""
              : `border-b border-slate-200/70 ${DARK_DIVIDER_BORDER_CLASS}`
            : hasDesktopTabs
              ? "border-b border-transparent"
              : "border-b border-transparent",
        ].join(" ")}
      >
      <Text
        as="span"
        variant="bodyStrong"
        tone="primary"
        className="sr-only"
        aria-hidden="true"
        data-testid="topbar-project-name"
      >
        {resolvedProjectName}
      </Text>
      {useDesktopTabChrome ? (
        <WorkspaceTabs
          leading={<>{desktopSidebarButton}{desktopParentConversationButton}</>}
          className="bg-transparent pr-0 pt-0 dark:bg-transparent"
          emptyStateContent={!hasDesktopTabs ? desktopEmptyStateTab : undefined}
          tabStripActions={
            shouldShowNewChat ? (
              <StudioNewChatButton
                testId="chat-new-conversation"
                size="sm"
                radius="none"
                className={desktopTabActionButtonClassName}
              />
            ) : null
          }
          actions={
            hasDesktopTabs ? (
              <div className="flex items-center">
                {notificationBell}
                <DialogTrigger
                  isOpen={tabMenuOpen}
                  onOpenChange={(open) => setTabMenuOpen((current) => (open && current ? false : open))}
                >
                  <IconButton
                    variant="ghost"
                    radius="none"
                    size="sm"
                    aria-label="Browse tabs"
                    data-testid="topbar-tab-overflow"
                    className={desktopTabActionButtonClassName}
                  >
                    <MoreHoriz className="h-5 w-5" aria-hidden="true" />
                  </IconButton>
                  {tabsMenu}
                </DialogTrigger>
              </div>
            ) : notificationBell
          }
        />
      ) : isLargeScreen ? (
        <div className="flex items-center gap-2 px-4 py-2 sm:px-5">
          {desktopSidebarButton}
          {parentConversationButton}
          <div className="min-w-0 flex-1">{projectNameLabel}</div>
          {shouldShowNewChat ? <StudioNewChatButton /> : null}
          {notificationBell}
        </div>
      ) : isGlobalPage ? (
        <div className="flex items-center gap-2 px-4 py-2 max-[375px]:gap-1 max-[375px]:px-3" data-testid="topbar-global-navigation">
          <IconButton
            onPress={onOpenHome}
            isDisabled={!onOpenHome}
            variant="ghost"
            radius="full"
            size="md"
            aria-label="Home"
            aria-current={navigationPage === "home" ? "page" : undefined}
            data-testid="topbar-home-button"
            className={`h-10 w-10 shrink-0 text-slate-600 dark:text-slate-200 ${DARK_RAIL_HOVER_CLASS} aria-[current=page]:bg-primary-50 aria-[current=page]:text-primary-600 dark:aria-[current=page]:bg-primary-500/15 dark:aria-[current=page]:text-primary-400`}
          >
            <HomeIcon className="h-5 w-5" aria-hidden="true" />
          </IconButton>
          <Button
            onPress={onOpenTeamSwitcher ?? onToggleSidebar}
            isDisabled={!onOpenTeamSwitcher && !onToggleSidebar}
            variant="ghost"
            size="sm"
            radius="lg"
            aria-label={`Choose team: ${resolvedTeamName}`}
            aria-expanded={sidebarOpen ?? false}
            data-testid="topbar-team-selector"
            className={`h-11 min-w-0 max-w-72 justify-start gap-2 px-1.5 text-left text-slate-900 dark:text-slate-100 ${DARK_RAIL_HOVER_CLASS}`}
          >
            <span aria-hidden="true" data-testid="topbar-team-avatar"
              className="flex h-7 w-7 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-slate-200 text-2xs font-semibold text-slate-700 dark:bg-white/10 dark:text-slate-200">
              {activeTeamAvatarUrl ? <img src={activeTeamAvatarUrl} alt="" className="h-full w-full object-cover" /> : getOrgInitials(resolvedTeamName)}
            </span>
            <span className="min-w-0 truncate text-sm font-semibold" data-testid="topbar-team-name">{resolvedTeamName}</span>
            <SidebarExpand className="h-4 w-4 shrink-0 text-slate-500 dark:text-slate-400" aria-hidden="true" />
          </Button>
          <div className="ml-auto flex shrink-0 items-center gap-1">
            {notificationBell}
            <IconButton
              onPress={onOpenProfileSettings}
              isDisabled={!onOpenProfileSettings}
              variant="ghost"
              radius="full"
              size="md"
              aria-label="Open profile settings"
              aria-current={navigationPage === "account" ? "page" : undefined}
              data-testid="topbar-profile-button"
              className="h-10 w-10 shrink-0 p-1"
            >
              <span className="flex h-8 w-8 items-center justify-center overflow-hidden rounded-full bg-slate-200 text-xs font-semibold text-slate-700 dark:bg-white/10 dark:text-slate-200" aria-hidden="true">
                {profile?.avatarUrl ? <img src={profile.avatarUrl} alt="" className="h-full w-full object-cover" /> : profileInitials}
              </span>
            </IconButton>
          </div>
        </div>
      ) : (
        <div className="flex min-w-0 items-center gap-1 px-3 py-2 max-[375px]:px-2" data-testid="topbar-workspace-navigation">
          {mobileBackButton}
          <Button
            onPress={onToggleSidebar ?? onOpenTeamSwitcher}
            isDisabled={!onToggleSidebar && !onOpenTeamSwitcher}
            variant="ghost"
            size="sm"
            radius="xl"
            aria-label={`Open space navigation: ${resolvedProjectName}`}
            aria-expanded={sidebarOpen ?? false}
            data-testid="topbar-sidebar-toggle"
            className={`${COMPACT_TAB_SELECTOR_CLASS} flex-1 text-left`}
          >
            <span className="min-w-0 flex-1">
              <span className="block truncate text-2xs font-normal text-slate-500 dark:text-slate-400">{resolvedProjectName}</span>
              <span className="block truncate text-xs font-semibold">{topbarLocationTitle}</span>
            </span>
            <ControlChevron direction="down" />
          </Button>
          <div className="flex shrink-0 items-center">
            {workspaceTabs.length > 0 && !controllerProjectMissing ? (
              <DialogTrigger
                isOpen={tabMenuOpen}
                onOpenChange={(open) => setTabMenuOpen((current) => (open && current ? false : open))}
              >
                <IconButton
                  variant="ghost"
                  size="md"
                  radius="full"
                  data-testid="topbar-tab-selector"
                  className="h-10 w-10"
                  aria-label="Browse tabs"
                >
                  <MoreHoriz className="h-5 w-5" aria-hidden="true" />
                </IconButton>
                {tabsMenu}
              </DialogTrigger>
            ) : null}
            {shouldShowNewChat ? <StudioNewChatButton /> : null}
            {notificationBell}
          </div>
        </div>
      )}
    </header>
  );
}
