import type { ChatMessage } from "../screens/studio/types";
import {
  extractRuntimePreferenceDetails,
  type RuntimePreferenceDetails,
} from "../runtime/runtimePreferenceUtils";

export type ConversationVisibility = "public" | "private";

export type ConversationLifecycleStatus =
  | "active"
  | "archived"
  | "hidden"
  | "deleted";

export type ConversationRuntimePreference = RuntimePreferenceDetails;
export type ConversationOwnerAgent = {
  id: string | null;
  handle: string | null;
};

const CONVERSATION_LIFECYCLE_METADATA_PREFIX =
  "instafy_conversation_lifecycle_v1_";

function normalizeMessageTypeValue(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed.toLowerCase();
}

export function isPlainObject(
  value: unknown,
): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function extractConversationTitleFromMetadata(
  metadata: Record<string, unknown> | null | undefined,
): string | null {
  if (!metadata || typeof metadata !== "object") {
    return null;
  }
  const title = metadata.title;
  if (typeof title !== "string") {
    return null;
  }
  const trimmed = title.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function extractConversationLocalIdFromMetadata(
  metadata: Record<string, unknown> | null | undefined,
): string | null {
  if (!metadata || typeof metadata !== "object") {
    return null;
  }
  const raw = metadata.localId ?? metadata.local_id;
  if (typeof raw !== "string") {
    return null;
  }
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeAgentHandleValue(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim().replace(/^@+/, "").trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeUuidLikeValue(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function extractConversationOwnerAgentFromMetadata(
  metadata: Record<string, unknown> | null | undefined,
): ConversationOwnerAgent | null {
  if (!isPlainObject(metadata)) {
    return null;
  }
  const ownerAgent = isPlainObject(metadata.ownerAgent)
    ? metadata.ownerAgent
    : isPlainObject(metadata.owner_agent)
      ? metadata.owner_agent
      : null;
  if (!ownerAgent) {
    return null;
  }
  const handle = normalizeAgentHandleValue(ownerAgent.handle);
  const id = normalizeUuidLikeValue(ownerAgent.id);
  if (!handle && !id) {
    return null;
  }
  return { id, handle };
}

export function extractConversationOriginMessageIdFromMetadata(
  metadata: Record<string, unknown> | null | undefined,
): string | null {
  if (!isPlainObject(metadata)) {
    return null;
  }
  return normalizeUuidLikeValue(
    metadata.originMessageId ?? metadata.origin_message_id,
  );
}

export function extractConversationDelegatedByAgentIdFromMetadata(
  metadata: Record<string, unknown> | null | undefined,
): string | null {
  if (!isPlainObject(metadata)) {
    return null;
  }
  return normalizeUuidLikeValue(
    metadata.delegatedByAgentId ?? metadata.delegated_by_agent_id,
  );
}

export function createConversationThreadMetadataPatch(input: {
  ownerAgentId?: string | null;
  ownerAgentHandle?: string | null;
  originMessageId?: string | null;
  delegatedByAgentId?: string | null;
}): Record<string, unknown> {
  const handle = normalizeAgentHandleValue(input.ownerAgentHandle);
  const id = normalizeUuidLikeValue(input.ownerAgentId);
  const originMessageId = normalizeUuidLikeValue(input.originMessageId);
  const delegatedByAgentId = normalizeUuidLikeValue(input.delegatedByAgentId);

  const patch: Record<string, unknown> = {};
  if (handle || id) {
    patch.ownerAgent = {
      ...(id ? { id } : {}),
      ...(handle ? { handle } : {}),
    };
  }
  if (originMessageId) {
    patch.originMessageId = originMessageId;
  }
  if (delegatedByAgentId) {
    patch.delegatedByAgentId = delegatedByAgentId;
  }
  return patch;
}

export function extractConversationLocalIdFromMessageMetadata(
  metadata: Record<string, unknown> | null | undefined,
): string | null {
  if (!metadata || typeof metadata !== "object") {
    return null;
  }
  const candidate =
    metadata.conversation_metadata ?? metadata.conversationMetadata;
  if (!isPlainObject(candidate)) {
    return null;
  }
  const raw = candidate.localId ?? candidate.local_id;
  if (typeof raw !== "string") {
    return null;
  }
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function getConversationLifecycleMetadataKey(userId: string): string {
  return `${CONVERSATION_LIFECYCLE_METADATA_PREFIX}${userId}`;
}

function normalizeConversationLifecycleStatus(
  value: unknown,
): ConversationLifecycleStatus | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  if (
    normalized === "active" ||
    normalized === "archived" ||
    normalized === "hidden" ||
    normalized === "deleted"
  ) {
    return normalized;
  }
  return null;
}

export function extractConversationLifecycleFromMetadata(
  metadata: Record<string, unknown> | null | undefined,
  userId: string | null,
): ConversationLifecycleStatus {
  if (!metadata || !userId) {
    return "active";
  }
  const key = getConversationLifecycleMetadataKey(userId);
  const raw = metadata[key];
  const direct = normalizeConversationLifecycleStatus(raw);
  if (direct) {
    return direct;
  }
  if (isPlainObject(raw)) {
    const fromObject = normalizeConversationLifecycleStatus(raw.status);
    if (fromObject) {
      return fromObject;
    }
  }
  return "active";
}

export function resolveConversationVisibilityCandidate(
  value: unknown,
): ConversationVisibility | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "private") {
    return "private";
  }
  if (normalized === "public") {
    return "public";
  }
  return null;
}

export function resolveConversationVisibility(
  value: unknown,
  metadata?: Record<string, unknown> | null | undefined,
): ConversationVisibility {
  return (
    resolveConversationVisibilityCandidate(value) ??
    resolveConversationVisibilityCandidate(metadata?.visibility) ??
    "public"
  );
}

export function formatNotificationBody(content: string): string | null {
  const normalized = content.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return null;
  }
  const maxLength = 180;
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength - 1)}…`;
}

export function computePlanSignature(message: ChatMessage): string | null {
  const type = normalizeMessageTypeValue(message.messageType);
  let resolvedType = type;
  if (!resolvedType && isPlainObject(message.metadata)) {
    resolvedType =
      normalizeMessageTypeValue(message.metadata.messageType) ??
      normalizeMessageTypeValue(message.metadata.message_type);
  }
  if (resolvedType !== "todo_list") {
    return null;
  }
  if (!isPlainObject(message.metadata)) {
    return `plan:${message.content.trim()}`;
  }
  const details = isPlainObject(message.metadata.details)
    ? message.metadata.details
    : null;
  const items = details && Array.isArray(details.items) ? details.items : null;
  const signatureSource = items ? JSON.stringify(items) : message.content.trim();
  return `plan:${signatureSource}`;
}

export function deriveRuntimePreferenceFromMessages(
  messages: ChatMessage[],
): ConversationRuntimePreference | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    const metadata = isPlainObject(message.metadata) ? message.metadata : null;
    const preference = extractRuntimePreferenceDetails(null, metadata);
    if (preference) {
      return preference;
    }
  }
  return null;
}

export function parseTimestamp(value: string | null | undefined): number {
  if (!value) {
    return Date.now();
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Date.now();
}
