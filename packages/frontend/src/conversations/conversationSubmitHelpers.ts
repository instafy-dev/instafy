import {
  ChatAttachmentUploadError,
  describeChatAttachmentUploadError,
  removeChatAttachments,
  uploadChatAttachment,
  type ChatStorageAttachment,
} from "../lib/chatAttachments";
import { seedChatAttachmentPreview } from "../lib/chatAttachmentPreviews";
import type { ChatMessage } from "../screens/studio/types";

export function detectClientTimezone(): string | null {
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
  // An unavailable browser timezone is unknown, not evidence that the user is
  // in UTC. Keep that distinction in the context sent to the runtime.
  return null;
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

/** The longest attachment `fileName` a message records. */
export const CHAT_UPLOAD_FILE_NAME_MAX_LENGTH = 80;

export function sanitizeChatUploadFileName(rawName: string): string {
  const trimmed = rawName.trim();
  if (!trimmed) {
    return "image";
  }
  const cleaned = trimmed.replace(/[/\\?%*:|"<>]/g, "-").replace(/\s+/g, "-");
  return cleaned.length > CHAT_UPLOAD_FILE_NAME_MAX_LENGTH
    ? cleaned.slice(0, CHAT_UPLOAD_FILE_NAME_MAX_LENGTH)
    : cleaned;
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

/** At most this many of a message's attachments upload at once. */
export const CHAT_ATTACHMENT_UPLOAD_CONCURRENCY = 3;

/**
 * Runs `run` over `items`, at most `limit` at a time, in order. After the
 * first failure no further item starts; those that did not run are left out
 * of the results.
 */
async function settleInTurn<T, R>(
  items: T[],
  limit: number,
  run: (item: T) => Promise<R>,
): Promise<Array<PromiseSettledResult<R> | undefined>> {
  const results: Array<PromiseSettledResult<R> | undefined> = new Array(items.length).fill(undefined);
  let next = 0;
  let failed = false;
  const worker = async () => {
    while (!failed && next < items.length) {
      const index = next;
      next += 1;
      try {
        results[index] = { status: "fulfilled", value: await run(items[index]) };
      } catch (reason) {
        failed = true;
        results[index] = { status: "rejected", reason };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

/**
 * Stores a message's attachments in its conversation's Storage folder with the
 * person's session and returns their message metadata, in order. The
 * conversation must already exist on the controller. When any upload fails,
 * the ones that succeeded are removed again and a ChatAttachmentUploadError
 * with plain copy is thrown, so a message is sent with all of its attachments
 * or not at all. Stored images are kept as local previews, so the sender's
 * own message shows them without downloading them again.
 */
export async function uploadConversationAttachments(args: {
  projectId: string;
  conversationId: string;
  files: File[];
}): Promise<ChatStorageAttachment[]> {
  const { projectId, conversationId, files } = args;
  const results = await settleInTurn(files, CHAT_ATTACHMENT_UPLOAD_CONCURRENCY, (file) =>
    uploadChatAttachment({
      projectId,
      conversationId,
      file,
      fileName: sanitizeChatUploadFileName(file.name || "attachment"),
    }),
  );
  const failure = results.find(
    (result): result is PromiseRejectedResult => result?.status === "rejected",
  );
  if (failure || results.some((result) => result === undefined)) {
    await removeChatAttachments(
      results.flatMap((result) => (result?.status === "fulfilled" ? [result.value.storagePath] : [])),
    );
    const reason: unknown = failure?.reason;
    throw reason instanceof ChatAttachmentUploadError
      ? reason
      : new ChatAttachmentUploadError(describeChatAttachmentUploadError(reason), { cause: reason });
  }
  const attachments = results.map((result) => (result as PromiseFulfilledResult<ChatStorageAttachment>).value);
  attachments.forEach((attachment, index) => {
    if (attachment.kind === "image") {
      seedChatAttachmentPreview(attachment.storagePath, files[index]);
    }
  });
  return attachments;
}
