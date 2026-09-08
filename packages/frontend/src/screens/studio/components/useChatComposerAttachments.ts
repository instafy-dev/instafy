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
  originalFile?: File;
};

type ShowStatus = (message: string, intent?: StatusIntent, durationMs?: number) => void;
const EMPTY_ATTACHMENTS: PendingChatImageAttachment[] = [];
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

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
  const isInputLockedRef = useRef(isInputLocked);

  useLayoutEffect(() => {
    activeDraftKeyRef.current = draftKey;
    if (imageInputRef.current) imageInputRef.current.value = "";
  }, [draftKey]);

  useLayoutEffect(() => {
    isInputLockedRef.current = isInputLocked;
  }, [isInputLocked]);

  // Keep callbacks bound to their originating chat, including an upload/send
  // that completes after the user has already selected another conversation.
  const setImageAttachments = useCallback((update: (
    previous: PendingChatImageAttachment[],
  ) => PendingChatImageAttachment[]) => {
    const previous = attachmentDraftsRef.current.get(draftKey) ?? EMPTY_ATTACHMENTS;
    const next = update(previous);
    if (next === previous) return;
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
      if (match) {
        revokePreviewUrl(match.previewUrl);
      }
      return previous.filter((attachment) => attachment.id !== attachmentId);
    });
  }, [setImageAttachments]);

  // A null replacement restores the first original. Keep only its File; it
  // does not need a second live preview URL while the edited image is shown.
  const updateImageAttachment = useCallback((
    attachmentId: string,
    expectedFile: File,
    nextFile: File | null,
  ): boolean => {
    if (activeDraftKeyRef.current !== draftKey || isInputLockedRef.current()) return false;
    let updated = false;
    setImageAttachments((previous) => {
      const index = previous.findIndex((attachment) => attachment.id === attachmentId && attachment.file === expectedFile);
      if (index < 0) return previous;
      const current = previous[index]!;
      const file = nextFile ?? current.originalFile;
      if (!file) return previous;
      if (!(file instanceof File) || !file.type.startsWith("image/")) {
        throw new Error("Choose an image file to replace this attachment.");
      }
      if (file.size > MAX_IMAGE_BYTES) {
        throw new Error("The edited image must be 5MB or smaller.");
      }
      // Allocate before changing state or revoking the visible preview. If
      // allocation fails, the existing image and its original remain usable.
      const previewUrl = URL.createObjectURL(file);
      const replacement: PendingChatImageAttachment = { ...current, file, previewUrl };
      if (nextFile === null) delete replacement.originalFile;
      else replacement.originalFile = current.originalFile ?? current.file;
      const next = previous.slice();
      next[index] = replacement;
      revokePreviewUrl(current.previewUrl);
      updated = true;
      return next;
    });
    return updated;
  }, [draftKey, setImageAttachments]);

  const replaceImageAttachment = useCallback((attachmentId: string, expectedFile: File, nextFile: File): boolean =>
    updateImageAttachment(attachmentId, expectedFile, nextFile), [updateImageAttachment]);

  const restoreImageAttachment = useCallback((attachmentId: string, expectedFile: File): boolean =>
    updateImageAttachment(attachmentId, expectedFile, null), [updateImageAttachment]);

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
      const nextAttachments: PendingChatImageAttachment[] = [];
      let hasNonImage = false;
      let hasTooLarge = false;

      for (const file of files) {
        if (!file.type || !file.type.startsWith("image/")) {
          hasNonImage = true;
          continue;
        }
        if (file.size > MAX_IMAGE_BYTES) {
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
    replaceImageAttachment,
    restoreImageAttachment,
  };
}
