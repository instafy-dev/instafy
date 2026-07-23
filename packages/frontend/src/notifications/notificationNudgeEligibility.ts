import type { ChatMessage } from "../screens/studio/types";

const LIVE_RESPONSE_CLOCK_SKEW_MS = 1_000;

export type NotificationNudgeConversationObservation = {
  activatedAt: number;
  historyInitialized: boolean;
  observedAssistantResponseKeys: Set<string>;
};

function normalizeMessageType(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  return normalized || null;
}

function resolveMessageType(message: ChatMessage): string | null {
  const direct = normalizeMessageType(message.messageType);
  if (direct) {
    return direct;
  }
  const metadata =
    message.metadata && typeof message.metadata === "object"
      ? (message.metadata as Record<string, unknown>)
      : null;
  return (
    normalizeMessageType(metadata?.messageType) ??
    normalizeMessageType(metadata?.message_type)
  );
}

function assistantResponseKey(message: ChatMessage): string {
  const id = message.id.trim();
  if (id) {
    return `id:${id}`;
  }
  return `fallback:${Math.floor(message.timestamp)}:${message.content.trim()}`;
}

/** A final, user-visible AI answer rather than status, tooling, errors, or synthetic rows. */
export function isGenuineAssistantResponseForNotifications(message: ChatMessage): boolean {
  if (message.role !== "assistant" || message.content.trim().length === 0) {
    return false;
  }
  const messageType = resolveMessageType(message);
  return messageType === null || messageType === "assistant";
}

export function createNotificationNudgeConversationObservation(
  activatedAt = Date.now(),
): NotificationNudgeConversationObservation {
  return {
    activatedAt,
    historyInitialized: false,
    observedAssistantResponseKeys: new Set(),
  };
}

/**
 * Observes transcript changes and returns a response only when it arrived live
 * after the initial history snapshot. Older pages and repeated observations are
 * consumed without becoming nudge opportunities.
 */
export function observeNotificationNudgeAssistantResponses({
  observation,
  messages,
  historyReady,
  assistantRoutingEnabled,
}: {
  observation: NotificationNudgeConversationObservation;
  messages: ChatMessage[];
  historyReady: boolean;
  assistantRoutingEnabled: boolean;
}): {
  observation: NotificationNudgeConversationObservation;
  freshAssistantResponse: ChatMessage | null;
} {
  if (!historyReady) {
    return { observation, freshAssistantResponse: null };
  }

  const observedAssistantResponseKeys = new Set(observation.observedAssistantResponseKeys);
  const candidates: ChatMessage[] = [];

  for (const message of messages) {
    if (!isGenuineAssistantResponseForNotifications(message)) {
      continue;
    }
    const key = assistantResponseKey(message);
    if (observedAssistantResponseKeys.has(key)) {
      continue;
    }
    observedAssistantResponseKeys.add(key);
    if (observation.historyInitialized) {
      candidates.push(message);
    }
  }

  const nextObservation: NotificationNudgeConversationObservation = {
    ...observation,
    historyInitialized: true,
    observedAssistantResponseKeys,
  };

  if (!observation.historyInitialized || !assistantRoutingEnabled) {
    return { observation: nextObservation, freshAssistantResponse: null };
  }

  const liveCandidates = candidates.filter((message) => {
    return (
      Number.isFinite(message.timestamp) &&
      message.timestamp >= observation.activatedAt - LIVE_RESPONSE_CLOCK_SKEW_MS
    );
  });

  return {
    observation: nextObservation,
    freshAssistantResponse: liveCandidates.at(-1) ?? null,
  };
}
