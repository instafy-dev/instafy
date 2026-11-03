import { useState } from "react";
import { ChatLines, Folder } from "iconoir-react";
const noop = () => {};
const notify = (text: string) =>
  window.dispatchEvent(new CustomEvent("review:status", { detail: text }));
const conversations = [
  {
    localId: "chat-1",
    title: "Review browser navigation",
    lifecycleStatus: "active",
  },
  { localId: "chat-2", title: "Website research", lifecycleStatus: "active" },
];
export const useProject = () => ({
  activeProjectId: "review-project",
  projectCapabilitiesResolved: true,
  canWriteProject: true,
});
export const useAuth = () => ({ user: { id: "review-user" } });
export const useConversations = () => ({
  activeConversationId: "chat-1",
  conversations,
  createConversation: () => ({ localId: "new-chat" }),
  setConversationDraft: noop,
  setConversationTitle: noop,
  setConversationLifecycleStatus: noop,
  setConversationControllerId: noop,
});
const availability = { issue: null, recoveryVersion: 0, reportFailure: noop };
export const useWorkspaceAvailability = () => availability;
export const useWorkspaceUi = () => ({ requestConversationInvite: noop });
export const useStatus = () => ({ showStatus: notify });
export function useWorkspaceTabs() {
  const [activeTabId, setActive] = useState("chat-1");
  const [tabs, setTabs] = useState([
    {
      id: "chat-1",
      kind: "conversation",
      conversationId: "chat-1",
      title: "Review browser navigation",
      icon: <ChatLines className="h-4 w-4" />,
      dirty: false,
      closable: true,
      draggable: false,
    },
    {
      id: "chat-2",
      kind: "conversation",
      conversationId: "chat-2",
      title: "Website research",
      icon: <ChatLines className="h-4 w-4" />,
      dirty: false,
      closable: true,
      draggable: false,
    },
    {
      id: "files",
      kind: "panel",
      title: "Files",
      icon: <Folder className="h-4 w-4" />,
      dirty: false,
      closable: true,
      draggable: false,
    },
  ]);
  return {
    tabs,
    activeTabId,
    focusTab: setActive,
    closeTab: (id: string) =>
      setTabs((previous) => previous.filter((tab) => tab.id !== id)),
    keepTabOpen: noop,
    moveTab: noop,
    requestUrlPush: noop,
    openConversationTab: noop,
    openGitReviewTab: () =>
      notify(
        "Review version selected. This fixture does not contact a workspace.",
      ),
  };
}
const entries = [
  {
    subject: "Bring browser controls into the shared toolbar",
    authorName: "Alexandra Montgomery",
    actor: "user",
    age: 60000,
  },
  {
    subject: "Agent save: preserve draft attachments when returning from Home",
    authorName: "Instafy",
    actor: "service",
    age: 6 * 86400000,
  },
  {
    subject: "Agent save: improve account navigation and permission recovery",
    authorName: "Instafy",
    actor: "service",
    age: 7 * 86400000,
    resolvedBy: "assistant",
  },
  {
    subject:
      "Update documentation and onboarding examples for the review workspace",
    authorName: "Morgan Cooper with a deliberately long display name",
    actor: "external",
    age: 8 * 86400000,
  },
].map((entry, index) => ({
  ...entry,
  commit: String(index + 1).padStart(40, "0"),
  shortCommit: String(index + 1).padStart(8, "0"),
  firstParent: "0".repeat(40),
  committedAt: new Date(Date.now() - entry.age).toISOString(),
  authorEmail: "review@example.invalid",
  resolvedBy: entry.resolvedBy ?? null,
}));
export const controllerClient = {
  workspace: {
    git: {
      fetchHistory: async () => ({
        supported: true,
        entries,
        branch: "main",
        headRef: "main",
        hasMore: false,
        busy: false,
        error: null,
      }),
      fetchStatus: async () => ({
        supported: true,
        dirtyCount: 0,
        dirtyPaths: [],
        pathGroups: [],
      }),
      fetchRecovery: async () => ({
        status: "unsupported",
        entries: [],
        originId: "review-origin",
        originMode: "hosted",
      }),
      revertCommit: async () => ({ error: "This is a local visual preview." }),
      syncToRemote: async () => ({ error: "This is a local visual preview." }),
    },
    files: { readAt: async () => ({ content: "" }) },
    save: { changes: async () => ({}) },
  },
  conversations: { updateMetadata: async () => ({}) },
};
