import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { ChatLines, Clock, Coins, Cpu, Cube, GitBranch, Globe, Group, Lock, Page, Puzzle, User, Xmark } from "iconoir-react";
import { ResizablePanels } from "../components/ResizablePanels";
import { CreditsPanel } from "./studio/components/CreditsPanel";
import { fetchCreditPolicy } from "../credits/creditService";
import { clearIdlePaused, markIdlePaused } from "../runtime/idlePauseRegistry";
import { setRuntimeSizePreference } from "../runtime/runtimeSizePreference";
import { isHostedRuntime, runtimeEntryIsReady } from "../runtime/utils/runtimeEntry";
import { Button, IconButton } from "../components/Button";
import { Card } from "../components/Card";
import { Badge } from "../components/Badge";
import { Heading } from "../components/Heading";
import { Surface } from "../components/Surface";
import { Text } from "../components/Text";
import { ChatsIcon } from "../components/AppIcons";
import { FilesPanel } from "./studio/components/FilesPanel";
import {
  resolvePreferredFilesMobileViewForExplorerOpen,
  resolveStudioFilesMobileView,
  resolveStudioFilesMobileViewChange,
  type FilesPanelMobileView,
} from "./studioFilesMobileView";
import { buildGithubImportRetryIdentity } from "./studio/components/githubImportRetryRegistry";
import { GitDiffView } from "./studio/components/GitDiffView";
import { GitReviewView } from "./studio/components/GitReviewView";
import { SourceControlDrawer } from "./studio/components/SourceControlDrawer";
import { ParticipantsDrawer } from "./studio/components/ParticipantsDrawer";
import { useBreakpoint } from "../hooks/useBreakpoint";
import { StudioSidebar } from "./studio/components/StudioSidebar";
import { StudioTopBar } from "./studio/components/StudioTopBar";
import { MobileBottomDock } from "./studio/components/MobileBottomDock";
import { ProjectLauncher } from "./studio/components/ProjectLauncher";
import { ChatPanel } from "./studio/components/ChatPanel";
import { ProjectPickerPanel } from "./studio/components/ProjectPickerPanel";
import { SettingsPanel } from "./studio/components/SettingsPanel";
import { SecretsPanel } from "./studio/components/SecretsPanel";
import { AiPanel } from "./studio/components/AiPanel";
import { AutomationsPanel } from "./studio/components/AutomationsPanel";
import { ExtensionsPanel } from "./studio/components/ExtensionsPanel";
import { SkillsPanel } from "./studio/components/SkillsPanel";
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
import { useConversations } from "../conversations/ConversationsProvider";
import { isUUID } from "../utils/uuid";
import { writeClipboardText } from "../runtime/runtimeMenuShared";
import { INSTAFY_CLI_URL } from "../config/externalLinks";
import { SidePaneProvider, useSidePane } from "../workspace/SidePaneProvider";
import { useStudioNavigationPosture } from "./studio/useStudioNavigationPosture";
import { SidePaneTabs } from "../workspace/SidePaneTabs";
import { WorkspaceTabsProvider, useWorkspaceTabs } from "../workspace/WorkspaceTabsProvider";
import type { WorkspaceGitReviewSource } from "../workspace/gitReviewTypes";
import { ConversationHistoryTab } from "../workspace/ConversationHistoryTab";
import { useWorkspaceActivity } from "../workspace/useWorkspaceActivity";
import { WorkspaceControlsProvider, type PrivateChatTarget } from "./studio/workspaceControls";
import { findReusableBlankConversation } from "../conversations/conversationAutoTitle";
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
import {
  buildStudioViewportStyle,
  resolveStudioViewportHeightPx,
  shouldResetStudioDocumentScroll,
} from "./studioViewport";
import { writePendingProjectSwitch } from "./pendingProjectSwitch";
import { controllerBaseUrl } from "../services/runtimeController/core";
import { useAutoDesktopSpeechTunnel } from "../desktop/voiceTunnel/useAutoDesktopSpeechTunnel";
import { useStudioLayoutChromeState } from "./useStudioLayoutChromeState";
import { useStudioLayoutWorkspaceRouting } from "./useStudioLayoutWorkspaceRouting";


