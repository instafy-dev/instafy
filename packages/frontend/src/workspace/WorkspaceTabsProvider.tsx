import type { StudioNavigationOptions } from "../navigation/studioNavigation";
import { useConversationSurfacesOwner } from "./conversationSurfaces";
import { readWorkspacePanelDestination, type WorkspacePanelDestination } from "./workspacePanelDestination";
import { useStudioDraftSnapshot } from "./StudioDrafts";
import { useStudioGuardedNavigation } from "../navigation/StudioDraftNavigationGuard";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { CodeFile } from "../types";
import type { ChatMessageCommitRange, StudioPanel } from "../screens/studio/types";
import { useCode } from "../code/useCode";
import { useWorkspaceUi } from "./useWorkspace";
import {
  useConversations,
  type ConversationState,
} from "../conversations/ConversationsProvider";
import { useProject } from "../projects/useProject";
import { isEmptyConversationPlaceholder } from "../conversations/conversationState";
import { isUUID } from "../utils/uuid";
import type { WorkspaceGitReviewSource } from "./gitReviewTypes";
import { useWorkspaceTabController } from "./useWorkspaceTabController";
import { prepareConversationTabOpen, shouldKeepConversationTab } from "./workspaceConversationPreview";
import {
  createGitReviewTab,
  createTabForConversation,
  formatUnreadBadge,
  getConversationTabIcon,
  getTabIdForConversation,
  PANEL_META,
  type WorkspaceConversationTabState,
  type WorkspaceGitReviewTabState,
  type WorkspaceTabState,
} from "./workspaceTabFactories";
import {
  loadPersistedWorkspaceGitReviews,
  loadPersistedWorkspaceTabs,
  persistWorkspaceGitReviewState,
  persistWorkspaceTabsState,
  type PersistedWorkspaceGitReviewState,
  type PersistedWorkspaceTabsState,
} from "./workspaceTabPersistence";

interface WorkspaceTabsContextValue {
  conversationSurfaces: ReturnType<typeof useConversationSurfacesOwner>;
  tabs: WorkspaceTabState[];
  activeTab: WorkspaceTabState | null;
  activeTabId: string | null;
  /** The tab owner can materialize this space's conversation tabs. */
  conversationTabsReady: boolean;
  openPanelTab: (panel: StudioPanel, options?: { activate?: boolean }) => void;
  openConversationTab: (
    conversationId: string,
    options?: { activate?: boolean; fallbackConversation?: ConversationState | null; preview?: boolean }
  ) => void;
  openJobThreadTab: (params: { conversationId: string; jobId: string; title?: string }, options?: { activate?: boolean }) => void;
  requestUrlNavigation: (mode?: "push" | "replace") => void;
  peekUrlNavigation: () => "push" | "replace" | null;
  consumeUrlNavigation: () => "push" | "replace" | null;
  requestUrlPush: () => void;
  consumeUrlPush: () => boolean;
  setPanelTabMeta: (
    panel: StudioPanel,
    meta: { title?: string; icon?: ReactNode }
  ) => void;
  openFileTab: (file: Pick<CodeFile, "id" | "path" | "label">, options?: { preview?: boolean }) => void;
  openGitDiffTab: (options: {
    path: string;
    title?: string;
    commitRange?: ChatMessageCommitRange | null;
  }) => void;
  openGitReviewTab: (review: WorkspaceGitReviewSource) => void;
  restoreGitReviewTab: (tabId: string) => boolean;
  openExplorerTab: (options: { rootPath: string; title?: string }) => void;
  focusTab: (tabId: string) => void;
  keepTabOpen: (tabId: string) => void;
  closeTab: (tabId: string) => void;
  moveTab: (tabId: string, targetIndex: number) => void;
  setTabDirty: (tabId: string, dirty: boolean) => void;
  resetTabs: () => void;
}

const WorkspaceTabsContext = createContext<WorkspaceTabsContextValue | null>(null);

declare global {
  interface Window {
    __INSTAFY_WORKSPACE_TABS_DEBUG__?: {
      activeTabId: string | null;
      tabs: Array<{
        id: string;
        kind: WorkspaceTabState["kind"];
        conversationId?: string | null;
        preview?: boolean;
      }>;
      openPanelTab: (panel: StudioPanel, options?: { activate?: boolean }) => void;
      openConversationTab: (
        conversationId: string,
        options?: { activate?: boolean; fallbackConversation?: ConversationState | null; preview?: boolean },
      ) => void;
    };
  }
}

