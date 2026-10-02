import { createInitialConversation, type ConversationState, type ConversationsState } from "./conversationState";
import { isUuid } from "./conversationMessageUtils";

const keyFor = (userId: string, projectId: string) =>
  `instafy:conversation-drafts:${JSON.stringify([userId, projectId])}`;
const MAX_DRAFTS = 50;
const MAX_STORED_LENGTH = 1_000_000;

/** Only unsent text/editor state and the identity needed to reopen its composer.
 * History, files, runtime authority and attachments are never stored here. */
export function saveConversationDrafts(userId: string, state: ConversationsState): void {
  try {
    const key = keyFor(userId, state.projectKey);
    const drafts = state.conversations.filter(c => c.draft.trim() && c.lifecycleStatus !== "deleted").slice(-MAX_DRAFTS).map(c => ({
      localId: c.localId, controllerId: c.controllerId, title: c.title,
      visibility: c.visibility, draft: c.draft, draftEditorState: c.draftEditorState,
      createdAt: c.createdAt, lifecycleStatus: c.lifecycleStatus,
    }));
    if (!drafts.length) { if (sessionStorage.getItem(key)) sessionStorage.removeItem(key); return; }
    const serialized = JSON.stringify({ drafts, sequence: state.sequence });
    if (serialized.length <= MAX_STORED_LENGTH) {
      if (sessionStorage.getItem(key) !== serialized) sessionStorage.setItem(key, serialized);
    }
    else sessionStorage.removeItem(key);
  } catch { /* Storage unavailable: retain the existing in-memory draft. */ }
}

export function restoreConversationDrafts(userId: string, state: ConversationsState): ConversationsState {
  try {
    const serialized = sessionStorage.getItem(keyFor(userId, state.projectKey));
    if (!serialized || serialized.length > MAX_STORED_LENGTH) return state;
    const saved = JSON.parse(serialized);
    if (!Array.isArray(saved?.drafts)) return state;
    const conversations = [...state.conversations];
    for (const entry of saved.drafts.slice(-MAX_DRAFTS)) {
      if (!entry || typeof entry.localId !== "string" || !entry.localId ||
          typeof entry.draft !== "string" || !entry.draft.trim()) continue;
      const controllerId = isUuid(entry.controllerId) ? entry.controllerId : null;
      const index = conversations.findIndex(c => c.localId === entry.localId ||
        (controllerId && c.controllerId === controllerId));
      const existing = index >= 0 ? conversations[index] : null;
      if (existing?.draft.trim()) continue;
      const conversation: ConversationState = {
        ...(existing ?? createInitialConversation({ localId: entry.localId, controllerId })),
        controllerId: existing?.controllerId ?? controllerId,
        title: existing?.controllerId ? existing.title : typeof entry.title === "string" ? entry.title : "New chat",
        visibility: existing?.controllerId ? existing.visibility : entry.visibility === "private" ? "private" : "public",
        lifecycleStatus: existing?.controllerId ? existing.lifecycleStatus
          : entry.lifecycleStatus === "hidden" || entry.lifecycleStatus === "archived" ? entry.lifecycleStatus : "active",
        createdAt: existing?.createdAt ?? (Number.isFinite(entry.createdAt) ? entry.createdAt : Date.now()),
        draft: entry.draft,
        draftEditorState: typeof entry.draftEditorState === "string" ? entry.draftEditorState : null,
        // A saved controller chat may have been titled or written in since;
        // the chat list confirms both (see remoteSummaryPending).
        ...(!existing?.controllerId && controllerId ? { remoteSummaryPending: true } : {}),
      };
      if (index >= 0) conversations[index] = conversation;
      else conversations.push(conversation);
    }
    return {
      ...state, conversations,
      sequence: Number.isSafeInteger(saved.sequence) ? Math.max(state.sequence, saved.sequence) : state.sequence,
    };
  } catch { return state; }
}
