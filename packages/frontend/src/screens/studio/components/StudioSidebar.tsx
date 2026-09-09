import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { Capacitor } from "@capacitor/core";
import { DESKTOP_TITLE_BAR_HEIGHT_PX, desktopTitleBarFree } from "../../../lib/desktopShell";
import {
  SidebarCollapse,
  SidebarExpand,
  Xmark,
  Plus,
} from "iconoir-react";
import { ChatsIcon } from "../../../components/AppIcons";
import { OctoMark } from "../../../components/OctoMark";
import { AttentionBadge } from "../../../components/AttentionBadge";
import { Button, IconButton } from "../../../components/Button";
import { Text } from "../../../components/Text";
import { StudioDialogModal } from "../../../components/aria/StudioModal";

import { NewTeamDialog } from "./NewTeamDialog";
import { useStatus } from "../../../status/useStatus";
import { useStudioNavigation } from "../../../navigation/useStudioNavigation";
import { studioPerformance } from "../../../telemetry/studioPerformance";
import { useProfile } from "../../../profile/ProfileProvider";
import { useProjects } from "../../../projects/useProjects";
import { useMergedControllerProjects } from "../../../projects/useMergedControllerProjects";
import { mostRecentProjectId } from "../../../projects/projectRecency";
import { useProjectRecency } from "../../../projects/useProjectRecency";
import { useRuntimeMenuOptions } from "../../../runtime/useRuntimeMenu";
import { useTheme } from "../../../theme/ThemeProvider";
import { DARK_RAIL_SURFACE_CLASS } from "../../../theme/darkSurfaces";
import {
  areMessageNotificationsEnabled,
  disableMessageNotifications,
  enableMessageNotifications,
} from "../../../notifications/assistantMessageNotifications";
import { DevDiagnosticsMenu } from "./DevDiagnosticsMenu";
import { BuildLogOverlay } from "./BuildLogOverlay";
import type { TunnelCopyMode } from "../../../runtime/components/RuntimeTunnelDetails";
import { useWorkspaceControls } from "../workspaceControls";
import type { StudioNavItem, StudioPanel } from "../types";
import { useStudioDesktopLayout } from "../useStudioDesktopLayout";
import { getOrgDisambiguator, getOrgDisplayName } from "../../../org/orgNaming";
import { useAppLogs } from "../../../debug/useAppLogs";
import type { MobileSidebarNavigation } from "../../useMobileSidebarHistory";
import {
  controllerClient,
  runtimeControllerEnabled,
  type ControllerOrgSummary,
} from "../../../sdk/instafy";
import {
  checkDesktopUpdaterNow,
  desktopUpdaterBridgeAvailable,
  downloadDesktopUpdaterNow,
  installDesktopUpdaterNow,
} from "../../../desktop/updates/client";
import {
  applyStagedNativeOtaUpdate,
  triggerNativeOtaCheck,
} from "../../../mobile/ota/bootstrap";

const { list: listControllerOrganizations } = controllerClient.organizations;
import { otaIsSupportedOnThisClient } from "../../../mobile/ota/shared";
import {
  resolveDesktopDownloadFeedback,
  summarizeAppUpdateState,
} from "../../../updates/releaseMetadata";
import { getAppAcquisitionTarget } from "../../../updates/desktopAcquisition";
import { DESKTOP_APP_PUBLIC_LATEST_URL } from "../../../updates/desktopReleaseManifest";
import { useAppUpdateMetadata } from "../../../updates/useAppUpdateMetadata";
import { useDesktopReleaseLookup } from "../../../updates/useDesktopReleaseLookup";
import { StudioSidebarAccountSection } from "./StudioSidebarAccountSection";
import { StudioSidebarMobileDrillIn } from "./StudioSidebarMobileDrillIn";
import { StudioSidebarMorePanels } from "./StudioSidebarMorePanels";
import { StudioSidebarTeamMenu } from "./StudioSidebarTeamMenu";
import { StudioSidebarWorkspaceSwitcher } from "./StudioSidebarWorkspaceSwitcher";
import { StudioSidebarWorkspacePanel } from "./StudioSidebarWorkspacePanel";
import { StudioOrganizationRail } from "./StudioOrganizationRail";
import { SIDEBAR_RECENT_CHAT_LIMIT, StudioRecentChats } from "./StudioRecentChats";
import { SIDEBAR_RECENT_SPACE_LIMIT, StudioRecentSpaces } from "./StudioRecentSpaces";
import type { ConversationState } from "../../../conversations/conversationState";
import {
  normalizeSidebarOrgUser,
  readCachedControllerOrgs,
  writeSidebarOrgSnapshot,
} from "./sidebarOrgSnapshot";


const EXPANDED_SIDEBAR_ROW_LAYOUT_CLASS = "justify-start gap-2.5 px-3 py-1";
const COLLAPSED_SIDEBAR_ROW_LAYOUT_CLASS = "justify-center px-1 py-1.5";
const COLLAPSED_SIDEBAR_ROW_LAYOUT_COMPACT_CLASS = "justify-center px-1 py-1";
const COLLAPSED_SIDEBAR_ROW_LAYOUT_DENSE_CLASS = "justify-center px-1 py-0.5";
const COLLAPSED_SIDEBAR_BUTTON_TONE_CLASS =
  "bg-transparent hover:bg-transparent data-[hovered]:bg-transparent data-[pressed]:bg-transparent dark:hover:bg-transparent dark:data-[hovered]:bg-transparent dark:data-[pressed]:bg-transparent";
const EXPANDED_SIDEBAR_BUTTON_ACTIVE_CLASS =
  "bg-white text-slate-900 dark:bg-[var(--color-studio-dark-active)] dark:text-slate-50";
const EXPANDED_SIDEBAR_BUTTON_INACTIVE_CLASS =
  "text-slate-600 hover:bg-white/70 hover:text-slate-900 dark:text-slate-300 dark:hover:bg-[var(--color-studio-dark-rail-hover)] dark:hover:text-slate-50";

export interface StudioSidebarProps {
  items: StudioNavItem[];
  moreItems?: StudioNavItem[];
  activePanel: StudioPanel;
  onSelect: (panel: StudioPanel) => void;
  collapsed: boolean;
  pinnedPanel?: StudioPanel | null;
  onOpenConversationHistory?: () => void;
  recentConversations?: ConversationState[];
  activeConversationId?: string | null;
  openConversationIds?: ReadonlySet<string>;
  onSelectConversation?: (id: string) => void;
  isConversationHistoryActive?: boolean;
  workspaceSwitcherOpen: boolean;
  onWorkspaceSwitcherOpenChange: (open: boolean) => void;
  workspaceSwitcherPortalTarget: HTMLDivElement | null;
  onRequestClose?: () => void;
  mobileOverlay?: boolean;
  selectedOrgKey?: string;
  onOpenTeam?: (orgKey: string) => void;
  onReturnToTeam?: (orgKey: string) => void;
  onActiveTeamChange?: (team: { key: string; name: string; avatarUrl: string | null }) => void;
  onActivateProject?: (projectId: string, orgKey: string) => void;
  hideContext?: boolean;
  mobileNavigation?: MobileSidebarNavigation;
  runSidebarAction?: (action: () => void) => void;
}

