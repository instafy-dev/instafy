import type { ConversationState } from "../../../conversations/ConversationsProvider";
import type { ChatMessage } from "../types";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resolvePromptMetadata(
  metadata: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null {
  if (!isRecord(metadata)) {
    return null;
  }
  const promptMetadata =
    isRecord(metadata.prompt_metadata)
      ? metadata.prompt_metadata
      : isRecord(metadata.promptMetadata)
        ? metadata.promptMetadata
        : null;
  return promptMetadata;
}

function trimContent(value: string | null | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}

function findFirstNonEmptyUserMessage(messages: ChatMessage[]): ChatMessage | null {
  for (const message of messages) {
    if (message.role !== "user") {
      continue;
    }
    if (!trimContent(message.content)) {
      continue;
    }
    return message;
  }
  return null;
}

function findNearestParentSeedUserMessage(parentMessages: ChatMessage[], createdAt: number): ChatMessage | null {
  let fallback: ChatMessage | null = null;
  for (let index = parentMessages.length - 1; index >= 0; index -= 1) {
    const message = parentMessages[index];
    if (message.role !== "user") {
      continue;
    }
    if (!trimContent(message.content)) {
      continue;
    }
    if (fallback === null) {
      fallback = message;
    }
    if (typeof message.timestamp === "number" && message.timestamp <= createdAt) {
      return message;
    }
  }
  return fallback;
}

function extractAgentJobId(message: ChatMessage): string | null {
  const metadata = message.metadata;
  if (!isRecord(metadata)) {
    return null;
  }
  const candidates = [metadata["jobId"], metadata["job_id"], metadata["jobID"], metadata["runId"], metadata["run_id"]];
  for (const candidate of candidates) {
    if (typeof candidate !== "string") {
      continue;
    }
    const trimmed = candidate.trim();
    if (trimmed) {
      return trimmed;
    }
  }
  return null;
}

function findLatestAssistantMetadata(messages: ChatMessage[]): Record<string, unknown> | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== "assistant") {
      continue;
    }
    if (!isRecord(message.metadata)) {
      continue;
    }
    return message.metadata;
  }
  return null;
}

function findLatestThreadMetadataValue(
  messages: ChatMessage[],
  key: string,
): unknown {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const metadata = isRecord(messages[index]?.metadata)
      ? (messages[index]?.metadata as Record<string, unknown>)
      : null;
    if (!metadata) {
      continue;
    }
    if (key in metadata) {
      return metadata[key];
    }
    const promptMetadata = resolvePromptMetadata(metadata);
    if (promptMetadata && key in promptMetadata) {
      return promptMetadata[key];
    }
  }
  return null;
}

function createPlaceholderThreadMessage(thread: ConversationState): ChatMessage {
  const isRunning = (thread.pendingRunIds?.length ?? 0) > 0 || (thread.awaitingLeaseRunIds?.length ?? 0) > 0;
  return {
    id: `conversation-thread-placeholder:${thread.localId}`,
    role: "assistant",
    authorId: null,
    content: isRunning ? "Starting run…" : "Waiting for updates…",
    timestamp: Math.max(thread.createdAt, 0),
    files: null,
    messageType: "status",
    metadata: {
      messageType: "status",
      status: isRunning ? "queued" : "started",
      outcome: "in_progress",
      source: "agent",
      kind: "update",
    },
  };
}

function shouldRenderAsRunThread(thread: ConversationState, seedCommandText: string, collapsedThreadMessages: ChatMessage[]): boolean {
  if (seedCommandText.startsWith("/")) {
    return true;
  }
  if ((thread.pendingRunIds?.length ?? 0) > 0 || (thread.awaitingLeaseRunIds?.length ?? 0) > 0) {
    return true;
  }
  return collapsedThreadMessages.some((message) => message.role === "assistant" || extractAgentJobId(message) !== null);
}

export function buildParentConversationThreadMessage({
  thread,
  parentMessages,
  collapsedThreadMessages,
}: {
  thread: ConversationState;
  parentMessages: ChatMessage[];
  collapsedThreadMessages: ChatMessage[];
}): ChatMessage {
  const firstSeedUserMessage = findFirstNonEmptyUserMessage(thread.messages);
  const inheritedSeedUserMessage = findNearestParentSeedUserMessage(parentMessages, thread.createdAt);
  const seedCommandText = trimContent(firstSeedUserMessage?.content) || trimContent(inheritedSeedUserMessage?.content);
  const renderAsRunThread = shouldRenderAsRunThread(thread, seedCommandText, collapsedThreadMessages);

  if (!renderAsRunThread) {
    const advisoryScopeClaims = findLatestThreadMetadataValue(
      collapsedThreadMessages,
      "advisoryScopeClaims",
    );
    return {
      id: `conversation-thread-preview:${thread.localId}`,
      role: "assistant",
      content: "",
      timestamp: Math.max(thread.createdAt, 0),
      messageType: "conversation_thread",
      metadata: {
        messageType: "conversation_thread",
        threadLocalId: thread.localId,
        linkedThreadId: thread.localId,
        ...(advisoryScopeClaims !== null
          ? { advisoryScopeClaims }
          : {}),
      },
    };
  }

  const filteredThreadMessages = collapsedThreadMessages.filter((message) => {
    if (!seedCommandText.startsWith("/")) {
      return true;
    }
    return message.id !== firstSeedUserMessage?.id;
  });
  const threadMessages = filteredThreadMessages.length > 0 ? filteredThreadMessages : [createPlaceholderThreadMessage(thread)];
  const resolvedJobId =
    thread.pendingRunIds?.[0]
    ?? thread.awaitingLeaseRunIds?.[0]
    ?? threadMessages.map((message) => extractAgentJobId(message)).find((candidate): candidate is string => Boolean(candidate))
    ?? `thread:${thread.localId}`;
  const latestAssistantMetadata = findLatestAssistantMetadata(threadMessages);
  const advisoryScopeClaims = findLatestThreadMetadataValue(
    threadMessages,
    "advisoryScopeClaims",
  );
  const fallbackAgent =
    thread.ownerAgent?.handle
      ? {
          handle: thread.ownerAgent.handle,
          ...(thread.ownerAgent.id ? { id: thread.ownerAgent.id } : {}),
        }
      : null;

  return {
    id: `conversation-thread-run-thread:${thread.localId}`,
    role: "assistant",
    content: "",
    timestamp: Math.max(thread.createdAt, 0),
    messageType: "agent_job_thread",
    metadata: {
      ...(latestAssistantMetadata ?? {}),
      ...(!(latestAssistantMetadata && isRecord(latestAssistantMetadata.agent)) && fallbackAgent
        ? { agent: fallbackAgent }
        : {}),
      messageType: "agent_job_thread",
      jobId: resolvedJobId,
      threadMessages,
      threadLocalId: thread.localId,
      linkedThreadId: thread.localId,
      ...(advisoryScopeClaims !== null
        ? { advisoryScopeClaims }
        : {}),
    },
  };
}