const sidebarPrimaryAccentClass = "text-primary-600 dark:text-primary-500";

const navItems: StudioNavItem[] = [
  { id: "chat", label: "Assistant", icon: ChatLines, accent: sidebarPrimaryAccentClass },
  { id: "code", label: "Files", icon: Page, accent: sidebarPrimaryAccentClass },
  { id: "sourceControl", label: "Changes", icon: GitBranch, accent: sidebarPrimaryAccentClass },
  { id: "credits", label: "Credits", icon: Coins, accent: sidebarPrimaryAccentClass },
];

const navMoreItems: StudioNavItem[] = [
  { id: "extensions", label: "Extensions", icon: Globe, accent: sidebarPrimaryAccentClass },
  { id: "secrets", label: "Secrets", icon: Lock, accent: sidebarPrimaryAccentClass },
  { id: "skills", label: "Skills", icon: Puzzle, accent: sidebarPrimaryAccentClass },
  { id: "ai", label: "AI Manager", icon: Cpu, accent: sidebarPrimaryAccentClass },
  { id: "automations", label: "Automations", icon: Clock, accent: sidebarPrimaryAccentClass }
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
    <WorkspaceTabsProvider>
      <SidePaneProvider>
        <StudioLayoutInner />
      </SidePaneProvider>
    </WorkspaceTabsProvider>
  );
}

