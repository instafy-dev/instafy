import { useCallback, type MutableRefObject } from "react";
import type { CodeFile } from "../types";
import type { ChatMessageCommitRange, StudioPanel } from "../screens/studio/types";
import type { ConversationState } from "../conversations/ConversationsProvider";
import type { WorkspaceGitReviewSource } from "./gitReviewTypes";
import {
  createExplorerTab,
  createGitDiffTab,
  createGitReviewTab,
  createTabForConversation,
  createTabForFile,
  createTabForJobThread,
  getTabIdForConversation,
  normalizeExplorerPath,
  type WorkspaceConversationTabState,
  type WorkspaceFileTabState,
  type WorkspaceGitDiffTabState,
  type WorkspaceGitReviewTabState,
  type WorkspaceJobThreadTabState,
  type WorkspaceTabState,
} from "./workspaceTabFactories";
import type { PersistedWorkspaceGitReviewState } from "./workspaceTabPersistence";
import { prepareConversationTabOpen } from "./workspaceConversationPreview";

interface UseWorkspaceTabOpenersArgs {
  activeConversationId: string | null;
  conversations: ConversationState[];
  createConversation: (options?: { title?: string; select?: boolean }) => ConversationState;
  workspaceProjectId: string | null;
  tabsRef: MutableRefObject<WorkspaceTabState[]>;
  activeTabIdRef: MutableRefObject<string | null>;
  persistedGitReviewStateRef: MutableRefObject<PersistedWorkspaceGitReviewState | null>;
  commitTabs: (tabs: WorkspaceTabState[]) => void;
  setActiveTabInternal: (
    nextTab: WorkspaceTabState,
    options?: { syncPanel?: boolean; syncConversation?: boolean },
  ) => void;
  ensureTabForPanel: (panel: StudioPanel) => WorkspaceTabState;
}

