import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type SetStateAction,
} from "react";
import { isUUID } from "../utils/uuid";
import type { ConversationState } from "../conversations/ConversationsProvider";
import type { SettingsTab, StudioPanel } from "./studio/types";
import { resolveStudioUrlProjectId } from "./studioProjectUrlSync";
import { readPendingProjectSwitch } from "./pendingProjectSwitch";
import type { LeftDrawerPanel } from "./useStudioLayoutChromeState";

type UrlNavigationMode = "push" | "replace" | null;

interface PendingUrlSearchSyncResolution {
  nextPendingSearch: string | null;
  shouldDeferHydration: boolean;
}

export function resolvePendingUrlSearchSync({
  browserSearch,
  pendingSearch,
  routedSearch,
}: {
  browserSearch: string;
  pendingSearch: string | null;
  routedSearch: string;
}): PendingUrlSearchSyncResolution {
  if (pendingSearch === null) {
    return { nextPendingSearch: null, shouldDeferHydration: false };
  }

  if (browserSearch === routedSearch) {
    return { nextPendingSearch: null, shouldDeferHydration: false };
  }

  // The router can briefly expose an intermediate URL when user actions push
  // twice in quick succession. Keep treating the write as in-flight until the
  // routed location reaches the browser, regardless of which source search was
  // recorded when the first push began.
  return { nextPendingSearch: pendingSearch, shouldDeferHydration: true };
}

export function resolveWorkspaceUrlSyncBaseSearch({
  browserSearch,
  lastHydratedSearch,
  pendingNavigationMode,
  routedSearch,
}: {
  browserSearch: string;
  lastHydratedSearch: string | null;
  pendingNavigationMode: UrlNavigationMode;
  routedSearch: string;
}): string | null {
  if (lastHydratedSearch !== routedSearch && pendingNavigationMode !== "push") {
    return null;
  }

  // A second user action can arrive after navigate() has committed the first
  // URL to browser history but before React Router publishes that location.
  // Chain the new push from the live browser URL so neither history entry is
  // lost while the routed location catches up.
  if (pendingNavigationMode === "push" && browserSearch !== routedSearch) {
    return browserSearch;
  }

  return routedSearch;
}

interface ProjectScopedWorkspaceRouteValues {
  conversationId: string | null;
  conversationControllerId: string | null;
  jobId: string | null;
  reviewTabId: string | null;
}

export function resolveProjectScopedWorkspaceRouteValues({
  activeProjectId,
  conversationsProjectKey,
  conversationId,
  conversationControllerId,
  jobId,
  reviewTabId,
}: ProjectScopedWorkspaceRouteValues & {
  activeProjectId: string | null;
  conversationsProjectKey: string;
}): ProjectScopedWorkspaceRouteValues {
  if (!activeProjectId || conversationsProjectKey !== activeProjectId) {
    return {
      conversationId: null,
      conversationControllerId: null,
      jobId: null,
      reviewTabId: null,
    };
  }

  return {
    conversationId,
    conversationControllerId,
    jobId,
    reviewTabId,
  };
}

type WorkspaceTabSummary = {
  id: string;
  kind: string;
};

function isStudioPanel(value: string | null): value is StudioPanel {
  return (
    value === "home" ||
    value === "chat" ||
    value === "credits" ||
    value === "code" ||
    value === "extensions" ||
    value === "skills" ||
    value === "secrets" ||
    value === "ai" ||
    value === "automations" ||
    value === "sourceControl" ||
    value === "projects" ||
    value === "settings"
  );
}

function isLeftDrawerPanel(value: string | null): value is LeftDrawerPanel {
  return value === "history" || value === "files" || value === "sourceControl";
}

export function resolveLeftDrawerFromSearch(search: string): LeftDrawerPanel | null {
  const value = new URLSearchParams(search).get("workspaceTab");
  return isLeftDrawerPanel(value) ? value : null;
}

