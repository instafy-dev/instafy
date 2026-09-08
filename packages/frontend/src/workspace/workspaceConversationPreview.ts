import type { ConversationState } from "../conversations/conversationState";
import {
  createTabForConversation,
  type WorkspaceConversationTabState,
  type WorkspaceTabState,
} from "./workspaceTabFactories";

export function shouldKeepConversationTab(
  tab: WorkspaceConversationTabState,
  conversation: ConversationState | undefined,
  tabs: WorkspaceTabState[],
): boolean {
  return !conversation
    || tab.dirty
    || conversation.draft.length > 0
    || conversation.pendingRunIds.length > 0
    || conversation.awaitingLeaseRunIds.length > 0
    || tabs.some((entry) => entry.kind === "jobThread" && entry.conversationId === tab.conversationId);
}

/** Change only tab ownership; conversation content and runs stay provider-owned. */
export function prepareConversationTabOpen(
  currentTabs: WorkspaceTabState[],
  conversation: ConversationState,
  conversations: ConversationState[],
  preview = false,
): { tabs: WorkspaceTabState[]; tab: WorkspaceConversationTabState } {
  const byId = new Map(conversations.map((entry) => [entry.localId, entry]));
  byId.set(conversation.localId, conversation);
  let changed = false;
  const tabs = currentTabs.map((entry) => {
    if (entry.kind !== "conversation" || !entry.preview) return entry;
    if (shouldKeepConversationTab(entry, byId.get(entry.conversationId), currentTabs)
      || (entry.conversationId === conversation.localId && !preview)) {
      changed = true;
      return { ...entry, preview: false };
    }
    return entry;
  });
  const existing = tabs.find((entry): entry is WorkspaceConversationTabState => (
    entry.kind === "conversation" && entry.conversationId === conversation.localId
  ));
  if (existing) return { tabs: changed ? tabs : currentTabs, tab: existing };

  const tab = createTabForConversation(conversation);
  tab.preview = preview && !shouldKeepConversationTab(tab, conversation, tabs);
  const previewIndex = tab.preview
    ? tabs.findIndex((entry) => entry.kind === "conversation" && entry.preview)
    : -1;
  if (previewIndex >= 0) {
    tabs.splice(previewIndex, 1, tab);
  } else {
    const firstOtherTab = tabs.findIndex((entry) => entry.kind !== "conversation");
    tabs.splice(firstOtherTab === -1 ? tabs.length : firstOtherTab, 0, tab);
  }
  return { tabs, tab };
}
