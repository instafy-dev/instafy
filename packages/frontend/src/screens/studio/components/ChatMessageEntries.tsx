import {
  type ClipboardEvent as ReactClipboardEvent,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { MoreHoriz, WarningTriangle } from "iconoir-react";
import { Button } from "../../../components/Button";
import { Surface } from "../../../components/Surface";
import { useConversations } from "../../../conversations/ConversationsProvider";
import { controllerClient } from "../../../sdk/instafy";
import { useWorkspaceTabs } from "../../../workspace/WorkspaceTabsProvider";
import type { ChatMessage } from "../types";
import { ActionRequestEntry } from "./ActionRequestEntry";
import { CHAT_BUBBLE_MAX_WIDTH } from "./chatBubbleWidth";
import {
  LocalCapabilityInlineEntry,
  ReasoningEntry,
  StatusActivityEntry,
} from "./ChatActivityEntries";
import { AgentJobThreadPreviewLayout } from "./AgentJobThreadPreviewLayout";
import { ChatFileChangeList } from "./ChatFileChangeList";
import { IntegrationRequestEntry, SecretRequestEntry } from "./ChatCredentialRequestEntries";
import { MessageContent } from "./ChatMessageContent";
import { ConversationThreadPreviewEntry } from "./ConversationThreadPreviewEntry";
import { MultiAgentPlanEntry } from "./MultiAgentPlanEntry";
import { TimelineEntry } from "./ChatTimelineEntry";
import { resolveRunFailurePresentation } from "../../../conversations/runFailurePresentation";
import { extractMessageDetails, getMessageType } from "./chatMessageMetadata";
import { shouldRenderLocalCapabilityStatusAsTimeline } from "./chatMessagePresentation";
import { resolveProxyUpstreamErrorGuidance } from "./proxyError";
import { RunFailureMessageBody } from "./RunFailureNotice";
import {
  resolveControllerNoticeActionHandler,
  useControllerNoticeActions,
} from "./ControllerNoticeActions";
import {
  getControllerConversationNoticeKind,
  resolveControllerConversationNoticeContent,
  resolveControllerConversationNoticeLabel,
  resolveControllerConversationNoticeAction,
} from "./controllerConversationNotice";
import { resolveSpineToneFromStatus, ThreadSpine, type ThreadSpineTone } from "./ThreadSpine";
import { buildAgentThreadBranchRows } from "./agentThreadBranchRows";
import { extractThreadRunStatus } from "./threadPreviewHelpers";
import { useAgentJobThreadPreviewState } from "./useAgentJobThreadPreviewState";
import { sanitizeChatMessageCopyEvent } from "./chatSelectionCopy";

const { getRawUrl: getWorkspaceFileRawUrl } = controllerClient.workspace.files;
const CHAT_LEFT_SPINE_OFFSET_CLASS = "left-[-26px]";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function handleChatMessageCopy(event: ReactClipboardEvent<HTMLDivElement>) {
  sanitizeChatMessageCopyEvent(event.nativeEvent);
}

export type NotchedMessageShellProps = {
  align: "left" | "right";
  messageId?: string;
  testId?: string;
  messageType?: string;
  showNotch?: boolean;
  showStartNotch?: boolean;
  width?: "fit" | "full";
  padding?: "normal" | "none";
  className?: string;
  onPointerDown?: (event: PointerEvent<HTMLDivElement>) => void;
  onPointerMove?: (event: PointerEvent<HTMLDivElement>) => void;
  onPointerUp?: (event: PointerEvent<HTMLDivElement>) => void;
  onPointerCancel?: (event: PointerEvent<HTMLDivElement>) => void;
  onContextMenu?: (event: MouseEvent<HTMLDivElement>) => void;
  onClickCapture?: (event: MouseEvent<HTMLDivElement>) => void;
  children: ReactNode;
};

export function NotchedMessageShell({
  messageId,
  testId,
  messageType,
  width = "fit",
  padding = "normal",
  className,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onPointerCancel,
  onContextMenu,
  onClickCapture,
  children,
}: NotchedMessageShellProps) {
  const widthClassName =
    width === "full"
      ? `w-full ${CHAT_BUBBLE_MAX_WIDTH.messageFull}`
      : `w-fit ${CHAT_BUBBLE_MAX_WIDTH.message}`;
  // No horizontal padding: the shell's left edge IS the chat alignment line —
  // speaker header, body text, and chip rows all start on it (#177).
  const paddingClassName = padding === "none" ? "" : "py-1";

  return (
    <div
      data-testid={testId}
      data-chat-message-id={messageId}
      data-message-type={messageType}
      data-chat-message-copy-root="true"
      className={`group relative inline-flex ${widthClassName} min-w-0 flex-col items-start ${paddingClassName} text-sm text-slate-700 dark:text-slate-200 ${className ?? ""}`.trim()}
      onCopy={handleChatMessageCopy}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onContextMenu={onContextMenu}
      onClickCapture={onClickCapture}
    >
      {/*
        Always full width, not just for `width="full"`: the shell above is a
        column flex container with `items-start`, so a cross-axis (width)
        auto-sized flex item ignores the shell's own max-width and grows to
        its content's max-content size instead of wrapping (#207). Giving
        this single content child an explicit width resolves it against the
        shell's already-clamped size, which is what actually makes long
        prose wrap at the shell's max-width instead of overflowing it. Short
        content is unaffected: percentage widths are treated as `auto` when
        the shell itself computes its own fit-content size, so narrow
        bubbles still hug their content exactly as before.
      */}
      <div className="w-full min-w-0">{children}</div>
    </div>
  );
}

type ChatImageAttachmentDescriptor = {
  kind: "image";
  workspacePath?: string | null;
  fileName?: string | null;
  mimeType?: string | null;
  sizeBytes?: number | null;
  previewUrl?: string | null;
};

function parseImageAttachment(value: unknown): ChatImageAttachmentDescriptor | null {
  if (!isRecord(value)) {
    return null;
  }
  const kind = typeof value.kind === "string" ? value.kind.trim().toLowerCase() : "";
  if (kind !== "image") {
    return null;
  }
  const workspacePathRaw =
    typeof value.workspacePath === "string"
      ? value.workspacePath
      : typeof value.workspace_path === "string"
        ? value.workspace_path
        : null;
  const workspacePath = workspacePathRaw?.trim() ? workspacePathRaw.trim() : null;
  const fileNameRaw =
    typeof value.fileName === "string"
      ? value.fileName
      : typeof value.file_name === "string"
        ? value.file_name
        : null;
  const fileName = fileNameRaw?.trim() ? fileNameRaw.trim() : null;
  const mimeTypeRaw =
    typeof value.mimeType === "string"
      ? value.mimeType
      : typeof value.mime_type === "string"
        ? value.mime_type
        : null;
  const mimeType = mimeTypeRaw?.trim() ? mimeTypeRaw.trim() : null;
  const sizeBytesValue =
    typeof value.sizeBytes === "number"
      ? value.sizeBytes
      : typeof value.size_bytes === "number"
        ? value.size_bytes
        : null;
  const sizeBytes =
    typeof sizeBytesValue === "number" && Number.isFinite(sizeBytesValue) && sizeBytesValue >= 0
      ? sizeBytesValue
      : null;
  const previewUrlRaw = typeof value.previewUrl === "string" ? value.previewUrl : null;
  const previewUrl = previewUrlRaw?.trim() ? previewUrlRaw.trim() : null;
  if (!workspacePath && !previewUrl) {
    return null;
  }
  return { kind: "image", workspacePath, fileName, mimeType, sizeBytes, previewUrl };
}

export function extractImageAttachments(message: ChatMessage): ChatImageAttachmentDescriptor[] {
  if (!message.metadata || !isRecord(message.metadata)) {
    return [];
  }
  const metadata = message.metadata as Record<string, unknown>;
  const attachmentsDirect = metadata.attachments;
  const attachments = Array.isArray(attachmentsDirect)
    ? attachmentsDirect
    : (() => {
        const promptMetadata = metadata.prompt_metadata;
        if (isRecord(promptMetadata) && Array.isArray(promptMetadata.attachments)) {
          return promptMetadata.attachments as unknown[];
        }
        const promptMetadataCamel = metadata.promptMetadata;
        if (isRecord(promptMetadataCamel) && Array.isArray(promptMetadataCamel.attachments)) {
          return promptMetadataCamel.attachments as unknown[];
        }
        return null;
      })();

  if (!attachments) {
    return [];
  }

  return attachments
    .map((entry) => parseImageAttachment(entry))
    .filter((entry): entry is ChatImageAttachmentDescriptor => entry !== null);
}

function ChatMessageImageAttachment({
  attachment,
  projectId,
  runtimeId,
  onOpenImage,
}: {
  attachment: ChatImageAttachmentDescriptor;
  projectId: string | null | undefined;
  runtimeId: string | null | undefined;
  onOpenImage?: (src: string, alt: string) => void;
}) {
  const [imageUrl, setImageUrl] = useState<string | null>(() => attachment.previewUrl ?? null);

  useEffect(() => {
    if (attachment.previewUrl) {
      setImageUrl(attachment.previewUrl);
      return;
    }
    const path = attachment.workspacePath;
    if (!projectId || !path) {
      setImageUrl(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      const rawUrl = await getWorkspaceFileRawUrl({
        projectId,
        path,
        runtimeId: runtimeId ?? null,
      });
      if (!cancelled) {
        setImageUrl(rawUrl);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [attachment.previewUrl, attachment.workspacePath, projectId, runtimeId]);

  const alt = attachment.fileName ?? "Image attachment";

  if (!imageUrl) {
    return (
      <div
        className="h-24 w-24 rounded-xl border border-slate-200 bg-slate-50 dark:border-[color:var(--color-studio-dark-panel-border)] dark:bg-[var(--color-studio-dark-panel-soft)]"
        aria-label={alt}
        data-testid="chat-image-attachment-placeholder"
      />
    );
  }

  return (
    <button
      type="button"
      className="h-24 w-24 overflow-hidden rounded-xl border border-slate-200 bg-slate-50 shadow-sm transition hover:bg-slate-100/60 hover:opacity-95 dark:border-[color:var(--color-studio-dark-panel-border)] dark:bg-[var(--color-studio-dark-panel-soft)] dark:hover:bg-[var(--color-studio-dark-control-hover)]"
      onClick={() => onOpenImage?.(imageUrl, alt)}
      aria-label={`Open ${alt}`}
      data-testid="chat-image-attachment-thumbnail"
    >
      <img src={imageUrl} alt={alt} className="h-full w-full object-cover" />
    </button>
  );
}

export type UserMessageBubbleProps = {
  message: ChatMessage;
  projectId?: string | null;
  runtimeId?: string | null;
  align?: "left" | "right";
  showNotch?: boolean;
  showStartNotch?: boolean;
  onOpenImage?: (src: string, alt: string) => void;
  mentionableAgentHandles?: string[] | null;
};

export function UserMessageBubble({
  message,
  projectId,
  runtimeId,
  align = "right",
  showNotch = true,
  showStartNotch = false,
  onOpenImage,
  mentionableAgentHandles,
}: UserMessageBubbleProps) {
  const attachments = useMemo(() => extractImageAttachments(message), [message]);
  const hasText = message.content.trim().length > 0;
  const isOwnMessage = align === "right";
  const fileChanges = Array.isArray(message.files) ? message.files : [];
  const hasFileChanges = fileChanges.length > 0;

  return (
    <NotchedMessageShell
      align={align}
      messageId={message.id}
      testId="chat-bubble-user"
      showNotch={isOwnMessage ? false : showNotch}
      showStartNotch={isOwnMessage ? false : showStartNotch}
      padding={isOwnMessage ? "none" : "normal"}
      className={
        isOwnMessage
          ? "rounded-2xl rounded-br-none bg-slate-50/90 px-3.5 py-2.5 text-slate-800 ring-1 ring-inset ring-slate-200/70 dark:bg-[var(--color-studio-dark-raised-control)] dark:text-slate-200 dark:ring-[color:var(--color-studio-dark-raised-control-border)]"
          : "text-slate-800 dark:text-slate-200"
      }
    >
      {attachments.length > 0 ? (
        <div className="mb-2 mt-0.5 flex flex-wrap gap-2">
          {attachments.map((attachment, index) => (
            <ChatMessageImageAttachment
              key={attachment.workspacePath ?? attachment.previewUrl ?? attachment.fileName ?? `attachment-${index}`}
              attachment={attachment}
              projectId={projectId ?? null}
              runtimeId={runtimeId ?? null}
              onOpenImage={onOpenImage}
            />
          ))}
        </div>
      ) : null}
      {hasText ? (
        <MessageContent
          content={message.content}
          metadata={
            message.metadata && isRecord(message.metadata)
              ? (message.metadata as Record<string, unknown>)
              : null
          }
          projectId={projectId ?? null}
          mentionableAgentHandles={mentionableAgentHandles}
        />
      ) : null}
      {hasFileChanges ? (
        <div className="mt-2">
          <ChatFileChangeList files={fileChanges} projectId={projectId} commitRange={message.commitRange ?? null} messageId={message.id} messageTimestamp={message.timestamp} />
        </div>
      ) : null}
    </NotchedMessageShell>
  );
}

function AgentJobThreadPreviewEntry({
  message,
  projectId,
  onCancelTerminalCommand,
  onMessageContextMenu,
  showHeaderAvatar = true,
  showHeaderIdentity = true,
  visibleAuthorHandle = null,
  visibleAuthorVisibility = "all",
  hideThreadSpine = false,
  runStatusShownInEntryHeader = false,
}: {
  message: ChatMessage;
  projectId?: string | null;
  onCancelTerminalCommand?: (() => void | Promise<void>) | null;
  onMessageContextMenu?: (event: MouseEvent<HTMLDivElement>, messageId: string) => void;
  showHeaderAvatar?: boolean;
  showHeaderIdentity?: boolean;
  visibleAuthorHandle?: string | null;
  visibleAuthorVisibility?: "all" | "narrow";
  hideThreadSpine?: boolean;
  runStatusShownInEntryHeader?: boolean;
}) {
  const previewState = useAgentJobThreadPreviewState({
    message,
    projectId,
    onCancelTerminalCommand,
    showHeaderAvatar: showHeaderIdentity && showHeaderAvatar,
    hideThreadSpine,
  });
  const { conversations } = useConversations();
  const { openConversationTab, requestUrlPush } = useWorkspaceTabs();
  const branchThreads = useMemo(
    () => buildAgentThreadBranchRows({ message, conversations }),
    [conversations, message],
  );
  const handleOpenBranchThread = useCallback(
    (threadLocalId: string) => {
      if (!threadLocalId) {
        return;
      }
      requestUrlPush();
      openConversationTab(threadLocalId);
    },
    [openConversationTab, requestUrlPush],
  );

  if (!previewState) {
    return null;
  }

  return (
    <AgentJobThreadPreviewLayout
      {...previewState}
      branchThreads={branchThreads}
      onOpenBranchThread={handleOpenBranchThread}
      MessageContent={MessageContent}
      ChatFileChangeList={ChatFileChangeList}
      onMessageContextMenu={onMessageContextMenu}
      showHeaderIdentity={showHeaderIdentity}
      visibleAuthorHandle={visibleAuthorHandle}
      visibleAuthorVisibility={visibleAuthorVisibility}
      runStatusShownInEntryHeader={runStatusShownInEntryHeader}
    />
  );
}

// Live runtime activity, provided by ChatPanel, so persisted runtime alerts
// can tell when a newer workspace start supersedes them: a 45-minute-old
// "startup failed" card above a live "starting its workspace…" row reads as a
// contradiction, not as history.
export const ChatRuntimeActivityContext = createContext<{ workspaceStarting: boolean }>({
  workspaceStarting: false,
});

function ControllerConversationNoticeEntry({
  message,
  messageType,
  projectId,
  showNotch,
  mentionableAgentHandles,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onPointerCancel,
  onContextMenu,
  onClickCapture,
}: {
  message: ChatMessage;
  messageType: "runtime_alert" | "run_cancellation";
  projectId?: string | null;
  showNotch: boolean;
  mentionableAgentHandles?: string[] | null;
  onPointerDown?: (event: PointerEvent<HTMLDivElement>) => void;
  onPointerMove?: (event: PointerEvent<HTMLDivElement>) => void;
  onPointerUp?: (event: PointerEvent<HTMLDivElement>) => void;
  onPointerCancel?: (event: PointerEvent<HTMLDivElement>) => void;
  onContextMenu?: (event: MouseEvent<HTMLDivElement>) => void;
  onClickCapture?: (event: MouseEvent<HTMLDivElement>) => void;
}) {
  const isRuntimeAlert = messageType === "runtime_alert";
  const { workspaceStarting } = useContext(ChatRuntimeActivityContext);
  // While a workspace start is live, the activity row by the composer is the
  // source of truth; older runtime alerts demote to a quiet history line so
  // the transcript never says "failed" and "starting" at full volume at once.
  const superseded = isRuntimeAlert && workspaceStarting;
  const spineTone: ThreadSpineTone = isRuntimeAlert ? "warning" : "danger";
  const label = resolveControllerConversationNoticeLabel(message);
  const noticeClassName = isRuntimeAlert
    ? "border-secondary-200/80 bg-secondary-50/80 text-secondary-900 shadow-sm dark:border-secondary-400/25 dark:bg-secondary-500/10 dark:text-secondary-100"
    : "border-rose-200/80 bg-rose-50/80 text-rose-900 shadow-sm dark:border-rose-400/25 dark:bg-rose-500/10 dark:text-rose-100";
  const displayContent = resolveControllerConversationNoticeContent(message);
  // Without the provider (thread previews, tests) the card keeps its old
  // button-free shape rather than throwing.
  const noticeActions = useControllerNoticeActions();
  const noticeAction = resolveControllerConversationNoticeAction(message, {
    viewerUserId: noticeActions?.viewerUserId ?? null,
  });
  const handleNoticeAction = resolveControllerNoticeActionHandler(noticeAction, noticeActions);

  return (
    <NotchedMessageShell
      align="left"
      messageId={message.id}
      testId="chat-controller-notice"
      messageType={messageType}
      showNotch={showNotch}
      className="pr-2"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onContextMenu={onContextMenu}
      onClickCapture={onClickCapture}
    >
      <ThreadSpine
        tone={spineTone}
        className={`pointer-events-none absolute top-0 h-full ${CHAT_LEFT_SPINE_OFFSET_CLASS}`}
        notches={[{ maskLine: true }]}
      />
      {superseded ? (
        <div
          className={`${CHAT_BUBBLE_MAX_WIDTH.notice} px-1 py-0.5 text-xs text-slate-500 dark:text-slate-400`}
          data-runtime-alert-superseded="true"
        >
          Earlier: {label.toLowerCase()}. A new workspace start is in progress below.
        </div>
      ) : (
        <div className={`${CHAT_BUBBLE_MAX_WIDTH.notice} rounded-xl border px-3 py-2 text-sm ${noticeClassName}`}>
          <div className="flex items-center gap-1.5 text-xs font-semibold">
            <WarningTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            {label}
          </div>
          <div className="mt-0.5">
            <MessageContent
              content={displayContent}
              metadata={
                message.metadata && isRecord(message.metadata)
                  ? (message.metadata as Record<string, unknown>)
                  : null
              }
              projectId={projectId ?? null}
              mentionableAgentHandles={mentionableAgentHandles}
            />
          </div>
          {noticeAction && handleNoticeAction ? (
            <div className="mt-2">
              <button
                type="button"
                data-testid="chat-controller-notice-action"
                onClick={handleNoticeAction}
                className={`inline-flex flex-none items-center justify-center rounded-full border px-2.5 py-1 text-xs font-medium transition focus:outline-none focus-visible:ring-2 ${
                  isRuntimeAlert
                    ? "border-secondary-300/70 text-secondary-800 hover:bg-secondary-100/70 focus-visible:ring-secondary-400 dark:border-secondary-400/30 dark:text-secondary-100 dark:hover:bg-secondary-500/15"
                    : "border-rose-300/70 text-rose-800 hover:bg-rose-100/70 focus-visible:ring-rose-400 dark:border-rose-400/30 dark:text-rose-100 dark:hover:bg-rose-500/15"
                }`}
              >
                {noticeAction.label}
              </button>
            </div>
          ) : null}
        </div>
      )}
    </NotchedMessageShell>
  );
}

export type AssistantMessageEntryProps = {
  message: ChatMessage;
  conversationMessages: ChatMessage[];
  projectId?: string | null;
  showNotch?: boolean;
  defaultPlanExpanded?: boolean;
  showAgentIdentityAvatar?: boolean;
  showAgentThreadHeaderIdentity?: boolean;
  visibleAuthorHandle?: string | null;
  visibleAuthorVisibility?: "all" | "narrow";
  onRequestActions?: (messageId: string, anchorRect: DOMRect | null) => void;
  onRequestActionsAtPoint?: (messageId: string, clientX: number, clientY: number) => void;
  onMessageContextMenu?: (event: MouseEvent<HTMLDivElement>, messageId: string) => void;
  onCancelTerminalCommand?: (() => void | Promise<void>) | null;
  conversationLocalId?: string | null;
  conversationControllerId?: string | null;
  mentionableAgentHandles?: string[] | null;
  useOuterWorkflowSpine?: boolean;
  renderContext?: "conversation" | "runTrace";
  /**
   * True when the surrounding row's speaker header already carries the
   * terminal run-status marker, so job-thread previews skip the duplicate
   * content-level status caption (#145).
   */
  runStatusShownInEntryHeader?: boolean;
};

export function AssistantMessageEntry({
  message,
  conversationMessages,
  projectId,
  showNotch = true,
  defaultPlanExpanded,
  showAgentIdentityAvatar = true,
  showAgentThreadHeaderIdentity = true,
  visibleAuthorHandle = null,
  visibleAuthorVisibility = "all",
  onRequestActions,
  onRequestActionsAtPoint,
  onMessageContextMenu,
  onCancelTerminalCommand,
  conversationLocalId,
  conversationControllerId,
  mentionableAgentHandles,
  useOuterWorkflowSpine = false,
  renderContext = "conversation",
  runStatusShownInEntryHeader = false,
}: AssistantMessageEntryProps) {
  const messageType = getMessageType(message);
  const details = extractMessageDetails(message.metadata);
  const metadataRecord =
    message.metadata && isRecord(message.metadata)
      ? (message.metadata as Record<string, unknown>)
      : null;
  const actionAnchorRef = useRef<HTMLButtonElement | null>(null);
  const { openJobThreadTab, requestUrlPush: requestWorkspaceUrlPush } = useWorkspaceTabs();
  const handleOpenActions = useCallback(() => {
    if (!onRequestActions) {
      return;
    }
    const rect = actionAnchorRef.current?.getBoundingClientRect() ?? null;
    onRequestActions(message.id, rect);
  }, [message.id, onRequestActions]);
  const handleOpenWorkerRunTrace = useCallback(
    ({ jobId, title }: { jobId: string; title: string }) => {
      if (!conversationLocalId || !jobId) {
        return;
      }
      requestWorkspaceUrlPush();
      openJobThreadTab({ conversationId: conversationLocalId, jobId, title });
    },
    [conversationLocalId, openJobThreadTab, requestWorkspaceUrlPush],
  );
  const handleBubbleContextMenu = useCallback(
    (event: MouseEvent<HTMLDivElement>) => {
      if (!onMessageContextMenu) {
        return;
      }
      onMessageContextMenu(event, message.id);
    },
    [message.id, onMessageContextMenu],
  );
  const longPressTimeoutRef = useRef<number | null>(null);
  const longPressStartRef = useRef<{ pointerId: number; x: number; y: number } | null>(null);
  const longPressTriggeredRef = useRef(false);

  const clearLongPress = useCallback(() => {
    if (longPressTimeoutRef.current !== null && typeof window !== "undefined") {
      window.clearTimeout(longPressTimeoutRef.current);
    }
    longPressTimeoutRef.current = null;
    longPressStartRef.current = null;
  }, []);

  useEffect(() => {
    return () => {
      clearLongPress();
    };
  }, [clearLongPress]);

  const handleBubblePointerDown = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      if (!onRequestActionsAtPoint) {
        return;
      }
      const pointerType = (event.pointerType ?? "").toLowerCase();
      const touchLikePointer = pointerType === "touch" || pointerType === "pen";
      if (!touchLikePointer) {
        return;
      }
      clearLongPress();
      longPressTriggeredRef.current = false;
      longPressStartRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };

      if (typeof window === "undefined") {
        return;
      }
      const HOLD_MS = 420;
      longPressTimeoutRef.current = window.setTimeout(() => {
        longPressTimeoutRef.current = null;
        const start = longPressStartRef.current;
        if (!start) {
          return;
        }
        longPressTriggeredRef.current = true;
        onRequestActionsAtPoint(message.id, start.x, start.y);
      }, HOLD_MS);
    },
    [clearLongPress, message.id, onRequestActionsAtPoint],
  );

  const handleBubblePointerMove = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      const start = longPressStartRef.current;
      if (!start || event.pointerId !== start.pointerId) {
        return;
      }
      const dx = event.clientX - start.x;
      const dy = event.clientY - start.y;
      if (dx * dx + dy * dy > 64) {
        clearLongPress();
      }
    },
    [clearLongPress],
  );

  const handleBubblePointerUp = useCallback(() => {
    clearLongPress();
  }, [clearLongPress]);

  const handleBubblePointerCancel = useCallback(() => {
    clearLongPress();
  }, [clearLongPress]);

  const handleBubbleClickCapture = useCallback((event: MouseEvent<HTMLDivElement>) => {
    if (!longPressTriggeredRef.current) {
      return;
    }
    longPressTriggeredRef.current = false;
    event.preventDefault();
    event.stopPropagation();
  }, []);

  const controllerNoticeKind = getControllerConversationNoticeKind(message);
  if (controllerNoticeKind) {
    return (
      <ControllerConversationNoticeEntry
        message={message}
        messageType={controllerNoticeKind}
        projectId={projectId}
        showNotch={showNotch}
        mentionableAgentHandles={mentionableAgentHandles}
        onPointerDown={handleBubblePointerDown}
        onPointerMove={handleBubblePointerMove}
        onPointerUp={handleBubblePointerUp}
        onPointerCancel={handleBubblePointerCancel}
        onContextMenu={handleBubbleContextMenu}
        onClickCapture={handleBubbleClickCapture}
      />
    );
  }

  if (messageType === "reasoning") {
    return <ReasoningEntry message={message} projectId={projectId} ChatFileChangeList={ChatFileChangeList} />;
  }

  if (messageType === "status") {
    if (shouldRenderLocalCapabilityStatusAsTimeline(message)) {
      return (
        <LocalCapabilityInlineEntry
          message={message}
          projectId={projectId}
          mentionableAgentHandles={mentionableAgentHandles}
          NotchedMessageShell={NotchedMessageShell}
          MessageContent={MessageContent}
          ChatFileChangeList={ChatFileChangeList}
          chatLeftSpineOffsetClass={CHAT_LEFT_SPINE_OFFSET_CLASS}
        />
      );
    }
    return (
      <StatusActivityEntry
        message={message}
        projectId={projectId}
        NotchedMessageShell={NotchedMessageShell}
        ChatFileChangeList={ChatFileChangeList}
        chatLeftSpineOffsetClass={CHAT_LEFT_SPINE_OFFSET_CLASS}
      />
    );
  }

  if (messageType === "local_capability_result") {
    return (
      <LocalCapabilityInlineEntry
        message={message}
        projectId={projectId}
        mentionableAgentHandles={mentionableAgentHandles}
        NotchedMessageShell={NotchedMessageShell}
        MessageContent={MessageContent}
        ChatFileChangeList={ChatFileChangeList}
        chatLeftSpineOffsetClass={CHAT_LEFT_SPINE_OFFSET_CLASS}
      />
    );
  }

  if (messageType === "conversation_thread") {
    return (
      <ConversationThreadPreviewEntry
        message={message}
        AssistantMessageEntry={AssistantMessageEntry}
        UserMessageBubble={UserMessageBubble}
        onMessageContextMenu={onMessageContextMenu}
      />
    );
  }

  if (messageType === "agent_job_thread") {
    return (
      <AgentJobThreadPreviewEntry
        message={message}
        projectId={projectId}
        onCancelTerminalCommand={onCancelTerminalCommand ?? null}
        onMessageContextMenu={onMessageContextMenu}
        showHeaderAvatar={showAgentIdentityAvatar}
        showHeaderIdentity={showAgentThreadHeaderIdentity}
        visibleAuthorHandle={visibleAuthorHandle}
        visibleAuthorVisibility={visibleAuthorVisibility}
        hideThreadSpine={useOuterWorkflowSpine}
        runStatusShownInEntryHeader={runStatusShownInEntryHeader}
      />
    );
  }

  if (messageType === "secret_request") {
    return <SecretRequestEntry message={message} projectId={projectId ?? null} details={details} />;
  }

  if (messageType === "integration_request") {
    return <IntegrationRequestEntry message={message} projectId={projectId ?? null} details={details} />;
  }

  if (messageType === "action_request") {
    return <ActionRequestEntry message={message} details={details} />;
  }

  if (messageType === "multi_agent_plan") {
    return (
      <NotchedMessageShell
        align="left"
        messageId={message.id}
        testId="chat-bubble-assistant"
        messageType={messageType}
        showNotch={showNotch}
        className="pr-2"
        onPointerDown={handleBubblePointerDown}
        onPointerMove={handleBubblePointerMove}
        onPointerUp={handleBubblePointerUp}
        onPointerCancel={handleBubblePointerCancel}
        onContextMenu={handleBubbleContextMenu}
        onClickCapture={handleBubbleClickCapture}
      >
        {useOuterWorkflowSpine ? null : (
          <ThreadSpine
            tone="primary"
            className={`pointer-events-none absolute top-0 h-full ${CHAT_LEFT_SPINE_OFFSET_CLASS}`}
            notches={[{ maskLine: true }]}
          />
        )}
        <div className="min-w-0">
          <MessageContent
            content={message.content}
            metadata={metadataRecord}
            projectId={projectId ?? null}
            mentionableAgentHandles={mentionableAgentHandles}
          />
          <MultiAgentPlanEntry
            details={details}
            planMessage={message}
            conversationMessages={conversationMessages}
            conversationLocalId={conversationLocalId ?? null}
            onOpenWorkerRunTrace={handleOpenWorkerRunTrace}
          />
        </div>
      </NotchedMessageShell>
    );
  }

  if (
    messageType &&
    ["command_execution", "mcp_tool_call", "todo_list", "file_change", "web_search", "token_usage", "runtime_switch"].includes(
      messageType
    )
  ) {
    return (
      <TimelineEntry
        message={messageType === "todo_list" ? { ...message, content: "" } : message}
        conversationMessages={conversationMessages}
        details={details}
        metadataRecord={metadataRecord}
        defaultPlanExpanded={defaultPlanExpanded}
        projectId={projectId}
        onCancelTerminalCommand={onCancelTerminalCommand ?? null}
        conversationLocalId={conversationLocalId ?? null}
        conversationControllerId={conversationControllerId ?? null}
        MessageContent={MessageContent}
        ChatFileChangeList={ChatFileChangeList}
        renderContext={renderContext}
      />
    );
  }

  const isError = messageType === "error";
  const singleMessageSpineTone: ThreadSpineTone =
    resolveSpineToneFromStatus(extractThreadRunStatus(message)) ?? (isError ? "danger" : "primary");
  // Failed-run error bubbles show a short friendly sentence with the raw
  // technical text behind a Details toggle; curated proxy/credential guidance
  // keeps its existing rendering inside MessageContent.
  const runFailurePresentation =
    isError && !resolveProxyUpstreamErrorGuidance(message.content)
      ? resolveRunFailurePresentation({
          metadata: metadataRecord,
          content: message.content,
          assumeFailed: true,
        })
      : null;

  if (!isError) {
    return (
      <NotchedMessageShell
        align="left"
        messageId={message.id}
        testId="chat-bubble-assistant"
        messageType={messageType ?? undefined}
        showNotch={showNotch}
        className="pr-2"
        onPointerDown={handleBubblePointerDown}
        onPointerMove={handleBubblePointerMove}
        onPointerUp={handleBubblePointerUp}
        onPointerCancel={handleBubblePointerCancel}
        onContextMenu={handleBubbleContextMenu}
        onClickCapture={handleBubbleClickCapture}
      >
        <div className="min-w-0">
          <MessageContent
            content={message.content}
            metadata={metadataRecord}
            projectId={projectId ?? null}
            mentionableAgentHandles={mentionableAgentHandles}
          />
          {message.files && message.files.length > 0 ? (
            <div className="mt-2">
              <ChatFileChangeList files={message.files} projectId={projectId} commitRange={message.commitRange ?? null} messageId={message.id} messageTimestamp={message.timestamp} />
            </div>
          ) : null}
        </div>
        {onRequestActions ? (
          <Button
            ref={actionAnchorRef}
            variant="ghost"
            size="icon"
            radius="full"
            onPress={handleOpenActions}
            className="absolute left-full top-1 ml-1 hidden h-6 w-6 p-0 text-slate-500 opacity-0 pointer-events-none transition-opacity sm:inline-flex hover:text-slate-700 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100 [@media(hover:none)]:hidden hover:!bg-transparent data-[hovered]:!bg-transparent data-[pressed]:!bg-transparent dark:text-slate-400 dark:hover:text-slate-200 dark:hover:!bg-transparent dark:data-[hovered]:!bg-transparent dark:data-[pressed]:!bg-transparent"
            aria-label="Message actions"
            data-testid="chat-message-actions"
          >
            <MoreHoriz className="h-4 w-4" aria-hidden="true" />
          </Button>
        ) : null}
      </NotchedMessageShell>
    );
  }

  return (
    <div
      data-chat-message-id={message.id}
      className="group relative inline-flex max-w-full"
      onPointerDown={handleBubblePointerDown}
      onPointerMove={handleBubblePointerMove}
      onPointerUp={handleBubblePointerUp}
      onPointerCancel={handleBubblePointerCancel}
      onContextMenu={handleBubbleContextMenu}
      onClickCapture={handleBubbleClickCapture}
    >
      <ThreadSpine
        tone={singleMessageSpineTone}
        className={`pointer-events-none absolute top-0 h-full ${CHAT_LEFT_SPINE_OFFSET_CLASS}`}
        notches={[{ maskLine: true }]}
      />
      <Surface
        tone="danger"
        radius="2xl"
        shadow="sm"
        data-testid="chat-bubble-assistant"
        data-message-type={messageType ?? undefined}
        className={`${CHAT_BUBBLE_MAX_WIDTH.alert} px-4 py-3 text-sm text-rose-700`}
      >
        {runFailurePresentation ? (
          <RunFailureMessageBody message={message} presentation={runFailurePresentation} />
        ) : (
          <MessageContent
            content={message.content}
            metadata={metadataRecord}
            projectId={projectId ?? null}
            mentionableAgentHandles={mentionableAgentHandles}
          />
        )}
        {message.files && message.files.length > 0 ? (
          <div className="mt-2">
            <ChatFileChangeList files={message.files} projectId={projectId} commitRange={message.commitRange ?? null} messageId={message.id} messageTimestamp={message.timestamp} />
          </div>
        ) : null}
      </Surface>
      {onRequestActions ? (
        <Button
          ref={actionAnchorRef}
          variant="ghost"
          size="icon"
          radius="full"
          onPress={handleOpenActions}
          className="absolute left-full top-1 ml-1 hidden h-6 w-6 p-0 text-slate-500 opacity-0 pointer-events-none transition-opacity sm:inline-flex hover:text-slate-700 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100 [@media(hover:none)]:hidden hover:!bg-transparent data-[hovered]:!bg-transparent data-[pressed]:!bg-transparent dark:text-slate-400 dark:hover:text-slate-200 dark:hover:!bg-transparent dark:data-[hovered]:!bg-transparent dark:data-[pressed]:!bg-transparent"
          aria-label="Message actions"
          data-testid="chat-message-actions"
        >
          <MoreHoriz className="h-4 w-4" aria-hidden="true" />
        </Button>
      ) : null}
    </div>
  );
}
