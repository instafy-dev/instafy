import { Capacitor } from "@capacitor/core";
import { useCallback, type MutableRefObject } from "react";
import type { SubmitConversationOptions } from "../../../conversations/useConversation";

export type ChatSubmitDispatchPayload = {
  message: string;
  composerMessage?: string | null;
  editorState: string | null;
  imageFiles: File[];
  metadata?: Record<string, unknown> | null;
  runtimeOverride?: SubmitConversationOptions["runtimeOverride"];
  expectedLaneIdle?: boolean;
  /**
   * Sent by the app on the person's behalf (an automatic retry): the composer,
   * its staged attachments, focus and the scroll position are left as they are.
   */
  automatic?: boolean;
};

type UseChatSubmitDispatchOptions = {
  activeConversationId: string | null;
  clearInputEditor?: () => void;
  clearImageAttachments: () => void;
  focusInput: (options?: { force?: boolean }) => void;
  isChatInputFocused: () => boolean;
  latestInputValueRef: MutableRefObject<string>;
  mentionableAgentHandles: string[];
  onInputChange: (conversationId: string | null, value: string, editorState?: string | null) => void;
  onSubmit: (conversationId: string | null, input: string, options?: SubmitConversationOptions) => Promise<void>;
  scrollToBottom: () => void;
  setSendingAttachment: (value: boolean) => void;
  shouldAutoScrollRef: MutableRefObject<boolean>;
};

export function useChatSubmitDispatch({
  activeConversationId,
  clearInputEditor,
  clearImageAttachments,
  focusInput,
  isChatInputFocused,
  latestInputValueRef,
  mentionableAgentHandles,
  onInputChange,
  onSubmit,
  scrollToBottom,
  setSendingAttachment,
  shouldAutoScrollRef,
}: UseChatSubmitDispatchOptions) {
  const clearComposerIfUnchanged = useCallback(
    (conversationId: string, expectedDraft: string) => {
      if (activeConversationId !== conversationId) {
        return;
      }
      const current = latestInputValueRef.current ?? "";
      if (current.trim() !== expectedDraft.trim()) {
        return;
      }
      latestInputValueRef.current = "";
      onInputChange(conversationId, "", null);
      clearInputEditor?.();
    },
    [activeConversationId, clearInputEditor, latestInputValueRef, onInputChange],
  );

  const clearComposerAfterQueue = useCallback(
    (conversationId: string, expectedDraft: string) => {
      clearComposerIfUnchanged(conversationId, expectedDraft);
      if (typeof window === "undefined") {
        return;
      }
      window.setTimeout(() => {
        clearComposerIfUnchanged(conversationId, expectedDraft);
      }, 0);
    },
    [clearComposerIfUnchanged],
  );

  const performSubmit = useCallback(
    async (payload: ChatSubmitDispatchPayload) => {
      // The person may be writing their next message or reading further up
      // while an automatic send goes out, so it changes none of that.
      const touchComposer = payload.automatic !== true;
      const shouldRefocus = touchComposer && isChatInputFocused();
      const composerMessage = payload.composerMessage ?? payload.message;
      if (touchComposer) {
        shouldAutoScrollRef.current = true;
        scrollToBottom();
        if (typeof window !== "undefined" && typeof window.requestAnimationFrame === "function") {
          window.requestAnimationFrame(() => {
            shouldAutoScrollRef.current = true;
            scrollToBottom();
          });
        }
        if (activeConversationId && latestInputValueRef.current.trim() === composerMessage.trim()) {
          latestInputValueRef.current = "";
          onInputChange(activeConversationId, "", null);
          clearInputEditor?.();
        }
      }
      setSendingAttachment(true);
      try {
        await onSubmit(activeConversationId, composerMessage, {
          dispatchInput: payload.message !== composerMessage ? payload.message : null,
          imageFiles: payload.imageFiles,
          editorState: payload.editorState,
          agentHandles: mentionableAgentHandles,
          metadata: payload.metadata ?? null,
          runtimeOverride: payload.runtimeOverride ?? null,
          expectedLaneIdle: payload.expectedLaneIdle,
        });
        if (touchComposer) {
          clearImageAttachments();
          if (shouldRefocus && !Capacitor.isNativePlatform()) {
            focusInput({ force: true });
          }
          shouldAutoScrollRef.current = true;
          scrollToBottom();
        }
      } finally {
        setSendingAttachment(false);
      }
    },
    [
      activeConversationId,
      clearInputEditor,
      clearImageAttachments,
      focusInput,
      isChatInputFocused,
      latestInputValueRef,
      mentionableAgentHandles,
      onInputChange,
      onSubmit,
      scrollToBottom,
      setSendingAttachment,
      shouldAutoScrollRef,
    ],
  );

  return {
    clearComposerAfterQueue,
    clearComposerIfUnchanged,
    performSubmit,
  };
}
