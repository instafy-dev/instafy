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
import { DialogTrigger } from "react-aria-components";
import {
  NavArrowDown,
  SidebarCollapse,
  SidebarExpand,
} from "iconoir-react";
import { ChatsIcon, HomeIcon } from "../../../components/AppIcons";
import { AttentionBadge } from "../../../components/AttentionBadge";
import { Button } from "../../../components/Button";
import { Text } from "../../../components/Text";
import { StudioDialogModal } from "../../../components/aria/StudioModal";
import { StudioDialogPopover } from "../../../components/aria/StudioPopover";
import { useStatus } from "../../../status/useStatus";
import { useProfile } from "../../../profile/ProfileProvider";
import { useProjects } from "../../../projects/useProjects";
import { useMergedControllerProjects } from "../../../projects/useMergedControllerProjects";
import { mostRecentProjectId, readProjectRecency } from "../../../projects/projectRecency";
import { useRuntimeMenuOptions } from "../../../runtime/useRuntimeMenu";
import { useTheme } from "../../../theme/ThemeProvider";
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
import { SidebarOrgDeck } from "./SidebarOrgDeck";
import { useAppLogs } from "../../../debug/useAppLogs";
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
import { canOfferDesktopAcquisition } from "../../../updates/desktopAcquisition";
import { DESKTOP_APP_PUBLIC_LATEST_URL } from "../../../updates/desktopReleaseManifest";
import { useAppUpdateMetadata } from "../../../updates/useAppUpdateMetadata";
import { useDesktopReleaseLookup } from "../../../updates/useDesktopReleaseLookup";
import { StudioSidebarAccountSection } from "./StudioSidebarAccountSection";
import { StudioSidebarMobileDrillIn } from "./StudioSidebarMobileDrillIn";
import { StudioSidebarMorePanels } from "./StudioSidebarMorePanels";
import { StudioSidebarWorkspaceSwitcher } from "./StudioSidebarWorkspaceSwitcher";
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
  isConversationHistoryActive?: boolean;
  onRequestClose?: () => void;
}

