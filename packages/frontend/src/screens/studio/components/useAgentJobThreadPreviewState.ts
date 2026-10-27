import { type CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useConversations } from "../../../conversations/ConversationsProvider";
import { useRuntime } from "../../../runtime/useRuntime";
import type { RunRecord } from "../../../types";
import type { ChatMessage } from "../types";
import type { AgentJobThreadPreviewLayoutProps } from "./AgentJobThreadPreviewLayout";
import {
  isAgentStatusMessage,
  runMatchesThreadJobId,
  shouldDisplayChatMessage,
} from "./chatMessagePresentation";
import { getMessageType } from "./chatMessageMetadata";
import { readChatRunStopNotice } from "./ChatRunStopNotice";
import { getControllerConversationNoticeKind } from "./controllerConversationNotice";
import { normalizeAssistantStatusText } from "./assistantStatusHeuristics";
import { isThreadPreviewUnresolved } from "./threadPreviewState";
import {
  isThreadPreviewRunInFlight,
  resolveThreadPreviewMessages,
} from "./threadPreviewRunData";
import { resolveTerminalProxyErrorMessage } from "./threadPreviewProxyError";
import {
  coerceThreadMessages,
  isGenericProgressLabel,
  looksLikeTerminalProgressLabel,
  resolveThreadRunStatusFromMessages,
  THREAD_ACTION_CARD_TYPES,
  THREAD_RECENT_ACTIVITY_WINDOW_MS,
} from "./threadPreviewHelpers";
import { resolveThreadPreviewSafeInsetPx } from "./threadPreviewGeometry";
import { resolveSpineToneFromStatus } from "./ThreadSpine";
import { summarizeTurnActivity, type TurnActivityPhase } from "./turnActivity";
import { useTurnBrowserApproval } from "./turnBrowserApproval";

