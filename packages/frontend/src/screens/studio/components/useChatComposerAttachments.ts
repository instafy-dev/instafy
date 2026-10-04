import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ChangeEvent,
  type ClipboardEvent,
  type DragEvent,
} from "react";
import type { StatusIntent } from "../../../status/useStatus";
import {
  CHAT_ATTACHMENT_SIZE_REQUIREMENT,
  CHAT_IMAGE_TYPE_REQUIREMENT,
  chatAttachmentFileProblem,
  isChatImageMimeType,
} from "../../../lib/chatAttachments";

export type PendingChatImageAttachment = {
  id: string;
  file: File;
  previewUrl: string;
  /** Set while a send carrying this image uploads it; it can't be removed then. */
  sending?: boolean;
};

type ShowStatus = (message: string, intent?: StatusIntent, durationMs?: number) => void;

/** A staged attachment's size: "640 KB" below a megabyte, then "3.4 MB". */
export function formatAttachmentSize(bytes: number): string {
  const megabyte = 1024 * 1024;
  if (bytes < megabyte) {
    return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  }
  return `${(bytes / megabyte).toFixed(1)} MB`;
}

/** What the tray says while a send uploads its images. */
export function describeSendingImages(count: number): string {
  return count === 1 ? "Sending your message with 1 image…" : `Sending your message with ${count} images…`;
}

const EMPTY_ATTACHMENTS: PendingChatImageAttachment[] = [];

function revokePreviewUrl(previewUrl: string) {
  try {
    URL.revokeObjectURL(previewUrl);
  } catch (_error) {
    // ignore cleanup failure
  }
}

// A pasted image is taken over from the editor even when its type is one the
// bucket refuses, so the person hears why it was not added instead of nothing.
function isImageLike(type: string | null | undefined): boolean {
  return (type ?? "").trim().toLowerCase().startsWith("image/");
}

