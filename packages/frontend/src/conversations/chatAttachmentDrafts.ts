export type PendingChatImageAttachment = {
  id: string;
  file: File;
  previewUrl: string;
  originalFile?: File;
};

export const MAX_CHAT_ATTACHMENT_DRAFT_BYTES = 50 * 1024 * 1024;
export const MAX_CHAT_ATTACHMENT_DRAFT_IMAGES = 32;
const EMPTY_ATTACHMENTS: PendingChatImageAttachment[] = [];

export function revokeChatAttachmentPreview(previewUrl: string) {
  try {
    URL.revokeObjectURL(previewUrl);
  } catch {
    // Revocation is best-effort during session teardown.
  }
}

/** File drafts belong to the Studio session, not a mounted Chat panel. */
export function createChatAttachmentDraftStore() {
  const drafts = new Map<string, PendingChatImageAttachment[]>();
  const listeners = new Set<() => void>();
  let disposed = false;
  const get = (key: string) => drafts.get(key) ?? EMPTY_ATTACHMENTS;
  const notify = () => listeners.forEach((listener) => listener());

  return {
    get,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    update(key: string, update: (previous: PendingChatImageAttachment[]) => PendingChatImageAttachment[]) {
      if (disposed) return false;
      const previous = get(key);
      const next = update(previous);
      if (next === previous) return false;

      const files = new Set<File>();
      let count = 0;
      const include = (attachments: PendingChatImageAttachment[]) => {
        count += attachments.length;
        for (const attachment of attachments) {
          files.add(attachment.file);
          if (attachment.originalFile) files.add(attachment.originalFile);
        }
      };
      for (const [draftKey, attachments] of drafts) {
        if (draftKey !== key) include(attachments);
      }
      include(next);
      const bytes = [...files].reduce((total, file) => total + file.size, 0);
      if (count > MAX_CHAT_ATTACHMENT_DRAFT_IMAGES || bytes > MAX_CHAT_ATTACHMENT_DRAFT_BYTES) {
        const existingUrls = new Set(previous.map((attachment) => attachment.previewUrl));
        for (const attachment of next) {
          if (!existingUrls.has(attachment.previewUrl)) revokeChatAttachmentPreview(attachment.previewUrl);
        }
        throw new Error("Image drafts are limited to 32 images and 50MB, including originals. Send or remove selected images before adding more.");
      }

      if (next.length > 0) drafts.set(key, next);
      else drafts.delete(key);
      const retainedUrls = new Set(next.map((attachment) => attachment.previewUrl));
      for (const attachment of previous) {
        if (!retainedUrls.has(attachment.previewUrl)) revokeChatAttachmentPreview(attachment.previewUrl);
      }
      notify();
      return true;
    },
    activate() {
      disposed = false;
    },
    dispose() {
      disposed = true;
      for (const attachments of drafts.values()) {
        for (const attachment of attachments) revokeChatAttachmentPreview(attachment.previewUrl);
      }
      drafts.clear();
      notify();
    },
  };
}

export type ChatAttachmentDraftStore = ReturnType<typeof createChatAttachmentDraftStore>;
