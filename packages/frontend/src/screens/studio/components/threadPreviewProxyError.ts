import { resolveRetryingStatusPresentation } from "../../../conversations/runFailurePresentation";
import type { ChatMessage } from "../types";
import { getMessageType } from "./chatMessageMetadata";
import { resolveProxyUpstreamErrorGuidance } from "./proxyError";

const SUCCESSFUL_RUN_STATUSES = new Set(["success", "succeeded", "completed", "merged"]);
const FAILED_RUN_STATUSES = new Set(["failed", "error"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizedField(record: Record<string, unknown> | null, key: string): string {
  const value = record?.[key];
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

export function isSuccessfulRunStatus(status: string | null | undefined): boolean {
  return SUCCESSFUL_RUN_STATUSES.has(status?.trim().toLowerCase() ?? "");
}

/**
 * True for a run step that reports progress rather than an outcome: an
 * activity line (status/reasoning), an update the agent marked in progress, or
 * a Codex retry notice. Such a step can quote a provider error ("Retrying:
 * unexpected status 502 …") while the run recovers, so it never ends the run.
 */
export function isTransientThreadUpdate(message: ChatMessage): boolean {
  const metadata = isRecord(message.metadata) ? message.metadata : null;
  const outcome = normalizedField(metadata, "outcome");
  if (outcome === "in_progress") {
    return true;
  }
  if (resolveRetryingStatusPresentation({ metadata, content: message.content }) !== null) {
    return true;
  }
  const type = (getMessageType(message) ?? "").trim().toLowerCase();
  if (type === "status" || type === "reasoning") {
    // A status line that carries a failed outcome is the run's own verdict.
    return !FAILED_RUN_STATUSES.has(outcome) && !FAILED_RUN_STATUSES.has(normalizedField(metadata, "status"));
  }
  return false;
}

/** A proxy error the run ended on, as opposed to one it reported while retrying. */
export function isTerminalProxyErrorMessage(message: ChatMessage): boolean {
  return (
    message.role === "assistant" &&
    !isTransientThreadUpdate(message) &&
    resolveProxyUpstreamErrorGuidance(message.content) !== null
  );
}

function isSuccessfulTerminalMessage(message: ChatMessage): boolean {
  if (message.role !== "assistant" || isTransientThreadUpdate(message)) {
    return false;
  }
  const metadata = isRecord(message.metadata) ? message.metadata : null;
  return (
    isSuccessfulRunStatus(normalizedField(metadata, "outcome")) ||
    isSuccessfulRunStatus(normalizedField(metadata, "status"))
  );
}

/**
 * The proxy error a thread ended on, if any. A successful run outcome, or a
 * successful terminal message after the error, means the run recovered and the
 * earlier error is history, not the result.
 */
export function resolveTerminalProxyErrorMessage(
  threadMessages: readonly ChatMessage[],
  runStatus: { phase: string; status: string | null },
): ChatMessage | null {
  if (runStatus.phase === "completed" && isSuccessfulRunStatus(runStatus.status)) {
    return null;
  }
  for (let index = threadMessages.length - 1; index >= 0; index -= 1) {
    const candidate = threadMessages[index];
    if (isSuccessfulTerminalMessage(candidate)) {
      return null;
    }
    if (isTerminalProxyErrorMessage(candidate)) {
      return candidate;
    }
  }
  return null;
}