export function useChatComposerAttachments({
  draftKey,
  isInputLocked,
  showStatus,
  onAttachmentsAdded,
  unavailableReason = null,
}: {
  draftKey: string;
  isInputLocked: () => boolean;
  showStatus: ShowStatus;
  onAttachmentsAdded?: () => void;
  /** Set when this server cannot store attachments; paste and drop say it. */
  unavailableReason?: string | null;
}) {
  const attachmentDraftsRef = useRef(new Map<string, PendingChatImageAttachment[]>());
  const [attachmentDrafts, setAttachmentDrafts] = useState(attachmentDraftsRef.current);
  const imageAttachments = attachmentDrafts.get(draftKey) ?? EMPTY_ATTACHMENTS;
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const activeDraftKeyRef = useRef(draftKey);

  useLayoutEffect(() => {
    activeDraftKeyRef.current = draftKey;
    if (imageInputRef.current) imageInputRef.current.value = "";
  }, [draftKey]);

  // Keep callbacks bound to their originating chat, including an upload/send
  // that completes after the user has already selected another conversation.
  const setImageAttachments = useCallback((update: (
    previous: PendingChatImageAttachment[],
  ) => PendingChatImageAttachment[]) => {
    const current = attachmentDraftsRef.current.get(draftKey) ?? EMPTY_ATTACHMENTS;
    const next = update(current);
    if (next === current) return;
    const drafts = new Map(attachmentDraftsRef.current);
    if (next.length > 0) drafts.set(draftKey, next);
    else drafts.delete(draftKey);
    attachmentDraftsRef.current = drafts;
    setAttachmentDrafts(drafts);
  }, [draftKey]);

  const openImagePicker = useCallback(() => {
    imageInputRef.current?.click();
  }, []);

  const clearImageAttachments = useCallback(() => {
    setImageAttachments((previous) => {
      for (const attachment of previous) {
        revokePreviewUrl(attachment.previewUrl);
      }
      return [];
    });
    const input = imageInputRef.current;
    if (input && activeDraftKeyRef.current === draftKey) {
      input.value = "";
    }
  }, [draftKey, setImageAttachments]);

  const removeImageAttachment = useCallback((attachmentId: string) => {
    setImageAttachments((previous) => {
      const match = previous.find((attachment) => attachment.id === attachmentId) ?? null;
      if (!match || match.sending) {
        // An image already uploading goes out with its message.
        return previous;
      }
      revokePreviewUrl(match.previewUrl);
      return previous.filter((attachment) => attachment.id !== attachmentId);
    });
  }, [setImageAttachments]);

  // A send carries the files it was given. Marking and removing go by those
  // files, so an image pasted or dropped while the send uploads stays staged
  // for the next message.
  const markImageAttachmentsSending = useCallback((files: File[], sending: boolean) => {
    if (files.length === 0) {
      return;
    }
    const carried = new Set(files);
    setImageAttachments((previous) => {
      if (!previous.some((attachment) => carried.has(attachment.file) && Boolean(attachment.sending) !== sending)) {
        return previous;
      }
      return previous.map((attachment) =>
        carried.has(attachment.file) ? { ...attachment, sending } : attachment,
      );
    });
  }, [setImageAttachments]);

  const removeSentImageAttachments = useCallback((files: File[]) => {
    if (files.length === 0) {
      return;
    }
    const sent = new Set(files);
    setImageAttachments((previous) => {
      if (!previous.some((attachment) => sent.has(attachment.file))) {
        return previous;
      }
      return previous.filter((attachment) => {
        if (!sent.has(attachment.file)) {
          return true;
        }
        revokePreviewUrl(attachment.previewUrl);
        return false;
      });
    });
    const input = imageInputRef.current;
    if (input && activeDraftKeyRef.current === draftKey) {
      input.value = "";
    }
  }, [draftKey, setImageAttachments]);

  const attachImageFiles = useCallback(
    (files: File[]) => {
      if (files.length === 0) {
        return;
      }
      if (unavailableReason) {
        showStatus(unavailableReason, "info", 4000);
        return;
      }
      const nextAttachments: PendingChatImageAttachment[] = [];
      let hasUnsupported = false;
      let hasTooLarge = false;
      let hasEmpty = false;

      for (const file of files) {
        const problem = isChatImageMimeType(file.type) ? chatAttachmentFileProblem(file) : "type";
        if (problem === "type") {
          hasUnsupported = true;
          continue;
        }
        if (problem === "size") {
          hasTooLarge = true;
          continue;
        }
        if (problem === "empty") {
          hasEmpty = true;
          continue;
        }
        const id =
          typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
            ? crypto.randomUUID()
            : `chat-image-${Date.now()}-${Math.random().toString(16).slice(2)}`;
        nextAttachments.push({
          id,
          file,
          previewUrl: URL.createObjectURL(file),
        });
      }

      if (hasUnsupported) {
        showStatus(CHAT_IMAGE_TYPE_REQUIREMENT, "info", 4000);
      }
      if (hasTooLarge) {
        showStatus(CHAT_ATTACHMENT_SIZE_REQUIREMENT, "error", 4000);
      }
      if (hasEmpty) {
        showStatus("Empty files weren't added.", "info", 3000);
      }
      if (nextAttachments.length === 0) {
        return;
      }

      onAttachmentsAdded?.();
      setImageAttachments((previous) => [...previous, ...nextAttachments]);
    },
    [onAttachmentsAdded, setImageAttachments, showStatus, unavailableReason],
  );

  const handleImageInputChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(event.target.files ?? []);
      if (files.length === 0) {
        return;
      }
      attachImageFiles(files);
      event.target.value = "";
    },
    [attachImageFiles],
  );

  const handleComposerDragOver = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      const dataTransfer = event.dataTransfer;
      if (!dataTransfer?.types?.includes("Files")) {
        return;
      }

      event.preventDefault();

      const items = Array.from(dataTransfer.items ?? []);
      const hasImage = items.some((item) => item.kind === "file" && isImageLike(item.type));
      // A drop on a server without attachment storage still lands, so the
      // drop handler can say why nothing was added.
      dataTransfer.dropEffect = !isInputLocked() && hasImage ? "copy" : "none";
    },
    [isInputLocked],
  );

  const handleComposerDrop = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      const dataTransfer = event.dataTransfer;
      if (!dataTransfer?.types?.includes("Files")) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();

      if (isInputLocked()) {
        showStatus("Finish onboarding before uploading attachments.", "info", 3500);
        return;
      }

      const files = Array.from(dataTransfer.files ?? []);
      if (files.length === 0) {
        return;
      }

      if (unavailableReason) {
        showStatus(unavailableReason, "info", 4000);
        return;
      }

      attachImageFiles(files);
    },
    [attachImageFiles, isInputLocked, showStatus, unavailableReason],
  );

  const handleComposerPaste = useCallback(
    (event: ClipboardEvent<HTMLDivElement>) => {
      const clipboardData = event.clipboardData;
      if (!clipboardData) {
        return;
      }

      const items = Array.from(clipboardData.items ?? []);
      const imageFiles = items
        .filter((item) => item.kind === "file" && isImageLike(item.type))
        .map((item) => item.getAsFile())
        .filter((file): file is File => file instanceof File);
      if (imageFiles.length === 0) {
        return;
      }

      if (isInputLocked()) {
        event.preventDefault();
        showStatus("Finish onboarding before uploading attachments.", "info", 3500);
        return;
      }

      event.preventDefault();
      attachImageFiles(imageFiles);
    },
    [attachImageFiles, isInputLocked, showStatus],
  );

  useEffect(() => {
    return () => {
      for (const attachments of attachmentDraftsRef.current.values()) {
        for (const attachment of attachments) revokePreviewUrl(attachment.previewUrl);
      }
      attachmentDraftsRef.current.clear();
    };
  }, []);

  return {
    attachImageFiles,
    clearImageAttachments,
    handleComposerDragOver,
    handleComposerDrop,
    handleComposerPaste,
    handleImageInputChange,
    imageAttachments,
    imageInputRef,
    markImageAttachmentsSending,
    openImagePicker,
    removeImageAttachment,
    removeSentImageAttachments,
  };
}
