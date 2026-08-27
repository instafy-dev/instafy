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
      const shouldRefocus = isChatInputFocused();
      shouldAutoScrollRef.current = true;
      scrollToBottom();
      if (typeof window !== "undefined" && typeof window.requestAnimationFrame === "function") {
        window.requestAnimationFrame(() => {
          shouldAutoScrollRef.current = true;
          scrollToBottom();
        });
      }
      const composerMessage = payload.composerMessage ?? payload.message;
      if (activeConversationId && latestInputValueRef.current.trim() === composerMessage.trim()) {
        latestInputValueRef.current = "";
        onInputChange(activeConversationId, "", null);
        clearInputEditor?.();
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
        clearImageAttachments();
        if (shouldRefocus && !Capacitor.isNativePlatform()) {
          focusInput({ force: true });
        }
        shouldAutoScrollRef.current = true;
        scrollToBottom();
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
