import {
  useCallback,
  useLayoutEffect,
  useRef,
  useSyncExternalStore,
  type ChangeEvent,
  type ClipboardEvent,
  type DragEvent,
} from "react";
import type { StatusIntent } from "../../../status/useStatus";
import { useChatAttachmentDraftStore } from "../../../conversations/ChatAttachmentDraftsProvider";
import { revokeChatAttachmentPreview, type PendingChatImageAttachment } from "../../../conversations/chatAttachmentDrafts";
export type { PendingChatImageAttachment } from "../../../conversations/chatAttachmentDrafts";

type ShowStatus = (message: string, intent?: StatusIntent, durationMs?: number) => void;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

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
  const store = useChatAttachmentDraftStore();
  const getSnapshot = useCallback(() => store.get(draftKey), [draftKey, store]);
  const imageAttachments = useSyncExternalStore(store.subscribe, getSnapshot, getSnapshot);
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const activeDraftKeyRef = useRef(draftKey);
  const isInputLockedRef = useRef(isInputLocked);

  useLayoutEffect(() => {
    activeDraftKeyRef.current = draftKey;
    if (imageInputRef.current) imageInputRef.current.value = "";
    return () => { activeDraftKeyRef.current = ""; };
  }, [draftKey]);

  useLayoutEffect(() => {
    isInputLockedRef.current = isInputLocked;
  }, [isInputLocked]);

  // Keep callbacks bound to their originating chat, including an upload/send
  // that completes after the user has already selected another conversation.
  const setImageAttachments = useCallback((update: (
    previous: PendingChatImageAttachment[],
  ) => PendingChatImageAttachment[]) => {
    return store.update(draftKey, update);
  }, [draftKey, store]);

  const openImagePicker = useCallback(() => {
    imageInputRef.current?.click();
  }, []);

  const clearImageAttachments = useCallback(() => {
    setImageAttachments(() => []);
    const input = imageInputRef.current;
    if (input && activeDraftKeyRef.current === draftKey) {
      input.value = "";
    }
  }, [draftKey, setImageAttachments]);

  const removeImageAttachment = useCallback((attachmentId: string) => {
    setImageAttachments((previous) => {
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
    setImageAttachments((previous) => previous.filter((attachment) => !submitted.has(attachment.file)));
  }, [setImageAttachments]);

  const attachImageFiles = useCallback(
    (files: File[]) => {
      const acceptedFiles: File[] = [];
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
        acceptedFiles.push(file);
      }

      if (hasNonImage) {
        showStatus("Skipped non-image files.", "info", 3000);
      }
      if (hasTooLarge) {
        showStatus("Skipped image(s) larger than 5MB.", "error", 4000);
      }
      if (acceptedFiles.length === 0) {
        return;
      }

      try {
        const added = setImageAttachments((previous) => {
          const nextAttachments: PendingChatImageAttachment[] = [];
          try {
            for (const file of acceptedFiles) {
              const id = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
                ? crypto.randomUUID()
                : `chat-image-${Date.now()}-${Math.random().toString(16).slice(2)}`;
              nextAttachments.push({ id, file, previewUrl: URL.createObjectURL(file) });
            }
          } catch (error) {
            for (const attachment of nextAttachments) revokeChatAttachmentPreview(attachment.previewUrl);
            throw error;
          }
          return [...previous, ...nextAttachments];
        });
        if (added) onAttachmentsAdded?.();
      } catch (error) {
        showStatus(error instanceof Error ? error.message : "Unable to add these images.", "error", 5000);
      }
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
