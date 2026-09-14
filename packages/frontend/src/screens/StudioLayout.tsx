import { buildHomeFeed } from "./studio/homeFeed";
import { getHomeNotificationTarget } from "./studio/homeNotifications";
import { processNotificationClickDestination } from "../notifications/notificationClickDestination";
import { useNotificationCenter } from "../notifications/useNotificationCenter";
import { UUID_PATTERN, parseNotificationClickUrl } from "../notifications/notificationContract";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { StudioNavigationProvider, useStudioNavigation } from "../navigation/useStudioNavigation";
import { StudioHistoryControls } from "../navigation/StudioHistoryControls";
import { StudioPanelScrollContainer, buildStudioPanelScrollIdentity } from "../navigation/StudioPanelScrollContainer";
import { resolveSettingsRoute } from "./studio/settingsRoute";
import { getStudioVisitKey } from "../navigation/studioVisit";
import { useStudioHistory } from "../navigation/useStudioHistory";
import { useRouteOwnedWorkspaceDrawer } from "./useRouteOwnedWorkspaceDrawer";
import { ChatLines, Clock, Coins, Cpu, Cube, GitBranch, Globe, Group, Lock, Page, Puzzle, Search, SidebarExpand, User, Xmark } from "iconoir-react";
import { ResizablePanels } from "../components/ResizablePanels";
import { fetchCreditPolicy } from "../credits/creditService";
import { clearIdlePaused, markIdlePaused } from "../runtime/idlePauseRegistry";
import { setRuntimeSizePreference } from "../runtime/runtimeSizePreference";
import { isHostedRuntime, runtimeEntryIsReady } from "../runtime/utils/runtimeEntry";
import { Button, IconButton } from "../components/Button";
import { ProjectAccessRecoveryBanner, StudioStartupGate } from "./StudioStartup";
import { Badge } from "../components/Badge";
import { Heading } from "../components/Heading";
import { Surface } from "../components/Surface";
import { Text } from "../components/Text";
import { OctoMark } from "../components/OctoMark";
import { AttentionBadge } from "../components/AttentionBadge";
import { ChatsIcon } from "../components/AppIcons";
import {
  resolvePreferredFilesMobileViewForExplorerOpen,
  resolveStudioFilesMobileView,
  resolveStudioFilesMobileViewChange,
  type FilesPanelMobileView,
} from "./studioFilesMobileView";
import { buildGithubImportRetryIdentity } from "./studio/components/githubImportRetryRegistry";
import { ParticipantsDrawer } from "./studio/components/ParticipantsDrawer";
import {
  setParticipantsDrawerOpen,
  useParticipantsDrawerOpen,
} from "./studio/components/chatParticipantsStore";
import { useStudioSearch, type StudioSearchRequest } from "./studio/components/useStudioSearch";
import { StudioSearchContext } from "./studio/components/StudioSearchContext";
import { StudioSearchReturnProvider } from "./studio/components/StudioSearchReturnContext";
import { StudioMobileContextHeader } from "./studio/components/StudioMobileContextHeader";
import { useStudioSearchRecords } from "./studio/useStudioSearchRecords";
import { getStudioWorkspaceOwnerKey, useStudioKnownFiles } from "./studio/useStudioKnownFiles";
import { useStudioSearchNavigation } from "./studio/useStudioSearchNavigation";
import { useStudioSearchHistory } from "./studio/useStudioSearchHistory";
import { useNativeBackButtonAction } from "../native/useNativeBackButtonAction";
import { desktopTitleBarFree } from "../lib/desktopShell";
import "./studio/StudioContextLayout.css";
import { StudioSidebar } from "./studio/components/StudioSidebar";
import { StudioMobileSidebarOverlay } from "./studio/components/StudioMobileSidebarOverlay";
import { StudioTopBar } from "./studio/components/StudioTopBar";
import { useSidebarToggleFocus } from "./studio/useSidebarToggleFocus";
import { MobileBottomDock } from "./studio/components/MobileBottomDock";
import { ProjectLauncher } from "./studio/components/ProjectLauncher";
import { ChatPanel } from "./studio/components/ChatPanel";
import {
  ControllerNoticeActionsProvider,
  type ControllerNoticeActionsContextValue,
} from "./studio/components/ControllerNoticeActions";
import { ProjectPickerPanel } from "./studio/components/ProjectPickerPanel";
import { setMachinesPanelFocus } from "./studio/components/machinesPanelStore";
import {
  AiPanel,
  AutomationsPanel,
  CreditsPanel,
  ExtensionsPanel,
  FilesPanel,
  GitDiffView,
  GitReviewView,
  MachinesPanel,
  TeamPanel,
  SecretsPanel,
  SettingsPanel,
  SkillsPanel,
  SourceControlDrawer,
} from "./studio/StudioLazyPanels";
import { HomePanel } from "./studio/components/HomePanel";
import { useStudioBugReportController } from "./studio/components/useStudioBugReportController";
import { Status } from "../status/Status";
import type { SettingsTab, StudioNavItem, StudioPanel } from "./studio/types";
import { useAuth } from "../providers/AuthProvider";
import { useWorkspaceUi } from "../workspace/useWorkspace";
import { useStatus } from "../status/useStatus";
import { useProject } from "../projects/useProject";
import { useProjects } from "../projects/useProjects";
import { useCredits } from "../credits/useCredits";
import {
  clearControllerAccessTokenOverride,
  CONTROLLER_AUTH_ERROR_EVENT,
  controllerClient,
  type ControllerAuthErrorDetail,
  type NotificationInboxItem,
} from "../sdk/instafy";
import { useBuildLogs } from "../debug/useBuildLogs";
import { BuildLogOverlay } from "./studio/components/BuildLogOverlay";
import { ProviderBindingApprovalHost } from "./studio/components/ProviderBindingApprovalHost";
import { useRuntime } from "../runtime/useRuntime";
import { type SubmitPromptResult } from "../prompts/usePromptActions";
import { usePromptBootstrap } from "./studio/hooks/usePromptBootstrap";
import { useCreatePrivateConversation } from "./studio/hooks/useCreatePrivateConversation";
import { useConversations } from "../conversations/ConversationsProvider";
import { isUUID } from "../utils/uuid";
import { writeClipboardText } from "../runtime/runtimeMenuShared";
import { INSTAFY_CLI_URL } from "../config/externalLinks";
import { SidePaneProvider, useSidePane } from "../workspace/SidePaneProvider";
import { resolveMobileOverviewSection, useStudioNavigationPosture } from "./studio/useStudioNavigationPosture";
import { SidePaneTabs } from "../workspace/SidePaneTabs";
import { WorkspaceTabsProvider, useWorkspaceTabs } from "../workspace/WorkspaceTabsProvider";
import type { WorkspaceGitReviewSource } from "../workspace/gitReviewTypes";
import { ConversationHistoryTab } from "../workspace/ConversationHistoryTab";
import { useWorkspaceActivity } from "../workspace/useWorkspaceActivity";
import { useRecentConversations } from "../workspace/useRecentConversations";
import { WorkspaceControlsProvider } from "./studio/workspaceControls";
import {
  buildHomeAttentionEntries,
  excludeVisibleConversationInboxItems,
} from "./studio/homeAttention";
import {
  executeGithubProjectImport,
  formatGithubImportSuccessMessage,
} from "./studio/components/githubImport";
import { applyPageMeta } from "../utils/seo";
import { isPersonalOrgName } from "../org/orgNaming";
import { buildStudioViewportStyle } from "./studioViewport";
import { useStudioViewportState } from "./useStudioViewportState";
import { writePendingProjectSwitch } from "./pendingProjectSwitch";
import { controllerBaseUrl } from "../services/runtimeController/core";
import { useAutoDesktopSpeechTunnel } from "../desktop/voiceTunnel/useAutoDesktopSpeechTunnel";
import { useStudioLayoutChromeState } from "./useStudioLayoutChromeState";
import { useStudioLayoutWorkspaceRouting } from "./useStudioLayoutWorkspaceRouting";
import { canRememberTeamWorkspace, resolveTeamNavigationScope } from "./studio/teamNavigation";
import { readCachedControllerOrgs } from "./studio/components/sidebarOrgSnapshot";
import { StudioPanelPerformance } from "../telemetry/StudioPanelPerformance";


const sidebarPrimaryAccentClass = "text-primary-600 dark:text-primary-500";

const navItems: StudioNavItem[] = [
  { id: "chat", label: "Assistant", icon: ChatLines, accent: sidebarPrimaryAccentClass },
  { id: "automations", label: "Automations", icon: Clock, accent: sidebarPrimaryAccentClass },
  { id: "code", label: "Files", icon: Page, accent: sidebarPrimaryAccentClass },
  { id: "sourceControl", label: "Changes", icon: GitBranch, accent: sidebarPrimaryAccentClass },
];

const navMoreItems: StudioNavItem[] = [
  { id: "extensions", label: "Extensions", icon: Globe, accent: sidebarPrimaryAccentClass },
  { id: "secrets", label: "Secrets", icon: Lock, accent: sidebarPrimaryAccentClass },
  { id: "skills", label: "Skills", icon: Puzzle, accent: sidebarPrimaryAccentClass },
  { id: "ai", label: "Your AI", icon: Cpu, accent: sidebarPrimaryAccentClass },
  { id: "machines", label: "Machines", icon: Cube, accent: sidebarPrimaryAccentClass },
  { id: "credits", label: "Credits", icon: Coins, accent: sidebarPrimaryAccentClass }
];

const GIT_STATUS_POLL_INTERVAL_MS = 15_000;
const GIT_STATUS_POLL_BACKOFF_MS = 60_000;
type SourceControlOpenDetail = {
  projectId?: string | null;
  previewPath?: string | null;
  reviewMode?: "focused" | "all";
};
type GitReviewOpenDetail = {
  review?: WorkspaceGitReviewSource | null;
};

export function StudioLayout() {
  return (
    <StudioStartupGate>
      <WorkspaceTabsProvider>
        <SidePaneProvider>
          <StudioLayoutInner />
        </SidePaneProvider>
      </WorkspaceTabsProvider>
    </StudioStartupGate>
  );
}