const CHAT_SPINE_GUTTER_PX = 26;
// Steps are the activity line's and Details'; they are never update rows.
const STEP_MESSAGE_TYPES = new Set(["command_execution", "mcp_tool_call", "web_search", "file_change"]);
// Cards ask the person for something or show what the turn made: they stay in
// the turn's default view, never behind Details.
const CARD_MESSAGE_TYPES = new Set([...THREAD_ACTION_CARD_TYPES, "multi_agent_plan"]);
const CANCELLED_STATUSES = new Set(["canceled", "cancelled"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function messageType(message: ChatMessage): string {
  return (getMessageType(message) ?? "").trim().toLowerCase();
}

export type AgentJobThreadPreviewState = Omit<
  AgentJobThreadPreviewLayoutProps,
  "MessageContent" | "ChatFileChangeList" | "branchThreads" | "onOpenBranchThread"
>;

export function useAgentJobThreadPreviewState({
  message,
  projectId,
  onCancelTerminalCommand,
  showHeaderAvatar = true,
  hideThreadSpine = false,
}: {
  message: ChatMessage;
  projectId?: string | null;
  onCancelTerminalCommand?: (() => void | Promise<void>) | null;
  showHeaderAvatar?: boolean;
  hideThreadSpine?: boolean;
}): AgentJobThreadPreviewState | null {
  const { activeConversation, conversations } = useConversations();
  const { runs } = useRuntime();
  const metadata = message.metadata && isRecord(message.metadata) ? message.metadata : null;
  const jobId = typeof metadata?.jobId === "string" ? metadata.jobId.trim() : "";
  const threadLocalId = typeof metadata?.threadLocalId === "string" ? metadata.threadLocalId.trim() : "";
  const rawThreadMessages = metadata?.threadMessages;
  const fallbackThreadMessages = useMemo(() => coerceThreadMessages(rawThreadMessages), [rawThreadMessages]);
  const threadConversation = useMemo(
    () => (threadLocalId ? conversations.find((entry) => entry.localId === threadLocalId) ?? null : null),
    [conversations, threadLocalId],
  );
  const threadConversationControllerId = threadConversation?.controllerId ?? null;
  const threadMessages = useMemo(
    () =>
      resolveThreadPreviewMessages({
        threadMessages: fallbackThreadMessages,
        conversationControllerId: threadConversationControllerId,
        runs,
        jobId,
      }),
    [fallbackThreadMessages, jobId, runs, threadConversationControllerId],
  );
  const owningConversation = threadConversation ?? activeConversation;
  // A browser prompt of this turn's run shows inside the turn, under its line.
  const browserApproval = useTurnBrowserApproval({ jobId, runs: runs ?? {} });
  const threadPreviewRootRef = useRef<HTMLDivElement | null>(null);
  const threadPreviewRef = useRef<HTMLDivElement | null>(null);
  const [threadPreviewRootLeftPx, setThreadPreviewRootLeftPx] = useState(Number.POSITIVE_INFINITY);
  const [threadPreviewContainerLeftPx, setThreadPreviewContainerLeftPx] = useState(0);

  const preview = useMemo(() => {
    if (threadMessages.length === 0) {
      return "";
    }
    const isPreviewCandidate = (candidate: ChatMessage) => {
      const content = candidate.content.trim();
      if (!content) {
        return false;
      }
      const type = messageType(candidate);
      if (!type) {
        const normalized = content.toLowerCase();
        if (normalized.startsWith("plan update:")) {
          return false;
        }
        if (isGenericProgressLabel(normalized)) {
          return false;
        }
        if (
          /^(bash\s+-lc|pnpm|npm|yarn|cargo|git|python3?|node|deno|instafy|cat|ls|sed|curl|wget|chmod|mkdir|rm|cp|mv|touch)\b/i.test(
            normalized,
          )
        ) {
          return false;
        }
        return true;
      }
      if (THREAD_ACTION_CARD_TYPES.has(type)) {
        return false;
      }
      // A step is plumbing (a file change reads "Applied file changes:
      // <paths>"): it is the activity line's and Details', never the body of a
      // turn that has no reply, such as one someone stopped.
      if (STEP_MESSAGE_TYPES.has(type)) {
        return false;
      }
      return !["todo_list", "token_usage", "runtime_switch", "reasoning", "status"].includes(type);
    };

    for (let index = threadMessages.length - 1; index >= 0; index -= 1) {
      const candidate = threadMessages[index];
      if (candidate.role === "assistant" && isPreviewCandidate(candidate)) {
        return candidate.content.trim();
      }
    }
    for (let index = threadMessages.length - 1; index >= 0; index -= 1) {
      const candidate = threadMessages[index];
      if (isPreviewCandidate(candidate)) {
        return candidate.content.trim();
      }
    }
    return "";
  }, [threadMessages]);

  const latestFileMessage = useMemo(() => {
    for (let index = threadMessages.length - 1; index >= 0; index -= 1) {
      const candidate = threadMessages[index];
      if (Array.isArray(candidate.files) && candidate.files.length > 0) {
        return candidate;
      }
    }
    return null;
  }, [threadMessages]);
  const latestFiles = latestFileMessage?.files ?? null;
  const latestCommitRange = latestFileMessage?.commitRange ?? null;
  const latestUnsavedReason = latestFileMessage?.unsavedReason ?? null;

  const hasSupersedingConversationMessage = useMemo(() => {
    const activeMessages = activeConversation?.messages ?? [];
    if (activeMessages.length === 0) {
      return false;
    }

    const isSupersedingMessage = (candidate: ChatMessage) => {
      if (candidate.id === message.id) {
        return false;
      }
      return shouldDisplayChatMessage(candidate);
    };

    const messageIndex = activeMessages.findIndex((candidate) => candidate.id === message.id);
    if (messageIndex >= 0) {
      return activeMessages.slice(messageIndex + 1).some(isSupersedingMessage);
    }

    const messageTimestamp =
      typeof message.timestamp === "number" && Number.isFinite(message.timestamp)
        ? message.timestamp
        : Number.NEGATIVE_INFINITY;
    if (!Number.isFinite(messageTimestamp)) {
      return false;
    }

    return activeMessages.some((candidate) => {
      if (!isSupersedingMessage(candidate)) {
        return false;
      }
      const candidateTimestamp =
        typeof candidate.timestamp === "number" && Number.isFinite(candidate.timestamp)
          ? candidate.timestamp
          : Number.NEGATIVE_INFINITY;
      return candidateTimestamp > messageTimestamp;
    });
  }, [activeConversation?.messages, message.id, message.timestamp]);

  const runStatus = useMemo(() => resolveThreadRunStatusFromMessages(threadMessages), [threadMessages]);
  const isThreadRunInFlight = useMemo(() => {
    const pendingRunIds = owningConversation?.pendingRunIds ?? [];
    const pendingRunSubmittedAt = owningConversation?.pendingRunSubmittedAt ?? {};
    if (!jobId) {
      return false;
    }
    return isThreadPreviewRunInFlight({
      jobId,
      pendingRunIds,
      awaitingLeaseRunIds: owningConversation?.awaitingLeaseRunIds ?? [],
      pendingRunSubmittedAt,
      runs,
      conversationControllerId: owningConversation?.controllerId ?? null,
      matchesRunToJobId: runMatchesThreadJobId,
    });
  }, [
    jobId,
    owningConversation?.awaitingLeaseRunIds,
    owningConversation?.controllerId,
    owningConversation?.pendingRunIds,
    owningConversation?.pendingRunSubmittedAt,
    runs,
  ]);

  const hasRecentThreadActivity = useMemo(() => {
    let latestTimestamp = 0;
    for (const threadMessage of threadMessages) {
      const timestamp = typeof threadMessage.timestamp === "number" ? threadMessage.timestamp : 0;
      if (Number.isFinite(timestamp) && timestamp > latestTimestamp) {
        latestTimestamp = timestamp;
      }
    }
    if (latestTimestamp <= 0) {
      return false;
    }
    return Date.now() - latestTimestamp <= THREAD_RECENT_ACTIVITY_WINDOW_MS;
  }, [threadMessages]);

  const isPlanOnlyThread = useMemo(() => {
    let hasPlanUpdate = false;
    let hasNonPlanTimelineUpdate = false;
    for (const threadMessage of threadMessages) {
      const type = messageType(threadMessage);
      if (!type) {
        continue;
      }
      if (type === "todo_list") {
        hasPlanUpdate = true;
        continue;
      }
      hasNonPlanTimelineUpdate = true;
      break;
    }
    return hasPlanUpdate && !hasNonPlanTimelineUpdate;
  }, [threadMessages]);

  const hasThreadCommandActivity = useMemo(
    () => threadMessages.some((threadMessage) => messageType(threadMessage) === "command_execution"),
    [threadMessages],
  );
  // The model has started on the turn: a step, a reasoning title or a plan.
  // Until then the line says "Starting…", and from then on "Thinking…"
  // between steps, also before the first one.
  const hasModelWork = useMemo(
    () =>
      threadMessages.some((threadMessage) => {
        const type = messageType(threadMessage);
        return STEP_MESSAGE_TYPES.has(type) || type === "reasoning" || type === "todo_list";
      }),
    [threadMessages],
  );

  // Only a proxy error the run ended on fails the run. A retry notice that
  // quotes one ("Retrying: unexpected status 502 …") is progress, and a later
  // success supersedes any earlier error.
  const terminalProxyErrorMessage = useMemo(
    () => resolveTerminalProxyErrorMessage(threadMessages, runStatus),
    [runStatus, threadMessages],
  );
  // Someone stopped this run (Take over, Stop): its record says canceled, or
  // the conversation's stop notice names its job. Its updates just end, so
  // without this it read "Status unavailable" once they went quiet.
  const isStoppedRun = useMemo(() => {
    if (!jobId || runStatus.phase === "completed") {
      return false;
    }
    if (Object.values(runs ?? {}).some((run) => run.status === "canceled" && runMatchesThreadJobId(run, jobId))) {
      return true;
    }
    const conversationsToRead = threadConversation && threadConversation !== activeConversation
      ? [activeConversation, threadConversation]
      : [activeConversation];
    return conversationsToRead.some((conversation) =>
      (conversation?.messages ?? []).some((candidate) =>
        getControllerConversationNoticeKind(candidate) === "run_cancellation" &&
        readChatRunStopNotice(candidate).jobIds.includes(jobId)));
  }, [activeConversation, jobId, runStatus.phase, runs, threadConversation]);
  const isStaleRunningStatus = runStatus.phase === "running" && !isThreadRunInFlight && !hasRecentThreadActivity;
  const isCompleted =
    runStatus.phase === "completed" || isPlanOnlyThread || terminalProxyErrorMessage !== null || isStoppedRun;
  const isRunning =
    !isCompleted && runStatus.phase === "running" && (isThreadRunInFlight || hasRecentThreadActivity);
  const isStaleCommandOnlyStatus =
    !isCompleted && !isRunning && !isThreadRunInFlight && !hasRecentThreadActivity && hasThreadCommandActivity;
  const shouldShowStaleThreadStatus = !isCompleted && (isStaleRunningStatus || isStaleCommandOnlyStatus);
  const isActiveForPreview =
    !isCompleted &&
    !shouldShowStaleThreadStatus &&
    (isRunning || isThreadRunInFlight || hasRecentThreadActivity || runStatus.phase === "running");
  // `isRunning` flips back and forth inside one turn: it follows the newest
  // update's own status, so it drops each time a command finishes and returns
  // when the next one starts. Layout that must hold still for the whole turn
  // (the live line, where the spine ends) follows this instead: true from the
  // first sign of the turn until it completes or goes stale.
  const isThreadUnresolved = isThreadPreviewUnresolved({
    isCompleted,
    isRunning,
    isThreadRunInFlight,
    hasRecentThreadActivity,
    runPhase: runStatus.phase,
  });
  const finalSpineTone = terminalProxyErrorMessage
    ? "danger"
    : isActiveForPreview || isCompleted
    ? (resolveSpineToneFromStatus(runStatus.status) ?? "primary")
    : "neutral";

  const finalSummaryMessage = useMemo(() => {
    if (terminalProxyErrorMessage) {
      return terminalProxyErrorMessage;
    }
    if (threadMessages.length === 0) {
      return null;
    }
    const excluded = new Set([
      "command_execution",
      "mcp_tool_call",
      "todo_list",
      "file_change",
      "web_search",
      "token_usage",
      "runtime_switch",
      "reasoning",
    ]);
    for (let index = threadMessages.length - 1; index >= 0; index -= 1) {
      const candidate = threadMessages[index];
      if (candidate.role !== "assistant") {
        continue;
      }
      const content = candidate.content.trim();
      if (!content) {
        continue;
      }
      const type = messageType(candidate);
      // A card is not the reply. Taken for one, the newest card of a running
      // turn stayed hidden until the reply arrived and the turn ended on its
      // raw text instead of the card.
      if (type && (excluded.has(type) || CARD_MESSAGE_TYPES.has(type))) {
        continue;
      }
      if (type === "status") {
        const candidateMetadata = candidate.metadata && isRecord(candidate.metadata) ? candidate.metadata : null;
        const outcome =
          candidateMetadata && typeof candidateMetadata.outcome === "string"
            ? candidateMetadata.outcome.trim().toLowerCase()
            : "";
        if (outcome === "in_progress") {
          continue;
        }
        if (isAgentStatusMessage(candidate)) {
          const normalized = normalizeAssistantStatusText(candidate.content).toLowerCase();
          const looksLikeDrafting = normalized.includes("drafting response");
          const looksLikeSummary = normalized.includes("response summary") && normalized.includes("prepar");
          if (looksLikeDrafting || looksLikeSummary) {
            continue;
          }
        }
      }
      return candidate;
    }
    return null;
  }, [terminalProxyErrorMessage, threadMessages]);

  const [expandedUpdateIds, setExpandedUpdateIds] = useState<Record<string, boolean>>({});
  const [detailsOpen, setDetailsOpen] = useState(false);

  const toggleUpdateExpanded = useCallback((messageId: string) => {
    setExpandedUpdateIds((current) => ({
      ...current,
      [messageId]: !current[messageId],
    }));
  }, []);

  useEffect(() => {
    setDetailsOpen(false);
  }, [jobId]);

  // Everything between the person's message and the reply that is not a step:
  // cards (shown in the turn) and Octo's notes, reasoning titles, statuses and
  // plan updates (listed in Details).
  const intermediateUpdates = useMemo(() => {
    const excludedIds = new Set<string>();
    if (finalSummaryMessage?.id) {
      excludedIds.add(finalSummaryMessage.id);
    }
    if (latestFileMessage?.id) {
      excludedIds.add(latestFileMessage.id);
    }
    return threadMessages.filter((candidate) => {
      if (!candidate.content?.trim()) {
        return false;
      }
      if (excludedIds.has(candidate.id)) {
        return false;
      }
      const type = messageType(candidate);
      // Octo's reasoning titles and notes are listed in Details (never on the
      // line), as long as they say something.
      if (type === "status" || type === "reasoning") {
        const normalized = normalizeAssistantStatusText(candidate.content);
        if (!normalized) {
          return false;
        }
        if (normalized.toLowerCase() === "completed") {
          return false;
        }
        if (isGenericProgressLabel(normalized) || looksLikeTerminalProgressLabel(normalized)) {
          return false;
        }
      }
      return !["token_usage", "runtime_switch", ...STEP_MESSAGE_TYPES].includes(type);
    });
  }, [finalSummaryMessage?.id, latestFileMessage?.id, threadMessages]);
  const cards = useMemo(
    () => intermediateUpdates.filter((update) => CARD_MESSAGE_TYPES.has(messageType(update))),
    [intermediateUpdates],
  );
  const detailUpdates = useMemo(
    () => intermediateUpdates.filter((update) => !CARD_MESSAGE_TYPES.has(messageType(update))),
    [intermediateUpdates],
  );

  const activityPhase: TurnActivityPhase = shouldShowStaleThreadStatus
    ? "stale"
    : isThreadUnresolved
      ? hasModelWork
        ? "running"
        : "starting"
      : isCompleted &&
          terminalProxyErrorMessage === null &&
          (isStoppedRun || CANCELLED_STATUSES.has(runStatus.status ?? ""))
        ? "cancelled"
        : isCompleted && finalSpineTone === "danger"
          ? "failed"
          : "completed";
  const activity = useMemo(
    () =>
      summarizeTurnActivity(threadMessages, {
        jobId: jobId || null,
        phase: activityPhase,
        updates: detailUpdates,
        viewerCanAnswer: browserApproval.viewerCanAnswer,
        approvals: browserApproval.settled,
      }),
    [activityPhase, browserApproval.settled, browserApproval.viewerCanAnswer, detailUpdates, jobId, threadMessages],
  );

  useEffect(() => {
    const allowed = new Set(detailUpdates.map((entry) => entry.id));
    setExpandedUpdateIds((current) => {
      const next: Record<string, boolean> = {};
      let changed = false;
      for (const [id, expanded] of Object.entries(current)) {
        if (allowed.has(id)) {
          next[id] = expanded;
        } else {
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [detailUpdates]);

  useEffect(() => {
    const element = threadPreviewRef.current;
    const rootElement = threadPreviewRootRef.current;
    if (!element || !rootElement) {
      return;
    }
    const scrollContainer = rootElement.closest('[data-testid="chat-message-scroll"]');

    const syncLayout = () => {
      const nextLeft = rootElement.getBoundingClientRect().left;
      setThreadPreviewRootLeftPx((current) => (current === nextLeft ? current : nextLeft));
      const nextContainerLeft =
        scrollContainer instanceof HTMLElement ? scrollContainer.getBoundingClientRect().left : 0;
      setThreadPreviewContainerLeftPx((current) => (current === nextContainerLeft ? current : nextContainerLeft));
    };

    syncLayout();
    if (typeof ResizeObserver === "undefined") {
      return;
    }
    const observer = new ResizeObserver(() => syncLayout());
    observer.observe(element);
    observer.observe(rootElement);
    if (scrollContainer instanceof HTMLElement) {
      observer.observe(scrollContainer);
    }
    return () => observer.disconnect();
  }, []);

  const shouldAnimateThreadLiveState =
    isThreadUnresolved && !shouldShowStaleThreadStatus && !hasSupersedingConversationMessage;

  const assistantAvatarMotion = useMemo<"idle" | "thinking">(() => {
    if (!shouldAnimateThreadLiveState || !isRunning) {
      return "idle";
    }

    const normalizedConversationId = owningConversation?.controllerId?.trim() ?? "";
    if (!normalizedConversationId && (!jobId || jobId.startsWith("thread:"))) {
      return "idle";
    }
    let matchingRun: RunRecord | null = null;
    let matchingRunTimestamp = Number.NEGATIVE_INFINITY;
    for (const run of Object.values(runs ?? {})) {
      if (normalizedConversationId && run.conversationId !== normalizedConversationId) {
        continue;
      }
      if (jobId && !jobId.startsWith("thread:") && !runMatchesThreadJobId(run, jobId)) {
        continue;
      }
      const updatedAt = Date.parse(run.updatedAt ?? "");
      const createdAt = Date.parse(run.createdAt ?? "");
      const timestamp = Math.max(
        Number.isFinite(updatedAt) ? updatedAt : 0,
        Number.isFinite(createdAt) ? createdAt : 0,
      );
      if (!matchingRun || timestamp >= matchingRunTimestamp) {
        matchingRun = run;
        matchingRunTimestamp = timestamp;
      }
    }
    if (!matchingRun || matchingRun.status !== "in_progress") {
      return "idle";
    }
    // Octo holds still while it waits for the person or saves the turn.
    const live = activity.live ?? "";
    return live === "Waiting for you" || live === "Saving your changes…" ? "idle" : "thinking";
  }, [activity.live, isRunning, jobId, owningConversation?.controllerId, runs, shouldAnimateThreadLiveState]);

  const threadPreviewSafeInsetPx = useMemo(
    () =>
      resolveThreadPreviewSafeInsetPx({
        rootLeftPx: threadPreviewRootLeftPx,
        containerLeftPx: threadPreviewContainerLeftPx,
      }),
    [threadPreviewContainerLeftPx, threadPreviewRootLeftPx],
  );

  const [cancelPending, setCancelPending] = useState(false);
  const canCancelTerminalRun = Boolean(onCancelTerminalCommand) && isRunning && hasThreadCommandActivity;

  const handleCancelRun = useCallback(async () => {
    if (!onCancelTerminalCommand || cancelPending) {
      return;
    }
    setCancelPending(true);
    try {
      await onCancelTerminalCommand();
    } finally {
      setCancelPending(false);
    }
  }, [cancelPending, onCancelTerminalCommand]);

  if ((!jobId && !threadLocalId) || threadMessages.length === 0) {
    return null;
  }

  const isLiveTurn = isRunning || isThreadUnresolved;
  const threadPreviewBodyInsetPx = Math.max(4, threadPreviewSafeInsetPx - 24);
  const threadPreviewHeaderInsetPx = CHAT_SPINE_GUTTER_PX + threadPreviewBodyInsetPx + 16;
  const threadSpineJunctionOffsetClass = "left-[var(--thread-spine-left)]";
  const threadSpineHeaderOffsetClass = "left-[var(--thread-header-left)]";
  const threadPreviewRootStyle = {
    paddingLeft: `${threadPreviewBodyInsetPx}px`,
    ["--thread-spine-left" as const]: `${-CHAT_SPINE_GUTTER_PX - threadPreviewBodyInsetPx}px`,
    ["--thread-header-left" as const]: `${-threadPreviewHeaderInsetPx}px`,
  } as CSSProperties;
  // The spine runs open to the bottom for the whole turn and gains its end
  // cap once, when the turn settles (see isThreadUnresolved).
  const threadPreviewRailStyle = { top: "32px", bottom: isLiveTurn ? "0px" : "16px" } as CSSProperties;

  return {
    message,
    projectId,
    hideThreadSpine,
    showHeaderAvatar,
    assistantAvatarMotion,
    activity,
    browserApproval: browserApproval.row,
    detailsOpen,
    cards,
    isThreadUnresolved,
    canCancelTerminalRun,
    cancelPending,
    expandedUpdateIds,
    finalSummaryMessage,
    hasPreview: Boolean(preview),
    previewText: preview || (isCompleted ? (isStoppedRun && terminalProxyErrorMessage === null ? "Stopped." : "Completed.") : ""),
    isCompleted,
    shouldAnimateThreadLiveState,
    latestFiles,
    latestCommitRange,
    latestUnsavedReason,
    latestFilesMessageId: latestFileMessage?.id ?? null,
    latestFilesMessageTimestamp: latestFileMessage?.timestamp ?? null,
    isRunning,
    finalSpineTone,
    threadPreviewRootRef,
    threadPreviewRef,
    threadPreviewRootStyle,
    threadPreviewRailStyle,
    threadSpineJunctionOffsetClass,
    threadSpineHeaderOffsetClass,
    onToggleDetails: () => setDetailsOpen((current) => !current),
    onToggleUpdateExpanded: toggleUpdateExpanded,
    onCancelRun: () => {
      void handleCancelRun();
    },
    onCancelTerminalCommand: onCancelTerminalCommand ?? null,
  };
}
