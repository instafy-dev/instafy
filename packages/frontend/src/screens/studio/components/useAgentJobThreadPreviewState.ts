import { type CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useConversations } from "../../../conversations/ConversationsProvider";
import { useRuntime } from "../../../runtime/useRuntime";
import type { RunRecord } from "../../../types";
import type { ChatMessage } from "../types";
import type { AgentJobThreadPreviewLayoutProps } from "./AgentJobThreadPreviewLayout";
import {
  parseCommandExecutionOutput,
  summarizeActiveCommandForPreview,
  summarizeCommandExecutionUpdateForPreview,
  truncate,
} from "./chatContentHelpers";
import {
  isAgentStatusMessage,
  runMatchesThreadJobId,
  shouldDisplayChatMessage,
} from "./chatMessagePresentation";
import { getMessageType } from "./chatMessageMetadata";
import { isCompactionStatusText, normalizeAssistantStatusText } from "./assistantStatusHeuristics";
import {
  isThreadPreviewUnresolved,
  resolveCompactRailStatusText,
  resolveThreadCompactUpdateHistoryLabel,
  resolveThreadCompactUpdateLabel,
  shouldRenderCompactRailStatus,
  shouldSuppressSummaryRunningStatus,
  shouldSweepCompactRailStatusText as shouldSweepCompactRailStatusTextValue,
} from "./threadPreviewState";
import { resolveRetryingStatusPresentation } from "../../../conversations/runFailurePresentation";
import {
  isThreadPreviewRunInFlight,
  resolveThreadPreviewMessages,
} from "./threadPreviewRunData";
import { resolveProxyUpstreamErrorGuidance } from "./proxyError";
import {
  coerceThreadMessages,
  isGenericProgressLabel,
  looksLikeTerminalProgressLabel,
  resolveThreadCompactEventPreview,
  resolveThreadCompactUpdateKind,
  resolveThreadRunStatusFromMessages,
  shouldKeepThreadUpdateInline,
  THREAD_ACTIVE_STATES,
  THREAD_COMPACT_EVENT_ICON_CAP,
  THREAD_HYBRID_COMPACTION_MIN_WIDTH_PX,
  THREAD_RECENT_ACTIVITY_WINDOW_MS,
  type ThreadCompactEvent,
} from "./threadPreviewHelpers";
import { resolveThreadPreviewSafeInsetPx } from "./threadPreviewGeometry";
import { resolveSpineToneFromStatus } from "./ThreadSpine";

const CHAT_SPINE_GUTTER_PX = 26;
const COMPACTION_STATUS_LABEL = "Re-organizing my thoughts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeAgentHandle(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim().replace(/^@+/, "").trim().toLowerCase();
  return trimmed ? `@${trimmed}` : null;
}

function extractMessageAgentHandle(message: ChatMessage): string | null {
  const metadata = message.metadata && isRecord(message.metadata) ? message.metadata : null;
  if (!metadata) {
    return null;
  }
  const direct = normalizeAgentHandle(metadata["agentHandle"] ?? metadata["agent_handle"]);
  if (direct) {
    return direct;
  }
  const agent = isRecord(metadata["agent"]) ? metadata["agent"] : null;
  return normalizeAgentHandle(agent?.["handle"]);
}

