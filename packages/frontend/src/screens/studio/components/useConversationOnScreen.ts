import { useEffect } from "react";
import { registerOpenConversation } from "../../../notifications/openConversations";

/**
 * While this conversation is on screen the chat itself presents its replies:
 * the notification center skips the banner for it and asks it to re-read when
 * the durable feed sees a reply the live stream may have missed. Its Browser
 * view in front counts too: the reply belongs to the turn the person is
 * watching there, and Chat is one press away. A job thread's tab is not the
 * conversation.
 */
export function useConversationOnScreen(
  conversationId: string | null | undefined,
  view: { chatVisible: boolean; browserVisible: boolean; jobThread: boolean },
): void {
  const onScreen = (view.chatVisible || view.browserVisible) && !view.jobThread;
  useEffect(() => {
    if (!onScreen || !conversationId) return;
    return registerOpenConversation(conversationId);
  }, [conversationId, onScreen]);
}
