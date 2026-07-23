import type { ConversationState } from "./ConversationsProvider";
import type { ChatMessage } from "../screens/studio/types";

const DEFAULT_CONVERSATION_TITLE_PATTERN = /^Conversation\s+\d+$/i;
const REUSABLE_BLANK_ASSISTANT_PROMPTS = new Set([
  "How can I help with your space?",
  "How can I help with your project?",
]);

export function isDefaultConversationTitle(title: string | null | undefined): boolean {
  return DEFAULT_CONVERSATION_TITLE_PATTERN.test((title ?? "").trim());
}

function isReusableBlankAssistantMessage(
  conversation: ConversationState,
): boolean {
  if (conversation.messages.length !== 1) {
    return false;
  }
  const [message] = conversation.messages;
  if (!message || message.role !== "assistant") {
    return false;
  }
  if ((message.files?.length ?? 0) > 0) {
    return false;
  }
  if ((message.messageType ?? "").trim().toLowerCase() !== "status") {
    return false;
  }
  return REUSABLE_BLANK_ASSISTANT_PROMPTS.has(message.content.trim());
}

export function isReusableBlankConversation(
  conversation: ConversationState | null | undefined,
): boolean {
  if (!conversation) {
    return false;
  }
  if (conversation.lifecycleStatus !== "active" || conversation.visibility !== "public") {
    return false;
  }
  if (conversation.parentConversationId || conversation.threadKind) {
    return false;
  }
  if (!isDefaultConversationTitle(conversation.title)) {
    return false;
  }
  if (conversation.draft.trim().length > 0 || conversation.draftEditorState !== null) {
    return false;
  }
  if (conversation.pendingRunIds.length > 0 || conversation.awaitingLeaseRunIds.length > 0) {
    return false;
  }
  if (conversation.messages.length === 0) {
    return true;
  }
  return isReusableBlankAssistantMessage(conversation);
}

export function findReusableBlankConversation(
  conversations: ConversationState[],
): ConversationState | null {
  let candidate: ConversationState | null = null;
  for (const conversation of conversations) {
    if (!isReusableBlankConversation(conversation)) {
      continue;
    }
    if (!candidate || conversation.createdAt >= candidate.createdAt) {
      candidate = conversation;
    }
  }
  return candidate;
}

export function shouldAutoTitleConversation(
  conversation: ConversationState | null | undefined,
  firstUserMessage: string,
): boolean {
  if (!conversation) {
    return false;
  }
  if (conversation.parentConversationId || conversation.threadKind) {
    return false;
  }
  if (!isDefaultConversationTitle(conversation.title)) {
    return false;
  }
  if (firstUserMessage.trim().length === 0) {
    return false;
  }
  return !conversation.messages.some((message) => message.role === "user");
}

export function getConversationAutoTitleSeed(
  conversation: ConversationState | null | undefined,
): string | null {
  if (!conversation) {
    return null;
  }
  if (conversation.parentConversationId || conversation.threadKind) {
    return null;
  }
  if (!isDefaultConversationTitle(conversation.title)) {
    return null;
  }
  const userMessages = conversation.messages.filter(
    (message) => {
      if (message.role !== "user" || message.content.trim().length === 0) {
        return false;
      }
      const metadata = readRecord(message.metadata);
      const groupParticipation = readRecord(metadata?.groupParticipation);
      const participationPreflight = readRecord(metadata?.groupParticipationPreflight);
      const preflightStatus = participationPreflight?.status;
      if (groupParticipation?.decision === "silent") {
        return false;
      }
      if (
        (preflightStatus === "controller_deferred" ||
          preflightStatus === "controller_coverage") &&
        !groupParticipation?.decision
      ) {
        return false;
      }
      return true;
    },
  );
  return userMessages.at(-1)?.content.trim() ?? null;
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function getStructuredConversationTitle(messages: ChatMessage[]): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const metadata = readRecord(messages[index]?.metadata);
    const githubImport = readRecord(metadata?.githubImport);
    const repo = readNonEmptyString(githubImport?.repo);
    if (repo) {
      return `Import ${repo}`;
    }
  }
  return null;
}
