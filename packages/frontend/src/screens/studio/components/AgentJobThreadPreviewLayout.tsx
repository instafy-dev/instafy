import { useId, useMemo } from "react";
import type { CSSProperties, ComponentType, MouseEvent, MutableRefObject } from "react";
import {
  Activity,
  ClipboardCheck,
  CompressLines,
  GitBranch,
  Globe,
  NavArrowRight,
  OpenNewWindow,
  WarningTriangle,
} from "iconoir-react";
import { IconButton } from "../../../components/Button";
import { Text } from "../../../components/Text";
import { formatAiAccessibleName } from "../../../components/AiTag";
import { AI_TILE_CLASS, AI_TILE_SHAPE_CLASS, OctoCoin } from "../../../components/OctoCoin";
import { Spinner } from "../../../components/Spinner";
import {
  OCTO_AVATAR_SRC,
  resolveAgentAvatarGradient,
  resolveAgentAvatarImageSrc,
  resolveAgentAvatarText,
} from "../../../utils/agentAvatar";
import type { ChatMessage, ChatMessageCommitRange,
  ChatMessageFileChange, ChatMessageUnsavedReason } from "../types";
import { ActionRequestOrPreviewEntry } from "./ActionRequestOrPreviewEntry";
import { ChatMessageAvatar } from "./ChatMessageAvatar";
import type { AssistantAvatarMotion } from "./chatAssistantIdentity";
import { IntegrationRequestEntry, SecretRequestEntry } from "./ChatCredentialRequestEntries";
import { MultiAgentPlanEntry } from "./MultiAgentPlanEntry";
import {
  normalizeActivityText,
  parseTodoItems,
  splitActivityLeadAndDetails,
  stripWorkspacePrefixForPreview,
  truncate,
} from "./chatContentHelpers";
import {
  resolveRetryingStatusPresentation,
  resolveRunFailurePresentation,
} from "../../../conversations/runFailurePresentation";
import { extractMessageDetails, getMessageType } from "./chatMessageMetadata";
import { agentJobThreadAcknowledgementIds, shouldRenderLocalCapabilityStatusAsTimeline } from "./chatMessagePresentation";
import { RunFailureMessageBody, useRunFailureAutoRetryActive } from "./RunFailureNotice";
import { isCompactionStatusText } from "./assistantStatusHeuristics";
import type { AgentThreadBranchParticipant, AgentThreadBranchRow } from "./agentThreadBranchRows";
import {
  THREAD_SPINE_DEFAULT_NOTCH_OFFSET_PX,
  THREAD_SPINE_END_SEGMENT_HEIGHT_PX,
  THREAD_SPINE_END_SEGMENT_TOP_PX,
} from "./threadPreviewHelpers";
import { ThreadSpine, type ThreadSpineTone } from "./ThreadSpine";
import {
  formatProxyUpstreamErrorSummary,
  resolveProxyUpstreamErrorGuidance,
} from "./proxyError";
import { sitePreviewFromMessage } from "./sitePreviewRequest";
import { isTransientThreadUpdate } from "./threadPreviewProxyError";
import { TurnActivityDetails } from "./TurnActivityDetails";
import { TurnActivityLine } from "./TurnActivityLine";
import { detailsOnlySummary, type DetailItem, type TurnActivity } from "./turnActivity";
import { TurnBrowserApprovalRow, type TurnBrowserApproval } from "./turnBrowserApproval";

const COMPACTION_STATUS_LABEL = "Re-organizing my thoughts";
const NO_EARLIER_ATTEMPTS: EarlierAttemptDetails[] = [];
/** The line of a turn that ran no step itself after Instafy tried it again. */
const RETRIED_TURN_LINE = "Took two tries";

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
  // A retry notice quoting a provider error is not the failure the summary
  // stands for; it must not lend its guidance to the final row.
  if (isTransientThreadUpdate(update)) {
    return null;
  }
  const updateType = (getMessageType(update) ?? "").trim().toLowerCase();
  const isActivityUpdate = updateType === "reasoning" || updateType === "status";
  const rawContent = isActivityUpdate ? normalizeActivityText(update.content) : update.content.trim();
  return resolveProxyUpstreamErrorGuidance(rawContent) ? rawContent : null;
}

