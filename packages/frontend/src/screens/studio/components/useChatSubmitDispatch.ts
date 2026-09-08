import { Capacitor } from "@capacitor/core";
import { useCallback, useRef, type MutableRefObject } from "react";
import type { SubmitConversationOptions, SubmitConversationResult } from "../../../conversations/useConversation";

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
  draftScopeKey: string;
  clearInputEditor?: () => void;
  clearSubmittedImageAttachments: (files: File[]) => void;
  clearConversationDraftIfUnchanged: (conversationId: string, draft: string, editorState: string | null) => boolean;
  focusInput: (options?: { force?: boolean }) => void;
  isChatInputFocused: () => boolean;
  latestInputValueRef: MutableRefObject<string>;
  latestInputEditorStateRef: MutableRefObject<string | null>;
  mentionableAgentHandles: string[];
  onInputChange: (conversationId: string | null, value: string, editorState?: string | null) => void;
  onSubmit: (conversationId: string | null, input: string, options?: SubmitConversationOptions) => Promise<SubmitConversationResult>;
  scrollToBottom: () => void;
  setSendingAttachment: (value: boolean) => void;
  shouldAutoScrollRef: MutableRefObject<boolean>;
};

export function useChatSubmitDispatch({
  activeConversationId,
  draftScopeKey,
  clearInputEditor,
  clearSubmittedImageAttachments,
  clearConversationDraftIfUnchanged,
  focusInput,
  isChatInputFocused,
  latestInputValueRef,
  latestInputEditorStateRef,
  mentionableAgentHandles,
  onInputChange,
  onSubmit,
  scrollToBottom,
  setSendingAttachment,
  shouldAutoScrollRef,
}: UseChatSubmitDispatchOptions) {
  const currentScopeRef = useRef(draftScopeKey);
  currentScopeRef.current = draftScopeKey;
  const clearComposerIfUnchanged = useCallback(
    (conversationId: string, expectedDraft: string) => {
      if (currentScopeRef.current !== draftScopeKey || activeConversationId !== conversationId) {
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
    [activeConversationId, clearInputEditor, draftScopeKey, latestInputValueRef, onInputChange],
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
          if (currentScopeRef.current !== draftScopeKey) return;
          shouldAutoScrollRef.current = true;
          scrollToBottom();
        });
      }
      const composerMessage = payload.composerMessage ?? payload.message;
      const submittedDraft = latestInputValueRef.current;
      const submittedEditorState = latestInputEditorStateRef.current;
      const sendsCurrentDraft = currentScopeRef.current === draftScopeKey && submittedDraft.trim() === composerMessage.trim();
      const hasImages = payload.imageFiles.length > 0;
      if (!hasImages && activeConversationId && sendsCurrentDraft) {
        latestInputValueRef.current = "";
        onInputChange(activeConversationId, "", null);
        clearInputEditor?.();
      }
      setSendingAttachment(true);
      try {
        const result = await onSubmit(activeConversationId, composerMessage, {
          dispatchInput: payload.message !== composerMessage ? payload.message : null,
          imageFiles: payload.imageFiles,
          editorState: payload.editorState,
          agentHandles: mentionableAgentHandles,
          metadata: payload.metadata ?? null,
          runtimeOverride: payload.runtimeOverride ?? null,
          expectedLaneIdle: payload.expectedLaneIdle,
        });
        if (result?.ok === false) return false;
        if (hasImages && activeConversationId && sendsCurrentDraft) {
          const cleared = clearConversationDraftIfUnchanged(activeConversationId, submittedDraft, submittedEditorState);
          if (cleared && currentScopeRef.current === draftScopeKey &&
            latestInputValueRef.current === submittedDraft && latestInputEditorStateRef.current === submittedEditorState) {
            latestInputValueRef.current = "";
            latestInputEditorStateRef.current = null;
            clearInputEditor?.();
          }
        }
        clearSubmittedImageAttachments(payload.imageFiles);
        if (shouldRefocus && currentScopeRef.current === draftScopeKey && !Capacitor.isNativePlatform()) {
          focusInput({ force: true });
        }
        if (currentScopeRef.current === draftScopeKey) {
          shouldAutoScrollRef.current = true;
          scrollToBottom();
        }
        return true;
      } finally {
        setSendingAttachment(false);
      }
    },
    [
      activeConversationId,
      clearInputEditor,
      clearSubmittedImageAttachments,
      clearConversationDraftIfUnchanged,
      draftScopeKey,
      focusInput,
      isChatInputFocused,
      latestInputValueRef,
      latestInputEditorStateRef,
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