interface UseStudioLayoutWorkspaceRoutingParams {
  activeConversationControllerId: string | null;
  activeConversationId: string | null;
  activePanel: StudioPanel;
  activeProjectId: string | null;
  activeWorkspaceGitReviewReturnTabId: string | null;
  activeWorkspaceReviewTabId: string | null;
  activeWorkspaceTabConversationId: string | null;
  activeWorkspaceTabId: string | null;
  activeWorkspaceTabJobId: string | null;
  activeWorkspaceTabKind: string | null;
  activeWorkspaceTabPanel: StudioPanel | null;
  consumeUrlNavigation: () => UrlNavigationMode;
  conversations: ConversationState[];
  conversationsProjectKey: string;
  focusWorkspaceTab: (tabId: string) => void;
  isLargeScreen: boolean;
  leftDrawer: LeftDrawerPanel | null;
  locationPathname: string;
  locationSearch: string;
  navigate: (to: { pathname: string; search: string }, options: { replace: boolean }) => void;
  openConversationTab: (conversationId: string) => void;
  openJobThreadTab: (
    params: { conversationId: string; jobId: string; title?: string },
    options?: { activate?: boolean },
  ) => void;
  openPanelTab: (panel: StudioPanel, options?: { activate?: boolean }) => void;
  peekUrlNavigation: () => UrlNavigationMode;
  projectReadyForWorkspace: boolean;
  requestUrlNavigation: (mode?: "push" | "replace") => void;
  restoreGitReviewTab: (tabId: string) => boolean;
  selectConversation: (conversationId: string) => void;
  setConversationControllerId: (conversationId: string, controllerId: string | null) => void;
  setIsProjectLauncherOpen: (open: boolean) => void;
  setLeftDrawer: (value: SetStateAction<LeftDrawerPanel | null>) => void;
  setMobileSidebarOpen: (value: SetStateAction<boolean>) => void;
  workspaceTabs: WorkspaceTabSummary[];
}

