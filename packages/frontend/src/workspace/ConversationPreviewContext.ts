import { createContext, useContext } from "react";

export type ConversationPreviewOpener = {
  /** Selects the site's view in this conversation's pane; the pane mints its own viewer session. */
  openPreview: (preview: { previewId: string; title: string }) => void;
  /** The preview whose pane is on screen now, or null. */
  visiblePreviewId: string | null;
};

/** Routes "open this preview" to the conversation's view state, like ConversationFileContext; holds no address. */
export const ConversationPreviewContext = createContext<ConversationPreviewOpener | null>(null);
export const useConversationPreviewOpener = () => useContext(ConversationPreviewContext);
