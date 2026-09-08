import { useCallback } from "react";

interface ComposerPreviewTab {
  id: string;
  kind: string;
  conversationId?: string;
  preview?: boolean;
}

/** Explicit composer work keeps its conversation open; viewing and focus do not. */
export function useChatComposerPreviewTab({
  conversationId,
  inputValue,
  inputEditorState,
  tabs,
  keepTabOpen,
}: {
  conversationId: string | null;
  inputValue: string;
  inputEditorState: string | null;
  tabs: readonly ComposerPreviewTab[];
  keepTabOpen: (tabId: string) => void;
}) {
  const previewTabId = tabs.find((tab) =>
    tab.kind === "conversation" && tab.conversationId === conversationId && tab.preview,
  )?.id;

  // Bind to this conversation, rather than whichever tab is active when an
  // attachment/send callback eventually completes.
  const keepComposerTabOpen = useCallback(() => {
    if (previewTabId) keepTabOpen(previewTabId);
  }, [keepTabOpen, previewTabId]);

  const keepComposerTabOpenForEdit = useCallback((nextValue: string, nextEditorState: string) => {
    // Lexical can report controlled state on mount/focus. A missing saved
    // editor state must not make that initial serialization count as typing.
    if (nextValue !== inputValue || (inputEditorState !== null && nextEditorState !== inputEditorState)) {
      keepComposerTabOpen();
    }
  }, [inputEditorState, inputValue, keepComposerTabOpen]);

  return { keepComposerTabOpen, keepComposerTabOpenForEdit };
}
