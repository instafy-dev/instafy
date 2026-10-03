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
  /**
   * Marks the staged images a send carries while they upload, and unmarks
   * them when the send fails, so the tray shows they are on their way.
   */
  markImageAttachmentsSending?: (files: File[], sending: boolean) => void;
  /**
   * Takes the images a send carried out of the tray once they are stored.
   * Images staged after the send began stay for the next message.
   */
  removeSentImageAttachments: (files: File[]) => void;
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
  markImageAttachmentsSending,
  removeSentImageAttachments,
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

  /**
   * Sends one message. Resolves true once it went out, and false when an
   * attachment upload failed: then nothing was sent, the draft is back in its
   * composer and the staged images are still there.
   */
  const performSubmit = useCallback(
    async (payload: ChatSubmitDispatchPayload): Promise<boolean> => {
      // The person may be writing their next message or reading further up
      // while an automatic send goes out, so it changes none of that.
      const touchComposer = payload.automatic !== true;
      const shouldRefocus = touchComposer && isChatInputFocused();
      const composerMessage = payload.composerMessage ?? payload.message;
      const carriedImages = touchComposer ? payload.imageFiles : [];
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
      markImageAttachmentsSending?.(carriedImages, true);
      try {
        try {
          await onSubmit(activeConversationId, composerMessage, {
            dispatchInput: payload.message !== composerMessage ? payload.message : null,
            imageFiles: payload.imageFiles,
            onAttachmentsStored:
              carriedImages.length > 0 ? () => removeSentImageAttachments(carriedImages) : undefined,
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
          return false;
        }
        if (touchComposer) {
          removeSentImageAttachments(carriedImages);
          if (shouldRefocus && !Capacitor.isNativePlatform()) {
            focusInput({ force: true });
          }
          shouldAutoScrollRef.current = true;
          scrollToBottom();
        }
        return true;
      } finally {
        // Images still in the tray (a failed send) can be removed again.
        markImageAttachmentsSending?.(carriedImages, false);
        setSendingAttachment(false);
      }
    },
    [
      activeConversationId,
      clearInputEditor,
      focusInput,
      isChatInputFocused,
      latestInputValueRef,
      markImageAttachmentsSending,
      mentionableAgentHandles,
      onInputChange,
      onSubmit,
      removeSentImageAttachments,
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
