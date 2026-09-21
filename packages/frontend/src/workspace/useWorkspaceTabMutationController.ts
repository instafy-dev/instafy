import { useStudioDraftStore } from "./StudioDrafts";
import { useCallback, type MutableRefObject, type ReactNode } from "react";
import type { StudioPanel } from "../screens/studio/types";
import { studioPerformance } from "../telemetry/studioPerformance";
import { insertPreviewTab, isUtilityPreviewPanel, isWorkspacePreviewTab } from "./workspacePreviewTabs";
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
  onActivatePanel?: (panel: StudioPanel) => void;
  workspaceProjectId: string | null;
  canPersistTabs: boolean;
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
  onActivatePanel,
  workspaceProjectId,
  canPersistTabs,
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
  const draftStore = useStudioDraftStore();
  const setActiveTabInternal = useCallback(
    (
      nextTab: WorkspaceTabState,
      options?: { syncPanel?: boolean; syncConversation?: boolean; restorePanel?: boolean },
    ) => {
      if (nextTab.id !== activeTabIdRef.current &&
          (nextTab.kind === "conversation" || nextTab.kind === "jobThread") && workspaceProjectId) {
        studioPerformance.beginConversation(workspaceProjectId, nextTab.conversationId);
      } else if (nextTab.id !== activeTabIdRef.current && nextTab.kind !== "conversation" &&
          !(nextTab.kind === "panel" && nextTab.panel === "chat")) {
        studioPerformance.cancelConversation();
      }
      activeTabIdRef.current = nextTab.id;
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
        if (nextTab.kind === "panel" && options?.restorePanel) onActivatePanel?.(nextTab.panel);
      }
    },
    [
      activeConversationId,
      activeConversationIdRef,
      activeTabIdRef,
      markConversationRead,
      selectConversation,
      setActiveFile,
      setActivePanel,
      onActivatePanel,
      setActiveTabId,
      suppressPanelSyncRef,
      workspaceProjectId,
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
      // A draft can be entered and navigation requested in the same React batch.
      // Read the store synchronously so effect timing cannot replace its tab.
      const snapshot = draftStore?.getSnapshot();
      const protectedPanels = new Set([...(snapshot?.drafts ?? []), ...(snapshot?.protections ?? [])].map(item => item.panel));
      const currentTabs = tabsRef.current.map(tab => tab.kind === "panel" && protectedPanels.has(tab.panel)
        ? { ...tab, dirty: true, preview: false } : tab);
      const nextTab = createTabForPanel(panel);
      nextTab.dirty = protectedPanels.has(panel);
      nextTab.preview = isUtilityPreviewPanel(panel) && !nextTab.dirty;
      commitTabs(insertPreviewTab(currentTabs, nextTab));
      return nextTab;
    },
    [commitTabs, draftStore, tabsRef],
  );

  const focusTab = useCallback(
    (tabId: string) => {
      const tab = tabsRef.current.find((item) => item.id === tabId);
      if (!tab) {
        return;
      }
      setActiveTabInternal(tab, { restorePanel: true });
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
        if (workspaceProjectId && canPersistTabs) {
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
                previewConversationId: remainingConversationTabs.find((tab) => tab.preview)?.conversationId,
              },
            },
          };
          persistedStateRef.current = nextState;
          persistWorkspaceTabsState(nextState);
        }
        commitTabs(nextTabsWithCloseability);
        if (isClosingActiveTab) {
          if (fallbackTab) {
            setActiveTabInternal(fallbackTab, { restorePanel: true });
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
          setActiveTabInternal(fallback, { restorePanel: true });
        } else {
          setActiveTabId(null);
        }
      }
    },
    [
      activeTabIdRef,
      canPersistTabs,
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

  const keepTabOpen = useCallback((tabId: string) => {
    const currentTabs = tabsRef.current;
    const target = currentTabs.find((tab) => tab.id === tabId);
    if (!isWorkspacePreviewTab(target)) return;
    commitTabs(currentTabs.map((tab) => tab.id === tabId ? { ...target, preview: false } : tab));
  }, [commitTabs, tabsRef]);

  const moveTab = useCallback(
    (tabId: string, targetIndex: number) => {
      const currentTabs = tabsRef.current;
      const currentIndex = currentTabs.findIndex((tab) => tab.id === tabId);
      if (currentIndex === -1 || !currentTabs[currentIndex].draggable) {
        return;
      }
      const clampedIndex = Math.max(0, Math.min(targetIndex, currentTabs.length - 1));
      if (currentIndex === clampedIndex) {
        keepTabOpen(tabId);
        return;
      }
      const nextTabs = [...currentTabs];
      const [moved] = nextTabs.splice(currentIndex, 1);
      nextTabs.splice(clampedIndex, 0, isWorkspacePreviewTab(moved) ? { ...moved, preview: false } : moved);
      commitTabs(nextTabs);
    },
    [commitTabs, keepTabOpen, tabsRef],
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
      nextTabs[index] = isWorkspacePreviewTab(target) && dirty
        ? { ...target, dirty, preview: false }
        : { ...target, dirty };
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
    keepTabOpen,
    closeTab,
    moveTab,
    setTabDirty,
    setPanelTabMeta,
    resetTabs,
  };
}
