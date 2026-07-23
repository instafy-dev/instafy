import { controllerClient } from "../sdk/instafy";
import type { ChatMessage } from "../screens/studio/types";

const { applyChanges: applyWorkspaceChangesViaOrigin } = controllerClient.workspace.origin;

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

export function mimeTypeToExtension(mimeType: string): string {
  const normalized = (mimeType ?? "").trim().toLowerCase();
  switch (normalized) {
    case "image/jpeg":
      return "jpg";
    case "image/png":
      return "png";
    case "image/webp":
      return "webp";
    case "image/gif":
      return "gif";
    case "image/svg+xml":
      return "svg";
    default:
      return "img";
  }
}

export function shouldRetryChatImageUploadError(message: string): boolean {
  const lower = (message ?? "").toLowerCase();
  if (
    lower.includes("failed to fetch") ||
    lower.includes("networkerror") ||
    lower.includes("load failed") ||
    lower.includes("gateway timeout") ||
    lower.includes("timed out") ||
    lower.includes("timeout") ||
    lower.includes("aborterror")
  ) {
    return true;
  }
  const match = lower.match(/origin apply failed \((\d+)\)/);
  if (match) {
    const status = Number(match[1]);
    if (status === 408 || status === 429 || (status >= 500 && status <= 599)) {
      return true;
    }
  }
  return (
    lower.includes("no origin available") ||
    lower.includes("origin is offline") ||
    lower.includes("failed to obtain origin token") ||
    lower.includes("project lock acquisition failed") ||
    lower.includes("project lock renewal failed") ||
    lower.includes("workspace lease acquisition failed") ||
    lower.includes("workspace lease renewal failed") ||
    lower.includes("runtime is unavailable") ||
    lower.includes("runtime_not_ready")
  );
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

export async function uploadConversationImageAttachments(args: {
  projectId: string;
  runtimeId: string | null;
  imageFiles: File[];
}) {
  const { projectId, runtimeId, imageFiles } = args;
  const attachments: Array<{
    kind: "image";
    workspacePath: string;
    fileName: string;
    mimeType: string | null;
    sizeBytes: number;
  }> = [];

  for (const imageFile of imageFiles) {
    const safeName = sanitizeChatUploadFileName(imageFile.name || "image");
    const ext = safeName.includes(".") ? "" : mimeTypeToExtension(imageFile.type);
    const fileName = ext ? `${safeName}.${ext}` : safeName;
    const uploadId =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const workspacePath = `chat-upload-${Date.now()}-${uploadId}-${fileName}`;

    const bytes = new Uint8Array(await imageFile.arrayBuffer());
    const uploadDeadline = Date.now() + 60_000;
    let uploadAttempt = 0;
    let result = await applyWorkspaceChangesViaOrigin({
      projectId,
      files: [
        {
          path: workspacePath,
          bytes,
          encoding: "binary",
        },
      ],
      deletes: [],
      runtimeId,
      preferRuntime: runtimeId,
      accessToken: null,
    });
    while (!result.ok && Date.now() < uploadDeadline) {
      const errorMessage = result.error ?? "Failed to upload image.";
      if (!shouldRetryChatImageUploadError(errorMessage)) {
        break;
      }
      uploadAttempt += 1;
      await sleep(Math.min(500 * uploadAttempt, 2_000));
      result = await applyWorkspaceChangesViaOrigin({
        projectId,
        files: [
          {
            path: workspacePath,
            bytes,
            encoding: "binary",
          },
        ],
        deletes: [],
        runtimeId,
        preferRuntime: runtimeId,
        accessToken: null,
      });
    }
    if (!result.ok) {
      throw new Error(result.error ?? "Failed to upload image.");
    }

    attachments.push({
      kind: "image",
      workspacePath,
      fileName,
      mimeType: imageFile.type || null,
      sizeBytes: imageFile.size,
    });
  }

  return attachments;
}