export function StudioSidebar({
  items,
  moreItems,
  activePanel,
  onSelect,
  collapsed,
  pinnedPanel,
  onOpenConversationHistory,
  recentConversations = [],
  activeConversationId,
  openConversationIds,
  onSelectConversation,
  isConversationHistoryActive = false,
  workspaceSwitcherOpen: desktopWorkspaceSwitcherOpen,
  onWorkspaceSwitcherOpenChange,
  workspaceSwitcherPortalTarget,
  onRequestClose,
  mobileOverlay = false,
  selectedOrgKey,
  onOpenTeam,
  onReturnToTeam,
  onActiveTeamChange,
  onActivateProject,
  hideContext = false,
  mobileNavigation,
  runSidebarAction,
}: StudioSidebarProps) {
  const {
    onShowLogs,
    hasLogs,
    userEmail,
    homeAttentionCount = 0,
    homeAttentionByProject = {},
    homeAttentionByOrg = {},
    onSignOut,
    onToggleSidebar,
    sidebarOpen,
    onStartNewProject,
    onOpenProjectSettings,
    onOpenProfileSettings,
    onOpenOrgSettings,
    onOpenBugReport,
    onOpenBugReportInbox,
    supportUnreadCount = 0,
    shakeToReportEnabled = false,
    onToggleShakeToReport,
    onSimulateShakeToReport,
    onTestShakeToReport,
    shakeToReportStatus,
    shakeToReportDetail,
  } = useWorkspaceControls();
  const { projectList, activeProjectId } = useProjects();
  const navigateToDestination = useStudioNavigation();
  const {
    runtime: runtimeContext,
    runtimeOptions,
  } = useRuntimeMenuOptions();
  const { showStatus } = useStatus();
  const { profile } = useProfile();
  const { resolvedTheme, setThemeMode } = useTheme();
  const [profileMenuOpen, setProfileMenuOpen] = useState(false);
  const [notificationsEnabled, setNotificationsEnabled] = useState(() => areMessageNotificationsEnabled());
  const [notificationsPending, setNotificationsPending] = useState(false);
  const [devMenuOpen, setDevMenuOpen] = useState(false);
  const [updateDialogOpen, setUpdateDialogOpen] = useState(false);
  const [updateDialogShowDetails, setUpdateDialogShowDetails] = useState(false);
  const [updateActionPending, setUpdateActionPending] = useState(false);
  const workspaceTriggerRef = useRef<HTMLButtonElement | null>(null);
  const browseTriggerRef = useRef<HTMLButtonElement | null>(null);
  const spaceTriggerRef = useRef<HTMLButtonElement | null>(null);
  const moreTriggerRef = useRef<HTMLButtonElement | null>(null);
  const [workspaceSwitcherMode, setWorkspaceSwitcherMode] = useState<"teams-and-spaces" | "spaces">("teams-and-spaces");
  const requestedSwitcherModeRef = useRef<"teams-and-spaces" | "spaces" | null>(null);
  const [localWorkspaceMobileViewOpen, setWorkspaceMobileViewOpen] = useState(false);
  const [workspaceOrgKey, setWorkspaceOrgKey] = useState("personal");
  const [workspaceProjectQuery, setWorkspaceProjectQuery] = useState("");
  const [workspaceProjectSearchOpen, setWorkspaceProjectSearchOpen] = useState(false);
  // Stale-while-revalidate: paint the last known team rail for this user on
  // frame one instead of reserving zero height until the fetch lands.
  const [controllerOrgs, setControllerOrgs] = useState<ControllerOrgSummary[]>(() =>
    readCachedControllerOrgs(userEmail),
  );
  const [orgsFetchState, setOrgsFetchState] = useState<"loading" | "ready" | "error">(() =>
    runtimeControllerEnabled ? "loading" : "ready",
  );
  const hydratedOrgUserRef = useRef<string | null>(normalizeSidebarOrgUser(userEmail));
  const [pendingOrgSwitchKey, setPendingOrgSwitchKey] = useState<string | null>(null);
  const revealedOrgFailureRef = useRef<string | null>(null);
  const [orgsRefreshEpoch, setOrgsRefreshEpoch] = useState(0);
  const [moreMenuOpen, setMoreMenuOpen] = useState(false);
  const [localMoreMobileViewOpen, setMoreMobileViewOpen] = useState(false);
  const moreMobileViewOpen = mobileNavigation ? mobileNavigation.view === "more" : localMoreMobileViewOpen;
  const runDestination = useCallback((action: () => void) => {
    if (runSidebarAction) {
      runSidebarAction(action);
    } else {
      onRequestClose?.();
      action();
    }
  }, [onRequestClose, runSidebarAction]);
  const [recentChatsExpanded, setRecentChatsExpanded] = useState(true);
  const [recentSpacesExpanded, setRecentSpacesExpanded] = useState(true);
  const projectRecency = useProjectRecency(userEmail);
  const [appLogsOverlayOpen, setAppLogsOverlayOpen] = useState(false);
  const navRef = useRef<HTMLElement | null>(null);
  const footerRef = useRef<HTMLDivElement | null>(null);
  const updateLongPressTimerRef = useRef<number | null>(null);
  const suppressUpdateRowClickRef = useRef(false);
  const [navHeight, setNavHeight] = useState(0);
  const [footerHeight, setFooterHeight] = useState(0);
  const { logs: appLogs, hasLogs: hasAppLogs, hasErrors: hasAppLogErrors, clearLogs: clearAppLogs } =
    useAppLogs();
  const isLargeScreen = useStudioDesktopLayout();
  const desktopRail = isLargeScreen && !mobileOverlay;
  const showContext = !desktopRail || (activePanel !== "home" && !hideContext);
  const workspaceSwitcherOpen = isLargeScreen
    ? desktopWorkspaceSwitcherOpen
    : mobileNavigation ? mobileNavigation.view === "workspace" : desktopWorkspaceSwitcherOpen || localWorkspaceMobileViewOpen;
  const mobileDrillInOpen = !isLargeScreen && (workspaceSwitcherOpen || moreMobileViewOpen);
  useEffect(() => {
    if (!workspaceSwitcherOpen) return;
    // Header and browser-history entry points always browse all teams. Only
    // the context's space button opts into the narrower picker.
    setWorkspaceSwitcherMode(requestedSwitcherModeRef.current ?? "teams-and-spaces");
    requestedSwitcherModeRef.current = null;
  }, [workspaceSwitcherOpen]);
  const acquisitionTarget = getAppAcquisitionTarget();
  const { lookup: desktopReleaseLookup } = useDesktopReleaseLookup({
    enabled: acquisitionTarget === "desktop",
    manifestUrl: DESKTOP_APP_PUBLIC_LATEST_URL,
  });
  const installEntry = acquisitionTarget === "mobile"
    ? { kind: "mobile-soon" as const }
    : acquisitionTarget === "desktop" && desktopReleaseLookup.status === "available"
      ? { kind: "desktop" as const, version: desktopReleaseLookup.manifest.version }
      : null;
  const isExpanded = !collapsed;
  const showLabels = isExpanded;
  const collapsedSidebarDensity =
    showLabels || navHeight <= 0 ? "comfortable" : navHeight < 640 ? "dense" : navHeight < 760 ? "compact" : "comfortable";
  const collapsedSidebarRowLayoutClass =
    collapsedSidebarDensity === "dense"
      ? COLLAPSED_SIDEBAR_ROW_LAYOUT_DENSE_CLASS
      : collapsedSidebarDensity === "compact"
        ? COLLAPSED_SIDEBAR_ROW_LAYOUT_COMPACT_CLASS
        : COLLAPSED_SIDEBAR_ROW_LAYOUT_CLASS;
  const sidebarRowLayoutClass = showLabels ? EXPANDED_SIDEBAR_ROW_LAYOUT_CLASS : collapsedSidebarRowLayoutClass;
  const collapsedSidebarIconShellSizeClass =
    collapsedSidebarDensity === "dense"
      ? "h-7 w-7 min-w-[1.75rem]"
      : collapsedSidebarDensity === "compact"
        ? "h-8 w-8 min-w-[2rem]"
        : "h-9 w-9 min-w-[2.25rem]";
  const sidebarIconShellSizeClass = showLabels ? "h-9 w-9 min-w-[2.25rem]" : collapsedSidebarIconShellSizeClass;
  const estimatedRowHeightPx = showLabels
    ? 50
    : collapsedSidebarDensity === "dense"
      ? 38
      : collapsedSidebarDensity === "compact"
        ? 42
        : 46;
  const estimatedFooterReservePx = showLabels
    ? 184
    : collapsedSidebarDensity === "dense"
      ? 88
      : collapsedSidebarDensity === "compact"
        ? 100
        : 120;
  const resolvedMoreItems = useMemo(
    () => moreItems?.filter((item): item is StudioNavItem => Boolean(item)) ?? [],
    [moreItems],
  );
  const alwaysCollapsedMoreItemIds = useMemo(() => new Set<StudioPanel>(["secrets"]), []);
  const hasRecentChats = Boolean(onSelectConversation);
  // Desktop has a header and space selector, plus a team-menu icon when
  // compact. Home/account controls live in the separate global rail.
  const fixedEntryCount = (desktopRail ? showLabels ? 2 : 3 : showLabels ? 2 : 4) + items.length + (onOpenConversationHistory && !hasRecentChats ? 1 : 0);
  const recentChatsReservePx = hasRecentChats && showLabels && recentChatsExpanded
    ? Math.max(1, Math.min(recentConversations.length, SIDEBAR_RECENT_CHAT_LIMIT)) * 40 + 56
    : 0;
  // Reserve the bounded two-row space grid before placing secondary tools.
  const recentSpacesReservePx = showLabels && recentSpacesExpanded
    ? Math.ceil(SIDEBAR_RECENT_SPACE_LIMIT / 3) * 96 + 48
    : 0;
  const estimatedChromeReservePx = 24;
  const effectiveFooterReservePx = desktopRail ? 0 : Math.max(estimatedFooterReservePx, footerHeight);
  const desktopSecondaryRowCapacity =
    isLargeScreen
      ? Math.max(
          0,
          Math.floor(
            (navHeight - effectiveFooterReservePx - estimatedChromeReservePx - recentChatsReservePx - recentSpacesReservePx - fixedEntryCount * estimatedRowHeightPx) /
              estimatedRowHeightPx,
          ),
        )
      : 0;
  const spillableDesktopMoreItems = useMemo(
    () => resolvedMoreItems.filter((item) => !alwaysCollapsedMoreItemIds.has(item.id)),
    [alwaysCollapsedMoreItemIds, resolvedMoreItems],
  );
  const desktopNeedsMoreButton =
    isLargeScreen &&
    resolvedMoreItems.length > 0 &&
    (resolvedMoreItems.length !== spillableDesktopMoreItems.length ||
      spillableDesktopMoreItems.length > desktopSecondaryRowCapacity);
  const desktopInlineMoreCapacity = isLargeScreen
    ? Math.max(0, desktopSecondaryRowCapacity - (desktopNeedsMoreButton ? 1 : 0))
    : 0;
  const inlineMoreItems = useMemo(
    () =>
      !isLargeScreen
        ? isExpanded && !hasRecentChats
          ? resolvedMoreItems
          : []
        : spillableDesktopMoreItems.slice(
            0,
            Math.min(spillableDesktopMoreItems.length, desktopInlineMoreCapacity),
          ),
    [
      desktopInlineMoreCapacity,
      hasRecentChats,
      isExpanded,
      isLargeScreen,
      resolvedMoreItems,
      spillableDesktopMoreItems,
    ],
  );
  const inlineMoreItemIds = useMemo(() => new Set(inlineMoreItems.map((item) => item.id)), [inlineMoreItems]);
  const collapsedMoreItems = useMemo(
    () =>
      !isLargeScreen
        ? isExpanded && !hasRecentChats
          ? []
          : resolvedMoreItems
        : resolvedMoreItems.filter((item) => !inlineMoreItemIds.has(item.id)),
    [hasRecentChats, inlineMoreItemIds, isExpanded, isLargeScreen, resolvedMoreItems],
  );
  const showInlineMoreItems = inlineMoreItems.length > 0;
  const sidebarMobileDrillInOpen = workspaceSwitcherOpen || moreMobileViewOpen;
  const mobileExpandedWidthClass = sidebarMobileDrillInOpen
    ? "w-[clamp(18rem,65vw,24rem)]"
    : "w-[clamp(16rem,60vw,22rem)]";
  // Only true in the macOS shell that vacated its title bar; everywhere
  // else the rail keeps its stock full-height surface.
  const titleBarFree = !mobileOverlay && desktopTitleBarFree();
  const widthClass = isExpanded
    ? isLargeScreen
      ? "w-56"
      : mobileExpandedWidthClass
    : "w-[4rem]";
  const getSidebarNavIconClass = useCallback(
    (active: boolean, accentClass = "text-primary-600 dark:text-primary-500") =>
      [
        `relative flex ${sidebarIconShellSizeClass} items-center justify-center rounded-lg border transition-colors`,
        active
          ? showLabels
            ? `border-transparent bg-transparent ${accentClass}`
            : `border-primary-200 bg-primary-50 ${accentClass} dark:border-primary-500/40 dark:bg-primary-500/10`
          : "border-transparent text-slate-600 group-hover/item:text-primary-600 dark:text-slate-500 dark:group-hover/item:text-primary-500",
      ].join(" "),
    [showLabels, sidebarIconShellSizeClass],
  );
  const getSidebarRowToneClass = useCallback(
    (active: boolean) =>
      showLabels
        ? active
          ? EXPANDED_SIDEBAR_BUTTON_ACTIVE_CLASS
          : EXPANDED_SIDEBAR_BUTTON_INACTIVE_CLASS
        : [
            active ? "text-slate-900 dark:text-slate-50" : "text-slate-600 hover:text-slate-900 dark:text-slate-300 dark:hover:text-slate-50",
            COLLAPSED_SIDEBAR_BUTTON_TONE_CLASS,
          ].join(" "),
    [showLabels],
  );
  const isMorePanelActive = collapsedMoreItems.some((item) => item.id === activePanel);
  const moreIndicator = useMemo(() => {
    const danger = collapsedMoreItems.find((item) => item.indicator?.tone === "danger")?.indicator;
    if (danger) {
      return danger;
    }
    const warning = collapsedMoreItems.find((item) => item.indicator?.tone === "warning")?.indicator;
    return warning ?? null;
  }, [collapsedMoreItems]);
  const selectedMoreKeys = useMemo(() => {
    if (!collapsedMoreItems.some((item) => item.id === activePanel)) {
      return [];
    }
    return [`panel:${activePanel}`];
  }, [activePanel, collapsedMoreItems]);

  useEffect(() => {
    if (!isLargeScreen && sidebarOpen) {
      setRecentChatsExpanded(true);
    }
  }, [isLargeScreen, sidebarOpen]);

  useEffect(() => {
    // Resizing the rail can move secondary tools between inline rows and
    // More. An old popover must not reappear on the next width change.
    setMoreMenuOpen(false);
  }, [isExpanded]);

  useEffect(() => {
    if (!showInlineMoreItems) {
      return;
    }
    setMoreMobileViewOpen(false);
  }, [showInlineMoreItems]);
  useEffect(() => {
    if (collapsedMoreItems.length > 0) {
      return;
    }
    setMoreMenuOpen(false);
    setMoreMobileViewOpen(false);
  }, [collapsedMoreItems.length]);
  const fullName = profile?.fullName?.trim() || null;
  const displayName = fullName || userEmail || "Guest";
  const accountSubtitle = (() => {
    const email = userEmail?.trim() || null;
    if (!email) {
      return null;
    }
    if (!fullName) {
      return null;
    }
    if (fullName.toLowerCase() === email.toLowerCase()) {
      return null;
    }
    return email;
  })();
  const avatarUrl = profile?.avatarUrl?.trim() || null;
  const initials = (() => {
    const base = displayName.trim();
    if (!base) {
      return "U";
    }
    const parts = base.split(/\s+/).filter(Boolean);
    if (parts.length >= 2) {
      return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
    }
    return parts[0].slice(0, 2).toUpperCase();
  })();
  const updateEntrySupported = desktopUpdaterBridgeAvailable() || otaIsSupportedOnThisClient();
  const {
    metadata: updateMetadata,
    refresh: refreshUpdateMetadata,
  } = useAppUpdateMetadata(updateEntrySupported);
  const updatePresentation = useMemo(
    () => (updateMetadata ? summarizeAppUpdateState(updateMetadata) : null),
    [updateMetadata],
  );
  const shouldRenderUpdateEntry =
    updateEntrySupported && (updateMetadata ? Boolean(updatePresentation?.show) : true);

  useEffect(() => {
    const element = navRef.current;
    if (!element) {
      return;
    }

    const updateHeight = () => {
      setNavHeight(Math.round(element.getBoundingClientRect().height));
    };

    updateHeight();

    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", updateHeight);
      return () => {
        window.removeEventListener("resize", updateHeight);
      };
    }

    const observer = new ResizeObserver(() => {
      updateHeight();
    });
    observer.observe(element);
    window.addEventListener("resize", updateHeight);

    return () => {
      observer.disconnect();
      window.removeEventListener("resize", updateHeight);
    };
  }, [isExpanded, isLargeScreen, items.length, onOpenConversationHistory, resolvedMoreItems.length, showContext]);

  useEffect(() => {
    const element = footerRef.current;
    if (!element) {
      return;
    }

    const updateHeight = () => {
      setFooterHeight(Math.round(element.getBoundingClientRect().height));
    };

    updateHeight();

    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", updateHeight);
      return () => {
        window.removeEventListener("resize", updateHeight);
      };
    }

    const observer = new ResizeObserver(() => {
      updateHeight();
    });
    observer.observe(element);
    window.addEventListener("resize", updateHeight);

    return () => {
      observer.disconnect();
      window.removeEventListener("resize", updateHeight);
    };
  }, [isExpanded, isLargeScreen, showInlineMoreItems]);

  const handleCopyTunnel = useCallback(
    (mode: TunnelCopyMode, runtimeId: string | null) => {
      void runtimeContext.copyTunnelDetails(mode, runtimeId);
    },
    [runtimeContext],
  );

  useEffect(() => {
    if (!profileMenuOpen) {
      return;
    }
    setNotificationsEnabled(areMessageNotificationsEnabled());
  }, [profileMenuOpen]);

  useEffect(() => {
    if (!profileMenuOpen && !updateDialogOpen) {
      return;
    }
    void refreshUpdateMetadata();
  }, [profileMenuOpen, refreshUpdateMetadata, updateDialogOpen]);

  const clearUpdateLongPress = useCallback(() => {
    if (updateLongPressTimerRef.current === null) {
      return;
    }
    window.clearTimeout(updateLongPressTimerRef.current);
    updateLongPressTimerRef.current = null;
  }, []);

  useEffect(() => () => clearUpdateLongPress(), [clearUpdateLongPress]);

  const openUpdateDialog = useCallback(
    async (showDetails: boolean) => {
      setProfileMenuOpen(false);
      setUpdateDialogShowDetails(showDetails);
      setUpdateDialogOpen(true);
      await refreshUpdateMetadata();
    },
    [refreshUpdateMetadata],
  );

  const handleUpdateEntryClick = useCallback(() => {
    clearUpdateLongPress();
    if (suppressUpdateRowClickRef.current) {
      suppressUpdateRowClickRef.current = false;
      return;
    }
    void openUpdateDialog(false);
  }, [clearUpdateLongPress, openUpdateDialog]);

  const handleUpdateEntryContextMenu = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => {
      event.preventDefault();
      clearUpdateLongPress();
      suppressUpdateRowClickRef.current = true;
      void openUpdateDialog(true);
    },
    [clearUpdateLongPress, openUpdateDialog],
  );

  const handleUpdateEntryPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      if (event.pointerType === "mouse" && event.button !== 0) {
        return;
      }
      suppressUpdateRowClickRef.current = false;
      clearUpdateLongPress();
      updateLongPressTimerRef.current = window.setTimeout(() => {
        suppressUpdateRowClickRef.current = true;
        void openUpdateDialog(true);
      }, 550);
    },
    [clearUpdateLongPress, openUpdateDialog],
  );

  const handleUpdatePrimaryAction = useCallback(async () => {
    const current = updateMetadata ?? (await refreshUpdateMetadata());
    if (!current) {
      return;
    }

    setUpdateActionPending(true);
    try {
      if (current.runtime_surface === "desktop") {
        if (current.updates.primary_action === "download") {
          const result = await downloadDesktopUpdaterNow();
          const nextMeta = await refreshUpdateMetadata();
          const feedback = resolveDesktopDownloadFeedback(result, nextMeta);
          showStatus(feedback.message, feedback.intent, feedback.intent === "error" ? 3500 : 3000);
          return;
        } else if (current.updates.primary_action === "install") {
          const result = await installDesktopUpdaterNow();
          if (result?.lastInstallRequestAccepted === false) {
            showStatus("Update kept for later.", "info", 2500);
            return;
          }
          showStatus("Restarting to install update.", "success", 2500);
        } else if (current.updates.primary_action === "check") {
          const next = await checkDesktopUpdaterNow();
          const nextMeta = await refreshUpdateMetadata();
          if (next?.phase === "up_to_date" || nextMeta?.updates.phase === "up_to_date") {
            showStatus("Instafy is up to date.", "success", 2500);
          } else if (next?.phase === "error" || nextMeta?.updates.phase === "error") {
            showStatus(nextMeta?.updates.last_error ?? "Update check failed.", "error", 3500);
          }
          return;
        }
      } else if (current.runtime_surface === "native-ota") {
        if (current.updates.primary_action === "install") {
          const applied = await applyStagedNativeOtaUpdate();
          await refreshUpdateMetadata();
          if (applied) {
            showStatus("Restarting to apply the staged update.", "success", 3000);
          } else {
            showStatus("No staged update was found.", "info", 2500);
          }
          return;
        }
        if (
          current.updates.primary_action === "download" ||
          current.updates.primary_action === "check"
        ) {
          const result = await triggerNativeOtaCheck();
          const nextMeta = await refreshUpdateMetadata();
          if (nextMeta?.updates.phase === "downloaded") {
            showStatus("Update is ready. Restart to apply it.", "success", 3000);
          } else if (result?.update_available) {
            showStatus("Update detected. Instafy is staging it now.", "success", 3000);
          } else {
            showStatus("Instafy is up to date.", "success", 2500);
          }
          return;
        }
      }
      await refreshUpdateMetadata();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to complete update action.";
      showStatus(message, "error", 4000);
    } finally {
      setUpdateActionPending(false);
    }
  }, [refreshUpdateMetadata, showStatus, updateMetadata]);

  useEffect(() => {
    let cancelled = false;
    if (!runtimeControllerEnabled) {
      setControllerOrgs([]);
      setOrgsFetchState("ready");
      return () => {
        cancelled = true;
      };
    }
    // Auth usually resolves after mount, so the lazy initialiser above often
    // ran with no user. Re-hydrate from this user's snapshot the moment their
    // identity is known, before the round-trip that replaces it.
    const userKey = normalizeSidebarOrgUser(userEmail);
    if (hydratedOrgUserRef.current !== userKey) {
      hydratedOrgUserRef.current = userKey;
      setControllerOrgs(readCachedControllerOrgs(userEmail));
    }
    setOrgsFetchState("loading");
    const requestController = new AbortController();
    listControllerOrganizations({ throwOnError: true, signal: requestController.signal })
      .then((orgs) => {
        if (!cancelled) {
          setControllerOrgs(orgs);
          setOrgsFetchState("ready");
        }
      })
      .catch(() => {
        if (!cancelled) {
          // Keep whatever the cached snapshot hydrated. Clearing here would
          // make an already-painted team rail vanish on a failed refresh —
          // a worse flicker than the pop-in this hydration exists to remove.
          // A stale rail is still switchable; the next successful fetch
          // reconciles it, and the snapshot is only rewritten on success.
          setOrgsFetchState("error");
        }
      });
    // orgsRefreshEpoch is in the dependency array: org profile edits
    // (avatar/name) dispatch instafy:orgs-updated to re-run this fetch.
    return () => {
      cancelled = true;
      requestController.abort();
    };
  }, [orgsRefreshEpoch, userEmail]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    const bump = () => setOrgsRefreshEpoch((epoch) => epoch + 1);
    window.addEventListener("instafy:orgs-updated", bump);
    return () => window.removeEventListener("instafy:orgs-updated", bump);
  }, []);

  const handleToggleNotifications = useCallback(async () => {
    if (notificationsPending) {
      return;
    }
    setNotificationsPending(true);
    try {
      if (notificationsEnabled) {
        setNotificationsEnabled(false);
        const ok = await disableMessageNotifications();
        if (!ok) {
          showStatus("Notifications disabled (cleanup may be incomplete).", "info", 4000);
        }
        return;
      }

      const ok = await enableMessageNotifications();
      setNotificationsEnabled(ok);
      if (!ok) {
        showStatus("Unable to enable notifications.", "error", 4000);
      }
    } finally {
      setNotificationsPending(false);
    }
  }, [notificationsEnabled, notificationsPending, showStatus]);

  const activeProject = useMemo(
    () => projectList.find((project) => project.id === activeProjectId),
    [activeProjectId, projectList],
  );
  const activeProjectOrgKey = activeProject?.orgId ?? "personal";
  const activeOrgKey = selectedOrgKey ?? activeProjectOrgKey;
  const selectedTeamHasActiveSpace = activeOrgKey === activeProjectOrgKey && Boolean(activeProject);
  const canBrowseAllWorkspaceOrgs = activeProject?.orgId == null && controllerOrgs.length > 0;
  const workspaceOrgFilterId =
    workspaceOrgKey === "all" || workspaceOrgKey === "personal" ? null : workspaceOrgKey;
  const {
    mergedProjects,
    remoteLoading: mergedProjectsLoading,
    remoteLoadedScope,
    remoteDiscoveryResolved,
    remoteError: mergedProjectsError,
    remoteRefreshing: mergedProjectsRefreshing,
    retryRemoteProjects,
  } = useMergedControllerProjects({
    localProjects: projectList,
    orgId: workspaceOrgFilterId,
    includeAllOrgs: workspaceOrgKey === "all",
  });
  const retryWorkspaceProjects = useCallback(() => {
    if (pendingOrgSwitchKey) {
      studioPerformance.begin("organization_switch", {
        organizationId: pendingOrgSwitchKey === "personal" ? null : pendingOrgSwitchKey,
      });
    }
    retryRemoteProjects();
  }, [pendingOrgSwitchKey, retryRemoteProjects]);
  const controllerOrgInfoById = useMemo(() => {
    const map = new Map<string, { name: string; slug: string | null; avatarUrl: string | null }>();
    controllerOrgs.forEach((org) => {
      map.set(org.id, {
        name: getOrgDisplayName(org.name),
        slug: org.slug ?? null,
        avatarUrl: org.avatarUrl ?? null,
      });
    });
    return map;
  }, [controllerOrgs]);
  const appLogExport = useMemo(() => {
    const payload = {
      createdAt: new Date().toISOString(),
      location: typeof window !== "undefined" ? window.location.href : null,
      userAgent: typeof navigator !== "undefined" ? navigator.userAgent : null,
      mode: import.meta.env.MODE,
      userEmail,
      activeProjectId,
      logs: appLogs,
    };
    return JSON.stringify(payload, null, 2);
  }, [activeProjectId, appLogs, userEmail]);
  const orgOptions = useMemo(() => {
    const options = new Map<
      string,
      { key: string; name: string; label: string; slug: string | null; count: number; avatarUrl: string | null }
    >();

    controllerOrgs.forEach((org) => {
      options.set(org.id, {
        key: org.id,
        name: getOrgDisplayName(org.name),
        label: getOrgDisplayName(org.name),
        slug: org.slug ?? null,
        count: 0,
        avatarUrl: org.avatarUrl ?? null,
      });
    });
    mergedProjects.forEach((project) => {
      const key = project.orgId ?? "personal";
      const controllerInfo = key !== "personal" ? controllerOrgInfoById.get(key) : null;
      const name = controllerInfo?.name ?? project.orgName;
      const slug = controllerInfo?.slug ?? null;
      const current = options.get(key);
      if (current) {
        current.count += 1;
        if (!current.slug && slug) {
          current.slug = slug;
        }
        if (!current.name && name) {
          current.name = name;
        }
      } else {
        options.set(key, {
          key,
          name,
          label: name,
          slug,
          count: 1,
          avatarUrl: controllerInfo?.avatarUrl ?? null,
        });
      }
    });
    const list = Array.from(options.values());
    const base =
      list.length === 0
        ? [{ key: "personal", name: getOrgDisplayName(null), label: getOrgDisplayName(null), slug: null, count: 0, avatarUrl: null }]
        : list;
    if (canBrowseAllWorkspaceOrgs) {
      base.unshift({ key: "all", name: "All teams", label: "All teams", slug: null, count: mergedProjects.length, avatarUrl: null });
    }
    const nameCounts = new Map<string, number>();
    base.forEach((org) => {
      nameCounts.set(org.name, (nameCounts.get(org.name) ?? 0) + 1);
    });
    const resolved = base.map((org) => {
      if ((nameCounts.get(org.name) ?? 0) <= 1) {
        return { ...org, label: org.name };
      }
      const suffix =
        org.key === "personal" ? "local" : getOrgDisambiguator(org.slug, org.key);
      return { ...org, label: `${org.name} • ${suffix}` };
    });
    return resolved.sort((a, b) => {
      if (a.key === "all") {
        return -1;
      }
      if (b.key === "all") {
        return 1;
      }
      return a.name.localeCompare(b.name);
    });
  }, [canBrowseAllWorkspaceOrgs, controllerOrgInfoById, controllerOrgs, mergedProjects]);
  const activeOrgName = useMemo(() => {
    const match = orgOptions.find((org) => org.key === activeOrgKey);
    if (match?.name) {
      return match.name;
    }
    return activeOrgKey === activeProjectOrgKey ? getOrgDisplayName(activeProject?.orgName) : "Team";
  }, [activeOrgKey, activeProjectOrgKey, activeProject?.orgName, orgOptions]);
  const activeOrgAvatarUrl = orgOptions.find((org) => org.key === activeOrgKey)?.avatarUrl ?? null;
  const activeTeamUserKey = normalizeSidebarOrgUser(userEmail);
  const activeTeamMetadataReady = hydratedOrgUserRef.current === activeTeamUserKey;
  const publishedActiveTeamRef = useRef<{ user: string | null; key: string; name: string; avatarUrl: string | null } | null>(null);
  useEffect(() => {
    // Account changes hydrate their own org snapshot in the effect above. Do
    // not publish this render's previous-account metadata as the new user.
    if (!activeTeamMetadataReady) return;
    const previous = publishedActiveTeamRef.current;
    if (previous?.user === activeTeamUserKey && previous.key === activeOrgKey && previous.name === activeOrgName && previous.avatarUrl === activeOrgAvatarUrl) return;
    const team = { key: activeOrgKey, name: activeOrgName, avatarUrl: activeOrgAvatarUrl };
    publishedActiveTeamRef.current = { user: activeTeamUserKey, ...team };
    onActiveTeamChange?.(team);
  }, [activeOrgKey, activeOrgName, activeOrgAvatarUrl, activeTeamMetadataReady, activeTeamUserKey, onActiveTeamChange]);
  const orgDeckTeams = useMemo(
    () => orgOptions.filter((org) => org.key !== "all"),
    [orgOptions],
  );
  // Refresh the snapshot after every successful load (never after a failure —
  // a flaky request must not erase teams the user really has).
  useEffect(() => {
    if (!runtimeControllerEnabled || orgsFetchState !== "ready") {
      return;
    }
    writeSidebarOrgSnapshot(userEmail, controllerOrgs, orgDeckTeams.length);
  }, [controllerOrgs, orgDeckTeams.length, orgsFetchState, userEmail]);
  const selectedWorkspaceOrg = useMemo(
    () => orgOptions.find((org) => org.key === workspaceOrgKey) ?? null,
    [orgOptions, workspaceOrgKey],
  );
  const activeOrgProjects = useMemo(
    () =>
      workspaceOrgKey === "all"
        ? mergedProjects
        : mergedProjects.filter((project) => (project.orgId ?? "personal") === workspaceOrgKey),
    [mergedProjects, workspaceOrgKey],
  );
  // Quick switching follows the selected team, independent of directory search
  // or a temporarily browsed team. Recency contains IDs only; access comes from
  // the authenticated project snapshot.
  const recentSpaceCandidates = useMemo(() => activeTeamMetadataReady
    ? mergedProjects.filter((project) => (project.orgId ?? "personal") === activeOrgKey)
      .map((project) => ({ id: project.id, name: project.name, icon: project.projectIcon, color: project.projectColor }))
    : [], [activeOrgKey, activeTeamMetadataReady, mergedProjects]);
  const filteredOrgProjects = useMemo(() => {
    const needle = workspaceProjectQuery.trim().toLowerCase();
    const filtered =
      needle.length === 0
        ? activeOrgProjects
        : activeOrgProjects.filter((project) => {
            const name = (project.name || "Untitled space").toLowerCase();
            return name.includes(needle) || project.id.toLowerCase().includes(needle);
          });
    // Spaces needing attention first, then most recently opened; never-opened
    // spaces fall back to name order. Keeps badged spaces above the list cap.
    return [...filtered].sort((a, b) => {
      const attentionDelta =
        (homeAttentionByProject[b.id] ?? 0) - (homeAttentionByProject[a.id] ?? 0);
      if (attentionDelta !== 0) {
        return attentionDelta;
      }
      const recencyDelta = (projectRecency[b.id] ?? 0) - (projectRecency[a.id] ?? 0);
      if (recencyDelta !== 0) {
        return recencyDelta;
      }
      return (a.name || "Untitled space").localeCompare(b.name || "Untitled space");
    });
  }, [activeOrgProjects, homeAttentionByProject, projectRecency, workspaceProjectQuery]);
  const currentOrgProject = useMemo(
    () => filteredOrgProjects.find((project) => project.id === activeProjectId) ?? null,
    [activeProjectId, filteredOrgProjects],
  );
  const switcherProjects = useMemo(
    () => filteredOrgProjects.filter((project) => project.id !== activeProjectId),
    [activeProjectId, filteredOrgProjects],
  );
  const canSearchSpaces =
    switcherProjects.length > 0 || workspaceProjectSearchOpen || workspaceProjectQuery.trim().length > 0;

  const resetWorkspaceSwitcher = useCallback(() => {
    // A local reset is not Back. Destination actions own their history write.
    requestedSwitcherModeRef.current = null;
    setWorkspaceMobileViewOpen(false);
    setWorkspaceProjectQuery("");
    setWorkspaceProjectSearchOpen(false);
  }, []);

  const dismissWorkspaceSwitcher = useCallback(() => {
    resetWorkspaceSwitcher();
    if (!isLargeScreen && mobileNavigation) mobileNavigation.back();
    else onWorkspaceSwitcherOpenChange(false);
  }, [isLargeScreen, mobileNavigation, onWorkspaceSwitcherOpenChange, resetWorkspaceSwitcher]);

  const openWorkspaceSwitcher = useCallback((mode: "teams-and-spaces" | "spaces" = "teams-and-spaces") => {
    requestedSwitcherModeRef.current = mode;
    setWorkspaceSwitcherMode(mode);
    setMoreMenuOpen(false);
    setMoreMobileViewOpen(false);
    setWorkspaceOrgKey(mode === "spaces" ? activeOrgKey : canBrowseAllWorkspaceOrgs ? "all" : activeOrgKey);
    // A programmatic reset abandons any in-flight team switch — clear the
    // pending markers or the clicked chip pulses forever and the sync effect
    // stays short-circuited by the stale ref.
    if (pendingOrgContextSwitchRef.current) {
      studioPerformance.cancelOrganizationDiscovery(
        pendingOrgContextSwitchRef.current === "personal" ? null : pendingOrgContextSwitchRef.current,
      );
    }
    pendingOrgContextSwitchRef.current = null;
    setPendingOrgSwitchKey(null);
    setWorkspaceProjectQuery("");
    setWorkspaceProjectSearchOpen(false);
    if (!isLargeScreen) {
      if (mobileNavigation) mobileNavigation.openView("workspace");
      else setWorkspaceMobileViewOpen(true);
    } else {
      onWorkspaceSwitcherOpenChange(true);
    }
  }, [activeOrgKey, canBrowseAllWorkspaceOrgs, isLargeScreen, mobileNavigation, onWorkspaceSwitcherOpenChange]);

  const pendingOrgContextSwitchRef = useRef<string | null>(null);

  const performProjectSwitch = useCallback(
    (projectId: string) => {
      if (!projectId) return;
      const destination = mergedProjects.find((entry) => entry.id === projectId);
      const destinationOrgKey = destination?.orgId ?? (projectId === activeProjectId ? activeProject?.orgId : null) ?? "personal";
      if (projectId !== activeProjectId) {
        studioPerformance.beginProject(projectId, destination?.orgId ?? null, activeProject?.orgId ?? null);
      }
      // Resolve previously unseen spaces through the authenticated route owner;
      // createProject followed by a stale switchProject closure can return early.
      if (onActivateProject) onActivateProject(projectId, destinationOrgKey);
      else if (projectId !== activeProjectId || activeOrgKey !== activeProjectOrgKey || activePanel === "home" || hideContext) {
        navigateToDestination({ kind: "conversation", projectId });
      }
    },
    [activeOrgKey, activePanel, activeProject?.orgId, activeProjectId, activeProjectOrgKey, hideContext, mergedProjects, navigateToDestination, onActivateProject],
  );

  const handleWorkspaceOrgChange = useCallback(
    (orgKey: string) => {
      revealedOrgFailureRef.current = null;
      setWorkspaceOrgKey(orgKey);
      setWorkspaceProjectQuery("");
      setWorkspaceProjectSearchOpen(false);
      if (pendingOrgContextSwitchRef.current) {
        studioPerformance.cancelOrganizationDiscovery(
          pendingOrgContextSwitchRef.current === "personal" ? null : pendingOrgContextSwitchRef.current,
        );
      }
      pendingOrgContextSwitchRef.current = null;
      setPendingOrgSwitchKey(null);
      if (orgKey === activeOrgKey && (activePanel === "home" || hideContext)) {
        resetWorkspaceSwitcher();
        runDestination(() => {
          if (onReturnToTeam) onReturnToTeam(orgKey);
          else if (onOpenTeam) onOpenTeam(orgKey);
          else onSelect("team");
        });
        return;
      }
      if (orgKey === activeProjectOrgKey && orgKey !== activeOrgKey && activeProjectId) {
        resetWorkspaceSwitcher();
        runDestination(() => performProjectSwitch(activeProjectId));
        return;
      }
      // Keep the requested team separate from the active space until a
      // successful discovery snapshot can resolve its destination.
      const pending =
        orgKey !== "all" && (activeProject?.orgId ?? "personal") !== orgKey ? orgKey : null;
      if (pending) studioPerformance.begin("organization_switch", { organizationId: pending === "personal" ? null : pending });
      else studioPerformance.cancel();
      pendingOrgContextSwitchRef.current = pending;
      setPendingOrgSwitchKey(pending);
    },
    [activeOrgKey, activePanel, activeProject?.orgId, activeProjectId, activeProjectOrgKey, resetWorkspaceSwitcher, hideContext, onOpenTeam, runDestination, onReturnToTeam, onSelect, performProjectSwitch],
  );

  useEffect(() => {
    if (!desktopRail || !pendingOrgSwitchKey || pendingOrgSwitchKey !== workspaceOrgKey
      || !mergedProjectsError || mergedProjectsRefreshing) return;
    if (workspaceSwitcherOpen) {
      revealedOrgFailureRef.current = pendingOrgSwitchKey;
      return;
    }
    if (revealedOrgFailureRef.current === pendingOrgSwitchKey) return;
    revealedOrgFailureRef.current = pendingOrgSwitchKey;
    // Reveal the existing error and Retry without resetting the requested team
    // or cancelling its pending switch. Dismissing it stays dismissed.
    requestedSwitcherModeRef.current = "teams-and-spaces";
    setWorkspaceSwitcherMode("teams-and-spaces");
    onWorkspaceSwitcherOpenChange(true);
  }, [desktopRail, mergedProjectsError, mergedProjectsRefreshing, onWorkspaceSwitcherOpenChange, pendingOrgSwitchKey, workspaceOrgKey, workspaceSwitcherOpen]);

  useEffect(() => {
    const pendingOrgKey = pendingOrgContextSwitchRef.current;
    if (!pendingOrgKey || pendingOrgKey !== workspaceOrgKey || mergedProjectsLoading || !remoteDiscoveryResolved) {
      return;
    }
    // The list must actually be FOR the pending org: right after a chip click
    // this effect can run against the previous org's results with loading not
    // yet visible in this closure — resolving then fires a false "no spaces"
    // toast and drops the switch, leaving the org unreachable from the rail.
    const expectedScope =
      pendingOrgKey === "personal" ? null : pendingOrgKey;
    if (remoteLoadedScope !== expectedScope) {
      return;
    }
    pendingOrgContextSwitchRef.current = null;
    setPendingOrgSwitchKey(null);
    if ((activeProject?.orgId ?? "personal") === pendingOrgKey) {
      return;
    }
    // Move to the team's most recently opened space; never-opened teams fall
    // back to name order. Empty teams open their explicitly scoped overview.
    const orgProjects = mergedProjects.filter(
      (project) => (project.orgId ?? "personal") === pendingOrgKey,
    );
    if (orgProjects.length === 0) {
      studioPerformance.cancel();
      if (onOpenTeam) {
        resetWorkspaceSwitcher();
        runDestination(() => onOpenTeam(pendingOrgKey));
      } else {
        showStatus("No spaces in this team yet — create one to get started.", "info", 3500);
      }
      return;
    }
    const targetId =
      mostRecentProjectId(orgProjects.map((project) => project.id), projectRecency) ??
      [...orgProjects].sort((a, b) =>
        (a.name || "Untitled space").localeCompare(b.name || "Untitled space"),
      )[0].id;
    resetWorkspaceSwitcher();
    runDestination(() => performProjectSwitch(targetId));
  }, [activeProject?.orgId, mergedProjects, mergedProjectsLoading, onOpenTeam, performProjectSwitch, projectRecency, remoteDiscoveryResolved, remoteLoadedScope, resetWorkspaceSwitcher, runDestination, showStatus, workspaceOrgKey]);

  const handleProjectSwitch = useCallback(
    (projectId: string) => {
      if (projectId === activeProjectId && !mobileNavigation && activeOrgKey === activeProjectOrgKey && activePanel !== "home" && !hideContext) {
        // Choosing Current is dismissal, not a new destination. A route-owned
        // drawer has no sidebar branch for runDestination to collapse.
        dismissWorkspaceSwitcher();
        return;
      }
      resetWorkspaceSwitcher();
      runDestination(() => performProjectSwitch(projectId));
    },
    [activeOrgKey, activePanel, activeProjectId, activeProjectOrgKey, dismissWorkspaceSwitcher, hideContext, mobileNavigation, resetWorkspaceSwitcher, performProjectSwitch, runDestination],
  );

  const handleProjectMenuAction = useCallback(
    (key: string | number) => {
      const action = String(key);
      if (action === "project:settings") {
        resetWorkspaceSwitcher();
        runDestination(() => onOpenProjectSettings?.());
        return;
      }
      if (action === "project:new") {
        resetWorkspaceSwitcher();
        runDestination(() => onStartNewProject?.());
        return;
      }
      if (action.startsWith("project:")) {
        handleProjectSwitch(action.slice("project:".length));
      }
    },
    [
      resetWorkspaceSwitcher,
      handleProjectSwitch,
      onOpenProjectSettings,
      runDestination,
      onStartNewProject,
    ],
  );

  const handleMoreMenuAction = useCallback(
    (key: string | number) => {
      const action = String(key);
      if (!action.startsWith("panel:")) {
        return;
      }
      setMoreMenuOpen(false);
      setMoreMobileViewOpen(false);
      runDestination(() => onSelect(action.slice("panel:".length) as StudioPanel));
    },
    [onSelect, runDestination],
  );

  const closeMoreMenu = useCallback(() => {
    setMoreMenuOpen(false);
    setMoreMobileViewOpen(false);
  }, []);

  const openMoreMenu = useCallback(() => {
    resetWorkspaceSwitcher();
    if (isLargeScreen) {
      setMoreMenuOpen(true);
      return;
    }
    if (mobileNavigation) mobileNavigation.openView("more");
    else setMoreMobileViewOpen(true);
  }, [resetWorkspaceSwitcher, isLargeScreen, mobileNavigation]);

  const previousActiveProjectId = useRef(activeProjectId);
  useEffect(() => {
    const previousProjectId = previousActiveProjectId.current;
    previousActiveProjectId.current = activeProjectId;
    if (!previousProjectId || !activeProjectId || previousProjectId === activeProjectId) {
      return;
    }
    resetWorkspaceSwitcher();
  }, [activeProjectId, resetWorkspaceSwitcher]);

  useEffect(() => {
    setWorkspaceOrgKey(canBrowseAllWorkspaceOrgs ? "all" : activeOrgKey);
    // A programmatic reset abandons any in-flight team switch — clear the
    // pending markers or the clicked chip pulses forever and the sync effect
    // stays short-circuited by the stale ref.
    pendingOrgContextSwitchRef.current = null;
    setPendingOrgSwitchKey(null);
  }, [activeOrgKey, canBrowseAllWorkspaceOrgs]);

  useEffect(() => {
    if (!sidebarOpen) {
      setMoreMobileViewOpen(false);
    }
  }, [sidebarOpen]);

  useEffect(() => {
    if (workspaceSwitcherOpen) {
      return;
    }
    setWorkspaceProjectQuery("");
    setWorkspaceProjectSearchOpen(false);
  }, [workspaceSwitcherOpen]);

  useEffect(() => {
    if (isLargeScreen) {
      setMoreMobileViewOpen(false);
    } else {
      setMoreMenuOpen(false);
    }
  }, [isLargeScreen]);

  const showProjectSearch = workspaceProjectSearchOpen || workspaceProjectQuery.trim().length > 0;
  const handleToggleProjectSearch = useCallback(() => {
    if (showProjectSearch) {
      setWorkspaceProjectSearchOpen(false);
      setWorkspaceProjectQuery("");
      return;
    }
    setWorkspaceProjectSearchOpen(true);
  }, [showProjectSearch]);

  const moreSwitcherOpen = moreMenuOpen || moreMobileViewOpen;
  const [newTeamOpen, setNewTeamOpen] = useState(false);
  const handleTeamCreated = useCallback((created: ControllerOrgSummary) => {
    setControllerOrgs((current) => [...current.filter((org) => org.id !== created.id), created]);
    setWorkspaceOrgKey(created.id);
    resetWorkspaceSwitcher();
    runDestination(() => onOpenOrgSettings?.(created.id));
  }, [onOpenOrgSettings, resetWorkspaceSwitcher, runDestination]);

  const openSelectedTeam = () => {
    resetWorkspaceSwitcher();
    closeMoreMenu();
    runDestination(() => {
      if (onOpenTeam) onOpenTeam(activeOrgKey);
      else onSelect("team");
    });
  };
  const openSelectedTeamSettings = () => {
    resetWorkspaceSwitcher();
    closeMoreMenu();
    runDestination(() => onOpenOrgSettings?.(activeOrgKey));
  };
  // A selected-team/account/page change discards any open menu, including
  // changes that retain the same loaded project behind a global panel.
  const teamMenu = <StudioSidebarTeamMenu
    key={JSON.stringify([activeTeamUserKey, activeOrgKey, activeProjectId, activePanel, desktopRail, showLabels])}
    teamName={activeOrgName} compact={!showLabels}
    active={activePanel === "team" || activePanel === "settings"}
    rowClassName={`${sidebarRowLayoutClass} ${getSidebarRowToneClass(activePanel === "team" || activePanel === "settings")}`}
    iconClassName={getSidebarNavIconClass(activePanel === "team" || activePanel === "settings")}
    mobile={!desktopRail}
    triggerRef={!desktopRail ? workspaceTriggerRef : undefined}
    onSwitchTeam={!desktopRail ? () => openWorkspaceSwitcher() : undefined}
    onOpenOverview={openSelectedTeam}
    onOpenSettings={activeOrgKey !== "personal" && onOpenOrgSettings ? openSelectedTeamSettings : undefined}
  />;
  const selectedTeamRole = controllerOrgs.find((org) => org.id === activeOrgKey)?.role;
  const canCreateSelectedTeamSpace = activeOrgKey === "personal" || ["owner", "admin", "builder"].includes(selectedTeamRole ?? "");

  const workspaceSwitcherSections = (
    <StudioSidebarWorkspaceSwitcher
      mode={workspaceSwitcherMode}
      orgOptions={orgOptions}
      workspaceOrgKey={workspaceOrgKey}
      activeOrgKey={activeOrgKey}
      pendingOrgKey={pendingOrgSwitchKey}
      projectsError={mergedProjectsError}
      projectsRefreshing={mergedProjectsRefreshing}
      onRetryProjects={retryWorkspaceProjects}
      onWorkspaceOrgChange={handleWorkspaceOrgChange}
      onCreateOrg={
        runtimeControllerEnabled
          ? () => {
              resetWorkspaceSwitcher();
              setNewTeamOpen(true);
            }
          : undefined
      }
      projectAttentionCounts={homeAttentionByProject}
      orgAttentionCounts={homeAttentionByOrg}
      onOpenOrgSettings={
        onOpenOrgSettings && workspaceOrgFilterId
          ? () => {
              resetWorkspaceSwitcher();
              runDestination(() => onOpenOrgSettings(workspaceOrgFilterId));
            }
          : undefined
      }
      canSearchSpaces={canSearchSpaces}
      showProjectSearch={showProjectSearch}
      workspaceProjectSearchOpen={workspaceProjectSearchOpen}
      workspaceProjectQuery={workspaceProjectQuery}
      onWorkspaceProjectQueryChange={setWorkspaceProjectQuery}
      onToggleProjectSearch={handleToggleProjectSearch}
      onCreateProject={
        onStartNewProject
          ? () => {
              resetWorkspaceSwitcher();
              runDestination(() => onStartNewProject(
                selectedWorkspaceOrg?.key && !["personal", "all"].includes(selectedWorkspaceOrg.key)
                  ? selectedWorkspaceOrg.key
                  : null,
              ));
            }
          : undefined
      }
      currentOrgProject={currentOrgProject}
      switcherProjects={switcherProjects}
      onOpenProjectSettings={
        onOpenProjectSettings
          ? () => {
              resetWorkspaceSwitcher();
              runDestination(onOpenProjectSettings);
            }
          : undefined
      }
      onProjectMenuAction={handleProjectMenuAction}
    />
  );

  const accountSection = (
    <StudioSidebarAccountSection
        footerRef={footerRef}
        showLabels={!desktopRail && showLabels}
        collapsedSidebarDensity={desktopRail ? "compact" : collapsedSidebarDensity}
        profileMenuOpen={profileMenuOpen}
        onProfileMenuOpenChange={(open) =>
          setProfileMenuOpen((current) => (open && current ? false : open))
        }
        avatarUrl={avatarUrl}
        initials={initials}
        displayName={displayName}
        accountSubtitle={accountSubtitle}
        resolvedTheme={resolvedTheme}
        onThemeModeChange={setThemeMode}
        installEntry={installEntry}
        isLargeScreen={isLargeScreen}
        shouldRenderUpdateEntry={shouldRenderUpdateEntry}
        updatePresentation={updatePresentation}
        onUpdateEntryClick={handleUpdateEntryClick}
        onUpdateEntryContextMenu={handleUpdateEntryContextMenu}
        onUpdateEntryPointerDown={handleUpdateEntryPointerDown}
        clearUpdateLongPress={clearUpdateLongPress}
        onOpenProfileSettings={onOpenProfileSettings ? () => runDestination(onOpenProfileSettings) : undefined}
        onOpenSupport={onOpenBugReportInbox ? () => runDestination(onOpenBugReportInbox) : undefined}
        supportUnreadCount={supportUnreadCount}
        notificationsPending={notificationsPending}
        notificationsEnabled={notificationsEnabled}
        onToggleNotifications={handleToggleNotifications}
        onOpenDiagnostics={() => setDevMenuOpen(true)}
        hasAppLogErrors={hasAppLogErrors}
        onSignOut={onSignOut}
        updateDialogOpen={updateDialogOpen}
        onUpdateDialogOpenChange={setUpdateDialogOpen}
        updateMetadata={updateMetadata}
        updateDialogShowDetails={updateDialogShowDetails}
        onUpdateDialogShowDetailsChange={setUpdateDialogShowDetails}
        onUpdatePrimaryAction={handleUpdatePrimaryAction}
        updateActionPending={updateActionPending}
      />
  );
  const workspacePanel = (
    <StudioSidebarWorkspacePanel
        open={workspaceSwitcherOpen}
        mode={workspaceSwitcherMode}
        desktop={isLargeScreen}
        portalTarget={workspaceSwitcherPortalTarget}
        triggerRef={workspaceSwitcherMode === "spaces" ? spaceTriggerRef : desktopRail ? browseTriggerRef : workspaceTriggerRef}
        onClose={dismissWorkspaceSwitcher}
      >
        {workspaceSwitcherSections}
      </StudioSidebarWorkspacePanel>
  );

  return (
    <>
      {desktopRail ? <StudioOrganizationRail
        organizations={orgDeckTeams} selectedOrgKey={activeOrgKey}
        pendingOrgKey={mergedProjectsError ? null : pendingOrgSwitchKey}
        homeActive={activePanel === "home"} homeAttentionCount={homeAttentionCount}
        orgAttentionCounts={homeAttentionByOrg} titleBarFree={titleBarFree}
        onHome={() => { resetWorkspaceSwitcher(); closeMoreMenu(); runDestination(() => onSelect("home")); }}
        onSelectOrganization={handleWorkspaceOrgChange}
        onCreateOrganization={runtimeControllerEnabled ? () => { resetWorkspaceSwitcher(); setNewTeamOpen(true); } : undefined}
        onBrowseOrganizations={() => openWorkspaceSwitcher()}
        browseButtonRef={browseTriggerRef} account={accountSection}
      /> : null}
      {showContext ? <nav
        aria-label={desktopRail ? `${activeOrgName} navigation` : "Navigation"}
        data-testid="sidebar-context-navigation"
        ref={navRef}
        // The rail is the full-height column at the very left edge, so on
        // macOS it -- not the workspace header -- is what sits under the
        // traffic lights, and it has to clear them.
        //
        // Two shapes, depending on what the shell supports. On a shell that
        // has vacated the title bar the rail's SURFACE starts on the tab
        // strip's baseline, so the rail's top edge and the tab underline are
        // the same line and the buttons sit on the title bar above it; the
        // surface moves to an inner layer because padding alone would keep
        // painting the background up to y=0. Otherwise the rail keeps its own
        // background and pads by the safe-area inset. The mobile overlay owns
        // both the surface and safe-area padding, so the nav must not add them twice.
        className={[
          widthClass,
          "group relative flex h-full min-h-0 shrink-0 flex-col pb-4 text-slate-600",
          "transition-[width] duration-200 ease-in-out dark:text-slate-300",
          mobileOverlay
            ? "overflow-hidden"
            : titleBarFree
              // Lift every child above the surface layer as a rule, rather than
              // tagging each one: a control added to the rail later would
              // otherwise render behind the background and simply vanish.
              ? "overflow-visible [&>*:not([data-rail-surface])]:relative [&>*:not([data-rail-surface])]:z-[1]"
              : `overflow-hidden border-r border-slate-200/70 bg-slate-50 pt-[var(--instafy-safe-area-inset-top)] ${DARK_RAIL_SURFACE_CLASS}`,
        ]
          .filter(Boolean)
          .join(" ")}
        style={titleBarFree ? { paddingTop: `${DESKTOP_TITLE_BAR_HEIGHT_PX}px` } : undefined}
      >
        {titleBarFree ? (
          <div
            aria-hidden="true"
            data-rail-surface=""
            className={`absolute inset-x-0 bottom-0 z-0 border-r border-slate-200/70 bg-slate-50 ${DARK_RAIL_SURFACE_CLASS}`}
            style={{ top: `${DESKTOP_TITLE_BAR_HEIGHT_PX}px` }}
          />
        ) : null}
        {desktopRail ? <div
          className={`flex min-h-11 shrink-0 items-center gap-1 ${showLabels ? "pr-[7px]" : ""}`}
          data-testid="sidebar-team-header">
          <div className="flex w-[calc(4rem-1px)] shrink-0 items-center justify-center">
            <IconButton variant="ghost" size="sm"
              aria-label={showLabels ? "Collapse sidebar" : "Expand sidebar"}
              title={showLabels ? "Collapse sidebar" : "Expand sidebar"}
              aria-expanded={showLabels}
              data-testid="sidebar-drawer-toggle" onPress={onToggleSidebar}
              isDisabled={!onToggleSidebar} className="shrink-0">
              {showLabels ? <SidebarCollapse className="h-4 w-4" /> : <SidebarExpand className="h-4 w-4" />}
            </IconButton>
          </div>
          {showLabels ? teamMenu : null}
        </div> : null}
        {!desktopRail ? <div
          className={`flex shrink-0 items-center gap-1 px-1 py-1 ${showLabels ? "min-h-14" : "flex-col"}`}
          inert={mobileDrillInOpen || undefined} aria-hidden={mobileDrillInOpen || undefined}
          data-testid="sidebar-team-header">
          <IconButton variant="ghost" size="sm" radius="lg"
            onPress={() => {
              resetWorkspaceSwitcher();
              closeMoreMenu();
              runDestination(() => onSelect("home"));
            }}
            data-testid="sidebar-home-button"
            aria-current={activePanel === "home" ? "page" : undefined}
            aria-label="Home — all teams" title="Home — all teams"
            className="relative !min-h-12 !min-w-12 shrink-0 aria-[current=page]:bg-primary-50 dark:aria-[current=page]:bg-primary-500/10">
            <span aria-hidden="true"><OctoMark className="h-6 w-6 text-brand-ink dark:text-brand-paper" /></span>
            <AttentionBadge count={homeAttentionCount} testId="sidebar-home-badge" aria-hidden
              className="absolute right-0 top-0 ring-2 ring-slate-50 dark:ring-[color:var(--color-studio-dark-rail)]" />
          </IconButton>
          {teamMenu}
          <IconButton variant="ghost" size="sm"
            aria-label={onRequestClose ? "Close navigation" : showLabels ? "Collapse sidebar" : "Expand sidebar"}
            data-testid="sidebar-drawer-toggle" onPress={onRequestClose ?? onToggleSidebar}
            isDisabled={!onRequestClose && !onToggleSidebar} className="!min-h-12 !min-w-12 shrink-0">
            {onRequestClose ? <Xmark className="h-4 w-4" /> : showLabels ? <SidebarCollapse className="h-4 w-4" /> : <SidebarExpand className="h-4 w-4" />}
          </IconButton>
        </div> : null}
        <ul className="min-h-0 flex-1 space-y-1 overflow-y-auto overflow-x-hidden pb-2" data-testid="sidebar-context-scroll"
          inert={mobileDrillInOpen || undefined} aria-hidden={mobileDrillInOpen || undefined}>
          {desktopRail && !showLabels ? <li>{teamMenu}</li> : null}
          <li className="border-t border-slate-200/70 pt-1 dark:border-[color:var(--color-studio-dark-divider)]">
            <StudioRecentSpaces
              key={JSON.stringify([activeTeamUserKey, activeOrgKey, activePanel])}
              spaces={recentSpaceCandidates}
              recency={projectRecency}
              attentionCounts={homeAttentionByProject}
              activeProjectId={selectedTeamHasActiveSpace ? activeProjectId : null}
              onSelectSpace={(id) => {
                if (!recentSpaceCandidates.some((space) => space.id === id)) return;
                resetWorkspaceSwitcher();
                runDestination(() => performProjectSwitch(id));
              }}
              onBrowseAll={() => openWorkspaceSwitcher("spaces")}
              collapsed={!showLabels}
              expanded={recentSpacesExpanded}
              onExpandedChange={setRecentSpacesExpanded}
              rowClassName={`${sidebarRowLayoutClass} ${getSidebarRowToneClass(workspaceSwitcherOpen && workspaceSwitcherMode === "spaces")}`}
              iconClassName={getSidebarNavIconClass(workspaceSwitcherOpen && workspaceSwitcherMode === "spaces")}
              triggerRef={spaceTriggerRef}
            />
          </li>
          {selectedTeamHasActiveSpace ? <>
          {items.map((item) => {
          if (item.id === "chat" && onSelectConversation) {
            return (
              <li key={item.id}>
                <StudioRecentChats
                  key={JSON.stringify([activeTeamUserKey, activeProjectId])}
                  conversations={recentConversations}
                  activeConversationId={activeConversationId}
                  openConversationIds={openConversationIds}
                  onSelectConversation={(id) => runDestination(() => onSelectConversation(id))}
                  onBrowseAll={onOpenConversationHistory ? () => runDestination(onOpenConversationHistory) : undefined}
                  isHistoryActive={isConversationHistoryActive}
                  collapsed={!showLabels}
                  expanded={recentChatsExpanded}
                  onExpandedChange={setRecentChatsExpanded}
                  active={activePanel === "chat" || isConversationHistoryActive}
                  rowClassName={`${sidebarRowLayoutClass} ${getSidebarRowToneClass((!showLabels || !recentChatsExpanded) && (activePanel === "chat" || isConversationHistoryActive))}`}
                  iconClassName={getSidebarNavIconClass(activePanel === "chat" || isConversationHistoryActive)}
                />
              </li>
            );
          }
          const IconComponent = item.icon;
          const isActive =
            item.id === activePanel && !(item.id === "chat" && isConversationHistoryActive);
          const isPinned = pinnedPanel === item.id;
          const badgeCount = item.badge?.count ?? 0;
          const badgeText = badgeCount > 9 ? "9+" : badgeCount.toString();

          return (
            <Fragment key={item.id}>
              <li>
                <Button
                  onPress={() => runDestination(() => onSelect(item.id))}
                  variant="ghost"
                  size="sm"
                  radius="lg"
                  fullWidth
                  data-testid={`sidebar-nav-${item.id}`}
                  className={[
                    "group/item relative py-1.5 transition focus-visible:ring-offset-0",
                    sidebarRowLayoutClass,
                    getSidebarRowToneClass(isActive),
                  ].join(" ")}
                  aria-current={isActive ? "page" : undefined}
                  aria-label={item.label}
                  title={showLabels ? undefined : item.label}
                >
                  <span className={getSidebarNavIconClass(isActive, item.accent)}>
                    <IconComponent className="text-base" aria-hidden="true" />
                    {item.indicator ? (
                      item.indicator.tone === "danger" ? (
                        <span
                          aria-hidden="true"
                          title={item.indicator.label}
                          data-testid={`sidebar-nav-${item.id}-indicator`}
                          className="absolute -right-0.5 -top-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-rose-500 text-3xs font-semibold text-white ring-2 ring-slate-50 dark:ring-[color:var(--color-studio-dark-rail)]"
                        >
                          !
                        </span>
                      ) : (
                        <span
                          aria-hidden="true"
                          title={item.indicator.label}
                          data-testid={`sidebar-nav-${item.id}-indicator`}
                          className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-amber-400 ring-2 ring-slate-50 dark:ring-[color:var(--color-studio-dark-rail)]"
                        />
                      )
                    ) : null}
                    <AttentionBadge
                      count={badgeCount}
                      aria-hidden
                      title={item.badge?.label ?? `${badgeText} changes`}
                      testId={`sidebar-nav-${item.id}-badge`}
                      className="absolute -right-0.5 -top-0.5 ring-2 ring-slate-50 dark:ring-[color:var(--color-studio-dark-rail)]"
                    />
                    {isPinned && !isActive ? (
                      <span
                        aria-hidden="true"
                        className="absolute -bottom-0.5 -right-0.5 h-2 w-2 rounded-full bg-primary-500 ring-2 ring-slate-50 dark:ring-[color:var(--color-studio-dark-rail)]"
                      />
                    ) : null}
                  </span>
                  {showLabels ? (
                    <span className="flex flex-1 items-center justify-between gap-2 text-sm font-medium text-slate-700 dark:text-slate-200">
                      <span>{item.label}</span>
                    </span>
                  ) : null}
                </Button>
              </li>
              {item.id === "chat" && onOpenConversationHistory ? (
                <li>
                  <Button
                    onPress={() => runDestination(onOpenConversationHistory)}
                    variant="ghost"
                    size="sm"
                    radius="lg"
                    fullWidth
                    data-testid="sidebar-nav-history"
                    className={[
                      "group/item relative py-1.5 transition focus-visible:ring-offset-0",
                      sidebarRowLayoutClass,
                      getSidebarRowToneClass(isConversationHistoryActive),
                    ].join(" ")}
                    aria-current={isConversationHistoryActive ? "page" : undefined}
                    aria-label="Open chats"
                    title={showLabels ? undefined : "Open chats"}
                  >
                    <span className={getSidebarNavIconClass(isConversationHistoryActive)}>
                      <ChatsIcon className="text-base" aria-hidden="true" />
                    </span>
                    {showLabels ? (
                      <span className="flex flex-1 items-center justify-between gap-2 text-sm font-medium text-slate-700 dark:text-slate-200">
                        <span>Chats</span>
                      </span>
                    ) : null}
                  </Button>
                </li>
              ) : null}
            </Fragment>
          );
        })}

          <StudioSidebarMorePanels
            triggerRef={moreTriggerRef}
            resolvedMoreItems={resolvedMoreItems}
            showInlineMoreItems={showInlineMoreItems}
            inlineMoreItems={inlineMoreItems}
            collapsedMoreItems={collapsedMoreItems}
            activePanel={activePanel}
            showLabels={showLabels}
            isLargeScreen={isLargeScreen}
            sidebarRowLayoutClass={sidebarRowLayoutClass}
            moreMenuOpen={moreMenuOpen}
            onMoreMenuOpenChange={(open) => {
              setMoreMenuOpen((current) => (open && current ? false : open));
              if (open) {
                setMoreMobileViewOpen(false);
                resetWorkspaceSwitcher();
              }
            }}
            onMobileMoreToggle={() => {
              if (moreMobileViewOpen) {
                closeMoreMenu();
                mobileNavigation?.back();
                return;
              }
              openMoreMenu();
            }}
            onMoreMenuAction={handleMoreMenuAction}
            getSidebarRowToneClass={getSidebarRowToneClass}
            getSidebarNavIconClass={getSidebarNavIconClass}
            isMorePanelActive={isMorePanelActive}
            moreSwitcherOpen={moreSwitcherOpen}
            moreIndicator={moreIndicator}
            selectedMoreKeys={selectedMoreKeys}
          />
          </> : <li className={`${showLabels ? "mx-3" : ""} ${desktopRail ? "pt-2" : "mt-3 pt-3"} border-t border-slate-200/70 dark:border-[color:var(--color-studio-dark-divider)]`} data-testid="sidebar-no-selected-space">
            {showLabels ? <Text as="p" variant="caption" tone="muted">Choose a space in this team to open its tools.</Text> : null}
            {onStartNewProject && canCreateSelectedTeamSpace ? <Button variant="ghost" size="sm" fullWidth={!showLabels}
              className={showLabels ? "mt-1" : `mt-1 ${sidebarRowLayoutClass}`}
              aria-label="New space" title={showLabels ? undefined : "New space"} data-testid="sidebar-new-space"
              onPress={() => runDestination(() => onStartNewProject(activeOrgKey === "personal" ? null : activeOrgKey))}>
              {showLabels ? "New space" : <span className={getSidebarNavIconClass(false)}><Plus className="h-5 w-5" aria-hidden="true" /></span>}
            </Button> : null}
          </li>}
      </ul>

      {!desktopRail ? <div className="shrink-0" data-testid="sidebar-account-navigation"
        inert={mobileDrillInOpen || undefined} aria-hidden={mobileDrillInOpen || undefined}>
        {accountSection}
      </div> : null}
      {!desktopRail ? workspacePanel : null}
      <StudioSidebarMobileDrillIn
        open={!isLargeScreen && moreMobileViewOpen}
        triggerRef={moreTriggerRef}
        testId="sidebar-more-menu"
        title="More"
        backLabel="Back"
        backTestId="sidebar-more-back"
        onBack={() => { closeMoreMenu(); mobileNavigation?.back(); }}
      >
        <ul className="space-y-1" aria-label="More panels">
          {collapsedMoreItems.map((item) => {
            const IconComponent = item.icon;
            const isActive = item.id === activePanel;
            const badgeCount = item.badge?.count ?? 0;
            const badgeText = badgeCount > 9 ? "9+" : badgeCount.toString();
            return (
              <li key={`panel:${item.id}`}>
                <Button
                  onPress={() => handleMoreMenuAction(`panel:${item.id}`)}
                  variant="ghost"
                  size="sm"
                  radius="lg"
                  fullWidth
                  data-testid={`sidebar-more-item-${item.id}`}
                  className={[
                    "group/item relative py-1.5 transition focus-visible:ring-offset-0",
                    EXPANDED_SIDEBAR_ROW_LAYOUT_CLASS,
                    isActive
                      ? EXPANDED_SIDEBAR_BUTTON_ACTIVE_CLASS
                      : EXPANDED_SIDEBAR_BUTTON_INACTIVE_CLASS,
                  ].join(" ")}
                  aria-current={isActive ? "page" : undefined}
                >
                  <span className={getSidebarNavIconClass(isActive, item.accent)}>
                    <IconComponent className="text-base" aria-hidden="true" />
                    {item.indicator ? (
                      item.indicator.tone === "danger" ? (
                        <span
                          aria-hidden="true"
                          title={item.indicator.label}
                          className="absolute -right-0.5 -top-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-rose-500 text-3xs font-semibold text-white ring-2 ring-slate-50 dark:ring-[color:var(--color-studio-dark-rail)]"
                        >
                          !
                        </span>
                      ) : (
                        <span
                          aria-hidden="true"
                          title={item.indicator.label}
                          className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-amber-400 ring-2 ring-slate-50 dark:ring-[color:var(--color-studio-dark-rail)]"
                        />
                      )
                    ) : null}
                    <AttentionBadge
                      count={badgeCount}
                      aria-hidden
                      title={item.badge?.label ?? `${badgeText} updates`}
                      className="absolute -right-0.5 -top-0.5 ring-2 ring-slate-50 dark:ring-[color:var(--color-studio-dark-rail)]"
                    />
                  </span>
                  <span className="flex flex-1 items-center justify-between gap-2 text-sm font-medium text-slate-700 dark:text-slate-200">
                    <span>{item.label}</span>
                  </span>
                </Button>
              </li>
            );
          })}
        </ul>
      </StudioSidebarMobileDrillIn>
      </nav> : null}
      {desktopRail ? workspacePanel : null}
      <StudioDialogModal
        isOpen={devMenuOpen}
        onOpenChange={(open) => setDevMenuOpen(open)}
        isDismissable
        dialogAriaLabel="Diagnostics"
        data-testid="sidebar-dev-diagnostics-modal"
        modalClassName="max-h-[min(90dvh,42rem)] max-w-xl overflow-hidden p-0"
      >
        <DevDiagnosticsMenu
            onClose={() => setDevMenuOpen(false)}
            onShowLogs={onShowLogs}
            hasLogs={hasLogs}
            onShowAppLogs={() => setAppLogsOverlayOpen(true)}
            hasAppLogs={hasAppLogs}
            onShowBugReports={onOpenBugReportInbox}
            onReportBug={onOpenBugReport}
            shakeToReportEnabled={shakeToReportEnabled}
            onToggleShakeToReport={Capacitor.isNativePlatform() ? onToggleShakeToReport : undefined}
            onSimulateShakeToReport={
              Capacitor.isNativePlatform() && onSimulateShakeToReport
                ? () => {
                    setDevMenuOpen(false);
                    onSimulateShakeToReport();
                  }
                : undefined
            }
            onTestShakeToReport={
              Capacitor.isNativePlatform() && onTestShakeToReport
                ? () => {
                    setDevMenuOpen(false);
                    onTestShakeToReport();
                  }
                : undefined
            }
            shakeToReportStatus={shakeToReportStatus}
            shakeToReportDetail={shakeToReportDetail}
            runtimeOptions={runtimeOptions}
            onCopyTunnel={handleCopyTunnel}
          />
      </StudioDialogModal>
      <NewTeamDialog open={newTeamOpen} onClose={() => setNewTeamOpen(false)} onCreated={handleTeamCreated} />
      {appLogsOverlayOpen ? (
        <BuildLogOverlay
          logs={appLogs}
          onClear={clearAppLogs}
          onClose={() => setAppLogsOverlayOpen(false)}
          title="App logs"
          ariaLabel="App logs"
          emptySummary=""
          emptyBody="Warnings, errors, and unhandled exceptions will appear here."
          copyText={appLogExport}
        />
      ) : null}
    </>
  );
}