export function StudioSidebar({
  items,
  moreItems,
  activePanel,
  onSelect,
  collapsed,
  pinnedPanel,
  onOpenConversationHistory,
  isConversationHistoryActive = false,
  onRequestClose,
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
    shakeToReportEnabled = false,
    onToggleShakeToReport,
    onSimulateShakeToReport,
    onTestShakeToReport,
    shakeToReportStatus,
    shakeToReportDetail,
  } = useWorkspaceControls();
  const { projectList, activeProjectId, switchProject, createProject } = useProjects();
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
  const [workspaceMenuOpen, setWorkspaceMenuOpen] = useState(false);
  const [workspaceMobileViewOpen, setWorkspaceMobileViewOpen] = useState(false);
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
  const [orgsRefreshEpoch, setOrgsRefreshEpoch] = useState(0);
  const [moreMenuOpen, setMoreMenuOpen] = useState(false);
  const [moreMobileViewOpen, setMoreMobileViewOpen] = useState(false);
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
  const desktopAcquisitionSurface = canOfferDesktopAcquisition();
  const { lookup: desktopReleaseLookup } = useDesktopReleaseLookup({
    enabled: desktopAcquisitionSurface,
    manifestUrl: DESKTOP_APP_PUBLIC_LATEST_URL,
  });
  const showInstallEntry =
    desktopAcquisitionSurface && desktopReleaseLookup.status === "available";
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
  const fixedEntryCount = 3 + items.length + (onOpenConversationHistory ? 1 : 0);
  const estimatedChromeReservePx = 24;
  const effectiveFooterReservePx = Math.max(estimatedFooterReservePx, footerHeight);
  const desktopSecondaryRowCapacity =
    isLargeScreen
      ? Math.max(
          0,
          Math.floor(
            (navHeight - effectiveFooterReservePx - estimatedChromeReservePx - fixedEntryCount * estimatedRowHeightPx) /
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
        ? isExpanded
          ? resolvedMoreItems
          : []
        : spillableDesktopMoreItems.slice(
            0,
            Math.min(spillableDesktopMoreItems.length, desktopInlineMoreCapacity),
          ),
    [
      desktopInlineMoreCapacity,
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
        ? isExpanded
          ? []
          : resolvedMoreItems
        : resolvedMoreItems.filter((item) => !inlineMoreItemIds.has(item.id)),
    [inlineMoreItemIds, isExpanded, isLargeScreen, resolvedMoreItems],
  );
  const showInlineMoreItems = inlineMoreItems.length > 0;
  const sidebarMobileDrillInOpen = workspaceMobileViewOpen || moreMobileViewOpen;
  const mobileExpandedWidthClass = sidebarMobileDrillInOpen
    ? "w-[clamp(18rem,65vw,24rem)]"
    : "w-[clamp(16rem,60vw,22rem)]";
  // Only true in the macOS shell that vacated its title bar; everywhere
  // else the rail keeps its stock full-height surface.
  const titleBarFree = desktopTitleBarFree();
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
          : "border-transparent text-slate-400 group-hover/item:text-primary-600 dark:text-slate-500 dark:group-hover/item:text-primary-500",
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
  }, [isExpanded, isLargeScreen, items.length, onOpenConversationHistory, resolvedMoreItems.length]);

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
    listControllerOrganizations()
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
  const activeOrgKey = activeProject?.orgId ?? "personal";
  const canBrowseAllWorkspaceOrgs = activeProject?.orgId == null && controllerOrgs.length > 0;
  const workspaceOrgFilterId =
    workspaceOrgKey === "all" || workspaceOrgKey === "personal" ? null : workspaceOrgKey;
  const {
    mergedProjects,
    remoteLoading: mergedProjectsLoading,
    remoteLoadedScope,
  } = useMergedControllerProjects({
    localProjects: projectList,
    orgId: workspaceOrgFilterId,
    includeAllOrgs: workspaceOrgKey === "all",
  });
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
    return getOrgDisplayName(activeProject?.orgName);
  }, [activeOrgKey, activeProject?.orgName, orgOptions]);
  // The org deck (the team & spaces row's icon) shows the selected team on top
  // and reads as a stack when there is more than one; switching happens in the
  // popover it opens. Selection follows the user's CHOICE instantly; the active
  // project catches up once that team's spaces load.
  const orgDeckTeams = useMemo(
    () => orgOptions.filter((org) => org.key !== "all"),
    [orgOptions],
  );
  const orgDeckSelectedKey = workspaceOrgKey === "all" ? activeOrgKey : workspaceOrgKey;
  const orgDeckTeam = useMemo(
    () => orgDeckTeams.find((team) => team.key === orgDeckSelectedKey) ?? orgDeckTeams[0] ?? null,
    [orgDeckSelectedKey, orgDeckTeams],
  );
  const orgDeckOtherAttention = useMemo(
    () =>
      orgDeckTeams.reduce(
        (total, team) =>
          team.key === orgDeckSelectedKey ? total : total + (homeAttentionByOrg[team.key] ?? 0),
        0,
      ),
    [homeAttentionByOrg, orgDeckSelectedKey, orgDeckTeams],
  );
  // Refresh the snapshot after every successful load (never after a failure —
  // a flaky request must not erase teams the user really has).
  useEffect(() => {
    if (!runtimeControllerEnabled || orgsFetchState !== "ready") {
      return;
    }
    writeSidebarOrgSnapshot(userEmail, controllerOrgs, orgDeckTeams.length);
  }, [controllerOrgs, orgDeckTeams.length, orgsFetchState, userEmail]);
  const activeProjectName = activeProject?.name?.trim() || "Untitled space";
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
  // Re-read recency whenever the switcher opens so the ordering reflects this
  // session's switches without subscribing to storage events.
  const projectRecency = useMemo(
    () => readProjectRecency(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [workspaceMenuOpen, workspaceMobileViewOpen],
  );
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

  const handleWorkspaceMenuOpenChange = useCallback(
    (open: boolean) => {
      setWorkspaceMenuOpen((current) => (open && current ? false : open));
      if (open) {
        setMoreMenuOpen(false);
        setMoreMobileViewOpen(false);
        setWorkspaceOrgKey(canBrowseAllWorkspaceOrgs ? "all" : activeOrgKey);
    // A programmatic reset abandons any in-flight team switch — clear the
    // pending markers or the clicked chip pulses forever and the sync effect
    // stays short-circuited by the stale ref.
    pendingOrgContextSwitchRef.current = null;
    setPendingOrgSwitchKey(null);
        setWorkspaceProjectQuery("");
        setWorkspaceProjectSearchOpen(false);
      }
    },
    [activeOrgKey, canBrowseAllWorkspaceOrgs],
  );

  const closeWorkspaceSwitcher = useCallback(() => {
    setWorkspaceMenuOpen(false);
    setWorkspaceMobileViewOpen(false);
    setWorkspaceProjectQuery("");
    setWorkspaceProjectSearchOpen(false);
  }, []);

  const openWorkspaceSwitcher = useCallback(() => {
    setMoreMenuOpen(false);
    setMoreMobileViewOpen(false);
    setWorkspaceOrgKey(canBrowseAllWorkspaceOrgs ? "all" : activeOrgKey);
    // A programmatic reset abandons any in-flight team switch — clear the
    // pending markers or the clicked chip pulses forever and the sync effect
    // stays short-circuited by the stale ref.
    pendingOrgContextSwitchRef.current = null;
    setPendingOrgSwitchKey(null);
    setWorkspaceProjectQuery("");
    setWorkspaceProjectSearchOpen(false);
    if (isLargeScreen) {
      setWorkspaceMenuOpen(true);
      return;
    }
    setWorkspaceMobileViewOpen(true);
  }, [activeOrgKey, canBrowseAllWorkspaceOrgs, isLargeScreen]);

  const pendingOrgContextSwitchRef = useRef<string | null>(null);

  const performProjectSwitch = useCallback(
    (projectId: string) => {
      if (!projectId || projectId === activeProjectId) {
        return;
      }
      if (!projectList.some((project) => project.id === projectId)) {
        const project = mergedProjects.find((entry) => entry.id === projectId);
        createProject({
          projectId,
          projectName: project?.name ?? `Space ${projectId.slice(0, 8)}`,
          orgId: project?.orgId ?? null,
          orgName: project?.orgName ?? null,
        });
      }
      switchProject(projectId);
    },
    [activeProjectId, createProject, mergedProjects, projectList, switchProject],
  );

  const handleWorkspaceOrgChange = useCallback(
    (orgKey: string) => {
      setWorkspaceOrgKey(orgKey);
      setWorkspaceProjectQuery("");
      setWorkspaceProjectSearchOpen(false);
      // Picking a team is a context switch, not just a list filter. The
      // remote project list refetches for the selected org, so the actual
      // switch happens in the effect below once that fetch settles.
      const pending =
        orgKey !== "all" && (activeProject?.orgId ?? "personal") !== orgKey ? orgKey : null;
      pendingOrgContextSwitchRef.current = pending;
      // State mirror of the ref: the clicked chip highlights and pulses
      // immediately, instead of nothing happening until the project list
      // refetch settles seconds later.
      setPendingOrgSwitchKey(pending);
    },
    [activeProject?.orgId],
  );

  useEffect(() => {
    const pendingOrgKey = pendingOrgContextSwitchRef.current;
    if (!pendingOrgKey || pendingOrgKey !== workspaceOrgKey || mergedProjectsLoading) {
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
    // back to name order. A team with no spaces leaves the active space alone
    // (the switcher shows its create-space state instead).
    const orgProjects = mergedProjects.filter(
      (project) => (project.orgId ?? "personal") === pendingOrgKey,
    );
    if (orgProjects.length === 0) {
      showStatus("No spaces in this team yet — create one to get started.", "info", 3500);
      return;
    }
    const targetId =
      mostRecentProjectId(orgProjects.map((project) => project.id)) ??
      [...orgProjects].sort((a, b) =>
        (a.name || "Untitled space").localeCompare(b.name || "Untitled space"),
      )[0].id;
    performProjectSwitch(targetId);
  }, [activeProject?.orgId, mergedProjects, mergedProjectsLoading, performProjectSwitch, remoteLoadedScope, showStatus, workspaceOrgKey]);

  const handleProjectSwitch = useCallback(
    (projectId: string) => {
      closeWorkspaceSwitcher();
      performProjectSwitch(projectId);
      onRequestClose?.();
    },
    [closeWorkspaceSwitcher, onRequestClose, performProjectSwitch],
  );

  const handleProjectMenuAction = useCallback(
    (key: string | number) => {
      const action = String(key);
      if (action === "project:settings") {
        closeWorkspaceSwitcher();
        onOpenProjectSettings?.();
        onRequestClose?.();
        return;
      }
      if (action === "project:new") {
        closeWorkspaceSwitcher();
        onStartNewProject?.();
        onRequestClose?.();
        return;
      }
      if (action.startsWith("project:")) {
        handleProjectSwitch(action.slice("project:".length));
      }
    },
    [
      closeWorkspaceSwitcher,
      handleProjectSwitch,
      onOpenProjectSettings,
      onRequestClose,
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
      onSelect(action.slice("panel:".length) as StudioPanel);
      onRequestClose?.();
    },
    [onRequestClose, onSelect],
  );

  const closeMoreMenu = useCallback(() => {
    setMoreMenuOpen(false);
    setMoreMobileViewOpen(false);
  }, []);

  const openMoreMenu = useCallback(() => {
    closeWorkspaceSwitcher();
    if (isLargeScreen) {
      setMoreMenuOpen(true);
      return;
    }
    setMoreMobileViewOpen(true);
  }, [closeWorkspaceSwitcher, isLargeScreen]);

  useEffect(() => {
    closeWorkspaceSwitcher();
  }, [activeProjectId, closeWorkspaceSwitcher]);

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
      setWorkspaceMobileViewOpen(false);
      setMoreMobileViewOpen(false);
    }
  }, [sidebarOpen]);

  useEffect(() => {
    if (!workspaceMenuOpen) {
      return;
    }

    const handlePointerDown = (event: globalThis.PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) {
        return;
      }

      if (workspaceMenuOpen) {
        const insideWorkspaceTrigger = target.closest('[data-testid="sidebar-project-button"]');
        const insideWorkspaceMenu = target.closest('[data-testid="sidebar-project-switcher-menu"]');
        if (!insideWorkspaceTrigger && !insideWorkspaceMenu) {
          closeWorkspaceSwitcher();
          return;
        }
      }

    };

    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        closeWorkspaceSwitcher();
      }
    };
    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [closeWorkspaceSwitcher, workspaceMenuOpen]);

  useEffect(() => {
    if (isLargeScreen) {
      setWorkspaceMobileViewOpen(false);
      setMoreMobileViewOpen(false);
    } else {
      setWorkspaceMenuOpen(false);
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

  const workspaceSwitcherOpen = workspaceMenuOpen || workspaceMobileViewOpen;
  const moreSwitcherOpen = moreMenuOpen || moreMobileViewOpen;
  const workspaceSwitcherSections = (
    <StudioSidebarWorkspaceSwitcher
      orgOptions={orgOptions}
      workspaceOrgKey={workspaceOrgKey}
      onWorkspaceOrgChange={handleWorkspaceOrgChange}
      projectAttentionCounts={homeAttentionByProject}
      orgAttentionCounts={homeAttentionByOrg}
      onOpenOrgSettings={
        onOpenOrgSettings
          ? () => {
              closeWorkspaceSwitcher();
              onOpenOrgSettings();
              onRequestClose?.();
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
              closeWorkspaceSwitcher();
              onStartNewProject(
                selectedWorkspaceOrg?.key && selectedWorkspaceOrg.key !== "personal"
                  ? selectedWorkspaceOrg.key
                  : null,
              );
              onRequestClose?.();
            }
          : undefined
      }
      currentOrgProject={currentOrgProject}
      switcherProjects={switcherProjects}
      onOpenProjectSettings={
        onOpenProjectSettings
          ? () => {
              closeWorkspaceSwitcher();
              onOpenProjectSettings();
              onRequestClose?.();
            }
          : undefined
      }
      onProjectMenuAction={handleProjectMenuAction}
    />
  );

  return (
    <>
      <nav
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
        // background and merely pads by the safe-area inset -- which is also
        // what every non-macOS target does, since the variable is 0 there.
        className={[
          widthClass,
          "group relative flex h-full min-h-0 shrink-0 flex-col pb-4 text-slate-600",
          "transition-[width] duration-200 ease-in-out dark:text-slate-300",
          titleBarFree
            // Lift every child above the surface layer as a rule, rather than
            // tagging each one: a control added to the rail later would
            // otherwise render behind the background and simply vanish.
            ? "overflow-visible [&>*:not([data-rail-surface])]:relative [&>*:not([data-rail-surface])]:z-[1]"
            : "overflow-hidden border-r border-slate-200/70 bg-slate-50/80 pt-[var(--instafy-safe-area-inset-top)] dark:border-[color:var(--color-studio-dark-divider)] dark:bg-[var(--color-studio-dark-rail)]",
        ]
          .filter(Boolean)
          .join(" ")}
        style={titleBarFree ? { paddingTop: `${DESKTOP_TITLE_BAR_HEIGHT_PX}px` } : undefined}
      >
        {titleBarFree ? (
          <div
            aria-hidden="true"
            data-rail-surface=""
            className="absolute inset-x-0 bottom-0 z-0 border-r border-slate-200/70 bg-slate-50/80 dark:border-[color:var(--color-studio-dark-divider)] dark:bg-[var(--color-studio-dark-rail)]"
            style={{ top: `${DESKTOP_TITLE_BAR_HEIGHT_PX}px` }}
          />
        ) : null}
        <ul className="min-h-0 flex-1 space-y-1 overflow-y-auto overflow-x-hidden pb-2">
          <li className={showLabels ? "" : "flex justify-center"}>
            <Button
              variant="ghost"
              size="sm"
              radius="lg"
              fullWidth
              onPress={onToggleSidebar}
              aria-label={sidebarOpen ? "Collapse sidebar" : "Expand sidebar"}
              data-testid="sidebar-drawer-toggle"
              className={[
                "group/item relative py-1.5 transition focus-visible:ring-offset-0",
                sidebarRowLayoutClass,
                getSidebarRowToneClass(false),
              ].join(" ")}
              isDisabled={!onToggleSidebar}
            >
              <span
                className={
                  `relative flex ${sidebarIconShellSizeClass} items-center justify-center rounded-lg border border-transparent text-slate-400 transition-colors group-hover/item:text-primary-600 dark:text-slate-500 dark:group-hover/item:text-primary-500`
                }
              >
                {sidebarOpen ? (
                  <SidebarCollapse className="text-base" aria-hidden="true" />
                ) : (
                  <SidebarExpand className="text-base" aria-hidden="true" />
                )}
              </span>
              {showLabels ? (
                <span className="flex flex-1 items-center justify-between gap-2 text-sm font-medium text-slate-700 dark:text-slate-200">
                  <span>{sidebarOpen ? "Collapse" : "Expand"}</span>
                </span>
              ) : null}
            </Button>
          </li>

          <li>
            <Button
              onPress={() => {
                closeWorkspaceSwitcher();
                closeMoreMenu();
                onSelect("home");
                onRequestClose?.();
              }}
              variant="ghost"
              size="sm"
              radius="lg"
              fullWidth
              data-testid="sidebar-home-button"
              className={[
                "group/item relative py-1.5 transition focus-visible:ring-offset-0",
                sidebarRowLayoutClass,
                getSidebarRowToneClass(activePanel === "home"),
              ].join(" ")}
              aria-current={activePanel === "home" ? "page" : undefined}
              aria-label="Open home"
            >
              <span className={getSidebarNavIconClass(activePanel === "home")}>
                <HomeIcon className="h-6 w-6" />
                <AttentionBadge
                  count={homeAttentionCount}
                  testId="sidebar-home-badge"
                  aria-hidden
                  className="absolute right-[1px] top-[1px] ring-2 ring-slate-50 dark:ring-[color:var(--color-studio-dark-rail)]"
                />
              </span>
              {showLabels ? (
                <span className="flex flex-1 items-center gap-2 text-sm font-medium text-slate-700 dark:text-slate-200">
                  <span>Home</span>
                </span>
              ) : null}
            </Button>
          </li>

          <li>
            {isLargeScreen ? (
              <DialogTrigger
                isOpen={workspaceMenuOpen}
                onOpenChange={handleWorkspaceMenuOpenChange}
              >
                <Button
                  variant="ghost"
                  size="sm"
                  radius="lg"
                  fullWidth
                  data-testid="sidebar-project-button"
                  aria-haspopup="dialog"
                  className={[
                    "group/item relative py-1.5 transition focus-visible:ring-offset-0",
                    sidebarRowLayoutClass,
                    getSidebarRowToneClass(workspaceSwitcherOpen),
                  ].join(" ")}
                  aria-label="Open team and spaces"
                >
                  <span
                    className={[
                      `relative flex ${sidebarIconShellSizeClass} shrink-0 items-center justify-center rounded-lg transition-transform active:scale-95`,
                      workspaceSwitcherOpen ? "ring-2 ring-primary-400/60 ring-offset-1 ring-offset-slate-50 dark:ring-offset-[color:var(--color-studio-dark-rail)]" : "",
                    ]
                      .filter(Boolean)
                      .join(" ")}
                  >
                    <SidebarOrgDeck
                      team={orgDeckTeam}
                      teamCount={orgDeckTeams.length}
                      otherAttentionCount={orgDeckOtherAttention}
                      pending={pendingOrgSwitchKey !== null}
                    />
                  </span>
                  {showLabels ? (
                    <span className="flex min-w-0 flex-1 items-center justify-between gap-2 text-left">
                      <span className="min-w-0 flex-1">
                        <Text as="span" variant="bodyStrong" tone="primary" className="block truncate text-sm">
                          {activeProjectName}
                        </Text>
                        <Text as="span" variant="caption" tone="muted" className="block truncate">
                          {activeOrgName}
                        </Text>
                      </span>
                      <NavArrowDown className="text-base text-slate-400" aria-hidden="true" />
                    </span>
                  ) : null}
                </Button>
                <StudioDialogPopover
                  placement="right top"
                  offset={8}
                  className="w-80 p-3 text-sm"
                  data-testid="sidebar-project-switcher-menu"
                >
                  {workspaceSwitcherSections}
                </StudioDialogPopover>
              </DialogTrigger>
            ) : (
              <Button
                variant="ghost"
                size="sm"
                radius="lg"
                fullWidth
                data-testid="sidebar-project-button"
                aria-haspopup="dialog"
                onPress={() => {
                  if (workspaceMobileViewOpen) {
                    closeWorkspaceSwitcher();
                    return;
                  }
                  openWorkspaceSwitcher();
                }}
                className={[
                  "group/item relative py-1.5 transition focus-visible:ring-offset-0",
                  sidebarRowLayoutClass,
                  getSidebarRowToneClass(workspaceSwitcherOpen),
                ].join(" ")}
                aria-label="Open team and spaces"
              >
                <span
                  className={[
                    `relative flex ${sidebarIconShellSizeClass} shrink-0 items-center justify-center rounded-lg transition-transform active:scale-95`,
                    workspaceSwitcherOpen ? "ring-2 ring-primary-400/60 ring-offset-1 ring-offset-slate-50 dark:ring-offset-[color:var(--color-studio-dark-rail)]" : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                >
                  <SidebarOrgDeck
                    team={orgDeckTeam}
                    teamCount={orgDeckTeams.length}
                    otherAttentionCount={orgDeckOtherAttention}
                    pending={pendingOrgSwitchKey !== null}
                  />
                </span>
                {showLabels ? (
                  <span className="flex min-w-0 flex-1 items-center justify-between gap-2 text-left">
                    <span className="min-w-0 flex-1">
                      <Text as="span" variant="bodyStrong" tone="primary" className="block truncate text-sm">
                        {activeProjectName}
                      </Text>
                      <Text as="span" variant="caption" tone="muted" className="block truncate">
                        {activeOrgName}
                      </Text>
                    </span>
                    <NavArrowDown className="text-base text-slate-400" aria-hidden="true" />
                  </span>
                ) : null}
              </Button>
            )}
          </li>

          {items.map((item) => {
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
                  onPress={() => onSelect(item.id)}
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
                    onPress={onOpenConversationHistory}
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
                setWorkspaceMenuOpen(false);
              }
            }}
            onMobileMoreToggle={() => {
              if (moreMobileViewOpen) {
                closeMoreMenu();
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
      </ul>

      <StudioSidebarAccountSection
        footerRef={footerRef}
        showLabels={showLabels}
        collapsedSidebarDensity={collapsedSidebarDensity}
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
        showInstallEntry={showInstallEntry}
        shouldRenderUpdateEntry={shouldRenderUpdateEntry}
        updatePresentation={updatePresentation}
        onUpdateEntryClick={handleUpdateEntryClick}
        onUpdateEntryContextMenu={handleUpdateEntryContextMenu}
        onUpdateEntryPointerDown={handleUpdateEntryPointerDown}
        clearUpdateLongPress={clearUpdateLongPress}
        onOpenProfileSettings={onOpenProfileSettings}
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
      <StudioSidebarMobileDrillIn
        open={!isLargeScreen && workspaceMobileViewOpen}
        testId="sidebar-project-switcher-menu"
        title="Space switcher"
        backLabel="Back"
        backTestId="sidebar-project-switcher-back"
        onBack={closeWorkspaceSwitcher}
      >
        {workspaceSwitcherSections}
      </StudioSidebarMobileDrillIn>
      <StudioSidebarMobileDrillIn
        open={!isLargeScreen && moreMobileViewOpen}
        testId="sidebar-more-menu"
        title="More"
        backLabel="Back"
        backTestId="sidebar-more-back"
        onBack={closeMoreMenu}
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
      </nav>
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
