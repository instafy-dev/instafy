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
import { isUUID } from "../utils/uuid";
import type { WorkspaceGitReviewSource } from "./gitReviewTypes";
import { useWorkspaceTabController } from "./useWorkspaceTabController";
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
  tabs: WorkspaceTabState[];
  activeTab: WorkspaceTabState | null;
  activeTabId: string | null;
  openPanelTab: (panel: StudioPanel, options?: { activate?: boolean }) => void;
  openConversationTab: (
    conversationId: string,
    options?: { activate?: boolean; fallbackConversation?: ConversationState | null }
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
  openFileTab: (file: Pick<CodeFile, "id" | "path" | "label">) => void;
  openGitDiffTab: (options: {
    path: string;
    title?: string;
    commitRange?: ChatMessageCommitRange | null;
  }) => void;
  openGitReviewTab: (review: WorkspaceGitReviewSource) => void;
  restoreGitReviewTab: (tabId: string) => boolean;
  openExplorerTab: (options: { rootPath: string; title?: string }) => void;
  focusTab: (tabId: string) => void;
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
      }>;
      openPanelTab: (panel: StudioPanel, options?: { activate?: boolean }) => void;
      openConversationTab: (
        conversationId: string,
        options?: { activate?: boolean; fallbackConversation?: ConversationState | null },
      ) => void;
    };
  }
}

export function WorkspaceTabsProvider({ children }: { children: ReactNode }) {
  const { activePanel, setActivePanel } = useWorkspaceUi();
  const { workspace, setActiveFile } = useCode();
  const {
    conversations,
    activeConversationId,
    selectConversation,
    markConversationRead,
    createConversation
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
    workspaceProjectId,
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
      nextConversationTabs.push(createTabForConversation(conversation));
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
      nextConversationTabs.push(createTabForConversation(activeConversation));
    }

    const persistedConversationCount = projectState.conversations.length;
    if (persistedConversationCount > 0 && nextConversationTabs.length === 0) {
      const fallback = conversations[0] ?? null;
      if (fallback) {
        nextConversationTabs.push(createTabForConversation(fallback));
      }
    }

    const nextTabs: WorkspaceTabState[] = [...nextConversationTabs, ...nonConversationTabs];
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
    if (!workspaceProjectId) {
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
      const conversationTabs = [createTabForConversation(conversation)];
      const nextTabs: WorkspaceTabState[] = [...conversationTabs, ...nonConversationTabs];
      tabsRef.current = nextTabs;
      setTabs(nextTabs);
      const target = nextTabs.find(
        (tab) => tab.kind === "conversation" && tab.conversationId === conversation.localId
      );
      if (target) {
        setActiveTabInternal(target, { syncPanel: false });
      }
      seenConversationIdsRef.current = new Set(conversations.map((entry) => entry.localId));
      conversationAutoOpenStartRef.current = Date.now();
      appliedProjectRef.current = workspaceProjectId;
      return;
    }

    if (appliedProjectRef.current === workspaceProjectId) {
      return;
    }

    applyPersistedTabs();
    appliedProjectRef.current = workspaceProjectId;
  }, [activeConversationId, applyPersistedTabs, conversations, setActiveTabInternal, workspaceProjectId]);

  useEffect(() => {
    const currentTabs = tabsRef.current;
    const conversationLookup = new Map(conversations.map((conversation) => [conversation.localId, conversation]));
    const nonConversationTabs = currentTabs.filter((tab) => tab.kind !== "conversation");
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
      if (tab.title === conversation.title && tab.badge === badge && tab.icon === icon && tab.closable) {
        return tab;
      }
      changed = true;
      return { ...tab, title: conversation.title, badge, icon, closable: true };
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
        nextConversationTabs.push(createTabForConversation(conversation));
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
      nextConversationTabs.length === 0 && conversations.length > 0 && (hadConversationTabs || persistedOrder === null);
    if (shouldEnsureFallback) {
      const fallback = conversations[0] ?? null;
      if (fallback) {
        nextConversationTabs.push(createTabForConversation(fallback));
        changed = true;
      }
    }

    const nextTabs: WorkspaceTabState[] = [...nextConversationTabs, ...nonConversationTabs];
    const orderChanged =
      nextTabs.length !== currentTabs.length ||
      nextTabs.some((tab, index) => tab.id !== currentTabs[index]?.id);
    const payloadChanged = nextTabs.some((tab, index) => tab !== currentTabs[index]);

    if (orderChanged || payloadChanged || changed) {
      tabsRef.current = nextTabs;
      setTabs(nextTabs);
    }
  }, [conversations, workspaceProjectId]);

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
        const insertAt = (() => {
          const index = currentTabs.findIndex((tab) => tab.kind !== "conversation");
          return index === -1 ? currentTabs.length : index;
        })();
      const tab = createTabForConversation(conversation);
      const nextTabs = [...currentTabs.slice(0, insertAt), tab, ...currentTabs.slice(insertAt)];
      tabsRef.current = nextTabs;
      setTabs(nextTabs);
      targetTab = tab;
    }
    if (!targetTab) {
      return;
    }
    setActiveTabInternal(targetTab, { syncPanel: false, syncConversation: false });
  }, [activeConversationId, activePanel, conversations, setActiveTabInternal]);

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
          title: nextTitle
        };
      }
      return tab;
    });
    if (changed) {
      tabsRef.current = nextTabs;
      setTabs(nextTabs);
    }
  }, [workspace.files]);

  useEffect(() => {
    if (!workspaceProjectId) {
      return;
    }
    if (appliedProjectRef.current !== workspaceProjectId) {
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
          activeConversationId: activeConversationIdPersisted
        }
      }
    };
    persistedStateRef.current = nextState;
    persistWorkspaceTabsState(nextState);
  }, [activeTabId, tabs, workspaceProjectId]);

  useEffect(() => {
    if (!workspaceProjectId) {
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
  }, [tabs, workspaceProjectId]);

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
    if (typeof window === "undefined") {
      return;
    }
    window.__INSTAFY_WORKSPACE_TABS_DEBUG__ = {
      activeTabId,
      tabs: tabs.map((tab) => ({
        id: tab.id,
        kind: tab.kind,
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
      tabs,
      activeTab,
      activeTabId,
      openPanelTab,
      openConversationTab,
      openJobThreadTab,
      requestUrlNavigation,
      peekUrlNavigation,
      consumeUrlNavigation,
      requestUrlPush,
      consumeUrlPush,
      setPanelTabMeta,
      openFileTab,
      openGitDiffTab,
      openGitReviewTab,
      restoreGitReviewTab,
      openExplorerTab,
      focusTab,
      closeTab,
      moveTab,
      setTabDirty,
      resetTabs
    }),
    [
      activeTab,
      activeTabId,
      closeTab,
      peekUrlNavigation,
      consumeUrlNavigation,
      consumeUrlPush,
      focusTab,
      moveTab,
      openConversationTab,
      openJobThreadTab,
      openExplorerTab,
      openFileTab,
      openGitDiffTab,
      openGitReviewTab,
      restoreGitReviewTab,
      openPanelTab,
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
