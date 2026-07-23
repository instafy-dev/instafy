import { generateUUID } from "../../../utils/uuid";
import type { ChatMessage } from "../types";

export function createLocalChatMessage(
  role: ChatMessage["role"],
  content: string,
  options?: {
    authorId?: string | null;
    timestamp?: number;
    messageType?: string | null;
    metadata?: Record<string, unknown> | null;
  },
): ChatMessage {
  return {
    id: generateUUID(),
    role,
    authorId: options?.authorId ?? null,
    content,
    timestamp: options?.timestamp ?? Date.now(),
    files: null,
    messageType: options?.messageType ?? null,
    metadata: options?.metadata ?? null,
  };
}