function StudioLayoutInner() {
  const auth = useAuth();
  const authLoading = auth.loading;
  const user = auth.user;
  const signOut = auth.signOut;
  const { isLargeScreen, showTouchBottomDock } = useStudioNavigationPosture();
  const location = useLocation();
  const navigate = useNavigate();
  const [viewportHeightPx, setViewportHeightPx] = useState<number | null>(null);
  const viewportHeightStyle = useMemo(() => buildStudioViewportStyle(viewportHeightPx), [viewportHeightPx]);

  useLayoutEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    let frameId: number | null = null;
    const applyViewportHeight = () => {
      frameId = null;
      // WKWebView can pan the layout viewport to a focused input even though
      // Studio owns all scrolling and the document itself is overflow-locked.
      // Undo that native page pan so the resized visual viewport continues to
      // contain the top bar, transcript, and composer instead of blank space.
      if (shouldResetStudioDocumentScroll(window.scrollX, window.scrollY)) {
        window.scrollTo(0, 0);
      }
      const viewportHeight = resolveStudioViewportHeightPx(window.visualViewport?.height ?? window.innerHeight);
      setViewportHeightPx((current) => (current === viewportHeight ? current : viewportHeight));
    };

    const schedule = () => {
      if (frameId !== null) {
        return;
      }
      frameId =
        typeof window.requestAnimationFrame === "function"
          ? window.requestAnimationFrame(applyViewportHeight)
          : (applyViewportHeight(), null);
    };

    schedule();

    window.addEventListener("resize", schedule);
    window.addEventListener("orientationchange", schedule);
    window.addEventListener("focusin", schedule);
    window.addEventListener("focusout", schedule);
    window.addEventListener("scroll", schedule, { passive: true });
    window.visualViewport?.addEventListener("resize", schedule);
    window.visualViewport?.addEventListener("scroll", schedule);

    return () => {
      window.removeEventListener("resize", schedule);
      window.removeEventListener("orientationchange", schedule);
      window.removeEventListener("focusin", schedule);
      window.removeEventListener("focusout", schedule);
      window.removeEventListener("scroll", schedule);
      window.visualViewport?.removeEventListener("resize", schedule);
      window.visualViewport?.removeEventListener("scroll", schedule);
      if (frameId !== null && typeof window.cancelAnimationFrame === "function") {
        window.cancelAnimationFrame(frameId);
      }
    };
  }, []);

  useEffect(() => {
    if (typeof document === "undefined") {
      return;
    }
    const originalHtmlOverflow = document.documentElement.style.overflow;
    const originalBodyOverflow = document.body.style.overflow;

    document.documentElement.style.overflow = "hidden";
    document.body.style.overflow = "hidden";

    return () => {
      document.documentElement.style.overflow = originalHtmlOverflow;
      document.body.style.overflow = originalBodyOverflow;
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
    openPanelTab,
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
    focusTab,
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
  const { runtime, runtimeReady, effectiveRuntimeId, runtimeStatuses } = useRuntime();
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
  const {
    projectKey: conversationsProjectKey,
    conversations,
    activeConversationId,
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
  const currentUserId = user?.id ?? null;
  const [mobileHomeReturnTarget, setMobileHomeReturnTarget] = useState<{
    tabId: string;
    fallbackPanel: StudioPanel;
  } | null>(null);
  const [homeAttentionInboxItems, setHomeAttentionInboxItems] = useState<NotificationInboxItem[]>([]);
  const homeAttentionRequestRef = useRef<Promise<NotificationInboxItem[]> | null>(null);
  const homeAttentionEpochRef = useRef(0);
  const isChatSurfaceVisible =
    activeWorkspaceTab?.kind === "conversation" ||
    activeWorkspaceTab?.kind === "jobThread" ||
    (activeWorkspaceTab?.kind === "panel" && activeWorkspaceTab.panel === "chat");
  // The participants drawer needs genuinely wide viewports: a third column
  // beside chat and the (potential) side panel only fits at xl and up.
  const participantsDrawerViewportWide = useBreakpoint("xl");
  const visibleConversationControllerId = useMemo((): string | null => {
    if (!isChatSurfaceVisible) {
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
  }, [activeConversation?.controllerId, isChatSurfaceVisible, location.search]);
  const visibleConversationLocalId = useMemo((): string | null => {
    if (!isChatSurfaceVisible) {
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
  ]);
  const {
    buildLogs,
    hasBuildLogs,
    isBuildLogOverlayOpen,
    handleClearBuildLogs,
    handleShowBuildLogs,
    handleHideBuildLogs
  } = useBuildLogs();
  const bugReportController = useStudioBugReportController({
    activeProjectId,
    activeConversationId: activeConversation?.controllerId ?? null,
    activeConversationLocalId: activeConversation?.localId ?? null,
    activeRuntimeId: effectiveRuntimeId,
    userEmail: user?.email ?? null,
    controllerProjectMissing,
    buildLogs,
  });
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

  const homeAttentionCount = useMemo(() => {
    const currentSpaceName = (activeProjectName ?? "").trim() || "Choose a Space";
    return buildHomeAttentionEntries({
      conversations,
      inboxItems: visibleHomeAttentionInboxItems,
      currentSpaceName,
      visibleConversationLocalId,
      visibleConversationControllerId,
    }).length;
  }, [
    activeProjectName,
    conversations,
    visibleConversationControllerId,
    visibleConversationLocalId,
    visibleHomeAttentionInboxItems,
  ]);

  const { homeAttentionByProject, homeAttentionByOrg } = useMemo(() => {
    const byProject: Record<string, number> = {};
    const byOrg: Record<string, number> = {};
    for (const item of visibleHomeAttentionInboxItems) {
      byProject[item.projectId] = (byProject[item.projectId] ?? 0) + 1;
      const orgKey = item.orgId ?? "personal";
      byOrg[orgKey] = (byOrg[orgKey] ?? 0) + 1;
    }
    return { homeAttentionByProject: byProject, homeAttentionByOrg: byOrg };
  }, [visibleHomeAttentionInboxItems]);

  useEffect(() => {
    if (isLargeScreen || !activeWorkspaceTab) {
      return;
    }
    if (activeWorkspaceTab.kind === "panel" && activeWorkspaceTab.panel === "home") {
      return;
    }
    let fallbackPanel: StudioPanel = "chat";
    if (activeWorkspaceTab.kind === "panel") {
      fallbackPanel = activeWorkspaceTab.panel;
    } else if (
      activeWorkspaceTab.kind === "file" ||
      activeWorkspaceTab.kind === "explorer" ||
      activeWorkspaceTab.kind === "gitDiff"
    ) {
      fallbackPanel = "code";
    }
    setMobileHomeReturnTarget({
      tabId: activeWorkspaceTab.id,
      fallbackPanel,
    });
  }, [activeWorkspaceTab, isLargeScreen]);

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
    handleLeftDrawerResizeStart,
    leftDrawer,
    leftDrawerResizing,
    leftDrawerWidth,
    mobileGitReviewSheet,
    mobileSidebarOpen,
    setLeftDrawer,
    setMobileGitReviewSheet,
    setMobileSidebarOpen,
    setSidebarCollapsed,
    sidebarCollapsed,
    sourceControlOpenRequest,
    setSourceControlOpenRequest,
  } = useStudioLayoutChromeState({ isLargeScreen });
  const {
    settingsTab,
    setSettingsTab,
    handlePanelSelect,
    suppressNextQuerySync,
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
    consumeUrlNavigation,
    conversations,
    conversationsProjectKey,
    focusWorkspaceTab,
    isLargeScreen,
    leftDrawer,
    locationPathname: location.pathname,
    locationSearch: location.search,
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
        requestHistoryPush();
        suppressNextQuerySync();
        setLeftDrawer("sourceControl");
        setSourceControlOpenRequest({
          key: Date.now(),
          previewPath,
          reviewMode,
        });
        if (!isLargeScreen) {
          setMobileSidebarOpen(false);
        }
      };
      window.addEventListener("instafy:open-source-control", handler as EventListener);
      return () => {
        window.removeEventListener("instafy:open-source-control", handler as EventListener);
      };
    }, [
      isLargeScreen,
      requestHistoryPush,
      setLeftDrawer,
      setMobileSidebarOpen,
      setSourceControlOpenRequest,
      suppressNextQuerySync,
    ]);

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
      if (!isLargeScreen) {
        setLeftDrawer(null);
        setMobileSidebarOpen(false);
        setMobileGitReviewSheet(review);
        return;
      }
      requestHistoryPush();
      openGitReviewTab(review);
    };
    window.addEventListener("instafy:open-git-review", handler as EventListener);
    return () => {
      window.removeEventListener("instafy:open-git-review", handler as EventListener);
    };
  }, [
    isLargeScreen,
    openGitReviewTab,
    requestHistoryPush,
    setLeftDrawer,
    setMobileGitReviewSheet,
    setMobileSidebarOpen,
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
        if (item.id === "credits") {
          return { ...item, indicator: creditsIndicator ?? null };
        }
        return item;
      });
    }, [creditsIndicator, sourceControlBadge]);

    const sidebarMoreItems = useMemo(() => {
      return navMoreItems;
    }, []);

  useEffect(() => {
    if (!isLargeScreen || !mobileGitReviewSheet) {
      return;
    }
    requestHistoryPush();
    openGitReviewTab(mobileGitReviewSheet);
    setMobileGitReviewSheet(null);
  }, [isLargeScreen, mobileGitReviewSheet, openGitReviewTab, requestHistoryPush, setMobileGitReviewSheet]);

  const handleToggleSidebar = useCallback(() => {
    if (isLargeScreen) {
      setSidebarCollapsed((previous) => !previous);
      return;
    }
    setMobileSidebarOpen((previous) => {
      if (!previous) {
        setLeftDrawer(null);
      }
      return !previous;
    });
  }, [isLargeScreen, setLeftDrawer, setMobileSidebarOpen, setSidebarCollapsed]);

  const handleOpenConversationHistory = useCallback(() => {
    if (leftDrawer !== "history") {
      requestHistoryPush();
    }
    openPanelTab("chat");
    setLeftDrawer("history");
    if (!isLargeScreen) {
      setMobileSidebarOpen(false);
    }
  }, [isLargeScreen, leftDrawer, openPanelTab, requestHistoryPush, setLeftDrawer, setMobileSidebarOpen]);

  const prepareWorkspaceForNewSession = useCallback((options?: { closeProjectLauncher?: boolean }) => {
    if (options?.closeProjectLauncher !== false) {
      setIsProjectLauncherOpen(false);
    }
    resetTabs();
    clearTabs();
    setLeftDrawer(null);

  }, [clearTabs, resetTabs, setIsProjectLauncherOpen, setLeftDrawer]);

  const handleOpenProjectPicker = useCallback(() => {
    if (activePanel !== "projects") {
      requestHistoryPush();
    }
    setLeftDrawer(null);
    openPanelTab("projects");
  }, [activePanel, openPanelTab, requestHistoryPush, setLeftDrawer]);

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

  const handleCreateConversation = useCallback(() => {
    const reusableConversation = findReusableBlankConversation(conversations);
    if (reusableConversation) {
      requestHistoryPush();
      if (!isLargeScreen) {
        setLeftDrawer(null);
      }
      selectConversation(reusableConversation.localId);
      markConversationRead(reusableConversation.localId);
      setPendingConversationTabOpenId(reusableConversation.localId);
      return;
    }
    createFreshConversation();
  }, [
    conversations,
    createFreshConversation,
    isLargeScreen,
    markConversationRead,
    requestHistoryPush,
    selectConversation,
    setLeftDrawer,
  ]);

  const handleCreatePrivateConversation = useCallback(
    (target: PrivateChatTarget) => {
      requestHistoryPush();
      if (!isLargeScreen) {
        setLeftDrawer(null);
      }
      const projectId = activeProjectId && isUUID(activeProjectId) ? activeProjectId : null;
      const userId = typeof target.userId === "string" ? target.userId.trim() : "";
      if (!userId) {
        return;
      }
      const titleName = target.displayName.trim() || "Teammate";
      const title = `Chat with ${titleName}`;
      const conversation = createConversation({
        title,
        visibility: "private",
        messages: [
          {
            id: `assistant-${Date.now()}-${Math.random().toString(16).slice(2)}`,
            role: "assistant",
            content: "This chat is private. Write @someone to invite them here.",
            timestamp: Date.now(),
            files: null,
            messageType: "status",
            metadata: null
          }
        ],
        select: true,
      });
      selectConversation(conversation.localId);
      markConversationRead(conversation.localId);
      setPendingConversationTabOpenId(conversation.localId);
      if (!projectId) {
        return;
      }
      void (async () => {
        try {
          const response = await controllerClient.conversations.createBlank({
            projectId,
            metadata: {
              title,
              localId: conversation.localId,
              visibility: "private",
              privateWithUserId: userId,
            }
          });
          if (!response?.conversationId) {
            throw new Error("Controller unavailable. Try again shortly.");
          }
          setConversationControllerId(conversation.localId, response.conversationId);
          const participants = await controllerClient.conversations.addParticipant({
            conversationId: response.conversationId,
            userId,
            role: "member",
            accessToken: null,
          });
          if (!participants) {
            throw new Error("Unable to invite teammate.");
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          showStatus(`Can't start private chat: ${message}`, "error", 4500);
        }
      })();
    },
    [
      activeProjectId,
      createConversation,
      isLargeScreen,
      markConversationRead,
      requestHistoryPush,
      selectConversation,
      setConversationControllerId,
      setLeftDrawer,
      showStatus,
    ],
  );

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
      requestUrlNavigation("push");
      setSettingsTab(tab);
      openPanelTab("settings");
      setPanelTabMeta("settings", meta);
    },
    [openPanelTab, requestUrlNavigation, setPanelTabMeta, setSettingsTab]
  );

  const handleOpenOrgSettings = useCallback(() => {
    handleOpenSettingsTab("org", {
      title: orgSettingsTitle,
      icon: <Group className="text-[16px]" aria-hidden="true" />
    });
  }, [handleOpenSettingsTab, orgSettingsTitle]);

  const handleOpenProjectSettings = useCallback(() => {
    handleOpenSettingsTab("project", {
      title: "Space settings",
      icon: <Cube className="text-[16px]" aria-hidden="true" />
    });
  }, [handleOpenSettingsTab]);

  const handleOpenProfileSettings = useCallback(() => {
    handleOpenSettingsTab("profile", {
      title: "Profile settings",
      icon: <User className="text-[16px]" aria-hidden="true" />
    });
  }, [handleOpenSettingsTab]);

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
  const mobileDockActiveSlot = useMemo((): "home" | "chat" | "files" | "projects" | null => {
    if (!activeWorkspaceTab) {
      return null;
    }
    if (activeWorkspaceTab.kind === "panel") {
      if (activeWorkspaceTab.panel === "home") {
        return "home";
      }
      if (activeWorkspaceTab.panel === "chat") {
        return "chat";
      }
      if (activeWorkspaceTab.panel === "code") {
        return "files";
      }
      if (activeWorkspaceTab.panel === "projects") {
        return "projects";
      }
      return null;
    }
    if (activeWorkspaceTab.kind === "conversation" || activeWorkspaceTab.kind === "jobThread") {
      return "chat";
    }
    if (
      activeWorkspaceTab.kind === "file" ||
      activeWorkspaceTab.kind === "explorer" ||
      activeWorkspaceTab.kind === "gitDiff"
    ) {
      return "files";
    }
    return null;
  }, [activeWorkspaceTab]);
  const mobileUsesComposerDock = showTouchBottomDock && mobileDockActiveSlot === "chat";
  const showMobileBottomDock = showTouchBottomDock && !mobileUsesComposerDock;
  const mobileDockPrimaryMode =
    mobileDockActiveSlot === "home" && mobileHomeReturnTarget ? "return" : "home";
  const handleMobileDockPrimaryPress = useCallback(() => {
    requestHistoryPush();
    setLeftDrawer(null);
    if (mobileDockPrimaryMode === "return") {
      const targetTabId = mobileHomeReturnTarget?.tabId ?? null;
      if (targetTabId && workspaceTabs.some((tab) => tab.id === targetTabId)) {
        focusTab(targetTabId);
        return;
      }
      openPanelTab(mobileHomeReturnTarget?.fallbackPanel ?? "chat");
      return;
    }
    openPanelTab("home");
  }, [
    focusTab,
    mobileDockPrimaryMode,
    mobileHomeReturnTarget,
    openPanelTab,
    requestHistoryPush,
    setLeftDrawer,
    workspaceTabs,
  ]);
  const handleMobileDockOpenChat = useCallback(() => {
    requestHistoryPush();
    setLeftDrawer(null);
    if (activeConversationId) {
      openConversationTab(activeConversationId);
      return;
    }
    openPanelTab("chat");
  }, [activeConversationId, openConversationTab, openPanelTab, requestHistoryPush, setLeftDrawer]);
  const handleMobileDockOpenFiles = useCallback(() => {
    requestHistoryPush();
    setPreferredFilesMobileView("tree");
    setLeftDrawer("files");
    openPanelTab("code");
  }, [openPanelTab, requestHistoryPush, setLeftDrawer]);
  const handleMobileDockOpenProjects = useCallback(() => {
    requestHistoryPush();
    setLeftDrawer(null);
    openPanelTab("projects");
  }, [openPanelTab, requestHistoryPush, setLeftDrawer]);
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
  if (authLoading) {
    return <StudioLoadingScreen />;
  }

  if (!user) {
    return null;
  }

  if (!projectInitialized) {
    return <StudioLoadingScreen />;
  }

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
    !isLargeScreen && leftDrawer !== null && !(leftDrawer === "files" && shouldShowFilesWorkspace);
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

  let workspaceContent: ReactNode;
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
    workspaceContent = (
      <FilesPanel
        tabsSlot={workspaceTabsElement}
        previewOwnerId={user?.id ?? null}
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
    workspaceContent = (
      <GitDiffView path={activeWorkspaceTab.path} commitRange={activeWorkspaceTab.commitRange} />
    );
  } else if (activeWorkspaceTab.kind === "gitReview") {
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
      workspaceContent = (
        <div className="flex h-full flex-col overflow-hidden">
          <SourceControlDrawer openRequest={sourceControlOpenRequest} />
        </div>
      );
    } else if (activeWorkspaceTab.panel === "projects") {
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
    } else {
      const scroller = (
        <div className={`flex-1 overflow-y-auto ${scrollPaddingClass}`}>
          {activeWorkspaceTab.panel === "home" ? (
            <HomePanel inboxItems={homeAttentionInboxItems} refreshInbox={refreshHomeAttentionCount} />
          ) : activeWorkspaceTab.panel === "credits" ? (
            <CreditsPanel />
          ) : activeWorkspaceTab.panel === "extensions" ? (
            <ExtensionsPanel />
          ) : activeWorkspaceTab.panel === "settings" ? (
            <SettingsPanel activeTab={settingsTab} />
          ) : activeWorkspaceTab.panel === "skills" ? (
            <SkillsPanel />
          ) : activeWorkspaceTab.panel === "secrets" ? (
            <SecretsPanel />
          ) : activeWorkspaceTab.panel === "ai" ? (
            <AiPanel />
          ) : activeWorkspaceTab.panel === "automations" ? (
            <AutomationsPanel />
          ) : null}
        </div>
      );
      workspaceContent = (
        <div className="flex h-full flex-col overflow-hidden">
          {scroller}
        </div>
      );
    }
  }
  const workspaceSurface = shouldShowFilesWorkspace ? (
    <div className="flex h-full min-w-0 flex-col overflow-hidden bg-white text-slate-700 shadow-sm dark:bg-[var(--color-studio-dark-panel)] dark:text-slate-200">
      <div key={activeProjectId ?? "files-workspace"} className="min-h-0 flex-1">
        {workspaceContent}
      </div>
      {showMobileBottomDock ? (
        <MobileBottomDock
          primaryMode={mobileDockPrimaryMode}
          activeSlot={mobileDockActiveSlot}
          homeAttentionCount={homeAttentionCount}
          onPrimaryPress={handleMobileDockPrimaryPress}
          onChatPress={handleMobileDockOpenChat}
          onNewChatPress={handleCreateConversation}
          onFilesPress={handleMobileDockOpenFiles}
          onProjectsPress={handleMobileDockOpenProjects}
        />
      ) : null}
    </div>
  ) : (
    <div className="flex h-full min-w-0 flex-col overflow-hidden bg-white text-slate-700 shadow-sm dark:bg-[var(--color-studio-dark-panel)] dark:text-slate-200">
      {workspaceTabsElement}
      <div className="flex-1 overflow-hidden">
        <div key={activeWorkspaceTab?.id ?? "empty"} className="h-full">
          {workspaceContent}
        </div>
      </div>
      {showMobileBottomDock ? (
        <MobileBottomDock
          primaryMode={mobileDockPrimaryMode}
          activeSlot={mobileDockActiveSlot}
          homeAttentionCount={homeAttentionCount}
          onPrimaryPress={handleMobileDockPrimaryPress}
          onChatPress={handleMobileDockOpenChat}
          onNewChatPress={handleCreateConversation}
          onFilesPress={handleMobileDockOpenFiles}
          onProjectsPress={handleMobileDockOpenProjects}
        />
      ) : null}
    </div>
  );



  return (
    <>
      {shouldRenderFilesExplorerPortal ? (
        <FilesPanel
          renderMode="portal"
          previewOwnerId={user?.id ?? null}
          showExplorer
          explorerPortalTarget={filesExplorerPortalTarget}
          mobileView={filesMobileView}
          onMobileViewChange={handleFilesMobileViewChange}
          onRequestOpenExplorer={handleRequestOpenFilesExplorer}
          onRequestCloseExplorer={handleRequestCloseFilesExplorer}
        />
      ) : null}
      <div
        className="flex h-screen min-h-screen overflow-hidden bg-slate-50 dark:bg-[var(--color-studio-dark-canvas)]"
        style={{
          ...viewportHeightStyle,
          paddingLeft: "var(--instafy-safe-area-inset-left)",
          paddingRight: "var(--instafy-safe-area-inset-right)",
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
            sidebarOpen: isLargeScreen ? !sidebarCollapsed : mobileSidebarOpen,
            onToggleSidebar: handleToggleSidebar,
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
            topbarLocationOverride,
            shakeToReportEnabled: bugReportController.shakeToReportEnabled,
            onToggleShakeToReport: bugReportController.onToggleShakeToReport,
            onSimulateShakeToReport: bugReportController.onSimulateShakeToReport,
            onTestShakeToReport: bugReportController.onTestShakeToReport,
            shakeToReportStatus: bugReportController.shakeToReportStatus,
            shakeToReportDetail: bugReportController.shakeToReportDetail,
          }}
        >
          {isLargeScreen ? (
              <StudioSidebar
                items={sidebarItems}
                moreItems={sidebarMoreItems}
                activePanel={sidebarActivePanel}
                pinnedPanel={null}
                onSelect={handlePanelSelect}
                onOpenConversationHistory={handleOpenConversationHistory}
                isConversationHistoryActive={isConversationHistoryActive}
                collapsed={sidebarCollapsed}
              />
          ) : null}

          {isLargeScreen && leftDrawer ? (
            <div
              className="relative flex h-full shrink-0"
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

          <div
            className="flex flex-1 min-h-0 min-w-0 flex-col"
            aria-hidden={showMobileLeftDrawerOverlay || undefined}
            inert={showMobileLeftDrawerOverlay || undefined}
          >
            <StudioTopBar />
            <div className="flex flex-1 min-h-0 min-w-0">
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
              {isLargeScreen && participantsDrawerViewportWide && isChatSurfaceVisible ? (
                <ParticipantsDrawer
                  // The code/preview panel owns the right edge when open; the
                  // drawer yields to its avatar rail rather than competing.
                  forceRail={shouldShowFilesWorkspace || effectiveSideVisible}
                />
              ) : null}
            </div>
          </div>

          {!isLargeScreen && mobileSidebarOpen ? (
            <div className="fixed inset-0 z-50" data-testid="mobile-sidebar-overlay">
              <button
                type="button"
                className="absolute inset-0 bg-slate-900/30 backdrop-blur-sm"
                aria-label="Close sidebar"
                onClick={() => setMobileSidebarOpen(false)}
              />
              <div
                className="absolute"
                style={{
                  bottom: "var(--instafy-safe-area-inset-bottom)",
                  left: "var(--instafy-safe-area-inset-left)",
                  top: "var(--instafy-safe-area-inset-top)",
                }}
              >
                <StudioSidebar
                  items={sidebarItems}
                  moreItems={sidebarMoreItems}
                  activePanel={sidebarActivePanel}
                  pinnedPanel={null}
                  onRequestClose={() => setMobileSidebarOpen(false)}
                  onSelect={(panel) => {
                    handlePanelSelect(panel);
                    setMobileSidebarOpen(false);
                  }}
                  onOpenConversationHistory={() => {
                    handleOpenConversationHistory();
                    setMobileSidebarOpen(false);
                  }}
                  isConversationHistoryActive={isConversationHistoryActive}
                  collapsed={false}
                />
              </div>
            </div>
          ) : null}

          {showMobileLeftDrawerOverlay ? (
            <div
              className="fixed inset-0 z-[60] flex h-full flex-col bg-white dark:bg-[var(--color-studio-dark-panel)]"
              data-testid="mobile-left-drawer-overlay"
              style={{
                paddingBottom: "var(--instafy-safe-area-inset-bottom)",
                paddingLeft: "var(--instafy-safe-area-inset-left)",
                paddingRight: "var(--instafy-safe-area-inset-right)",
              }}
            >
              <StudioTopBar />
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
            </div>
          ) : null}

          {!isLargeScreen && mobileGitReviewSheet ? (
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
    </>
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
      showStatus("CLI command copied.", "success", 2500);
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
            <Xmark className="h-5 w-5" aria-hidden="true" />
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

function StudioLoadingScreen() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-slate-100 via-white to-slate-50 dark:bg-none dark:bg-slate-950">
      <Card
        tone="default"
        radius="2xl"
        shadow="lg"
        padding="sm"
        className="border-purple-100 bg-white/80 px-4 py-3 text-sm font-medium text-purple-600 dark:border-slate-800 dark:bg-slate-900/70 dark:text-slate-200"
      >
        Preparing your studio workspace…
      </Card>
    </div>
  );
}