function normalizeInlineUpdateDedupeKey(content: string, updateType: string): string | null {
  const normalizedContent = content.replace(/\s+/g, " ").trim().toLowerCase();
  if (!normalizedContent) {
    return null;
  }
  return `${updateType}:${normalizedContent}`;
}

// Every face in the stack fills the same 20px slot, no inset (docs/Brand.md,
// "One rule for faces"), and the stack's 1px separator is a ring on the face
// itself, as in the conversation roster. So it follows the face's own shape
// (the AI tile's corners), sits outside the tile's inside hairline and draws
// above the face's avatar coin shadow: a clean edge with the soft shadow
// outside it. Nothing is positioned, so tree order decides which face covers
// which.
const BRANCH_PARTICIPANT_SLOT_CLASS = `inline-flex h-5 w-5 shrink-0 first:ml-0 -ml-1.5 ${AI_TILE_SHAPE_CLASS} *:ring-1 *:ring-white dark:*:ring-slate-950`;

function BranchParticipantAvatar({ participant }: { participant: AgentThreadBranchParticipant }) {
  const avatarImageSrc = resolveAgentAvatarImageSrc(participant);
  const avatarText = resolveAgentAvatarText({ handle: participant.handle });
  const title = `@${participant.handle}`;
  // Each slot is one image named for its AI ("@ben, AI"); the tooltip keeps
  // the handle alone.
  return (
    <span role="img" className={BRANCH_PARTICIPANT_SLOT_CLASS} title={title} aria-label={formatAiAccessibleName(title)}>
      {avatarImageSrc === OCTO_AVATAR_SRC ? (
        // Octo is its tile (OctoCoin, docs/Brand.md).
        <OctoCoin className="h-full w-full" />
      ) : (
        // Every other agent is the same AI tile around its own gradient and
        // initial or its uploaded picture.
        <span
          aria-hidden="true"
          className={`flex h-full w-full items-center justify-center overflow-hidden ${AI_TILE_CLASS} bg-slate-100 text-3xs font-semibold text-white shadow-avatar-coin dark:bg-slate-800`}
          style={avatarImageSrc ? undefined : { backgroundImage: resolveAgentAvatarGradient(participant.avatarSeed ?? participant.handle) }}
        >
          {avatarImageSrc ? (
            <img src={avatarImageSrc} alt="" className="h-full w-full object-cover" decoding="async" draggable={false} />
          ) : (
            avatarText
          )}
        </span>
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
        <span role="group" className="flex flex-none items-center" aria-label={`Participants: ${participants.map((entry) => `@${entry.handle}`).join(", ")}`}>
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

/** A failed attempt Instafy tried again by itself, as the retry's Details list it. */
export type EarlierAttemptDetails = {
  id: string;
  details: DetailItem[];
  /** The attempt's raw failure reason, shown only in Details. */
  failureText: string | null;
};

export type ChatFileChangeListProps = {
  files: ChatMessageFileChange[];
  projectId?: string | null;
  commitRange?: ChatMessageCommitRange | null;
  unsavedReason?: ChatMessageUnsavedReason | null;
  messageId?: string | null;
  messageTimestamp?: number | null;
  /** The turn opened a site in a preview: files it created read as the site it made. */
  madeSite?: boolean;
};

export type AgentJobThreadPreviewLayoutProps = {
  message: ChatMessage;
  projectId?: string | null;
  branchThreads: AgentThreadBranchRow[];
  hideThreadSpine?: boolean;
  showHeaderAvatar: boolean;
  assistantAvatarMotion: AssistantAvatarMotion;
  showHeaderIdentity?: boolean;
  /**
   * True when the surrounding row's speaker header already shows the terminal
   * run-status marker; the preview then skips its own status caption so run
   * state reads exactly once, at entry-header level (#145).
   */
  runStatusShownInEntryHeader?: boolean;
  /** The turn's plain-language line and the steps behind its Details (turnActivity). */
  activity: TurnActivity;
  /** The failed attempt this turn replaced, when Instafy tried it again by itself. */
  earlierAttempts?: EarlierAttemptDetails[];
  /** This failed turn's automatic resend went out, and the retry has shown nothing yet. */
  autoRetryPending?: boolean;
  /** The run's browser prompt, when this turn waits on the viewer's answer; shown under the line. */
  browserApproval?: TurnBrowserApproval["row"];
  detailsOpen: boolean;
  /** Cards stay in the turn's default view: they ask the person for something or show what it made. */
  cards: ChatMessage[];
  isThreadUnresolved: boolean;
  canCancelTerminalRun: boolean;
  cancelPending: boolean;
  expandedUpdateIds: Record<string, boolean>;
  finalSummaryMessage: ChatMessage | null;
  hasPreview: boolean;
  previewText: string;
  isCompleted: boolean;
  shouldAnimateThreadLiveState: boolean;
  latestFiles: ChatMessageFileChange[] | null;
  latestCommitRange?: ChatMessageCommitRange | null;
  latestUnsavedReason?: ChatMessageUnsavedReason | null;
  latestFilesMessageId?: string | null;
  latestFilesMessageTimestamp?: number | null;
  isRunning: boolean;
  finalSpineTone: ThreadSpineTone;
  threadPreviewRootRef: MutableRefObject<HTMLDivElement | null>;
  threadPreviewRef: MutableRefObject<HTMLDivElement | null>;
  threadPreviewRootStyle: CSSProperties;
  threadPreviewRailStyle: CSSProperties;
  threadSpineJunctionOffsetClass: string;
  threadSpineHeaderOffsetClass: string;
  onOpenBranchThread: (threadLocalId: string) => void;
  onToggleDetails: () => void;
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
  runStatusShownInEntryHeader = false,
  activity,
  earlierAttempts = NO_EARLIER_ATTEMPTS,
  autoRetryPending = false,
  browserApproval = null,
  detailsOpen,
  cards,
  isThreadUnresolved,
  expandedUpdateIds,
  finalSummaryMessage,
  hasPreview,
  previewText,
  isCompleted,
  shouldAnimateThreadLiveState,
  latestFiles,
  latestCommitRange,
  latestUnsavedReason,
  latestFilesMessageId,
  latestFilesMessageTimestamp,
  isRunning,
  finalSpineTone,
  threadPreviewRootRef,
  threadPreviewRef,
  threadPreviewRootStyle,
  threadPreviewRailStyle,
  threadSpineJunctionOffsetClass,
  threadSpineHeaderOffsetClass,
  onOpenBranchThread,
  onToggleDetails,
  onToggleUpdateExpanded,
  onMessageContextMenu,
  MessageContent,
  ChatFileChangeList,
}: AgentJobThreadPreviewLayoutProps) {
  const metadata = isRecord(message.metadata) ? message.metadata : null;
  const agentMetadata = metadata && isRecord(metadata.agent) ? metadata.agent : null;
  const detailsId = useId();
  // The row id is synthetic; list the replies it shows so reading them clears
  // their notification (useConversationNotificationRead).
  const acknowledgementIds = useMemo(() => agentJobThreadAcknowledgementIds(message).join(" "), [message]);
  const headerIdentityVisible = showHeaderIdentity && showHeaderAvatar;
  const threadOwnerHandle = normalizeAgentHandle(agentMetadata?.handle);
  const ownerBadge = showHeaderIdentity ? threadOwnerHandle : null;
  const terminalStatusMarker = resolveTerminalStatusMarker(finalSpineTone, isCompleted);
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
  const updateMessages = useMemo(
    () => activity.details.flatMap((item) => (item.kind === "update" ? [item.message] : [])),
    [activity.details],
  );
  // Reasoning is the model thinking aloud, never the source of the reply's guidance.
  const proxyGuidanceContentFromUpdates = finalSummaryLooksLikeProxyError
    ? [...updateMessages]
        .reverse()
        .filter((update) => (getMessageType(update) ?? "").trim().toLowerCase() !== "reasoning")
        .map(resolveProxyGuidanceContent)
        .find(Boolean) ?? null
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
  // Every failed turn renders one failure block: a short friendly sentence,
  // "Try again", and the raw text and the turn's steps behind its Details. A
  // proxy failure reads from its raw diagnostic, so the block can say whose
  // AI it was and offer "Manage AI" when settings can fix it.
  const runFailurePresentation =
    isCompleted && finalSpineTone === "danger" && finalSummaryMessage !== null
      ? resolveRunFailurePresentation({
          metadata: finalSummaryMessage.metadata,
          content: inheritedProxyGuidanceContent ?? finalSummaryDisplayContent,
          assumeFailed: true,
        })
      : null;
  // While Instafy tries a failed turn again by itself, the turn is one quiet
  // line: no failure block, no status and no red.
  const quietRetry = useRunFailureAutoRetryActive(
    runFailurePresentation ? finalSummaryMessage : null,
    autoRetryPending,
  );
  // A turn reads its outcome once. A failed turn shows it in its failure
  // block (or the quiet retry line), so its header carries no status; only a
  // failure with nothing to show below keeps the marker.
  const shownStatusMarker = runFailurePresentation === null ? terminalStatusMarker : null;
  const spineTone: ThreadSpineTone = quietRetry ? "neutral" : finalSpineTone;
  // Octo's notes listed in Details, once each, never repeating the reply.
  const visibleUpdateIds = useMemo(() => {
    const keys = new Set<string>();
    const ids = new Set<string>();
    for (const update of updateMessages) {
      const updateType = (getMessageType(update) ?? "").trim().toLowerCase();
      const isActivityUpdate = updateType === "reasoning" || updateType === "status";
      const rawContent = isActivityUpdate ? normalizeActivityText(update.content) : update.content.trim();
      const retryingPresentation = isActivityUpdate
        ? resolveRetryingStatusPresentation({ metadata: update.metadata, content: rawContent })
        : null;
      const content =
        retryingPresentation?.displayText ?? formatProxyUpstreamErrorSummary(rawContent) ?? rawContent;
      if (content && finalSummaryDisplayContent && content === finalSummaryDisplayContent) {
        continue;
      }
      if (
        terminalStatusMarker !== null &&
        finalSummaryMessage !== null &&
        finalSummaryCoversProxyError &&
        resolveProxyUpstreamErrorGuidance(rawContent) !== null
      ) {
        continue;
      }
      const dedupeKey = normalizeInlineUpdateDedupeKey(content, updateType);
      if (dedupeKey && keys.has(dedupeKey)) {
        continue;
      }
      if (dedupeKey) {
        keys.add(dedupeKey);
      }
      ids.add(update.id);
    }
    return ids;
  }, [finalSummaryCoversProxyError, finalSummaryDisplayContent, finalSummaryMessage, terminalStatusMarker, updateMessages]);
  const detailItems = useMemo(
    () => activity.details.filter((item) => item.kind !== "update" || visibleUpdateIds.has(item.id)),
    [activity.details, visibleUpdateIds],
  );
  // Details opens once the turn has done something: a step, a note, a plan or
  // a child thread. Reasoning titles are listed there too, but on their own
  // they leave the line plain ("Thinking…" before the first step).
  const hasDetails =
    detailItems.some(
      (item) => item.kind !== "update" || (getMessageType(item.message) ?? "").trim().toLowerCase() !== "reasoning",
    ) ||
    branchThreads.length > 0 ||
    earlierAttempts.length > 0;
  // A failed turn has one Details: the failure block's, which lists the steps.
  const activityLineOpensDetails = hasDetails && runFailurePresentation === null;
  // A done turn that ran no step but left notes, a plan or a thread still
  // gets a line, so its Details can open: "Wrote 2 notes". So does a retry
  // whose earlier attempt Details lists.
  const activityText =
    activity.live ??
    activity.summary ??
    (activityLineOpensDetails ? detailsOnlySummary(detailItems, branchThreads.length) : null) ??
    (activityLineOpensDetails && earlierAttempts.length > 0 ? RETRIED_TURN_LINE : null) ??
    "";
  // A failed turn's one line is its failure block: a summary of its steps
  // above it would read like a turn that went fine.
  const showActivityLine = activityText.length > 0 && runFailurePresentation === null;
  const showDetailsPanel = detailsOpen && activityLineOpensDetails;
  // The turn's preview card: the files it created are that site.
  const madeSite = cards.some((card) => sitePreviewFromMessage(card) !== null);
  const normalizeThreadPlaceholderText = (value: string) =>
    value
      .trim()
      .toLowerCase()
      .replace(/\.\.\.$/, "")
      .replace(/…$/, "")
      .replace(/[.!]+$/g, "")
      .trim();
  const finalSummaryPlaceholderText = normalizeThreadPlaceholderText(finalSummaryDisplayContent);
  const hasUsefulFinalSummary =
    isCompleted &&
    finalSummaryMessage !== null &&
    finalSummaryPlaceholderText.length > 0 &&
    finalSummaryPlaceholderText !== "thinking" &&
    finalSummaryPlaceholderText !== "reasoning";
  const hasUsefulPreview =
    isCompleted && hasPreview && !["", "completed", "thinking", "reasoning"].includes(normalizeThreadPlaceholderText(previewText));
  const showSummaryBody = isCompleted && (hasUsefulFinalSummary || hasUsefulPreview || terminalStatusMarker !== null);
  // Opening Details never changes this: the line must stay under the pointer
  // that opened it, so the turn keeps its chrome either way.
  const canUseTightCompletedLayoutBase =
    isCompleted &&
    showSummaryBody &&
    finalSummaryDisplayContent.length > 0 &&
    (hideThreadSpine || finalSummaryDisplayContent.length <= 420);
  // A short settled reply drops the run-activity spine, even with a file-change
  // rail under it. A failure with nothing else to show (no steps, cards or
  // child threads) is its failure block alone; otherwise it keeps its fuller
  // chrome.
  const useTightCompletedSummaryLayout = canUseTightCompletedLayoutBase && terminalStatusMarker === null;
  const useTightTerminalSummaryLayout =
    canUseTightCompletedLayoutBase &&
    latestFiles === null &&
    terminalStatusMarker !== null &&
    !showActivityLine &&
    cards.length === 0 &&
    branchThreads.length === 0;
  const useTightThreadPreviewLayout = useTightCompletedSummaryLayout || useTightTerminalSummaryLayout;
  const hasThreadPreviewHeaderContent = headerIdentityVisible || Boolean(ownerBadge);
  const showThreadPreviewHeader = useTightTerminalSummaryLayout
    ? false
    : headerIdentityVisible || (!useTightCompletedSummaryLayout && hasThreadPreviewHeaderContent);
  const showThreadPreviewSpine = !hideThreadSpine && !useTightThreadPreviewLayout;
  // Run status reads exactly once, at header level: the preview's own header
  // row when it renders, else the outer row's speaker header when that
  // carries it; the content-level caption is the fallback for headerless
  // continuation entries (#145).
  const showTerminalStatusInHeader = shownStatusMarker !== null && showThreadPreviewHeader;
  const showTerminalStatusCaption =
    shownStatusMarker !== null && !showTerminalStatusInHeader && !runStatusShownInEntryHeader;
  const terminalStatusTextClassName =
    finalSpineTone === "danger"
      ? "text-rose-700 dark:text-rose-200"
      : "text-secondary-800 dark:text-secondary-100";
  const threadPreviewRailRenderStyle = {
    ...threadPreviewRailStyle,
    top: showThreadPreviewHeader ? threadPreviewRailStyle.top : "0px",
  } as CSSProperties;

  const isEmptySettledTurn =
    !isRunning &&
    !isThreadUnresolved &&
    !shouldAnimateThreadLiveState &&
    terminalStatusMarker === null &&
    !showActivityLine &&
    !showSummaryBody &&
    cards.length === 0 &&
    (!latestFiles || latestFiles.length === 0) &&
    branchThreads.length === 0;
  if (isEmptySettledTurn) {
    return null;
  }

  const renderThreadPreviewNotch = (offsetPx = THREAD_SPINE_DEFAULT_NOTCH_OFFSET_PX) =>
    hideThreadSpine || useTightThreadPreviewLayout ? null : (
      <ThreadSpine
        tone={spineTone}
        className={`pointer-events-none absolute top-0 h-full ${threadSpineJunctionOffsetClass}`}
        notches={[{ offsetPx, maskLine: true }]}
      />
    );

  const renderCard = (card: ChatMessage) => {
    const cardType = (getMessageType(card) ?? "").trim().toLowerCase();
    const cardDetails = extractMessageDetails(card.metadata);
    if (cardType === "integration_request") {
      return <IntegrationRequestEntry message={card} projectId={projectId ?? null} details={cardDetails} />;
    }
    if (cardType === "secret_request") {
      return <SecretRequestEntry message={card} projectId={projectId ?? null} details={cardDetails} />;
    }
    if (cardType === "action_request") {
      return <ActionRequestOrPreviewEntry message={card} details={cardDetails} projectId={projectId ?? null} />;
    }
    const content = card.content.trim();
    return (
      <div className="min-w-0 max-w-full overflow-hidden">
        {content ? <MessageContent content={content} projectId={projectId ?? null} /> : null}
        <MultiAgentPlanEntry details={cardDetails} planMessage={card} />
      </div>
    );
  };

  // Octo's notes, reasoning titles, statuses and plan updates, as Details lists them.
  const renderUpdate = (update: ChatMessage) => {
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
    const todoItems = updateType === "todo_list" ? parseTodoItems(updateDetails) : [];
    const isCompactionUpdate = isActivityUpdate && isCompactionStatusText(content);
    const isLocalCapabilityActivity =
      updateType === "local_capability_result" || shouldRenderLocalCapabilityStatusAsTimeline(update);
    const iconClassName = "mt-[1px] h-3 w-3 flex-shrink-0 text-slate-400 dark:text-slate-500";
    const updateIcon =
      updateType === "todo_list" ? (
        <ClipboardCheck className={iconClassName} aria-hidden="true" />
      ) : isCompactionUpdate ? (
        <CompressLines className={iconClassName} aria-hidden="true" />
      ) : isLocalCapabilityActivity ? (
        <Globe className={iconClassName} aria-hidden="true" />
      ) : isActivityUpdate ? (
        <Activity className={iconClassName} aria-hidden="true" />
      ) : null;
    const canExpand =
      content.length > 240 ||
      content.includes("\n") ||
      (update.metadata && JSON.stringify(update.metadata).length > 300);
    const previewSource = isCompactionUpdate
      ? COMPACTION_STATUS_LABEL
      : updateType === "file_change"
        ? stripWorkspacePrefixForPreview(content)
        : content;
    const previewLine = truncate(previewSource.replace(/\s+/g, " "), 200);
    const activityPreviewParts = isActivityUpdate ? splitActivityLeadAndDetails(previewLine) : null;
    const previewContent = (
      <span className="flex min-w-0 items-start gap-2">
        {updateIcon}
        {activityPreviewParts ? (
          <span className="min-w-0 truncate">
            <span className="font-medium text-slate-700 dark:text-slate-100">{activityPreviewParts.lead}</span>
            {activityPreviewParts.details ? (
              <span className="text-slate-600 dark:text-slate-300"> {activityPreviewParts.details}</span>
            ) : null}
          </span>
        ) : (
          <span className="min-w-0 truncate">{previewLine}</span>
        )}
      </span>
    );

    return (
      <div className="group min-w-0">
        <div
          data-testid="agent-thread-inline-update-row"
          className="flex min-h-6 min-w-0 items-center justify-between gap-2 rounded-lg pr-1 pointer-coarse:min-h-11"
        >
          {canExpand ? (
            <button
              type="button"
              onClick={() => onToggleUpdateExpanded(update.id)}
              className="min-w-0 flex-1 truncate text-left text-xs text-slate-600 hover:text-slate-800 dark:text-slate-300 dark:hover:text-slate-100"
              title={updateTitle}
            >
              {previewContent}
            </button>
          ) : (
            <div className="min-w-0 flex-1 truncate text-xs text-slate-600 dark:text-slate-300" title={updateTitle}>
              {previewContent}
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
    );
  };

  const branchThreadRows =
    branchThreads.length > 0 ? (
      <div className="mt-1.5 space-y-1.5">
        {branchThreads.map((branch) => (
          <AgentThreadBranchRowEntry key={branch.threadLocalId} branch={branch} onOpen={onOpenBranchThread} />
        ))}
      </div>
    ) : null;
  const latestSteps = (
    <TurnActivityDetails
      id={earlierAttempts.length > 0 ? `${detailsId}-latest` : detailsId}
      items={detailItems}
      renderUpdate={renderUpdate}
      footer={branchThreadRows}
    />
  );
  // A retry's Details lists the attempt it replaced first, then its own steps.
  const stepsList =
    earlierAttempts.length === 0 ? (
      latestSteps
    ) : (
      <div id={detailsId} className="min-w-0 space-y-1 py-1" data-testid="turn-activity-attempts">
        {earlierAttempts.map((attempt, index) => (
          <section
            key={attempt.id}
            aria-labelledby={`${detailsId}-attempt-${index}-label`}
            data-testid="turn-activity-earlier-attempt"
            className="min-w-0"
          >
            <Text as="p" id={`${detailsId}-attempt-${index}-label`} variant="caption" tone="muted">
              First try
            </Text>
            <TurnActivityDetails
              id={`${detailsId}-attempt-${index}`}
              items={attempt.details}
              renderUpdate={renderUpdate}
            />
            {attempt.failureText ? (
              <p className="whitespace-pre-wrap break-words text-xs text-slate-500 dark:text-slate-400">
                {attempt.failureText}
              </p>
            ) : null}
          </section>
        ))}
        {detailItems.length > 0 || branchThreads.length > 0 ? (
          <section aria-labelledby={`${detailsId}-latest-label`} className="min-w-0">
            <Text as="p" id={`${detailsId}-latest-label`} variant="caption" tone="muted">
              Second try
            </Text>
            {latestSteps}
          </section>
        ) : null}
      </div>
    );

  return (
    // Clip only the horizontal axis: wide previews must not widen the chat,
    // but a vertical clip cut off the focus rings of the file chips, Review
    // changes and Undo that sit on this bubble's bottom edge. One axis clip
    // with the other visible is valid (hidden would turn visible into auto).
    // Browsers without overflow: clip (iOS 15) keep plain overflow-hidden.
    <div
      ref={threadPreviewRootRef}
      data-chat-message-id={message.id}
      data-chat-message-ids={acknowledgementIds || undefined}
      data-testid="chat-bubble-assistant"
      data-message-type="agent_job_thread"
      className="w-full min-w-0 max-w-2xl overflow-hidden supports-[overflow:clip]:overflow-x-clip supports-[overflow:clip]:overflow-y-visible text-sm text-slate-700 dark:text-slate-200"
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
            tone={spineTone}
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
              {showTerminalStatusInHeader && shownStatusMarker ? (
                <span
                  data-testid="agent-thread-terminal-status"
                  className={`inline-flex min-w-0 items-center gap-1 text-xxs font-semibold leading-none ${terminalStatusTextClassName}`}
                >
                  <WarningTriangle
                    aria-hidden="true"
                    className={`h-3 w-3 flex-none ${shownStatusMarker.iconClassName}`}
                  />
                  <span className="min-w-0 truncate">{shownStatusMarker.label}</span>
                </span>
              ) : null}
            </div>
          </div>
        ) : null}

        {showActivityLine ? (
          <div className="relative py-1">
            {renderThreadPreviewNotch()}
            <TurnActivityLine
              text={activityText}
              live={activity.live !== null}
              animate={shouldAnimateThreadLiveState}
              interactive={activityLineOpensDetails}
              detailsOpen={showDetailsPanel}
              detailsId={detailsId}
              onToggleDetails={onToggleDetails}
            />
          </div>
        ) : null}

        {browserApproval ? (
          // The run's prompt for the person who started it, under the line,
          // with no avatar of its own: it is part of this turn.
          <div className="relative min-w-0">
            <TurnBrowserApprovalRow agentName={browserApproval.agentName} onSettled={browserApproval.onSettled} />
          </div>
        ) : null}

        {showDetailsPanel ? <div className="relative min-w-0">{stepsList}</div> : null}

        {cards.map((card) => (
          <div key={card.id} className="relative py-1">
            {renderThreadPreviewNotch()}
            <div className="min-w-0">{renderCard(card)}</div>
          </div>
        ))}

        {showSummaryBody ? (
          <div
            className={`relative ${showActivityLine || cards.length > 0 ? "pt-1" : "pt-2"} pb-0`}
            data-workflow-spine-notch-anchor={hideThreadSpine ? "true" : undefined}
          >
            {renderThreadPreviewNotch()}
            <div className="min-w-0">
              <div
                className={
                  terminalStatusMarker && !quietRetry
                    ? `space-y-1.5 border-l-2 pl-3 ${
                        finalSpineTone === "danger"
                          ? "border-rose-200 dark:border-rose-400/30"
                          : "border-secondary-200 dark:border-secondary-400/30"
                      }`
                    : "space-y-1.5"
                }
              >
                {showTerminalStatusCaption && shownStatusMarker ? (
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
                      className={`h-3.5 w-3.5 flex-none ${shownStatusMarker.iconClassName}`}
                    />
                    <span className="min-w-0 truncate">{shownStatusMarker.label}</span>
                  </div>
                ) : null}
                {runFailurePresentation && finalSummaryMessage ? (
                  <RunFailureMessageBody
                    message={finalSummaryMessage}
                    presentation={runFailurePresentation}
                    steps={hasDetails ? stepsList : null}
                    autoRetryPending={autoRetryPending}
                  />
                ) : hasUsefulFinalSummary && finalSummaryMessage ? (
                  <MessageContent content={finalSummaryDisplayContent} projectId={projectId ?? null} />
                ) : hasUsefulPreview ? (
                  <MessageContent content={previewText} projectId={projectId ?? null} />
                ) : null}
              </div>
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
                unsavedReason={latestUnsavedReason ?? null}
                messageId={latestFilesMessageId ?? null}
                messageTimestamp={latestFilesMessageTimestamp ?? null}
                madeSite={madeSite}
              />
            </div>
          </div>
        ) : null}
        {/* The end cap marks a settled turn. Keyed to isRunning it came and
            went with every command (isRunning follows the newest update),
            moving the whole rail by its height mid-turn. */}
        {!isRunning && !isThreadUnresolved && showThreadPreviewSpine ? (
          <div className="relative h-4" data-testid="agent-thread-spine-end">
            <ThreadSpine
              tone={spineTone}
              className={`pointer-events-none absolute top-0 h-full ${threadSpineJunctionOffsetClass}`}
              segments={[{ topPx: THREAD_SPINE_END_SEGMENT_TOP_PX, heightPx: THREAD_SPINE_END_SEGMENT_HEIGHT_PX }]}
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}
