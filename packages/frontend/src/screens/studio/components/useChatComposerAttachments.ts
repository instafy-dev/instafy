import {
  useCallback,
  useEffect,
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

function revokePreviewUrl(previewUrl: string) {
  try {
    URL.revokeObjectURL(previewUrl);
  } catch (_error) {
    // ignore cleanup failure
  }
}

export function useChatComposerAttachments({
  isInputLocked,
  showStatus,
}: {
  isInputLocked: () => boolean;
  showStatus: ShowStatus;
}) {
  const [imageAttachments, setImageAttachments] = useState<PendingChatImageAttachment[]>([]);
  const imageAttachmentPreviewUrlsRef = useRef<string[]>([]);
  const imageInputRef = useRef<HTMLInputElement | null>(null);

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
    if (input) {
      input.value = "";
    }
  }, []);

  const removeImageAttachment = useCallback((attachmentId: string) => {
    setImageAttachments((previous) => {
      const match = previous.find((attachment) => attachment.id === attachmentId) ?? null;
      if (match) {
        revokePreviewUrl(match.previewUrl);
      }
      return previous.filter((attachment) => attachment.id !== attachmentId);
    });
  }, []);

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

      setImageAttachments((previous) => [...previous, ...nextAttachments]);
    },
    [showStatus],
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
    imageAttachmentPreviewUrlsRef.current = imageAttachments.map((attachment) => attachment.previewUrl);
  }, [imageAttachments]);

  useEffect(() => {
    return () => {
      for (const previewUrl of imageAttachmentPreviewUrlsRef.current) {
        revokePreviewUrl(previewUrl);
      }
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
    openImagePicker,
    removeImageAttachment,
  };
}
