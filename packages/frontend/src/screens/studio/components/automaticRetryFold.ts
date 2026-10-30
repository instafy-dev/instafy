// A turn sent again reads as one turn, whether Instafy resent it by itself
// (useRunFailureAutoRetry) or the person pressed "Try again": the resent
// prompt repeats the person's own words, so the chat leaves it out, and the
// failed attempt moves into the Details of the turn that replaced it. A resend
// names the failure it retries (`retryOfMessageId`); only Instafy's own is
// also marked `retryAutomatic`, which billing reads, so the person's resend is
// still their turn and charged as one. The mark is the sender's word, so the
// chat leaves a prompt out only when it can see the failed turn, the prompt
// repeats, from the same person, the words that turn answered, and no other
// turn came between them: "Try again" on an older failure, or a resend that
// waited behind a busy turn, stays as sent, so its answer never sits under
// an unrelated message. A retry that fails and is tried again folds too, so
// the turn that answers carries every try before it.

import {
  hasFailedRunMetadata,
  readRunFailureRetryOf,
  resolveRunFailureRetrySource,
} from "../../../conversations/runFailurePresentation";
import type { ChatMessage } from "../types";
import { getMessageType } from "./chatMessageMetadata";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(record: Record<string, unknown> | null, keys: readonly string[]): string {
  for (const key of keys) {
    const value = record?.[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return "";
}

function metadataOf(message: ChatMessage): Record<string, unknown> | null {
  return isRecord(message.metadata) ? message.metadata : null;
}

function jobIdOf(message: ChatMessage): string {
  return stringField(metadataOf(message), ["jobId", "job_id", "jobID"]);
}

function runIdOf(message: ChatMessage): string {
  return stringField(metadataOf(message), ["runId", "run_id"]);
}

function isFailureMessage(message: ChatMessage): boolean {
  return (
    message.role === "assistant" &&
    ((getMessageType(message) ?? "").trim().toLowerCase() === "error" || hasFailedRunMetadata(message.metadata))
  );
}

/** The failed attempt a retry replaces: its job, or its lone failure message when it had none. */
export type EarlierAttempt = { jobId: string | null; failureId: string };

export type AutomaticRetryFold = {
  /** Prompts sent again, by Instafy or by the person's "Try again". */
  hiddenPromptIds: ReadonlySet<string>;
  /** The retry's job id, to the attempt it replaces. */
  earlierAttemptByJobId: ReadonlyMap<string, EarlierAttempt>;
  /** Failed jobs whose resend went out but whose retry has shown nothing yet. */
  pendingJobIds: ReadonlySet<string>;
};

/**
 * Links each resend to the failed attempt it retries and to the job it
 * started: the resent prompt names the failure (`retryOfMessageId`), and its
 * stored row names the run its job reports under.
 */
export function resolveAutomaticRetryFold(messages: readonly ChatMessage[]): AutomaticRetryFold {
  const hiddenPromptIds = new Set<string>();
  const earlierAttemptByJobId = new Map<string, EarlierAttempt>();
  const pendingJobIds = new Set<string>();
  const failures = new Map<string, ChatMessage>();
  const jobByRunId = new Map<string, string>();
  // Runs that failed before any job ran them (the controller refused them).
  const failedRunsWithoutJob = new Set<string>();
  const resends: Array<{ prompt: ChatMessage; failureId: string; index: number }> = [];
  const failureIndex = new Map<string, number>();
  messages.forEach((message, index) => {
    const failureId = message.role === "user" ? readRunFailureRetryOf(message) : null;
    if (failureId) {
      resends.push({ prompt: message, failureId, index });
      return;
    }
    if (message.role !== "assistant") {
      return;
    }
    const jobId = jobIdOf(message);
    const runId = runIdOf(message);
    if (isFailureMessage(message)) {
      failures.set(message.id, message);
      failureIndex.set(message.id, index);
      if (!jobId && runId) {
        failedRunsWithoutJob.add(runId);
      }
    }
    if (jobId && runId && !jobByRunId.has(runId)) {
      jobByRunId.set(runId, jobId);
    }
  });
  for (const { prompt, failureId, index } of resends) {
    const failure = failures.get(failureId);
    const retryRunId = runIdOf(prompt);
    const retryJobId = retryRunId ? jobByRunId.get(retryRunId) : undefined;
    if (
      !failure ||
      !repeatsFailedPrompt(messages, prompt, failure) ||
      anotherTurnBetween(messages, failureIndex.get(failureId) ?? index, index, [jobIdOf(failure), retryJobId ?? ""])
    ) {
      continue;
    }
    hiddenPromptIds.add(prompt.id);
    const failedJobId = jobIdOf(failure) || null;
    if (retryJobId && retryJobId !== failedJobId) {
      earlierAttemptByJobId.set(retryJobId, { jobId: failedJobId, failureId });
    } else if (retryRunId && failedJobId && !failedRunsWithoutJob.has(retryRunId)) {
      // The controller took the resend and started its run, which has
      // written nothing yet.
      pendingJobIds.add(failedJobId);
    }
  }
  return { hiddenPromptIds, earlierAttemptByJobId, pendingJobIds };
}

/**
 * True when another turn sits between the failure and its resend: anyone's
 * prompt, or a message of a job that is neither the failed try nor its retry.
 */
function anotherTurnBetween(
  messages: readonly ChatMessage[],
  failureIndex: number,
  resendIndex: number,
  ownJobIds: readonly string[],
): boolean {
  return messages.slice(failureIndex + 1, resendIndex).some((message) => {
    if (message.role === "user") {
      return true;
    }
    const jobId = jobIdOf(message);
    return jobId !== "" && !ownJobIds.includes(jobId);
  });
}

/**
 * True when `prompt` repeats, from the same person, the prompt the failed turn
 * answered: the words a retry sends again.
 */
function repeatsFailedPrompt(messages: readonly ChatMessage[], prompt: ChatMessage, failure: ChatMessage): boolean {
  const source = resolveRunFailureRetrySource({ conversationMessages: [...messages], failureMessage: failure });
  return (
    source !== null &&
    source.id !== prompt.id &&
    source.content.trim() === prompt.content.trim() &&
    (source.authorId ?? null) === (prompt.authorId ?? null)
  );
}

/** The earlier attempts a turn carries in its Details, oldest first. */
export function readEarlierAttempts(message: ChatMessage): ChatMessage[][] {
  const attempts = metadataOf(message)?.earlierAttempts;
  if (!Array.isArray(attempts)) {
    return [];
  }
  return attempts.filter((attempt): attempt is ChatMessage[] => Array.isArray(attempt) && attempt.length > 0);
}

/** True for a failed turn whose resend went out and has not shown anything yet. */
export function isAutomaticRetryPending(message: ChatMessage): boolean {
  return metadataOf(message)?.autoRetryPending === true;
}