function isTerminalProxyErrorMessage(message: ChatMessage): boolean {
  return message.role === "assistant" && Boolean(resolveProxyUpstreamErrorGuidance(message.content));
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
  const threadPreviewRootRef = useRef<HTMLDivElement | null>(null);
  const threadPreviewRef = useRef<HTMLDivElement | null>(null);
  const [threadPreviewWidth, setThreadPreviewWidth] = useState(0);
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
      const type = (getMessageType(candidate) ?? "").trim().toLowerCase();
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
      return ![
        "command_execution",
        "mcp_tool_call",
        "todo_list",
        "web_search",
        "token_usage",
        "runtime_switch",
        "reasoning",
        "status",
      ].includes(type);
    };

    const resolveLast = (predicate: (candidate: ChatMessage) => boolean) => {
      for (let index = threadMessages.length - 1; index >= 0; index -= 1) {
        const candidate = threadMessages[index];
        if (predicate(candidate)) {
          return candidate;
        }
      }
      return null;
    };

    const lastAssistant = resolveLast((candidate) => candidate.role === "assistant" && isPreviewCandidate(candidate));
    const lastAny = lastAssistant ?? resolveLast(isPreviewCandidate);
    return lastAny?.content?.trim() ?? "";
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
      const type = (getMessageType(threadMessage) ?? "").trim().toLowerCase();
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
    () =>
      threadMessages.some(
        (threadMessage) => (getMessageType(threadMessage) ?? "").trim().toLowerCase() === "command_execution",
      ),
    [threadMessages],
  );

  const terminalProxyErrorMessage = useMemo(() => {
    for (let index = threadMessages.length - 1; index >= 0; index -= 1) {
      const candidate = threadMessages[index];
      if (isTerminalProxyErrorMessage(candidate)) {
        return candidate;
      }
    }
    return null;
  }, [threadMessages]);
  const isStaleRunningStatus = runStatus.phase === "running" && !isThreadRunInFlight && !hasRecentThreadActivity;
  const isCompleted = runStatus.phase === "completed" || isPlanOnlyThread || terminalProxyErrorMessage !== null;
  const isRunning =
    !isCompleted && runStatus.phase === "running" && (isThreadRunInFlight || hasRecentThreadActivity);
  const isStaleCommandOnlyStatus =
    !isCompleted && !isRunning && !isThreadRunInFlight && !hasRecentThreadActivity && hasThreadCommandActivity;
  const shouldShowStaleThreadStatus = !isCompleted && (isStaleRunningStatus || isStaleCommandOnlyStatus);
  const isActiveForPreview =
    !isCompleted &&
    !shouldShowStaleThreadStatus &&
    (isRunning || isThreadRunInFlight || hasRecentThreadActivity || runStatus.phase === "running");
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
      const type = (getMessageType(candidate) ?? "").trim().toLowerCase();
      if (type && excluded.has(type)) {
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

  const latestCommandExecutionUpdate = useMemo(() => {
    for (let index = threadMessages.length - 1; index >= 0; index -= 1) {
      const candidate = threadMessages[index];
      if ((getMessageType(candidate) ?? "").trim().toLowerCase() === "command_execution") {
        return candidate;
      }
    }
    return null;
  }, [threadMessages]);
  const latestCommandExecution = useMemo(
    () => (latestCommandExecutionUpdate ? parseCommandExecutionOutput(latestCommandExecutionUpdate) : null),
    [latestCommandExecutionUpdate],
  );
  const latestCommandAgentHandle = latestCommandExecutionUpdate
    ? extractMessageAgentHandle(latestCommandExecutionUpdate)
    : null;
  const hasAnyCommandExecutionUpdate = latestCommandExecutionUpdate !== null;
  const latestCommandPreview = useMemo(() => {
    if (!latestCommandExecution) {
      return "";
    }
    return summarizeCommandExecutionUpdateForPreview(
      latestCommandExecution.command ?? "",
      latestCommandExecution.output ?? null,
    );
  }, [latestCommandExecution]);

  const [expandedUpdateIds, setExpandedUpdateIds] = useState<Record<string, boolean>>({});
  const [commandOutputExpanded, setCommandOutputExpanded] = useState(false);
  const [isThreadPreviewExpanded, setIsThreadPreviewExpanded] = useState(false);

  const toggleUpdateExpanded = useCallback((messageId: string) => {
    setExpandedUpdateIds((current) => ({
      ...current,
      [messageId]: !current[messageId],
    }));
  }, []);

  useEffect(() => {
    setCommandOutputExpanded(false);
  }, [latestCommandExecutionUpdate?.id]);

  useEffect(() => {
    setIsThreadPreviewExpanded(false);
  }, [jobId]);

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
      const type = (getMessageType(candidate) ?? "").trim().toLowerCase();
      if (type === "reasoning") {
        return false;
      }
      if (type === "status") {
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
      return !["token_usage", "file_change", "command_execution", "runtime_switch", "web_search"].includes(type);
    });
  }, [finalSummaryMessage?.id, latestFileMessage?.id, threadMessages]);

  const { visibleUpdates, hiddenUpdateCount } = useMemo(() => {
    const maxVisible = isRunning ? 5 : 3;
    if (intermediateUpdates.length <= maxVisible) {
      return { visibleUpdates: intermediateUpdates, hiddenUpdateCount: 0 };
    }
    return {
      visibleUpdates: intermediateUpdates.slice(-maxVisible),
      hiddenUpdateCount: intermediateUpdates.length - maxVisible,
    };
  }, [intermediateUpdates, isRunning]);

  useEffect(() => {
    const allowed = new Set(visibleUpdates.map((entry) => entry.id));
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
  }, [visibleUpdates]);

  useEffect(() => {
    const element = threadPreviewRef.current;
    const rootElement = threadPreviewRootRef.current;
    if (!element || !rootElement) {
      return;
    }
    const scrollContainer = rootElement.closest('[data-testid="chat-message-scroll"]');

    const syncLayout = () => {
      const nextWidth = Math.round(element.clientWidth);
      setThreadPreviewWidth((current) => (current === nextWidth ? current : nextWidth));
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

  const hasUpdates = visibleUpdates.length > 0 || hiddenUpdateCount > 0;
  const hasCommandOutput = Boolean(latestCommandExecution?.output);
  const hasCommandInvocation = Boolean(latestCommandExecution?.command);
  const showLiveCommandPlaceholder = isRunning && hasCommandInvocation && !hasCommandOutput;
  const showLiveCommandOutputRaw = isRunning && hasCommandOutput;
  const showCollapsedCommandToggle = !isRunning && hasCommandOutput;
  const showCollapsedCommandOutput = !isRunning && hasCommandOutput && commandOutputExpanded;

  const shouldUseHybridThreadCompaction = useMemo(() => {
    if (threadPreviewWidth <= 0) {
      return false;
    }
    if (threadPreviewWidth < THREAD_HYBRID_COMPACTION_MIN_WIDTH_PX) {
      return true;
    }
    return visibleUpdates.length >= 5;
  }, [threadPreviewWidth, visibleUpdates.length]);

  const isHybridCompactionActive = shouldUseHybridThreadCompaction && !isThreadPreviewExpanded;
  const hybridThreadCompaction = useMemo(() => {
    if (!shouldUseHybridThreadCompaction) {
      return null;
    }
    const inlineUpdates: ChatMessage[] = [];
    const compactEvents: ThreadCompactEvent[] = [];
    const visibleUpdateIds = new Set(visibleUpdates.map((entry) => entry.id));
    const inlineUpdateIds = new Set<string>();
    const excludedIds = new Set<string>();
    if (finalSummaryMessage?.id) {
      excludedIds.add(finalSummaryMessage.id);
    }
    if (latestFileMessage?.id) {
      excludedIds.add(latestFileMessage.id);
    }

    for (const update of threadMessages) {
      if (!update.content?.trim()) {
        continue;
      }
      if (excludedIds.has(update.id)) {
        continue;
      }
      if (shouldKeepThreadUpdateInline(update)) {
        if (visibleUpdateIds.has(update.id) && !inlineUpdateIds.has(update.id)) {
          inlineUpdates.push(update);
          inlineUpdateIds.add(update.id);
        }
        continue;
      }
      const kind = resolveThreadCompactUpdateKind(update);
      if (kind) {
        // Enriched at assembly time with a short excerpt so the chip's hover
        // card can show what the step did without resolving the message again.
        const eventPreview = resolveThreadCompactEventPreview(update, kind);
        compactEvents.push({
          id: update.id,
          kind,
          actorHandle: extractMessageAgentHandle(update),
          previewText: eventPreview?.text ?? null,
          previewMono: eventPreview?.mono ?? false,
        });
        continue;
      }
      if (visibleUpdateIds.has(update.id) && !inlineUpdateIds.has(update.id)) {
        inlineUpdates.push(update);
        inlineUpdateIds.add(update.id);
      }
    }

    const safeIconSlots = Math.max(1, THREAD_COMPACT_EVENT_ICON_CAP);
    let overflowCount = 0;
    let nextVisibleCompactEvents: ThreadCompactEvent[] = compactEvents;
    let nextOverflowCompactEvents: ThreadCompactEvent[] = [];
    if (compactEvents.length > safeIconSlots) {
      const tailSlots = Math.max(1, safeIconSlots - 1);
      overflowCount = compactEvents.length - tailSlots;
      nextVisibleCompactEvents = compactEvents.slice(-tailSlots);
      // The elided head of the rail: the "+N" chip's hover card lists these
      // steps' history labels so the overflow is inspectable without expanding.
      nextOverflowCompactEvents = compactEvents.slice(0, overflowCount);
    } else {
      nextVisibleCompactEvents = compactEvents.slice(-safeIconSlots);
    }

    for (const update of visibleUpdates) {
      if (!inlineUpdateIds.has(update.id)) {
        const kind = resolveThreadCompactUpdateKind(update);
        if (!kind) {
          inlineUpdates.push(update);
          inlineUpdateIds.add(update.id);
        }
      }
    }

    return {
      inlineUpdates,
      visibleCompactEvents: nextVisibleCompactEvents,
      overflowCompactCount: overflowCount,
      overflowCompactEvents: nextOverflowCompactEvents,
    };
  }, [
    finalSummaryMessage?.id,
    latestFileMessage?.id,
    shouldUseHybridThreadCompaction,
    threadMessages,
    visibleUpdates,
  ]);

  const updatesForInlineRendering = isThreadPreviewExpanded
    ? intermediateUpdates
    : (hybridThreadCompaction?.inlineUpdates ?? visibleUpdates);
  const visibleCompactEvents = hybridThreadCompaction?.visibleCompactEvents ?? [];
  const overflowCompactCount = hybridThreadCompaction?.overflowCompactCount ?? 0;
  const overflowCompactEvents = hybridThreadCompaction?.overflowCompactEvents ?? [];
  const latestCompactEvent = visibleCompactEvents[visibleCompactEvents.length - 1] ?? null;
  const showLiveCommandOutput = showLiveCommandOutputRaw && !isHybridCompactionActive;
  const showCompactIconRail =
    shouldUseHybridThreadCompaction &&
    (visibleCompactEvents.length > 0 || overflowCompactCount > 0 || isThreadPreviewExpanded);
  const showCompactRailWaitingSpinner =
    isHybridCompactionActive && !isRunning && !isCompleted && isThreadRunInFlight;

  const isThreadUnresolved = isThreadPreviewUnresolved({
    isCompleted,
    isRunning,
    isThreadRunInFlight,
    hasRecentThreadActivity,
    runPhase: runStatus.phase,
  });
  const shouldAnimateThreadLiveState =
    isThreadUnresolved && !shouldShowStaleThreadStatus && !hasSupersedingConversationMessage;

  const runningStatusLabel = useMemo(() => {
    if (!isRunning) {
      return null;
    }
    for (let index = threadMessages.length - 1; index >= 0; index -= 1) {
      const candidate = threadMessages[index];
      if (candidate.role !== "assistant") {
        continue;
      }
      const type = (getMessageType(candidate) ?? "").trim().toLowerCase();
      if (type !== "status" && type !== "reasoning") {
        continue;
      }
      const normalized = normalizeAssistantStatusText(candidate.content);
      if (!normalized) {
        continue;
      }
      const retryingPresentation = resolveRetryingStatusPresentation({
        metadata: candidate.metadata,
        content: normalized,
      });
      if (retryingPresentation) {
        return retryingPresentation.displayText;
      }
      if (isCompactionStatusText(normalized)) {
        return COMPACTION_STATUS_LABEL;
      }
      if (normalized.toLowerCase() === "completed") {
        continue;
      }
      if (isGenericProgressLabel(normalized) || looksLikeTerminalProgressLabel(normalized)) {
        continue;
      }
      return truncate(normalized, 120);
    }
    return showLiveCommandOutput || hasUpdates ? "Running tasks…" : "Starting run…";
  }, [hasUpdates, isRunning, showLiveCommandOutput, threadMessages]);
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

    const normalizedStatus = normalizeAssistantStatusText(runningStatusLabel ?? "").toLowerCase();
    const statusKeepsOctoStill =
      isCompactionStatusText(runningStatusLabel ?? "") ||
      normalizedStatus === COMPACTION_STATUS_LABEL.toLowerCase() ||
      normalizedStatus.includes("drafting response") ||
      normalizedStatus.includes("response summary") ||
      normalizedStatus.includes("finaliz") ||
      normalizedStatus.includes("waiting for approval");
    return statusKeepsOctoStill ? "idle" : "thinking";
  }, [
    isRunning,
    jobId,
    owningConversation?.controllerId,
    runningStatusLabel,
    runs,
    shouldAnimateThreadLiveState,
  ]);

  const latestCommandStatus = (latestCommandExecution?.status ?? "").trim().toLowerCase();
  const latestCommandIsActive = latestCommandStatus ? THREAD_ACTIVE_STATES.has(latestCommandStatus) : false;
  const latestCommandLooksRunning =
    isActiveForPreview &&
    !shouldShowStaleThreadStatus &&
    hasCommandInvocation &&
    !hasCommandOutput &&
    (latestCommandIsActive || !latestCommandStatus);
  const activeCommandPreview = summarizeActiveCommandForPreview(latestCommandExecution?.command ?? "", 120);
  const compactRailStatusText = resolveCompactRailStatusText({
    showCompactRailCommandStatus: latestCommandLooksRunning,
    commandPreview: activeCommandPreview,
    latestCompactEventKind: shouldShowStaleThreadStatus ? null : (latestCompactEvent?.kind ?? null),
    runningStatusLabel: shouldShowStaleThreadStatus ? "Status unavailable" : runningStatusLabel,
  });
  const showCompactRailStatus = shouldRenderCompactRailStatus({
    isHybridCompactionActive,
    isCompleted,
    showLiveCommandOutput,
    isUnresolved: isThreadUnresolved,
    showCompactIconRail,
    showCompactRailWaitingSpinner,
  });
  const shouldCollapseSingleCompactEvent =
    showCompactIconRail &&
    visibleCompactEvents.length === 1 &&
    overflowCompactCount === 0 &&
    !showCompactRailWaitingSpinner;
  const singleCompactEvent = shouldCollapseSingleCompactEvent ? visibleCompactEvents[0] ?? null : null;
  const singleCompactEventLabel = useMemo(() => {
    if (!singleCompactEvent) {
      return "";
    }
    if (singleCompactEvent.kind === "command") {
      const commandPreview = activeCommandPreview.trim();
      if (commandPreview) {
        return commandPreview;
      }
    }
    if (shouldAnimateThreadLiveState) {
      const liveLabel = compactRailStatusText.trim();
      if (liveLabel) {
        return liveLabel;
      }
    }
    return shouldAnimateThreadLiveState
      ? resolveThreadCompactUpdateLabel(singleCompactEvent.kind)
      : resolveThreadCompactUpdateHistoryLabel(singleCompactEvent.kind);
  }, [activeCommandPreview, compactRailStatusText, shouldAnimateThreadLiveState, singleCompactEvent]);

  const showSingleCompactEventStatusSweep = Boolean(singleCompactEvent) && shouldAnimateThreadLiveState;
  const showCollapsedCompactRailStatus = showCompactRailStatus && !shouldCollapseSingleCompactEvent;
  const shouldSweepCompactRailStatusText = shouldSweepCompactRailStatusTextValue({
    showCompactRailStatus: showCollapsedCompactRailStatus,
    isUnresolved: shouldAnimateThreadLiveState,
  });

  const previewText =
    preview ||
    (isCompleted
      ? "Completed."
      : shouldShowStaleThreadStatus
        ? "Status unavailable"
        : showLiveCommandOutput || hasUpdates
          ? "Running tasks…"
          : "Starting run…");
  const showRunningPlaceholder =
    shouldAnimateThreadLiveState &&
    !showLiveCommandOutput &&
    !showLiveCommandPlaceholder &&
    !hasUpdates;
  const showSummaryBody = isCompleted || showRunningPlaceholder;
  const showRunningSpinnerFallback = showRunningPlaceholder && !preview;
  const useCompactRunningPreview =
    showRunningPlaceholder && previewText.length > 0 && previewText.length <= 80 && !previewText.includes("\n");
  const suppressSummaryRunningStatus = shouldSuppressSummaryRunningStatus({
    showCompactRailStatus: showCollapsedCompactRailStatus,
    showRunningSpinnerFallback,
    useCompactRunningPreview,
    hasRunningStatusLabel: Boolean(runningStatusLabel),
  });
  const summaryBodyPaddingTopClass =
    showCompactIconRail || showCollapsedCompactRailStatus
      ? "pt-0"
      : hasUpdates
        ? "pt-2"
        : "pt-1";

  const threadPreviewSafeInsetPx = useMemo(
    () =>
      resolveThreadPreviewSafeInsetPx({
        rootLeftPx: threadPreviewRootLeftPx,
        containerLeftPx: threadPreviewContainerLeftPx,
      }),
    [threadPreviewContainerLeftPx, threadPreviewRootLeftPx],
  );

  const runningPreviewContainerRef = useRef<HTMLDivElement | null>(null);
  const [runningPreviewHasOverflow, setRunningPreviewHasOverflow] = useState(false);

  useEffect(() => {
    if (isCompleted) {
      setRunningPreviewHasOverflow(false);
      return;
    }
    const element = runningPreviewContainerRef.current;
    if (!element) {
      return;
    }

    const checkOverflow = () => {
      setRunningPreviewHasOverflow(element.scrollHeight > element.clientHeight + 1);
    };

    checkOverflow();

    if (typeof ResizeObserver === "undefined") {
      return;
    }

    const observer = new ResizeObserver(() => checkOverflow());
    observer.observe(element);
    return () => observer.disconnect();
  }, [isCompleted, previewText]);

  const [cancelPending, setCancelPending] = useState(false);
  const canCancelTerminalRun = Boolean(onCancelTerminalCommand) && isRunning && hasAnyCommandExecutionUpdate;

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

  const threadPreviewBodyInsetPx = Math.max(4, threadPreviewSafeInsetPx - 24);
  const threadPreviewHeaderInsetPx = CHAT_SPINE_GUTTER_PX + threadPreviewBodyInsetPx + 16;
  const threadSpineJunctionOffsetClass = "left-[var(--thread-spine-left)]";
  const threadSpineHeaderOffsetClass = "left-[var(--thread-header-left)]";
  const threadPreviewRootStyle = {
    paddingLeft: `${threadPreviewBodyInsetPx}px`,
    ["--thread-spine-left" as const]: `${-CHAT_SPINE_GUTTER_PX - threadPreviewBodyInsetPx}px`,
    ["--thread-header-left" as const]: `${-threadPreviewHeaderInsetPx}px`,
  } as CSSProperties;
  const threadPreviewRailStyle = { top: "32px", bottom: !isRunning ? "16px" : "0px" } as CSSProperties;

  return {
    message,
    projectId,
    hideThreadSpine,
    showHeaderAvatar,
    assistantAvatarMotion,
    hiddenUpdateCount,
    isHybridCompactionActive,
    isThreadPreviewExpanded,
    visibleCompactEvents,
    overflowCompactCount,
    overflowCompactEvents,
    latestCompactEventId: latestCompactEvent?.id ?? null,
    showCompactRailWaitingSpinner,
    isThreadUnresolved,
    singleCompactEvent,
    singleCompactEventLabel,
    showSingleCompactEventStatusSweep,
    canCancelTerminalRun,
    cancelPending,
    compactRailStatusText,
    shouldSweepCompactRailStatusText,
    showCollapsedCompactRailStatus,
    showLiveCommandOutput,
    showLiveCommandPlaceholder,
    showCollapsedCommandToggle,
    showCollapsedCommandOutput,
    latestCommandExecution,
    latestCommandAgentHandle,
    latestCommandPreview,
    updatesForInlineRendering,
    expandedUpdateIds,
    finalSummaryMessage,
    hasPreview: Boolean(preview),
    previewText,
    showSummaryBody,
    suppressSummaryRunningStatus,
    isCompleted,
    showRunningSpinnerFallback,
    shouldAnimateThreadLiveState,
    runningStatusLabel,
    useCompactRunningPreview,
    runningPreviewHasOverflow,
    latestFiles,
    latestCommitRange,
    latestFilesMessageId: latestFileMessage?.id ?? null,
    latestFilesMessageTimestamp: latestFileMessage?.timestamp ?? null,
    isRunning,
    finalSpineTone,
    threadPreviewRootRef,
    threadPreviewRef,
    runningPreviewContainerRef,
    threadPreviewRootStyle,
    threadPreviewRailStyle,
    threadSpineJunctionOffsetClass,
    threadSpineHeaderOffsetClass,
    summaryBodyPaddingTopClass,
    onExpandThreadPreview: () => setIsThreadPreviewExpanded(true),
    onCollapseThreadPreview: () => setIsThreadPreviewExpanded(false),
    onToggleThreadPreview: () => setIsThreadPreviewExpanded((current) => !current),
    onToggleCommandOutput: () => setCommandOutputExpanded((current) => !current),
    onToggleUpdateExpanded: toggleUpdateExpanded,
    onCancelRun: () => {
      void handleCancelRun();
    },
    onCancelTerminalCommand: onCancelTerminalCommand ?? null,
  };
}
