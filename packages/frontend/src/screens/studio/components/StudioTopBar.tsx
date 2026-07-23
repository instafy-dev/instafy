import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DialogTrigger } from "react-aria-components";
import {
  ChatLines,
  Cube,
  Lock,
  MoreHoriz,
  NavArrowLeft,
  NavArrowRight,
  Plus,
  SidebarCollapse,
  SidebarExpand,
  Xmark
} from "iconoir-react";
import { HomeIcon } from "../../../components/AppIcons";
import { Button, IconButton } from "../../../components/Button";
import { Badge } from "../../../components/Badge";
import { EntityRow } from "../../../components/EntityRow";
import { SearchInput } from "../../../components/SearchInput";
import { Spinner } from "../../../components/Spinner";
import { Text } from "../../../components/Text";
import { StudioDialogHeader } from "../../../components/aria/StudioDialogLayout";
import { StudioDialogModal } from "../../../components/aria/StudioModal";
import { StudioDialogPopover } from "../../../components/aria/StudioPopover";
import { useProject } from "../../../projects/useProject";
import { useProjects } from "../../../projects/useProjects";
import { useRuntime } from "../../../runtime/useRuntime";
import {
  controllerClient,
  type ControllerProjectMember,
} from "../../../sdk/instafy";
import { WorkspaceTabs } from "../../../workspace/WorkspaceTabs";
import { useWorkspaceTabs } from "../../../workspace/WorkspaceTabsProvider";
import { useConversations } from "../../../conversations/ConversationsProvider";
import { useAuth } from "../../../providers/AuthProvider";
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
  DARK_ACTIVE_SURFACE_CLASS,
  DARK_CANVAS_CLASS,
  DARK_CONTROL_HOVER_CLASS,
  DARK_DIVIDER_BORDER_CLASS,
  DARK_RAIL_BLUR_BG_CLASS,
  DARK_RAIL_HOVER_CLASS,
  DARK_RAIL_MUTED_BG_CLASS,
} from "../../../theme/darkSurfaces";
import { useWorkspaceControls } from "../workspaceControls";
import { useStudioNavigationPosture } from "../useStudioNavigationPosture";

const {
  listMembers: listControllerOrgMembers,
} = controllerClient.organizations;
const {
  listMembers: listControllerProjectMembers,
} = controllerClient.projects;

const COMPACT_TAB_SELECTOR_CLASS =
  "h-10 min-w-0 justify-between gap-2 rounded-xl !border-transparent !bg-slate-100 px-2.5 !text-slate-950 !shadow-none hover:!bg-slate-100 data-[hovered]:!bg-slate-100 focus-visible:ring-white/16 focus-visible:ring-offset-white max-[375px]:min-h-11 dark:!bg-white/[0.06] dark:!text-slate-50 dark:hover:!bg-white/[0.09] dark:data-[hovered]:!bg-white/[0.09] dark:focus-visible:ring-white/16 dark:focus-visible:ring-offset-[var(--color-studio-dark-rail)]";

function resolvePrivateChatDisplayName(member: ControllerProjectMember): string {
  const fullName = typeof member.fullName === "string" ? member.fullName.trim() : "";
  if (fullName) {
    return fullName;
  }
  const email = typeof member.email === "string" ? member.email.trim() : "";
  if (email) {
    return email;
  }
  return "Teammate";
}

function resolvePrivateChatSubtitle(member: ControllerProjectMember): string | null {
  const fullName = typeof member.fullName === "string" ? member.fullName.trim() : "";
  const email = typeof member.email === "string" ? member.email.trim() : "";
  if (fullName && email) {
    return email;
  }
  return null;
}

