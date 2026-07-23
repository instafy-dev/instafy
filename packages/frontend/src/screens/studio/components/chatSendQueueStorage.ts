import type { SubmitConversationRuntimeOverride } from "../../../conversations/useConversation";
import type { BrowserSessionPageTarget } from "./browserSessionPages";

const CHAT_SEND_QUEUE_STORAGE_PREFIX = "instafy.chat.sendQueue.v1";

export type QueuedChatSendItem = {
  id: string;
  message: string;
  editorState: string | null;
  createdAt: number;
  targetAgentHandles: string[];
  browserPageTarget: BrowserSessionPageTarget | null;
  browserLaunchMode: "new_page" | null;
  metadata?: Record<string, unknown> | null;
  runtimeOverride?: SubmitConversationRuntimeOverride | null;
};

export type EditingQueuedChatItem = {
  item: QueuedChatSendItem;
  targetAgentHandles: string[];
};

export function createChatSendQueueKey(projectId: string, conversationId: string): string {
  return `${CHAT_SEND_QUEUE_STORAGE_PREFIX}:${projectId}:${conversationId}`;
}

export function readChatSendQueue(key: string): QueuedChatSendItem[] {
  if (typeof window === "undefined") {
    return [];
  }
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed
      .map((entry: unknown): QueuedChatSendItem | null => {
        if (!entry || typeof entry !== "object") {
          return null;
        }
        const record = entry as Record<string, unknown>;
        const id = typeof record.id === "string" ? record.id.trim() : "";
        const message = typeof record.message === "string" ? record.message : "";
        const editorState = typeof record.editorState === "string" ? record.editorState : null;
        const createdAt = typeof record.createdAt === "number" ? record.createdAt : Date.now();
        const targetAgentHandles = Array.isArray(record.targetAgentHandles)
          ? record.targetAgentHandles
              .filter((value): value is string => typeof value === "string")
              .map((value) => value.trim().toLowerCase())
              .filter((value) => value.length > 0)
          : [];
        const browserPageTargetRecord =
          record.browserPageTarget && typeof record.browserPageTarget === "object"
            ? (record.browserPageTarget as Record<string, unknown>)
            : null;
        const browserPageTargetId =
          typeof browserPageTargetRecord?.id === "string" ? browserPageTargetRecord.id.trim() : "";
        const browserPageTargetUrl =
          typeof browserPageTargetRecord?.url === "string" ? browserPageTargetRecord.url.trim() : "";
        const browserPageTargetHost =
          typeof browserPageTargetRecord?.host === "string" ? browserPageTargetRecord.host.trim() : "";
        const browserPageTargetLabel =
          typeof browserPageTargetRecord?.label === "string" ? browserPageTargetRecord.label.trim() : "";
        const browserPageTarget =
          browserPageTargetId && browserPageTargetUrl && browserPageTargetHost && browserPageTargetLabel
            ? {
                id: browserPageTargetId,
                url: browserPageTargetUrl,
                host: browserPageTargetHost,
                label: browserPageTargetLabel,
              }
            : null;
        const browserLaunchMode = record.browserLaunchMode === "new_page" ? "new_page" : null;
        const metadata =
          record.metadata && typeof record.metadata === "object" && !Array.isArray(record.metadata)
            ? (record.metadata as Record<string, unknown>)
            : null;
        const runtimeOverrideRecord =
          record.runtimeOverride &&
          typeof record.runtimeOverride === "object" &&
          !Array.isArray(record.runtimeOverride)
            ? (record.runtimeOverride as Record<string, unknown>)
            : null;
        const runtimeId =
          typeof runtimeOverrideRecord?.runtimeId === "string"
            ? runtimeOverrideRecord.runtimeId.trim()
            : "";
        const runtimeDisplayName =
          typeof runtimeOverrideRecord?.runtimeDisplayName === "string"
            ? runtimeOverrideRecord.runtimeDisplayName.trim() || null
            : null;
        const preferRuntime =
          typeof runtimeOverrideRecord?.preferRuntime === "boolean"
            ? runtimeOverrideRecord.preferRuntime
            : null;
        const runtimeOverride: SubmitConversationRuntimeOverride | null = runtimeId
          ? { runtimeId, runtimeDisplayName, preferRuntime }
          : null;
        if (!id || !message.trim()) {
          return null;
        }
        return {
          id,
          message,
          editorState,
          createdAt,
          targetAgentHandles,
          browserPageTarget,
          browserLaunchMode,
          metadata,
          ...(runtimeOverride ? { runtimeOverride } : {}),
        };
      })
      .filter((entry): entry is QueuedChatSendItem => Boolean(entry));
  } catch {
    return [];
  }
}

export function writeChatSendQueue(key: string, items: QueuedChatSendItem[]) {
  if (typeof window === "undefined") {
    return;
  }
  try {
    if (items.length === 0) {
      window.localStorage.removeItem(key);
      return;
    }
    window.localStorage.setItem(key, JSON.stringify(items));
  } catch {
    // ignore storage failures
  }
}
