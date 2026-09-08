import { createContext, useContext, useLayoutEffect, useState, type ReactNode } from "react";
import { createChatAttachmentDraftStore, type ChatAttachmentDraftStore } from "./chatAttachmentDrafts";

const ChatAttachmentDraftsContext = createContext<ChatAttachmentDraftStore | null>(null);

function AttachmentSession({ children }: { children: ReactNode }) {
  const [store] = useState(createChatAttachmentDraftStore);
  useLayoutEffect(() => {
    store.activate();
    return () => store.dispose();
  }, [store]);
  return <ChatAttachmentDraftsContext.Provider value={store}>{children}</ChatAttachmentDraftsContext.Provider>;
}

export function ChatAttachmentDraftsProvider({ sessionKey, children }: { sessionKey: string | null; children: ReactNode }) {
  return <AttachmentSession key={sessionKey ?? "signed-out"}>{children}</AttachmentSession>;
}

export function useChatAttachmentDraftStore() {
  const shared = useContext(ChatAttachmentDraftsContext);
  // Standalone composer fixtures retain their original mount-scoped ownership.
  const [owned] = useState(() => shared ?? createChatAttachmentDraftStore());
  useLayoutEffect(() => {
    if (shared) return;
    owned.activate();
    return () => owned.dispose();
  }, [owned, shared]);
  return shared ?? owned;
}
