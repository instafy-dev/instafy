import {
  ChatAttachmentUploadError,
  describeChatAttachmentUploadError,
  removeChatAttachments,
  uploadChatAttachment,
  type ChatStorageAttachment,
} from "../lib/chatAttachments";
import type { ChatMessage } from "../screens/studio/types";

export function detectClientTimezone(): string {
  try {
    if (typeof Intl !== "undefined") {
      const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      if (typeof timezone === "string" && timezone.trim().length > 0) {
        return timezone.trim();
      }
    }
  } catch {
    // ignore
  }
  return "UTC";
}

export function detectClientLocale(): string {
  try {
    if (typeof navigator !== "undefined" && typeof navigator.language === "string") {
      const locale = navigator.language.trim();
      if (locale.length > 0) {
        return locale;
      }
    }
    if (typeof Intl !== "undefined") {
      const locale = Intl.DateTimeFormat().resolvedOptions().locale;
      if (typeof locale === "string" && locale.trim().length > 0) {
        return locale.trim();
      }
    }
  } catch {
    // ignore
  }
  return "en-US";
}

export function formatClientLocalDateTime(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absoluteOffsetMinutes = Math.abs(offsetMinutes);
  const offsetHours = Math.floor(absoluteOffsetMinutes / 60);
  const remainingOffsetMinutes = absoluteOffsetMinutes % 60;
  return [
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`,
    `${sign}${pad(offsetHours)}:${pad(remainingOffsetMinutes)}`,
  ].join("");
}

export function createConversationMessage(
  role: ChatMessage["role"],
  content: string,
  authorId?: string | null,
  metadata?: Record<string, unknown> | null,
): ChatMessage {
  return {
    id: `${role}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    role,
    authorId: authorId ?? null,
    content,
    timestamp: Date.now(),
    files: null,
    messageType: role === "assistant" ? "status" : "user",
    metadata: metadata ?? null,
  };
}

export function buildConversationClientMetadata(
  sessionId: string,
  currentUserId: string | null,
  now = new Date(),
) {
  return {
    sessionId,
    userId: currentUserId,
    timezone: detectClientTimezone(),
    locale: detectClientLocale(),
    localDateTime: formatClientLocalDateTime(now),
  };
}

export function isLearnPrompt(prompt: string): boolean {
  const lowered = prompt.trim().toLowerCase();
  if (!lowered) {
    return false;
  }
  return lowered.startsWith("/learn");
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

export function sanitizeChatUploadFileName(rawName: string): string {
  const trimmed = rawName.trim();
  if (!trimmed) {
    return "image";
  }
  const cleaned = trimmed.replace(/[/\\?%*:|"<>]/g, "-").replace(/\s+/g, "-");
  return cleaned.length > 80 ? cleaned.slice(0, 80) : cleaned;
}

export function resolveSubmittedImageFiles(imageFile?: File | null, imageFiles?: File[]) {
  const provided = Array.isArray(imageFiles)
    ? imageFiles.filter((file): file is File => file instanceof File)
    : [];
  if (provided.length > 0) {
    return provided;
  }
  return imageFile ? [imageFile] : [];
}

export function patchConversationMessageMetadata(
  updateMessage: (
    conversationId: string,
    messageId: string,
    updater: (message: ChatMessage) => ChatMessage,
  ) => void,
  conversationId: string,
  messageId: string,
  metadata: Record<string, unknown> | null,
) {
  updateMessage(conversationId, messageId, (previous) => {
    const previousMetadata =
      previous.metadata && typeof previous.metadata === "object"
        ? (previous.metadata as Record<string, unknown>)
        : {};
    return {
      ...previous,
      metadata: {
        ...previousMetadata,
        ...(metadata ?? {}),
      },
    };
  });
}

/**
 * Stores a message's attachments in its conversation's Storage folder with the
 * person's session and returns their message metadata, in order. The
 * conversation must already exist on the controller. When any upload fails,
 * the ones that succeeded are removed again and a ChatAttachmentUploadError
 * with plain copy is thrown, so a message is sent with all of its attachments
 * or not at all.
 */
export async function uploadConversationAttachments(args: {
  projectId: string;
  conversationId: string;
  files: File[];
}): Promise<ChatStorageAttachment[]> {
  const { projectId, conversationId, files } = args;
  const results = await Promise.allSettled(
    files.map((file) =>
      uploadChatAttachment({
        projectId,
        conversationId,
        file,
        fileName: sanitizeChatUploadFileName(file.name || "attachment"),
      }),
    ),
  );
  const failure = results.find(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (failure) {
    await removeChatAttachments(
      results.flatMap((result) => (result.status === "fulfilled" ? [result.value.storagePath] : [])),
    );
    const reason: unknown = failure.reason;
    throw reason instanceof ChatAttachmentUploadError
      ? reason
      : new ChatAttachmentUploadError(describeChatAttachmentUploadError(reason), { cause: reason });
  }
  return results.map((result) => (result as PromiseFulfilledResult<ChatStorageAttachment>).value);
}
