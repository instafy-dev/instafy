import { createContext, useContext } from "react";
import type { StudioDestination, StudioNavigationOptions } from "../navigation/studioNavigation";

export interface ConversationMessageReference {
  projectId: string | null | undefined;
  conversationControllerId: string;
  messageId: string;
}

export type ConversationMessageOpener = (reference: ConversationMessageReference) => boolean;

/** Message bodies use the chat's existing route owner without subscribing to its draft. */
export const ConversationMessageContext = createContext<ConversationMessageOpener | null>(null);
export const useConversationMessageOpener = () => useContext(ConversationMessageContext);

/** A stale message cannot open its controller ID under the newly selected space. */
export function openConversationMessageReference(
  reference: ConversationMessageReference,
  scope: {
    activeProjectId: string | null | undefined;
    conversationsProjectKey: string;
    resolveConversationLocalId: (controllerId: string) => string | null;
  },
  navigate: (destination: StudioDestination, options?: StudioNavigationOptions) => void,
): boolean {
  const projectId = reference.projectId?.trim();
  const conversationControllerId = reference.conversationControllerId.trim();
  const messageId = reference.messageId.trim();
  if (!projectId || projectId !== scope.activeProjectId || projectId !== scope.conversationsProjectKey
    || !conversationControllerId || !messageId) return false;
  const conversationId = scope.resolveConversationLocalId(conversationControllerId)?.trim();
  if (!conversationId) return false;
  navigate({ kind: "conversation", projectId, conversationId, conversationControllerId, messageId }, { forceNewVisit: true });
  return true;
}
