import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { DESKTOP_TITLE_BAR_HEIGHT_PX, desktopTitleBarFree } from "../../../lib/desktopShell";
import {
  SidebarCollapse,
  SidebarExpand,
  Plus,
} from "iconoir-react";
import { ChatsIcon } from "../../../components/AppIcons";
import { OctoMark } from "../../../components/OctoMark";
import { AttentionBadge } from "../../../components/AttentionBadge";
import { Button, IconButton } from "../../../components/Button";
import { Text } from "../../../components/Text";

import { NewTeamDialog } from "./NewTeamDialog";
import { StudioNewChatButton } from "./StudioNewChatButton";
import { useStatus } from "../../../status/useStatus";
import { useStudioNavigation } from "../../../navigation/useStudioNavigation";
import { studioPerformance } from "../../../telemetry/studioPerformance";
import { useProjects } from "../../../projects/useProjects";
import { useMergedControllerProjects } from "../../../projects/useMergedControllerProjects";
import { mostRecentProjectId } from "../../../projects/projectRecency";
import { useProjectRecency } from "../../../projects/useProjectRecency";
import { DARK_RAIL_SURFACE_CLASS } from "../../../theme/darkSurfaces";
import { useWorkspaceControls } from "../workspaceControls";
import type { StudioNavItem, StudioPanel } from "../types";
import { useStudioDesktopLayout } from "../useStudioDesktopLayout";
import { useTouchLikeInput } from "../../../hooks/useTouchLikeInput";
import { getOrgDisambiguator, getOrgDisplayName } from "../../../org/orgNaming";
import type { MobileSidebarNavigation } from "../../useMobileSidebarHistory";
import {
  controllerClient,
  runtimeControllerEnabled,
  type ControllerOrgSummary,
} from "../../../sdk/instafy";
const { list: listControllerOrganizations } = controllerClient.organizations;
import { StudioAccountMenu } from "./StudioAccountMenu";
import { StudioSidebarMobileDrillIn } from "./StudioSidebarMobileDrillIn";
import { StudioSidebarMorePanels } from "./StudioSidebarMorePanels";
import type { StudioNavigationContext } from "./StudioSearchContext";
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
  /** Scope for directory entry points owned by the surrounding mobile header. */
  workspaceSwitcherInitialMode?: "teams-and-spaces" | "spaces";
  onWorkspaceSwitcherOpenChange: (open: boolean) => void;
  workspaceSwitcherPortalTarget: HTMLDivElement | null;
  onRequestClose?: () => void;
  mobileOverlay?: boolean;
  selectedOrgKey?: string;
  onOpenTeam?: (orgKey: string) => void;
  onReturnToTeam?: (orgKey: string) => void;
  onActiveTeamChange?: (team: { key: string; name: string; avatarUrl: string | null; accentColor?: string | null }) => void;
  onActivateProject?: (projectId: string, orgKey: string) => void;
  hideContext?: boolean;
  mobileNavigation?: MobileSidebarNavigation;
  runSidebarAction?: (action: () => void) => void;
  /** Compact context pickers can live above the independent navigation rail. */
  navigationPresentation?: "tiles" | "path";
  navigationHeaderPortalTarget?: HTMLElement | null;
  /** The surrounding shell provides the team and space context header. */
  navigationHeaderExternal?: boolean;
  compactContextHeader?: boolean;
  renderNavigationHeader?: (context: StudioNavigationContext) => ReactNode;
  onNavigationHeaderAction?: () => void;
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
  workspaceSwitcherInitialMode = "teams-and-spaces",
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
  navigationPresentation = "tiles",
  navigationHeaderPortalTarget = null,
  navigationHeaderExternal = false,
  compactContextHeader = false,
  renderNavigationHeader,
  onNavigationHeaderAction,
}: StudioSidebarProps) {
  const {
    userEmail,
    homeAttentionCount = 0,
    homeAttentionByProject = {},
    homeAttentionByOrg = {},
    onToggleSidebar,
    sidebarOpen,
    onStartNewProject,
    onStartNewConversation,
    showChatActions = false,
    navigationPage = "workspace",
    onOpenProjectSettings,
    onOpenProfileSettings,
    onOpenOrgSettings,
    onOpenBugReportInbox,
  } = useWorkspaceControls();
  const { projectList, activeProjectId } = useProjects();
  const navigateToDestination = useStudioNavigation();
  const { showStatus } = useStatus();
  const workspaceTriggerRef = useRef<HTMLButtonElement | null>(null);
  const workspaceSwitcherSourceRef = useRef<"rail" | "team">("rail");
  const browseTriggerRef = useRef<HTMLButtonElement | null>(null);
  const spaceTriggerRef = useRef<HTMLButtonElement | null>(null);
  const moreTriggerRef = useRef<HTMLButtonElement | null>(null);
  const [workspaceSwitcherMode, setWorkspaceSwitcherMode] = useState(workspaceSwitcherInitialMode);
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
  const navRef = useRef<HTMLElement | null>(null);
  const footerRef = useRef<HTMLDivElement | null>(null);
  const [navHeight, setNavHeight] = useState(0);
  const [footerHeight, setFooterHeight] = useState(0);
  const isLargeScreen = useStudioDesktopLayout();
  const touchLikeInput = useTouchLikeInput();
  const desktopRail = isLargeScreen && !mobileOverlay;
  const externalHeader = navigationHeaderExternal || Boolean(navigationHeaderPortalTarget);
  const showContext = !desktopRail || (activePanel !== "home" && !hideContext);
  const workspaceSwitcherOpen = isLargeScreen
    ? desktopWorkspaceSwitcherOpen
    : mobileNavigation ? mobileNavigation.view === "workspace" : desktopWorkspaceSwitcherOpen || localWorkspaceMobileViewOpen;
  const mobileDrillInOpen = !isLargeScreen && (workspaceSwitcherOpen || moreMobileViewOpen);
  useEffect(() => {
    if (!workspaceSwitcherOpen) return;
    // Internal picker actions override the scope supplied by an external header.
    setWorkspaceSwitcherMode(requestedSwitcherModeRef.current ?? workspaceSwitcherInitialMode);
    requestedSwitcherModeRef.current = null;
  }, [workspaceSwitcherOpen, workspaceSwitcherInitialMode]);
  const isExpanded = !collapsed;
  const showLabels = isExpanded;
  const pathHeader = !externalHeader && navigationPresentation === "path" && showLabels;
  const pathControls = externalHeader || pathHeader;
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
  const hasRecentChats = Boolean(onSelectConversation);
  // External context already contains the space selector. Only compact
  // desktop navigation needs a second row for New chat below its toggle.
  const desktopHeaderRows = externalHeader ? showLabels ? 1 : 2 : pathHeader ? 1 : showLabels ? 2 : 3;
  const mobileHeaderRows = showLabels ? pathControls ? 1 : 2 : 4;
  const fixedEntryCount = (desktopRail ? desktopHeaderRows : mobileHeaderRows) + items.length + (onOpenConversationHistory && !hasRecentChats ? 1 : 0);
  const recentChatsReservePx = hasRecentChats && showLabels && recentChatsExpanded
    ? Math.max(1, Math.min(recentConversations.length, SIDEBAR_RECENT_CHAT_LIMIT)) * 40 + 56
    : 0;
  // Reserve the bounded two-row space grid before placing secondary tools.
  const recentSpacesReservePx = showLabels && !pathControls && recentSpacesExpanded
    ? Math.ceil(SIDEBAR_RECENT_SPACE_LIMIT / 3) * 96 + 48
    : 0;
  const estimatedChromeReservePx = 24;
  const effectiveFooterReservePx = desktopRail ? 0 : footerHeight || estimatedFooterReservePx;
  const secondaryRowCapacity =
    isLargeScreen || isExpanded
      ? Math.max(
          0,
          Math.floor(
            (navHeight - effectiveFooterReservePx - estimatedChromeReservePx - recentChatsReservePx - recentSpacesReservePx - fixedEntryCount * estimatedRowHeightPx) /
              estimatedRowHeightPx,
          ),
        )
      : 0;
  const needsMoreButton = resolvedMoreItems.length > secondaryRowCapacity;
  const measuredInlineMoreCapacity = Math.max(0, secondaryRowCapacity - (needsMoreButton ? 1 : 0));
  const moreViewOpen = isLargeScreen ? moreMenuOpen : moreMobileViewOpen;
  const moreAllocationRef = useRef({ capacity: 0, open: false, overflowIds: [] as StudioPanel[] });
  // Keep an open menu/drill-in stable until dismissal, even if every tool now fits.
  const inlineMoreCapacity = moreViewOpen
    ? moreAllocationRef.current.capacity
    : measuredInlineMoreCapacity;
  const inlineMoreItems = useMemo(
    () => resolvedMoreItems.slice(0, inlineMoreCapacity),
    [inlineMoreCapacity, resolvedMoreItems],
  );
  const inlineMoreItemIds = useMemo(() => new Set(inlineMoreItems.map((item) => item.id)), [inlineMoreItems]);
  const collapsedMoreItems = useMemo(
    () => resolvedMoreItems.filter((item) => !inlineMoreItemIds.has(item.id)),
    [inlineMoreItemIds, resolvedMoreItems],
  );
  const showInlineMoreItems = inlineMoreItems.length > 0;
  const sidebarMobileDrillInOpen = workspaceSwitcherOpen || moreMobileViewOpen;
  const mobileExpandedWidthClass = externalHeader
    ? "w-[min(22rem,calc(100vw-2rem))]"
    : sidebarMobileDrillInOpen
    ? "w-[clamp(18rem,65vw,24rem)]"
    : pathControls ? "w-[min(22rem,calc(100vw-2rem))]" : "w-[clamp(16rem,60vw,22rem)]";
  // Only true in the macOS shell that vacated its title bar; everywhere
  // else the rail keeps its stock full-height surface.
  const titleBarFree = !mobileOverlay && desktopTitleBarFree();
  const widthClass = isExpanded
    ? isLargeScreen
      ? externalHeader ? "w-[var(--studio-context-column-width,14rem)]" : pathHeader && touchLikeInput ? "w-60" : "w-56"
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
  }, [isExpanded, isLargeScreen]);

  useEffect(() => {
    const previous = moreAllocationRef.current;
    moreAllocationRef.current = {
      capacity: inlineMoreCapacity,
      open: moreViewOpen,
      overflowIds: collapsedMoreItems.map((item) => item.id),
    };
    if (!previous.open || moreViewOpen || collapsedMoreItems.length > 0) return;
    // After dismissal on a taller screen, More may have become inline tools.
    // Restore focus to the first of those tools instead of a removed trigger.
    const frame = requestAnimationFrame(() => {
      const nav = navRef.current;
      const focused = document.activeElement;
      if (!nav || nav.closest("[inert]") || (focused !== document.body && !nav.contains(focused))) return;
      for (const id of previous.overflowIds) {
        const target = nav.querySelector<HTMLButtonElement>(`[data-testid="sidebar-more-item-${id}"]`);
        if (target) {
          target.focus();
          break;
        }
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [collapsedMoreItems, inlineMoreCapacity, moreViewOpen]);
  useEffect(() => {
    if (collapsedMoreItems.length > 0) {
      return;
    }
    setMoreMenuOpen(false);
    setMoreMobileViewOpen(false);
  }, [collapsedMoreItems.length]);

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
    const map = new Map<string, { name: string; slug: string | null; avatarUrl: string | null; accentColor?: string | null }>();
    controllerOrgs.forEach((org) => {
      map.set(org.id, {
        name: getOrgDisplayName(org.name),
        slug: org.slug ?? null,
        avatarUrl: org.avatarUrl ?? null,
        accentColor: org.accentColor ?? null,
      });
    });
    return map;
  }, [controllerOrgs]);
  const orgOptions = useMemo(() => {
    const options = new Map<
      string,
      { key: string; name: string; label: string; slug: string | null; count: number; avatarUrl: string | null; accentColor?: string | null }
    >();

    controllerOrgs.forEach((org) => {
      options.set(org.id, {
        key: org.id,
        name: getOrgDisplayName(org.name),
        label: getOrgDisplayName(org.name),
        slug: org.slug ?? null,
        count: 0,
        avatarUrl: org.avatarUrl ?? null,
        accentColor: org.accentColor ?? null,
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
          accentColor: controllerInfo?.accentColor ?? null,
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
  const activeOrgAccentColor = orgOptions.find((org) => org.key === activeOrgKey)?.accentColor ?? null;
  const activeTeamUserKey = normalizeSidebarOrgUser(userEmail);
  const activeTeamMetadataReady = hydratedOrgUserRef.current === activeTeamUserKey;
  const publishedActiveTeamRef = useRef<{ user: string | null; key: string; name: string; avatarUrl: string | null; accentColor?: string | null } | null>(null);
  useEffect(() => {
    // Account changes hydrate their own org snapshot in the effect above. Do
    // not publish this render's previous-account metadata as the new user.
    if (!activeTeamMetadataReady) return;
    const previous = publishedActiveTeamRef.current;
    if (previous?.user === activeTeamUserKey && previous.key === activeOrgKey && previous.name === activeOrgName && previous.avatarUrl === activeOrgAvatarUrl && previous.accentColor === activeOrgAccentColor) return;
    const team = { key: activeOrgKey, name: activeOrgName, avatarUrl: activeOrgAvatarUrl, accentColor: activeOrgAccentColor };
    publishedActiveTeamRef.current = { user: activeTeamUserKey, ...team };
    onActiveTeamChange?.(team);
  }, [activeOrgKey, activeOrgName, activeOrgAvatarUrl, activeOrgAccentColor, activeTeamMetadataReady, activeTeamUserKey, onActiveTeamChange]);
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
      .map((project) => ({ id: project.id, name: project.name, icon: project.projectIcon, color: project.projectColor, avatarUrl: project.projectAvatarUrl }))
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

  const openWorkspaceSwitcher = useCallback((mode: "teams-and-spaces" | "spaces" = "teams-and-spaces", source: "rail" | "team" = "rail") => {
    workspaceSwitcherSourceRef.current = source;
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
    setWorkspaceOrgKey(workspaceSwitcherMode === "spaces" ? activeOrgKey : canBrowseAllWorkspaceOrgs ? "all" : activeOrgKey);
    // A programmatic reset abandons any in-flight team switch — clear the
    // pending markers or the clicked chip pulses forever and the sync effect
    // stays short-circuited by the stale ref.
    pendingOrgContextSwitchRef.current = null;
    setPendingOrgSwitchKey(null);
  }, [activeOrgKey, canBrowseAllWorkspaceOrgs, workspaceSwitcherMode]);

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

  const openTeamOverview = (orgKey: string) => {
    onNavigationHeaderAction?.();
    resetWorkspaceSwitcher();
    closeMoreMenu();
    runDestination(() => {
      if (onOpenTeam) onOpenTeam(orgKey);
      else onSelect("team");
    });
  };
  const openSelectedTeam = () => openTeamOverview(activeOrgKey);
  const openTeamSettings = (orgKey: string, category?: "profile" | "members") => {
    onNavigationHeaderAction?.();
    resetWorkspaceSwitcher();
    closeMoreMenu();
    runDestination(() => category ? onOpenOrgSettings?.(orgKey, category) : onOpenOrgSettings?.(orgKey));
  };
  const openSelectedTeamSettings = () => openTeamSettings(activeOrgKey);
  const canStartHeaderChat = externalHeader && showChatActions && selectedTeamHasActiveSpace &&
    Boolean(onStartNewConversation) && activePanel !== "home" && !hideContext &&
    navigationPage !== "home";
  const runHeaderChatAction = (action: () => void) => {
    if (!canStartHeaderChat || !onStartNewConversation) return;
    resetWorkspaceSwitcher();
    closeMoreMenu();
    runDestination(action);
  };
  const headerNewChat = canStartHeaderChat ? <StudioNewChatButton
    testId="sidebar-new-chat" size="sm" radius="lg"
    label={desktopRail && !showLabels ? undefined : "New chat"}
    isDisabled={mobileDrillInOpen}
    dismissalKey={JSON.stringify([activeOrgKey, activeProjectId, activePanel, navigationPage, mobileDrillInOpen])}
    runAction={runHeaderChatAction}
    className={desktopRail && !showLabels
      ? "!h-11 !w-11 !min-h-11 !min-w-11 shrink-0"
      : "!h-11 !w-auto !min-h-11 min-w-0 flex-1 justify-start gap-2 px-3"}
  /> : null;
  // A selected-team/account/page change discards any open menu, including
  // changes that retain the same loaded project behind a global panel.
  const teamMenu = <StudioSidebarTeamMenu
    key={JSON.stringify([activeTeamUserKey, activeOrgKey, activeProjectId, activePanel, desktopRail, externalHeader || showLabels, navigationPresentation, externalHeader])}
    teamName={activeOrgName} teamAvatarUrl={activeOrgAvatarUrl} accentColor={activeOrgAccentColor}
    presentation={pathControls && (compactContextHeader || !externalHeader || !desktopRail) ? "path" : "standard"} compact={!externalHeader && !showLabels}
    active={activePanel === "team" || activePanel === "settings"}
    rowClassName={`${sidebarRowLayoutClass} ${getSidebarRowToneClass(activePanel === "team" || activePanel === "settings")}`}
    iconClassName={getSidebarNavIconClass(activePanel === "team" || activePanel === "settings")}
    mobile={!desktopRail}
    touchTargets={pathControls && touchLikeInput}
    triggerRef={externalHeader || !desktopRail || navigationPresentation === "path" ? workspaceTriggerRef : undefined}
    onSwitchTeam={externalHeader || !desktopRail || pathHeader ? () => { onNavigationHeaderAction?.(); openWorkspaceSwitcher("teams-and-spaces", "team"); } : undefined}
    onOpenOverview={openSelectedTeam}
    onOpenSettings={activeOrgKey !== "personal" && onOpenOrgSettings ? openSelectedTeamSettings : undefined}
  />;
  const spaceControl = (
    <StudioRecentSpaces
      key={JSON.stringify([activeTeamUserKey, activeOrgKey, activePanel, navigationPresentation, externalHeader])}
      spaces={recentSpaceCandidates}
      recency={projectRecency}
      attentionCounts={homeAttentionByProject}
      activeProjectId={selectedTeamHasActiveSpace ? activeProjectId : null}
      onSelectSpace={(id) => {
        if (!recentSpaceCandidates.some((space) => space.id === id)) return;
        onNavigationHeaderAction?.();
        resetWorkspaceSwitcher();
        runDestination(() => performProjectSwitch(id));
      }}
      onBrowseAll={() => { onNavigationHeaderAction?.(); openWorkspaceSwitcher("spaces"); }}
      presentation={pathControls ? "path" : "inline"}
      collapsed={!externalHeader && !showLabels}
      expanded={recentSpacesExpanded}
      onExpandedChange={setRecentSpacesExpanded}
      rowClassName={pathControls ? `gap-1 !px-1 ${desktopRail ? "min-h-9" : "!min-h-12"}` : `${sidebarRowLayoutClass} ${getSidebarRowToneClass(workspaceSwitcherOpen && workspaceSwitcherMode === "spaces")}`}
      iconClassName={pathControls ? "flex h-5 w-5 shrink-0 items-center justify-center" : getSidebarNavIconClass(workspaceSwitcherOpen && workspaceSwitcherMode === "spaces")}
      triggerRef={spaceTriggerRef}
    />
  );
  const navigationPath = <div
    className="sidebar-navigation-path flex min-w-0 flex-1 items-center gap-0.5"
    role="group" aria-label="Team and space" data-testid="sidebar-navigation-path"
    inert={externalHeader && mobileDrillInOpen || undefined} aria-hidden={externalHeader && mobileDrillInOpen || undefined}>
    <div className={`sidebar-path-team flex ${externalHeader && desktopRail ? "min-w-0 max-w-64" : "shrink-0"}`}>{teamMenu}</div>
    <span aria-hidden="true" className="pointer-events-none shrink-0 text-sm text-slate-400 dark:text-slate-500">/</span>
    <div className="sidebar-path-space flex min-w-0 flex-1">{spaceControl}</div>
  </div>;
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
    <StudioAccountMenu
      footerRef={footerRef}
      showLabels={!desktopRail && showLabels}
      collapsedSidebarDensity={desktopRail ? "compact" : collapsedSidebarDensity}
      onProfile={onOpenProfileSettings ? () => runDestination(onOpenProfileSettings) : undefined}
      onSupport={onOpenBugReportInbox ? () => runDestination(onOpenBugReportInbox) : undefined}
    />
  );
  const workspacePanel = (
    <StudioSidebarWorkspacePanel
        open={workspaceSwitcherOpen}
        mode={workspaceSwitcherMode}
        desktop={isLargeScreen}
        portalTarget={workspaceSwitcherPortalTarget}
        triggerRef={workspaceSwitcherMode === "spaces" ? spaceTriggerRef : !desktopRail || workspaceSwitcherSourceRef.current === "team" ? workspaceTriggerRef : browseTriggerRef}
        onClose={dismissWorkspaceSwitcher}
      >
        {workspaceSwitcherSections}
      </StudioSidebarWorkspacePanel>
  );

  return (
    <>
      {navigationHeaderPortalTarget ? createPortal(renderNavigationHeader ? renderNavigationHeader({ team: teamMenu, space: spaceControl, teamName: activeOrgName, accentColor: activeOrgAccentColor, onBrowseTeams: () => { onNavigationHeaderAction?.(); openWorkspaceSwitcher(); } }) : navigationPath, navigationHeaderPortalTarget) : null}
      {desktopRail ? <StudioOrganizationRail
        organizations={orgDeckTeams} selectedOrgKey={activeOrgKey}
        pendingOrgKey={mergedProjectsError ? null : pendingOrgSwitchKey}
        homeActive={activePanel === "home"} homeAttentionCount={homeAttentionCount}
        orgAttentionCounts={homeAttentionByOrg} titleBarFree={titleBarFree}
        onHome={() => { resetWorkspaceSwitcher(); closeMoreMenu(); runDestination(() => onSelect("home")); }}
        onSelectOrganization={handleWorkspaceOrgChange}
        onOpenOrganizationOverview={onOpenTeam ? openTeamOverview : undefined}
        onOpenOrganizationSettings={onOpenOrgSettings ? openTeamSettings : undefined}
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
        style={titleBarFree && !externalHeader ? { paddingTop: `${DESKTOP_TITLE_BAR_HEIGHT_PX}px` } : undefined}
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
          className={`${externalHeader ? "h-12 min-h-12 border-b border-transparent" : "min-h-11"} shrink-0 ${pathHeader ? "gap-x-0 flex items-center border-b border-slate-200/70 dark:border-[color:var(--color-studio-dark-divider)]" : "gap-x-1 flex items-center"} ${showLabels ? pathHeader ? "pr-px" : "pr-[7px]" : ""}`}
          data-testid="sidebar-team-header">
          <div className={`flex w-[calc(4rem-1px)] shrink-0 items-center justify-center ${pathHeader ? "h-11" : ""}`}>
            <IconButton variant="ghost" size="sm"
              aria-label={showLabels ? "Collapse sidebar" : "Expand sidebar"}
              title={showLabels ? "Collapse sidebar" : "Expand sidebar"}
              aria-expanded={showLabels}
              data-testid="sidebar-drawer-toggle" onPress={onToggleSidebar}
              isDisabled={!onToggleSidebar} className="shrink-0">
              {showLabels ? <SidebarCollapse className={externalHeader ? "h-[18px] w-[18px]" : "h-4 w-4"} /> : <SidebarExpand className={externalHeader ? "h-[18px] w-[18px]" : "h-4 w-4"} />}
            </IconButton>
          </div>
          {externalHeader && showLabels ? headerNewChat : null}
          {!externalHeader && showLabels ? pathHeader ? navigationPath : teamMenu : null}
        </div> : null}
        {desktopRail && !showLabels && headerNewChat ? <div className="flex shrink-0 justify-center">{headerNewChat}</div> : null}
        {!desktopRail ? <div
          className={`shrink-0 gap-x-1 px-1 py-1 ${pathHeader ? "flex items-center border-b border-slate-200/70 dark:border-[color:var(--color-studio-dark-divider)]" : "flex items-center gap-y-1"} ${showLabels ? "min-h-14" : "flex-col"} ${externalHeader ? "flex-row-reverse" : ""}`}
          inert={mobileDrillInOpen || undefined} aria-hidden={mobileDrillInOpen || undefined}
          data-testid="sidebar-team-header">
          {externalHeader ? headerNewChat ?? <span className="min-w-0 flex-1" aria-hidden="true" /> : <>
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
          {pathHeader ? navigationPath : teamMenu}
          </>}
          <IconButton variant="ghost" size="sm"
            aria-label={onRequestClose ? "Close navigation" : showLabels ? "Collapse sidebar" : "Expand sidebar"}
            title={onRequestClose ? "Close navigation" : showLabels ? "Collapse sidebar" : "Expand sidebar"}
            data-testid="sidebar-drawer-toggle" onPress={onRequestClose ?? onToggleSidebar}
            isDisabled={!onRequestClose && !onToggleSidebar} className="!min-h-12 !min-w-12 shrink-0">
            {onRequestClose || showLabels ? <SidebarCollapse className="h-[18px] w-[18px]" aria-hidden="true" /> : <SidebarExpand className="h-[18px] w-[18px]" aria-hidden="true" />}
          </IconButton>
        </div> : null}
        <ul className="min-h-0 flex-1 space-y-1 overflow-y-auto overflow-x-hidden pb-2" data-testid="sidebar-context-scroll"
          inert={mobileDrillInOpen || undefined} aria-hidden={mobileDrillInOpen || undefined}>
          {desktopRail && !showLabels && !externalHeader ? <li>{teamMenu}</li> : null}
          {!pathControls ? <li className="border-t border-slate-200/70 pt-1 dark:border-[color:var(--color-studio-dark-divider)]">
            {spaceControl}
          </li> : null}
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
          </> : <li className={`${showLabels ? "mx-3" : ""} ${desktopRail ? "pt-2" : "mt-3 pt-3"} border-t ${externalHeader ? "border-transparent" : "border-slate-200/70 dark:border-[color:var(--color-studio-dark-divider)]"}`} data-testid="sidebar-no-selected-space">
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
      <NewTeamDialog open={newTeamOpen} onClose={() => setNewTeamOpen(false)} onCreated={handleTeamCreated} />
    </>
  );
}
