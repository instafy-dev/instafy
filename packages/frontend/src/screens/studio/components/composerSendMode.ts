import { shouldSuppressAgentEvaluationRunPresence } from "../../../conversations/groupParticipation";
import type { RunRecord } from "../../../types";
import type { ChatMessage } from "../types";

export function resolveSteerableComposerRuns<T extends Pick<RunRecord, "id" | "metadata">>(
  runs: readonly T[],
  messages: readonly ChatMessage[],
): T[] {
  return runs.filter(
    (run) =>
      !shouldSuppressAgentEvaluationRunPresence({
        runId: run.id,
        runMetadata: run.metadata,
        messages,
      }),
  );
}

export function resolveComposerPrimaryActionMode({
  isAssistantActive,
  targetAgentHandles,
  activeAgentHandles,
}: {
  isAssistantActive: boolean;
  targetAgentHandles: string[];
  activeAgentHandles: ReadonlySet<string>;
}): "send" | "steer" {
  if (!isAssistantActive || targetAgentHandles.length === 0) {
    return "send";
  }
  if (activeAgentHandles.size === 0) {
    return "steer";
  }
  return targetAgentHandles.some((handle) => activeAgentHandles.has(handle))
    ? "steer"
    : "send";
}

export function resolveExpectedSteerJobId(
  run: { id: string; metadata: Record<string, unknown> | null } | null,
  messages: ReadonlyArray<{
    role: "assistant" | "user";
    metadata?: Record<string, unknown> | null;
  }> = [],
): string | null {
  if (!run) {
    return null;
  }

  const normalizeUuid = (candidate: unknown): string | null => {
    if (typeof candidate !== "string") {
      return null;
    }
    const normalized = candidate.trim().toLowerCase();
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
      normalized,
    )
      ? normalized
      : null;
  };

  const jobIds = new Set<string>();
  for (const candidate of run.metadata
    ? [run.metadata.jobId, run.metadata.job_id, run.metadata.jobID]
    : []) {
    const jobId = normalizeUuid(candidate);
    if (jobId) {
      jobIds.add(jobId);
    }
  }

  // Run snapshots predate agent jobs and do not always carry the job UUID,
  // notably after a workspace reconnect. Conversation-message upserts do:
  // their normalized metadata includes both the authoritative runId and jobId.
  // Accept that fallback only when every message for this exact active run
  // agrees on one job, preserving the controller's exact-job CAS guarantee.
  const runId = run.id.trim();
  if (!runId) {
    return null;
  }
  for (const message of messages) {
    // Human message metadata is client-authored. Only assistant rows can carry
    // the controller-authored run/job linkage used for this exact-job fence.
    if (message.role !== "assistant") {
      continue;
    }
    const metadata = message.metadata;
    if (!metadata) {
      continue;
    }
    // mapControllerMessageToChat injects the controller row's runId at the
    // top level. Nested details are runtime-authored and are not routing
    // authority, so never use them to select a steer target.
    const messageRunIdCandidates = [metadata.runId, metadata.run_id];
    const belongsToRun = messageRunIdCandidates.some(
      (candidate) => typeof candidate === "string" && candidate.trim() === runId,
    );
    if (!belongsToRun) {
      continue;
    }
    const messageJobIdCandidates = [metadata.jobId, metadata.job_id, metadata.jobID];
    for (const candidate of messageJobIdCandidates) {
      const jobId = normalizeUuid(candidate);
      if (jobId) {
        jobIds.add(jobId);
      }
    }
  }
  return jobIds.size === 1 ? Array.from(jobIds)[0] : null;
}

export function requireExpectedJobForSteer(
  candidateMode: "send" | "steer",
  expectedActiveJobId: string | null,
): "send" | "steer" {
  return candidateMode === "steer" && expectedActiveJobId ? "steer" : "send";
}
