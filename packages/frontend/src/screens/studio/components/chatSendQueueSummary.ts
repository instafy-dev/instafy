import type { QueuedChatPrompt } from "./ChatSendQueue";

export type CollapsedQueuedMessageSummary = {
  message: string;
};

export function buildCollapsedQueuedMessageSummary(
  item: QueuedChatPrompt | null,
  totalQueuedCount: number,
): CollapsedQueuedMessageSummary | null {
  if (!item || totalQueuedCount !== 1) {
    return null;
  }

  const normalizedMessage = item.message.replace(/\s+/g, " ").trim();

  return {
    message: normalizedMessage ? truncateQueuedMessagePreview(normalizedMessage, 120) : "Waiting to send",
  };
}

function truncateQueuedMessagePreview(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength).trimEnd()}…`;
}
