import { getBuiltInAssistantDisplayName } from "../../../assistants/localBuiltInAssistantCatalog";
import type { ControllerConversationStopResult } from "../../../services/runtimeController/conversationStop";
import type { RunRecord } from "../../../types";
import type { ChatMessage } from "../types";
import { extractAgentIdentityFromMetadata } from "./chatAssistantIdentity";
import { resolveExpectedSteerJobId, resolveSteerableComposerRuns } from "./composerSendMode";

export type ChatRunStopTarget = {
  jobId: string;
  runId: string;
  agentHandle: string;
  agentDisplayName: string;
  /** Controller-derived identity. Missing identity always requires confirmation. */
  initiatingUserId: string | null;
};

export function resolveChatRunStopTargets(
  runs: readonly RunRecord[],
  messages: readonly ChatMessage[],
  options: { getAgentDisplayName?: (handle: string) => string | null | undefined } = {},
): ChatRunStopTarget[] {
  const seen = new Set<string>();
  return resolveSteerableComposerRuns(runs, messages).flatMap((run) => {
    if (!["queued", "in_progress", "awaiting_approval"].includes(run.status)) return [];
    const jobId = resolveExpectedSteerJobId(run, messages);
    if (!jobId || seen.has(jobId)) return [];
    seen.add(jobId);
    const identity = extractAgentIdentityFromMetadata(run.metadata);
    const handle = identity?.handle ?? "agent";
    // The controller reserves this field when serializing run metadata; never
    // infer ownership from nearby human messages or runtime-authored details.
    const initiator = run.metadata?.initiatingUserId;
    return [{
      jobId,
      runId: run.id,
      agentHandle: handle,
      agentDisplayName: options.getAgentDisplayName?.(handle)?.trim()
        || getBuiltInAssistantDisplayName(handle) || (handle === "agent" ? "the agent" : `@${handle}`),
      initiatingUserId: typeof initiator === "string" && initiator.trim() ? initiator.trim() : null,
    }];
  });
}

export function groupChatRunStopTargets(targets: readonly ChatRunStopTarget[]) {
  const groups = new Map<string, { handle: string; label: string; targets: ChatRunStopTarget[] }>();
  for (const target of targets) {
    const group = groups.get(target.agentHandle) ?? {
      handle: target.agentHandle,
      label: target.agentDisplayName,
      targets: [],
    };
    group.targets.push(target);
    groups.set(target.agentHandle, group);
  }
  return [...groups.values()];
}

export function chatRunStopNeedsConfirmation(targets: readonly ChatRunStopTarget[], viewerUserId: string | null): boolean {
  return !viewerUserId || targets.some((target) => !target.initiatingUserId || target.initiatingUserId !== viewerUserId);
}

/**
 * The records of the runs a Stop's answer says the controller canceled, now
 * canceled. The answer comes once the Stop is committed, as the same record
 * on the run's stream does, so the turn's row can say "Stopped" when the
 * answer lands. Never a run the answer calls finished, a run it does not
 * name, or one the chat holds no record of (its stream brings that).
 */
export function runsCanceledByStop(
  result: Pick<ControllerConversationStopResult, "ok" | "canceledRunIds">,
  runs: Readonly<Record<string, RunRecord>> | null | undefined,
): RunRecord[] {
  if (!result.ok) return [];
  return [...new Set(result.canceledRunIds)].flatMap((runId) => {
    const run = runs?.[runId];
    return run && run.status !== "canceled" ? [{ ...run, status: "canceled" as const }] : [];
  });
}
