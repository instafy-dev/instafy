import { createContext, useContext, useLayoutEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import type { SentPageAttachmentInfo } from "./sentPageAttachment";

export type PendingChatImageAttachment = {
  id: string;
  file: File;
  /** An object URL for an image; empty for a sent page. */
  previewUrl: string;
  /** An upload already carrying this file cannot be removed from the tray. */
  sending?: boolean;
  /** A masked Markdown copy staged by Send page to Octo, sent as a file attachment. */
  page?: SentPageAttachmentInfo;
};

export function revokeAttachmentPreview(previewUrl: string) {
  if (!previewUrl) return;
  try { URL.revokeObjectURL(previewUrl); } catch { /* Already released by the browser. */ }
}

const EMPTY_ATTACHMENTS: PendingChatImageAttachment[] = [];

/** Files remain in session memory, scoped to an account and each chat's draft key. */
class ChatAttachmentDraftStore {
  private drafts = new Map<string, PendingChatImageAttachment[]>();
  private listeners = new Set<() => void>();
  private released = false;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  getSnapshot = () => this.drafts;
  get = (key: string) => this.drafts.get(key) ?? EMPTY_ATTACHMENTS;
  update = (key: string, update: (previous: PendingChatImageAttachment[]) => PendingChatImageAttachment[]) => {
    const previous = this.get(key);
    const next = update(previous);
    // A callback from an old account must not retain newly created previews.
    if (this.released) {
      for (const item of next) revokeAttachmentPreview(item.previewUrl);
      return;
    }
    if (next === previous) return;
    this.drafts = new Map(this.drafts);
    if (next.length) this.drafts.set(key, next);
    else this.drafts.delete(key);
    this.listeners.forEach(listener => listener());
  };
  retain = () => { this.released = false; };
  release = () => {
    this.released = true;
    for (const attachments of this.drafts.values()) {
      for (const item of attachments) revokeAttachmentPreview(item.previewUrl);
    }
    this.drafts = new Map();
  };
}

const Context = createContext<ChatAttachmentDraftStore | null>(null);

function useOwnedAttachmentDrafts() {
  const [store] = useState(() => new ChatAttachmentDraftStore());
  useLayoutEffect(() => {
    store.retain();
    return store.release;
  }, [store]);
  return store;
}

/** Mount below Studio's account key, above panels that come and go during navigation. */
export function ChatAttachmentDraftsProvider({ children }: { children: ReactNode }) {
  const store = useOwnedAttachmentDrafts();
  return <Context.Provider value={store}>{children}</Context.Provider>;
}

export function useChatAttachmentDrafts() {
  const shared = useContext(Context);
  const local = useOwnedAttachmentDrafts();
  const store = shared ?? local;
  const drafts = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  return { drafts, store };
}
