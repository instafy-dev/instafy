import { createContext, useContext } from "react";
import type { OpenWorkspaceFileEventDetail } from "../screens/studio/components/useFilesPanelViewerState";

/** Routes chat links to its existing workspace owner; contains no tab state. */
export const ConversationFileContext = createContext<((file: OpenWorkspaceFileEventDetail) => void) | null>(null);
export const useConversationFileOpener = () => useContext(ConversationFileContext);