export function StudioTopBar() {
  const {
    activeProjectName,
    onStartNewConversation,
    onStartPrivateConversation,
    showChatActions = false,
    onToggleSidebar,
    sidebarOpen,
    homeAttentionCount = 0,
    onOpenProjectSettings,
    topbarLocationOverride,
  } = useWorkspaceControls();
  const { projectList, activeProjectId } = useProjects();
  const { projectAccessBlocked } = useProject();
  const { user } = useAuth();
  const currentUserId = user?.id ?? null;

  const [tabMenuOpen, setTabMenuOpen] = useState(false);
  const [newChatMenuOpen, setNewChatMenuOpen] = useState(false);
  const [privateChatPickerOpen, setPrivateChatPickerOpen] = useState(false);
  const [privateChatQuery, setPrivateChatQuery] = useState("");
  const [privateChatTargets, setPrivateChatTargets] = useState<ControllerProjectMember[]>([]);
  const [privateChatTargetsLoading, setPrivateChatTargetsLoading] = useState(false);
  const [privateChatTargetsLoaded, setPrivateChatTargetsLoaded] = useState(false);
  const [desktopVoiceHostStatus, setDesktopVoiceHostStatus] = useState<DesktopVoiceHostBridgeStatus | null>(null);
  const [desktopSpeechTunnelStatus, setDesktopSpeechTunnelStatus] = useState<DesktopSpeechTunnelBridgeStatus | null>(null);
  const [desktopVoiceStatusLoading, setDesktopVoiceStatusLoading] = useState(false);
  const privateChatTargetsRequestRef = useRef<Promise<ControllerProjectMember[]> | null>(null);
  const privateChatTargetsEpochRef = useRef(0);
  const newChatTriggerRef = useRef<HTMLButtonElement | null>(null);
  const newChatInteractionModalityRef = useRef<"pointer" | "keyboard" | null>(null);

  const { tabs: workspaceTabs, activeTabId, focusTab, closeTab, requestUrlPush, openPanelTab, openConversationTab } = useWorkspaceTabs();
  const { conversations } = useConversations();
  const { runtime } = useRuntime();
  const controllerProjectMissing = runtime.controllerProjectMissing || projectAccessBlocked;
  const shouldShowNewChat = showChatActions && Boolean(onStartNewConversation);
  const { isLargeScreen, showTopbarHomeButton } = useStudioNavigationPosture();

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
  const isRootConversationContext =
    activeWorkspaceTab?.kind === "conversation" &&
    activeConversation !== null &&
    !(activeConversation.parentConversationId?.trim());
  const isRootChatContext =
    (activeWorkspaceTab?.kind === "panel" && activeWorkspaceTab.panel === "chat") ||
    isRootConversationContext;
  const showTopbarHomeShortcut = showTopbarHomeButton && isRootChatContext;
  const topbarLocationIcon = topbarLocationOverride?.icon ?? activeWorkspaceTab?.icon ?? (
    <Cube className="text-[16px]" aria-hidden="true" />
  );
  const topbarLocationTitle = topbarLocationOverride?.title ?? activeWorkspaceTab?.title ?? "Space";
  const handleOpenParentConversation = useCallback(() => {
    if (!parentConversation) {
      return;
    }
    requestUrlPush();
    openConversationTab(parentConversation.localId);
  }, [openConversationTab, parentConversation, requestUrlPush]);
  const homeAttentionBadge = homeAttentionCount > 9 ? "9+" : homeAttentionCount.toString();
  const homeButtonActive =
    activeWorkspaceTab?.kind === "panel" && activeWorkspaceTab.panel === "home";
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

  useEffect(() => {
    privateChatTargetsEpochRef.current += 1;
    privateChatTargetsRequestRef.current = null;
    setNewChatMenuOpen(false);
    setPrivateChatPickerOpen(false);
    setPrivateChatQuery("");
    setPrivateChatTargets([]);
    setPrivateChatTargetsLoading(false);
    setPrivateChatTargetsLoaded(false);
  }, [activeProjectId, currentUserId]);

  const loadPrivateChatTargets = useCallback(async (): Promise<ControllerProjectMember[]> => {
    if (privateChatTargetsLoaded) {
      return privateChatTargets;
    }
    if (privateChatTargetsRequestRef.current) {
      return privateChatTargetsRequestRef.current;
    }

    const epoch = privateChatTargetsEpochRef.current;
    const inflight = (async (): Promise<ControllerProjectMember[]> => {
      if (!activeProjectId) {
        if (epoch === privateChatTargetsEpochRef.current) {
          setPrivateChatTargets([]);
          setPrivateChatTargetsLoaded(true);
          setPrivateChatTargetsLoading(false);
        }
        return [];
      }

      if (epoch === privateChatTargetsEpochRef.current) {
        setPrivateChatTargetsLoading(true);
      }

      try {
        const project = projectList.find((entry) => entry.id === activeProjectId) ?? null;
        const orgId = project?.orgId ?? null;
        const [orgMembers, projectMembers] = await Promise.all([
          orgId ? listControllerOrgMembers(orgId) : Promise.resolve([]),
          listControllerProjectMembers(activeProjectId),
        ]);
        const members = orgId ? [...orgMembers, ...projectMembers] : projectMembers;

        const filtered: ControllerProjectMember[] = [];
        const seenUserIds = new Set<string>();
        for (const member of members) {
          const userId = typeof member.userId === "string" ? member.userId.trim() : "";
          if (!userId || userId === currentUserId) {
            continue;
          }
          if (seenUserIds.has(userId)) {
            continue;
          }
          seenUserIds.add(userId);
          filtered.push(member);
        }
        filtered.sort((a, b) => {
          const labelA = `${a.fullName ?? ""} ${a.email ?? ""}`.trim().toLowerCase();
          const labelB = `${b.fullName ?? ""} ${b.email ?? ""}`.trim().toLowerCase();
          return labelA.localeCompare(labelB);
        });

        if (epoch === privateChatTargetsEpochRef.current) {
          setPrivateChatTargets(filtered);
          setPrivateChatTargetsLoaded(true);
        }
        return filtered;
      } catch {
        if (epoch === privateChatTargetsEpochRef.current) {
          setPrivateChatTargets([]);
          setPrivateChatTargetsLoaded(true);
        }
        return [];
      } finally {
        if (epoch === privateChatTargetsEpochRef.current) {
          setPrivateChatTargetsLoading(false);
        }
      }
    })();

    privateChatTargetsRequestRef.current = inflight;
    try {
      return await inflight;
    } finally {
      if (privateChatTargetsRequestRef.current === inflight) {
        privateChatTargetsRequestRef.current = null;
      }
    }
  }, [
    activeProjectId,
    currentUserId,
    privateChatTargets,
    privateChatTargetsLoaded,
    projectList,
  ]);

  const filteredPrivateChatTargets = useMemo(() => {
    const query = privateChatQuery.trim().toLowerCase();
    if (!query) {
      return privateChatTargets;
    }
    return privateChatTargets.filter((member) => {
      const displayName = resolvePrivateChatDisplayName(member).toLowerCase();
      const email = (member.email ?? "").trim().toLowerCase();
      return displayName.includes(query) || email.includes(query);
    });
  }, [privateChatQuery, privateChatTargets]);

  const handleNewChatMenuOpenChange = useCallback(
    (open: boolean) => {
      setNewChatMenuOpen(open);
      if (!open && newChatInteractionModalityRef.current === "pointer") {
        requestAnimationFrame(() => {
          newChatTriggerRef.current?.blur();
        });
      }
      if (open && onStartPrivateConversation && !privateChatTargetsLoaded && !privateChatTargetsLoading) {
        void loadPrivateChatTargets();
      }
      if (!open) {
        newChatInteractionModalityRef.current = null;
      }
    },
    [
      loadPrivateChatTargets,
      onStartPrivateConversation,
      privateChatTargetsLoaded,
      privateChatTargetsLoading,
    ],
  );

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    if (!shouldShowNewChat || privateChatTargetsLoaded || privateChatTargetsLoading) {
      return;
    }
    if (!onStartPrivateConversation) {
      return;
    }
    const timer = window.setTimeout(() => {
      void loadPrivateChatTargets();
    }, 400);
    return () => {
      window.clearTimeout(timer);
    };
  }, [
    loadPrivateChatTargets,
    onStartPrivateConversation,
    privateChatTargetsLoaded,
    privateChatTargetsLoading,
    shouldShowNewChat,
  ]);

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
                <span className="min-w-0 flex-1 truncate text-left">{tab.title}</span>
                {tab.badge ? (
                  <span
                    className="inline-flex h-4 min-w-[1rem] shrink-0 items-center justify-center rounded-full bg-primary-500/90 px-1 text-3xs font-semibold leading-none text-white dark:bg-primary-500/85"
                    aria-label={`${tab.badge} unread messages`}
                  >
                    {tab.badge}
                  </span>
                ) : null}
              </Button>
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
  const hasDesktopTabs = useDesktopTabChrome && workspaceTabs.length > 0;
  const resolvedProjectName = activeProjectName || "Untitled Space";
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

  const newChatMenu = shouldShowNewChat ? (
    <StudioDialogPopover placement="bottom start" offset={8} className="w-80 p-3" data-testid="chat-new-chat-menu-popover">
      <div className="flex flex-col gap-1.5">
        <EntityRow
          title="Public chat"
          surface="interactive"
          pressable
          start={<ChatLines className="h-4 w-4 text-slate-400 dark:text-slate-400" aria-hidden="true" />}
          onPress={() => {
            setNewChatMenuOpen(false);
            onStartNewConversation?.();
          }}
          data-testid="chat-new-chat-public"
        />

        {onStartPrivateConversation ? (
          <EntityRow
            title="Private chat"
            surface="interactive"
            pressable
            start={<Lock className="h-4 w-4 text-slate-400 dark:text-slate-400" aria-hidden="true" />}
            end={<NavArrowRight className="h-4 w-4 text-slate-400 dark:text-slate-400" aria-hidden="true" />}
            onPress={() => {
              setNewChatMenuOpen(false);
              setPrivateChatPickerOpen(true);
              setPrivateChatQuery("");
              void loadPrivateChatTargets();
            }}
            data-testid="chat-new-chat-private"
          />
        ) : null}
      </div>
    </StudioDialogPopover>
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

  return (
      <header
        aria-label={`${resolvedProjectName} workspace navigation`}
        className={[
          "sticky top-0 z-40 pt-[var(--instafy-safe-area-inset-top)]",
          isLargeScreen
            ? useDesktopTabChrome
              ? `bg-white ${DARK_CANVAS_CLASS}`
              : `bg-white/95 ${DARK_RAIL_MUTED_BG_CLASS}`
            : `bg-white/70 backdrop-blur-md ${DARK_RAIL_BLUR_BG_CLASS}`,
          isLargeScreen
            ? useDesktopTabChrome
              ? "border-b border-transparent"
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
          leading={desktopParentConversationButton}
          className="bg-transparent pr-0 pt-0 dark:bg-transparent"
          emptyStateContent={!hasDesktopTabs ? desktopEmptyStateTab : undefined}
          tabStripActions={
            shouldShowNewChat ? (
              <DialogTrigger isOpen={newChatMenuOpen} onOpenChange={handleNewChatMenuOpenChange}>
                <IconButton
                  ref={newChatTriggerRef}
                  variant="ghost"
                  size="sm"
                  radius="none"
                  aria-label="New chat"
                  data-testid="chat-new-conversation"
                  className={desktopTabActionButtonClassName}
                  onPointerDown={() => {
                    newChatInteractionModalityRef.current = "pointer";
                  }}
                  onKeyDown={() => {
                    newChatInteractionModalityRef.current = "keyboard";
                  }}
                >
                  <Plus className="h-[18px] w-[18px]" aria-hidden="true" />
                </IconButton>
                {newChatMenu}
              </DialogTrigger>
            ) : null
          }
          actions={
            hasDesktopTabs ? (
              <div className="flex items-center">
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
            ) : null
          }
        />
      ) : isLargeScreen ? (
        <div className="flex flex-wrap items-center gap-2 px-4 py-2 sm:flex-nowrap sm:px-5">
          <div className="flex min-w-0 flex-none items-center gap-2">
            {!isLargeScreen && onToggleSidebar ? (
              <IconButton
                onPress={onToggleSidebar}
                variant="ghost"
                radius="full"
                size="md"
                aria-label="Toggle sidebar"
                aria-expanded={sidebarOpen ?? false}
                data-testid="topbar-sidebar-toggle"
                className="h-10 w-10"
              >
                {sidebarOpen ? (
                  <SidebarCollapse className="h-5 w-5" aria-hidden="true" />
                ) : (
                  <SidebarExpand className="h-5 w-5" aria-hidden="true" />
                )}
              </IconButton>
            ) : null}
            {parentConversationButton}
            {!isLargeScreen && onToggleSidebar && !sidebarOpen && showTopbarHomeShortcut ? (
              <IconButton
                onPress={() => {
                  requestUrlPush();
                  openPanelTab("home");
                }}
                variant="ghost"
                radius="full"
                size="md"
                aria-label="Open home"
                aria-current={homeButtonActive ? "page" : undefined}
                data-testid="topbar-home-button"
                className={[
                  "relative h-10 w-10",
                  homeButtonActive
                    ? `bg-slate-100 text-slate-900 dark:text-slate-50 ${DARK_ACTIVE_SURFACE_CLASS}`
                    : "bg-transparent text-slate-600 dark:text-slate-200",
                ].join(" ")}
              >
                <HomeIcon className="h-5 w-5" aria-hidden="true" />
                {homeAttentionCount > 0 ? (
                  <span
                    aria-hidden="true"
                    data-testid="topbar-home-badge"
                    className="absolute right-[1px] top-[1px] flex h-3.5 min-w-[0.875rem] items-center justify-center rounded-full bg-primary-600 px-1 text-3xs font-semibold leading-none text-white ring-2 ring-white translate-x-[16%] -translate-y-[16%] dark:bg-primary-500 dark:ring-slate-950"
                  >
                    {homeAttentionBadge}
                  </span>
                ) : null}
              </IconButton>
            ) : null}
            {isLargeScreen ? projectNameLabel : null}
          </div>

          <div className="flex min-w-0 flex-1 flex-wrap items-center justify-end gap-2 sm:flex-nowrap">
            {!isLargeScreen && workspaceTabs.length > 0 && !controllerProjectMissing ? (
              <DialogTrigger
                isOpen={tabMenuOpen}
                onOpenChange={(open) => setTabMenuOpen((current) => (open && current ? false : open))}
              >
                <Button
                  variant="ghost"
                  size="xs"
                  radius="full"
                  data-testid="topbar-tab-selector"
                  className={`${COMPACT_TAB_SELECTOR_CLASS} flex-1 sm:max-w-[min(11rem,55vw)]`}
                  aria-haspopup="dialog"
                  aria-label="Open tab switcher"
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <span aria-hidden="true" className="shrink-0">
                      {topbarLocationIcon}
                    </span>
                    <span className="truncate text-xs font-semibold">
                      {topbarLocationTitle}
                    </span>
                  </span>
                </Button>
                {tabsMenu}
              </DialogTrigger>
            ) : null}

            {shouldShowNewChat ? (
              <DialogTrigger isOpen={newChatMenuOpen} onOpenChange={handleNewChatMenuOpenChange}>
                <IconButton
                  ref={newChatTriggerRef}
                  variant="ghost"
                  radius="full"
                  size="md"
                  data-testid="topbar-new-conversation"
                  aria-label="New chat"
                  className={`h-10 w-10 rounded-full border border-transparent bg-transparent shadow-none focus-visible:ring-white/16 focus-visible:ring-offset-white dark:focus-visible:ring-white/16 dark:focus-visible:ring-offset-[var(--color-studio-dark-rail)] [aria-expanded=true]:dark:bg-white/[0.05] ${DARK_RAIL_HOVER_CLASS}`}
                  onPointerDown={() => {
                    newChatInteractionModalityRef.current = "pointer";
                  }}
                  onKeyDown={() => {
                    newChatInteractionModalityRef.current = "keyboard";
                  }}
                >
                  <Plus className="text-base" aria-hidden="true" />
                </IconButton>
                {newChatMenu}
              </DialogTrigger>
            ) : null}
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 px-4 py-2 max-[375px]:px-3 max-[375px]:py-1">
          <div className="flex min-w-0 items-center gap-2">
            {onToggleSidebar ? (
              <IconButton
                onPress={onToggleSidebar}
                variant="ghost"
                radius="full"
                size="md"
                aria-label="Toggle sidebar"
                aria-expanded={sidebarOpen ?? false}
                data-testid="topbar-sidebar-toggle"
                className="h-10 w-10"
              >
                {sidebarOpen ? (
                  <SidebarCollapse className="h-5 w-5" aria-hidden="true" />
                ) : (
                  <SidebarExpand className="h-5 w-5" aria-hidden="true" />
                )}
              </IconButton>
            ) : null}
            {parentConversationButton}
            {onToggleSidebar && !sidebarOpen && showTopbarHomeShortcut ? (
              <IconButton
                onPress={() => {
                  requestUrlPush();
                  openPanelTab("home");
                }}
                variant="ghost"
                radius="full"
                size="md"
                aria-label="Open home"
                aria-current={homeButtonActive ? "page" : undefined}
                data-testid="topbar-home-button"
                className={[
                  "relative h-10 w-10",
                  homeButtonActive
                    ? `bg-slate-100 text-slate-900 dark:text-slate-50 ${DARK_ACTIVE_SURFACE_CLASS}`
                    : "bg-transparent text-slate-600 dark:text-slate-200",
                ].join(" ")}
              >
                <HomeIcon className="h-5 w-5" aria-hidden="true" />
                {homeAttentionCount > 0 ? (
                  <span
                    aria-hidden="true"
                    data-testid="topbar-home-badge"
                    className="absolute right-[1px] top-[1px] flex h-3.5 min-w-[0.875rem] items-center justify-center rounded-full bg-primary-600 px-1 text-3xs font-semibold leading-none text-white ring-2 ring-white translate-x-[16%] -translate-y-[16%] dark:bg-primary-500 dark:ring-slate-950"
                  >
                    {homeAttentionBadge}
                  </span>
                ) : null}
              </IconButton>
            ) : null}
          </div>

          <div className="flex min-w-0 flex-1 justify-start">
            {workspaceTabs.length > 0 && !controllerProjectMissing ? (
              <DialogTrigger
                isOpen={tabMenuOpen}
                onOpenChange={(open) => setTabMenuOpen((current) => (open && current ? false : open))}
              >
                <Button
                  variant="ghost"
                  size="xs"
                  radius="full"
                  data-testid="topbar-tab-selector"
                  className={`${COMPACT_TAB_SELECTOR_CLASS} max-w-full text-left`}
                  aria-haspopup="dialog"
                  aria-label="Open tab switcher"
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <span aria-hidden="true" className="shrink-0">
                      {topbarLocationIcon}
                    </span>
                    <span className="truncate text-xs font-semibold">
                      {topbarLocationTitle}
                    </span>
                  </span>
                </Button>
                {tabsMenu}
              </DialogTrigger>
            ) : null}
          </div>

          <div className="flex items-center justify-end">
            {shouldShowNewChat ? (
              <DialogTrigger isOpen={newChatMenuOpen} onOpenChange={handleNewChatMenuOpenChange}>
                <IconButton
                  ref={newChatTriggerRef}
                  variant="ghost"
                  radius="full"
                  size="md"
                  data-testid="topbar-new-conversation"
                  aria-label="New chat"
                  className={`h-10 w-10 rounded-full border border-transparent bg-transparent shadow-none focus-visible:ring-white/16 focus-visible:ring-offset-white dark:focus-visible:ring-white/16 dark:focus-visible:ring-offset-[var(--color-studio-dark-rail)] [aria-expanded=true]:dark:bg-white/[0.05] ${DARK_RAIL_HOVER_CLASS}`}
                  onPointerDown={() => {
                    newChatInteractionModalityRef.current = "pointer";
                  }}
                  onKeyDown={() => {
                    newChatInteractionModalityRef.current = "keyboard";
                  }}
                >
                  <Plus className="text-base" aria-hidden="true" />
                </IconButton>
                {newChatMenu}
              </DialogTrigger>
            ) : null}
          </div>
        </div>
      )}
      <StudioDialogModal
        isOpen={privateChatPickerOpen}
        onOpenChange={(open) => {
          setPrivateChatPickerOpen(open);
          if (!open) {
            setPrivateChatQuery("");
          }
        }}
        isDismissable
        dialogAriaLabel="Start private chat"
        data-testid="chat-private-chat-modal"
        modalClassName="max-h-[min(90dvh,42rem)] max-w-xl overflow-hidden p-0"
      >
        <div className="flex max-h-[min(90dvh,42rem)] flex-col">
          <StudioDialogHeader
            title="Private chat"
            description="Choose one teammate to start a private conversation."
            descriptionClassName="mt-1 text-sm"
            onClose={() => {
              setPrivateChatPickerOpen(false);
              setPrivateChatQuery("");
            }}
            closeLabel="Close private chat picker"
            className="px-4 py-3"
          />

          <div className="flex-1 overflow-y-auto px-4 pb-4 pt-3">
            <SearchInput
              id="private-chat-target-search"
              label="Search teammates"
              value={privateChatQuery}
              onChange={(event) => setPrivateChatQuery(event.target.value)}
              placeholder="Search teammates…"
              autoFocus
              data-testid="chat-private-chat-search"
            />

            {privateChatTargetsLoading ? (
              <div className="mt-4 flex items-center gap-2 text-sm text-slate-500 dark:text-slate-300">
                <Spinner aria-hidden="true" size="xs" />
                Loading teammates…
              </div>
            ) : privateChatTargets.length === 0 ? (
              <div className="mt-4 space-y-3">
                <Text as="p" variant="caption" tone="muted" className="text-sm leading-relaxed">
                  Invite a teammate to unlock private chats in this space.
                </Text>
                {onOpenProjectSettings ? (
                  <Button
                    variant="outline"
                    size="sm"
                    radius="full"
                    onPress={() => {
                      setPrivateChatPickerOpen(false);
                      setPrivateChatQuery("");
                      onOpenProjectSettings();
                    }}
                  >
                    Invite teammate
                  </Button>
                ) : null}
              </div>
            ) : filteredPrivateChatTargets.length === 0 ? (
              <div className="mt-4 space-y-3">
                <Text as="p" variant="caption" tone="muted" className="text-sm leading-relaxed">
                  No teammates match that search.
                </Text>
                <Button
                  variant="ghost"
                  size="sm"
                  radius="full"
                  className="justify-start"
                  onPress={() => setPrivateChatQuery("")}
                >
                  Clear search
                </Button>
              </div>
            ) : (
              <div className="mt-4 space-y-2" data-testid="chat-private-chat-list">
                {filteredPrivateChatTargets.map((member) => {
                  const userId = typeof member.userId === "string" ? member.userId.trim() : "";
                  if (!userId) {
                    return null;
                  }
                  const displayName = resolvePrivateChatDisplayName(member);
                  return (
                    <EntityRow
                      key={userId}
                      title={displayName}
                      subtitle={resolvePrivateChatSubtitle(member) ?? undefined}
                      surface="interactive"
                      pressable
                      onPress={() => {
                        setPrivateChatPickerOpen(false);
                        setPrivateChatQuery("");
                        onStartPrivateConversation?.({ userId, displayName });
                      }}
                      data-testid={`chat-private-chat-target-${userId}`}
                    />
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </StudioDialogModal>
    </header>
  );
}
