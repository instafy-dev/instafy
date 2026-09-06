import { useCallback, useEffect, useRef } from "react";
import { controllerClient } from "../../../sdk/instafy";
import { makeConversationId, type ConversationState } from "../../../conversations/conversationState";
import type { UseConversationSubmitFlowArgs } from "../../../conversations/conversationSubmitTypes";
import { isUUID } from "../../../utils/uuid";
import type { PrivateChatTarget } from "../workspaceControls";

type Options = Pick<UseConversationSubmitFlowArgs, "createConversation" | "showStatus"> & {
  projectId: string | null;
  userId: string | null;
  accessToken: string | null;
  onCreated: (conversation: ConversationState) => void;
};

/** A direct-chat composer becomes available only after its participant is authorized. */
export function useCreatePrivateConversation({
  projectId, userId, accessToken, createConversation, showStatus, onCreated,
}: Options) {
  const scopeRef = useRef({ projectId, userId, accessToken });
  if (scopeRef.current.projectId !== projectId || scopeRef.current.userId !== userId ||
      scopeRef.current.accessToken !== accessToken) {
    scopeRef.current = { projectId, userId, accessToken };
  }
  const pendingRef = useRef<object | null>(null);
  const mountedRef = useRef(false);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      pendingRef.current = null;
    };
  }, []);

  return useCallback(async (target: PrivateChatTarget): Promise<void> => {
    if (!isUUID(projectId) || !userId || !accessToken) {
      showStatus("Select a project and sign in before starting a private chat.", "error", 4000);
      return;
    }
    const participantUserId = target.userId.trim().toLowerCase();
    if (!isUUID(participantUserId)) return;
    const scope = scopeRef.current;
    if (pendingRef.current === scope) return;
    pendingRef.current = scope;
    const isCurrent = () => mountedRef.current && scopeRef.current === scope && pendingRef.current === scope;
    const title = `Chat with ${target.displayName.trim() || "Teammate"}`;
    const localId = makeConversationId();
    showStatus("Starting private chat…", "info", 3500);
    try {
      const response = await controllerClient.conversations.createBlank({
        projectId,
        accessToken,
        metadata: { title, localId, visibility: "private" },
        initialParticipantUserIds: [participantUserId],
      });
      if (!isCurrent()) return;
      if (!isUUID(response?.conversationId)) {
        throw new Error("Unable to create the chat. Check this teammate's project access and try again.");
      }
      if (!response.initialParticipantUserIds?.includes(participantUserId)) {
        throw new Error("The server did not confirm this teammate's participation. Update the controller and try again.");
      }
      // Do not expose an unbound local conversation: ordinary submit fallback
      // could otherwise create a different private conversation without the target.
      const conversation = createConversation({
        localId,
        controllerId: response.conversationId,
        title,
        visibility: "private",
        messages: [{
          id: `assistant-${localId}`,
          role: "assistant",
          content: "This chat is private. Write @someone to invite them here.",
          timestamp: Date.now(),
          files: null,
          messageType: "status",
          metadata: null,
        }],
        select: true,
      });
      onCreated(conversation);
    } catch (error) {
      if (isCurrent()) {
        const message = error instanceof Error ? error.message : String(error);
        showStatus(`Can't start private chat: ${message}`, "error", 4500);
      }
    } finally {
      if (pendingRef.current === scope) pendingRef.current = null;
    }
  }, [accessToken, createConversation, onCreated, projectId, showStatus, userId]);
}
