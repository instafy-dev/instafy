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

export type PendingChatImageAttachment = {
  id: string;
  file: File;
  previewUrl: string;
};

type ShowStatus = (message: string, intent?: StatusIntent, durationMs?: number) => void;
const EMPTY_ATTACHMENTS: PendingChatImageAttachment[] = [];

function revokePreviewUrl(previewUrl: string) {
  try {
    URL.revokeObjectURL(previewUrl);
  } catch (_error) {
    // ignore cleanup failure
  }
}

export function useChatComposerAttachments({
  draftKey,
  isInputLocked,
  showStatus,
  onAttachmentsAdded,
}: {
  draftKey: string;
  isInputLocked: () => boolean;
  showStatus: ShowStatus;
  onAttachmentsAdded?: () => void;
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
    const drafts = new Map(attachmentDraftsRef.current);
    const next = update(drafts.get(draftKey) ?? EMPTY_ATTACHMENTS);
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
      if (match) {
        revokePreviewUrl(match.previewUrl);
      }
      return previous.filter((attachment) => attachment.id !== attachmentId);
    });
  }, [setImageAttachments]);

  const clearSubmittedImageAttachments = useCallback((files: File[]) => {
    const submitted = new Set(files);
    setImageAttachments((previous) => previous.filter((attachment) => {
      if (!submitted.has(attachment.file)) return true;
      revokePreviewUrl(attachment.previewUrl);
      return false;
    }));
  }, [setImageAttachments]);

  const attachImageFiles = useCallback(
    (files: File[]) => {
      const maxBytes = 5 * 1024 * 1024;
      const nextAttachments: PendingChatImageAttachment[] = [];
      let hasNonImage = false;
      let hasTooLarge = false;

      for (const file of files) {
        if (!file.type || !file.type.startsWith("image/")) {
          hasNonImage = true;
          continue;
        }
        if (file.size > maxBytes) {
          hasTooLarge = true;
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

      if (hasNonImage) {
        showStatus("Skipped non-image files.", "info", 3000);
      }
      if (hasTooLarge) {
        showStatus("Skipped image(s) larger than 5MB.", "error", 4000);
      }
      if (nextAttachments.length === 0) {
        return;
      }

      onAttachmentsAdded?.();
      setImageAttachments((previous) => [...previous, ...nextAttachments]);
    },
    [onAttachmentsAdded, setImageAttachments, showStatus],
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
      const hasImage = items.some((item) => item.kind === "file" && item.type.startsWith("image/"));
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

      const images = files.filter((file) => file.type.startsWith("image/"));
      if (images.length === 0) {
        showStatus("Drop an image file to upload.", "error", 3500);
        return;
      }

      attachImageFiles(images);
    },
    [attachImageFiles, isInputLocked, showStatus],
  );

  const handleComposerPaste = useCallback(
    (event: ClipboardEvent<HTMLDivElement>) => {
      const clipboardData = event.clipboardData;
      if (!clipboardData) {
        return;
      }

      const items = Array.from(clipboardData.items ?? []);
      const imageFiles = items
        .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
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
    clearSubmittedImageAttachments,
    handleComposerDragOver,
    handleComposerDrop,
    handleComposerPaste,
    handleImageInputChange,
    imageAttachments,
    imageInputRef,
    openImagePicker,
    removeImageAttachment,
  };
}
