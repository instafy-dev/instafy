import { useCallback, type MutableRefObject, type ReactNode } from "react";
import type { StudioPanel } from "../screens/studio/types";
import {
  createTabForPanel,
  getTabIdForConversation,
  type WorkspaceConversationTabState,
  type WorkspaceTabState,
} from "./workspaceTabFactories";
import {
  persistWorkspaceTabsState,
  type PersistedWorkspaceTabsState,
} from "./workspaceTabPersistence";

interface UseWorkspaceTabMutationControllerArgs {
  activeConversationId: string | null;
  selectConversation: (conversationId: string) => void;
  markConversationRead: (conversationId: string) => void;
  setActiveFile: (fileId: string | null) => void;
  setActivePanel: (panel: StudioPanel) => void;
  workspaceProjectId: string | null;
  tabsRef: MutableRefObject<WorkspaceTabState[]>;
  activeTabIdRef: MutableRefObject<string | null>;
  activeConversationIdRef: MutableRefObject<string | null>;
  suppressPanelSyncRef: MutableRefObject<StudioPanel | null>;
  urlNavigationModeRef: MutableRefObject<"push" | "replace" | null>;
  requestUrlNavigation?: (mode: "push" | "replace") => void;
  persistedStateRef: MutableRefObject<PersistedWorkspaceTabsState | null>;
  commitTabs: (tabs: WorkspaceTabState[]) => void;
  setActiveTabId: (tabId: string | null) => void;
}

