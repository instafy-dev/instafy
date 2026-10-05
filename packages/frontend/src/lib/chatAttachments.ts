import { generateUUID } from "../utils/uuid";
import { hasSupabaseConfig, supabase } from "./supabaseClient";

// Chat attachments live in the private `chat-attachments` bucket, one folder
// per conversation (docs/Chat-Attachments.md). The bucket's policies decide
// who may upload and read, so every call here runs with the signed-in user's
// own Supabase session and never with a signed URL.

export const CHAT_ATTACHMENTS_BUCKET = "chat-attachments";

/** The bucket's per-object limit: 20 MiB. */
export const CHAT_ATTACHMENT_MAX_BYTES = 20 * 1024 * 1024;

const IMAGE_EXTENSIONS = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
} as const;

const TEXT_EXTENSIONS = {
  "text/plain": "txt",
  "text/markdown": "md",
} as const;

type ChatImageMimeType = keyof typeof IMAGE_EXTENSIONS;
type ChatTextMimeType = keyof typeof TEXT_EXTENSIONS;
export type ChatAttachmentMimeType = ChatImageMimeType | ChatTextMimeType;

/** The image types the picker offers; paste and drop take the same ones. */
export const CHAT_IMAGE_ACCEPT = Object.keys(IMAGE_EXTENSIONS).join(",");

export const CHAT_ATTACHMENTS_UNAVAILABLE_REASON = "This server can't store attachments.";

/**
 * Why the composer takes no attachments in a space, or null when it does.
 * Only a server that says `none` turns them off; an unknown answer (an older
 * controller, or a space still loading) leaves them on.
 */
export function chatAttachmentsUnavailableReason(mode: "storage" | "none" | null | undefined): string | null {
  return mode === "none" ? CHAT_ATTACHMENTS_UNAVAILABLE_REASON : null;
}
export const CHAT_IMAGE_TYPE_REQUIREMENT = "Only PNG, JPEG, WebP and GIF images can be attached.";
export const CHAT_ATTACHMENT_SIZE_REQUIREMENT = "Attachments must be 20 MB or smaller.";

/** How a message records one attachment in its metadata. */
export type ChatStorageAttachment = {
  kind: "image" | "file";
  storagePath: string;
  fileName: string;
  mimeType: ChatAttachmentMimeType;
  sizeBytes: number;
};

const UUID_SOURCE = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const CANONICAL_UUID = new RegExp(`^${UUID_SOURCE}$`);
const STORAGE_PATH = new RegExp(
  `^${UUID_SOURCE}/${UUID_SOURCE}/${UUID_SOURCE}\\.(png|jpg|webp|gif|txt|md)$`,
);

function normalizeMimeType(value: string | null | undefined): string {
  return (value ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
}

/** The attachment type of a MIME type the bucket takes, or null. */
export function chatAttachmentMimeType(value: string | null | undefined): ChatAttachmentMimeType | null {
  const normalized = normalizeMimeType(value);
  return normalized in IMAGE_EXTENSIONS || normalized in TEXT_EXTENSIONS
    ? (normalized as ChatAttachmentMimeType)
    : null;
}

export function isChatImageMimeType(value: string | null | undefined): boolean {
  return normalizeMimeType(value) in IMAGE_EXTENSIONS;
}

function extensionFor(mimeType: ChatAttachmentMimeType): string {
  return mimeType in IMAGE_EXTENSIONS
    ? IMAGE_EXTENSIONS[mimeType as ChatImageMimeType]
    : TEXT_EXTENSIONS[mimeType as ChatTextMimeType];
}

/**
 * `<projectId>/<conversationId>/<uuid>.<ext>`, every id in its one canonical
 * spelling. Storage refuses any other name.
 */
export function chatAttachmentObjectName(
  projectId: string,
  conversationId: string,
  mimeType: ChatAttachmentMimeType,
  objectId: string = generateUUID(),
): string {
  const segments = [projectId, conversationId, objectId].map((value) => value.trim().toLowerCase());
  if (!segments.every((segment) => CANONICAL_UUID.test(segment))) {
    throw new Error("Invalid attachment destination.");
  }
  return `${segments.join("/")}.${extensionFor(mimeType)}`;
}

export function isChatAttachmentStoragePath(value: unknown): value is string {
  return typeof value === "string" && STORAGE_PATH.test(value);
}

/**
 * Why a file can't be attached, or null when the bucket takes it. An empty
 * text file is fine (a merge's base can be an empty file); an empty image is not.
 */
export function chatAttachmentFileProblem(file: Pick<File, "type" | "size">): "type" | "size" | "empty" | null {
  if (!chatAttachmentMimeType(file.type)) return "type";
  if (file.size <= 0 && isChatImageMimeType(file.type)) return "empty";
  if (file.size > CHAT_ATTACHMENT_MAX_BYTES) return "size";
  return null;
}

/**
 * An attachment that was not stored, so nothing was sent. Its message is
 * plain copy for the person.
 */
export class ChatAttachmentUploadError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ChatAttachmentUploadError";
  }
}

