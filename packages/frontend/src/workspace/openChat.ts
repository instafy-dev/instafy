import type { StudioDestination } from "../navigation/studioNavigation";

type ChatDestination = Extract<StudioDestination, { kind: "conversation" }>;

/**
 * Opens a chat from a press: an open chat's tab, or View on a prompt waiting
 * in another chat. A chat of the open space opens in the press itself, as the
 * Chats list opens one: the chat, its tab and the address change in one
 * render. Through the address alone, the router renders the change later
 * (React Router defers it as a transition) and the chat and its tab follow in
 * the effects after that, so for up to a quarter second the chat on screen
 * stayed there, with its prompts, its Browser view and its sign-in row. A chat
 * of another space goes through the address, which switches the space first.
 */
export function openChat(
  destination: ChatDestination,
  space: {
    activeProjectId: string | null;
    /** The space the loaded chats are of; one commit behind a space switch. */
    conversationsProjectKey: string | null;
    conversations: readonly { localId: string; controllerId?: string | null }[];
    /** Selects the chat and its tab in one update, the address following (a pushed entry). */
    open: (conversationId: string, options: { restoreWorkspace: boolean; preview: boolean }) => void;
    navigate: (destination: ChatDestination) => void;
  },
  options: { restoreWorkspace: boolean },
): void {
  const inOpenSpace = destination.projectId === space.activeProjectId &&
    space.conversationsProjectKey === space.activeProjectId && !destination.jobId && !destination.messageId;
  const chat = inOpenSpace
    ? space.conversations.find((entry) => destination.conversationId
      ? entry.localId === destination.conversationId
      : Boolean(destination.conversationControllerId) && entry.controllerId === destination.conversationControllerId) ?? null
    : null;
  if (!chat) {
    space.navigate(destination);
    return;
  }
  space.open(chat.localId, { restoreWorkspace: options.restoreWorkspace, preview: true });
}
