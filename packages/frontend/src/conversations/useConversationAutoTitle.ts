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
  const findConversation = useCallback(
    (conversationId: string) => conversationsRef.current.find((entry) => entry.localId === conversationId) ?? null,
    [],
  );

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
      // The chat is named from the first line of its opening message at once,
      // in the same tick as the send, so it has a name while its first turn
      // runs and after that turn fails. Only from the opening message, never a
      // later one such as "Yes, that one", and only on the client of the person
      // who wrote it, so only they turn their words into a title everyone sees.
      const isOwnOpeningMessage = (message: OpeningUserMessage | null): message is OpeningUserMessage =>
        Boolean(message && currentUserId && message.authorId === currentUserId);
      const promptTitle = isOwnOpeningMessage(initialOpeningMessage)
        ? getFallbackConversationTitle(initialOpeningMessage.content)
        : null;
      if (promptTitle) {
        setConversationTitle(conversationId, promptTitle);
      }
      const shownTitle = promptTitle ?? initialTitle;
      const controllerId = await ensureControllerConversationId(projectId, initialConversation);
      if (!controllerId) {
        return;
      }
      // Nobody renamed it meanwhile. The list read here may not hold the name
      // set above yet, so the title it replaced also counts as unchanged.
      const isStillShown = (conversation: ConversationState | null): conversation is ConversationState =>
        Boolean(
          conversation &&
            !conversation.parentConversationId &&
            !conversation.threadKind &&
            !conversation.remoteSummaryPending &&
            (conversation.title === shownTitle || conversation.title === initialTitle),
        );
      if (promptTitle && isStillShown(findConversation(conversationId))) {
        void updateControllerConversationMetadata({ conversationId: controllerId, metadata: { title: promptTitle } });
      }

      // The controller titles only with the person's own credential; its
      // title replaces the line's name once, while nobody has renamed the chat.
      const titleResult = await requestProjectConversationTitle({
        projectId,
        message: trimmedMessage,
      });
      const modelTitle = titleResult.success ? titleResult.title?.trim() ?? "" : "";

      const latestConversation = findConversation(conversationId);
      if (!isStillShown(latestConversation)) {
        return;
      }

      let nextTitle = modelTitle && modelTitle !== shownTitle ? modelTitle : "";
      if (!nextTitle && !promptTitle) {
        // A caller can run before its message lands in the list, so the latest
        // list may be the first to hold the opening message.
        const knownOpeningMessage = getOpeningUserMessage(latestConversation);
        if (!isDefaultConversationTitle(latestConversation.title) || !isOwnOpeningMessage(knownOpeningMessage)) {
          return;
        }
        nextTitle = getFallbackConversationTitle(knownOpeningMessage.content) ?? "";
      }
      if (!nextTitle) {
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
    [currentUserId, ensureControllerConversationId, findConversation, resolveProjectId, setConversationTitle],
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
