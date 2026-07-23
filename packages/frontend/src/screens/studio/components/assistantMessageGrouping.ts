export interface AssistantGroupingMessageLike {
  role: string;
}

function normalizeMessageType(messageType: string | null | undefined): string {
  return typeof messageType === "string" ? messageType.trim().toLowerCase() : "";
}

export function isStandaloneAssistantGroupMessageType(
  messageType: string | null | undefined,
): boolean {
  const normalized = normalizeMessageType(messageType);
  return (
    normalized === "agent_job_thread" ||
    normalized === "conversation_thread" ||
    normalized === "runtime_alert" ||
    normalized === "run_cancellation"
  );
}

export function resolvePreviousAssistantHandleAcrossTurns<T extends AssistantGroupingMessageLike>(
  messages: T[],
  index: number,
  resolveHandle: (message: T) => string | null,
): string | null {
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    const previous = messages[cursor];
    if (!previous) {
      continue;
    }
    if (previous.role !== "assistant") {
      continue;
    }
    const handle = resolveHandle(previous);
    if (handle) {
      return handle;
    }
  }
  return null;
}

export function shouldAssistantMessagesShareVisualGroup(
  currentType: string | null | undefined,
  nextType: string | null | undefined,
): boolean {
  return !(
    isStandaloneAssistantGroupMessageType(currentType) ||
    isStandaloneAssistantGroupMessageType(nextType)
  );
}
