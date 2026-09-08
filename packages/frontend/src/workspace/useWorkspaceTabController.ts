import { useCallback, type MutableRefObject } from "react";
import type { StudioPanel } from "../screens/studio/types";
import type { ConversationState } from "../conversations/ConversationsProvider";
import type { WorkspaceTabState } from "./workspaceTabFactories";
import type {
  PersistedWorkspaceGitReviewState,
  PersistedWorkspaceTabsState,
} from "./workspaceTabPersistence";
import { useWorkspaceTabMutationController } from "./useWorkspaceTabMutationController";
import { useWorkspaceTabOpeners } from "./useWorkspaceTabOpeners";
import { useWorkspaceTabUrlIntents } from "./useWorkspaceTabUrlIntents";

interface UseWorkspaceTabControllerArgs {
  activeConversationId: string | null;
  conversations: ConversationState[];
  createConversation: (options?: { title?: string; select?: boolean }) => ConversationState;
  selectConversation: (conversationId: string) => void;
  markConversationRead: (conversationId: string) => void;
  setActiveFile: (fileId: string | null) => void;
  setActivePanel: (panel: StudioPanel) => void;
  workspaceProjectId: string | null;
  canPersistTabs: boolean;
  tabsRef: MutableRefObject<WorkspaceTabState[]>;
  activeTabIdRef: MutableRefObject<string | null>;
  activeConversationIdRef: MutableRefObject<string | null>;
  suppressPanelSyncRef: MutableRefObject<StudioPanel | null>;
  urlNavigationModeRef: MutableRefObject<"push" | "replace" | null>;
  persistedStateRef: MutableRefObject<PersistedWorkspaceTabsState | null>;
  persistedGitReviewStateRef: MutableRefObject<PersistedWorkspaceGitReviewState | null>;
  setTabs: (tabs: WorkspaceTabState[]) => void;
  setActiveTabId: (tabId: string | null) => void;
}

export function useWorkspaceTabController({
  activeConversationId,
  conversations,
  createConversation,
  selectConversation,
  markConversationRead,
  setActiveFile,
  setActivePanel,
  workspaceProjectId,
  canPersistTabs,
  tabsRef,
  activeTabIdRef,
  activeConversationIdRef,
  suppressPanelSyncRef,
  urlNavigationModeRef,
  persistedStateRef,
  persistedGitReviewStateRef,
  setTabs,
  setActiveTabId,
}: UseWorkspaceTabControllerArgs) {
  const {
    requestUrlNavigation,
    peekUrlNavigation,
    consumeUrlNavigation,
    requestUrlPush,
    consumeUrlPush,
  } = useWorkspaceTabUrlIntents({ urlNavigationModeRef });
  const commitTabs = useCallback(
    (nextTabs: WorkspaceTabState[]) => {
      tabsRef.current = nextTabs;
      // Reconciliation can run before the persistence effect. Update its
      // source immediately so replacing a preview cannot resurrect its tab.
      if (workspaceProjectId && canPersistTabs) {
        const current = persistedStateRef.current ?? { projects: {} };
        const conversationTabs = nextTabs.filter((tab) => tab.kind === "conversation");
        persistedStateRef.current = {
          projects: {
            ...current.projects,
            [workspaceProjectId]: {
              conversations: conversationTabs.map((tab) => tab.conversationId),
              activeConversationId: conversationTabs.find((tab) => tab.id === activeTabIdRef.current)?.conversationId,
              previewConversationId: conversationTabs.find((tab) => tab.preview)?.conversationId,
            },
          },
        };
      }
      setTabs(nextTabs);
    },
    [activeTabIdRef, canPersistTabs, persistedStateRef, setTabs, tabsRef, workspaceProjectId],
  );

  const {
    setActiveTabInternal,
    ensureTabForPanel,
    focusTab,
    keepTabOpen,
    closeTab,
    moveTab,
    setTabDirty,
    setPanelTabMeta,
    resetTabs,
  } = useWorkspaceTabMutationController({
    activeConversationId,
    selectConversation,
    markConversationRead,
    setActiveFile,
    setActivePanel,
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
  });

  const {
    openConversationTab,
    openJobThreadTab,
    openPanelTab,
    openFileTab,
    openGitDiffTab,
    openGitReviewTab,
    restoreGitReviewTab,
    openExplorerTab,
  } = useWorkspaceTabOpeners({
    activeConversationId,
    conversations,
    createConversation,
    workspaceProjectId,
    tabsRef,
    activeTabIdRef,
    persistedGitReviewStateRef,
    commitTabs,
    setActiveTabInternal,
    ensureTabForPanel,
  });

  return {
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
  };
}
