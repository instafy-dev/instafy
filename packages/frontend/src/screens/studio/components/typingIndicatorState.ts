import { resolveRetryingStatusPresentation } from "../../../conversations/runFailurePresentation";
import type { ChatMessage } from "../types";
import type { RunRecord } from "../../../types";
import { extractRunIdFromMetadata } from "./chatAssistantIdentity";
import { extractAgentJobId } from "./chatMessagePresentation";
import {
  isCompactionStatusText,
  resolveAssistantStatusHeadline,
} from "./assistantStatusHeuristics";
import { getMessageType } from "./chatMessageMetadata";
import { truncate } from "./chatContentHelpers";

export type TypingIndicatorPhase = "typing" | "finalizing" | "thinking" | "waiting" | "compacting";
export type TypingIndicatorState = { phase: TypingIndicatorPhase; label: string | null };

export const COMPACTION_STATUS_LABEL = "Re-organizing my thoughts";

/** Keep queued and approval-blocked lanes distinct from actual execution. */
export function resolveMultiAgentTypingStatus(
  agents: readonly { displayName: string; status: RunRecord["status"] }[],
): { phase: TypingIndicatorPhase; label: string; ariaLabel: string } {
  const working = agents.filter(agent => agent.status === "in_progress");
  const queued = agents.filter(agent => agent.status === "queued");
  const approval = agents.filter(agent => agent.status === "awaiting_approval");
  const groups = [[working, "working"], [queued, "queued"], [approval, "waiting for approval"]] as const;
  return {
    phase: working.length ? "thinking" : "waiting",
    label: groups.filter(([entries]) => entries.length).map(([entries, label]) => `${entries.length} ${label}`).join(" · "),
    ariaLabel: groups.filter(([entries]) => entries.length).map(([entries, label]) =>
      `${entries.map(agent => agent.displayName).join(", ")} ${entries.length === 1 ? "is" : "are"} ${label}`,
    ).join("; "),
  };
}

export function resolveTypingIndicatorState(
  messages: ChatMessage[],
  fallback: TypingIndicatorState | null = null,
  activeRun?: RunRecord | null,
): TypingIndicatorState {
  // A queued lane has not started producing progress. In particular, a
  // completed sibling's last status must not replace its waiting state.
  if (activeRun?.status === "queued" || activeRun?.status === "awaiting_approval") {
    return fallback ?? { phase: "waiting", label: null };
  }
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
    if (activeRun) {
      const runId = extractRunIdFromMetadata(message.metadata);
      const jobId = extractAgentJobId(message);
      const activeJobId = activeRun.metadata?.jobId ?? activeRun.metadata?.job_id;
      // Exact execution identity, never an agent handle (handles are reused).
      if (runId && runId !== activeRun.id) continue;
      if (jobId && activeJobId && jobId !== activeJobId) continue;
      if (!runId && (!jobId || jobId !== activeJobId)) continue;
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
