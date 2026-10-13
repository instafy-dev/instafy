import { getBuiltInAssistantDisplayName } from "../../../assistants/localBuiltInAssistantCatalog";
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
