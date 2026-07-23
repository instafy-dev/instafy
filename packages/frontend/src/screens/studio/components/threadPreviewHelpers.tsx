import {
  ChatLines,
  ClipboardCheck,
  CompressLines,
  GitBranch,
  Reports,
  Terminal,
  Threads,
} from "iconoir-react";
import {
  isCompactionStatusText,
  looksLikeInternalLearnedBlocksStatus,
  normalizeAssistantStatusText,
} from "./assistantStatusHeuristics";
import {
  extractControllerConversationNoticeStatus,
} from "./controllerConversationNotice";
import { extractMessageDetails, getMessageType } from "./chatMessageMetadata";
import type { ThreadCompactUpdateKind } from "./threadPreviewState";
import type { ChatMessage } from "../types";
import { isNonRecoverableRunErrorMessage } from "../../../conversations/conversationGoals";

export const THREAD_ACTIVE_STATES = new Set([
  "in_progress",
  "queued",
  "started",
  "running",
  "applying",
  "refreshing",
]);
const THREAD_TERMINAL_STATES = new Set([
  "completed",
  "success",
  "succeeded",
  "failed",
  "canceled",
  "cancelled",
]);

export const THREAD_RECENT_ACTIVITY_WINDOW_MS = 45_000;
export const THREAD_HYBRID_COMPACTION_MIN_WIDTH_PX = 760;
export const THREAD_COMPACT_EVENT_ICON_CAP = 20;
export const THREAD_SPINE_DEFAULT_NOTCH_OFFSET_PX = 9;
export const THREAD_SPINE_COMPACT_NOTCH_OFFSET_PX = 16;
export const THREAD_SPINE_END_SEGMENT_TOP_PX = -1;
export const THREAD_SPINE_END_SEGMENT_HEIGHT_PX = 6;

const GENERIC_PROGRESS_LABELS = new Set([
  "working",
  "running",
  "thinking",
  "processing",
  "in progress",
  "loading",
  "starting",
  "please wait",
  "syncing workspace changes",
  "applying changes to workspace",
]);

