import { useCallback, useEffect, useRef } from "react";
import { controllerClient } from "../sdk/instafy";
import {
  getConversationAutoTitleSeed,
  getFallbackConversationTitle,
  getOpeningUserMessage,
  isDefaultConversationTitle,
  type OpeningUserMessage,
} from "./conversationAutoTitle";
import type { ConversationState } from "./conversationState";

const { requestTitle: requestProjectConversationTitle, updateMetadata: updateControllerConversationMetadata } =
  controllerClient.conversations;

const attemptedAutoTitleKeys = new Set<string>();

interface UseConversationAutoTitleArgs {
  conversations: ConversationState[];
  currentUserId: string | null;
  resolveProjectId: () => string | null;
  ensureControllerConversationId: (
    projectId: string,
    conversation: ConversationState,
  ) => Promise<string | null>;
  setConversationTitle: (conversationId: string, title: string) => void;
}

export function useConversationAutoTitle({
  conversations,
  currentUserId,
  resolveProjectId,
  ensureControllerConversationId,
  setConversationTitle,
}: UseConversationAutoTitleArgs) {
  const conversationsRef = useRef(conversations);
  const attemptedAutoTitleRef = useRef(attemptedAutoTitleKeys);

  useEffect(() => {
    conversationsRef.current = conversations;
  }, [conversations]);

  // `openingMessage` is the conversation's first user message, from a caller
  // that has its whole history loaded; without it only the local list can say
  // which message opened the conversation.
  const maybeAutoTitleConversation = useCallback(
    async (
      conversationId: string,
      firstUserMessage: string,
      openingMessage?: OpeningUserMessage | null,
    ): Promise<void> => {
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
      // A chat rebuilt from a message or a draft may already have a real
      // title that its default one hides; wait for the chat list. Not marking
      // the attempt lets the next pass try once the list confirms it.
      if (
        initialConversation.parentConversationId ||
        initialConversation.threadKind ||
        initialConversation.remoteSummaryPending ||
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
      // Read before the requests below: a list refresh while they run can mark
      // a brand-new chat as holding remote messages.
      const initialOpeningMessage = openingMessage ?? getOpeningUserMessage(initialConversation);
      const controllerId = await ensureControllerConversationId(projectId, initialConversation);
      if (!controllerId) {
        return;
      }

      const titleResult = await requestProjectConversationTitle({
        projectId,
        message: trimmedMessage,
      });
      const modelTitle = titleResult.success ? titleResult.title?.trim() ?? "" : "";

      const latestConversation =
        conversationsRef.current.find((entry) => entry.localId === conversationId) ?? null;
      if (!latestConversation) {
        return;
      }
      if (
        latestConversation.parentConversationId ||
        latestConversation.threadKind ||
        latestConversation.remoteSummaryPending ||
        latestConversation.title !== initialTitle ||
        !isDefaultConversationTitle(latestConversation.title)
      ) {
        return;
      }

      let nextTitle = modelTitle && modelTitle !== initialTitle ? modelTitle : "";
      if (!nextTitle) {
        // The controller titles only with the person's own credential, so a
        // managed-tier chat gets an answer with no title. Name it from its
        // opening message instead, never from a later one such as "Yes, that
        // one", and only:
        // - when the request went through: a refusal (a viewer) or an outage
        //   is not that answer;
        // - for the person who wrote the opening message, so only their own
        //   client turns their words into a title everyone sees.
        // A caller can run before its message lands in the list, so the
        // latest list may be the first to hold it.
        const knownOpeningMessage = initialOpeningMessage ?? getOpeningUserMessage(latestConversation);
        if (
          !titleResult.success ||
          !knownOpeningMessage ||
          !currentUserId ||
          knownOpeningMessage.authorId !== currentUserId
        ) {
          return;
        }
        nextTitle = getFallbackConversationTitle(knownOpeningMessage.content) ?? "";
        if (!nextTitle) {
          return;
        }
      }

      setConversationTitle(conversationId, nextTitle);
      void updateControllerConversationMetadata({
        conversationId: controllerId,
        metadata: {
          title: nextTitle,
        },
      });
    },
    [currentUserId, ensureControllerConversationId, resolveProjectId, setConversationTitle],
  );

  // A submit queues in the same tick it appends its message, before this
  // hook's list holds it, so it passes the opening message along.
  const queueAutoTitleConversation = useCallback(
    (conversationId: string, firstUserMessage: string, openingMessage?: OpeningUserMessage | null) => {
      const trimmedMessage = firstUserMessage.trim();
      if (!trimmedMessage) {
        return;
      }
      void maybeAutoTitleConversation(conversationId, trimmedMessage, openingMessage);
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
