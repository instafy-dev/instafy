import { shouldSuppressAgentEvaluationRunPresence } from "../../../conversations/groupParticipation";
import { resolveRetryingStatusPresentation } from "../../../conversations/runFailurePresentation";
import type { ChatMessage } from "../types";
import type { RunRecord } from "../../../types";
import { extractRunIdFromMetadata } from "./chatAssistantIdentity";
import { extractAgentJobId, runMatchesThreadJobId } from "./chatMessagePresentation";
import {
  isCompactionStatusText,
  resolveAssistantStatusHeadline,
} from "./assistantStatusHeuristics";
import { getMessageType } from "./chatMessageMetadata";
import { truncate } from "./chatContentHelpers";
import {
  coerceThreadMessages,
  isFinalAgentOutcomeMessage,
  resolveThreadRunStatusFromMessages,
} from "./threadPreviewHelpers";

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
    // A reply ends its turn: any reasoning title before it is history, not
    // what the agent is doing now, even while the run record catches up.
    if (isFinalAgentOutcomeMessage(message)) {
      break;
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

function readJobThreadMessages(message: ChatMessage): ChatMessage[] {
  const metadata = message.metadata;
  return coerceThreadMessages(
    metadata && typeof metadata === "object" && !Array.isArray(metadata)
      ? (metadata as Record<string, unknown>)["threadMessages"]
      : null,
  );
}

function isJobThreadRow(message: ChatMessage): boolean {
  return (getMessageType(message) ?? "").trim().toLowerCase() === "agent_job_thread";
}

/**
 * The runs the typing row speaks for: the same set isAssistantTyping counts,
 * which leaves out a silent skill-mode evaluation until it says something.
 * Counted here, such a run kept a reply from covering its own turn.
 */
function resolveTypingRuns(activeRuns: readonly RunRecord[], messages: readonly ChatMessage[]): RunRecord[] {
  return activeRuns.filter(
    (run) => !shouldSuppressAgentEvaluationRunPresence({ runId: run.id, runMetadata: run.metadata, messages }),
  );
}

/**
 * The job and run ids of the reply that ended a turn, when the newest row is
 * one: a job thread that already holds its reply, or a plain reply (a turn
 * with no tool use posts no thread). Null for anything else.
 */
function resolveTurnOutcomeIds(latestDisplayedMessage: ChatMessage): string[] | null {
  if (isJobThreadRow(latestDisplayedMessage)) {
    const threadMessages = readJobThreadMessages(latestDisplayedMessage);
    if (threadMessages.length === 0 || resolveThreadRunStatusFromMessages(threadMessages).phase !== "completed") {
      return null;
    }
  } else if (!isFinalAgentOutcomeMessage(latestDisplayedMessage)) {
    return null;
  }
  const ids = [
    extractAgentJobId(latestDisplayedMessage),
    extractRunIdFromMetadata(latestDisplayedMessage.metadata),
  ].filter((id): id is string => Boolean(id));
  return ids.length > 0 ? ids : null;
}

function outcomeNamesRun(outcomeIds: readonly string[], run: RunRecord): boolean {
  return outcomeIds.some((id) => runMatchesThreadJobId(run, id));
}

/**
 * How the newest transcript row covers the assistant typing row.
 *
 * - `live`: the row is a job thread still running. It shows the run's state
 *   itself (rail and caption), so a typing row under it would say it twice.
 * - `answered`: the row is the turn's reply (inside its job thread, or a plain
 *   reply when the turn used no tools), and every run still marked active is
 *   that turn's own run, whose record has not caught up yet. A typing row here
 *   would say "Thinking…" (or the turn's last reasoning title) under the
 *   finished answer, and then drop out seconds later.
 * - `none`: anything else, including a different run starting after the reply.
 *
 * `activeRuns` may hold silent skill-mode evaluations; they are left out here
 * as isAssistantTyping leaves them out.
 */
export type JobThreadTypingCoverage = "none" | "live" | "answered";

export function resolveJobThreadTypingCoverage(
  latestDisplayedMessage: ChatMessage | null | undefined,
  activeRuns: readonly RunRecord[],
  messages: readonly ChatMessage[],
): JobThreadTypingCoverage {
  if (!latestDisplayedMessage) {
    return "none";
  }
  if (isJobThreadRow(latestDisplayedMessage)) {
    const threadMessages = readJobThreadMessages(latestDisplayedMessage);
    if (threadMessages.length === 0) {
      return "none";
    }
    if (resolveThreadRunStatusFromMessages(threadMessages).phase !== "completed") {
      return "live";
    }
  }
  const outcomeIds = resolveTurnOutcomeIds(latestDisplayedMessage);
  const typingRuns = resolveTypingRuns(activeRuns, messages);
  return outcomeIds && typingRuns.length > 0 && typingRuns.every((run) => outcomeNamesRun(outcomeIds, run))
    ? "answered"
    : "none";
}

/**
 * Whether the newest row is the reply of a run the typing row speaks for. The
 * typing row's hidden spacer holds the place of a reply still on its way; when
 * the row it is anchored to is that reply already, the spacer only shifts the
 * chat twice (in, then out after twelve seconds) under a finished answer.
 */
export function isTranscriptTailActiveTurnOutcome(
  latestDisplayedMessage: ChatMessage | null | undefined,
  activeRuns: readonly RunRecord[],
  messages: readonly ChatMessage[],
): boolean {
  const outcomeIds = latestDisplayedMessage ? resolveTurnOutcomeIds(latestDisplayedMessage) : null;
  return (
    outcomeIds !== null && resolveTypingRuns(activeRuns, messages).some((run) => outcomeNamesRun(outcomeIds, run))
  );
}

/**
 * Identifies the newest transcript content for the typing row, which drops its
 * placeholder as soon as this changes. A job thread keeps one row id while its
 * reply lands inside it, so the key also names the thread's newest message.
 */
export function resolveTranscriptTailKey(latestDisplayedMessage: ChatMessage | null | undefined): string | null {
  if (!latestDisplayedMessage) {
    return null;
  }
  if (!isJobThreadRow(latestDisplayedMessage)) {
    return latestDisplayedMessage.id;
  }
  const newest = readJobThreadMessages(latestDisplayedMessage).at(-1);
  return newest ? `${latestDisplayedMessage.id}:${newest.id}` : latestDisplayedMessage.id;
}
