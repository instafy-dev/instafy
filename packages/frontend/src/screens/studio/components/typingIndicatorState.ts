import { resolveRetryingStatusPresentation } from "../../../conversations/runFailurePresentation";
import type { ChatMessage } from "../types";
import {
  isCompactionStatusText,
  resolveAssistantStatusHeadline,
} from "./assistantStatusHeuristics";
import { getMessageType } from "./chatMessageMetadata";
import { truncate } from "./chatContentHelpers";

export type TypingIndicatorPhase = "typing" | "finalizing" | "thinking" | "waiting" | "compacting";
export type TypingIndicatorState = { phase: TypingIndicatorPhase; label: string | null };

export const COMPACTION_STATUS_LABEL = "Re-organizing my thoughts";

export function resolveTypingIndicatorState(
  messages: ChatMessage[],
  fallback: TypingIndicatorState | null = null,
): TypingIndicatorState {
  let lastUserIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === "user") {
      lastUserIndex = index;
      break;
    }
  }
  const startIndex = lastUserIndex;

  for (let index = messages.length - 1; index > startIndex; index -= 1) {
    const message = messages[index];
    if (message.role !== "assistant") {
      continue;
    }
    const type = getMessageType(message);
    if (type !== "reasoning" && type !== "status") {
      continue;
    }
    // Only the headline goes in the one-line status row. A reasoning summary
    // body stays behind "Agent thinking" instead of leaking in here.
    const normalized = resolveAssistantStatusHeadline(message.content);
    if (!normalized) {
      continue;
    }
    // A retry reads as calm progress, as in the job-thread preview. The raw
    // cause (a 429 while Codex waits, say) stays on the stored message.
    const retryingPresentation = resolveRetryingStatusPresentation({
      metadata: message.metadata,
      content: normalized,
    });
    if (retryingPresentation) {
      return { phase: "thinking", label: retryingPresentation.displayText };
    }
    if (isCompactionStatusText(normalized)) {
      return { phase: "compacting", label: COMPACTION_STATUS_LABEL };
    }
    const lowered = normalized.toLowerCase();
    if (lowered === "completed") {
      continue;
    }

    const phase = lowered.includes("response summary")
      ? "finalizing"
      : lowered.includes("drafting response")
        ? "typing"
        : "thinking";

    return { phase, label: truncate(normalized, 120) };
  }

  if (fallback) {
    return fallback;
  }
  return { phase: "typing", label: null };
}
