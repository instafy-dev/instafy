import { useMemo, useRef } from "react";
import type { ConversationState } from "../../../conversations/conversationState";

function sameRunIds(previous: string[], next: string[]): boolean {
  return previous === next || (previous.length === next.length && previous.every((id, index) => id === next[index]));
}

function samePreview(previous: ConversationState, next: ConversationState): boolean {
  return previous.localId === next.localId &&
    previous.controllerId === next.controllerId &&
    previous.parentConversationId === next.parentConversationId &&
    previous.lifecycleStatus === next.lifecycleStatus &&
    previous.createdAt === next.createdAt &&
    previous.messages === next.messages &&
    sameRunIds(previous.pendingRunIds, next.pendingRunIds) &&
    sameRunIds(previous.awaitingLeaseRunIds, next.awaitingLeaseRunIds) &&
    previous.ownerAgent?.id === next.ownerAgent?.id &&
    previous.ownerAgent?.handle === next.ownerAgent?.handle;
}

/**
 * Stable inputs for buildParentConversationThreadMessage and
 * shouldHideStandaloneConversationThreadPreview. Retained objects deliberately
 * omit draft-only updates; use the full conversation context for composer state.
 */
export function useConversationPreviewThreads(
  conversations: readonly ConversationState[],
  parentControllerId: string | null,
): readonly ConversationState[] {
  const previousRef = useRef<readonly ConversationState[]>([]);
  return useMemo(() => {
    const next = parentControllerId
      ? conversations
          .filter((conversation) => conversation.parentConversationId === parentControllerId && conversation.lifecycleStatus !== "deleted")
          .sort((a, b) => a.createdAt - b.createdAt)
      : [];
    const previous = previousRef.current;
    if (next.length === previous.length && next.every((thread, index) => samePreview(previous[index], thread))) {
      return previous;
    }
    previousRef.current = next;
    return next;
  }, [conversations, parentControllerId]);
}
