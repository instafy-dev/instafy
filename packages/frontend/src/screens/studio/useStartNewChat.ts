import { useCallback } from "react";
import { useConversations } from "../../conversations/ConversationsProvider";
import { findReusableBlankConversation, isReusableBlankConversation } from "../../conversations/conversationAutoTitle";
import { NEW_CHAT_TITLE } from "../../conversations/conversationState";
import { controllerClient } from "../../sdk/instafy";
import { isUUID } from "../../utils/uuid";

/** What the empty chat New chat makes says before the person writes. */
export const NEW_CHAT_GREETING = "How can I help with your space?";

/**
 * New chat, from the sidebar, the tab bar or the phone's menu. In a chat where
 * nothing has been said yet it stays in that chat, and with such a chat open
 * elsewhere it goes there, instead of making another: the space's first empty
 * "New chat" stayed in the tab bar beside the chats made after it. Otherwise
 * it makes a chat at once and opens it.
 */
export function useStartNewChat({
  activeProjectId,
  beforeOpen,
  openTab,
}: {
  activeProjectId: string | null;
  /** Runs first: history, and the phone's drawer. */
  beforeOpen: () => void;
  /** Opens the chat's tab once the workspace has it. */
  openTab: (localId: string) => void;
}): () => void {
  const {
    conversations,
    activeConversationId,
    createConversation,
    markConversationRead,
    selectConversation,
    setConversationControllerId,
  } = useConversations();

  return useCallback(() => {
    beforeOpen();
    const active = conversations.find((conversation) => conversation.localId === activeConversationId) ?? null;
    const blank = isReusableBlankConversation(active) ? active : findReusableBlankConversation(conversations);
    if (blank) {
      selectConversation(blank.localId);
      openTab(blank.localId);
      return;
    }
    const projectId = activeProjectId && isUUID(activeProjectId) ? activeProjectId : null;
    const conversation = createConversation({
      title: NEW_CHAT_TITLE,
      messages: [
        {
          id: `assistant-${Date.now()}-${Math.random().toString(16).slice(2)}`,
          role: "assistant",
          content: NEW_CHAT_GREETING,
          timestamp: Date.now(),
          files: null,
          messageType: "status",
          metadata: null,
        },
      ],
      select: true,
    });
    selectConversation(conversation.localId);
    markConversationRead(conversation.localId);
    openTab(conversation.localId);
    if (!projectId) {
      return;
    }
    void (async () => {
      const response = await controllerClient.conversations.createBlank({
        projectId,
        metadata: { title: NEW_CHAT_TITLE, localId: conversation.localId },
      });
      if (!response?.conversationId) {
        return;
      }
      setConversationControllerId(conversation.localId, response.conversationId);
    })();
  }, [
    activeConversationId,
    activeProjectId,
    beforeOpen,
    conversations,
    createConversation,
    markConversationRead,
    openTab,
    selectConversation,
    setConversationControllerId,
  ]);
}