export function isChatAttachmentUploadError(error: unknown): error is ChatAttachmentUploadError {
  return error instanceof ChatAttachmentUploadError;
}

function readStorageErrorParts(error: unknown): { status: number | null; code: string; message: string } {
  if (!error || typeof error !== "object") {
    return { status: null, code: "", message: typeof error === "string" ? error : "" };
  }
  const record = error as { status?: unknown; statusCode?: unknown; message?: unknown; originalError?: unknown };
  const original =
    record.originalError && typeof record.originalError === "object"
      ? (record.originalError as { status?: unknown })
      : null;
  const status =
    typeof record.status === "number"
      ? record.status
      : typeof original?.status === "number"
        ? original.status
        : null;
  return {
    status,
    code: typeof record.statusCode === "string" ? record.statusCode : "",
    message: typeof record.message === "string" ? record.message : "",
  };
}

/** Plain copy for a failed upload. Storage's own wording never reaches the person. */
export function describeChatAttachmentUploadError(error: unknown): string {
  if (isChatAttachmentUploadError(error)) {
    return error.message;
  }
  const { status, code, message } = readStorageErrorParts(error);
  const lower = message.toLowerCase();
  if (code === "413" || status === 413 || /maximum allowed size|too large|payload/.test(lower)) {
    return CHAT_ATTACHMENT_SIZE_REQUIREMENT;
  }
  if (code === "415" || status === 415 || /mime type|invalid_mime_type/.test(lower)) {
    return CHAT_IMAGE_TYPE_REQUIREMENT;
  }
  if (/jwt|token/.test(lower) || status === 401) {
    return "Your sign-in has expired. Reload the page and try again.";
  }
  if (/bucket not found/.test(lower)) {
    return CHAT_ATTACHMENTS_UNAVAILABLE_REASON;
  }
  if (
    code === "403" ||
    status === 403 ||
    /row-level security|unauthorized|forbidden|not allowed/.test(lower)
  ) {
    return "You can't add attachments to this chat.";
  }
  if (code === "429" || status === 429) {
    return "Too many uploads at once. Wait a moment and try again.";
  }
  if ((status !== null && status >= 500) || /^5\d\d$/.test(code)) {
    return "Storage isn't responding right now. Try again in a moment.";
  }
  if (status === null && /failed to fetch|networkerror|load failed|network request failed|timed? ?out/.test(lower)) {
    return "Couldn't reach storage. Check your connection and try again.";
  }
  return "Couldn't upload the attachment. Try again.";
}

function storageBucket() {
  if (!hasSupabaseConfig) {
    throw new ChatAttachmentUploadError(CHAT_ATTACHMENTS_UNAVAILABLE_REASON);
  }
  return supabase.storage.from(CHAT_ATTACHMENTS_BUCKET);
}