export type ThreadCompactEvent = {
  id: string;
  kind: ThreadCompactUpdateKind;
  actorHandle?: string | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeProgressLabelForComparison(value: string): string {
  return normalizeAssistantStatusText(value)
    .toLowerCase()
    .replace(/\.\.\.$/, "")
    .replace(/…$/, "")
    .replace(/[.!]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function hasNonRecoverableThreadErrorSignal(message: ChatMessage): boolean {
  if (message.role !== "assistant") {
    return false;
  }
  const metadata = message.metadata && isRecord(message.metadata) ? message.metadata : null;
  const details = metadata && isRecord(metadata.details) ? metadata.details : null;
  const event = details && isRecord(details.event) ? details.event : null;
  const candidates = [
    message.content,
    metadata?.errorMessage,
    metadata?.error_message,
    details?.message,
    event?.message,
  ];
  return candidates.some((candidate) => {
    if (typeof candidate !== "string") {
      return false;
    }
    const normalized = candidate.toLowerCase();
    return (
      normalized.includes("insufficient_quota") ||
      normalized.includes("rate_limit_error") ||
      normalized.includes("rate limit reached")
    );
  });
}

export function isGenericProgressLabel(value: string): boolean {
  const normalized = normalizeAssistantStatusText(value)
    .toLowerCase()
    .replace(/\.\.\.$/, "")
    .replace(/…$/, "")
    .replace(/[.!]+$/g, "")
    .trim();
  return GENERIC_PROGRESS_LABELS.has(normalized) || looksLikeInternalLearnedBlocksStatus(normalized);
}

export function looksLikeTerminalProgressLabel(value: string): boolean {
  const normalized = normalizeProgressLabelForComparison(value);
  if (!normalized) {
    return false;
  }
  return (
    normalized === "completed" ||
    normalized.includes("complete") ||
    normalized.includes("completed") ||
    normalized.includes("done") ||
    normalized.includes("finished") ||
    normalized.includes("succeeded") ||
    normalized.includes("failed") ||
    normalized.includes("cancelled") ||
    normalized.includes("canceled")
  );
}

function looksLikeHighPriorityThreadUpdateText(value: string): boolean {
  const normalized = normalizeAssistantStatusText(value).toLowerCase();
  if (!normalized) {
    return false;
  }
  return (
    normalized.includes("error") ||
    normalized.includes("failed") ||
    normalized.includes("failure") ||
    normalized.includes("cancelled") ||
    normalized.includes("canceled") ||
    normalized.includes("aborted") ||
    normalized.includes("timeout") ||
    normalized.includes("approval") ||
    normalized.includes("integration required") ||
    normalized.includes("secret required") ||
    normalized.includes("credential required")
  );
}

export function shouldKeepThreadUpdateInline(update: ChatMessage): boolean {
  const type = (getMessageType(update) ?? "").trim().toLowerCase();
  if (type === "integration_request" || type === "secret_request" || type === "action_request") {
    return true;
  }
  if ((type === "status" || type === "reasoning") && looksLikeHighPriorityThreadUpdateText(update.content)) {
    return true;
  }
  return false;
}

export function resolveThreadCompactUpdateKind(update: ChatMessage): ThreadCompactUpdateKind | null {
  const type = (getMessageType(update) ?? "").trim().toLowerCase();
  if (type === "reasoning" || type === "status") {
    const normalized = normalizeAssistantStatusText(update.content);
    if (!normalized) {
      return null;
    }
    if (normalized.toLowerCase() === "completed") {
      return null;
    }
    if (isGenericProgressLabel(normalized) || looksLikeTerminalProgressLabel(normalized)) {
      return null;
    }
    if (isCompactionStatusText(update.content)) {
      return "compaction";
    }
    return "thinking";
  }
  if (type === "todo_list") {
    return "plan";
  }
  if (type === "mcp_tool_call") {
    return "tool";
  }
  if (type === "command_execution") {
    return "command";
  }
  if (type === "web_search") {
    return "search";
  }
  if (type === "runtime_switch") {
    return "runtime";
  }
  return null;
}

export function renderThreadCompactEventIcon(
  kind: ThreadCompactUpdateKind,
  className = "h-3.5 w-3.5",
) {
  switch (kind) {
    case "compaction":
      return <CompressLines aria-hidden="true" className={className} />;
    case "thinking":
      return <ChatLines aria-hidden="true" className={className} />;
    case "plan":
      return <ClipboardCheck aria-hidden="true" className={className} />;
    case "tool":
      return <Threads aria-hidden="true" className={className} />;
    case "command":
      return <Terminal aria-hidden="true" className={className} />;
    case "search":
      return <Reports aria-hidden="true" className={className} />;
    case "runtime":
      return <GitBranch aria-hidden="true" className={className} />;
    default:
      return <ChatLines aria-hidden="true" className={className} />;
  }
}

export function coerceThreadMessages(rawThreadMessages: unknown): ChatMessage[] {
  if (!Array.isArray(rawThreadMessages)) {
    return [];
  }
  return rawThreadMessages.filter(
    (candidate): candidate is ChatMessage => {
      if (candidate === null || typeof candidate !== "object") {
        return false;
      }
      const record = candidate as Record<string, unknown>;
      return (
        typeof record.id === "string" &&
        typeof record.role === "string" &&
        typeof record.content === "string"
      );
    },
  );
}

export function extractThreadRunStatus(message: ChatMessage): string | null {
  const controllerNoticeStatus = extractControllerConversationNoticeStatus(message);
  if (controllerNoticeStatus) {
    return controllerNoticeStatus;
  }
  if (hasNonRecoverableThreadErrorSignal(message)) {
    return "failed";
  }
  const metadata = message.metadata && isRecord(message.metadata) ? message.metadata : null;
  const details = extractMessageDetails(metadata);
  const candidates: unknown[] = [];
  const source =
    metadata && typeof metadata["source"] === "string"
      ? metadata["source"].trim().toLowerCase()
      : "";
  const kind =
    metadata && typeof metadata["kind"] === "string"
      ? metadata["kind"].trim().toLowerCase()
      : "";
  const outcome =
    metadata && typeof metadata["outcome"] === "string"
      ? metadata["outcome"].trim().toLowerCase()
      : "";
  const isAgentUpdate = source === "agent" && kind === "update" && outcome === "in_progress";

  if (isAgentUpdate && details) {
    candidates.push(details["status"]);
    candidates.push(details["outcome"]);
  }
  if (metadata) {
    candidates.push(metadata["status"]);
    candidates.push(metadata["outcome"]);
  }
  if (details && !isAgentUpdate) {
    candidates.push(details["status"]);
    candidates.push(details["outcome"]);
  }
  for (const candidate of candidates) {
    if (typeof candidate !== "string") {
      continue;
    }
    const trimmed = candidate.trim();
    if (trimmed) {
      return trimmed.toLowerCase();
    }
  }
  return null;
}

export function resolveThreadRunStatusFromMessages(threadMessages: ChatMessage[]): {
  phase: "running" | "completed" | "unknown";
  status: string | null;
} {
  let latestActive: { status: string; timestamp: number } | null = null;
  let latestTerminal: { status: string; timestamp: number } | null = null;

  for (let index = 0; index < threadMessages.length; index += 1) {
    const candidate = threadMessages[index];
    const messageType = (getMessageType(candidate) ?? "").trim().toLowerCase();
    const status = extractThreadRunStatus(candidate) ?? "";
    if (!status) {
      continue;
    }
    const candidateMetadata = candidate.metadata && isRecord(candidate.metadata) ? candidate.metadata : null;
    const candidateSource =
      candidateMetadata && typeof candidateMetadata["source"] === "string"
        ? candidateMetadata["source"].trim().toLowerCase()
        : "";
    const candidateOutcome =
      candidateMetadata && typeof candidateMetadata["outcome"] === "string"
        ? candidateMetadata["outcome"].trim().toLowerCase()
        : "";
    const candidateKind =
      candidateMetadata && typeof candidateMetadata["kind"] === "string"
        ? candidateMetadata["kind"].trim().toLowerCase()
        : "";
    const looksLikeFinalAgentOutcomeMessage =
      candidateSource === "agent" &&
      candidateOutcome !== "" &&
      candidateOutcome !== "in_progress" &&
      candidateKind !== "update";
    const isControllerTerminalNotice =
      messageType === "runtime_alert" || messageType === "run_cancellation";
    const isNonRecoverableError =
      isNonRecoverableRunErrorMessage(candidate) || hasNonRecoverableThreadErrorSignal(candidate);

    const timestamp =
      typeof candidate.timestamp === "number" && Number.isFinite(candidate.timestamp)
        ? candidate.timestamp
        : Number.NEGATIVE_INFINITY;

    if (
      THREAD_TERMINAL_STATES.has(status) &&
      (messageType === "status" ||
        looksLikeFinalAgentOutcomeMessage ||
        isControllerTerminalNotice ||
        isNonRecoverableError)
    ) {
      if (!latestTerminal || timestamp >= latestTerminal.timestamp) {
        latestTerminal = { status, timestamp };
      }
      continue;
    }

    if (THREAD_ACTIVE_STATES.has(status)) {
      if (!latestActive || timestamp >= latestActive.timestamp) {
        latestActive = { status, timestamp };
      }
    }
  }

  if (latestTerminal && (!latestActive || latestTerminal.timestamp >= latestActive.timestamp)) {
    return { phase: "completed", status: latestTerminal.status };
  }
  if (latestActive) {
    return { phase: "running", status: latestActive.status };
  }
  if (latestTerminal) {
    return { phase: "completed", status: latestTerminal.status };
  }

  return { phase: "unknown", status: null };
}
