import {
  hasFailedRunMetadata,
  resolveRunFailurePresentation,
  runFailureSentenceForViewer,
  runtimeEntryOfTurn,
  type TurnEngineTurnOwner,
} from "../../../conversations/runFailurePresentation";
import type { ControllerRuntimeStatusEntry } from "../../../services/runtimeController/runtimes";
import type { ChatMessage, ChatMessageFileChange } from "../types";
import { readRowStopNotice, rowWentOnFromStop } from "./chatMessagePresentation";

/**
 * Who copies the chat, as its rows word a failed turn for them: a failed
 * turn of someone's own AI (a turn engine) reads one way for its person and
 * another for everyone else (RunFailureNotice).
 */
export type ChatCopyReader = {
  /** Whose turn-engine turn a message belongs to, as the chat tells it (RunFailureRetryContextValue). */
  turnEngineOwnerOf?: (message: ChatMessage) => TurnEngineTurnOwner | null;
  /** The runtimes the reader's chat knows: its person's sentence names what the one that ran the turn says. */
  runtimeStatuses?: readonly ControllerRuntimeStatusEntry[] | null;
};

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

/**
 * A message's words as the chat shows them to `reader`. A failed turn shows
 * a plain sentence ("Instafy AI is unavailable right now: …"), with the
 * service's own words one press away in Details: a copy carries that
 * sentence too, never the raw text it stands for.
 */
function chatWords(message: ChatMessage, reader: ChatCopyReader | undefined): string {
  if (message.role === "assistant" && (normalizeMessageType(message) === "error" || hasFailedRunMetadata(message.metadata))) {
    const failure = resolveRunFailurePresentation({ metadata: message.metadata, content: message.content, assumeFailed: true });
    const sentence = failure
      ? normalizeText(runFailureSentenceForViewer(failure, {
        owner: failure.turnEngine ? reader?.turnEngineOwnerOf?.(message) ?? null : null,
        runtime: runtimeEntryOfTurn(message, reader?.runtimeStatuses),
      }))
      : "";
    if (sentence) {
      return sentence;
    }
  }
  return normalizeText(message.content);
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

/**
 * A turn's row as Copy conversation has it: its reply's words and nothing
 * after them, never the names of the files it changed. Only a turn with no
 * words copies what it changed.
 */
function resolveThreadSummary(threadMessages: ChatMessage[], reader: ChatCopyReader | undefined): string {
  let latestFileSummary = "";

  for (let index = threadMessages.length - 1; index >= 0; index -= 1) {
    const candidate = threadMessages[index];
    if (!latestFileSummary) {
      latestFileSummary = formatFileChangeSummary(candidate.files);
    }
    const content = chatWords(candidate, reader);
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
    return content;
  }

  return latestFileSummary;
}

export function resolveCopyableMessageContent(message: ChatMessage, reader?: ChatCopyReader): string {
  const directContent = chatWords(message, reader);
  if (directContent) {
    return directContent;
  }

  if (normalizeMessageType(message) === "agent_job_thread") {
    const metadata = isRecord(message.metadata) ? message.metadata : null;
    return resolveThreadSummary(coerceThreadMessages(metadata?.threadMessages), reader);
  }

  return formatFileChangeSummary(message.files);
}

export function formatConversationTranscript(messages: ChatMessage[], reader?: ChatCopyReader): string {
  const listed = new Set(messages.map((message) => message.id));
  return messages
    // A stopped turn's row holds the notice of its Stop (foldStopNotices): the
    // copy still says the turn was stopped, after it, as the chat stored it,
    // once (a chat opened at that notice lists it too). A row that went on
    // from its Stop (Continue) ends on what came after, as on screen.
    .flatMap((message) => {
      const stopNotice = readRowStopNotice(message);
      return stopNotice && !listed.has(stopNotice.id) && !rowWentOnFromStop(message) ? [message, stopNotice] : [message];
    })
    .map((message) => {
      const content = resolveCopyableMessageContent(message, reader);
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