export function useWorkspaceTabMutationController({
  activeConversationId,
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
  requestUrlNavigation,
  persistedStateRef,
  commitTabs,
  setActiveTabId,
}: UseWorkspaceTabMutationControllerArgs) {
  const setActiveTabInternal = useCallback(
    (
      nextTab: WorkspaceTabState,
      options?: { syncPanel?: boolean; syncConversation?: boolean },
    ) => {
      setActiveTabId(nextTab.id);
      if (nextTab.kind === "file") {
        setActiveFile(nextTab.fileId);
      } else if (nextTab.kind === "panel") {
        if (nextTab.panel !== "code") {
          setActiveFile(null);
        }
      } else if (nextTab.kind === "jobThread") {
        setActiveFile(null);
      } else {
        setActiveFile(null);
      }

      if (
        (nextTab.kind === "conversation" || nextTab.kind === "jobThread") &&
        options?.syncConversation !== false
      ) {
        const conversationId = nextTab.conversationId;
        activeConversationIdRef.current = conversationId;
        if (activeConversationId !== conversationId) {
          selectConversation(conversationId);
        }
        markConversationRead(conversationId);
      }

      let panelToSync: StudioPanel | null = null;
      if (nextTab.kind === "conversation" || nextTab.kind === "jobThread") {
        panelToSync = "chat";
      } else if (nextTab.kind === "explorer") {
        panelToSync = "code";
      } else if (nextTab.kind === "panel") {
        panelToSync = nextTab.panel;
      } else if (nextTab.kind === "file") {
        panelToSync = nextTab.panel;
      }

      if (panelToSync && options?.syncPanel !== false) {
        suppressPanelSyncRef.current = panelToSync;
        setActivePanel(panelToSync);
      }
    },
    [
      activeConversationId,
      activeConversationIdRef,
      markConversationRead,
      selectConversation,
      setActiveFile,
      setActivePanel,
      setActiveTabId,
      suppressPanelSyncRef,
    ],
  );

  const ensureTabForPanel = useCallback(
    (panel: StudioPanel): WorkspaceTabState => {
      const existing = tabsRef.current.find(
        (tab) => tab.kind === "panel" && tab.panel === panel,
      );
      if (existing) {
        return existing;
      }
      const nextTab = createTabForPanel(panel);
      commitTabs([...tabsRef.current, nextTab]);
      return nextTab;
    },
    [commitTabs, tabsRef],
  );

  const focusTab = useCallback(
    (tabId: string) => {
      const tab = tabsRef.current.find((item) => item.id === tabId);
      if (!tab) {
        return;
      }
      setActiveTabInternal(tab);
    },
    [setActiveTabInternal, tabsRef],
  );

  const closeTab = useCallback(
    (tabId: string) => {
      const currentTabs = tabsRef.current;
      const target = currentTabs.find((tab) => tab.id === tabId);
      if (!target || !target.closable) {
        return;
      }
      const isClosingActiveTab = activeTabIdRef.current === tabId;
      if (isClosingActiveTab && target.kind === "panel") {
        if (requestUrlNavigation) requestUrlNavigation("replace");
        else urlNavigationModeRef.current = "replace";
      }
      if (target.kind === "conversation") {
        const closeIndex = currentTabs.findIndex((tab) => tab.id === tabId);
        const nextTabs = currentTabs
          .filter((tab) => tab.id !== tabId)
          .filter(
            (tab) =>
              tab.kind !== "jobThread" || tab.conversationId !== target.conversationId,
          );
        const remainingConversationTabs = nextTabs.filter(
          (tab): tab is WorkspaceConversationTabState => tab.kind === "conversation",
        );
        const nextTabsWithCloseability = nextTabs.map((tab) =>
          tab.kind === "conversation" ? { ...tab, closable: true } : tab,
        );
        const fallbackIndex =
          isClosingActiveTab && nextTabsWithCloseability.length > 0
            ? Math.min(Math.max(closeIndex, 0), nextTabsWithCloseability.length - 1)
            : -1;
        const fallbackTab =
          fallbackIndex >= 0 ? nextTabsWithCloseability[fallbackIndex] ?? null : null;
        if (workspaceProjectId) {
          const currentState = persistedStateRef.current ?? { projects: {} };
          const conversationsToPersist = remainingConversationTabs.map(
            (tab) => tab.conversationId,
          );
          const nextActiveConversationId =
            fallbackTab?.kind === "conversation" ? fallbackTab.conversationId : undefined;
          const nextState: PersistedWorkspaceTabsState = {
            projects: {
              ...currentState.projects,
              [workspaceProjectId]: {
                conversations: conversationsToPersist,
                activeConversationId: nextActiveConversationId,
              },
            },
          };
          persistedStateRef.current = nextState;
          persistWorkspaceTabsState(nextState);
        }
        commitTabs(nextTabsWithCloseability);
        if (isClosingActiveTab) {
          if (fallbackTab) {
            setActiveTabInternal(fallbackTab);
            return;
          }
          setActiveTabId(null);
        }
        return;
      }
      const nextTabs = currentTabs.filter((tab) => tab.id !== tabId);
      commitTabs(nextTabs);
      if (isClosingActiveTab) {
        const fallback = nextTabs[nextTabs.length - 1] ?? nextTabs[0] ?? null;
        if (fallback) {
          setActiveTabInternal(fallback);
        } else {
          setActiveTabId(null);
        }
      }
    },
    [
      activeTabIdRef,
      commitTabs,
      persistedStateRef,
      requestUrlNavigation,
      setActiveTabId,
      setActiveTabInternal,
      tabsRef,
      urlNavigationModeRef,
      workspaceProjectId,
    ],
  );

  const moveTab = useCallback(
    (tabId: string, targetIndex: number) => {
      const currentTabs = tabsRef.current;
      const currentIndex = currentTabs.findIndex((tab) => tab.id === tabId);
      if (currentIndex === -1 || !currentTabs[currentIndex].draggable) {
        return;
      }
      const clampedIndex = Math.max(0, Math.min(targetIndex, currentTabs.length - 1));
      if (currentIndex === clampedIndex) {
        return;
      }
      const nextTabs = [...currentTabs];
      const [moved] = nextTabs.splice(currentIndex, 1);
      nextTabs.splice(clampedIndex, 0, moved);
      commitTabs(nextTabs);
    },
    [commitTabs, tabsRef],
  );

  const setTabDirty = useCallback(
    (tabId: string, dirty: boolean) => {
      const currentTabs = tabsRef.current;
      const index = currentTabs.findIndex((tab) => tab.id === tabId);
      if (index === -1) {
        return;
      }
      const target = currentTabs[index];
      if (target.dirty === dirty) {
        return;
      }
      const nextTabs = [...currentTabs];
      nextTabs[index] = { ...target, dirty };
      commitTabs(nextTabs);
    },
    [commitTabs, tabsRef],
  );

  const setPanelTabMeta = useCallback(
    (panel: StudioPanel, meta: { title?: string; icon?: ReactNode }) => {
      const currentTabs = tabsRef.current;
      const index = currentTabs.findIndex(
        (tab) => tab.kind === "panel" && tab.panel === panel,
      );
      if (index === -1) {
        return;
      }
      const target = currentTabs[index];
      if (target.kind !== "panel") {
        return;
      }
      const title = meta.title ?? target.title;
      const icon = meta.icon ?? target.icon;
      if (title === target.title && icon === target.icon) {
        return;
      }
      const nextTabs = [...currentTabs];
      nextTabs[index] = { ...target, title, icon };
      commitTabs(nextTabs);
    },
    [commitTabs, tabsRef],
  );

  const resetTabs = useCallback(() => {
    const conversationTabs = tabsRef.current.filter(
      (tab): tab is WorkspaceConversationTabState => tab.kind === "conversation",
    );
    if (conversationTabs.length === tabsRef.current.length) {
      return;
    }
    commitTabs(conversationTabs);
    const activeConversationIdValue = activeConversationIdRef.current;
    const fallback =
      (activeConversationIdValue
        ? conversationTabs.find(
            (tab) => tab.id === getTabIdForConversation(activeConversationIdValue),
          )
        : null) ??
      conversationTabs[conversationTabs.length - 1] ??
      null;
    if (fallback) {
      setActiveTabInternal(fallback, { syncConversation: false });
    } else {
      setActiveTabId(null);
    }
  }, [
    activeConversationIdRef,
    commitTabs,
    setActiveTabId,
    setActiveTabInternal,
    tabsRef,
  ]);

  return {
    setActiveTabInternal,
    ensureTabForPanel,
    focusTab,
    closeTab,
    moveTab,
    setTabDirty,
    setPanelTabMeta,
    resetTabs,
  };
}
