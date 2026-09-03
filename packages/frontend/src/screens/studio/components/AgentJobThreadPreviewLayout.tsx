import { useCallback, useEffect, useState } from "react";
import type { CSSProperties, ComponentType, MouseEvent, MutableRefObject, ReactNode } from "react";
import {
  Activity,
  ClipboardCheck,
  CompressLines,
  Copy,
  Eye,
  GitBranch,
  Globe,
  NavArrowDown,
  NavArrowRight,
  OpenNewWindow,
  Terminal,
  WarningTriangle,
  Xmark,
} from "iconoir-react";
import { IconButton } from "../../../components/Button";
import { Spinner } from "../../../components/Spinner";
import { Text } from "../../../components/Text";
import { isUuid } from "../../../conversations/conversationMessageUtils";
import { cancelAgentJob } from "../../../services/runtimeController/jobs";
import {
  resolveAgentAvatarGradient,
  resolveAgentAvatarImageSrc,
  resolveAgentAvatarText,
} from "../../../utils/agentAvatar";
import type { ChatMessage, ChatMessageCommitRange,
  ChatMessageFileChange } from "../types";
import { ActionRequestEntry } from "./ActionRequestEntry";
import { ChatMessageAvatar } from "./ChatMessageAvatar";
import type { AssistantAvatarMotion } from "./chatAssistantIdentity";
import { IntegrationRequestEntry, SecretRequestEntry } from "./ChatCredentialRequestEntries";
import { CommandOutputBlock, useCopyCommandOutput } from "./CommandOutputBlock";
import { MultiAgentPlanEntry } from "./MultiAgentPlanEntry";
import {
  normalizeActivityText,
  parseTodoItems,
  splitActivityLeadAndDetails,
  stripWorkspacePrefixForPreview,
  summarizeActiveCommandForPreview,
  summarizeCommandExecutionResultForPreview,
  truncate,
} from "./chatContentHelpers";
import {
  resolveRetryingStatusPresentation,
  resolveRunFailurePresentation,
} from "../../../conversations/runFailurePresentation";
import { extractMessageDetails, getMessageType } from "./chatMessageMetadata";
import { extractAgentJobId, shouldRenderLocalCapabilityStatusAsTimeline } from "./chatMessagePresentation";
import { RunFailureMessageBody } from "./RunFailureNotice";
import { isCompactionStatusText } from "./assistantStatusHeuristics";
import type { AgentThreadBranchParticipant, AgentThreadBranchRow } from "./agentThreadBranchRows";
import {
  resolveThreadCompactUpdateHistoryLabel,
  resolveThreadCompactUpdateLabel,
} from "./threadPreviewState";
import {
  renderThreadCompactEventIcon,
  stripShellWrapperFromCommand,
  THREAD_SPINE_COMPACT_NOTCH_OFFSET_PX,
  THREAD_SPINE_DEFAULT_NOTCH_OFFSET_PX,
  THREAD_SPINE_END_SEGMENT_HEIGHT_PX,
  THREAD_SPINE_END_SEGMENT_TOP_PX,
  type ThreadCompactEvent,
} from "./threadPreviewHelpers";
import { ThreadRailChipButton, type ThreadRailHoverCardContent } from "./ThreadRailHoverCard";
import { ThreadSpine, type ThreadSpineTone } from "./ThreadSpine";
import {
  formatProxyUpstreamErrorSummary,
  resolveProxyUpstreamErrorGuidance,
} from "./proxyError";

const COMPACTION_STATUS_LABEL = "Re-organizing my thoughts";

// The command surface is one visual family with CODE_BLOCK_CLASS: same radius
// and ring tokens, subtler fill. Sections stacked inside it are separated by a
// hairline drawn with the ring tokens so the panel reads as one box (#191).
const COMMAND_SURFACE_CLASS =
  "rounded-xl bg-slate-950/[0.02] ring-1 ring-inset ring-slate-900/10 dark:bg-white/[0.035] dark:ring-white/[0.08]";
const COMMAND_SURFACE_DIVIDER_CLASS = "border-t border-slate-900/10 dark:border-white/[0.08]";
// Ghost glyphs inside the command surface: no hover or pressed circle tint,
// the surface already carries its own hover fill.
const COMMAND_SURFACE_GLYPH_BUTTON_CLASS =
  "text-slate-500 opacity-100 hover:bg-transparent hover:text-slate-800 data-[hovered]:bg-transparent data-[pressed]:bg-transparent dark:text-slate-300 dark:hover:bg-transparent dark:hover:text-slate-100 dark:data-[hovered]:bg-transparent dark:data-[pressed]:bg-transparent";
const COMMAND_SURFACE_STOP_BUTTON_CLASS =
  "hover:bg-transparent data-[hovered]:bg-transparent data-[pressed]:bg-transparent dark:hover:bg-transparent dark:data-[hovered]:bg-transparent dark:data-[pressed]:bg-transparent";
// The collapsed command row may trail a short result hint ("→ 220a9ff"); a
// longer result is not a hint, so the row stays quiet instead of truncating.
const COMMAND_RESULT_HINT_MAX_CHARS = 24;

const COMMAND_RUNNING_STATUSES = new Set([
  "in_progress",
  "queued",
  "started",
  "running",
  "applying",
  "refreshing",
]);
const COMMAND_COMPLETED_STATUSES = new Set(["completed", "complete", "success", "succeeded", "done"]);
const COMMAND_FAILED_STATUSES = new Set(["failed", "failure", "error", "errored"]);
const COMMAND_CANCELLED_STATUSES = new Set([
  "cancelled",
  "canceled",
  "cancelling",
  "canceling",
  "aborted",
  "interrupted",
  "stopped",
]);

