import { Capacitor } from "@capacitor/core";
import { useCallback, useRef, type MutableRefObject } from "react";
import type { SubmitConversationOptions } from "../../../conversations/useConversation";
import { isChatAttachmentUploadError } from "../../../lib/chatAttachments";

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
  // The chat the composer shows now, which may differ from the one a slow
  // attachment upload started in.
  const activeConversationIdRef = useRef(activeConversationId);
  activeConversationIdRef.current = activeConversationId;

  // An attachment upload failed, so nothing was sent: the draft goes back
  // into the composer it came from. Text the person has typed since is kept
  // below it, and the staged attachments were never cleared.
  const restoreUnsentDraft = useCallback(
    (conversationId: string, draft: string, editorState: string | null) => {
      if (activeConversationIdRef.current !== conversationId) {
        onInputChange(conversationId, draft, editorState);
        return;
      }
      const current = latestInputValueRef.current ?? "";
      if (current.trim() === draft.trim()) {
        return;
      }
      const restored = current.trim() ? `${draft}\n\n${current}` : draft;
      latestInputValueRef.current = restored;
      onInputChange(conversationId, restored, current.trim() ? null : editorState);
    },
    [latestInputValueRef, onInputChange],
  );

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
        } catch (error) {
          // The submit flow has already said why in plain copy.
          if (!isChatAttachmentUploadError(error)) {
            throw error;
          }
          if (touchComposer && activeConversationId) {
            restoreUnsentDraft(activeConversationId, composerMessage, payload.editorState);
          }
          return;
        }
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
      restoreUnsentDraft,
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