export function useWorkspaceTabOpeners({
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
}: UseWorkspaceTabOpenersArgs) {
  const openConversationTab = useCallback(
    (
      conversationId: string,
      options?: {
        activate?: boolean;
        fallbackConversation?: ConversationState | null;
        preview?: boolean;
      },
    ) => {
      if (!conversationId) {
        return;
      }
      const fallbackConversation = options?.fallbackConversation?.localId === conversationId
        ? options.fallbackConversation
        : null;
      const conversation = conversations.find((entry) => entry.localId === conversationId)
        ?? fallbackConversation;
      if (!conversation) {
        const existing = tabsRef.current.find((entry): entry is WorkspaceConversationTabState => (
          entry.kind === "conversation" && entry.conversationId === conversationId
        ));
        if (!existing) return;
        const tab = existing.preview && !options?.preview ? { ...existing, preview: false } : existing;
        if (tab !== existing) commitTabs(tabsRef.current.map((entry) => entry.id === tab.id ? tab : entry));
        if (options?.activate !== false) setActiveTabInternal(tab);
        return;
      }
      if (conversation.lifecycleStatus === "deleted") return;
      const { tabs, tab } = prepareConversationTabOpen(
        tabsRef.current, conversation, conversations, options?.preview === true,
      );
      if (tabs !== tabsRef.current) {
        commitTabs(tabs);
      }
      if (options?.activate === false) {
        return;
      }
      setActiveTabInternal(tab);
    },
    [commitTabs, conversations, setActiveTabInternal, tabsRef],
  );

  const openJobThreadTab = useCallback(
    (
      params: { conversationId: string; jobId: string; title?: string },
      options?: { activate?: boolean },
    ) => {
      const conversationId = params.conversationId?.trim() ?? "";
      const jobId = params.jobId?.trim() ?? "";
      if (!conversationId || !jobId) {
        return;
      }
      const conversation =
        conversations.find((entry) => entry.localId === conversationId) ?? null;
      if (!conversation || conversation.lifecycleStatus === "deleted") {
        return;
      }

      // Opening a run is deliberate work in its conversation, so keep the
      // parent before adding a child tab that must survive chat browsing.
      const keptTabs = tabsRef.current.map((entry) => (
        entry.kind === "conversation" && entry.conversationId === conversationId && entry.preview
          ? { ...entry, preview: false }
          : entry
      ));
      if (keptTabs.some((entry, index) => entry !== tabsRef.current[index])) commitTabs(keptTabs);

      const tabId = `workspace-job-thread-${jobId}`;
      let tab = tabsRef.current.find(
        (entry) => entry.id === tabId,
      ) as WorkspaceJobThreadTabState | undefined;
      if (!tab) {
        const insertAt = (() => {
          const index = tabsRef.current.findIndex(
            (entry) => entry.kind !== "conversation" && entry.kind !== "jobThread",
          );
          return index === -1 ? tabsRef.current.length : index;
        })();
        tab = createTabForJobThread({ ...params, conversationId });
        commitTabs([
          ...tabsRef.current.slice(0, insertAt),
          tab,
          ...tabsRef.current.slice(insertAt),
        ]);
      }

      if (options?.activate === false) {
        return;
      }
      setActiveTabInternal(tab);
    },
    [commitTabs, conversations, setActiveTabInternal, tabsRef],
  );

  const openPanelTab = useCallback(
    (panel: StudioPanel, options?: { activate?: boolean }) => {
      if (panel === "code") {
        if (options?.activate === false) {
          return;
        }
        const fileTabs = [...tabsRef.current]
          .reverse()
          .filter((tab): tab is WorkspaceFileTabState => tab.kind === "file");
        const mostRecentFileTab = fileTabs[0] ?? null;
        if (mostRecentFileTab) {
          setActiveTabInternal(mostRecentFileTab);
        } else {
          setActiveTabInternal(ensureTabForPanel(panel));
        }
        return;
      }
      if (panel === "chat") {
        const resolveDefaultConversationId = (): string | null => {
          if (activeConversationId) {
            const conversation =
              conversations.find((entry) => entry.localId === activeConversationId) ?? null;
            if (conversation && conversation.lifecycleStatus !== "deleted") {
              if (conversation.lifecycleStatus === "active") {
                return activeConversationId;
              }
              const hasOpenTab = tabsRef.current.some(
                (tab) =>
                  tab.kind === "conversation" &&
                  tab.conversationId === activeConversationId,
              );
              if (hasOpenTab) {
                return activeConversationId;
              }
            }
          }
          const conversationTabs = tabsRef.current.filter(
            (tab): tab is WorkspaceConversationTabState => tab.kind === "conversation",
          );
          for (let index = conversationTabs.length - 1; index >= 0; index -= 1) {
            const tab = conversationTabs[index];
            const conversation =
              conversations.find((entry) => entry.localId === tab.conversationId) ?? null;
            if (conversation && conversation.lifecycleStatus !== "deleted") {
              return tab.conversationId;
            }
          }
          const activeConversation =
            conversations.find((entry) => entry.lifecycleStatus === "active") ?? null;
          return activeConversation?.localId ?? null;
        };

        let conversationId = resolveDefaultConversationId();
        if (!conversationId) {
          const conversation = createConversation({
            title: `Conversation ${conversations.length + 1}`,
            select: true,
          });
          conversationId = conversation.localId;
        }
        const tabId = getTabIdForConversation(conversationId);
        let tab = tabsRef.current.find(
          (entry) => entry.id === tabId,
        ) as WorkspaceConversationTabState | undefined;
        if (!tab) {
          const conversation =
            conversations.find((entry) => entry.localId === conversationId) ??
            createConversation({
              title: `Conversation ${conversations.length + 1}`,
              select: false,
            });
          tab = createTabForConversation(conversation);
          commitTabs([...tabsRef.current, tab]);
        }
        if (options?.activate === false) {
          return;
        }
        setActiveTabInternal(tab);
        return;
      }

      const tab = ensureTabForPanel(panel);
      if (options?.activate === false) {
        return;
      }
      setActiveTabInternal(tab);
    },
    [
      activeConversationId,
      commitTabs,
      conversations,
      createConversation,
      ensureTabForPanel,
      setActiveTabInternal,
      tabsRef,
    ],
  );

  const openFileTab = useCallback(
    (file: Pick<CodeFile, "id" | "path" | "label">) => {
      const existing = tabsRef.current.find(
        (tab) => tab.kind === "file" && tab.fileId === file.id,
      );
      const target = existing ?? createTabForFile(file);
      if (!existing) {
        commitTabs([...tabsRef.current, target]);
      }
      setActiveTabInternal(target);
    },
    [commitTabs, setActiveTabInternal, tabsRef],
  );

  const openGitDiffTab = useCallback(
    ({
      path,
      title,
      commitRange,
    }: {
      path: string;
      title?: string;
      commitRange?: ChatMessageCommitRange | null;
    }) => {
      const normalizedPath = path.trim().replace(/^\/+|\/+$/g, "");
      if (!normalizedPath) {
        return;
      }

      const label =
        title && title.trim().length > 0
          ? title
          : `${normalizedPath.split("/").pop() ?? normalizedPath} (diff)`;

      const existing = tabsRef.current.find(
        (tab): tab is WorkspaceGitDiffTabState =>
          tab.kind === "gitDiff" && tab.path === normalizedPath,
      );
      // One diff tab per path; the latest request decides its pinning. An
      // opener without a range asks for the current worktree view, so an
      // existing pinned tab is unpinned rather than silently reused.
      const requestedRange = commitRange ?? null;
      if (existing) {
        const rangeChanged =
          (existing.commitRange?.base ?? null) !== (requestedRange?.base ?? null) ||
          (existing.commitRange?.head ?? null) !== (requestedRange?.head ?? null);
        const target = rangeChanged ? { ...existing, commitRange: requestedRange } : existing;
        if (rangeChanged) {
          commitTabs(tabsRef.current.map((tab) => (tab.id === existing.id ? target : tab)));
        }
        setActiveTabInternal(target);
        return;
      }

      const target = createGitDiffTab(normalizedPath, label, requestedRange);
      commitTabs([...tabsRef.current, target]);
      setActiveTabInternal(target);
    },
    [commitTabs, setActiveTabInternal, tabsRef],
  );

  const openGitReviewTab = useCallback(
    (review: WorkspaceGitReviewSource) => {
      const returnTabId = activeTabIdRef.current;
      if (review.kind === "savedVersion") {
        const existing = tabsRef.current.find(
          (tab): tab is WorkspaceGitReviewTabState =>
            tab.kind === "gitReview" &&
            tab.review.kind === "savedVersion" &&
            tab.review.commit === review.commit,
        );
        if (existing) {
          const updated: WorkspaceGitReviewTabState = {
            ...existing,
            review,
            returnTabId,
            title: `Review ${review.shortCommit}`,
          };
          commitTabs(
            tabsRef.current.map((tab) => (tab.id === existing.id ? updated : tab)),
          );
          setActiveTabInternal(updated);
          return;
        }
      }

      const target = createGitReviewTab(review, returnTabId);
      commitTabs([...tabsRef.current, target]);
      setActiveTabInternal(target);
    },
    [activeTabIdRef, commitTabs, setActiveTabInternal, tabsRef],
  );

  const restoreGitReviewTab = useCallback(
    (tabId: string) => {
      const normalizedId = tabId.trim();
      if (!normalizedId || !workspaceProjectId) {
        return false;
      }
      const existing = tabsRef.current.find(
        (tab): tab is WorkspaceGitReviewTabState =>
          tab.kind === "gitReview" && tab.id === normalizedId,
      );
      if (existing) {
        setActiveTabInternal(existing);
        return true;
      }
      const projectState =
        persistedGitReviewStateRef.current?.projects?.[workspaceProjectId] ?? null;
      const persisted = projectState?.tabs.find((tab) => tab.id === normalizedId) ?? null;
      if (!persisted) {
        return false;
      }
      const target = createGitReviewTab(persisted.review, persisted.returnTabId ?? null, {
        id: normalizedId,
      });
      commitTabs([...tabsRef.current, target]);
      setActiveTabInternal(target);
      return true;
    },
    [
      commitTabs,
      persistedGitReviewStateRef,
      setActiveTabInternal,
      tabsRef,
      workspaceProjectId,
    ],
  );

  const openExplorerTab = useCallback(
    ({ rootPath, title }: { rootPath: string; title?: string }) => {
      const normalized = normalizeExplorerPath(rootPath);
      const label =
        title && title.trim().length > 0
          ? title
          : normalized
            ? normalized.split("/").pop() ?? normalized
            : "Project";
      const tab = createExplorerTab(normalized, label);
      commitTabs([...tabsRef.current, tab]);
      setActiveTabInternal(tab);
    },
    [commitTabs, setActiveTabInternal, tabsRef],
  );

  return {
    openConversationTab,
    openJobThreadTab,
    openPanelTab,
    openFileTab,
    openGitDiffTab,
    openGitReviewTab,
    restoreGitReviewTab,
    openExplorerTab,
  };
}