/**
 * Stores one file in the conversation's folder with the person's session and
 * returns its message metadata. A name is never reused (upsert is off), and
 * the multipart body carries the exact type the bucket checks.
 */
export async function uploadChatAttachment(args: {
  projectId: string;
  conversationId: string;
  file: File;
  fileName: string;
}): Promise<ChatStorageAttachment> {
  const { projectId, conversationId, file, fileName } = args;
  const mimeType = chatAttachmentMimeType(file.type);
  const problem = chatAttachmentFileProblem(file);
  if (!mimeType || problem === "type") {
    throw new ChatAttachmentUploadError(CHAT_IMAGE_TYPE_REQUIREMENT);
  }
  if (problem === "size") {
    throw new ChatAttachmentUploadError(CHAT_ATTACHMENT_SIZE_REQUIREMENT);
  }
  if (problem === "empty") {
    throw new ChatAttachmentUploadError(`${fileName} is empty, so it wasn't attached.`);
  }
  const storagePath = chatAttachmentObjectName(projectId, conversationId, mimeType);
  const body = file.type === mimeType ? file : new File([file], file.name, { type: mimeType });
  let failure: unknown = null;
  try {
    const { error } = await storageBucket().upload(storagePath, body, {
      upsert: false,
      contentType: mimeType,
    });
    failure = error ?? null;
  } catch (error) {
    failure = error;
  }
  if (failure) {
    throw new ChatAttachmentUploadError(describeChatAttachmentUploadError(failure), { cause: failure });
  }
  return {
    kind: mimeType in IMAGE_EXTENSIONS ? "image" : "file",
    storagePath,
    fileName,
    mimeType,
    sizeBytes: file.size,
  };
}

/**
 * Removes attachments this person just uploaded for a message that was not
 * sent. Best effort: the bucket lets an uploader delete their own objects.
 */
export async function removeChatAttachments(storagePaths: string[]): Promise<void> {
  const paths = storagePaths.filter(isChatAttachmentStoragePath);
  if (paths.length === 0) return;
  try {
    await storageBucket().remove(paths);
  } catch {
    // An orphan stays private to the conversation and goes with its space.
  }
}

/**
 * `refused`: Storage answered and will not hand the object over (not a reader
 * of the conversation, or the object is gone), so trying again does not help.
 * `transient`: no answer, or a busy or failing Storage, so it may work later.
 */
export type ChatAttachmentDownloadFailure = "refused" | "transient";

export type ChatAttachmentDownloadResult =
  | { ok: true; blob: Blob }
  | { ok: false; reason: ChatAttachmentDownloadFailure };

function downloadFailureReason(error: unknown): ChatAttachmentDownloadFailure {
  if (isChatAttachmentUploadError(error)) {
    // No Storage on this server at all.
    return "refused";
  }
  const { status, code, message } = readStorageErrorParts(error);
  if (status === null && !code) {
    // No HTTP answer to go by: only Storage's own wording says it refused.
    return /not found|row-level security|unauthorized|forbidden|denied/i.test(message) ? "refused" : "transient";
  }
  if (status === 429 || code === "429" || (status !== null && status >= 500) || /^5\d\d$/.test(code)) {
    return "transient";
  }
  return "refused";
}

/**
 * Downloads one attachment with the person's session. A read Storage refuses
 * (not a reader of the conversation) or a deleted object comes back as
 * `refused`; a network failure or a failing Storage as `transient`.
 */
export async function downloadChatAttachment(storagePath: string): Promise<ChatAttachmentDownloadResult> {
  if (!isChatAttachmentStoragePath(storagePath)) {
    return { ok: false, reason: "refused" };
  }
  try {
    const { data, error } = await storageBucket().download(storagePath);
    if (error) {
      return { ok: false, reason: downloadFailureReason(error) };
    }
    if (!(data instanceof Blob)) {
      return { ok: false, reason: "refused" };
    }
    return { ok: true, blob: data };
  } catch (error) {
    return { ok: false, reason: downloadFailureReason(error) };
  }
}