// Fixed vocabulary for the panel's status line when a command has no output
// to show: the exit state, never the command text the header already shows.
function resolveCommandResultStatusLabel(status: string | null | undefined): string {
  const normalized = typeof status === "string" ? status.trim().toLowerCase() : "";
  if (!normalized) {
    return "No output";
  }
  if (COMMAND_RUNNING_STATUSES.has(normalized)) {
    return "Running…";
  }
  if (COMMAND_COMPLETED_STATUSES.has(normalized)) {
    return "Completed with no output";
  }
  if (COMMAND_FAILED_STATUSES.has(normalized)) {
    return "Failed";
  }
  if (COMMAND_CANCELLED_STATUSES.has(normalized)) {
    return "Cancelled";
  }
  const spaced = normalized.replace(/[_-]+/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// extractAgentJobId can surface run ids or "thread:"-prefixed thread ids;
// only real job ids (UUIDs) are cancelable through the per-job endpoint.
function isCancelableAgentJobId(jobId: string | null): jobId is string {
  return Boolean(jobId && !jobId.startsWith("thread:") && isUuid(jobId));
}

function normalizeAgentHandle(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim().replace(/^@+/, "").trim().toLowerCase();
  return trimmed ? `@${trimmed}` : null;
}

function formatAgentInitial(handle: string): string {
  return handle.replace(/^@+/, "").slice(0, 1).toUpperCase() || "@";
}

function formatHiddenUpdateLabel(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function resolveTerminalStatusMarker(tone: ThreadSpineTone, isCompleted: boolean) {
  if (!isCompleted) {
    return null;
  }
  if (tone === "danger") {
    return {
      label: "Run failed",
      iconClassName: "text-rose-500 dark:text-rose-300",
    };
  }
  if (tone === "warning") {
    return {
      label: "Run needs attention",
      iconClassName: "text-secondary-500 dark:text-secondary-300",
    };
  }
  return null;
}

function resolveProxyGuidanceContent(update: ChatMessage): string | null {
  const updateType = (getMessageType(update) ?? "").trim().toLowerCase();
  const isActivityUpdate = updateType === "reasoning" || updateType === "status";
  const rawContent = isActivityUpdate ? normalizeActivityText(update.content) : update.content.trim();
  return resolveProxyUpstreamErrorGuidance(rawContent) ? rawContent : null;
}

function resolveCompactEventLabel(
  event: ThreadCompactEvent,
  ownerBadge: string | null,
  isLive: boolean,
): string {
  const actor = normalizeAgentHandle(event.actorHandle);
  if (actor && ownerBadge && actor !== ownerBadge) {
    return `${actor} replied`;
  }
  return isLive
    ? resolveThreadCompactUpdateLabel(event.kind)
    : resolveThreadCompactUpdateHistoryLabel(event.kind);
}

// The hover card previews what the step is/was doing: header = the step's
// history label plus the actor handle when present, body = the excerpt the
// assembly derived (#179). No excerpt → no card; the chip keeps its title.
function resolveCompactEventHoverCard(event: ThreadCompactEvent): ThreadRailHoverCardContent | null {
  const previewText = typeof event.previewText === "string" ? event.previewText.trim() : "";
  if (!previewText) {
    return null;
  }
  return {
    header: resolveThreadCompactUpdateHistoryLabel(event.kind),
    headerDetail: normalizeAgentHandle(event.actorHandle),
    bodyText: previewText,
    mono: Boolean(event.previewMono),
  };
}

// Chips are focusable buttons; the same ring vocabulary as the chat's other
// chip rows (ChatFileChangeList).
const COMPACT_EVENT_PILL_FOCUS_CLASS =
  "focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-400 focus-visible:ring-offset-2 focus-visible:ring-offset-white dark:focus-visible:ring-primary-300/80 dark:focus-visible:ring-offset-slate-950";

function renderCompactEventContent(event: ThreadCompactEvent, ownerBadge: string | null) {
  const actor = normalizeAgentHandle(event.actorHandle);
  if (actor && ownerBadge && actor !== ownerBadge) {
    return (
      <span
        data-testid="agent-thread-compact-actor"
        aria-hidden="true"
        className="text-3xs font-semibold leading-none"
      >
        {formatAgentInitial(actor)}
      </span>
    );
  }
  return renderThreadCompactEventIcon(event.kind);
}

function normalizeInlineUpdateDedupeKey(content: string, updateType: string): string | null {
  const normalizedContent = content.replace(/\s+/g, " ").trim().toLowerCase();
  if (!normalizedContent) {
    return null;
  }
  return `${updateType}:${normalizedContent}`;
}

function BranchParticipantAvatar({ participant }: { participant: AgentThreadBranchParticipant }) {
  const avatarImageSrc = resolveAgentAvatarImageSrc(participant);
  const avatarText = resolveAgentAvatarText({ handle: participant.handle });
  const title = `@${participant.handle}`;
  return (
    <span
      className="inline-flex h-5 w-5 items-center justify-center overflow-hidden rounded-full border border-white bg-slate-100 text-3xs font-semibold text-white shadow-sm first:ml-0 -ml-1.5 dark:border-slate-950 dark:bg-slate-800"
      style={avatarImageSrc ? undefined : { backgroundImage: resolveAgentAvatarGradient(participant.avatarSeed ?? participant.handle) }}
      title={title}
      aria-label={title}
    >
      {avatarImageSrc ? (
        <img src={avatarImageSrc} alt="" className="h-full w-full object-cover" decoding="async" draggable={false} />
      ) : (
        avatarText
      )}
    </span>
  );
}

function AgentThreadBranchRowEntry({
  branch,
  onOpen,
}: {
  branch: AgentThreadBranchRow;
  onOpen: (threadLocalId: string) => void;
}) {
  const participants = branch.participants.slice(0, 3);
  const title = branch.title || "Thread";
  return (
    <div
      data-testid="agent-thread-branch-row"
      className="flex min-w-0 items-center gap-2 rounded-xl border border-slate-200/70 bg-white/70 px-2.5 py-1.5 text-xs text-slate-600 shadow-sm shadow-slate-200/30 dark:border-slate-800/80 dark:bg-slate-950/35 dark:text-slate-300 dark:shadow-none"
    >
      <GitBranch
        aria-hidden="true"
        className="h-3.5 w-3.5 flex-none -scale-x-100 text-primary-500 dark:text-primary-300"
      />
      <span className="min-w-0 flex-1 truncate font-medium text-slate-700 dark:text-slate-100" title={title}>
        {title}
      </span>
      {participants.length > 1 ? (
        <span className="flex flex-none items-center" aria-label={`Participants: ${participants.map((entry) => `@${entry.handle}`).join(", ")}`}>
          {participants.map((participant) => (
            <BranchParticipantAvatar key={participant.handle} participant={participant} />
          ))}
        </span>
      ) : null}
      {branch.hiddenActivityCount > 0 ? (
        <span
          className="instafy-branch-hidden-activity-indicator relative inline-flex h-5 w-5 flex-none items-center justify-center rounded-full border border-slate-200 bg-white text-slate-500 shadow-sm after:absolute after:-right-1 after:-top-1 after:flex after:h-3.5 after:min-w-3.5 after:items-center after:justify-center after:rounded-full after:bg-slate-700 after:px-0.5 after:text-3xs after:font-semibold after:leading-none after:text-white after:content-[attr(data-count)] dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300 dark:after:bg-slate-200 dark:after:text-slate-900"
          data-count={String(branch.hiddenActivityCount)}
          title={formatHiddenUpdateLabel(branch.hiddenActivityCount, "child thread update")}
          aria-label={formatHiddenUpdateLabel(branch.hiddenActivityCount, "child thread update")}
          role="note"
        >
          <Activity aria-hidden="true" className="h-3 w-3" />
        </span>
      ) : null}
      {branch.isRunning ? (
        <Spinner aria-label="Child thread is running" tone="primary" size="xs" className="h-3.5 w-3.5 flex-none" />
      ) : null}
      <IconButton
        aria-label={`Open child thread: ${title}`}
        variant="ghost"
        size="xs"
        radius="full"
        onPress={() => onOpen(branch.threadLocalId)}
        className="flex-none text-slate-400 hover:text-slate-700 dark:text-slate-500 dark:hover:text-slate-200"
      >
        <OpenNewWindow aria-hidden="true" className="h-3.5 w-3.5" />
      </IconButton>
    </div>
  );
}

export type MessageContentProps = {
  content: string;
  projectId?: string | null;
};

export type ChatFileChangeListProps = {
  files: ChatMessageFileChange[];
  projectId?: string | null;
  commitRange?: ChatMessageCommitRange | null;
  messageId?: string | null;
  messageTimestamp?: number | null;
};

export type CommandExecutionPreview = {
  output: string | null;
  status: string | null;
  command: string | null;
};

export type AgentJobThreadPreviewLayoutProps = {
  message: ChatMessage;
  projectId?: string | null;
  branchThreads: AgentThreadBranchRow[];
  hideThreadSpine?: boolean;
  showHeaderAvatar: boolean;
  assistantAvatarMotion: AssistantAvatarMotion;
  showHeaderIdentity?: boolean;
  hiddenUpdateCount: number;
  /**
   * True when the surrounding row's speaker header already shows the terminal
   * run-status marker; the preview then skips its own status caption so run
   * state reads exactly once, at entry-header level (#145).
   */
  runStatusShownInEntryHeader?: boolean;
  isHybridCompactionActive: boolean;
  isThreadPreviewExpanded: boolean;
  visibleCompactEvents: ThreadCompactEvent[];
  overflowCompactCount: number;
  /**
   * The steps elided behind the "+N" chip, oldest first; its hover card lists
   * their history labels (#179). May be empty even when overflowCompactCount
   * is set (legacy callers) — the chip then keeps its plain title tooltip.
   */
  overflowCompactEvents?: ThreadCompactEvent[];
  latestCompactEventId: string | null;
  showCompactRailWaitingSpinner: boolean;
  isThreadUnresolved: boolean;
  singleCompactEvent: ThreadCompactEvent | null;
  singleCompactEventLabel: string;
  showSingleCompactEventStatusSweep: boolean;
  canCancelTerminalRun: boolean;
  cancelPending: boolean;
  compactRailStatusText: string;
  shouldSweepCompactRailStatusText: boolean;
  showCollapsedCompactRailStatus: boolean;
  showLiveCommandOutput: boolean;
  showLiveCommandPlaceholder: boolean;
  showCollapsedCommandToggle: boolean;
  showCollapsedCommandOutput: boolean;
  latestCommandExecution: CommandExecutionPreview | null;
  latestCommandAgentHandle: string | null;
  latestCommandPreview: string;
  updatesForInlineRendering: ChatMessage[];
  expandedUpdateIds: Record<string, boolean>;
  finalSummaryMessage: ChatMessage | null;
  hasPreview: boolean;
  previewText: string;
  showSummaryBody: boolean;
  suppressSummaryRunningStatus: boolean;
  isCompleted: boolean;
  showRunningSpinnerFallback: boolean;
  shouldAnimateThreadLiveState: boolean;
  runningStatusLabel: string | null;
  useCompactRunningPreview: boolean;
  runningPreviewHasOverflow: boolean;
  latestFiles: ChatMessageFileChange[] | null;
  latestCommitRange?: ChatMessageCommitRange | null;
  latestFilesMessageId?: string | null;
  latestFilesMessageTimestamp?: number | null;
  isRunning: boolean;
  finalSpineTone: ThreadSpineTone;
  threadPreviewRootRef: MutableRefObject<HTMLDivElement | null>;
  threadPreviewRef: MutableRefObject<HTMLDivElement | null>;
  runningPreviewContainerRef: MutableRefObject<HTMLDivElement | null>;
  threadPreviewRootStyle: CSSProperties;
  threadPreviewRailStyle: CSSProperties;
  threadSpineJunctionOffsetClass: string;
  threadSpineHeaderOffsetClass: string;
  summaryBodyPaddingTopClass: string;
  onOpenBranchThread: (threadLocalId: string) => void;
  onExpandThreadPreview: () => void;
  onCollapseThreadPreview: () => void;
  onToggleThreadPreview: () => void;
  onToggleCommandOutput: () => void;
  onToggleUpdateExpanded: (messageId: string) => void;
  onCancelRun: () => void;
  onCancelTerminalCommand?: (() => void | Promise<void>) | null;
  onMessageContextMenu?: (event: MouseEvent<HTMLDivElement>, messageId: string) => void;
  MessageContent: ComponentType<MessageContentProps>;
  ChatFileChangeList: ComponentType<ChatFileChangeListProps>;
};

export function AgentJobThreadPreviewLayout({
  message,
  projectId,
  branchThreads,
  hideThreadSpine = false,
  showHeaderAvatar,
  assistantAvatarMotion,
  showHeaderIdentity = true,
  hiddenUpdateCount,
  runStatusShownInEntryHeader = false,
  isHybridCompactionActive,
  isThreadPreviewExpanded,
  visibleCompactEvents,
  overflowCompactCount,
  overflowCompactEvents = [],
  latestCompactEventId,
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
  hasPreview,
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
  latestFilesMessageId,
  latestFilesMessageTimestamp,
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
  onOpenBranchThread,
  onExpandThreadPreview,
  onCollapseThreadPreview,
  onToggleThreadPreview,
  onToggleCommandOutput,
  onToggleUpdateExpanded,
  onCancelRun,
  onCancelTerminalCommand,
  onMessageContextMenu,
  MessageContent,
  ChatFileChangeList,
}: AgentJobThreadPreviewLayoutProps) {
  const metadata = isRecord(message.metadata) ? message.metadata : null;
  const agentMetadata = metadata && isRecord(metadata.agent) ? metadata.agent : null;
  const jobId = extractAgentJobId(message);
  const [jobCancelPending, setJobCancelPending] = useState(false);
  const cancelRunPending = cancelPending || jobCancelPending;
  const copyLatestCommandOutput = useCopyCommandOutput(latestCommandExecution?.output ?? "");
  const handleCancelRun = useCallback(() => {
    if (!isCancelableAgentJobId(jobId)) {
      onCancelRun();
      return;
    }
    if (jobCancelPending) {
      return;
    }
    setJobCancelPending(true);
    void (async () => {
      try {
        let result: Awaited<ReturnType<typeof cancelAgentJob>> = null;
        try {
          result = await cancelAgentJob(jobId, "Agent job cancelled by user");
        } catch (error) {
          console.warn("[chat] failed to cancel agent job", error);
        }
        const canceledAnything =
          result !== null &&
          (result.canceledJobIds.length > 0 || result.canceledRunIds.length > 0);
        if (!canceledAnything) {
          // The per-job cancel failed, was unavailable, or matched nothing;
          // fall back to the conversation interrupt so the run does not stay
          // uncancelable.
          onCancelRun();
        }
      } finally {
        setJobCancelPending(false);
      }
    })();
  }, [jobCancelPending, jobId, onCancelRun]);
  const headerIdentityVisible = showHeaderIdentity && showHeaderAvatar;
  const ownerBadge = showHeaderIdentity ? normalizeAgentHandle(agentMetadata?.handle) : null;
  const latestCommandOwnerBadge = normalizeAgentHandle(latestCommandAgentHandle) ?? ownerBadge;
  const shouldCollapseSingleCompactEvent =
    singleCompactEvent !== null &&
    visibleCompactEvents.length === 1 &&
    overflowCompactCount === 0 &&
    !showCompactRailWaitingSpinner;
  const singleCompactEventIsCommand = singleCompactEvent?.kind === "command";
  // The in-flight pill sits at the rail's newest end; before any update chips
  // exist it reads as the run starting, afterwards as work continuing (#176).
  const compactRailInFlightLabel =
    visibleCompactEvents.length === 0 && overflowCompactCount === 0
      ? "Starting run"
      : "Run in progress";
  const terminalStatusMarker = resolveTerminalStatusMarker(finalSpineTone, isCompleted);
  const hasCompactRailVisualContent =
    showCompactRailWaitingSpinner || visibleCompactEvents.length > 0 || overflowCompactCount > 0;
  const terminalStatusDominatesCompactRail = terminalStatusMarker !== null && !isThreadPreviewExpanded;
  const finalSummaryContent = finalSummaryMessage?.content.trim() ?? "";
  const formattedFinalSummaryContent =
    formatProxyUpstreamErrorSummary(finalSummaryContent) ?? finalSummaryContent;
  const formattedFinalSummaryLower = formattedFinalSummaryContent.toLowerCase();
  const finalSummaryLooksLikeProxyError =
    formattedFinalSummaryLower.includes("rejected the ai request") ||
    formattedFinalSummaryLower.includes("retry later or switch credentials") ||
    formattedFinalSummaryLower.includes("credentials need reconnecting") ||
    formattedFinalSummaryLower.includes("quota");
  const finalSummaryDirectProxyGuidance = resolveProxyUpstreamErrorGuidance(finalSummaryContent);
  const proxyGuidanceContentFromUpdates = finalSummaryLooksLikeProxyError
    ? [...updatesForInlineRendering].reverse().map(resolveProxyGuidanceContent).find(Boolean) ?? null
    : null;
  const inheritedProxyGuidanceContent =
    proxyGuidanceContentFromUpdates ?? (finalSummaryDirectProxyGuidance ? finalSummaryContent : null);
  const finalSummaryDisplayContent = inheritedProxyGuidanceContent
    ? (formatProxyUpstreamErrorSummary(inheritedProxyGuidanceContent) ?? inheritedProxyGuidanceContent)
    : formattedFinalSummaryContent;
  const finalSummaryLower = finalSummaryDisplayContent.toLowerCase();
  const finalSummaryCoversProxyError =
    finalSummaryDirectProxyGuidance !== null ||
    finalSummaryLooksLikeProxyError ||
    finalSummaryLower.includes("rejected the ai request") ||
    finalSummaryLower.includes("retry later or switch credentials") ||
    finalSummaryLower.includes("credentials need reconnecting") ||
    finalSummaryLower.includes("quota");
  // Failed runs render a short friendly sentence instead of the raw technical
  // failure body; the raw text stays available behind the Details toggle.
  // Proxy/credential errors keep their existing curated guidance.
  const runFailurePresentation =
    isCompleted &&
    finalSpineTone === "danger" &&
    finalSummaryMessage !== null &&
    !finalSummaryCoversProxyError
      ? resolveRunFailurePresentation({
          metadata: finalSummaryMessage.metadata,
          content: finalSummaryDisplayContent,
          assumeFailed: true,
        })
      : null;
  const visibleInlineUpdateKeys = new Set<string>();
  const visibleInlineUpdates = updatesForInlineRendering.filter((update) => {
    const updateType = (getMessageType(update) ?? "").trim().toLowerCase();
    const isActivityUpdate = updateType === "reasoning" || updateType === "status";
    const rawContent = isActivityUpdate ? normalizeActivityText(update.content) : update.content.trim();
    const retryingPresentation = isActivityUpdate
      ? resolveRetryingStatusPresentation({ metadata: update.metadata, content: rawContent })
      : null;
    const content =
      retryingPresentation?.displayText ?? formatProxyUpstreamErrorSummary(rawContent) ?? rawContent;

    if (content && finalSummaryDisplayContent && content === finalSummaryDisplayContent) {
      return false;
    }

    if (
      terminalStatusMarker !== null &&
      finalSummaryMessage !== null &&
      finalSummaryCoversProxyError &&
      resolveProxyUpstreamErrorGuidance(rawContent) !== null
    ) {
      return false;
    }

    const dedupeKey = normalizeInlineUpdateDedupeKey(content, updateType);
    if (dedupeKey && visibleInlineUpdateKeys.has(dedupeKey)) {
      return false;
    }
    if (dedupeKey) {
      visibleInlineUpdateKeys.add(dedupeKey);
    }

    return true;
  });
  const hiddenUpdatesAreOnlyCoveredTerminalNoise =
    terminalStatusMarker !== null &&
    finalSummaryMessage !== null &&
    finalSummaryCoversProxyError &&
    visibleInlineUpdates.length === 0;
  const hiddenUpdatesRenderVisibleControls =
    hiddenUpdateCount > 0 &&
    !hiddenUpdatesAreOnlyCoveredTerminalNoise &&
    (!isHybridCompactionActive || isThreadPreviewExpanded);
  const canUseTightCompletedLayoutBase =
    isCompleted &&
    showSummaryBody &&
    !isThreadPreviewExpanded &&
    finalSummaryDisplayContent.length > 0 &&
    (hideThreadSpine || finalSummaryDisplayContent.length <= 420);
  // A successful one-step result collapses the run-activity timeline (spine +
  // compact/expand rail) even when it carries a file-change rail — the rail
  // renders independently below the summary. The terminal/failed variant stays
  // text-only (latestFiles === null) so failures keep their fuller chrome.
  const canUseTightSummaryLayout = canUseTightCompletedLayoutBase && latestFiles === null;
  const useTightCompletedSummaryLayout =
    canUseTightCompletedLayoutBase && terminalStatusMarker === null;
  const useTightTerminalSummaryLayout =
    canUseTightSummaryLayout &&
    terminalStatusMarker !== null &&
    (hiddenUpdateCount === 0 || hiddenUpdatesAreOnlyCoveredTerminalNoise) &&
    visibleInlineUpdates.length === 0 &&
    branchThreads.length === 0 &&
    !showLiveCommandOutput &&
    !showLiveCommandPlaceholder &&
    !showCollapsedCommandToggle &&
    !showCollapsedCommandOutput &&
    !showCollapsedCompactRailStatus;
  const useTightThreadPreviewLayout =
    useTightCompletedSummaryLayout || useTightTerminalSummaryLayout;
  const showCompactIconRail =
    !useTightThreadPreviewLayout &&
    !terminalStatusDominatesCompactRail &&
    hasCompactRailVisualContent;
  const hasThreadPreviewHeaderContent = headerIdentityVisible || Boolean(ownerBadge);
  const showThreadPreviewHeader = useTightTerminalSummaryLayout
    ? false
    : headerIdentityVisible || (!useTightCompletedSummaryLayout && hasThreadPreviewHeaderContent);
  const showThreadPreviewSpine = !hideThreadSpine && !useTightThreadPreviewLayout;
  // Run status reads exactly once, at header level: the preview's own header
  // row when it renders, else the outer row's speaker header when that
  // carries it; the content-level caption is the fallback for headerless
  // continuation entries (#145).
  const showTerminalStatusInHeader = terminalStatusMarker !== null && showThreadPreviewHeader;
  const showTerminalStatusCaption =
    terminalStatusMarker !== null && !showTerminalStatusInHeader && !runStatusShownInEntryHeader;
  const terminalStatusTextClassName =
    finalSpineTone === "danger"
      ? "text-rose-700 dark:text-rose-200"
      : "text-secondary-800 dark:text-secondary-100";
  const threadPreviewRailRenderStyle = {
    ...threadPreviewRailStyle,
    top: showThreadPreviewHeader ? threadPreviewRailStyle.top : "0px",
  } as CSSProperties;

  const commandOwnerBadgeElement = latestCommandOwnerBadge ? (
    <span
      data-testid="agent-thread-command-owner"
      className="inline-flex max-w-28 flex-none items-center rounded-full border border-slate-200/70 bg-white/70 px-1.5 py-0.5 text-xxs font-semibold leading-none text-slate-600 dark:border-slate-700/80 dark:bg-slate-900/70 dark:text-slate-300"
      title={latestCommandOwnerBadge}
    >
      {latestCommandOwnerBadge}
    </span>
  ) : null;
  const normalizeThreadPlaceholderText = (value: string) =>
    value
      .trim()
      .toLowerCase()
      .replace(/\.\.\.$/, "")
      .replace(/…$/, "")
      .replace(/[.!]+$/g, "")
      .trim();
  const previewPlaceholderText = normalizeThreadPlaceholderText(previewText);
  const finalSummaryPlaceholderText = normalizeThreadPlaceholderText(finalSummaryDisplayContent);
  const hasUsefulPreviewText =
    showSummaryBody &&
    hasPreview &&
    previewPlaceholderText.length > 0 &&
    previewPlaceholderText !== "thinking" &&
    previewPlaceholderText !== "reasoning";
  const hasUsefulFinalSummary =
    showSummaryBody &&
    finalSummaryMessage !== null &&
    finalSummaryPlaceholderText.length > 0 &&
    finalSummaryPlaceholderText !== "thinking" &&
    finalSummaryPlaceholderText !== "reasoning";
  const singleCompactEventPlaceholderText = normalizeThreadPlaceholderText(singleCompactEventLabel);
  const isStaleReasoningOnlyPreview =
    !isRunning &&
    !isThreadUnresolved &&
    !shouldAnimateThreadLiveState &&
    terminalStatusMarker === null &&
    !showLiveCommandOutput &&
    !showLiveCommandPlaceholder &&
    !showCollapsedCommandToggle &&
    !showCollapsedCommandOutput &&
    !showCollapsedCompactRailStatus &&
    !hasUsefulPreviewText &&
    !hasUsefulFinalSummary &&
    (!latestFiles || latestFiles.length === 0) &&
    !hiddenUpdatesRenderVisibleControls &&
    visibleInlineUpdates.length === 0 &&
    overflowCompactCount === 0 &&
    visibleCompactEvents.length === 1 &&
    visibleCompactEvents[0]?.kind === "thinking" &&
    singleCompactEventPlaceholderText === "reasoning";
  const isCompletedChromeOnlyPreview =
    !isRunning &&
    !isThreadUnresolved &&
    !shouldAnimateThreadLiveState &&
    terminalStatusMarker === null &&
    !showLiveCommandOutput &&
    !showLiveCommandPlaceholder &&
    !showCollapsedCommandToggle &&
    !showCollapsedCommandOutput &&
    !showCollapsedCompactRailStatus &&
    !hasUsefulPreviewText &&
    !hasUsefulFinalSummary &&
    (!latestFiles || latestFiles.length === 0) &&
    !hiddenUpdatesRenderVisibleControls &&
    visibleInlineUpdates.length === 0 &&
    overflowCompactCount === 0 &&
    visibleCompactEvents.length === 0 &&
    branchThreads.length === 0 &&
    !showCompactRailWaitingSpinner;

  const showSingleCompactEventRow =
    !useTightThreadPreviewLayout &&
    !terminalStatusDominatesCompactRail &&
    shouldCollapseSingleCompactEvent &&
    singleCompactEvent !== null;
  // A command-kind single-update run renders as the command surface: the
  // mono header row that IS the command, growing into a panel with the output
  // body. Whenever that surface renders at all — collapsed or expanded — it is
  // the only place the command and its output appear, so the legacy pieces
  // (output toggle row, framed CommandOutputBlock, running placeholder) are
  // suppressed. Founder feedback on the nested version: "why is there even a
  // view and hide button within there". The icon-rail (multi-update) path and
  // non-command runs keep those pieces untouched.
  const commandPanelActive = showSingleCompactEventRow && singleCompactEventIsCommand;
  // Streaming rule: the panel is the only place live output shows, so a
  // running command must not hide it behind a click. While the single command
  // is running the panel renders expanded unless the user explicitly collapsed
  // it during THIS run:
  //   effectivePanelExpanded = isThreadPreviewExpanded || (commandIsRunning && !userCollapsedThisRun)
  // The override is local, keyed by the job/run id, and released when the run
  // id changes or the run finishes, so a completed run returns to the parent's
  // isThreadPreviewExpanded semantics.
  const commandIsRunning =
    commandPanelActive &&
    (showLiveCommandOutput || (showLiveCommandPlaceholder && !isHybridCompactionActive));
  const commandRunKey = jobId ?? message.id;
  const [userCollapsedCommandRunKey, setUserCollapsedCommandRunKey] = useState<string | null>(null);
  useEffect(() => {
    setUserCollapsedCommandRunKey(null);
  }, [commandRunKey]);
  useEffect(() => {
    if (!commandIsRunning) {
      setUserCollapsedCommandRunKey(null);
    }
  }, [commandIsRunning]);
  const userCollapsedThisRun = userCollapsedCommandRunKey === commandRunKey;
  const effectivePanelExpanded =
    isThreadPreviewExpanded || (commandIsRunning && !userCollapsedThisRun);
  // The chevron (and the header text) still drive the parent's toggle. The one
  // exception is collapsing an auto-expanded panel: the parent already holds
  // "collapsed", so only the local override changes — toggling the parent
  // there would flip it to expanded and the collapse would never stick.
  const handleToggleCommandPanel = () => {
    if (commandIsRunning && effectivePanelExpanded) {
      setUserCollapsedCommandRunKey(commandRunKey);
      if (!isThreadPreviewExpanded) {
        return;
      }
    }
    onToggleThreadPreview();
  };

  if (isStaleReasoningOnlyPreview || isCompletedChromeOnlyPreview) {
    return null;
  }

  const renderThreadPreviewNotch = (offsetPx = THREAD_SPINE_DEFAULT_NOTCH_OFFSET_PX) =>
    hideThreadSpine || useTightThreadPreviewLayout ? null : (
      <ThreadSpine
        tone={finalSpineTone}
        className={`pointer-events-none absolute top-0 h-full ${threadSpineJunctionOffsetClass}`}
        notches={[{ offsetPx, maskLine: true }]}
      />
    );

  // The command surface has exactly two states. Collapsed: the mono header
  // row (plus, once finished, a short muted result hint). Expanded: the same
  // surface grows into a panel — header, hairline divider, then the output
  // body itself (or one status line when there is none), followed by any
  // inline updates and child threads. No toggle row and no nested output
  // card: the header already IS the command.
  const commandPanelExpanded = commandPanelActive && effectivePanelExpanded;
  const commandPanelCollapsed = commandPanelActive && !effectivePanelExpanded;
  const rawLatestCommand = latestCommandExecution?.command?.trim() || null;
  const singleCompactEventDisplayLabel = singleCompactEventIsCommand
    ? stripShellWrapperFromCommand(singleCompactEventLabel)
    : singleCompactEventLabel;
  const latestCommandStatus = latestCommandExecution?.status?.trim().toLowerCase() ?? "";
  const latestCommandIsRunning = isRunning || COMMAND_RUNNING_STATUSES.has(latestCommandStatus);
  const commandResultPreview = summarizeCommandExecutionResultForPreview(
    latestCommandExecution?.output ?? null,
    160,
  );
  const collapsedCommandResultHint =
    commandPanelCollapsed &&
    !latestCommandIsRunning &&
    commandResultPreview &&
    commandResultPreview.length <= COMMAND_RESULT_HINT_MAX_CHARS
      ? commandResultPreview
      : null;
  // Inside the panel the output body replaces the live block, the running
  // placeholder and the output toggle; when nothing has been printed a single
  // status line stands in for it.
  const showCommandPanelOutputBody =
    commandPanelExpanded &&
    Boolean(latestCommandExecution?.output) &&
    (showLiveCommandOutput || (showCollapsedCommandToggle && !isHybridCompactionActive));
  const showCommandPanelStatusLine =
    commandPanelExpanded &&
    !showCommandPanelOutputBody &&
    latestCommandExecution !== null &&
    !isHybridCompactionActive;
  // The copy glyph and the output body share one predicate: copy never sits
  // above a status line or above nothing.
  const showCommandPanelCopy = showCommandPanelOutputBody;
  const collapsedCommandToggleLabel = showCollapsedCommandOutput
    ? "Hide command output"
    : truncate(stripShellWrapperFromCommand(latestCommandPreview) || "Show command output", 130);

  // Run detail sections sit beside the spine with their own notch when they
  // stack under a plain row; inside the command panel they lose the notch and
  // pick up a hairline divider instead, so the spine stays outside the box.
  const runDetailSectionClass = commandPanelExpanded
    ? `relative ${COMMAND_SURFACE_DIVIDER_CLASS} px-2.5 py-1.5`
    : "relative py-1";
  const runDetailGroupSectionClass = `group ${runDetailSectionClass}`;
  const renderRunDetailSectionNotch = (): ReactNode =>
    commandPanelExpanded ? null : renderThreadPreviewNotch();

  const runDetailSections = (
    <>
      {!useTightThreadPreviewLayout && showCollapsedCompactRailStatus ? (
        <div className={runDetailSectionClass}>
          {renderRunDetailSectionNotch()}
          <Text
            as="div"
            variant="caption"
            tone="muted"
            className="flex min-w-0 items-center gap-1.5 pl-1 text-xs"
          >
            {commandOwnerBadgeElement}
            <span
              className={`${shouldSweepCompactRailStatusText ? "instafy-status-sweep" : ""} min-w-0 truncate`}
              data-sweep-text={compactRailStatusText}
            >
              {compactRailStatusText}
            </span>
            {canCancelTerminalRun ? (
              <IconButton
                aria-label="Stop run"
                variant="ghost"
                size="xs"
                radius="full"
                onPress={handleCancelRun}
                isDisabled={cancelRunPending}
                data-testid="chat-command-stop-button"
                className="ml-1 text-rose-500 hover:text-rose-600 dark:text-rose-300 dark:hover:text-rose-200"
              >
                <Xmark aria-hidden="true" className="h-3.5 w-3.5" />
              </IconButton>
            ) : null}
          </Text>
        </div>
      ) : null}

      {showCommandPanelOutputBody ? (
        <div className={runDetailSectionClass} data-testid="agent-thread-command-panel-body">
          {/* The panel's own body: output only. The header names the command,
              the trailing cluster carries copy; nothing is restated here. The
              block is keyed by the run and told the command so its "Show all"
              resets for a later command instead of arriving pre-expanded. */}
          <CommandOutputBlock
            key={commandRunKey}
            command={latestCommandExecution?.command ?? null}
            output={latestCommandExecution?.output ?? ""}
            status={latestCommandExecution?.status ?? null}
            bodyOnly
          />
        </div>
      ) : null}

      {showCommandPanelStatusLine ? (
        <div className={runDetailSectionClass} data-testid="agent-thread-command-panel-status">
          <Text
            as="div"
            variant="caption"
            tone="muted"
            className={`min-w-0 truncate text-xs ${
              latestCommandIsRunning && shouldAnimateThreadLiveState ? "instafy-status-sweep" : ""
            }`}
            data-sweep-text={resolveCommandResultStatusLabel(latestCommandExecution?.status)}
          >
            {resolveCommandResultStatusLabel(latestCommandExecution?.status)}
          </Text>
        </div>
      ) : null}

      {showLiveCommandOutput && !commandPanelActive ? (
        <div className={runDetailSectionClass}>
          {renderRunDetailSectionNotch()}
          <div className="min-w-0">
            <CommandOutputBlock
              command={latestCommandExecution?.command ?? null}
              output={latestCommandExecution?.output ?? ""}
              status={latestCommandExecution?.status ?? null}
              compact
              onCancel={onCancelTerminalCommand ?? null}
            />
          </div>
        </div>
      ) : null}

      {showLiveCommandPlaceholder && !isHybridCompactionActive && !commandPanelActive ? (
        <div className={runDetailSectionClass}>
          {renderRunDetailSectionNotch()}
          <Text
            as="div"
            variant="caption"
            tone="muted"
            className="flex min-w-0 items-center gap-1.5 text-xs"
          >
            <Terminal aria-hidden="true" className="h-3.5 w-3.5 text-slate-500 dark:text-slate-300" />
            {commandOwnerBadgeElement}
            <span
              className={`${shouldAnimateThreadLiveState ? "instafy-status-sweep" : ""} min-w-0 truncate`}
              data-sweep-text={latestCommandExecution?.command ?? "Running command…"}
            >
              {summarizeActiveCommandForPreview(latestCommandExecution?.command ?? "", 120) || "Running command…"}
            </span>
            {canCancelTerminalRun ? (
              <IconButton
                aria-label="Stop run"
                variant="ghost"
                size="xs"
                radius="full"
                onPress={handleCancelRun}
                isDisabled={cancelRunPending}
                data-testid="chat-command-stop-button"
                className="ml-1 text-rose-500 hover:text-rose-600 dark:text-rose-300 dark:hover:text-rose-200"
              >
                <Xmark aria-hidden="true" className="h-3.5 w-3.5" />
              </IconButton>
            ) : null}
          </Text>
        </div>
      ) : null}

      {showCollapsedCommandToggle && !isHybridCompactionActive && !commandPanelActive ? (
        <div className={runDetailSectionClass}>
          {renderRunDetailSectionNotch()}
          <div className="min-w-0">
            {/* Under an icon rail (multi-update runs) the toggle row names the
                command, shell wrapper stripped, and reveals the framed output
                block. The command surface never renders this row, collapsed
                or expanded. */}
            <button
              type="button"
              onClick={onToggleCommandOutput}
              data-testid="agent-thread-command-output-toggle"
              className="group flex min-w-0 w-full items-center justify-between gap-2 rounded-lg py-0.5 pr-1.5 text-left text-xs text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-100"
              title={rawLatestCommand ?? undefined}
            >
              <span className="inline-flex min-w-0 items-center gap-1.5">
                <Terminal aria-hidden="true" className="h-3.5 w-3.5 flex-shrink-0" />
                <span className="min-w-0 truncate">{collapsedCommandToggleLabel}</span>
              </span>
              <span className="inline-flex flex-shrink-0 items-center gap-1">
                <Eye aria-hidden="true" className="h-3 w-3" />
                {showCollapsedCommandOutput ? "Hide" : "View"}
              </span>
            </button>
            {showCollapsedCommandOutput ? (
              <div className="mt-2">
                <CommandOutputBlock
                  command={latestCommandExecution?.command ?? null}
                  output={latestCommandExecution?.output ?? ""}
                  status={latestCommandExecution?.status ?? null}
                  compact
                  onCancel={onCancelTerminalCommand ?? null}
                />
              </div>
            ) : null}
          </div>
        </div>
      ) : null}

      {visibleInlineUpdates.map((update) => {
        const updateType = (getMessageType(update) ?? "").trim().toLowerCase();
        const isActivityUpdate = updateType === "reasoning" || updateType === "status";
        const rawContent = isActivityUpdate ? normalizeActivityText(update.content) : update.content.trim();
        const retryingPresentation = isActivityUpdate
          ? resolveRetryingStatusPresentation({ metadata: update.metadata, content: rawContent })
          : null;
        const content =
          retryingPresentation?.displayText ?? formatProxyUpstreamErrorSummary(rawContent) ?? rawContent;
        const updateTitle = retryingPresentation?.fullText ?? content;
        const expanded = Boolean(expandedUpdateIds[update.id]);
        const updateDetails = extractMessageDetails(update.metadata);

        if (updateType === "integration_request") {
          return (
            <div key={update.id} className={runDetailSectionClass}>
              {renderRunDetailSectionNotch()}
              <div className="min-w-0">
                <IntegrationRequestEntry
                  message={update}
                  projectId={projectId ?? null}
                  details={updateDetails}
                />
              </div>
            </div>
          );
        }

        if (updateType === "secret_request") {
          return (
            <div key={update.id} className={runDetailSectionClass}>
              {renderRunDetailSectionNotch()}
              <div className="min-w-0">
                <SecretRequestEntry
                  message={update}
                  projectId={projectId ?? null}
                  details={updateDetails}
                />
              </div>
            </div>
          );
        }

        if (updateType === "action_request") {
          return (
            <div key={update.id} className={runDetailSectionClass}>
              {renderRunDetailSectionNotch()}
              <div className="min-w-0">
                <ActionRequestEntry message={update} details={updateDetails} />
              </div>
            </div>
          );
        }

        if (updateType === "multi_agent_plan") {
          return (
            <div key={update.id} className={runDetailSectionClass}>
              {renderRunDetailSectionNotch()}
              <div className="min-w-0 max-w-full overflow-hidden">
                {content ? (
                  <MessageContent
                    content={content}
                    projectId={projectId ?? null}
                  />
                ) : null}
                <MultiAgentPlanEntry details={updateDetails} />
              </div>
            </div>
          );
        }

        const todoItems = updateType === "todo_list" ? parseTodoItems(updateDetails) : [];
        const isCompactionUpdate =
          (updateType === "reasoning" || updateType === "status") && isCompactionStatusText(content);
        const isLocalCapabilityActivity =
          updateType === "local_capability_result" || shouldRenderLocalCapabilityStatusAsTimeline(update);
        const updateIcon =
          updateType === "todo_list" ? (
            <ClipboardCheck
              className="mt-[1px] h-3 w-3 flex-shrink-0 text-slate-400 dark:text-slate-500"
              aria-hidden="true"
            />
          ) : isCompactionUpdate ? (
            <CompressLines
              className="mt-[1px] h-3 w-3 flex-shrink-0 text-slate-400 dark:text-slate-500"
              aria-hidden="true"
            />
          ) : isLocalCapabilityActivity ? (
            <Globe
              className="mt-[1px] h-3 w-3 flex-shrink-0 text-slate-400 dark:text-slate-500"
              aria-hidden="true"
            />
          ) : isActivityUpdate ? (
            <Activity
              className="mt-[1px] h-3 w-3 flex-shrink-0 text-slate-400 dark:text-slate-500"
              aria-hidden="true"
            />
          ) : null;
        const canExpand =
          content.length > 240 ||
          content.includes("\n") ||
          (update.metadata && JSON.stringify(update.metadata).length > 300);
        const previewSource =
          isCompactionUpdate
            ? COMPACTION_STATUS_LABEL
            : updateType === "file_change"
              ? stripWorkspacePrefixForPreview(content)
              : content;
        const previewLine = truncate(previewSource.replace(/\s+/g, " "), 200);
        const activityPreviewParts = isActivityUpdate
          ? splitActivityLeadAndDetails(previewLine)
          : null;

        return (
          <div key={update.id} className={runDetailGroupSectionClass}>
            {renderRunDetailSectionNotch()}
            <div className="min-w-0">
              <div
                data-testid="agent-thread-inline-update-row"
                className="flex min-w-0 items-center justify-between gap-2 rounded-lg pr-1"
              >
                {canExpand ? (
                  <button
                    type="button"
                    onClick={() => onToggleUpdateExpanded(update.id)}
                    className="min-w-0 flex-1 truncate text-left text-xs text-slate-600 hover:text-slate-800 dark:text-slate-300 dark:hover:text-slate-100"
                    title={updateTitle}
                  >
                    <span className="flex min-w-0 items-start gap-2">
                      {updateIcon}
                      {activityPreviewParts ? (
                        <span className="min-w-0 truncate">
                          <span className="font-medium text-slate-700 dark:text-slate-100">
                            {activityPreviewParts.lead}
                          </span>
                          {activityPreviewParts.details ? (
                            <span className="text-slate-600 dark:text-slate-300">
                              {" "}
                              {activityPreviewParts.details}
                            </span>
                          ) : null}
                        </span>
                      ) : (
                        <span className="min-w-0 truncate">{previewLine}</span>
                      )}
                    </span>
                  </button>
                ) : (
                  <div
                    className="min-w-0 flex-1 truncate text-xs text-slate-600 dark:text-slate-300"
                    title={updateTitle}
                  >
                    <span className="flex min-w-0 items-start gap-2">
                      {updateIcon}
                      {activityPreviewParts ? (
                        <span className="min-w-0 truncate">
                          <span className="font-medium text-slate-700 dark:text-slate-100">
                            {activityPreviewParts.lead}
                          </span>
                          {activityPreviewParts.details ? (
                            <span className="text-slate-600 dark:text-slate-300">
                              {" "}
                              {activityPreviewParts.details}
                            </span>
                          ) : null}
                        </span>
                      ) : (
                        <span className="min-w-0 truncate">{previewLine}</span>
                      )}
                    </span>
                  </div>
                )}

                {canExpand ? (
                  <IconButton
                    aria-label={expanded ? "Collapse update" : "Expand update"}
                    variant="ghost"
                    size="xs"
                    radius="full"
                    onPress={() => onToggleUpdateExpanded(update.id)}
                    className={`transition-opacity ${
                      expanded
                        ? "opacity-100"
                        : "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 data-[focus-visible]:opacity-100"
                    }`}
                  >
                    <NavArrowRight
                      className={`h-3 w-3 transition-transform ${
                        expanded ? "rotate-90 text-slate-600 dark:text-slate-200" : "text-slate-400"
                      }`}
                      aria-hidden="true"
                    />
                  </IconButton>
                ) : null}
              </div>

              {expanded ? (
                <div className="mt-2 rounded-xl bg-white/60 p-2 text-sm text-slate-700 dark:bg-slate-950/40 dark:text-slate-200">
                  {isActivityUpdate ? (
                    <p className="whitespace-pre-wrap break-words text-sm">{content}</p>
                  ) : (
                    <MessageContent content={content} projectId={projectId ?? null} />
                  )}
                  {todoItems.length > 0 ? (
                    <ul className="mt-2 space-y-1 text-xs">
                      {todoItems.map((item, itemIndex) => (
                        <li key={`${item.text}-${itemIndex}`} className="flex items-start gap-2">
                          <span
                            className={`mt-1 inline-flex h-2 w-2 flex-shrink-0 rounded-full ${
                              item.completed ? "bg-primary-500" : "bg-slate-300 dark:bg-slate-700"
                            }`}
                            aria-hidden="true"
                          />
                          <span
                            className={
                              item.completed
                                ? "line-through text-slate-400 dark:text-slate-500"
                                : "text-slate-600 dark:text-slate-200"
                            }
                          >
                            {item.text}
                          </span>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              ) : null}
            </div>
          </div>
        );
      })}

      {isThreadPreviewExpanded && branchThreads.length > 0 ? (
        <div className={runDetailSectionClass}>
          {renderRunDetailSectionNotch()}
          <div className="space-y-1.5">
            {branchThreads.map((branch) => (
              <AgentThreadBranchRowEntry
                key={branch.threadLocalId}
                branch={branch}
                onOpen={onOpenBranchThread}
              />
            ))}
          </div>
        </div>
      ) : null}
    </>
  );

  return (
    <div
      ref={threadPreviewRootRef}
      data-chat-message-id={message.id}
      data-testid="chat-bubble-assistant"
      data-message-type="agent_job_thread"
      className="w-full min-w-0 max-w-2xl overflow-hidden text-sm text-slate-700 dark:text-slate-200"
      style={threadPreviewRootStyle}
      onContextMenu={
        onMessageContextMenu
          ? (event) => onMessageContextMenu(event, message.id)
          : undefined
      }
    >
      <div data-testid="agent-job-thread-preview" ref={threadPreviewRef} className="relative flex flex-col">
        {showThreadPreviewSpine ? (
          <ThreadSpine
            tone={finalSpineTone}
            className={`pointer-events-none absolute top-0 ${threadSpineJunctionOffsetClass}`}
            style={threadPreviewRailRenderStyle}
          />
        ) : null}
        {showThreadPreviewHeader ? (
          <div className="relative h-8" data-testid="agent-thread-preview-header">
            <div className={`absolute ${threadSpineHeaderOffsetClass} top-0 flex items-center gap-1`}>
              {headerIdentityVisible ? (
                <span
                  className="relative z-10 inline-flex h-8 w-8 items-center justify-center"
                  data-testid="agent-job-thread-avatar"
                >
                  <ChatMessageAvatar
                    kind="assistant"
                    metadata={message.metadata ?? null}
                    motion={assistantAvatarMotion}
                  />
                </span>
              ) : (
                <span aria-hidden="true" className="h-8 w-8 shrink-0 pointer-events-none" />
              )}
              {ownerBadge ? (
                <span
                  data-testid="agent-thread-owner-badge"
                  className="inline-flex max-w-28 items-center text-xxs font-medium leading-none text-slate-500 dark:text-slate-400"
                  title={ownerBadge}
                >
                  <span className="truncate">{ownerBadge}</span>
                </span>
              ) : null}
              {showTerminalStatusInHeader && terminalStatusMarker ? (
                <span
                  data-testid="agent-thread-terminal-status"
                  className={`inline-flex min-w-0 items-center gap-1 text-xxs font-semibold leading-none ${terminalStatusTextClassName}`}
                >
                  <WarningTriangle
                    aria-hidden="true"
                    className={`h-3 w-3 flex-none ${terminalStatusMarker.iconClassName}`}
                  />
                  <span className="min-w-0 truncate">{terminalStatusMarker.label}</span>
                </span>
              ) : null}
            </div>
          </div>
        ) : null}
        {hiddenUpdateCount > 0 &&
        !hiddenUpdatesAreOnlyCoveredTerminalNoise &&
        !isHybridCompactionActive &&
        !isThreadPreviewExpanded ? (
          <div className="relative py-1">
            {renderThreadPreviewNotch()}
            <button
              type="button"
              onClick={onExpandThreadPreview}
              className="group flex min-w-0 items-center justify-between gap-2 rounded-lg py-0.5 pr-1.5 text-left text-xs text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-100"
            >
              <span className="min-w-0 truncate">
                … {hiddenUpdateCount} earlier update{hiddenUpdateCount === 1 ? "" : "s"}
              </span>
              <NavArrowRight
                aria-hidden="true"
                className="h-3 w-3 opacity-0 transition-opacity group-hover:opacity-90 group-focus-within:opacity-90"
              />
            </button>
          </div>
        ) : null}

        {isThreadPreviewExpanded && hiddenUpdateCount > 0 && !hiddenUpdatesAreOnlyCoveredTerminalNoise ? (
          <div className="relative py-1">
            {renderThreadPreviewNotch()}
            <button
              type="button"
              onClick={onCollapseThreadPreview}
              className="group flex min-w-0 items-center justify-between gap-2 rounded-lg py-0.5 pr-1.5 text-left text-xs text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-100"
            >
              <span className="min-w-0 truncate">Collapse updates</span>
              <NavArrowDown
                aria-hidden="true"
                className="h-3 w-3 opacity-70 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
              />
            </button>
          </div>
        ) : null}

        {showCompactIconRail && !shouldCollapseSingleCompactEvent ? (
          <div className="group relative py-1">
            {renderThreadPreviewNotch(THREAD_SPINE_COMPACT_NOTCH_OFFSET_PX)}
            <div className="flex min-w-0 w-full items-center gap-2 rounded-lg py-0.5 pr-1">
              {/* Chip buttons are the keyboard path into the rail; the row
                  itself stays a mouse-only convenience target for the same
                  toggle. Chip clicks bubble here, so the chips carry no
                  onClick of their own. */}
              <div
                onClick={onToggleThreadPreview}
                className="flex min-w-0 flex-1 cursor-pointer items-center rounded-lg py-0.5 text-left"
                data-testid="agent-thread-compact-rail"
              >
                <div className="flex min-w-0 flex-1 justify-start overflow-visible">
                  {/* The rail reads oldest → newest, left → right: the dashed
                      "earlier updates" pill anchors the old end and any live
                      indicator anchors the new end, so a glance always tells
                      which chip is current (#176). */}
                  <div className="flex shrink-0 items-center -space-x-2 pl-0.5 py-0.5">
                    {overflowCompactCount > 0 ? (
                      <ThreadRailChipButton
                        card={
                          overflowCompactEvents.length > 0
                            ? {
                                header: formatHiddenUpdateLabel(overflowCompactCount, "earlier run update"),
                                bodyLines: overflowCompactEvents.map((event) =>
                                  resolveCompactEventLabel(event, ownerBadge, false),
                                ),
                              }
                            : null
                        }
                        ariaLabel={formatHiddenUpdateLabel(overflowCompactCount, "earlier run update")}
                        className={`instafy-compact-overflow-indicator relative inline-flex h-6 w-6 items-center justify-center rounded-full border border-dashed border-slate-200 bg-white text-slate-400 shadow-sm dark:border-slate-700 dark:bg-slate-900 dark:text-slate-500 ${COMPACT_EVENT_PILL_FOCUS_CLASS}`}
                        dataCount={String(overflowCompactCount)}
                        style={{ animationDelay: "0ms" }}
                      >
                        <Activity aria-hidden="true" className="h-3 w-3" />
                      </ThreadRailChipButton>
                    ) : null}
                    {visibleCompactEvents.map((event, index) => {
                      const badgeLabel = resolveCompactEventLabel(event, ownerBadge, isThreadUnresolved);
                      // While a command is in flight the trailing spinner pill
                      // is the single live indicator; otherwise the newest chip
                      // carries the subtle running ring.
                      const isLiveEventPill =
                        isThreadUnresolved &&
                        !showCompactRailWaitingSpinner &&
                        latestCompactEventId === event.id;
                      return (
                        <ThreadRailChipButton
                          key={`compact-event-${event.id}`}
                          card={resolveCompactEventHoverCard(event)}
                          ariaLabel={badgeLabel}
                          title={badgeLabel}
                          className={`instafy-compact-event-pill ${
                            isLiveEventPill ? "instafy-compact-event-pill-live" : ""
                          } inline-flex h-6 w-6 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-500 shadow-sm dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300 ${COMPACT_EVENT_PILL_FOCUS_CLASS}`}
                          style={{ animationDelay: `${Math.min(index + (overflowCompactCount > 0 ? 1 : 0), 16) * 36}ms` }}
                        >
                          {renderCompactEventContent(event, ownerBadge)}
                        </ThreadRailChipButton>
                      );
                    })}
                    {showCompactRailWaitingSpinner ? (
                      <span
                        className={`instafy-compact-event-pill ${
                          isThreadUnresolved ? "instafy-compact-event-pill-live" : ""
                        } inline-flex h-6 w-6 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-500 shadow-sm dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300`}
                        title={compactRailInFlightLabel}
                        aria-label={compactRailInFlightLabel}
                        style={{
                          animationDelay: `${Math.min(
                            visibleCompactEvents.length + (overflowCompactCount > 0 ? 1 : 0),
                            16,
                          ) * 36}ms`,
                        }}
                      >
                        <Spinner size="xs" tone="slate" className="h-3.5 w-3.5" />
                      </span>
                    ) : null}
                  </div>
                </div>
              </div>
              <div className="ml-auto flex flex-none items-center gap-1">
                <IconButton
                  aria-label={isThreadPreviewExpanded ? "Collapse run updates" : "Expand run updates"}
                  variant="ghost"
                  size="xs"
                  radius="full"
                  onPress={onToggleThreadPreview}
                  className={`text-slate-400 hover:text-slate-700 dark:text-slate-500 dark:hover:text-slate-200 ${
                    isThreadPreviewExpanded
                      ? "opacity-100"
                      : "opacity-0 group-hover:opacity-90 group-focus-within:opacity-90"
                  }`}
                >
                  {isThreadPreviewExpanded ? (
                    <NavArrowDown aria-hidden="true" className="h-3.5 w-3.5" />
                  ) : (
                    <NavArrowRight aria-hidden="true" className="h-3.5 w-3.5" />
                  )}
                </IconButton>
              </div>
            </div>
          </div>
        ) : null}

        {showSingleCompactEventRow && singleCompactEvent ? (
          <div className="group relative py-1">
            {renderThreadPreviewNotch(THREAD_SPINE_COMPACT_NOTCH_OFFSET_PX)}
            {/* A command row is one visual family with the command output it
                stands for (#191): monospace on the code-block surface (same
                radius and ring tokens, subtler fill). Collapsed it is a single
                pill; expanded the same surface grows into a panel that holds
                the run detail sections under a hairline divider, so nothing
                the expansion reveals lands outside the box. The chevron is an
                unframed ghost glyph — no second surface inside the surface.
                Other update kinds keep the plain row. */}
            <div
              data-testid={singleCompactEventIsCommand ? "agent-thread-command-surface" : undefined}
              data-expanded={singleCompactEventIsCommand ? (commandPanelExpanded ? "true" : "false") : undefined}
              className={singleCompactEventIsCommand ? `min-w-0 w-full ${COMMAND_SURFACE_CLASS}` : "min-w-0 w-full"}
            >
              <div
                data-testid="agent-thread-single-update-row"
                data-update-kind={singleCompactEvent.kind}
                className={`flex min-w-0 w-full items-center gap-2 ${
                  singleCompactEventIsCommand
                    ? `${commandPanelExpanded ? "rounded-t-xl" : "rounded-xl"} py-1 pl-2.5 pr-1 transition-colors hover:bg-slate-950/[0.025] dark:hover:bg-white/[0.03]`
                    : "rounded-lg py-0.5 pr-1"
                }`}
              >
                <button
                  type="button"
                  onClick={singleCompactEventIsCommand ? handleToggleCommandPanel : onToggleThreadPreview}
                  className={`flex min-w-0 flex-1 items-center gap-1.5 rounded-lg py-0.5 text-left text-xs ${
                    singleCompactEventIsCommand
                      ? "font-mono text-slate-700 hover:text-slate-900 dark:text-slate-200 dark:hover:text-slate-50"
                      : "text-slate-500 hover:text-slate-800 dark:text-slate-300 dark:hover:text-slate-100"
                  }`}
                  // On the command surface the text button is named by the
                  // command itself (wrapper stripped; the raw command stays in
                  // the title) so the chevron is the sole "Expand/Collapse run
                  // updates" control.
                  aria-label={
                    singleCompactEventIsCommand && singleCompactEventDisplayLabel
                      ? singleCompactEventDisplayLabel
                      : isThreadPreviewExpanded
                        ? "Collapse run updates"
                        : "Expand run updates"
                  }
                  title={
                    (singleCompactEventIsCommand ? rawLatestCommand : null) ??
                    (singleCompactEventDisplayLabel || resolveThreadCompactUpdateLabel(singleCompactEvent.kind))
                  }
                >
                  <span className="flex-shrink-0 text-slate-500 dark:text-slate-300">
                    {renderThreadCompactEventIcon(singleCompactEvent.kind)}
                  </span>
                  <span
                    className={`${showSingleCompactEventStatusSweep ? "instafy-status-sweep" : ""} min-w-0 truncate`}
                    data-sweep-text={singleCompactEventDisplayLabel}
                  >
                    {singleCompactEventDisplayLabel}
                  </span>
                </button>
                <div className="ml-auto flex min-w-0 flex-none items-center gap-1">
                  {collapsedCommandResultHint ? (
                    <span
                      data-testid="agent-thread-command-result-hint"
                      title={collapsedCommandResultHint}
                      className="hidden max-w-[16rem] truncate font-mono text-xxs text-slate-400 dark:text-slate-500 sm:inline-block"
                    >
                      <span aria-hidden="true">→ </span>
                      {collapsedCommandResultHint}
                    </span>
                  ) : null}
                  {canCancelTerminalRun ? (
                    <IconButton
                      aria-label="Stop run"
                      variant="ghost"
                      size="xs"
                      radius="full"
                      onPress={handleCancelRun}
                      isDisabled={cancelRunPending}
                      data-testid="chat-command-stop-button"
                      className={`text-rose-500 hover:text-rose-600 dark:text-rose-300 dark:hover:text-rose-200 ${
                        singleCompactEventIsCommand ? COMMAND_SURFACE_STOP_BUTTON_CLASS : ""
                      }`}
                    >
                      <Xmark aria-hidden="true" className="h-3.5 w-3.5" />
                    </IconButton>
                  ) : null}
                  {showCommandPanelCopy ? (
                    <IconButton
                      aria-label="Copy output"
                      variant="ghost"
                      size="xs"
                      radius="full"
                      onPress={() => void copyLatestCommandOutput()}
                      data-testid="agent-thread-command-copy-output"
                      className={COMMAND_SURFACE_GLYPH_BUTTON_CLASS}
                    >
                      <Copy aria-hidden="true" className="h-3.5 w-3.5" />
                    </IconButton>
                  ) : null}
                  <IconButton
                    aria-label={
                      (singleCompactEventIsCommand ? effectivePanelExpanded : isThreadPreviewExpanded)
                        ? "Collapse run updates"
                        : "Expand run updates"
                    }
                    variant="ghost"
                    size="xs"
                    radius="full"
                    onPress={singleCompactEventIsCommand ? handleToggleCommandPanel : onToggleThreadPreview}
                    className={
                      singleCompactEventIsCommand
                        ? COMMAND_SURFACE_GLYPH_BUTTON_CLASS
                        : `text-slate-400 hover:text-slate-700 dark:text-slate-500 dark:hover:text-slate-200 ${
                            isThreadPreviewExpanded
                              ? "opacity-100"
                              : "opacity-0 group-hover:opacity-90 group-focus-within:opacity-90"
                          }`
                    }
                  >
                    {(singleCompactEventIsCommand ? effectivePanelExpanded : isThreadPreviewExpanded) ? (
                      <NavArrowDown aria-hidden="true" className="h-3.5 w-3.5" />
                    ) : (
                      <NavArrowRight aria-hidden="true" className="h-3.5 w-3.5" />
                    )}
                  </IconButton>
                </div>
              </div>
              {commandPanelExpanded ? runDetailSections : null}
            </div>
          </div>
        ) : null}

        {commandPanelExpanded ? null : runDetailSections}

        {showSummaryBody && !suppressSummaryRunningStatus ? (
          <div
            className={`relative ${summaryBodyPaddingTopClass} pb-0`}
            data-workflow-spine-notch-anchor={hideThreadSpine ? "true" : undefined}
          >
            {renderThreadPreviewNotch()}
            <div className="min-w-0">
              {isCompleted ? (
                <div
                  className={
                    terminalStatusMarker
                      ? `space-y-1.5 border-l-2 pl-3 ${
                          finalSpineTone === "danger"
                            ? "border-rose-200 dark:border-rose-400/30"
                            : "border-secondary-200 dark:border-secondary-400/30"
                        }`
                      : "space-y-1.5"
                  }
                >
                  {showTerminalStatusCaption && terminalStatusMarker ? (
                    // Headerless fallback: when neither the preview header nor
                    // the outer speaker header carries the run status, it opens
                    // the failure block — an entry-level state label set off by
                    // a tone-tinted left rule, not a filled chip competing with
                    // the separate changes section below. (#145)
                    <div
                      data-testid="agent-thread-terminal-status"
                      className={`flex items-center gap-1.5 text-xs font-semibold ${terminalStatusTextClassName}`}
                    >
                      <WarningTriangle
                        aria-hidden="true"
                        className={`h-3.5 w-3.5 flex-none ${terminalStatusMarker.iconClassName}`}
                      />
                      <span className="min-w-0 truncate">{terminalStatusMarker.label}</span>
                    </div>
                  ) : null}
                  {runFailurePresentation && finalSummaryMessage ? (
                    <RunFailureMessageBody
                      message={finalSummaryMessage}
                      presentation={runFailurePresentation}
                    />
                  ) : finalSummaryMessage ? (
                    <MessageContent content={finalSummaryDisplayContent} projectId={projectId ?? null} />
                  ) : hasPreview ? (
                    <MessageContent content={previewText} projectId={projectId ?? null} />
                  ) : (
                    <Text as="div" variant="body" tone="muted" className="whitespace-pre-wrap">
                      {previewText}
                    </Text>
                  )}
                </div>
              ) : showRunningSpinnerFallback ? (
                <Text
                  as="div"
                  variant="caption"
                  tone="muted"
                  className={`${shouldAnimateThreadLiveState ? "instafy-status-sweep" : ""} text-xs`}
                  data-sweep-text={runningStatusLabel ?? "Running tasks…"}
                  aria-live="polite"
                >
                  {runningStatusLabel ?? "Running tasks…"}
                </Text>
              ) : useCompactRunningPreview && runningStatusLabel ? (
                <Text
                  as="div"
                  variant="body"
                  tone="muted"
                  className={`${shouldAnimateThreadLiveState ? "instafy-status-sweep" : ""} text-slate-600 dark:text-slate-300`}
                  data-sweep-text={runningStatusLabel}
                >
                  {runningStatusLabel}
                </Text>
              ) : (
                <div
                  ref={runningPreviewContainerRef}
                  className="relative max-h-48 overflow-hidden rounded-xl bg-white/50 p-3 dark:bg-slate-950/40"
                >
                  <div className="text-slate-700 dark:text-slate-200">
                    <MessageContent content={previewText} projectId={projectId ?? null} />
                  </div>
                  {runningPreviewHasOverflow ? (
                    <div className="pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-gradient-to-t from-white to-transparent dark:from-slate-950 dark:to-transparent" />
                  ) : null}
                </div>
              )}
            </div>
          </div>
        ) : null}

        {isCompleted && latestFiles ? (
          <div className="relative pt-1">
            <div className="min-w-0">
              <ChatFileChangeList
                files={latestFiles}
                projectId={projectId}
                commitRange={latestCommitRange ?? null}
                messageId={latestFilesMessageId ?? null}
                messageTimestamp={latestFilesMessageTimestamp ?? null}
              />
            </div>
          </div>
        ) : null}
        {!isRunning && showThreadPreviewSpine ? (
          <div className="relative h-4">
            <ThreadSpine
              tone={finalSpineTone}
              className={`pointer-events-none absolute top-0 h-full ${threadSpineJunctionOffsetClass}`}
              segments={[{ topPx: THREAD_SPINE_END_SEGMENT_TOP_PX, heightPx: THREAD_SPINE_END_SEGMENT_HEIGHT_PX }]}
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}
