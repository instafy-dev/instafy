import { useCallback, useEffect, useRef } from "react";
import { controllerClient } from "../sdk/instafy";
import {
  getConversationAutoTitleSeed,
  isDefaultConversationTitle,
} from "./conversationAutoTitle";
import type { ConversationState } from "./conversationState";

const { requestTitle: requestProjectConversationTitle, updateMetadata: updateControllerConversationMetadata } =
  controllerClient.conversations;

const attemptedAutoTitleKeys = new Set<string>();

interface UseConversationAutoTitleArgs {
  conversations: ConversationState[];
  resolveProjectId: () => string | null;
  ensureControllerConversationId: (
    projectId: string,
    conversation: ConversationState,
  ) => Promise<string | null>;
  setConversationTitle: (conversationId: string, title: string) => void;
}

export function useConversationAutoTitle({
  conversations,
  resolveProjectId,
  ensureControllerConversationId,
  setConversationTitle,
}: UseConversationAutoTitleArgs) {
  const conversationsRef = useRef(conversations);
  const attemptedAutoTitleRef = useRef(attemptedAutoTitleKeys);

  useEffect(() => {
    conversationsRef.current = conversations;
  }, [conversations]);

  const maybeAutoTitleConversation = useCallback(
    async (conversationId: string, firstUserMessage: string): Promise<void> => {
      const trimmedMessage = firstUserMessage.trim();
      if (!trimmedMessage) {
        return;
      }

      const projectId = resolveProjectId();
      if (!projectId) {
        return;
      }

      const initialConversation =
        conversationsRef.current.find((entry) => entry.localId === conversationId) ?? null;
      if (!initialConversation) {
        return;
      }
      if (
        initialConversation.parentConversationId ||
        initialConversation.threadKind ||
        !isDefaultConversationTitle(initialConversation.title) ||
        trimmedMessage.length === 0
      ) {
        return;
      }

      const attemptKey = `${conversationId}:${trimmedMessage}`;
      if (attemptedAutoTitleRef.current.has(attemptKey)) {
        return;
      }
      attemptedAutoTitleRef.current.add(attemptKey);

      const initialTitle = initialConversation.title;
      const controllerId = await ensureControllerConversationId(projectId, initialConversation);
      if (!controllerId) {
        return;
      }

      const titleResult = await requestProjectConversationTitle({
        projectId,
        message: trimmedMessage,
      });
      const nextTitle = titleResult.title?.trim() ?? "";
      if (!titleResult.success || !nextTitle || nextTitle === initialTitle) {
        return;
      }

      const latestConversation =
        conversationsRef.current.find((entry) => entry.localId === conversationId) ?? null;
      if (!latestConversation) {
        return;
      }
      if (
        latestConversation.parentConversationId ||
        latestConversation.threadKind ||
        latestConversation.title !== initialTitle ||
        !isDefaultConversationTitle(latestConversation.title)
      ) {
        return;
      }

      setConversationTitle(conversationId, nextTitle);
      void updateControllerConversationMetadata({
        conversationId: controllerId,
        metadata: {
          title: nextTitle,
        },
      });
    },
    [ensureControllerConversationId, resolveProjectId, setConversationTitle],
  );

  const queueAutoTitleConversation = useCallback(
    (conversationId: string, firstUserMessage: string) => {
      const trimmedMessage = firstUserMessage.trim();
      if (!trimmedMessage) {
        return;
      }
      void maybeAutoTitleConversation(conversationId, trimmedMessage);
    },
    [maybeAutoTitleConversation],
  );

  useEffect(() => {
    for (const conversation of conversations) {
      const seed = getConversationAutoTitleSeed(conversation);
      if (!seed) {
        continue;
      }
      queueAutoTitleConversation(conversation.localId, seed);
    }
  }, [conversations, queueAutoTitleConversation]);

  return {
    maybeAutoTitleConversation,
    queueAutoTitleConversation,
  };
}