function StudioLayoutInner() {
  const auth = useAuth();
  const authLoading = auth.loading;
  const user = auth.user;
  const signOut = auth.signOut;
  const { isLargeScreen, showTouchBottomDock } = useStudioNavigationPosture();
  const location = useLocation();
  const [searchRequest, setSearchRequest] = useState<StudioSearchRequest & { key: string } | null>(null);
  const navigate = useNavigate();
  const { viewportHeightPx, keyboardOpen } = useStudioViewportState({ trackKeyboard: showTouchBottomDock });
  // Keep one chronological history owner across responsive header changes.
  const mobileHistory = useStudioHistory();
  const viewportHeightStyle = useMemo(() => buildStudioViewportStyle(viewportHeightPx), [viewportHeightPx]);

  useEffect(() => {
    if (typeof document === "undefined") {
      return;
    }
    const originalHtmlOverflow = document.documentElement.style.overflow;
    const originalBodyOverflow = document.body.style.overflow;
    const originalScrollRestoration = window.history.scrollRestoration;

    document.documentElement.style.overflow = "hidden";
    document.body.style.overflow = "hidden";
    window.history.scrollRestoration = "manual";

    return () => {
      document.documentElement.style.overflow = originalHtmlOverflow;
      document.body.style.overflow = originalBodyOverflow;
      window.history.scrollRestoration = originalScrollRestoration;
    };
  }, []);

  const {
    activePanel,
    isProjectLauncherOpen,
    setIsProjectLauncherOpen,
  } = useWorkspaceUi();
  const [projectLauncherPreferredOrgId, setProjectLauncherPreferredOrgId] = useState<string | null>(null);
  const {
    tabs: sideTabs,
    activeTab: activeSideTab,
    activeTabId,
    sideVisible,
    ratio: sideRatio,
    setRatio: setSideRatio,
    closeTab: closeSideTab,
    focusTab: focusSideTab,
    moveTab: moveSideTab,
    clearTabs
  } = useSidePane();
  const {
    tabs: workspaceTabs,
    conversationTabsReady,
    openPanelTab,
    openFileTab,
    openConversationTab,
    openJobThreadTab,
    openGitReviewTab,
    restoreGitReviewTab,
    focusTab: focusWorkspaceTab,
    requestUrlNavigation,
    peekUrlNavigation,
    consumeUrlNavigation,
    resetTabs,
    activeTab: activeWorkspaceTab,
    setPanelTabMeta
  } =
    useWorkspaceTabs();
  const requestHistoryPush = useCallback(() => {
    requestUrlNavigation("push");
  }, [requestUrlNavigation]);


  const { showStatus } = useStatus();
  const {
    projectInitialized,
    projectAccessPending,
    projectAccessBlocked: projectAccessBlockedFromProject,
    activeProjectName,
    activeProjectId,
  } = useProject();
  const { billing: creditBilling, controllerEnabled: creditsControllerEnabled } = useCredits();
  const { runtime, runtimeReady, effectiveRuntimeId, runtimeStatuses, showDesktopRuntimeHelp, localWorkspace, desktopOrigin } =
    useRuntime();

  const controllerProjectMissing =
    runtime.controllerProjectMissing || projectAccessBlockedFromProject;
  const projectReadyForWorkspace = projectInitialized && !projectAccessPending;
  const { createProject, projectList } = useProjects();

  useAutoDesktopSpeechTunnel({
    enabled: projectReadyForWorkspace && !controllerProjectMissing && controllerBaseUrl.trim().length > 0,
    projectId: activeProjectId,
    controllerUrl: controllerBaseUrl,
  });
  const activeProjectSummary = useMemo(
    () => projectList.find((project) => project.id === activeProjectId) ?? null,
    [activeProjectId, projectList],
  );
  const orgSettingsTitle = isPersonalOrgName(activeProjectSummary?.orgName) ? "Personal settings" : "Team settings";
  const currentUserId = user?.id ?? null;
  const knownWorkspaceFiles = useStudioKnownFiles(currentUserId,
    projectReadyForWorkspace && !controllerProjectMissing ? activeProjectId : null,
    getStudioWorkspaceOwnerKey({ effectiveRuntimeId, localWorkspace, desktopOrigin }));
  const activeProjectOrgKey = activeProjectSummary?.orgId ?? "personal";
  const navigationScope = resolveTeamNavigationScope(location.search, activeProjectOrgKey);
  const searchRoute = new URLSearchParams(location.search);
  const searchKey = JSON.stringify([currentUserId, getStudioVisitKey(location), navigationScope.orgKey, activeProjectId, navigationScope.page,
    ...["conversationId", "conversationControllerId", "jobId", "panel", "settingsTab", "settingsOrgId", "settingsCategory"].map(key => searchRoute.get(key))]);
  const searchHidesWorkspace = searchRequest?.key === searchKey && searchRequest.open;
  const searchHistory = useStudioSearchHistory(currentUserId, getStudioVisitKey(location), searchKey,
    currentUserId ? `${currentUserId}:${activeProjectId ?? "no-project"}` : null);

  const [navigationTeam, setNavigationTeam] = useState<{ userId: string | null; key: string; name: string; avatarUrl: string | null } | null>(null);
  const handleActiveTeamChange = useCallback((team: { key: string; name: string; avatarUrl: string | null }) => {
    setNavigationTeam((current) => current?.userId === currentUserId && current.key === team.key && current.name === team.name && current.avatarUrl === team.avatarUrl
      ? current : { userId: currentUserId, ...team });
  }, [currentUserId]);
  const selectedTeamMetadata = navigationTeam?.userId === currentUserId && navigationTeam.key === navigationScope.orgKey
    ? navigationTeam : readCachedControllerOrgs(user?.email).find((org) => org.id === navigationScope.orgKey);
  const activeTeamName = navigationScope.orgKey === "personal" ? "Personal"
    : selectedTeamMetadata?.name
      ?? (navigationScope.orgKey === activeProjectOrgKey ? activeProjectSummary?.orgName : null) ?? "Team";
  const activeTeamAvatarUrl = navigationScope.orgKey === "personal" ? null : selectedTeamMetadata?.avatarUrl ?? null;
  const teamReturnRoutes = useRef<{ userId: string | null; routes: Map<string, string> }>({ userId: currentUserId, routes: new Map() });
  if (teamReturnRoutes.current.userId !== currentUserId) {
    teamReturnRoutes.current = { userId: currentUserId, routes: new Map() };
  }
  useEffect(() => {
    if (!canRememberTeamWorkspace(location.search, activeProjectId, activeProjectOrgKey)) return;
    const params = new URLSearchParams(location.search);
    if (params.get("workspaceTab") === "workspaces") params.delete("workspaceTab");
    teamReturnRoutes.current.routes.set(activeProjectOrgKey, `${location.pathname}?${params}`);
  }, [activeProjectId, activeProjectOrgKey, currentUserId, location.pathname, location.search]);
  const {
    projectKey: conversationsProjectKey,
    conversations,
    activeConversationId,
    remoteConversationHistoryResolved,
    createConversation,
    markConversationRead,
    selectConversation,
    setConversationControllerId
  } = useConversations();
  const activeWorkspaceTabId = activeWorkspaceTab?.id ?? null;
  const activeWorkspaceTabKind = activeWorkspaceTab?.kind ?? null;
  const activeWorkspacePanelTab = activeWorkspaceTab?.kind === "panel" ? activeWorkspaceTab : null;
  const activeWorkspaceJobThreadTab = activeWorkspaceTab?.kind === "jobThread" ? activeWorkspaceTab : null;
  const activeWorkspaceGitReviewTab = activeWorkspaceTab?.kind === "gitReview" ? activeWorkspaceTab : null;
  const activeWorkspaceTabPanel = activeWorkspacePanelTab?.panel ?? null;
  const activeWorkspaceTabJobId = activeWorkspaceJobThreadTab?.jobId ?? null;
  const activeWorkspaceTabConversationId = activeWorkspaceJobThreadTab?.conversationId ?? null;
  const activeWorkspaceGitReviewReturnTabId = activeWorkspaceGitReviewTab?.returnTabId ?? null;
  const activeWorkspaceReviewTabId =
    activeWorkspaceTabKind === "gitReview" ? activeWorkspaceTabId : null;
  useWorkspaceActivity();
  const lastControllerAuthErrorRef = useRef(0);
  const projectMissingHandledRef = useRef<string | null>(null);
  const projectMemoryBootstrapDoneRef = useRef<Set<string>>(new Set());
  const projectMemoryBootstrapInFlightRef = useRef<Set<string>>(new Set());
  const activeConversation = useMemo(() => {
    if (!activeConversationId) {
      return null;
    }
    return conversations.find((conversation) => conversation.localId === activeConversationId) ?? null;
  }, [activeConversationId, conversations]);
  // Controller notices ("Workspace unavailable", "Scheduled run couldn't
  // start") used to be text-only cards naming a composer Runtime button that no
  // longer exists. They get their action here, where both the Machines route
  // and the self-host dialog already live.
  const controllerNoticeActionsValue = useMemo<ControllerNoticeActionsContextValue>(
    () => ({
      onOpenMachines: () => {
        // Push before opening, or the ?panel= reconciliation snaps the
        // workspace straight back to the chat surface.
        requestHistoryPush();
        openPanelTab("machines", { activate: true });
      },
      onShowSelfHostHelp: showDesktopRuntimeHelp,
      onOpenCredits: () => {
        requestHistoryPush();
        openPanelTab("credits", { activate: true });
      },
      onRunAutomation: (automationId: string) => {
        void (async () => {
          try {
            const started = await controllerClient.automations.runNow({ automationId });
            if (started) {
              showStatus("Running the schedule now…", "info", 3500);
              return;
            }
            showStatus("Couldn't start that run. Try again in a moment.", "error", 4500);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            showStatus(`Couldn't start that run: ${message}`, "error", 5000);
          }
        })();
      },
      viewerUserId: currentUserId,
    }),
    [currentUserId, openPanelTab, requestHistoryPush, showDesktopRuntimeHelp, showStatus],
  );
  const [homeAttentionInboxItems, setHomeAttentionInboxItems] = useState<NotificationInboxItem[]>([]);
  const homeAttentionRequestRef = useRef<Promise<NotificationInboxItem[]> | null>(null);
  const homeAttentionEpochRef = useRef(0);
  const isChatSurfaceVisible =
    activeWorkspaceTab?.kind === "conversation" ||
    activeWorkspaceTab?.kind === "jobThread" ||
    (activeWorkspaceTab?.kind === "panel" && activeWorkspaceTab.panel === "chat");
  // The participants drawer is an overlay opened from the chat roster facepile,
  // so it needs no width gate — it renders over the workspace content when open.
  const participantsDrawerOpen = useParticipantsDrawerOpen();
  const visibleConversationControllerId = useMemo((): string | null => {
    if (!isChatSurfaceVisible || searchHidesWorkspace) {
      return null;
    }
    try {
      const params = new URLSearchParams(location.search);
      const fromControllerParam = (params.get("conversationControllerId") ?? "").trim();
      if (fromControllerParam) {
        return fromControllerParam;
      }
    } catch {
      // Ignore malformed URLs and fall back to the active conversation state.
    }
    const fromActiveConversation = (activeConversation?.controllerId ?? "").trim();
    return fromActiveConversation || null;
  }, [activeConversation?.controllerId, isChatSurfaceVisible, location.search, searchHidesWorkspace]);
  const visibleConversationLocalId = useMemo((): string | null => {
    if (!isChatSurfaceVisible || searchHidesWorkspace) {
      return null;
    }
    const controllerId = (visibleConversationControllerId ?? "").trim().toLowerCase();
    if (controllerId) {
      const controllerMatch = conversations.find(
        (conversation) => (conversation.controllerId ?? "").trim().toLowerCase() === controllerId,
      );
      if (controllerMatch) {
        return controllerMatch.localId;
      }
    }
    return activeWorkspaceTab?.kind === "jobThread" ? null : (activeConversation?.localId ?? null);
  }, [
    activeConversation?.localId,
    activeWorkspaceTab?.kind,
    conversations,
    isChatSurfaceVisible,
    visibleConversationControllerId,
    searchHidesWorkspace,
  ]);
  const {
    buildLogs,
    hasBuildLogs,
    isBuildLogOverlayOpen,
    handleClearBuildLogs,
    handleShowBuildLogs,
    handleHideBuildLogs
  } = useBuildLogs();
  const notificationCenter = useNotificationCenter({ userId: currentUserId, accessToken: auth.session?.access_token ?? null, navigate });
  const bugReportController = useStudioBugReportController({
    legacyResolutionToasts: false,
    currentUserId,
    activeProjectId,
    activeConversationId: activeConversation?.controllerId ?? null,
    activeConversationLocalId: activeConversation?.localId ?? null,
    activeRuntimeId: effectiveRuntimeId,
    controllerProjectMissing,
    buildLogs,
  });
  const openSupportReport = bugReportController.onOpenBugReportInbox;
  const notificationDestinationIdentity = useRef({ userId: currentUserId, accessToken: auth.session?.access_token ?? null });
  if (notificationDestinationIdentity.current.userId !== currentUserId ||
    notificationDestinationIdentity.current.accessToken !== (auth.session?.access_token ?? null)) {
    notificationDestinationIdentity.current = { userId: currentUserId, accessToken: auth.session?.access_token ?? null };
  }
  const notificationDestinationUrl = `${location.pathname}${location.search}`;
  const notificationDestinationUrlRef = useRef(notificationDestinationUrl);
  notificationDestinationUrlRef.current = notificationDestinationUrl;
  const notificationDestinationRequest = useRef<{ key: string; active: boolean } | null>(null);
  useEffect(() => {
    const click = parseNotificationClickUrl(notificationDestinationUrl);
    const identity = notificationDestinationIdentity.current;
    if (!click || !identity.userId || !identity.accessToken) return;
    const key = `${identity.userId}:${notificationDestinationUrl}`;
    if (notificationDestinationRequest.current?.key === key && notificationDestinationRequest.current.active) return;
    const request = { key, active: true };
    notificationDestinationRequest.current = request;
    const isCurrent = () => request.active && notificationDestinationIdentity.current === identity;
    void processNotificationClickDestination({
      url: notificationDestinationUrl,
      userId: identity.userId,
      accessToken: identity.accessToken,
      isCurrent,
      openResource: (resourceUrl) => {
        const reportId = new URL(resourceUrl, "https://instafy.invalid").searchParams.get("supportReportId");
        if (reportId) openSupportReport(reportId);
        // Conversation/project routing already consumes this URL in Studio.
        // Retain click metadata until acknowledgement succeeds, so reload retries.
      },
    }).then((result) => {
      if (result.status === "pending" || !result.resourceUrl || !isCurrent() ||
        notificationDestinationUrlRef.current !== notificationDestinationUrl) return;
      const target = new URL(result.status === "ignored" ? "/studio" : result.resourceUrl, "https://instafy.invalid");
      target.searchParams.delete("supportReportId");
      navigate(`${target.pathname}${target.search}`, { replace: true });
    }).catch(() => {
      // Keep IDs-only metadata in the URL for an authenticated reload retry.
    }).finally(() => {
      if (notificationDestinationRequest.current === request) notificationDestinationRequest.current = null;
    });
    return () => {
      request.active = false;
      if (notificationDestinationRequest.current === request) notificationDestinationRequest.current = null;
    };
  }, [auth.session?.access_token, currentUserId, navigate, notificationDestinationUrl, openSupportReport]);
  useEffect(() => {
    if (!currentUserId || parseNotificationClickUrl(`${location.pathname}${location.search}`)) return;
    const params = new URLSearchParams(location.search);
    const reportId = params.get("supportReportId");
    if (!reportId || !UUID_PATTERN.test(reportId)) return;
    openSupportReport(reportId);
    params.delete("supportReportId");
    params.delete("notificationEventId");
    params.delete("notificationAccountId");
    navigate({ pathname: location.pathname, search: params.toString() }, { replace: true });
  }, [currentUserId, location.pathname, location.search, navigate, openSupportReport]);
  const [projectPickerSearchTerm, setProjectPickerSearchTerm] = useState("");
  const [preferredFilesMobileView, setPreferredFilesMobileView] =
    useState<FilesPanelMobileView>("tree");

  useEffect(() => {
    if (!isLargeScreen && activeWorkspaceTabKind === "file") {
      setPreferredFilesMobileView("viewer");
    }
  }, [activeWorkspaceTabId, activeWorkspaceTabKind, isLargeScreen]);

  const filesMobileViewProjectRef = useRef(activeProjectId);
  useEffect(() => {
    if (filesMobileViewProjectRef.current === activeProjectId) {
      return;
    }
    filesMobileViewProjectRef.current = activeProjectId;
    setPreferredFilesMobileView("tree");
  }, [activeProjectId]);

  useEffect(() => {
    homeAttentionEpochRef.current += 1;
    homeAttentionRequestRef.current = null;
    setHomeAttentionInboxItems([]);
  }, [currentUserId]);

  const refreshHomeAttentionCount = useCallback(async (
    options?: { force?: boolean },
  ): Promise<NotificationInboxItem[]> => {
    if (!currentUserId) {
      setHomeAttentionInboxItems([]);
      return [];
    }
    if (options?.force) {
      homeAttentionEpochRef.current += 1;
      homeAttentionRequestRef.current = null;
    }
    if (homeAttentionRequestRef.current) {
      return homeAttentionRequestRef.current;
    }

    const epoch = homeAttentionEpochRef.current;
    const inflight = (async (): Promise<NotificationInboxItem[]> => {
      try {
        const result = await controllerClient.notifications.listInbox({ limit: 50 });
        if (epoch !== homeAttentionEpochRef.current || !result.success) {
          return [];
        }

        // Visibility is presentation state, not acknowledgement. Keep the
        // complete server inbox so a reply hidden in the active chat can
        // surface as soon as the user switches to another conversation.
        const items = result.items ?? [];
        setHomeAttentionInboxItems(items);
        return items;
      } catch {
        return [];
      }
    })();

    homeAttentionRequestRef.current = inflight;
    try {
      return await inflight;
    } finally {
      if (homeAttentionRequestRef.current === inflight) {
        homeAttentionRequestRef.current = null;
      }
    }
  }, [currentUserId]);

  const visibleHomeAttentionInboxItems = useMemo(
    () => excludeVisibleConversationInboxItems(homeAttentionInboxItems, visibleConversationControllerId),
    [homeAttentionInboxItems, visibleConversationControllerId],
  );

  const homeAttentionFeed = useMemo(() => buildHomeFeed({
    attentionEntries: buildHomeAttentionEntries({
      conversations, inboxItems: visibleHomeAttentionInboxItems,
      currentSpaceName: (activeProjectName ?? "").trim() || "Choose a Space",
      visibleConversationLocalId, visibleConversationControllerId,
    }),
    notifications: notificationCenter.page.items.filter(item => {
      const target = getHomeNotificationTarget(item);
      return item.eventName !== "conversation.reply" || !visibleConversationControllerId || target?.conversationId !== visibleConversationControllerId;
    }),
    supportReports: bugReportController.supportUnreadReports,
    recentConversations: [], projects: projectList,
    activeProject: projectList.find(project => project.id === activeProjectId) ?? null,
    conversations, teamFilter: "all", lastSeenAt: null,
  }), [activeProjectId, activeProjectName, bugReportController.supportUnreadReports, conversations, notificationCenter.page.items, projectList,
    visibleConversationControllerId, visibleConversationLocalId, visibleHomeAttentionInboxItems]);
  const homeAttentionCount = homeAttentionFeed.needs.length;
  const { homeAttentionByProject, homeAttentionByOrg } = useMemo(() => {
    const byProject: Record<string, number> = {};
    const byOrg: Record<string, number> = {};
    for (const item of homeAttentionFeed.needs) {
      if (item.project.id) byProject[item.project.id] = (byProject[item.project.id] ?? 0) + 1;
      if (item.team.key !== "all") byOrg[item.team.key] = (byOrg[item.team.key] ?? 0) + 1;
    }
    return { homeAttentionByProject: byProject, homeAttentionByOrg: byOrg };
  }, [homeAttentionFeed.needs]);

  useEffect(() => {
    if (typeof window === "undefined" || !currentUserId) {
      return;
    }
    // Conversation switches must not wait for the periodic poll: the reply in
    // the chat we just left may have landed since the previous refresh.
    void refreshHomeAttentionCount({ force: true });
    const timer = window.setInterval(() => {
      void refreshHomeAttentionCount();
    }, 20_000);
    return () => {
      window.clearInterval(timer);
    };
  }, [currentUserId, refreshHomeAttentionCount, visibleConversationControllerId]);

  useEffect(() => {
    const projectName = (activeProjectName ?? "").trim();
    applyPageMeta({
      title: projectName ? `${projectName} · Instafy` : "Instafy",
      description: "Chat with Octo, edit files, and manage your space in Instafy.",
      image: "/og-image.png",
    });
  }, [activeProjectName]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    const handler = (event: Event) => {
      const payload = (event as CustomEvent<ControllerAuthErrorDetail>).detail;
      const message =
        typeof payload?.message === "string" && payload.message.trim().length > 0
          ? payload.message.trim()
          : "Your session is no longer valid.";

      const now = Date.now();
      if (now - lastControllerAuthErrorRef.current < 4000) {
        return;
      }
      lastControllerAuthErrorRef.current = now;

      showStatus(`${message} Please sign in again.`, "error", 6000);
      clearControllerAccessTokenOverride();
      void signOut().catch(() => {});
      navigate("/login");
    };

    window.addEventListener(CONTROLLER_AUTH_ERROR_EVENT, handler);
    return () => window.removeEventListener(CONTROLLER_AUTH_ERROR_EVENT, handler);
  }, [navigate, showStatus, signOut]);

  useEffect(() => {
    if (!projectReadyForWorkspace || !activeProjectId) {
      return;
    }
    if (!controllerProjectMissing) {
      return;
    }
      if (projectMissingHandledRef.current === activeProjectId) {
        return;
      }
      projectMissingHandledRef.current = activeProjectId;
      openPanelTab("projects");
    }, [
      activeProjectId,
      controllerProjectMissing,
      openPanelTab,
      projectReadyForWorkspace,
    ]);

  useEffect(() => {
    const projectId = activeProjectId?.trim() ?? "";
    if (!projectReadyForWorkspace || !projectId || controllerProjectMissing || !isUUID(projectId)) {
      return;
    }
    if (typeof window === "undefined") {
      return;
    }
    if (projectMemoryBootstrapDoneRef.current.has(projectId)) {
      return;
    }
    const inFlightProjects = projectMemoryBootstrapInFlightRef.current;
    if (inFlightProjects.has(projectId)) {
      return;
    }

    let cancelled = false;
    let retryTimeout: number | null = null;

    const attemptBootstrap = async (attempt: number) => {
      if (cancelled) {
        return;
      }
      inFlightProjects.add(projectId);
      const result = await controllerClient.projects.bootstrapMemory({ projectId });
      inFlightProjects.delete(projectId);
      if (cancelled) {
        return;
      }

      if (result?.seeded === true || result?.reason === "already-present") {
        projectMemoryBootstrapDoneRef.current.add(projectId);
        if (result.seeded) {
          window.dispatchEvent(
            new CustomEvent("instafy:workspace-commit", { detail: { projectId } }),
          );
        }
        return;
      }

      const retryable =
        result == null || result.reason === "no-origin" || result.reason === "workspace-busy";
      if (retryable) {
        // Origins may only register after a hosted runtime is provisioned, which can take
        // longer than the initial quick retries. Keep retrying in the background with a
        // capped backoff so managed defaults eventually land before first real work.
        const delayMs = attempt < 5 ? 1200 * (attempt + 1) : 15_000;
        retryTimeout = window.setTimeout(() => {
          void attemptBootstrap(attempt + 1);
        }, delayMs);
        return;
      }

      if (result?.reason && result.reason !== "no-origin" && result.reason !== "workspace-busy") {
        projectMemoryBootstrapDoneRef.current.add(projectId);
      }
    };

    void attemptBootstrap(0);

    return () => {
      cancelled = true;
      if (retryTimeout !== null) {
        window.clearTimeout(retryTimeout);
      }
      inFlightProjects.delete(projectId);
    };
  }, [activeProjectId, controllerProjectMissing, projectReadyForWorkspace]);
  const {
    filesExplorerPortalTarget,
    handleFilesExplorerPortalRef,
    workspaceSwitcherPortalTarget,
    handleWorkspaceSwitcherPortalRef,
    handleLeftDrawerResizeStart,
    leftDrawer,
    leftDrawerResizing,
    leftDrawerWidth,
    mobileGitReviewSheet,
    mobileSidebarOpen,
    mobileSidebarNavigation,
    runAfterSidebarClose,
    setLeftDrawer,
    setMobileGitReviewSheet,
    setMobileSidebarOpen,
    setSidebarCollapsed,
    sidebarCollapsed,
    sourceControlOpenRequest,
    setSourceControlOpenRequest,
  } = useStudioLayoutChromeState({ isLargeScreen, scopeKey: currentUserId ? `${currentUserId}:${activeProjectId ?? "no-project"}` : null });
  useEffect(() => {
    if (mobileSidebarNavigation.error) showStatus(mobileSidebarNavigation.error, "error", 5000);
  }, [mobileSidebarNavigation.error, showStatus]);
  const closeSearchForNavigation = useRef<() => void>(() => {});
  const runStudioNavigation = useCallback((action: () => void) => {
    closeSearchForNavigation.current();
    runAfterSidebarClose(() => {
      consumeUrlNavigation();
      action();
    });
  }, [consumeUrlNavigation, runAfterSidebarClose]);
  const navigateToDestination = useStudioNavigation(runStudioNavigation);
  // A workspace URL opened on desktop keeps the same visit on a phone. It
  // does not become a second, synthetic sidebar-history branch on resize.
  const routeOwnedMobileWorkspaceDrawer = !isLargeScreen && leftDrawer === "workspaces" && !mobileSidebarOpen;
  const { dismiss: dismissRouteOwnedWorkspaceDrawer } = useRouteOwnedWorkspaceDrawer({
    enabled: routeOwnedMobileWorkspaceDrawer,
    history: mobileHistory,
  });
  // Search temporarily covers the workspace; it does not end the current chat
  // visit or discard an established blank chat from recents.
  const retainedChatId = isChatSurfaceVisible && leftDrawer !== "history"
    ? (activeWorkspaceTab?.kind === "conversation" || activeWorkspaceTab?.kind === "jobThread"
      ? activeWorkspaceTab.conversationId
      : activeConversationId)
    : null;
  const visibleChatId = searchHidesWorkspace ? null : retainedChatId;
  const recentConversations = useRecentConversations({
    conversations,
    activeConversationId: retainedChatId,
    userId: currentUserId,
    projectKey: conversationsProjectKey,
    // The local guest fallback has no authenticated remote history to wait for.
    historyResolved: remoteConversationHistoryResolved || !auth.session,
  });
  const openConversationIds = useMemo(() => new Set(
    workspaceTabs.flatMap((tab) => tab.kind === "conversation"
      ? [tab.conversationId]
      : []),
  ), [workspaceTabs]);
  const {
    settingsTab,
    settingsOrgId,
    handlePanelSelect,
  } = useStudioLayoutWorkspaceRouting({
    activeConversationControllerId: activeConversation?.controllerId ?? null,
    activeConversationId,
    activePanel,
    activeProjectId,
    activeWorkspaceGitReviewReturnTabId,
    activeWorkspaceReviewTabId,
    activeWorkspaceTabConversationId,
    activeWorkspaceTabId,
    activeWorkspaceTabJobId,
    activeWorkspaceTabKind,
    activeWorkspaceTabPanel,
    conversationTabsReady,
    consumeUrlNavigation,
    conversations,
    conversationsProjectKey,
    focusWorkspaceTab,
    isLargeScreen,
    leftDrawer,
    locationPathname: location.pathname,
    locationSearch: location.search,
    locationKey: location.key,
    locationState: location.state,
    navigate,
    openConversationTab,
    openJobThreadTab,
    openPanelTab,
    peekUrlNavigation,
    projectReadyForWorkspace,
    requestUrlNavigation,
    restoreGitReviewTab,
    selectConversation,
    setConversationControllerId,
    setIsProjectLauncherOpen,
    setLeftDrawer,
    setMobileSidebarOpen,
    workspaceTabs,
  });
  const [pendingConversationTabOpenId, setPendingConversationTabOpenId] = useState<string | null>(
    null,
  );
  const filesMobileView = resolveStudioFilesMobileView({
    isLargeScreen,
    leftDrawer,
    preferredView: preferredFilesMobileView,
  });
  const isConversationHistoryActive = leftDrawer === "history";

  const creditsIndicator = useMemo(() => {
    if (!creditsControllerEnabled) {
      return null;
    }
    const creditBalance = creditBilling.creditBalance ?? 0;
    const creditLimit = creditBilling.creditLimit ?? 0;
    if (creditLimit <= 0) {
      return null;
    }
    if (creditBalance <= 0) {
      return { tone: "danger" as const, label: "Out of credits" };
    }
    const lowBalanceThreshold = Math.max(2, Math.floor(creditLimit * 0.2));
    if (creditBalance <= lowBalanceThreshold) {
      return { tone: "warning" as const, label: "Low credits" };
    }
    return null;
  }, [creditBilling.creditBalance, creditBilling.creditLimit, creditsControllerEnabled]);

  // Proactively nudge the user once when they cross into a low/empty balance,
  // with a direct link to the Credits panel. Re-arms once the balance recovers,
  // so it fires on a crossing rather than nagging on every render.
  const creditNudgeLevelRef = useRef<null | "low" | "out">(null);
  const creditIndicatorTone = creditsIndicator?.tone ?? null;
  useEffect(() => {
    const level = creditIndicatorTone === "danger" ? "out" : creditIndicatorTone === "warning" ? "low" : null;
    if (level === null) {
      creditNudgeLevelRef.current = null;
      return;
    }
    if (creditNudgeLevelRef.current === level) {
      return;
    }
    creditNudgeLevelRef.current = level;
    const balance = creditBilling.creditBalance ?? 0;
    showStatus(
      level === "out"
        ? "You're out of credits — refill to keep going."
        : `Low on credits — ${balance} left. Refill to keep chatting.`,
      level === "out" ? "error" : "warning",
      8000,
      {
        id: "credits-low-nudge",
        actionLabel: level === "out" ? "Refill" : "Open credits",
        onAction: () => openPanelTab("credits"),
        forceVisible: true,
      },
    );
  }, [creditIndicatorTone, creditBilling.creditBalance, openPanelTab, showStatus]);

  // Deliberate runtime pauses (idle, credits) get an explained notice instead
  // of looking like a crash. Auto-restart is suppressed for these reasons in
  // unexpectedHostedRuntimeRecovery; the machine wakes on the next interaction.
  const runtimeStopNoticeRef = useRef<string | null>(null);
  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    const handleStopNotice = (event: Event) => {
      const custom = event as CustomEvent<{
        projectId?: string | null;
        kind?: string | null;
        data?: Record<string, unknown> | null;
      }>;
      if (custom.detail?.kind !== "runtime.stopped") {
        return;
      }
      const projectId =
        typeof custom.detail?.projectId === "string" ? custom.detail.projectId.trim() : "";
      if (!projectId || projectId !== activeProjectId) {
        return;
      }
      const reason =
        custom.detail?.data && typeof custom.detail.data.reason === "string"
          ? custom.detail.data.reason.trim().toLowerCase()
          : "";
      if (reason !== "idle" && reason !== "credits_exhausted" && reason !== "oom_killed") {
        return;
      }
      const runtimeId =
        custom.detail?.data && typeof custom.detail.data.runtimeId === "string"
          ? custom.detail.data.runtimeId
          : "";
      const noticeKey = `${runtimeId}:${reason}`;
      if (runtimeStopNoticeRef.current === noticeKey) {
        return;
      }
      runtimeStopNoticeRef.current = noticeKey;
      if (reason === "idle") {
        markIdlePaused(projectId);
        showStatus(
          "Hosted machine paused after inactivity. Your files and caches are kept — it wakes when you continue.",
          "info",
          8000,
          { id: "runtime-paused-idle", forceVisible: true },
        );
      } else if (reason === "oom_killed") {
        const oomCount =
          custom.detail?.data && typeof custom.detail.data.oomCount === "number"
            ? custom.detail.data.oomCount
            : 1;
        showStatus(
          oomCount >= 2
            ? "The hosted machine ran out of memory again (4 GB limit). Boost it to 8 GB (2× credits) or connect your own machine for heavy builds."
            : "The hosted machine ran out of memory (4 GB limit) and stopped. Boost it to 8 GB (2× credits) if this keeps happening.",
          "error",
          12000,
          {
            id: "runtime-oom-killed",
            actionLabel: "Boost machine",
            onAction: () => {
              setRuntimeSizePreference(projectId, "boost");
              showStatus(
                "Boost set (4 CPU · 8 GB · 2× credits). It applies the next time the machine starts.",
                "success",
                6000,
                { id: "runtime-size-change" },
              );
            },
            forceVisible: true,
          },
        );
      } else {
        showStatus(
          "Hosted machine paused — this team is out of credits for today. They refill at 00:00 UTC.",
          "error",
          10000,
          {
            id: "runtime-paused-credits",
            actionLabel: "Open credits",
            onAction: () => openPanelTab("credits"),
            forceVisible: true,
          },
        );
      }
    };
    window.addEventListener("instafy:runtime-lifecycle-event", handleStopNotice as EventListener);
    return () => {
      window.removeEventListener(
        "instafy:runtime-lifecycle-event",
        handleStopNotice as EventListener,
      );
    };
  }, [activeProjectId, openPanelTab, showStatus]);

  // A genuine interaction wakes an idle-paused machine: clearing the pause
  // lets the normal auto-ensure path relaunch it.
  useEffect(() => {
    if (typeof window === "undefined" || !activeProjectId) {
      return;
    }
    const wake = () => clearIdlePaused(activeProjectId);
    window.addEventListener("pointerdown", wake, { passive: true });
    window.addEventListener("keydown", wake, { passive: true });
    return () => {
      window.removeEventListener("pointerdown", wake);
      window.removeEventListener("keydown", wake);
    };
  }, [activeProjectId]);

  // T-30 runway warning: while a hosted machine is online, warn once when the
  // remaining balance covers less than ~30 minutes of runtime, so the pause
  // at credit exhaustion never comes as a surprise.
  const hostedBurnPerMinuteRef = useRef<{ projectId: string; perMinute: number } | null>(null);
  const runwayWarnedRef = useRef(false);
  const hostedRuntimeOnline = useMemo(
    () =>
      runtimeStatuses.some(
        (entry) => Boolean(entry) && isHostedRuntime(entry) && runtimeEntryIsReady(entry),
      ),
    [runtimeStatuses],
  );
  useEffect(() => {
    if (!creditsControllerEnabled || !activeProjectId || !hostedRuntimeOnline) {
      return;
    }
    let cancelled = false;
    const evaluate = async () => {
      let burn = hostedBurnPerMinuteRef.current;
      if (!burn || burn.projectId !== activeProjectId) {
        const result = await fetchCreditPolicy(activeProjectId).catch(() => null);
        if (cancelled) {
          return;
        }
        const rates = [
          ...(result?.policy?.usage?.hostedRuntimeProviders ?? []),
          ...(result?.policy?.usage?.hostedRuntime ? [result.policy.usage.hostedRuntime] : []),
        ].filter((rate) => rate.enabled && rate.creditsPerMinute > 0);
        burn = {
          projectId: activeProjectId,
          perMinute: rates.length > 0 ? Math.max(...rates.map((rate) => rate.creditsPerMinute)) : 0,
        };
        hostedBurnPerMinuteRef.current = burn;
      }
      if (burn.perMinute <= 0) {
        return;
      }
      const balance = creditBilling.creditBalance ?? 0;
      const minutesLeft = balance / burn.perMinute;
      if (minutesLeft > 45) {
        runwayWarnedRef.current = false;
        return;
      }
      if (minutesLeft <= 30 && minutesLeft > 0 && !runwayWarnedRef.current) {
        runwayWarnedRef.current = true;
        showStatus(
          `Heads up: today's credits cover about ${Math.max(1, Math.round(minutesLeft))} more minutes — the hosted machine pauses when they run out. Credits refill at 00:00 UTC.`,
          "warning",
          10000,
          {
            id: "runtime-runway-warning",
            actionLabel: "Open credits",
            onAction: () => openPanelTab("credits"),
            forceVisible: true,
          },
        );
      }
    };
    void evaluate();
    return () => {
      cancelled = true;
    };
  }, [
    activeProjectId,
    creditBilling.creditBalance,
    creditsControllerEnabled,
    hostedRuntimeOnline,
    openPanelTab,
    showStatus,
  ]);

  const [gitDirtyCount, setGitDirtyCount] = useState(0);
  const [gitSupported, setGitSupported] = useState(false);
  const gitStatusEpochRef = useRef(0);

    useEffect(() => {
      gitStatusEpochRef.current += 1;
    }, [
      activeProjectId,
      controllerProjectMissing,
      effectiveRuntimeId,
      projectReadyForWorkspace,
      runtimeReady,
    ]);

    const refreshGitStatus = useCallback(
      async (options?: { silent?: boolean }) => {
        const epoch = gitStatusEpochRef.current;
        if (!activeProjectId || controllerProjectMissing || !projectReadyForWorkspace) {
          if (!options?.silent) {
            setGitDirtyCount(0);
            setGitSupported(false);
          }
        return false;
      }
      const result = await controllerClient.workspace.git.fetchStatus({
        projectId: activeProjectId,
        runtimeId: effectiveRuntimeId ?? null,
        limit: 1,
      }).catch(() => null);

      if (gitStatusEpochRef.current !== epoch) {
        return false;
      }

      if (!result) {
        if (!options?.silent) {
          setGitDirtyCount(0);
          setGitSupported(false);
        }
        return false;
      }
      setGitSupported(result.supported);
      const count = result.supported
        ? Math.max(0, typeof result.dirtyCount === "number" ? result.dirtyCount : result.dirtyPaths.length)
        : 0;
      setGitDirtyCount(count);
      return true;
      },
      [activeProjectId, controllerProjectMissing, effectiveRuntimeId, projectReadyForWorkspace],
    );

  useEffect(() => {
    setGitDirtyCount(0);
    setGitSupported(false);
  }, [activeProjectId]);

    useEffect(() => {
      if (!activeProjectId || controllerProjectMissing || !projectReadyForWorkspace) {
        return;
      }
      let cancelled = false;
      let timeoutId: number | null = null;
    const tick = async () => {
      if (cancelled) {
        return;
      }
      const succeeded = await refreshGitStatus({ silent: true });
      if (cancelled) {
        return;
      }
      timeoutId = window.setTimeout(
        () => void tick(),
        succeeded ? GIT_STATUS_POLL_INTERVAL_MS : GIT_STATUS_POLL_BACKOFF_MS,
      );
    };

    void tick();
      return () => {
        cancelled = true;
        if (timeoutId !== null) {
          window.clearTimeout(timeoutId);
        }
      };
    }, [activeProjectId, controllerProjectMissing, projectReadyForWorkspace, refreshGitStatus]);

    useEffect(() => {
      if (!activeProjectId || controllerProjectMissing || !projectReadyForWorkspace) {
        return;
      }
      if (typeof window === "undefined") {
        return;
      }
    const handler = (event: Event) => {
      const custom = event as CustomEvent<{ projectId?: string | null }>;
      const projectIdFromEvent =
        custom.detail && typeof custom.detail.projectId === "string" ? custom.detail.projectId : null;
      if (projectIdFromEvent && projectIdFromEvent !== activeProjectId) {
        return;
      }
      void refreshGitStatus({ silent: false });
    };
    window.addEventListener("instafy:workspace-commit", handler as EventListener);
      return () => {
        window.removeEventListener("instafy:workspace-commit", handler as EventListener);
      };
    }, [activeProjectId, controllerProjectMissing, projectReadyForWorkspace, refreshGitStatus]);

    useEffect(() => {
      if (typeof window === "undefined") {
        return;
      }
      const handler = (event: Event) => {
        const custom = event as CustomEvent<SourceControlOpenDetail>;
        const previewPath =
          custom.detail && typeof custom.detail.previewPath === "string" && custom.detail.previewPath.trim().length > 0
            ? custom.detail.previewPath.trim()
            : null;
        const reviewMode =
          custom.detail?.reviewMode === "all" || custom.detail?.reviewMode === "focused"
            ? custom.detail.reviewMode
            : undefined;
        runStudioNavigation(() => {
          setSourceControlOpenRequest({ key: Date.now(), previewPath, reviewMode });
          navigateToDestination({ kind: "drawer", workspaceTab: "sourceControl" });
        });
      };
      window.addEventListener("instafy:open-source-control", handler as EventListener);
      return () => {
        window.removeEventListener("instafy:open-source-control", handler as EventListener);
      };
    }, [
      navigateToDestination,
      runStudioNavigation,
      setSourceControlOpenRequest,
    ]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    const handler = () => {
      // Runtime toasts are above WorkspaceTabsProvider; the destination owner
      // handles the event after any mobile drawer history has closed.
      navigateToDestination({ kind: "panel", panel: "machines" });
    };
    window.addEventListener("instafy:open-machines", handler as EventListener);
    return () => {
      window.removeEventListener("instafy:open-machines", handler as EventListener);
    };
  }, [navigateToDestination]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    const handler = (event: Event) => {
      const custom = event as CustomEvent<GitReviewOpenDetail>;
      const review = custom.detail?.review ?? null;
      if (!review) {
        return;
      }
      runStudioNavigation(() => {
        if (!isLargeScreen) {
          setLeftDrawer(null);
          setMobileGitReviewSheet(review);
          return;
        }
        requestHistoryPush();
        openGitReviewTab(review);
      });
    };
    window.addEventListener("instafy:open-git-review", handler as EventListener);
    return () => {
      window.removeEventListener("instafy:open-git-review", handler as EventListener);
    };
  }, [
    isLargeScreen,
    openGitReviewTab,
    requestHistoryPush,
    runStudioNavigation,
    setLeftDrawer,
    setMobileGitReviewSheet,
  ]);

  const sourceControlBadge = useMemo(() => {
    if (!gitSupported || gitDirtyCount <= 0) {
      return null;
    }
    const label = `${gitDirtyCount} uncommitted ${gitDirtyCount === 1 ? "change" : "changes"}`;
    return { count: gitDirtyCount, label };
  }, [gitDirtyCount, gitSupported]);

    const sidebarItems = useMemo(() => {
      return navItems.map((item) => {
        if (item.id === "sourceControl") {
          return { ...item, badge: sourceControlBadge };
        }
        return item;
      });
    }, [sourceControlBadge]);

    const sidebarMoreItems = useMemo(() => {
      return navMoreItems.map((item) => item.id === "credits" ? { ...item, indicator: creditsIndicator ?? null } : item);
    }, [creditsIndicator]);

  useEffect(() => {
    if (!isLargeScreen || !mobileGitReviewSheet) {
      return;
    }
    requestHistoryPush();
    openGitReviewTab(mobileGitReviewSheet);
    setMobileGitReviewSheet(null);
  }, [isLargeScreen, mobileGitReviewSheet, openGitReviewTab, requestHistoryPush, setMobileGitReviewSheet]);

  // The sheet dismisses on backdrop tap; Escape must work too.
  useEffect(() => {
    if (isLargeScreen || !mobileGitReviewSheet) {
      return;
    }
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        setMobileGitReviewSheet(null);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isLargeScreen, mobileGitReviewSheet, setMobileGitReviewSheet]);

  const prepareSidebarToggleFocus = useSidebarToggleFocus(isLargeScreen, sidebarCollapsed);
  const handleToggleSidebar = useCallback(() => {
    if (isLargeScreen) {
      prepareSidebarToggleFocus();
      setSidebarCollapsed((previous) => !previous);
      return;
    }
    setMobileSidebarOpen((previous) => {
      if (!previous) {
        setLeftDrawer(null);
      }
      return !previous;
    });
  }, [isLargeScreen, prepareSidebarToggleFocus, setLeftDrawer, setMobileSidebarOpen, setSidebarCollapsed]);

  const handleOpenConversationHistory = useCallback(() => {
    navigateToDestination({ kind: "panel", panel: "chat", workspaceTab: "history" });
  }, [navigateToDestination]);

  const [mobilePickerMode, setMobilePickerMode] = useState<"teams-and-spaces" | "spaces">("teams-and-spaces");
  const handleWorkspaceSwitcherOpenChange = useCallback((open: boolean) => {
    if (!isLargeScreen) {
      if (routeOwnedMobileWorkspaceDrawer) {
        if (!open) dismissRouteOwnedWorkspaceDrawer();
      } else if (open) {
        mobileSidebarNavigation.openView("workspace");
      }
      return;
    }
    if (open || leftDrawer === "workspaces") {
      navigateToDestination({ kind: "drawer", workspaceTab: open ? "workspaces" : null });
    }
  }, [dismissRouteOwnedWorkspaceDrawer, isLargeScreen, leftDrawer, mobileSidebarNavigation, navigateToDestination, routeOwnedMobileWorkspaceDrawer]);

  const openMobileContextDirectory = useCallback((mode: "teams-and-spaces" | "spaces") => {
    setMobilePickerMode(mode);
    setLeftDrawer(null);
    mobileSidebarNavigation.openView("workspace");
  }, [mobileSidebarNavigation, setLeftDrawer]);

  const handleMobileSidebarOpenChange = useCallback((open: boolean) => {
    if (!open && routeOwnedMobileWorkspaceDrawer) {
      dismissRouteOwnedWorkspaceDrawer();
    } else {
      setMobileSidebarOpen(open);
    }
  }, [dismissRouteOwnedWorkspaceDrawer, routeOwnedMobileWorkspaceDrawer, setMobileSidebarOpen]);

  const handleOpenTeam = useCallback((orgKey: string) => {
    navigateToDestination({ kind: "panel", panel: "team", teamId: orgKey });
  }, [navigateToDestination]);
  const handleReturnToTeam = useCallback((orgKey: string) => {
    const target = teamReturnRoutes.current.routes.get(orgKey);
    if (target) navigateToDestination({ kind: "route", search: new URL(target, "https://instafy.invalid").search });
    else if (orgKey === activeProjectOrgKey && activeProjectId) {
      navigateToDestination({ kind: "conversation", projectId: activeProjectId });
    } else handleOpenTeam(orgKey);
  }, [activeProjectId, activeProjectOrgKey, handleOpenTeam, navigateToDestination]);
  const handleActivateProject = useCallback((projectId: string, orgKey: string) => {
    const previous = teamReturnRoutes.current.routes.get(orgKey);
    const previousUrl = previous ? new URL(previous, "https://instafy.invalid") : null;
    navigateToDestination(previousUrl?.searchParams.get("projectId") === projectId
      ? { kind: "route", search: previousUrl.search }
      : { kind: "conversation", projectId });
  }, [navigateToDestination]);
  const handleOpenHome = useCallback(() => {
    navigateToDestination({ kind: "panel", panel: "home", teamId: navigationScope.orgKey });
  }, [navigateToDestination, navigationScope.orgKey]);
  const handleNavigationPanelSelect = useCallback((panel: StudioPanel) => {
    if (panel === "home") handleOpenHome();
    else if (panel === "team") handleOpenTeam(navigationScope.orgKey);
    else runStudioNavigation(() => handlePanelSelect(panel));
  }, [handleOpenHome, handleOpenTeam, handlePanelSelect, navigationScope.orgKey, runStudioNavigation]);
  const handleNavigateBack = useCallback(() => {
    consumeUrlNavigation();
    if (mobileHistory.canGoBack) mobileHistory.goBack();
    else handleOpenTeam(navigationScope.orgKey);
  }, [consumeUrlNavigation, handleOpenTeam, mobileHistory, navigationScope.orgKey]);

  const handleOpenChatNavigation = useCallback(() => {
    if (isLargeScreen) {
      setSidebarCollapsed(false);
      return;
    }
    if (leftDrawer) {
      requestHistoryPush();
      setLeftDrawer(null);
    }
    setMobileSidebarOpen(true);
  }, [isLargeScreen, leftDrawer, requestHistoryPush, setLeftDrawer, setMobileSidebarOpen, setSidebarCollapsed]);

  const handleSelectRecentConversation = useCallback((conversationId: string) => {
    if (!activeProjectId) return;
    navigateToDestination({ kind: "conversation", projectId: activeProjectId, conversationId,
      conversationControllerId: conversations.find(conversation => conversation.localId === conversationId)?.controllerId });
  }, [activeProjectId, conversations, navigateToDestination]);

  const prepareWorkspaceForNewSession = useCallback((options?: { closeProjectLauncher?: boolean }) => {
    if (options?.closeProjectLauncher !== false) {
      setIsProjectLauncherOpen(false);
    }
    resetTabs();
    clearTabs();
    setLeftDrawer(null);

  }, [clearTabs, resetTabs, setIsProjectLauncherOpen, setLeftDrawer]);

  const handleOpenProjectPicker = useCallback(() => {
    navigateToDestination({ kind: "panel", panel: "projects" });
  }, [navigateToDestination]);

  const handlePromptBootstrapResult = useCallback(
    (result: SubmitPromptResult) => {
      if (result.status === "success") {
        prepareWorkspaceForNewSession();
        return;
      }
      if (result.status === "error") {
        const message =
          result.error instanceof Error ? result.error.message : "Unable to send prompt. Please try again.";
        showStatus(message, "error", 4000);
      }
    },
    [prepareWorkspaceForNewSession, showStatus]
  );

  usePromptBootstrap(handlePromptBootstrapResult);

  const createFreshConversation = useCallback(() => {
    requestHistoryPush();
    if (!isLargeScreen) {
      setLeftDrawer(null);
    }
    const projectId = activeProjectId && isUUID(activeProjectId) ? activeProjectId : null;
    const conversationIndex = conversations.length + 1;
    const conversation = createConversation({
      title: `Conversation ${conversationIndex}`,
      messages: [
        {
          id: `assistant-${Date.now()}-${Math.random().toString(16).slice(2)}`,
          role: "assistant",
          content: "How can I help with your space?",
          timestamp: Date.now(),
          files: null,
          messageType: "status",
          metadata: null
        }
      ],
      select: true
    });
    selectConversation(conversation.localId);
    markConversationRead(conversation.localId);
    setPendingConversationTabOpenId(conversation.localId);
    if (!projectId) {
      return;
    }
    void (async () => {
      const response = await controllerClient.conversations.createBlank({
        projectId,
        metadata: { title: `Conversation ${conversationIndex}`, localId: conversation.localId }
      });
      if (!response?.conversationId) {
        return;
      }
      setConversationControllerId(conversation.localId, response.conversationId);
    })();
  }, [
    activeProjectId,
    conversations,
    createConversation,
    isLargeScreen,
    markConversationRead,
    requestHistoryPush,
    selectConversation,
    setConversationControllerId,
    setLeftDrawer,
  ]);

  const handlePrivateConversationCreated = useCallback((conversation: { localId: string }) => {
    requestHistoryPush();
    if (!isLargeScreen) setLeftDrawer(null);
    selectConversation(conversation.localId);
    markConversationRead(conversation.localId);
    setPendingConversationTabOpenId(conversation.localId);
  }, [isLargeScreen, markConversationRead, requestHistoryPush, selectConversation, setLeftDrawer]);

  const handleCreatePrivateConversation = useCreatePrivateConversation({
    projectId: activeProjectId,
    userId: currentUserId,
    accessToken: auth.session?.access_token ?? null,
    createConversation,
    showStatus,
    onCreated: handlePrivateConversationCreated,
  });

  useEffect(() => {
    if (!pendingConversationTabOpenId) {
      return;
    }
    openConversationTab(pendingConversationTabOpenId);
    setPendingConversationTabOpenId(null);
  }, [openConversationTab, pendingConversationTabOpenId]);

  const handleCreateBlankProject = useCallback(
    async (
      projectName?: string,
      org?: { orgId?: string | null; orgSlug?: string | null; orgName?: string | null }
    ) => {
      const resolvedName =
        typeof projectName === "string" && projectName.trim().length > 0
          ? projectName.trim()
          : "Untitled Space";
      const projectInfo = await controllerClient.projects.create({
        projectType: "customer",
        projectName: resolvedName,
        orgId: org?.orgId ?? null,
        orgSlug: org?.orgSlug ?? null,
        orgName: org?.orgName ?? null
      }).catch(() => null);
      if (!projectInfo?.projectId || !isUUID(projectInfo.projectId)) {
        showStatus("Unable to start a new space right now.", "error", 4000);
        throw new Error("project-create-failed");
      }
      writePendingProjectSwitch(projectInfo.projectId);
      createProject({
        projectId: projectInfo.projectId,
        projectName: resolvedName,
        orgId: projectInfo.orgId ?? null,
        orgName: projectInfo.orgName ?? null
      });
      prepareWorkspaceForNewSession();
      showStatus("Created a new space.", "success", 2500);
    },
    [createProject, prepareWorkspaceForNewSession, showStatus]
  );

  const handleCreateGithubProject = useCallback(
    async (
      projectName: string,
      org: { orgId?: string | null; orgSlug?: string | null; orgName?: string | null },
      github: { repo: string; ref?: string | null; githubDeviceAuthSessionId?: string | null },
    ): Promise<{ success: boolean; error?: string | null }> => {
      const resolvedName =
        typeof projectName === "string" && projectName.trim().length > 0
          ? projectName.trim()
          : "Untitled Space";
      const projectInfo = await controllerClient.projects.create({
        projectType: "customer",
        projectName: resolvedName,
        orgId: org?.orgId ?? null,
        orgSlug: org?.orgSlug ?? null,
        orgName: org?.orgName ?? null
      }).catch(() => null);
      if (!projectInfo?.projectId || !isUUID(projectInfo.projectId)) {
        return { success: false, error: "Unable to start a new space right now." };
      }

      writePendingProjectSwitch(projectInfo.projectId);

      createProject({
        projectId: projectInfo.projectId,
        projectName: resolvedName,
        orgId: projectInfo.orgId ?? null,
        orgName: projectInfo.orgName ?? null
      });
      prepareWorkspaceForNewSession({ closeProjectLauncher: false });

      const targetPath = controllerClient.projects.deriveGithubImportTargetPath(github.repo);
      const importIdentity = buildGithubImportRetryIdentity({
        projectId: projectInfo.projectId,
        sourceMessageId: "project-launcher",
        repo: github.repo,
        ref: github.ref ?? null,
        targetPath,
      });
      const importResult = await executeGithubProjectImport({
        projectId: projectInfo.projectId,
        repo: github.repo,
        ref: github.ref ?? null,
        targetPath,
        githubDeviceAuthSessionId: github.githubDeviceAuthSessionId ?? null,
        idempotencyKey: importIdentity.idempotencyKey,
      });
      if (!importResult.success) {
        return { success: false, error: importResult.error ?? "GitHub import failed." };
      }
      showStatus(
        formatGithubImportSuccessMessage({
          repo: github.repo,
          fileCount: importResult.fileCount ?? null,
          targetPath: importResult.targetPath ?? null,
        }),
        "success",
        3500,
      );
      if (importResult.notice) {
        showStatus(importResult.notice, "info", 9000, {
          id: "github-import-fit-notice",
          forceVisible: true,
        });
      }
      return { success: true };
    },
    [createProject, prepareWorkspaceForNewSession, showStatus]
  );

  const handleOpenSettingsTab = useCallback(
    (tab: SettingsTab, meta: { title: string; icon: ReactNode }) => {
      runAfterSidebarClose(() => {
        setPanelTabMeta("settings", meta);
        navigateToDestination({ kind: "panel", panel: "settings", settingsTab: tab });
      });
    },
    [navigateToDestination, runAfterSidebarClose, setPanelTabMeta]
  );

  const handleOpenOrgSettings = useCallback((organizationId?: string | null, category: "profile" | "members" = "profile") => {
    const orgId = organizationId ?? activeProjectSummary?.orgId ?? null;
    runStudioNavigation(() => {
      setPanelTabMeta("settings", {
        title: orgId === activeProjectSummary?.orgId ? orgSettingsTitle : "Team settings",
        icon: <Group className="text-[16px]" aria-hidden="true" />,
      });
      navigateToDestination({ kind: "panel", panel: "settings", settingsTab: "org", settingsOrgId: orgId, settingsCategory: category });
    });
  }, [activeProjectSummary?.orgId, navigateToDestination, orgSettingsTitle, runStudioNavigation, setPanelTabMeta]);

  // ChatPanel's read-only notice cannot open a workspace tab itself —
  // WorkspaceTabsProvider is mounted below the providers that panel runs in — so
  // it asks here, the same way "instafy:open-source-control" does.
  useEffect(() => {
    if (typeof window === "undefined") {
      return undefined;
    }
    const handler = () => {
      handleOpenOrgSettings(undefined, "members");
    };
    window.addEventListener("instafy:open-org-members", handler);
    return () => {
      window.removeEventListener("instafy:open-org-members", handler);
    };
  }, [handleOpenOrgSettings]);

  const handleOpenProjectSettings = useCallback(() => {
    handleOpenSettingsTab("project", {
      title: "Space settings",
      icon: <Cube className="text-[16px]" aria-hidden="true" />
    });
  }, [handleOpenSettingsTab]);

  const handleOpenProfileSettings = useCallback(() => {
    runStudioNavigation(() => {
      setPanelTabMeta("settings", {
        title: "Your settings",
        icon: <User className="text-[16px]" aria-hidden="true" />
      });
      navigateToDestination({ kind: "panel", panel: "settings", settingsTab: "profile", teamId: navigationScope.orgKey });
    });
  }, [navigateToDestination, navigationScope.orgKey, runStudioNavigation, setPanelTabMeta]);

  const handleNewProject = (preferredOrgId?: string | null) => {
    setProjectLauncherPreferredOrgId(preferredOrgId ?? null);
    setIsProjectLauncherOpen(true);
    showStatus("Start a new space with a prompt or template.", "info", 3500);
  };


  useEffect(() => {
    if (!authLoading && !user) {
      navigate("/login", { replace: true });
    }
  }, [authLoading, navigate, user]);


  const handleSideTabReorder = useCallback(
    (tabId: string, targetIndex: number) => {
      moveSideTab(tabId, targetIndex);
    },
    [moveSideTab]
  );
  const handleSignOut = useCallback(async () => {
    try {
      await signOut?.();
      showStatus("Signed out.", "info", 2000);
      navigate("/login", { replace: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to sign out";
      showStatus(message, "error");
    }
  }, [navigate, showStatus, signOut]);
  const mobileOverviewSection = resolveMobileOverviewSection(activeWorkspaceTab, leftDrawer);
  const showMobileBottomDock = showTouchBottomDock && mobileOverviewSection !== null && !keyboardOpen;
  const handleMobileDockOpenChat = useCallback(() => {
    navigateToDestination({ kind: "panel", panel: "chat", workspaceTab: "history" });
  }, [navigateToDestination]);
  const handleMobileDockOpenProjects = useCallback(() => {
    navigateToDestination({ kind: "panel", panel: "projects" });
  }, [navigateToDestination]);
  const handleFilesMobileViewChange = useCallback(
    (nextView: FilesPanelMobileView) => {
      const change = resolveStudioFilesMobileViewChange({
        isLargeScreen,
        leftDrawer,
        preferredView: preferredFilesMobileView,
        requestedView: nextView,
      });
      setPreferredFilesMobileView(change.preferredView);
      if (change.shouldCloseExplorer) {
        requestHistoryPush();
        setLeftDrawer(null);
      }
    },
    [
      isLargeScreen,
      leftDrawer,
      preferredFilesMobileView,
      requestHistoryPush,
      setLeftDrawer,
    ],
  );
  const handleRequestCloseFilesExplorer = useCallback(() => {
    if (!isLargeScreen) {
      setPreferredFilesMobileView("viewer");
    }
    requestHistoryPush();
    if (leftDrawer === "files") {
      setLeftDrawer(null);
    }
  }, [isLargeScreen, leftDrawer, requestHistoryPush, setLeftDrawer]);
  const handleRequestOpenFilesExplorer = useCallback(() => {
    if (leftDrawer === "files") {
      return;
    }
    setPreferredFilesMobileView((current) =>
      resolvePreferredFilesMobileViewForExplorerOpen({
        isLargeScreen,
        preferredView: current,
      }),
    );
    requestHistoryPush();
    setLeftDrawer("files");
  }, [isLargeScreen, leftDrawer, requestHistoryPush, setLeftDrawer]);
  const projectAccessBlocked = controllerProjectMissing;
  const effectiveSideVisible = projectAccessBlocked ? false : sideVisible;
  const scrollPaddingClass = isLargeScreen && effectiveSideVisible ? "pr-6" : "pr-0";
  const sidebarActivePanel =
    leftDrawer === "files"
      ? "code"
      : leftDrawer === "sourceControl"
        ? "sourceControl"
        : activePanel;
  const sidePaneNode = effectiveSideVisible ? (
    <Surface tone="default" radius="2xl" shadow="sm" className="flex h-full flex-col">
      <SidePaneTabs
        tabs={sideTabs}
        activeTabId={activeTabId}
        onSelect={focusSideTab}
        onClose={closeSideTab}
        onReorder={handleSideTabReorder}
        className="border-b border-slate-200/70 dark:border-[color:var(--color-studio-dark-divider)]"
      />
      <div className="flex-1 overflow-hidden">
        {activeSideTab?.content ?? (
          <div className="flex h-full items-center justify-center text-sm text-slate-500 dark:text-slate-400">
            Select a tab to get started.
          </div>
        )}
      </div>
    </Surface>
  ) : null;
  const shouldShowFilesWorkspace =
    !projectAccessBlocked &&
    (activeWorkspaceTab?.kind === "file" ||
      (activeWorkspaceTab?.kind === "panel" && activeWorkspaceTab.panel === "code"));
  const shouldRenderFilesExplorerPortal =
    leftDrawer === "files" && !shouldShowFilesWorkspace;
  const showMobileLeftDrawerOverlay =
    !isLargeScreen && leftDrawer !== null && leftDrawer !== "workspaces" && !(leftDrawer === "files" && shouldShowFilesWorkspace);
  const topbarLocationOverride = showMobileLeftDrawerOverlay
    ? leftDrawer === "files"
      ? { title: "Files", icon: <Page className="text-[16px]" aria-hidden="true" /> }
      : leftDrawer === "history"
        ? { title: "Chats", icon: <ChatsIcon className="text-[16px]" aria-hidden="true" /> }
        : leftDrawer === "sourceControl"
          ? { title: "Changes", icon: <GitBranch className="text-[16px]" aria-hidden="true" /> }
          : null
    : null;

  const showChatActions = !projectAccessBlocked;

  const workspaceTabsElement = null;
  const routeParams = new URLSearchParams(location.search);
  const routedPanel = routeParams.get("panel") ?? "chat";
  const panelScrollReady = projectReadyForWorkspace &&
    (!routeParams.get("projectId") || routeParams.get("projectId") === activeProjectId) &&
    routedPanel === activeWorkspaceTabPanel;
  const panelScrollIdentity = buildStudioPanelScrollIdentity({
    userId: currentUserId, projectId: activeProjectId,
    visitKey: getStudioVisitKey(location), panel: activeWorkspaceTabPanel ?? "projects",
    section: routedPanel === "settings"
      ? JSON.stringify({ ...resolveSettingsRoute(location.search, settingsTab), organizationId: settingsOrgId })
      : routedPanel === "team" ? navigationScope.orgKey : null,
  });

  let workspaceContent: ReactNode;
  let workspaceContentIsLazy = false;
  if (projectAccessBlocked) {
    const scroller = (
      <div className={`flex-1 overflow-y-auto ${scrollPaddingClass}`}>
        <ProjectPickerPanel
          onCreateProject={handleCreateBlankProject}
          searchTerm={projectPickerSearchTerm}
          onSearchTermChange={setProjectPickerSearchTerm}
        />
      </div>
    );
    workspaceContent = (
      <div className="flex h-full flex-col overflow-hidden">
        {scroller}
      </div>
    );
  } else if (shouldShowFilesWorkspace) {
    workspaceContentIsLazy = true;
    workspaceContent = (
      <FilesPanel
        tabsSlot={workspaceTabsElement}
        previewOwnerId={user?.id ?? null}
        onDirectoryEntriesLoaded={knownWorkspaceFiles.recordDirectory}
        showExplorer
        explorerPortalTarget={filesExplorerPortalTarget}
        mobileView={filesMobileView}
        onMobileViewChange={handleFilesMobileViewChange}
        onRequestOpenExplorer={handleRequestOpenFilesExplorer}
        onRequestCloseExplorer={handleRequestCloseFilesExplorer}
      />
    );
  } else if (!activeWorkspaceTab) {
    workspaceContent = (
      <div className="flex h-full items-center justify-center text-sm text-slate-500">
        Open a panel to get started.
      </div>
    );
  } else if (activeWorkspaceTab.kind === "jobThread") {
    workspaceContent = (
      <div className="flex h-full flex-col">
        <div className="flex-1 min-h-0">
          <ChatPanel jobThread={{ conversationId: activeWorkspaceTab.conversationId, jobId: activeWorkspaceTab.jobId }} />
        </div>
      </div>
    );
  } else if (activeWorkspaceTab.kind === "conversation") {
    workspaceContent = (
      <div className="flex h-full flex-col">
        <div className="flex-1 min-h-0">
          <ChatPanel />
        </div>
      </div>
    );
  } else if (activeWorkspaceTab.kind === "gitDiff") {
    workspaceContentIsLazy = true;
    workspaceContent = (
      <GitDiffView path={activeWorkspaceTab.path} commitRange={activeWorkspaceTab.commitRange} />
    );
  } else if (activeWorkspaceTab.kind === "gitReview") {
    workspaceContentIsLazy = true;
    workspaceContent = <GitReviewView review={activeWorkspaceTab.review} />;
  } else if (activeWorkspaceTab.kind === "panel") {
    if (activeWorkspaceTab.panel === "chat") {
      workspaceContent = (
        <div className="flex h-full flex-col">
          <div className="flex-1 min-h-0">
            <ChatPanel />
          </div>
        </div>
      );
    } else if (activeWorkspaceTab.panel === "sourceControl") {
      workspaceContentIsLazy = true;
      workspaceContent = (
        <div className="flex h-full flex-col overflow-hidden">
          <SourceControlDrawer openRequest={sourceControlOpenRequest} />
        </div>
      );
    } else if (activeWorkspaceTab.panel === "projects") {
      const scroller = (
        <StudioPanelScrollContainer identity={panelScrollIdentity} ready={panelScrollReady} className={`flex-1 overflow-y-auto ${scrollPaddingClass}`}>
          <ProjectPickerPanel
            onCreateProject={handleCreateBlankProject}
            searchTerm={projectPickerSearchTerm}
            onSearchTermChange={setProjectPickerSearchTerm}
          />
        </StudioPanelScrollContainer>
      );
      workspaceContent = (
        <div className="flex h-full flex-col overflow-hidden">
          {scroller}
        </div>
      );
    } else {
      workspaceContentIsLazy = activeWorkspaceTab.panel !== "home";
      const scroller = (
        <StudioPanelScrollContainer identity={panelScrollIdentity} ready={panelScrollReady} className={`flex-1 overflow-y-auto ${scrollPaddingClass}`} data-testid="studio-panel-scroll">
          {activeWorkspaceTab.panel === "home" ? (
            <HomePanel inboxItems={homeAttentionInboxItems} refreshInbox={refreshHomeAttentionCount} notifications={notificationCenter} supportReports={bugReportController.supportUnreadReports} supportLoading={bugReportController.supportNotificationsLoading} supportError={bugReportController.supportNotificationsError} refreshSupport={() => bugReportController.refreshSupportNotifications(false)} onOpenSupport={bugReportController.onOpenBugReportInbox} />
          ) : activeWorkspaceTab.panel === "team" ? (
            <TeamPanel organizationId={navigationScope.orgKey === "personal" ? null : navigationScope.orgKey} />
          ) : activeWorkspaceTab.panel === "credits" ? (
            <CreditsPanel />
          ) : activeWorkspaceTab.panel === "extensions" ? (
            <ExtensionsPanel />
          ) : activeWorkspaceTab.panel === "settings" ? (
            <SettingsPanel activeTab={settingsTab} organizationId={settingsOrgId} onOrganizationChange={(id) => {
              navigateToDestination({ kind: "panel", panel: "settings", settingsTab: "org", settingsOrgId: id,
                settingsCategory: resolveSettingsRoute(window.location.search, "org").category });
            }} />
          ) : activeWorkspaceTab.panel === "skills" ? (
            <SkillsPanel />
          ) : activeWorkspaceTab.panel === "secrets" ? (
            <SecretsPanel />
          ) : activeWorkspaceTab.panel === "ai" ? (
            <AiPanel />
          ) : activeWorkspaceTab.panel === "automations" ? (
            <AutomationsPanel />
          ) : activeWorkspaceTab.panel === "machines" ? (
            <MachinesPanel />
          ) : null}
        </StudioPanelScrollContainer>
      );
      workspaceContent = (
        <div className="flex h-full flex-col overflow-hidden">
          {scroller}
        </div>
      );
    }
  }
  const mobileOverviewDock = showMobileBottomDock && mobileOverviewSection ? (
    <MobileBottomDock
      activeSlot={mobileOverviewSection}
      homeAttentionCount={homeAttentionCount}
      onHomePress={handleOpenHome}
      onChatPress={handleMobileDockOpenChat}
      onProjectsPress={handleMobileDockOpenProjects}
    />
  ) : null;
  const mobileTopbarNavigation = !isLargeScreen ? {
    visitKey: location.key,
    history: mobileHistory,
    onOpenPicker: handleToggleSidebar,
    onOpenChats: handleMobileDockOpenChat,
  } : undefined;
  if (!isChatSurfaceVisible || projectAccessBlocked) {
    workspaceContent = (
      <StudioPanelPerformance
        projectId={activeProjectId}
        organizationId={activeProjectSummary?.orgId ?? null}
        enabled={!activeProjectId || conversationsProjectKey === activeProjectId}
        loading={!projectReadyForWorkspace || !workspaceContent || (!activeWorkspaceTab && !projectAccessBlocked)}
        error={projectReadyForWorkspace && projectAccessBlocked}
        deferred={workspaceContentIsLazy}
        requestedPanel={projectAccessBlocked ? "projects" : activePanel}
      >
        {workspaceContent}
      </StudioPanelPerformance>
    );
  }
  const workspaceSurface = shouldShowFilesWorkspace ? (
    <div className="flex h-full min-w-0 flex-col overflow-hidden bg-white text-slate-700 shadow-sm dark:bg-[var(--color-studio-dark-panel)] dark:text-slate-200">
      <div key={activeProjectId ?? "files-workspace"} className="min-h-0 flex-1">
        {workspaceContent}
      </div>
      {!showMobileLeftDrawerOverlay ? mobileOverviewDock : null}
    </div>
  ) : (
    <div className="flex h-full min-w-0 flex-col overflow-hidden bg-white text-slate-700 shadow-sm dark:bg-[var(--color-studio-dark-panel)] dark:text-slate-200">
      {workspaceTabsElement}
      <div className="flex-1 overflow-hidden">
        <div key={activeWorkspaceTab?.id ?? "empty"} className="h-full">
          {workspaceContent}
        </div>
      </div>
      {!showMobileLeftDrawerOverlay ? mobileOverviewDock : null}
    </div>
  );

  const [desktopContextTarget, setDesktopContextTarget] = useState<HTMLDivElement | null>(null);
  const [mobileContextTarget, setMobileContextTarget] = useState<HTMLDivElement | null>(null);
  const mobileSearchTriggerRef = useRef<HTMLButtonElement | null>(null);
  const overlaySearchTriggerRef = useRef<HTMLButtonElement | null>(null);
  const globalSearch = navigationScope.page === "home" || navigationScope.page === "account";
  const searchOrg = globalSearch ? null : { id: navigationScope.orgKey, name: activeTeamName };
  const searchSpace = !globalSearch && activeProjectId && activeProjectOrgKey === navigationScope.orgKey && !projectAccessBlocked
    ? { id: activeProjectId, name: activeProjectName } : null;
  const searchNavigation = useStudioSearchNavigation({
    viewerUserId: currentUserId, location, activeProjectId,
    projectReady: projectReadyForWorkspace, projectAccessBlocked, conversationsProjectKey,
    navigateToDestination, openFileTab, getSearchOriginToken: searchHistory.getOriginToken,
  });
  const searchData = useStudioSearchRecords({
    viewerUserId: currentUserId,
    enabled: searchRequest?.key === searchKey && searchRequest.open,
    query: searchRequest?.key === searchKey ? searchRequest.query : '',
    restoreMessagePages: searchRequest?.key === searchKey ? searchRequest.restoreMessagePages : undefined,
    scope: searchRequest?.key === searchKey ? searchRequest.scope : searchSpace ? "space" : searchOrg ? "org" : "all",
    orgId: searchOrg?.id ?? null,
    spaceId: searchSpace?.id ?? null,
    projects: projectList,
    knownFiles: knownWorkspaceFiles.files,
    activeConversations: activeProjectId && conversationsProjectKey === activeProjectId ? { projectId: activeProjectId, items: conversations } : null,
    onActivate: searchNavigation.activateTarget,
  });
  const search = useStudioSearch({
    scopeKey: searchKey, org: searchOrg, space: searchSpace, records: searchData.records,
    loading: searchData.loading, error: searchData.error, onRetry: searchData.retry, notice: searchData.notice,
    hasMoreMessages: searchData.hasMoreMessages, loadingMoreMessages: searchData.loadingMoreMessages,
    onLoadMoreMessages: searchData.loadMoreMessages, messagePageCount: searchData.messagePageCount,
    restoreSession: searchHistory.restoredSession, onBeforeResultActivate: searchHistory.remember, onDismiss: searchHistory.dismiss,
    fullPage: true, persistentControl: isLargeScreen, returnFocusRef: showMobileLeftDrawerOverlay ? overlaySearchTriggerRef : mobileSearchTriggerRef,
    onRequestChange: request => setSearchRequest({ ...request, key: searchKey }),
    onOpen: () => { if (!isLargeScreen) runAfterSidebarClose(() => {}); },
  });
  closeSearchForNavigation.current = () => { search.closeSearch(false); searchNavigation.cancelPending(); };
  useNativeBackButtonAction(search.open, () => search.closeSearch(), 200);
  const contextHomeActive = navigationScope.page === "home";
  const mobileContextHeader = (overlay = false) => <StudioMobileContextHeader
    teamName={activeTeamName} teamAvatarUrl={activeTeamAvatarUrl} teamId={navigationScope.orgKey}
    projects={projectList} activeProjectId={activeProjectId} attentionCounts={homeAttentionByProject}
    homeActive={contextHomeActive} homeAttentionCount={homeAttentionCount} searchRef={overlay ? overlaySearchTriggerRef : mobileSearchTriggerRef}
    onHome={handleOpenHome} onSearch={search.openSearch} onProfile={handleOpenProfileSettings}
    onSupport={() => runStudioNavigation(bugReportController.onOpenBugReportInbox)}
    onSignOut={() => runStudioNavigation(() => { void handleSignOut(); })}
    onTeam={() => handleOpenTeam(navigationScope.orgKey)}
    onSettings={navigationScope.orgKey === "personal" ? undefined : () => handleOpenOrgSettings(navigationScope.orgKey)}
    onSwitchTeam={() => openMobileContextDirectory("teams-and-spaces")}
    onBrowseSpaces={() => openMobileContextDirectory("spaces")}
    onSpace={id => handleActivateProject(id, navigationScope.orgKey)}
  />;

  if (!user) return null;

  return (
    <StudioNavigationProvider value={runStudioNavigation}>
    <StudioSearchReturnProvider value={{ originToken: searchHistory.originToken, returnToResults: () => runStudioNavigation(searchHistory.returnToResults) }}>
    <ControllerNoticeActionsProvider value={controllerNoticeActionsValue}>
      {shouldRenderFilesExplorerPortal ? (
        <FilesPanel
          renderMode="portal"
          previewOwnerId={user?.id ?? null}
          onDirectoryEntriesLoaded={knownWorkspaceFiles.recordDirectory}
          showExplorer
          explorerPortalTarget={filesExplorerPortalTarget}
          mobileView={filesMobileView}
          onMobileViewChange={handleFilesMobileViewChange}
          onRequestOpenExplorer={handleRequestOpenFilesExplorer}
          onRequestCloseExplorer={handleRequestCloseFilesExplorer}
        />
      ) : null}
      <div
        className="studio-context-layout relative flex h-screen min-h-screen overflow-hidden bg-slate-50 dark:bg-[var(--color-studio-dark-canvas)]"
        data-search-open={search.open}
        data-wide={isLargeScreen}
        data-titlebar-free={desktopTitleBarFree()}
        style={{
          ...viewportHeightStyle,
          paddingLeft: "var(--instafy-safe-area-inset-left)",
          paddingRight: "var(--instafy-safe-area-inset-right)",
          ...({ "--studio-context-top": desktopTitleBarFree() ? "0px" : "var(--instafy-safe-area-inset-top)", } as React.CSSProperties),
        }}
      >
        <WorkspaceControlsProvider
          value={{
            userEmail: user?.email ?? null,
            homeAttentionCount,
            homeAttentionByProject,
            homeAttentionByOrg,
            onSignOut: handleSignOut,
            activeProjectName,
            onShowLogs: hasBuildLogs ? handleShowBuildLogs : undefined,
            hasLogs: hasBuildLogs,
            buildLogs,
            sidebarCollapsed,
            sidebarOpen: isLargeScreen ? !sidebarCollapsed && navigationScope.page !== "home" && navigationScope.page !== "account" : mobileSidebarOpen,
            navigationPage: showMobileLeftDrawerOverlay ? "workspace" : navigationScope.page,
            activeTeamName,
            activeTeamAvatarUrl,
            onOpenHome: handleOpenHome,
            onOpenTeamSwitcher: () => handleWorkspaceSwitcherOpenChange(true),
            onNavigateBack: handleNavigateBack,
            onToggleSidebar: handleToggleSidebar,
            onOpenChatNavigation: handleOpenChatNavigation,
            onStartNewProject: handleNewProject,
            onStartNewConversation: createFreshConversation,
            onStartPrivateConversation: handleCreatePrivateConversation,
            showChatActions,
            onOpenProjectPicker: handleOpenProjectPicker,
            onOpenOrgSettings: handleOpenOrgSettings,
            onOpenProjectSettings: handleOpenProjectSettings,
            onOpenProfileSettings: handleOpenProfileSettings,
            onOpenBugReport: bugReportController.onOpenBugReport,
            onOpenBugReportInbox: bugReportController.onOpenBugReportInbox,
            supportUnreadCount: bugReportController.supportUnreadCount,
            topbarLocationOverride,
            shakeToReportEnabled: bugReportController.shakeToReportEnabled,
            onToggleShakeToReport: bugReportController.onToggleShakeToReport,
            onSimulateShakeToReport: bugReportController.onSimulateShakeToReport,
            onTestShakeToReport: bugReportController.onTestShakeToReport,
            shakeToReportStatus: bugReportController.shakeToReportStatus,
            shakeToReportDetail: bugReportController.shakeToReportDetail,
          }}
        >
          {isLargeScreen ? <header className="studio-context-header" aria-label="Working context"><div ref={setDesktopContextTarget} className="studio-context-slot" /></header> : null}
          {isLargeScreen ? (
              <StudioSidebar
                navigationPresentation="path"
                navigationHeaderExternal
                navigationHeaderPortalTarget={desktopContextTarget}
                renderNavigationHeader={context => search.renderControl(false, <StudioSearchContext scope={search.scope} context={context} onBroaden={search.changeScope} />)}
                onNavigationHeaderAction={() => search.closeSearch(false)}
                items={sidebarItems}
                moreItems={sidebarMoreItems}
                activePanel={sidebarActivePanel}
                pinnedPanel={null}
                onSelect={handleNavigationPanelSelect}
                selectedOrgKey={navigationScope.orgKey}
                onOpenTeam={handleOpenTeam}
                onReturnToTeam={handleReturnToTeam}
                onActivateProject={handleActivateProject}
                onActiveTeamChange={handleActiveTeamChange}
                hideContext={navigationScope.page === "account"}
                onOpenConversationHistory={handleOpenConversationHistory}
                recentConversations={recentConversations}
                activeConversationId={visibleChatId}
                openConversationIds={openConversationIds}
                onSelectConversation={handleSelectRecentConversation}
                isConversationHistoryActive={isConversationHistoryActive}
                workspaceSwitcherOpen={leftDrawer === "workspaces"}
                onWorkspaceSwitcherOpenChange={handleWorkspaceSwitcherOpenChange}
                workspaceSwitcherPortalTarget={workspaceSwitcherPortalTarget}
                collapsed={sidebarCollapsed}
              />
          ) : null}

          {isLargeScreen && leftDrawer ? (
            <div
              className="studio-context-drawer relative flex h-full shrink-0"
              style={{ width: `${leftDrawerWidth}px` }}
            >
              <div className="flex h-full min-w-0 flex-1 flex-col border-r border-slate-200/70 bg-white dark:border-[color:var(--color-studio-dark-divider)] dark:bg-[var(--color-studio-dark-panel)]">
                {leftDrawer === "history" ? (
                  <ConversationHistoryTab
                    onStartNewConversation={createFreshConversation}
                    onRequestClose={() => {
                      requestHistoryPush();
                      setLeftDrawer(null);
                    }}
                  />
                ) : leftDrawer === "workspaces" ? (
                  <div
                    ref={handleWorkspaceSwitcherPortalRef}
                    className="flex-1 min-h-0"
                    data-testid="workspace-switcher-drawer"
                  />
                ) : leftDrawer === "files" ? (
                  <div
                    ref={handleFilesExplorerPortalRef}
                    className="flex-1 min-h-0"
                    data-testid="files-explorer-drawer"
                  />
                ) : leftDrawer === "sourceControl" ? (
                  <SourceControlDrawer
                    openRequest={sourceControlOpenRequest}
                    onRequestClose={() => {
                      requestHistoryPush();
                      setLeftDrawer(null);
                    }}
                  />
                ) : null}
              </div>
              <button
                type="button"
                aria-label="Resize left drawer"
                data-testid="left-drawer-resize-handle"
                onPointerDown={handleLeftDrawerResizeStart}
                className="group absolute -right-1 top-0 z-20 h-full w-2 cursor-col-resize touch-none select-none focus:outline-none"
              >
                <span
                  aria-hidden="true"
                  className={[
                    "pointer-events-none absolute left-1/2 top-1/2 h-14 w-[2px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-slate-300 transition-opacity dark:bg-white/25",
                    leftDrawerResizing ? "opacity-100" : "opacity-0 group-hover:opacity-100",
                  ].join(" ")}
                />
              </button>
            </div>
          ) : null}

          {search.open ? <div className="studio-context-search-screen">
            {!isLargeScreen ? <header className="studio-context-search-mobile" aria-label="Search">{search.renderControl()}</header> : null}
            <StudioHistoryControls history={mobileHistory} className="self-start px-1" />
            <main className="flex min-h-0 min-w-0 flex-1" aria-label="Search results" data-testid="studio-search-screen">{search.results}</main>
          </div> : null}
          <div
            className="studio-context-workspace flex flex-1 min-h-0 min-w-0 flex-col"
            hidden={search.open}
            aria-hidden={search.open || showMobileLeftDrawerOverlay || undefined}
            inert={search.open || showMobileLeftDrawerOverlay || undefined}
          >
            {!isLargeScreen ? mobileContextHeader() : null}
            {isLargeScreen || navigationScope.page === "workspace" ? <StudioTopBar newChatInSidebar={isLargeScreen} contextHeaderAbove mobileNavigation={mobileTopbarNavigation} /> : <div className="flex min-h-14 shrink-0 items-center gap-2 border-b border-slate-200/70 px-1 py-1 dark:border-[color:var(--color-studio-dark-divider)]">
              <IconButton variant="ghost" aria-label="Open navigation" data-testid="topbar-sidebar-toggle" onPress={handleToggleSidebar} className="!min-h-12 !min-w-12"><SidebarExpand className="h-[18px] w-[18px]" aria-hidden="true" /></IconButton>
              <span className="min-w-0 flex-1 truncate text-sm text-slate-500 dark:text-slate-400">{navigationScope.page === "account" ? "Your settings" : topbarLocationOverride?.title ?? (contextHomeActive ? "Home" : activeTeamName)}</span>
            </div>}
            <ProjectAccessRecoveryBanner />
            {/* relative: the participants drawer overlays the right edge of the
                workspace content rather than pushing it, so it never competes
                with the code/preview panel for width. */}
            <div className="relative flex flex-1 min-h-0 min-w-0">
              <div
                className={
                  isLargeScreen
                    ? "flex flex-1 min-h-0 min-w-0"
                    : "flex flex-1 min-h-0 min-w-0 flex-col gap-3 overflow-hidden"
                }
              >
                <ResizablePanels
                  className="flex-1 min-w-0"
                  sideVisible={isLargeScreen && effectiveSideVisible}
                  ratio={sideRatio}
                  onRatioChange={setSideRatio}
                  minRatio={activeSideTab?.minRatio}
                  maxRatio={activeSideTab?.maxRatio}
                  main={workspaceSurface}
                  side={sidePaneNode ?? <div className="h-full" />}
                />
                {!isLargeScreen && sidePaneNode ? (
                  <div className="flex-none">{sidePaneNode}</div>
                ) : null}
              </div>
              {isChatSurfaceVisible && participantsDrawerOpen ? (
                <ParticipantsDrawer
                  projectId={activeProjectId}
                  onClose={() => setParticipantsDrawerOpen(false)}
                  onOpenMachine={(runtimeId) => {
                    // Deep-link: focus that machine on the Machines page, then
                    // open the page (which replaces the chat surface).
                    setMachinesPanelFocus(runtimeId);
                    openPanelTab("machines", { activate: true });
                  }}
                />
              ) : null}
            </div>
          </div>

          {!search.open && !isLargeScreen && (mobileSidebarOpen || routeOwnedMobileWorkspaceDrawer) ? (
            <StudioMobileSidebarOverlay onClose={() => handleMobileSidebarOpenChange(false)}>
              <div className="flex h-full min-h-0 flex-col">
              <div className="studio-context-mobile-picker" inert={mobileSidebarNavigation.view !== "sidebar" || undefined} aria-hidden={mobileSidebarNavigation.view !== "sidebar" || undefined}>
                <IconButton variant="ghost" onPress={handleOpenHome} aria-label="Home — all teams" aria-current={contextHomeActive ? "page" : undefined} className="relative !min-h-12 !min-w-11 shrink-0">
                  <OctoMark className="h-6 w-6 text-brand-ink dark:text-brand-paper" />
                  <AttentionBadge count={homeAttentionCount} aria-hidden className="absolute right-0 top-0" />
                </IconButton>
                <div ref={setMobileContextTarget} className="min-w-0 flex-1" />
                <IconButton variant="ghost" aria-label="Search" onPress={search.openSearch} className="!min-h-12 !min-w-11 shrink-0"><Search className="h-[18px] w-[18px]" /></IconButton>
              </div>
              <div className="min-h-0 flex-1">
              <StudioSidebar
                navigationPresentation="path"
                workspaceSwitcherInitialMode={mobilePickerMode}
                navigationHeaderExternal
                navigationHeaderPortalTarget={mobileContextTarget}
                mobileOverlay
                hideContext={navigationScope.page === "account"}
                mobileNavigation={mobileSidebarOpen ? mobileSidebarNavigation : undefined}
                runSidebarAction={runStudioNavigation}
                items={sidebarItems}
                moreItems={sidebarMoreItems}
                activePanel={sidebarActivePanel}
                pinnedPanel={null}
                onRequestClose={() => handleMobileSidebarOpenChange(false)}
                onSelect={handleNavigationPanelSelect}
                onOpenConversationHistory={handleOpenConversationHistory}
                isConversationHistoryActive={isConversationHistoryActive}
                selectedOrgKey={navigationScope.orgKey}
                onOpenTeam={handleOpenTeam}
                onReturnToTeam={handleReturnToTeam}
                onActivateProject={handleActivateProject}
                onActiveTeamChange={handleActiveTeamChange}
                workspaceSwitcherOpen={leftDrawer === "workspaces"}
                onWorkspaceSwitcherOpenChange={handleWorkspaceSwitcherOpenChange}
                workspaceSwitcherPortalTarget={workspaceSwitcherPortalTarget}
                recentConversations={recentConversations}
                activeConversationId={visibleChatId}
                openConversationIds={openConversationIds}
                onSelectConversation={handleSelectRecentConversation}
                collapsed={false}
              />
              </div></div>
            </StudioMobileSidebarOverlay>
          ) : null}

          {showMobileLeftDrawerOverlay ? (
            <div
              className="fixed inset-0 z-[60] flex h-full flex-col bg-white dark:bg-[var(--color-studio-dark-panel)]"
              data-testid="mobile-left-drawer-overlay"
              hidden={search.open}
              inert={search.open || undefined}
              aria-hidden={search.open || undefined}
              style={{
                ...viewportHeightStyle,
                paddingBottom: showMobileBottomDock || keyboardOpen ? "0px" : "var(--instafy-safe-area-inset-bottom)",
                paddingLeft: "var(--instafy-safe-area-inset-left)",
                paddingRight: "var(--instafy-safe-area-inset-right)",
              }}
            >
              {mobileContextHeader(true)}
              <StudioTopBar contextHeaderAbove mobileNavigation={mobileTopbarNavigation} />
              <div className="flex-1 min-h-0 overflow-hidden">
                  {leftDrawer === "history" ? (
                    <ConversationHistoryTab
                      onStartNewConversation={createFreshConversation}
                      onRequestClose={() => {
                        requestHistoryPush();
                        setLeftDrawer(null);
                    }}
                  />
                ) : leftDrawer === "files" ? (
                  <div
                    ref={handleFilesExplorerPortalRef}
                    className="h-full"
                    data-testid="files-explorer-drawer"
                  />
                ) : leftDrawer === "sourceControl" ? (
                  <SourceControlDrawer
                    openRequest={sourceControlOpenRequest}
                    onRequestClose={() => {
                      requestHistoryPush();
                      setLeftDrawer(null);
                    }}
                  />
                ) : null}
              </div>
              {mobileOverviewDock}
            </div>
          ) : null}

          {!search.open && !isLargeScreen && mobileGitReviewSheet ? (
            <div
              className="fixed inset-0 z-[70] flex items-end"
              data-testid="mobile-git-review-sheet-overlay"
              style={{
                paddingBottom: "var(--instafy-safe-area-inset-bottom)",
                paddingLeft: "var(--instafy-safe-area-inset-left)",
                paddingRight: "var(--instafy-safe-area-inset-right)",
              }}
            >
              <button
                type="button"
                className="absolute inset-0 bg-slate-900/30 backdrop-blur-sm"
                aria-label="Close review"
                onClick={() => setMobileGitReviewSheet(null)}
                data-testid="mobile-git-review-sheet-backdrop"
              />
              <div className="relative flex max-h-[85vh] w-full flex-col overflow-hidden rounded-t-[28px] border border-slate-200/70 bg-white shadow-2xl dark:border-[color:var(--color-studio-dark-panel-border)] dark:bg-[var(--color-studio-dark-panel)]">
                <GitReviewView
                  review={mobileGitReviewSheet}
                  presentation="sheet"
                  onOpenFullReview={() => {
                    requestHistoryPush();
                    openGitReviewTab(mobileGitReviewSheet);
                    setMobileGitReviewSheet(null);
                  }}
                  onRequestClose={() => setMobileGitReviewSheet(null)}
                />
              </div>
            </div>
          ) : null}
          {bugReportController.dialogs}
        </WorkspaceControlsProvider>
      </div>
      <ProjectLauncher
        open={isProjectLauncherOpen}
        preferredOrgId={projectLauncherPreferredOrgId}
        onClose={() => {
          setIsProjectLauncherOpen(false);
          setProjectLauncherPreferredOrgId(null);
        }}
        onCreateBlank={handleCreateBlankProject}
        onCreateFromGithub={handleCreateGithubProject}
      />
      {isBuildLogOverlayOpen ? (
        <BuildLogOverlay
          logs={buildLogs}
          onClear={handleClearBuildLogs}
          onClose={handleHideBuildLogs}
        />
      ) : null}
      <ProviderBindingApprovalHost />
      <Status />
      <DesktopRuntimeHelpDialog />
    </ControllerNoticeActionsProvider>
    </StudioSearchReturnProvider>
    </StudioNavigationProvider>
  );
}

function DesktopRuntimeHelpDialog() {
  const { isDesktopRuntimeHelpVisible, hideDesktopRuntimeHelp } = useRuntime();
  const { activeProjectId } = useProject();
  const { showStatus } = useStatus();
  const [desktopRuntimeBusy, setDesktopRuntimeBusy] = useState(false);
  const [desktopRuntimeStatus, setDesktopRuntimeStatus] = useState<{
    running: boolean;
    pid?: number;
    logFilePath?: string;
    } | null>(null);

  const serverUrl =
    controllerClient.core.baseUrl || "http://127.0.0.1:8788";
  const cliCommand = `instafy runtime start --space ${activeProjectId ?? "<space-id>"} --server-url ${serverUrl} --supabase-access-token <your-supabase-token>`;
  const canUseDesktopApp =
    typeof window !== "undefined" &&
    typeof window.instafyDesktop?.startDesktopRuntime === "function" &&
    typeof window.instafyDesktop?.desktopRuntimeStatus === "function";

  // The dialog otherwise only closes via its (x); Escape must work too.
  useEffect(() => {
    if (!isDesktopRuntimeHelpVisible) {
      return;
    }
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        hideDesktopRuntimeHelp();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [hideDesktopRuntimeHelp, isDesktopRuntimeHelpVisible]);

  useEffect(() => {
    if (!isDesktopRuntimeHelpVisible || !canUseDesktopApp) {
      setDesktopRuntimeStatus(null);
      return;
    }
    let cancelled = false;
    void window.instafyDesktop
      ?.desktopRuntimeStatus?.()
      .then((status) => {
        if (cancelled) {
          return;
        }
        setDesktopRuntimeStatus({
          running: Boolean(status?.running),
          pid: typeof status?.pid === "number" ? status.pid : undefined,
          logFilePath:
            typeof status?.logFilePath === "string" ? status.logFilePath : undefined,
        });
      })
      .catch(() => {
        if (!cancelled) {
          setDesktopRuntimeStatus({ running: false });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [canUseDesktopApp, isDesktopRuntimeHelpVisible]);

  if (!isDesktopRuntimeHelpVisible) {
    return null;
  }

  const handleCopyCliCommand = async () => {
    try {
      await writeClipboardText(cliCommand);
      showStatus("CLI command copied.", "success", 2500, { presentation: "confirmation" });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to copy.";
      showStatus(message, "error", 3500);
    }
  };

  const handleStartDesktopRuntime = async () => {
    if (!activeProjectId) {
      showStatus("Select a space before starting the desktop runtime.", "error", 4000);
      return;
    }
    if (!canUseDesktopApp || !window.instafyDesktop?.startDesktopRuntime) {
      showStatus("Desktop runtime launch is only available in the Instafy desktop app.", "warning", 4500);
      return;
    }
    if (desktopRuntimeBusy) {
      return;
    }

    setDesktopRuntimeBusy(true);
    try {
      const requestContext = await controllerClient.core.resolveRequestContext(null);
      if (!requestContext.accessToken) {
        showStatus("Login required to start the desktop runtime.", "error", 4500);
        return;
      }
      const desktopRuntimeOptions = {
        projectId: activeProjectId,
        controllerUrl: requestContext.baseUrl,
        controllerAccessToken: requestContext.accessToken,
        controllerCredentialMode: requestContext.credentialSource ?? "fixed",
        displayName: "Instafy Desktop",
      } as const;
      await window.instafyDesktop.startDesktopRuntime(desktopRuntimeOptions);
      const refreshed = await window.instafyDesktop.desktopRuntimeStatus?.().catch(() => null);
      if (refreshed) {
        setDesktopRuntimeStatus({
          running: Boolean(refreshed.running),
          pid: typeof refreshed.pid === "number" ? refreshed.pid : undefined,
          logFilePath:
            typeof refreshed.logFilePath === "string" ? refreshed.logFilePath : undefined,
        });
      }
      showStatus("Desktop runtime started.", "success", 3200);
      hideDesktopRuntimeHelp();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      showStatus(`Failed to start desktop runtime: ${message}`, "error", 5000);
    } finally {
      setDesktopRuntimeBusy(false);
    }
  };

  const handleStopDesktopRuntime = async () => {
    if (!canUseDesktopApp || !window.instafyDesktop?.stopDesktopRuntime) {
      return;
    }
    if (desktopRuntimeBusy) {
      return;
    }
    setDesktopRuntimeBusy(true);
    try {
      await window.instafyDesktop.stopDesktopRuntime();
      setDesktopRuntimeStatus({ running: false });
      showStatus("Desktop runtime stopped.", "success", 3200);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      showStatus(`Failed to stop desktop runtime: ${message}`, "error", 5000);
    } finally {
      setDesktopRuntimeBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-slate-900/40 pb-[max(var(--instafy-safe-area-inset-bottom),1rem)] pl-[max(var(--instafy-safe-area-inset-left),1rem)] pr-[max(var(--instafy-safe-area-inset-right),1rem)] pt-[max(var(--instafy-safe-area-inset-top),1rem)]"
      data-testid="desktop-runtime-help-dialog"
    >
      <Surface
        tone="default"
        radius="2xl"
        shadow="lg"
        className="max-h-full w-full max-w-xl overflow-y-auto p-5 shadow-2xl"
      >
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <Heading level={2}>Self-host a runtime</Heading>
            <Text variant="body" tone="secondary" className="mt-1 max-w-lg">
              Run Instafy on your own machine. Pick the easiest path below.
            </Text>
          </div>
          <IconButton
            variant="ghost"
            size="sm"
            radius="full"
            aria-label="Close"
            onPress={hideDesktopRuntimeHelp}
          >
            <Xmark className="h-4 w-4" aria-hidden="true" />
          </IconButton>
        </div>

        <div className="mt-5 grid gap-3">
          {canUseDesktopApp ? (
            <div className="rounded-2xl border border-slate-200/70 bg-white p-4 dark:border-[color:var(--color-studio-dark-panel-border)] dark:bg-[var(--color-studio-dark-panel)]">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <Badge
                    size="xs"
                    className="border-primary-200 bg-primary-50 text-primary-700 dark:border-primary-500/30 dark:bg-primary-500/15 dark:text-primary-200"
                  >
                    Installed
                  </Badge>
                  <Text variant="bodyStrong" tone="primary">
                    Instafy Desktop app
                  </Text>
                </div>
                {desktopRuntimeStatus?.running ? (
                  <Button
                    variant="outline"
                    size="xs"
                    radius="full"
                    onPress={handleStopDesktopRuntime}
                    isDisabled={desktopRuntimeBusy}
                  >
                    {desktopRuntimeBusy ? "Stopping…" : "Stop"}
                  </Button>
                ) : (
                  <Button
                    variant="primary"
                    size="xs"
                    radius="full"
                    onPress={handleStartDesktopRuntime}
                    isDisabled={desktopRuntimeBusy}
                  >
                    {desktopRuntimeBusy ? "Starting…" : "Start runtime"}
                  </Button>
                )}
              </div>
              <Text variant="caption" tone="muted" className="mt-2">
                {desktopRuntimeStatus?.running
                  ? `Runtime is running${typeof desktopRuntimeStatus.pid === "number" ? ` (pid ${desktopRuntimeStatus.pid})` : ""}.`
                  : "Launch a self-hosted runtime connected to this space."}
              </Text>
              {desktopRuntimeStatus?.running && desktopRuntimeStatus.logFilePath ? (
                <Text variant="caption" tone="muted" className="mt-1">
                  Logs: <span className="font-mono">{desktopRuntimeStatus.logFilePath}</span>
                </Text>
              ) : null}
            </div>
          ) : null}

          <div className="rounded-2xl border border-slate-200/70 bg-white p-4 dark:border-[color:var(--color-studio-dark-panel-border)] dark:bg-[var(--color-studio-dark-panel)]">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Text variant="bodyStrong" tone="primary">
                @instafy/cli
              </Text>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="xs"
                  radius="full"
                  onPress={() => window.open(INSTAFY_CLI_URL, "_blank", "noopener,noreferrer")}
                >
                  Open docs
                </Button>
                <Button variant="primary" size="xs" radius="full" onPress={handleCopyCliCommand}>
                  Copy command
                </Button>
              </div>
            </div>
            <div className="mt-2 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 font-mono text-[12px] text-slate-700 dark:border-slate-800 dark:bg-slate-900/40 dark:text-slate-200">
              {cliCommand}
            </div>
          </div>
        </div>
      </Surface>
    </div>
  );
}