export function useStudioLayoutWorkspaceRouting({
  activeConversationControllerId,
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
  locationPathname,
  locationSearch,
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
}: UseStudioLayoutWorkspaceRoutingParams) {
  const pendingConversationIdRef = useRef<string | null>(null);
  const pendingConversationControllerIdRef = useRef<string | null>(null);
  const applyingQueryParamsRef = useRef(false);
  const suppressQueryEffectRef = useRef(false);
  const lastHydratedSearchRef = useRef<string | null>(null);
  const pendingUrlSearchSyncRef = useRef<string | null>(null);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("org");

  const clearApplyingQueryParamsSoon = useCallback(() => {
    if (typeof window !== "undefined" && typeof window.requestAnimationFrame === "function") {
      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(() => {
          applyingQueryParamsRef.current = false;
        });
      });
      return;
    }
    setTimeout(() => {
      applyingQueryParamsRef.current = false;
    }, 0);
  }, []);

  const suppressNextQuerySync = useCallback(() => {
    suppressQueryEffectRef.current = true;
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    const handlePopState = () => {
      pendingUrlSearchSyncRef.current = null;
      lastHydratedSearchRef.current = null;
      consumeUrlNavigation();
      applyingQueryParamsRef.current = true;
      setLeftDrawer(resolveLeftDrawerFromSearch(window.location.search));
      clearApplyingQueryParamsSoon();
    };
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, [clearApplyingQueryParamsSoon, consumeUrlNavigation, setLeftDrawer]);

  const handlePanelSelect = useCallback(
    (panel: StudioPanel, options?: { source?: "query" | "user"; history?: "push" | "replace" }) => {
      const historyMode = options?.history ?? (options?.source === "query" ? "replace" : "push");
      const shouldRequestUrlNavigation = (() => {
        if (options?.source === "query") {
          return false;
        }
        if (panel === "code" || panel === "sourceControl") {
          return true;
        }
        if (panel === "chat") {
          if (activePanel !== "chat") {
            return true;
          }
          return leftDrawer === "history";
        }
        return activePanel !== panel;
      })();
      if (shouldRequestUrlNavigation) {
        requestUrlNavigation(historyMode);
      }
      if (panel === "code") {
        if (options?.source === "query") {
          openPanelTab("code");
          return;
        }
        suppressQueryEffectRef.current = true;
        setLeftDrawer((current) => (current === "files" ? null : "files"));
        if (!isLargeScreen) {
          setMobileSidebarOpen(false);
        }
        return;
      }
      if (panel === "sourceControl") {
        suppressQueryEffectRef.current = true;
        setLeftDrawer((current) => (current === "sourceControl" ? null : "sourceControl"));
        if (!isLargeScreen) {
          setMobileSidebarOpen(false);
        }
        return;
      }
      setLeftDrawer(null);
      if (options?.source !== "query") {
        suppressQueryEffectRef.current = true;
      }
      openPanelTab(panel);
    },
    [
      activePanel,
      isLargeScreen,
      leftDrawer,
      openPanelTab,
      requestUrlNavigation,
      setLeftDrawer,
      setMobileSidebarOpen,
    ],
  );

  // Hydrate the routed location before the downstream layout effect decides
  // whether UI state needs to be written back to the URL. A passive hydration
  // can otherwise leave the last-hydrated marker updated without another
  // render, dropping controller IDs that arrive while a navigation settles.
  useLayoutEffect(() => {
    if (!projectReadyForWorkspace) {
      return;
    }
    const pendingSearchResolution = resolvePendingUrlSearchSync({
      browserSearch: window.location.search,
      pendingSearch: pendingUrlSearchSyncRef.current,
      routedSearch: locationSearch,
    });
    pendingUrlSearchSyncRef.current = pendingSearchResolution.nextPendingSearch;
    if (pendingSearchResolution.shouldDeferHydration) {
      return;
    }
    if (peekUrlNavigation() !== null) {
      return;
    }
    if (suppressQueryEffectRef.current) {
      suppressQueryEffectRef.current = false;
    }
    const sameSearchAsLastHydration = lastHydratedSearchRef.current === locationSearch;
    const hasPendingConversationHydration =
      pendingConversationIdRef.current !== null || pendingConversationControllerIdRef.current !== null;
    if (sameSearchAsLastHydration && !hasPendingConversationHydration) {
      return;
    }
    if (peekUrlNavigation() !== null) {
      return;
    }
    lastHydratedSearchRef.current = locationSearch;
    const params = new URLSearchParams(locationSearch);
    let applied = false;
    let resolvedConversationLocalId = activeConversationId ?? null;

    const conversationParamRaw = params.get("conversationId");
    const conversationControllerParamRaw = params.get("conversationControllerId");
    const conversationParam =
      typeof conversationParamRaw === "string" && conversationParamRaw.trim().length > 0
        ? conversationParamRaw.trim()
        : null;
    const conversationControllerParam =
      typeof conversationControllerParamRaw === "string" && isUUID(conversationControllerParamRaw.trim())
        ? conversationControllerParamRaw.trim()
        : null;
    if (conversationControllerParam) {
      const existingByController = conversations.find(
        (conversation) => conversation.controllerId === conversationControllerParam,
      );
      if (existingByController) {
        resolvedConversationLocalId = existingByController.localId;
        if (existingByController.localId !== activeConversationId) {
          applyingQueryParamsRef.current = true;
          selectConversation(existingByController.localId);
          applied = true;
        }
        pendingConversationIdRef.current = null;
        pendingConversationControllerIdRef.current = null;
      } else if (conversationParam) {
        const existingConversation = conversations.find((conversation) => conversation.localId === conversationParam);
        if (existingConversation) {
          resolvedConversationLocalId = existingConversation.localId;
          if (existingConversation.controllerId !== conversationControllerParam) {
            setConversationControllerId(existingConversation.localId, conversationControllerParam);
          }
          if (existingConversation.localId !== activeConversationId) {
            applyingQueryParamsRef.current = true;
            selectConversation(existingConversation.localId);
            applied = true;
          }
          pendingConversationIdRef.current = null;
          pendingConversationControllerIdRef.current = null;
        } else {
          resolvedConversationLocalId = conversationParam;
          pendingConversationIdRef.current = conversationParam;
          pendingConversationControllerIdRef.current = conversationControllerParam;
        }
      } else {
        pendingConversationIdRef.current = null;
        pendingConversationControllerIdRef.current = conversationControllerParam;
      }
    } else if (conversationParam) {
      const existingConversation = conversations.find((conversation) => conversation.localId === conversationParam);
      if (existingConversation) {
        resolvedConversationLocalId = existingConversation.localId;
        if (conversationParam !== activeConversationId) {
          applyingQueryParamsRef.current = true;
          selectConversation(conversationParam);
          applied = true;
        }
        pendingConversationIdRef.current = null;
      } else {
        resolvedConversationLocalId = conversationParam;
        pendingConversationIdRef.current = conversationParam;
      }
      pendingConversationControllerIdRef.current = null;
    } else {
      pendingConversationIdRef.current = null;
      pendingConversationControllerIdRef.current = null;
    }

    const panelParam = params.get("panel");
    const resolvedPanelParam = panelParam;
    const isPanelTabMismatch = (() => {
      if (!isStudioPanel(resolvedPanelParam)) {
        return false;
      }
      if (resolvedPanelParam === "chat" || resolvedPanelParam === "code") {
        return false;
      }
      return activeWorkspaceTabKind !== "panel" || activeWorkspaceTabPanel !== resolvedPanelParam;
    })();
    if (
      isStudioPanel(resolvedPanelParam) &&
      (resolvedPanelParam !== activePanel || isPanelTabMismatch)
    ) {
      applyingQueryParamsRef.current = true;
      handlePanelSelect(resolvedPanelParam, { source: "query" });
      applied = true;
    } else if (!resolvedPanelParam && activePanel !== "chat") {
      applyingQueryParamsRef.current = true;
      handlePanelSelect("chat", { source: "query" });
      applied = true;
    }

    const settingsTabParamRaw = params.get("settingsTab");
    const resolvedSettingsTab: SettingsTab | null =
      settingsTabParamRaw === "org" || settingsTabParamRaw === "project" || settingsTabParamRaw === "profile"
        ? settingsTabParamRaw
        : null;
    if (
      (resolvedPanelParam === "settings" || activePanel === "settings") &&
      resolvedSettingsTab &&
      resolvedSettingsTab !== settingsTab
    ) {
      applyingQueryParamsRef.current = true;
      setSettingsTab(resolvedSettingsTab);
      applied = true;
    }

    const resolvedLeftDrawer = resolveLeftDrawerFromSearch(locationSearch);
    if (resolvedLeftDrawer !== leftDrawer) {
      applyingQueryParamsRef.current = true;
      setLeftDrawer(resolvedLeftDrawer);
      applied = true;
    }

    const reviewTabParam = params.get("reviewTab");
    const normalizedReviewTabId = typeof reviewTabParam === "string" ? reviewTabParam.trim() : "";
    if (normalizedReviewTabId) {
      const matchingReviewTab = workspaceTabs.find(
        (tab) => tab.kind === "gitReview" && tab.id === normalizedReviewTabId,
      );
      if (matchingReviewTab && activeWorkspaceTabId !== matchingReviewTab.id) {
        applyingQueryParamsRef.current = true;
        focusWorkspaceTab(matchingReviewTab.id);
        applied = true;
      } else if (!matchingReviewTab && restoreGitReviewTab(normalizedReviewTabId)) {
        applyingQueryParamsRef.current = true;
        applied = true;
      }
    } else if (activeWorkspaceTabKind === "gitReview") {
      if (activeWorkspaceGitReviewReturnTabId) {
        const returnTab = workspaceTabs.find((tab) => tab.id === activeWorkspaceGitReviewReturnTabId) ?? null;
        if (returnTab && activeWorkspaceTabId !== returnTab.id) {
          applyingQueryParamsRef.current = true;
          focusWorkspaceTab(returnTab.id);
          applied = true;
        }
      } else if (activePanel === "chat") {
        const targetConversationId = (resolvedConversationLocalId ?? activeConversationId ?? "").trim();
        if (targetConversationId) {
          applyingQueryParamsRef.current = true;
          openConversationTab(targetConversationId);
          applied = true;
        }
      } else {
        applyingQueryParamsRef.current = true;
        openPanelTab(activePanel);
        applied = true;
      }
    }

    const jobIdParam = params.get("jobId");
    const normalizedJobId = typeof jobIdParam === "string" ? jobIdParam.trim() : "";
    if (normalizedJobId) {
      const targetConversationId = (resolvedConversationLocalId ?? "").trim();
      if (targetConversationId) {
        const shouldOpen =
          activeWorkspaceTabKind !== "jobThread"
            ? true
            : activeWorkspaceTabJobId !== normalizedJobId || activeWorkspaceTabConversationId !== targetConversationId;
        if (shouldOpen) {
          applyingQueryParamsRef.current = true;
          openJobThreadTab({ conversationId: targetConversationId, jobId: normalizedJobId });
          applied = true;
        }
      }
    } else if (activeWorkspaceTabKind === "jobThread") {
      const targetConversationId = (resolvedConversationLocalId ?? activeWorkspaceTabConversationId ?? "").trim();
      if (targetConversationId) {
        applyingQueryParamsRef.current = true;
        openConversationTab(targetConversationId);
        applied = true;
      }
    }

    if (applied) {
      clearApplyingQueryParamsSoon();
    }
  }, [
    activeConversationId,
    activePanel,
    activeWorkspaceGitReviewReturnTabId,
    activeWorkspaceTabConversationId,
    activeWorkspaceTabId,
    activeWorkspaceTabJobId,
    activeWorkspaceTabKind,
    activeWorkspaceTabPanel,
    conversations,
    focusWorkspaceTab,
    handlePanelSelect,
    leftDrawer,
    locationSearch,
    openConversationTab,
    openJobThreadTab,
    openPanelTab,
    peekUrlNavigation,
    projectReadyForWorkspace,
    restoreGitReviewTab,
    selectConversation,
    setConversationControllerId,
    workspaceTabs,
    clearApplyingQueryParamsSoon,
    settingsTab,
    setLeftDrawer,
  ]);

  useEffect(() => {
    if (!projectReadyForWorkspace) {
      return;
    }
    const pendingSearchResolution = resolvePendingUrlSearchSync({
      browserSearch: window.location.search,
      pendingSearch: pendingUrlSearchSyncRef.current,
      routedSearch: locationSearch,
    });
    pendingUrlSearchSyncRef.current = pendingSearchResolution.nextPendingSearch;
    if (pendingSearchResolution.shouldDeferHydration) {
      return;
    }
    if (applyingQueryParamsRef.current) {
      return;
    }
    if (peekUrlNavigation() !== null) {
      return;
    }
    if (suppressQueryEffectRef.current) {
      return;
    }

    const params = new URLSearchParams(locationSearch);
    const panelParam = params.get("panel");
    if (!isStudioPanel(panelParam) || panelParam === "chat" || panelParam === "code") {
      return;
    }
    if (activeWorkspaceTabKind === "panel" && activeWorkspaceTabPanel === panelParam) {
      return;
    }

    applyingQueryParamsRef.current = true;
    openPanelTab(panelParam);
    clearApplyingQueryParamsSoon();
  }, [
    activeWorkspaceTabId,
    activeWorkspaceTabKind,
    activeWorkspaceTabPanel,
    clearApplyingQueryParamsSoon,
    locationSearch,
    openPanelTab,
    peekUrlNavigation,
    projectReadyForWorkspace,
  ]);

  useEffect(() => {
    const pendingConversationControllerId = pendingConversationControllerIdRef.current;
    if (!pendingConversationControllerId) {
      return;
    }
    const controllerMatch =
      conversations.find((conversation) => conversation.controllerId === pendingConversationControllerId) ?? null;
    if (controllerMatch) {
      pendingConversationIdRef.current = null;
      pendingConversationControllerIdRef.current = null;
      if (controllerMatch.localId === activeConversationId) {
        return;
      }
      applyingQueryParamsRef.current = true;
      selectConversation(controllerMatch.localId);
      clearApplyingQueryParamsSoon();
      return;
    }
    const pendingConversationId = pendingConversationIdRef.current;
    if (!pendingConversationId) {
      return;
    }
    const localMatch = conversations.find((conversation) => conversation.localId === pendingConversationId) ?? null;
    if (!localMatch) {
      return;
    }
    if (localMatch.controllerId !== pendingConversationControllerId) {
      setConversationControllerId(localMatch.localId, pendingConversationControllerId);
    }
    pendingConversationIdRef.current = null;
    pendingConversationControllerIdRef.current = null;
    if (localMatch.localId === activeConversationId) {
      return;
    }
    applyingQueryParamsRef.current = true;
    selectConversation(localMatch.localId);
    clearApplyingQueryParamsSoon();
  }, [activeConversationId, clearApplyingQueryParamsSoon, conversations, selectConversation, setConversationControllerId]);

  useEffect(() => {
    const pendingConversationId = pendingConversationIdRef.current;
    if (!pendingConversationId) {
      return;
    }
    const match = conversations.find((conversation) => conversation.localId === pendingConversationId);
    if (!match) {
      return;
    }
    const pendingConversationControllerId = pendingConversationControllerIdRef.current;
    if (pendingConversationControllerId && match.controllerId !== pendingConversationControllerId) {
      setConversationControllerId(match.localId, pendingConversationControllerId);
    }
    applyingQueryParamsRef.current = true;
    selectConversation(pendingConversationId);
    pendingConversationIdRef.current = null;
    pendingConversationControllerIdRef.current = null;
    clearApplyingQueryParamsSoon();
  }, [clearApplyingQueryParamsSoon, conversations, selectConversation, setConversationControllerId]);

  useEffect(() => {
    if (!projectReadyForWorkspace) {
      return;
    }
    const params = new URLSearchParams(locationSearch);
    const viewParam = params.get("view");
    if (viewParam === "templates" || viewParam === "start") {
      setIsProjectLauncherOpen(true);
    }
  }, [locationSearch, projectReadyForWorkspace, setIsProjectLauncherOpen]);

  // Commit user-initiated workspace history before the newly selected panel
  // paints. Otherwise a rapid Back can race the passive URL sync and pop the
  // previous entry while the UI is already showing a newer, uncommitted tab.
  useLayoutEffect(() => {
    if (!projectReadyForWorkspace) {
      return;
    }
    const pendingNavigationMode = peekUrlNavigation();
    const urlSyncBaseSearch = resolveWorkspaceUrlSyncBaseSearch({
      browserSearch: window.location.search,
      lastHydratedSearch: lastHydratedSearchRef.current,
      pendingNavigationMode,
      routedSearch: locationSearch,
    });
    if (urlSyncBaseSearch === null) {
      return;
    }
    if (applyingQueryParamsRef.current && pendingNavigationMode !== "push") {
      return;
    }

    const params = new URLSearchParams(urlSyncBaseSearch);
    if (pendingNavigationMode === null) {
      const urlPanel = params.get("panel");
      if (isStudioPanel(urlPanel) && urlPanel !== "chat" && urlPanel !== activePanel) {
        return;
      }
      const urlSettingsTab = params.get("settingsTab");
      if (
        activePanel === "settings" &&
        urlPanel === "settings" &&
        (urlSettingsTab === "org" || urlSettingsTab === "project" || urlSettingsTab === "profile") &&
        urlSettingsTab !== settingsTab
      ) {
        return;
      }
    }
    let changed = false;

    const syncParam = (key: string, value: string | null) => {
      const current = params.get(key);
      if (value && value.length > 0) {
        if (current !== value) {
          params.set(key, value);
          return true;
        }
        return false;
      }
      if (current !== null) {
        params.delete(key);
        return true;
      }
      return false;
    };

    const urlProjectId = (() => {
      const raw = params.get("projectId");
      if (raw && isUUID(raw.trim())) {
        return raw.trim();
      }
      return null;
    })();
    const pendingProjectSwitch = readPendingProjectSwitch();
    const resolvedProjectId = resolveStudioUrlProjectId({
      activeProjectId,
      urlProjectId,
      pendingProjectSwitch,
    });
    const projectScopedRouteValues = resolveProjectScopedWorkspaceRouteValues({
      activeProjectId,
      conversationsProjectKey,
      conversationId: activeConversationId,
      conversationControllerId: activeConversationControllerId,
      jobId: activeWorkspaceTabJobId,
      reviewTabId: activeWorkspaceReviewTabId,
    });
    changed = syncParam("projectId", resolvedProjectId) || changed;
    changed = syncParam("conversationId", projectScopedRouteValues.conversationId) || changed;
    changed = syncParam("jobId", projectScopedRouteValues.jobId) || changed;
    changed =
      syncParam("conversationControllerId", projectScopedRouteValues.conversationControllerId) || changed;
    changed = syncParam("workspaceTab", leftDrawer) || changed;
    changed = syncParam("reviewTab", projectScopedRouteValues.reviewTabId) || changed;
    changed = syncParam("panel", activePanel === "chat" ? null : activePanel) || changed;
    changed = syncParam("settingsTab", activePanel === "settings" ? settingsTab : null) || changed;
    changed =
      syncParam(
        "settingsCategory",
        activePanel === "settings" ? params.get("settingsCategory") : null,
      ) || changed;

    if (!changed) {
      if (suppressQueryEffectRef.current) {
        suppressQueryEffectRef.current = false;
      }
      return;
    }

    const searchString = params.toString();
    const navigationMode = consumeUrlNavigation();
    const shouldReplace = navigationMode !== "push";
    pendingUrlSearchSyncRef.current = urlSyncBaseSearch;
    lastHydratedSearchRef.current = null;
    navigate(
      {
        pathname: locationPathname,
        search: searchString.length > 0 ? `?${searchString}` : "",
      },
      { replace: shouldReplace },
    );
    if (suppressQueryEffectRef.current) {
      suppressQueryEffectRef.current = false;
    }
  }, [
    activeConversationControllerId,
    activeConversationId,
    activePanel,
    activeProjectId,
    activeWorkspaceReviewTabId,
    activeWorkspaceTabJobId,
    conversationsProjectKey,
    consumeUrlNavigation,
    leftDrawer,
    locationPathname,
    locationSearch,
    navigate,
    peekUrlNavigation,
    projectReadyForWorkspace,
    settingsTab,
  ]);

  return {
    settingsTab,
    setSettingsTab,
    handlePanelSelect,
    suppressNextQuerySync,
  };
}
