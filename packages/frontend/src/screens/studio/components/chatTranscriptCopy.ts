import type { ChatMessage, ChatMessageFileChange } from "../types";

const THREAD_COPY_EXCLUDED_TYPES = new Set([
  "command_execution",
  "mcp_tool_call",
  "todo_list",
  "web_search",
  "token_usage",
  "runtime_switch",
  "reasoning",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeMessageType(message: ChatMessage): string {
  const directType =
    typeof message.messageType === "string"
      ? message.messageType
      : isRecord(message.metadata) && typeof message.metadata.messageType === "string"
        ? message.metadata.messageType
        : "";
  return directType.trim().toLowerCase();
}

function normalizeText(value: string | null | undefined): string {
  return typeof value === "string" ? value.replace(/\r\n/g, "\n").trim() : "";
}

function coerceThreadMessages(rawThreadMessages: unknown): ChatMessage[] {
  if (!Array.isArray(rawThreadMessages)) {
    return [];
  }
  return rawThreadMessages.filter((candidate): candidate is ChatMessage => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      return false;
    }
    const message = candidate as Partial<ChatMessage>;
    return (
      typeof message.id === "string" &&
      (message.role === "assistant" || message.role === "user") &&
      typeof message.content === "string" &&
      typeof message.timestamp === "number"
    );
  });
}

function formatFileChangeLabel(file: ChatMessageFileChange): string {
  return file.label?.trim() || file.path?.trim() || file.workspacePath?.trim() || "file";
}

function formatFileChangeSummary(files: ChatMessageFileChange[] | null | undefined): string {
  if (!Array.isArray(files) || files.length === 0) {
    return "";
  }

  if (files.length === 1) {
    const file = files[0];
    const label = formatFileChangeLabel(file);
    switch (file.changeType) {
      case "created":
        return `Created ${label}.`;
      case "deleted":
        return `Deleted ${label}.`;
      case "changed":
        return `Updated ${label}.`;
      default:
        return `Changed ${label}.`;
    }
  }

  const labels = files.map(formatFileChangeLabel);
  return `Files changed: ${labels.join(", ")}.`;
}

function contentReferencesFileSummary(content: string, files: ChatMessageFileChange[] | null | undefined): boolean {
  if (!Array.isArray(files) || files.length === 0) {
    return false;
  }
  const normalizedContent = content.toLowerCase();
  return files.every((file) => {
    const candidates = [
      file.label?.trim(),
      file.path?.trim(),
      file.workspacePath?.trim(),
    ].filter((candidate): candidate is string => Boolean(candidate));
    return candidates.some((candidate) => normalizedContent.includes(candidate.toLowerCase()));
  });
}

function shouldTreatStatusAsSummary(message: ChatMessage): boolean {
  if (normalizeMessageType(message) !== "status") {
    return true;
  }
  const metadata = isRecord(message.metadata) ? message.metadata : null;
  const outcome =
    typeof metadata?.outcome === "string"
      ? metadata.outcome.trim().toLowerCase()
      : typeof metadata?.status === "string"
        ? metadata.status.trim().toLowerCase()
        : "";
  if (["queued", "pending", "in_progress", "running", "starting"].includes(outcome)) {
    return false;
  }
  const content = normalizeText(message.content).toLowerCase();
  if (!content) {
    return false;
  }
  if (
    content.includes("drafting response") ||
    content.includes("response summary") ||
    content === "completed" ||
    content === "thinking…" ||
    content === "starting…"
  ) {
    return false;
  }
  return true;
}

function resolveThreadSummary(threadMessages: ChatMessage[]): string {
  let latestFileSummary = "";

  for (let index = threadMessages.length - 1; index >= 0; index -= 1) {
    const candidate = threadMessages[index];
    if (!latestFileSummary) {
      latestFileSummary = formatFileChangeSummary(candidate.files);
    }
    const content = normalizeText(candidate.content);
    if (!content) {
      continue;
    }
    const type = normalizeMessageType(candidate);
    if (type && THREAD_COPY_EXCLUDED_TYPES.has(type)) {
      continue;
    }
    if (!shouldTreatStatusAsSummary(candidate)) {
      continue;
    }
    if (latestFileSummary && !contentReferencesFileSummary(content, candidate.files)) {
      return `${content}\n\n${latestFileSummary}`;
    }
    return content;
  }

  return latestFileSummary;
}

export function resolveCopyableMessageContent(message: ChatMessage): string {
  const directContent = normalizeText(message.content);
  if (directContent) {
    return directContent;
  }

  if (normalizeMessageType(message) === "agent_job_thread") {
    const metadata = isRecord(message.metadata) ? message.metadata : null;
    return resolveThreadSummary(coerceThreadMessages(metadata?.threadMessages));
  }

  return formatFileChangeSummary(message.files);
}

export function formatConversationTranscript(messages: ChatMessage[]): string {
  return messages
    .map((message) => {
      const content = resolveCopyableMessageContent(message);
      if (!content) {
        return null;
      }
      const author = message.role === "assistant" ? "Assistant" : "User";
      return content.includes("\n") ? `${author}:\n${content}` : `${author}: ${content}`;
    })
    .filter((entry): entry is string => Boolean(entry))
    .join("\n\n")
    .trim();
}