export function WorkspaceTabsProvider({ children, locationSearch, onRestorePanelDestination }: {
  children: ReactNode;
  locationSearch?: string;
  onRestorePanelDestination?: (destination: WorkspacePanelDestination, options?: StudioNavigationOptions) => void;
}) {
  const conversationSurfaces = useConversationSurfacesOwner();
  const { activePanel, setActivePanel } = useWorkspaceUi();
  const draftSnapshot = useStudioDraftSnapshot();
  const guardNavigation = useStudioGuardedNavigation();
  const { workspace, setActiveFile } = useCode();
  const {
    conversations,
    activeConversationId,
    selectConversation,
    markConversationRead,
    createConversation,
    remoteConversationHistoryResolved,
    projectKey: conversationsProjectKey
  } = useConversations();
  const { activeProjectId } = useProject();
  const workspaceProjectId = useMemo(() => {
    if (activeProjectId && isUUID(activeProjectId)) {
      return activeProjectId;
    }
    if (typeof window === "undefined") {
      return null;
    }
    const runtimeWindow = window as typeof window & {
      __INSTAFY_ACTIVE_PROJECT_ID__?: string | null;
    };
    const fromWindow = runtimeWindow.__INSTAFY_ACTIVE_PROJECT_ID__;
    if (fromWindow && isUUID(fromWindow)) {
      return fromWindow;
    }
    try {
      const params = new URLSearchParams(window.location.search);
      const fromUrl = params.get("projectId");
      if (fromUrl && isUUID(fromUrl.trim())) {
        return fromUrl.trim();
      }
    } catch (_error) {
      // ignore malformed URL
    }
    return null;
  }, [activeProjectId]);
  const initialConversationTabsRef = useRef<WorkspaceConversationTabState[] | null>(null);
  const persistedStateRef = useRef<PersistedWorkspaceTabsState | null>(null);
  const persistedGitReviewStateRef = useRef<PersistedWorkspaceGitReviewState | null>(null);
  if (persistedStateRef.current === null) {
    persistedStateRef.current = loadPersistedWorkspaceTabs();
  }
  if (persistedGitReviewStateRef.current === null) {
    persistedGitReviewStateRef.current = loadPersistedWorkspaceGitReviews();
  }
  const appliedProjectRef = useRef<string | null>(null);
  if (initialConversationTabsRef.current === null) {
    initialConversationTabsRef.current = conversations.map((conversation) =>
      createTabForConversation(conversation)
    );
  }
  const initialGitReviewTabRef = useRef<WorkspaceGitReviewTabState | null>(null);
  if (initialGitReviewTabRef.current === null && workspaceProjectId && typeof window !== "undefined") {
    try {
      const params = new URLSearchParams(window.location.search);
      const requestedReviewTabId = params.get("reviewTab")?.trim() ?? "";
      if (requestedReviewTabId) {
        const persistedProject = persistedGitReviewStateRef.current?.projects?.[workspaceProjectId] ?? null;
        const persistedReview = persistedProject?.tabs.find((tab) => tab.id === requestedReviewTabId) ?? null;
        if (persistedReview) {
          initialGitReviewTabRef.current = createGitReviewTab(
            persistedReview.review,
            persistedReview.returnTabId ?? null,
            { id: requestedReviewTabId },
          );
        }
      }
    } catch (_error) {
      // ignore malformed URL during initial tab restoration
    }
  }
  const [tabs, setTabs] = useState<WorkspaceTabState[]>(() => {
    const initialTabs = initialConversationTabsRef.current ?? [];
    const restoredReviewTab = initialGitReviewTabRef.current;
    return restoredReviewTab ? [...initialTabs, restoredReviewTab] : initialTabs;
  });
  const [activeTabId, setActiveTabId] = useState<string | null>(() => {
    if (initialGitReviewTabRef.current) {
      return initialGitReviewTabRef.current.id;
    }
    if (activeConversationId) {
      return getTabIdForConversation(activeConversationId);
    }
    const initialConversation = conversations[0] ?? null;
    return initialConversation ? getTabIdForConversation(initialConversation.localId) : null;
  });
  const suppressPanelSyncRef = useRef<StudioPanel | null>(null);
  const urlNavigationModeRef = useRef<"push" | "replace" | null>(null);
  const tabsRef = useRef<WorkspaceTabState[]>(tabs);
  const activeTabIdRef = useRef<string | null>(activeTabId);
  const activeConversationIdRef = useRef<string | null>(activeConversationId);
  const seenConversationIdsRef = useRef<Set<string>>(new Set());
  const conversationAutoOpenStartRef = useRef<number>(Date.now());
  const tabsProjectRef = useRef(workspaceProjectId);

  // A space we have not opened before starts with a single local placeholder
  // while its real conversations are still being fetched. Giving that
  // placeholder a tab puts a generic "Conversation 1" in the strip, which on
  // an org switch reads as the previous org's tab surviving. Hold the strip
  // until the real conversations land.
  const conversationHistoryPending =
    !remoteConversationHistoryResolved && conversations.every(isEmptyConversationPlaceholder);

  // ConversationsProvider swaps its reducer state one commit after the active
  // project changes, so there is always a commit where workspaceProjectId is
  // already the new space while `conversations` still holds the old one's.
  // Building or persisting tabs from that pairing puts the previous org's chat
  // in the strip and writes its ids into the new space's saved tab list.
  const conversationsMatchProject =
    workspaceProjectId === null || conversationsProjectKey === workspaceProjectId;
  const conversationTabsReady = conversationsMatchProject && !conversationHistoryPending;
  const savedConversationIds = workspaceProjectId
    ? persistedStateRef.current?.projects[workspaceProjectId]?.conversations ?? []
    : [];
  // A saved tab may arrive in a later history page. Do not prune or overwrite
  // the saved set while hydration has supplied only part of that space.
  const canRestoreSavedTabs = remoteConversationHistoryResolved
    || savedConversationIds.every((id) => conversations.some((conversation) => conversation.localId === id));

  useEffect(() => {
    seenConversationIdsRef.current = new Set();
    conversationAutoOpenStartRef.current = Date.now();
  }, [workspaceProjectId]);

  useEffect(() => {
    tabsRef.current = tabs;
  }, [tabs]);

  useEffect(() => {
    activeTabIdRef.current = activeTabId;
  }, [activeTabId]);

  useEffect(() => {
    activeConversationIdRef.current = activeConversationId;
  }, [activeConversationId]);
  const panelDestinations = useRef(new Map<string, WorkspacePanelDestination>());
  const restorePanelLocation = useCallback((panel: StudioPanel) => {
    const destination = panelDestinations.current.get(`${workspaceProjectId}:${panel}`);
    if (!destination || !onRestorePanelDestination) return;
    const replace = urlNavigationModeRef.current === "replace";
    urlNavigationModeRef.current = null;
    onRestorePanelDestination(destination, { replace });
  }, [onRestorePanelDestination, workspaceProjectId]);

  const {
    setActiveTabInternal,
    ensureTabForPanel,
    openConversationTab,
    openJobThreadTab,
    openPanelTab,
    openFileTab,
    openGitDiffTab,
    openGitReviewTab,
    restoreGitReviewTab,
    openExplorerTab,
    focusTab,
    keepTabOpen,
    closeTab,
    moveTab,
    setTabDirty,
    setPanelTabMeta,
    resetTabs,
    requestUrlNavigation,
    peekUrlNavigation,
    consumeUrlNavigation,
    requestUrlPush,
    consumeUrlPush,
  } = useWorkspaceTabController({
    activeConversationId,
    conversations,
    createConversation,
    selectConversation,
    markConversationRead,
    setActiveFile,
    setActivePanel,
    onActivatePanel: restorePanelLocation,
    workspaceProjectId,
    canPersistTabs: conversationsMatchProject && canRestoreSavedTabs
      && appliedProjectRef.current === workspaceProjectId,
    tabsRef,
    activeTabIdRef,
    activeConversationIdRef,
    suppressPanelSyncRef,
    urlNavigationModeRef,
    persistedStateRef,
    persistedGitReviewStateRef,
    setTabs,
    setActiveTabId,
  });

  const previousProtectedPanels = useRef(new Set<StudioPanel>());
  useEffect(() => {
    const protectedPanels = new Set([...draftSnapshot.drafts, ...draftSnapshot.protections].map(item => item.panel));
    tabsRef.current.forEach(tab => {
      if (tab.kind === "panel" && (protectedPanels.has(tab.panel) || previousProtectedPanels.current.has(tab.panel))) {
        setTabDirty(tab.id, protectedPanels.has(tab.panel));
      }
    });
    previousProtectedPanels.current = protectedPanels;
  }, [draftSnapshot, setTabDirty, tabs]);

  const guardedActions = useMemo(() => {
    const guarded = <Args extends unknown[]>(action: (...args: Args) => void) =>
      (...args: Args) => guardNavigation(() => action(...args));
    return {
      openPanelTab: guarded(openPanelTab),
      openConversationTab: guarded(openConversationTab),
      openJobThreadTab: guarded(openJobThreadTab),
      openFileTab: guarded(openFileTab),
      openGitDiffTab: guarded(openGitDiffTab),
      openGitReviewTab: guarded(openGitReviewTab),
      openExplorerTab: guarded(openExplorerTab),
      focusTab: (id: string) => id === activeTabIdRef.current ? focusTab(id) : guardNavigation(() => focusTab(id)),
      closeTab: (id: string) => id === activeTabIdRef.current ? guardNavigation(() => closeTab(id)) : closeTab(id),
    };
  }, [guardNavigation, openPanelTab, openConversationTab, openJobThreadTab, openFileTab,
    openGitDiffTab, openGitReviewTab, openExplorerTab, focusTab, closeTab]);

  useEffect(() => {
    if (tabsProjectRef.current === workspaceProjectId) return;
    tabsProjectRef.current = workspaceProjectId;
    appliedProjectRef.current = null;
    // Keep same-space tabs during a partial refresh, but never leave the old
    // space's chat/run tabs interactive while the destination is still loading.
    // This intentionally bypasses commitTabs: it must not rewrite either
    // space's saved conversation list before destination hydration finishes.
    const nextTabs = tabsRef.current.filter((tab) => tab.kind !== "conversation" && tab.kind !== "jobThread");
    tabsRef.current = nextTabs;
    setTabs(nextTabs);
    if (!nextTabs.some((tab) => tab.id === activeTabIdRef.current)) {
      const fallback = nextTabs[0] ?? null;
      if (fallback) {
        setActiveTabInternal(fallback, { syncPanel: false, syncConversation: false });
      } else {
        activeTabIdRef.current = null;
        setActiveTabId(null);
      }
    }
  }, [setActiveTabInternal, workspaceProjectId]);

  const applyPersistedTabs = useCallback(() => {
    if (!workspaceProjectId) {
      return;
    }
    const persistedAll = persistedStateRef.current;
    const projectState = persistedAll?.projects?.[workspaceProjectId] ?? null;
    if (!projectState) {
      return;
    }

    const conversationLookup = new Map(conversations.map((conversation) => [conversation.localId, conversation]));
    const nonConversationTabs = tabsRef.current.filter((tab) => tab.kind !== "conversation" && tab.kind !== "jobThread");
    const nextConversationTabs: WorkspaceConversationTabState[] = [];

    projectState.conversations.forEach((conversationId) => {
      const conversation = conversationLookup.get(conversationId);
      if (!conversation) {
        return;
      }
      const tab = createTabForConversation(conversation);
      tab.preview = conversationId === projectState.previewConversationId
        && !shouldKeepConversationTab(tab, conversation, nonConversationTabs);
      nextConversationTabs.push(tab);
    });

    const activeConversation = activeConversationIdRef.current
      ? conversationLookup.get(activeConversationIdRef.current) ?? null
      : null;
    if (
      activeConversation &&
      !nextConversationTabs.some(
        (tab) => tab.conversationId === activeConversation.localId,
      )
    ) {
      const opened = prepareConversationTabOpen(
        nextConversationTabs, activeConversation, conversations, true,
      );
      nextConversationTabs.splice(0, nextConversationTabs.length, ...opened.tabs.filter(
        (tab): tab is WorkspaceConversationTabState => tab.kind === "conversation",
      ));
    }

    const persistedConversationCount = projectState.conversations.length;
    if (persistedConversationCount > 0 && nextConversationTabs.length === 0) {
      const fallback = conversations[0] ?? null;
      if (fallback) {
        nextConversationTabs.push(createTabForConversation(fallback));
      }
    }

    const nextTabs: WorkspaceTabState[] = [...nextConversationTabs, ...nonConversationTabs];
    persistedStateRef.current = {
      projects: {
        ...persistedAll?.projects,
        [workspaceProjectId]: {
          ...projectState,
          conversations: nextConversationTabs.map((tab) => tab.conversationId),
          previewConversationId: nextConversationTabs.find((tab) => tab.preview)?.conversationId,
        },
      },
    };
    tabsRef.current = nextTabs;
    setTabs(nextTabs);
    seenConversationIdsRef.current = new Set(conversations.map((conversation) => conversation.localId));
    conversationAutoOpenStartRef.current = Date.now();

    const currentActiveId = activeTabIdRef.current;
    if (currentActiveId) {
      const current = nextTabs.find((tab) => tab.id === currentActiveId);
      if (current) {
        setActiveTabInternal(current, { syncPanel: false, syncConversation: false });
        appliedProjectRef.current = workspaceProjectId;
        return;
      }
    }

    appliedProjectRef.current = workspaceProjectId;
    const targetConversationId = projectState.activeConversationId;
    const target = targetConversationId
      ? nextTabs.find((tab) => tab.kind === "conversation" && tab.conversationId === targetConversationId)
      : null;
    if (target) {
      setActiveTabInternal(target, { syncPanel: false });
      return;
    }
    const fallback = nextTabs.find((tab) => tab.kind === "conversation") ?? null;
    if (fallback) {
      setActiveTabInternal(fallback, { syncPanel: false });
    }
  }, [conversations, setActiveTabInternal, workspaceProjectId]);

  useEffect(() => {
    if (!workspaceProjectId || !conversationsMatchProject || !canRestoreSavedTabs) {
      return;
    }
    const persisted = persistedStateRef.current;
    const projectState = persisted?.projects?.[workspaceProjectId] ?? null;
    const nonConversationTabs = tabsRef.current.filter((tab) => tab.kind !== "conversation" && tab.kind !== "jobThread");

    if (!projectState) {
      const targetConversationId = activeConversationId ?? conversations[0]?.localId ?? null;
      const conversation =
        (targetConversationId
          ? conversations.find((entry) => entry.localId === targetConversationId)
          : null) ?? conversations[0] ?? null;
      if (!conversation) {
        return;
      }
      if (conversationHistoryPending) {
        if (nonConversationTabs.length !== tabsRef.current.length) {
          tabsRef.current = nonConversationTabs;
          setTabs(nonConversationTabs);
          const stillActive = activeTabIdRef.current
            ? nonConversationTabs.find((tab) => tab.id === activeTabIdRef.current) ?? null
            : null;
          if (!stillActive) {
            const fallback = nonConversationTabs[0] ?? null;
            if (fallback) {
              setActiveTabInternal(fallback, { syncPanel: false, syncConversation: false });
            } else {
              activeTabIdRef.current = null;
              setActiveTabId(null);
            }
          }
        }
        return;
      }
      const conversationTabs = prepareConversationTabOpen([], conversation, conversations, true).tabs;
      const nextTabs: WorkspaceTabState[] = [...conversationTabs, ...nonConversationTabs];
      tabsRef.current = nextTabs;
      setTabs(nextTabs);
      seenConversationIdsRef.current = new Set(conversations.map((entry) => entry.localId));
      conversationAutoOpenStartRef.current = Date.now();
      appliedProjectRef.current = workspaceProjectId;

      const currentActiveId = activeTabIdRef.current;
      const current = currentActiveId
        ? nextTabs.find((tab) => tab.id === currentActiveId) ?? null
        : null;
      if (current) {
        setActiveTabInternal(current, { syncPanel: false, syncConversation: false });
        return;
      }

      const target = nextTabs.find(
        (tab) => tab.kind === "conversation" && tab.conversationId === conversation.localId
      );
      if (target) {
        setActiveTabInternal(target, { syncPanel: false });
      }
      return;
    }

    if (appliedProjectRef.current === workspaceProjectId) {
      return;
    }

    applyPersistedTabs();
    appliedProjectRef.current = workspaceProjectId;
  }, [
    activeConversationId,
    applyPersistedTabs,
    conversationHistoryPending,
    conversations,
    conversationsMatchProject,
    canRestoreSavedTabs,
    setActiveTabInternal,
    workspaceProjectId,
  ]);

  useEffect(() => {
    if (!conversationsMatchProject || !canRestoreSavedTabs) {
      return;
    }
    const currentTabs = tabsRef.current;
    const conversationLookup = new Map(conversations.map((conversation) => [conversation.localId, conversation]));
    const existingConversationTabs = currentTabs.filter(
      (tab): tab is WorkspaceConversationTabState =>
        tab.kind === "conversation" && conversationLookup.has(tab.conversationId)
    );
    const existingConversationTabMap = new Map(
      existingConversationTabs.map((tab) => [tab.conversationId, tab])
    );

    const persistedOrder =
      workspaceProjectId
        ? persistedStateRef.current?.projects?.[workspaceProjectId]?.conversations ?? null
        : null;

    let changed = false;
    if (currentTabs.some((tab) => tab.kind === "conversation" && !conversationLookup.has(tab.conversationId))) {
      changed = true;
    }

    const updateConversationTab = (tab: WorkspaceConversationTabState): WorkspaceConversationTabState => {
      const conversation = conversationLookup.get(tab.conversationId);
      if (!conversation) {
        return tab;
      }
      const badge = formatUnreadBadge(conversation.unreadCount);
      const icon = getConversationTabIcon(conversation.visibility);
      const preview = tab.preview && !shouldKeepConversationTab(tab, conversation, currentTabs);
      if (tab.title === conversation.title && tab.badge === badge && tab.icon === icon && tab.closable && tab.preview === preview) {
        return tab;
      }
      changed = true;
      return { ...tab, title: conversation.title, badge, icon, closable: true, preview };
    };

    const nextConversationTabs: WorkspaceConversationTabState[] = [];
    const includedConversationIds = new Set<string>();

    if (persistedOrder && persistedOrder.length > 0) {
      persistedOrder.forEach((conversationId) => {
        if (includedConversationIds.has(conversationId)) {
          return;
        }
        const conversation = conversationLookup.get(conversationId) ?? null;
        const existing = existingConversationTabMap.get(conversationId) ?? null;
        if (existing) {
          nextConversationTabs.push(updateConversationTab(existing));
          includedConversationIds.add(conversationId);
          return;
        }
        if (!conversation) {
          return;
        }
        const tab = createTabForConversation(conversation);
        tab.preview = conversationId === persistedStateRef.current?.projects[workspaceProjectId ?? ""]?.previewConversationId
          && !shouldKeepConversationTab(tab, conversation, currentTabs);
        nextConversationTabs.push(tab);
        includedConversationIds.add(conversationId);
        changed = true;
      });
    }

    existingConversationTabs.forEach((tab) => {
      if (includedConversationIds.has(tab.conversationId)) {
        return;
      }
      nextConversationTabs.push(updateConversationTab(tab));
      includedConversationIds.add(tab.conversationId);
    });

    const seen = seenConversationIdsRef.current;
    const now = Date.now();
    const autoOpenWindowMs = 60_000;
    conversations.forEach((conversation) => {
      if (seen.has(conversation.localId)) {
        return;
      }
      seen.add(conversation.localId);
      if (conversation.parentConversationId || conversation.threadKind) {
        return;
      }
      if (now - conversation.createdAt > autoOpenWindowMs) {
        return;
      }
      if (conversation.createdAt < conversationAutoOpenStartRef.current) {
        return;
      }
      if (includedConversationIds.has(conversation.localId)) {
        return;
      }
      nextConversationTabs.push(createTabForConversation(conversation));
      includedConversationIds.add(conversation.localId);
      changed = true;
    });

    const hadConversationTabs = currentTabs.some((tab) => tab.kind === "conversation");
    const shouldEnsureFallback =
      nextConversationTabs.length === 0 &&
      conversations.length > 0 &&
      !conversationHistoryPending &&
      (hadConversationTabs || persistedOrder === null);
    if (shouldEnsureFallback) {
      const fallback = conversations[0] ?? null;
      if (fallback) {
        nextConversationTabs.push(createTabForConversation(fallback));
        changed = true;
      }
    }

    // Refresh chats in their existing slots so title/unread updates do not undo
    // a drag across tab kinds. Keep saved chat order when more history arrives,
    // and append any remaining chats after the existing tabs.
    const nextTabs: WorkspaceTabState[] = [];
    let conversationIndex = 0;
    for (const tab of currentTabs) {
      if (tab.kind !== "conversation") {
        nextTabs.push(tab);
      } else if (conversationLookup.has(tab.conversationId)) {
        const nextConversationTab = nextConversationTabs[conversationIndex++];
        if (nextConversationTab) nextTabs.push(nextConversationTab);
      }
    }
    nextTabs.push(...nextConversationTabs.slice(conversationIndex));
    const orderChanged =
      nextTabs.length !== currentTabs.length ||
      nextTabs.some((tab, index) => tab.id !== currentTabs[index]?.id);
    const payloadChanged = nextTabs.some((tab, index) => tab !== currentTabs[index]);

    if (orderChanged || payloadChanged || changed) {
      tabsRef.current = nextTabs;
      setTabs(nextTabs);
      // Pruning a stale tab can leave activeTabId pointing at nothing, and the
      // repair below only runs on the chat panel — on Home the workspace would
      // sit blank until the next click.
      const activeId = activeTabIdRef.current;
      if (activeId && !nextTabs.some((tab) => tab.id === activeId)) {
        const fallback = nextTabs[0] ?? null;
        if (fallback) {
          setActiveTabInternal(fallback, { syncPanel: false, syncConversation: false });
        } else {
          activeTabIdRef.current = null;
          setActiveTabId(null);
        }
      }
    }
  }, [
    conversationHistoryPending,
    conversations,
    conversationsMatchProject,
    canRestoreSavedTabs,
    setActiveTabInternal,
    workspaceProjectId,
  ]);

  useEffect(() => {
    const resolvedActiveConversationId = activeConversationIdRef.current ?? activeConversationId;
    if (!resolvedActiveConversationId) {
      return;
    }
    if (activePanel !== "chat") {
      return;
    }
    if (!tabsRef.current.some((tab) => tab.kind === "conversation")) {
      return;
    }
    const currentActiveTab =
      activeTabIdRef.current ? tabsRef.current.find((tab) => tab.id === activeTabIdRef.current) ?? null : null;
    if (currentActiveTab?.kind === "jobThread") {
      return;
    }
    if (currentActiveTab?.kind === "gitReview") {
      return;
    }
    const targetId = getTabIdForConversation(resolvedActiveConversationId);
    if (activeTabIdRef.current === targetId) {
      return;
    }
    const currentTabs = tabsRef.current;
    let targetTab = currentTabs.find((tab) => tab.id === targetId) ?? null;
    if (!targetTab) {
      const conversation =
        conversations.find((entry) => entry.localId === resolvedActiveConversationId) ?? null;
      if (!conversation) {
        return;
      }
      // Route/back navigation previews an existing chat, matching selection
      // from history, while focusing an existing tab never promotes it.
      openConversationTab(conversation.localId, { preview: true, activate: false });
      targetTab = tabsRef.current.find((tab) => tab.id === targetId) ?? null;
    }
    if (!targetTab) {
      return;
    }
    setActiveTabInternal(targetTab, { syncPanel: false, syncConversation: false });
  }, [activeConversationId, activePanel, conversations, openConversationTab, setActiveTabInternal]);

  useEffect(() => {
    const dirtyLookup = new Map<string, boolean>();
    const titleLookup = new Map<string, string>();
    workspace.files.forEach((file) => {
      dirtyLookup.set(file.id, file.modified !== file.generated);
      titleLookup.set(file.id, file.label ?? file.path);
    });
    const currentTabs = tabsRef.current;
    let changed = false;
    const nextTabs = currentTabs.map((tab) => {
      if (tab.kind !== "file") {
        return tab;
      }
      const nextDirty = dirtyLookup.get(tab.fileId) ?? false;
      const nextTitle = titleLookup.get(tab.fileId) ?? tab.title;
      if (tab.dirty !== nextDirty || tab.title !== nextTitle) {
        changed = true;
        return {
          ...tab,
          dirty: nextDirty,
          preview: nextDirty ? false : tab.preview,
          title: nextTitle
        };
      }
      return tab;
    });
    if (changed) {
      tabsRef.current = nextTabs;
      setTabs(nextTabs);
    }
  }, [workspace.files, tabs]);

  useEffect(() => {
    if (!workspaceProjectId) {
      return;
    }
    if (appliedProjectRef.current !== workspaceProjectId || !conversationsMatchProject || !canRestoreSavedTabs) {
      return;
    }
    const conversationTabs = tabsRef.current.filter(
      (tab): tab is WorkspaceConversationTabState => tab.kind === "conversation"
    );
    const conversationsToPersist = conversationTabs.map((tab) => tab.conversationId);
    const activeConversationIdPersisted =
      conversationTabs.find((tab) => tab.id === activeTabId)?.conversationId ?? undefined;

    const currentState = persistedStateRef.current ?? { projects: {} };
    const nextState: PersistedWorkspaceTabsState = {
      projects: {
        ...currentState.projects,
        [workspaceProjectId]: {
          conversations: conversationsToPersist,
          activeConversationId: activeConversationIdPersisted,
          previewConversationId: conversationTabs.find((tab) => tab.preview)?.conversationId,
        }
      }
    };
    persistedStateRef.current = nextState;
    persistWorkspaceTabsState(nextState);
  }, [activeTabId, canRestoreSavedTabs, conversationsMatchProject, tabs, workspaceProjectId]);

  useEffect(() => {
    if (!workspaceProjectId || !conversationsMatchProject) {
      return;
    }
    const gitReviewTabs = tabsRef.current.filter(
      (tab): tab is WorkspaceGitReviewTabState => tab.kind === "gitReview",
    );
    const currentState = persistedGitReviewStateRef.current ?? { projects: {} };
    const nextState: PersistedWorkspaceGitReviewState = {
      projects: {
        ...currentState.projects,
        [workspaceProjectId]: {
          tabs: gitReviewTabs.map((tab) => ({
            id: tab.id,
            review: tab.review,
            returnTabId: tab.returnTabId ?? null,
          })),
        },
      },
    };
    persistedGitReviewStateRef.current = nextState;
    persistWorkspaceGitReviewState(nextState);
  }, [conversationsMatchProject, tabs, workspaceProjectId]);

  useEffect(() => {
    const suppressedPanel = suppressPanelSyncRef.current;
    if (suppressedPanel) {
      if (suppressedPanel === activePanel) {
        suppressPanelSyncRef.current = null;
      }
      return;
    }
    switch (activePanel) {
      case "chat":
      case "code":
        return;
      default: {
        if (!(activePanel in PANEL_META)) {
          return;
        }
        const currentActiveId = activeTabIdRef.current;
        if (currentActiveId) {
          const currentTab = tabsRef.current.find((tab) => tab.id === currentActiveId);
          if (currentTab) {
            if (currentTab.kind === "panel" && currentTab.panel === activePanel) {
              return;
            }
          }
        }
        const tab = ensureTabForPanel(activePanel);
        setActiveTabInternal(tab, { syncPanel: false });
      }
    }
  }, [activePanel, ensureTabForPanel, setActiveTabInternal]);

  const activeTab = useMemo(
    () => (activeTabId ? tabs.find((tab) => tab.id === activeTabId) ?? null : null),
    [tabs, activeTabId]
  );

  useEffect(() => {
    if (locationSearch === undefined || activeTab?.kind !== "panel") return;
    const destination = readWorkspacePanelDestination(locationSearch, activeTab.panel);
    if (destination) panelDestinations.current.set(`${workspaceProjectId}:${activeTab.panel}`, destination);
  }, [locationSearch, activeTab, workspaceProjectId]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    window.__INSTAFY_WORKSPACE_TABS_DEBUG__ = {
      activeTabId,
      tabs: tabs.map((tab) => ({
        id: tab.id,
        kind: tab.kind,
        preview: tab.kind === "conversation" ? tab.preview : undefined,
        conversationId:
          tab.kind === "conversation" || tab.kind === "jobThread"
            ? tab.conversationId
            : null,
      })),
      openPanelTab,
      openConversationTab,
    };
  }, [activeTabId, openConversationTab, openPanelTab, tabs]);

  const value = useMemo<WorkspaceTabsContextValue>(
    () => ({
      conversationSurfaces,
      tabs,
      activeTab,
      activeTabId,
      conversationTabsReady,
      requestUrlNavigation,
      peekUrlNavigation,
      consumeUrlNavigation,
      requestUrlPush,
      consumeUrlPush,
      setPanelTabMeta,
      restoreGitReviewTab,
      keepTabOpen,
      moveTab,
      setTabDirty,
      resetTabs,
      ...guardedActions
    }),
    [
      conversationSurfaces,
      activeTab,
      activeTabId,
      conversationTabsReady,
      guardedActions,
      peekUrlNavigation,
      consumeUrlNavigation,
      consumeUrlPush,
      keepTabOpen,
      moveTab,
      restoreGitReviewTab,
      requestUrlNavigation,
      requestUrlPush,
      setPanelTabMeta,
      resetTabs,
      setTabDirty,
      tabs
    ]
  );

  return <WorkspaceTabsContext.Provider value={value}>{children}</WorkspaceTabsContext.Provider>;
}

export function useWorkspaceTabs(): WorkspaceTabsContextValue {
  const context = useContext(WorkspaceTabsContext);
  if (!context) {
    throw new Error("useWorkspaceTabs must be used within a WorkspaceTabsProvider");
  }
  return context;
}
