import { getBuiltInAssistantDisplayName } from "../../../assistants/localBuiltInAssistantCatalog";
import { readRunFailureRetryOf } from "../../../conversations/runFailurePresentation";
import { wasRunStartedByPromptSentFromThisPage } from "../../../conversations/sentPromptRegistry";
import type { ControllerConversationStopResult } from "../../../services/runtimeController/conversationStop";
import type { RunRecord } from "../../../types";
import type { ChatMessage } from "../types";
import { isAutomaticRetryPending } from "./automaticRetryFold";
import { isBrowserNoticePrompt } from "./browserHandBack";
import { browserRequestFromMessage, browserRequestKey } from "./browserRequest";
import { extractAgentIdentityFromMetadata } from "./chatAssistantIdentity";
import { readPendingHandBack } from "./chatMessagePresentation";
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

function promptRunId(message: ChatMessage): string | null {
  const metadata = message.metadata;
  for (const key of ["runId", "run_id"]) {
    const value = metadata?.[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

/**
 * The targets whose turn carries a message on by itself: a browser card's
 * continuation, a hand-back to the building turn, or Instafy's own retry of a
 * failed turn, never a message someone wrote. A Stop pressed between two
 * parts of a message stops these as they start, and nothing else.
 */
export function chatRunStopFollowOnTargets(
  targets: readonly ChatRunStopTarget[],
  messages: readonly ChatMessage[],
): ChatRunStopTarget[] {
  if (targets.length === 0) return [];
  const prompts = messages.filter((message) =>
    message.role === "user" && (isBrowserNoticePrompt(message) || readRunFailureRetryOf(message) !== null));
  return targets.filter((target) => prompts.some((prompt) =>
    promptRunId(prompt) === target.runId || wasRunStartedByPromptSentFromThisPage(prompt, [target.runId, target.jobId])));
}

/**
 * Whether the chat's newest message is between two of its parts, the next of
 * which goes on by itself, so Stop stays meanwhile (useChatRunStop's
 * `between`): Studio is opening a browser card, a browser turn's hand-back to
 * the building turn is due or on its way, or the newest row stands in for a
 * turn that has shown nothing yet: a routed card's browser turn, or the
 * building turn it was handed to (routedBrowserFold.ts), a hand-back's turn,
 * or Instafy's own retry of a failed turn. Only the newest row counts, as for
 * the typing row: the fold keeps a routed card's key once its turn has shown
 * something (the chat takes the card out then), so a key alone is no gap.
 */
export function chatRunStopBetweenParts(chat: {
  /** Studio is opening a browser card by itself. */
  browserCardOpening: boolean;
  /** A browser turn's hand-back to the building turn is due or on its way (useBrowserHandBack). */
  handBackDue: boolean;
  /** The chat's newest row, as the transcript shows it. */
  newestRow: ChatMessage | null | undefined;
  /** The routed cards the fold keeps as standing in for their turn (routedBrowserFold.ts, `waitingCardKeys`). */
  routedWaitingKeys: ReadonlySet<string>;
}): boolean {
  if (chat.browserCardOpening || chat.handBackDue) return true;
  const row = chat.newestRow;
  if (!row) return false;
  if (readPendingHandBack(row) || isAutomaticRetryPending(row)) return true;
  return row.role === "assistant" && browserRequestFromMessage(row)?.routed === true &&
    chat.routedWaitingKeys.has(browserRequestKey(row));
}

/**
 * Whether the chat offers Stop (useChatRunStop's `active`): the chat is on
 * screen, in Chat or in its Browser view, both above the one composer that
 * holds Stop. A pause on the person's fields brings the Browser view forward
 * by itself while its turn still writes its reply, and Stop stays there until
 * that turn ends. Never in a job thread's tab, which is not the chat.
 */
export function chatRunStopOnScreen(view: { chatVisible: boolean; browserVisible: boolean; jobThread: boolean }): boolean {
  return (view.chatVisible || view.browserVisible) && !view.jobThread;
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
