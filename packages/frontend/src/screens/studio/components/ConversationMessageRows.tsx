import { useEffect, type JSX, type MouseEvent as ReactMouseEvent } from "react";
import type { ChatMessage } from "../types";
import { isCurrentUserChatMessage } from "./chatMessageDetailHelpers";
import { getMessageType } from "./chatMessageMetadata";
import {
  type AssistantAgentIdentity,
  type AssistantAvatarMotion,
  type AssistantAvatarRenderOptions,
  extractAgentIdentityFromMetadata,
  extractRunIdFromMetadata,
  resolveAssistantHandleForMessage,
  resolvePreviousAssistantHandle,
  shouldShowAssistantAvatarForMessage,
  shouldShowAssistantIdentityForMessage,
} from "./chatAssistantIdentity";
import { shouldAssistantMessagesShareVisualGroup } from "./assistantMessageGrouping";
import { ChatBubbleRow } from "./ChatBubbleRow";
import type { ChatSpeakerMarker } from "./chatSpeakerMarker";
import {
  AssistantMessageEntry,
  extractImageAttachments,
  UserMessageBubble,
} from "./ChatMessageEntries";
import { AssistantSpeakerIdentityLabel } from "./AssistantSpeakerIdentityPill";
import { normalizeAssistantHandleLabel } from "./assistantSpeakerIdentity";
import { extractAgentJobId } from "./chatMessagePresentation";
import {
  HumanSpeakerIdentityLabel,
  resolveHumanChatIdentity,
} from "./chatHumanIdentity";
import { shouldSuppressOuterAvatarForConversationThread } from "./conversationThreadPreviewLayout";
import { sanitizeChatMessageCopyEvent } from "./chatSelectionCopy";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function extractMultiAgentPlanMetadata(message: ChatMessage): Record<string, unknown> | null {
  const metadata = message.metadata && isRecord(message.metadata) ? message.metadata : null;
  if (!metadata) {
    return null;
  }
  const direct = metadata.multiAgentPlan;
  if (isRecord(direct)) {
    return direct;
  }
  const snake = metadata.multi_agent_plan;
  return isRecord(snake) ? snake : null;
}

function extractThreadMessages(message: ChatMessage): ChatMessage[] {
  const metadata = message.metadata && isRecord(message.metadata) ? message.metadata : null;
  const threadMessages = metadata?.threadMessages;
  return Array.isArray(threadMessages) ? (threadMessages as ChatMessage[]) : [];
}

function shouldShowSpeakerIdentityForMessage(message: ChatMessage): boolean {
  if (message.role !== "assistant") {
    return false;
  }
  const normalizedMessageType = (getMessageType(message) ?? "").trim().toLowerCase();
  return normalizedMessageType !== "runtime_alert" && normalizedMessageType !== "run_cancellation";
}

function resolveAssistantDisplayHandleForMessage(
  message: ChatMessage,
  runAgentHandleByRunId: Map<string, string>,
): string | null {
  const metadata =
    message.metadata && isRecord(message.metadata)
      ? (message.metadata as Record<string, unknown>)
      : null;
  const agentIdentity = extractAgentIdentityFromMetadata(metadata);
  const handle =
    resolveAssistantHandleForMessage(message, runAgentHandleByRunId) ?? agentIdentity?.handle;
  return handle ? normalizeAssistantHandleLabel(handle) : null;
}

function resolvePreviousVisibleAssistantDisplayHandle(
  messages: ChatMessage[],
  index: number,
  runAgentHandleByRunId: Map<string, string>,
): string | null {
  const previous = messages[index - 1];
  if (!previous || !shouldShowSpeakerIdentityForMessage(previous)) {
    return null;
  }
  return resolveAssistantDisplayHandleForMessage(previous, runAgentHandleByRunId);
}

function buildMultiAgentGroupByParentJob(messages: ChatMessage[]): Map<string, string> {
  const groupByParentJob = new Map<string, string>();
  for (const message of messages) {
    const plan = extractMultiAgentPlanMetadata(message);
    if (!plan) {
      continue;
    }
    const role = stringField(plan.role).toLowerCase();
    const parentJobId = stringField(plan.parentJobId);
    const groupId = stringField(plan.groupId);
    if (role === "worker" && parentJobId && groupId && !groupByParentJob.has(parentJobId)) {
      groupByParentJob.set(parentJobId, groupId);
    }
  }
  return groupByParentJob;
}

function resolveMessageWorkflowSpineKey(
  message: ChatMessage,
  groupByParentJob: ReadonlyMap<string, string>,
): string | null {
  const messageType = (getMessageType(message) ?? "").trim().toLowerCase();
  const directPlan = extractMultiAgentPlanMetadata(message);
  const directGroupId = stringField(directPlan?.groupId);
  if (directGroupId) {
    return `multi-agent:${directGroupId}`;
  }

  if (messageType === "multi_agent_plan") {
    const jobId = extractAgentJobId(message);
    const groupId = jobId ? groupByParentJob.get(jobId) ?? "" : "";
    return groupId ? `multi-agent:${groupId}` : null;
  }

  if (messageType === "agent_job_thread") {
    for (const threadMessage of extractThreadMessages(message)) {
      const plan = extractMultiAgentPlanMetadata(threadMessage);
      const groupId = stringField(plan?.groupId);
      if (groupId) {
        return `multi-agent:${groupId}`;
      }
    }
  }

  return null;
}

export function ConversationMessageRows({
  messages,
  allConversationMessages,
  timedSyntheticRows,
  currentUserId,
  chatClientSessionId,
  projectId,
  runtimeId,
  conversationLocalId,
  conversationControllerId,
  firstPlanMessageId,
  mentionableAgentHandles,
  humanLabelByUserId,
  runAgentIdentityByRunId,
  runAgentHandleByRunId,
  activeAssistantAvatarMotion = null,
  renderAssistantAvatar,
  assistantAvatarPlaceholder,
  onOpenImage,
  onRequestActions,
  onRequestActionsAtPoint,
  onCancelTerminalCommand,
  onMessageContextMenu,
}: {
  messages: ChatMessage[];
  allConversationMessages?: ChatMessage[] | null;
  timedSyntheticRows?: Array<{ key: string; timestamp: number; element: JSX.Element }>;
  currentUserId: string | null;
  chatClientSessionId: string;
  projectId: string | null;
  runtimeId: string | null;
  conversationLocalId: string | null;
  conversationControllerId: string | null;
  firstPlanMessageId: string | null;
  mentionableAgentHandles?: string[] | null;
  humanLabelByUserId: Map<string, string>;
  runAgentIdentityByRunId: Map<string, AssistantAgentIdentity>;
  runAgentHandleByRunId: Map<string, string>;
  activeAssistantAvatarMotion?: {
    messageId: string;
    motion: AssistantAvatarMotion;
  } | null;
  renderAssistantAvatar: (
    metadata?: Record<string, unknown> | null,
    messageAgentIdentity?: AssistantAgentIdentity | null,
    options?: AssistantAvatarRenderOptions,
  ) => JSX.Element;
  assistantAvatarPlaceholder: JSX.Element;
  onOpenImage?: (src: string, alt: string) => void;
  onRequestActions: (messageId: string, anchorRect: DOMRect | null) => void;
  onRequestActionsAtPoint: (messageId: string, clientX: number, clientY: number) => void;
  onCancelTerminalCommand: (() => void | Promise<void>) | null;
  onMessageContextMenu: (event: ReactMouseEvent<HTMLDivElement>, messageId: string) => void;
}) {
  useEffect(() => {
    document.addEventListener("copy", sanitizeChatMessageCopyEvent);
    return () => {
      document.removeEventListener("copy", sanitizeChatMessageCopyEvent);
    };
  }, []);

  const rows: JSX.Element[] = [];
  const assistantContextMessages = allConversationMessages ?? messages;
  const multiAgentGroupByParentJob = buildMultiAgentGroupByParentJob(assistantContextMessages);
  const workflowSpineKeys = messages.map((message) =>
    resolveMessageWorkflowSpineKey(message, multiAgentGroupByParentJob),
  );
  const orderedTimedSyntheticRows = [...(timedSyntheticRows ?? [])].sort(
    (a, b) => a.timestamp - b.timestamp || a.key.localeCompare(b.key),
  );
  let timedSyntheticRowIndex = 0;
  const flushTimedRowsBefore = (timestamp: number) => {
    while (
      timedSyntheticRowIndex < orderedTimedSyntheticRows.length &&
      orderedTimedSyntheticRows[timedSyntheticRowIndex].timestamp <= timestamp
    ) {
      rows.push(orderedTimedSyntheticRows[timedSyntheticRowIndex].element);
      timedSyntheticRowIndex += 1;
    }
  };

  for (const [messageIndex, message] of messages.entries()) {
        flushTimedRowsBefore(message.timestamp);
        const normalizedCurrentUserId = typeof currentUserId === "string" ? currentUserId.trim() : "";
        const humanIdentity =
          message.role === "user" ? resolveHumanChatIdentity(message, humanLabelByUserId) : null;
        const messageMetadata =
          message.metadata && isRecord(message.metadata)
            ? (message.metadata as Record<string, unknown>)
            : null;
        const messageAgentIdentityFromMetadata = extractAgentIdentityFromMetadata(messageMetadata);
        const messageRunId = extractRunIdFromMetadata(messageMetadata);
        const messageAgentIdentityFromRun =
          messageRunId ? runAgentIdentityByRunId.get(messageRunId) ?? null : null;
        const messageAgentIdentity = messageAgentIdentityFromMetadata ?? messageAgentIdentityFromRun;
        const previousAssistantHandle = resolvePreviousAssistantHandle(
          messages,
          messageIndex,
          runAgentHandleByRunId,
        );
        const previousVisibleAssistantHandle = resolvePreviousVisibleAssistantDisplayHandle(
          messages,
          messageIndex,
          runAgentHandleByRunId,
        );
        const isOwnUserMessage = isCurrentUserChatMessage(
          message,
          normalizedCurrentUserId,
          chatClientSessionId,
        );
        const isLeftAligned =
          message.role === "assistant" || (message.role === "user" && !isOwnUserMessage);
        const showAssistantAvatar =
          message.role === "assistant" &&
          shouldShowAssistantAvatarForMessage(message, runAgentHandleByRunId);
        const showAssistantIdentityAvatar =
          message.role === "assistant" &&
          shouldShowAssistantIdentityForMessage(message, previousAssistantHandle, runAgentHandleByRunId);
        const trimmedContent = message.content.trim();
        const hasImageAttachments = extractImageAttachments(message).length > 0;
        const hasFileChanges = Array.isArray(message.files) && message.files.length > 0;
        const groupIdentity =
          message.role === "assistant"
            ? `assistant:${(messageAgentIdentity?.handle ?? "").trim() || "assistant"}`
            : isOwnUserMessage
              ? "user:self"
              : humanIdentity?.groupIdentity ?? "user:teammate";
        const groupKey = `${isLeftAligned ? "left" : "right"}:${groupIdentity}`;
        const previousMessage = messages[messageIndex - 1] ?? null;
        const previousIsOwnUserMessage = previousMessage
          ? isCurrentUserChatMessage(previousMessage, normalizedCurrentUserId, chatClientSessionId)
          : false;
        const previousHumanIdentity =
          previousMessage?.role === "user" ? resolveHumanChatIdentity(previousMessage, humanLabelByUserId) : null;
        const previousIsSameOwnUserGroup =
          message.role === "user" &&
          isOwnUserMessage &&
          previousMessage !== null &&
          previousMessage.role === "user" &&
          previousIsOwnUserMessage &&
          shouldAssistantMessagesShareVisualGroup(
            getMessageType(previousMessage),
            getMessageType(message),
          );
        const previousIsSameLeftHumanGroup =
          message.role === "user" &&
          !isOwnUserMessage &&
          previousMessage !== null &&
          previousMessage.role === "user" &&
          !previousIsOwnUserMessage &&
          previousHumanIdentity?.groupIdentity === humanIdentity?.groupIdentity &&
          shouldAssistantMessagesShareVisualGroup(
            getMessageType(previousMessage),
            getMessageType(message),
          );
        const isGroupHead = !(previousIsSameOwnUserGroup || previousIsSameLeftHumanGroup);
        let isGroupTail = true;
        const nextMessage = messages[messageIndex + 1] ?? null;
        if (nextMessage) {
          const nextIsOwnUserMessage = isCurrentUserChatMessage(
            nextMessage,
            normalizedCurrentUserId,
            chatClientSessionId,
          );
          const nextHumanIdentity =
            nextMessage.role === "user" ? resolveHumanChatIdentity(nextMessage, humanLabelByUserId) : null;
          const nextIsLeftAligned =
            nextMessage.role === "assistant" || (nextMessage.role === "user" && !nextIsOwnUserMessage);
          const nextMessageMetadata =
            nextMessage.metadata && isRecord(nextMessage.metadata)
              ? (nextMessage.metadata as Record<string, unknown>)
              : null;
          const nextAgentIdentityFromMetadata = extractAgentIdentityFromMetadata(nextMessageMetadata);
          const nextRunId = extractRunIdFromMetadata(nextMessageMetadata);
          const nextAgentIdentityFromRun = nextRunId ? runAgentIdentityByRunId.get(nextRunId) ?? null : null;
          const nextAgentIdentity = nextAgentIdentityFromMetadata ?? nextAgentIdentityFromRun;
          const nextGroupIdentity =
            nextMessage.role === "assistant"
              ? `assistant:${(nextAgentIdentity?.handle ?? "").trim() || "assistant"}`
              : nextIsOwnUserMessage
                ? "user:self"
                : nextHumanIdentity?.groupIdentity ?? "user:teammate";
          const nextGroupKey = `${nextIsLeftAligned ? "left" : "right"}:${nextGroupIdentity}`;
          if (
            nextGroupKey === groupKey &&
            shouldAssistantMessagesShareVisualGroup(
              getMessageType(message),
              getMessageType(nextMessage),
            )
          ) {
            isGroupTail = false;
          }
        }

        const normalizedMessageType = (getMessageType(message) ?? "").trim().toLowerCase();
        const messageAssistantAvatarMotion: AssistantAvatarMotion =
          activeAssistantAvatarMotion?.messageId === message.id
            ? activeAssistantAvatarMotion.motion
            : "idle";
        const isAgentJobThreadMessage = normalizedMessageType === "agent_job_thread";
        const workflowSpineKey = workflowSpineKeys[messageIndex] ?? null;
        const previousWorkflowSpineKey = messageIndex > 0 ? workflowSpineKeys[messageIndex - 1] ?? null : null;
        const nextWorkflowSpineKey = workflowSpineKeys[messageIndex + 1] ?? null;
        const spineBridgeBefore = Boolean(workflowSpineKey && workflowSpineKey === previousWorkflowSpineKey);
        const spineBridgeAfter = Boolean(workflowSpineKey && workflowSpineKey === nextWorkflowSpineKey);
        const isWorkflowSpineContinuation = message.role === "assistant" && spineBridgeBefore;
        const suppressOuterAssistantAvatar =
          message.role === "assistant" &&
          (isAgentJobThreadMessage ||
            isWorkflowSpineContinuation ||
            shouldSuppressOuterAvatarForConversationThread(message));
        const assistantHandleForMessage =
          message.role === "assistant"
            ? resolveAssistantDisplayHandleForMessage(message, runAgentHandleByRunId) ?? ""
            : "";
        const normalizedPreviousAssistantHandle = previousVisibleAssistantHandle
          ? normalizeAssistantHandleLabel(previousVisibleAssistantHandle)
          : null;
        const isRepeatedAssistantSpeaker =
          message.role === "assistant" &&
          assistantHandleForMessage.length > 0 &&
          assistantHandleForMessage === normalizedPreviousAssistantHandle;
        const suppressDesktopAssistantAvatar = suppressOuterAssistantAvatar || isRepeatedAssistantSpeaker;
        const usesAssistantAvatarRail = message.role === "assistant" && Boolean(workflowSpineKey);
        const showNotch = isGroupTail && (trimmedContent.length > 0 || hasFileChanges || hasImageAttachments);
        const hasOwnUserStartBoundaryRisk =
          trimmedContent.length >= 96 ||
          trimmedContent.includes("\n") ||
          hasFileChanges ||
          hasImageAttachments;
        const showStartNotch =
          message.role === "user" &&
          isOwnUserMessage &&
          !isLeftAligned &&
          isGroupHead &&
          hasOwnUserStartBoundaryRisk;
        const bubble =
          message.role === "user" ? (
            <UserMessageBubble
              message={message}
              projectId={projectId}
              runtimeId={runtimeId}
              align={isLeftAligned ? "left" : "right"}
              showNotch={showNotch}
              showStartNotch={showStartNotch}
              onOpenImage={onOpenImage}
              mentionableAgentHandles={mentionableAgentHandles}
            />
          ) : (
            <AssistantMessageEntry
              message={message}
              conversationMessages={assistantContextMessages}
              projectId={projectId}
              showNotch={showNotch}
              showAgentIdentityAvatar={showAssistantIdentityAvatar}
              showAgentThreadHeaderIdentity={false}
              defaultPlanExpanded={firstPlanMessageId !== null && message.id === firstPlanMessageId}
              onRequestActions={onRequestActions}
              onRequestActionsAtPoint={onRequestActionsAtPoint}
              onCancelTerminalCommand={onCancelTerminalCommand}
              conversationLocalId={conversationLocalId}
              conversationControllerId={conversationControllerId}
              mentionableAgentHandles={mentionableAgentHandles}
              onMessageContextMenu={onMessageContextMenu}
              useOuterWorkflowSpine={Boolean(workflowSpineKey)}
            />
          );

        const avatar =
          message.role === "assistant"
            ? usesAssistantAvatarRail
              ? suppressDesktopAssistantAvatar
                ? assistantAvatarPlaceholder
                : showAssistantAvatar
                  ? renderAssistantAvatar(messageMetadata, messageAgentIdentity, {
                      motion: messageAssistantAvatarMotion,
                      scrollReactive: messageAssistantAvatarMotion === "thinking",
                    })
                  : assistantAvatarPlaceholder
              : null
            : null;
        const humanSpeakerIdentity =
          message.role === "user" && !isOwnUserMessage && isGroupHead && humanIdentity ? (
            <HumanSpeakerIdentityLabel
              avatarSeed={humanIdentity.avatarSeed}
              label={humanIdentity.label}
              timestamp={message.timestamp}
            />
          ) : null;
        const showSpeakerIdentity = shouldShowSpeakerIdentityForMessage(message);
        const showRuntimeNoticeIdentity =
          message.role === "assistant" &&
          normalizedMessageType === "runtime_alert" &&
          assistantHandleForMessage.length > 0;
        const showInlineNarrowSpeakerIdentity =
          showRuntimeNoticeIdentity ||
          (showSpeakerIdentity && assistantHandleForMessage !== normalizedPreviousAssistantHandle);
        const inlineSpeakerIdentity = showInlineNarrowSpeakerIdentity ? (
          <AssistantSpeakerIdentityLabel
            handle={assistantHandleForMessage}
            timestamp={message.timestamp}
            metadata={messageMetadata}
            agentIdentity={messageAgentIdentity}
            motion={messageAssistantAvatarMotion}
          />
        ) : null;
        const speakerIdentity =
          message.role === "user" ? humanSpeakerIdentity : usesAssistantAvatarRail ? null : inlineSpeakerIdentity;
        const narrowSpeakerIdentity = usesAssistantAvatarRail ? inlineSpeakerIdentity : null;
        const speakerMarker: ChatSpeakerMarker =
          showSpeakerIdentity
            ? {
                kind: "assistant",
                handle: assistantHandleForMessage,
                avatarSeed: messageAgentIdentity?.avatarSeed ?? assistantHandleForMessage,
              }
            : { kind: "boundary" };

        rows.push(
          <ChatBubbleRow
            key={message.id}
            testId="chat-message-row"
            align={isLeftAligned ? "left" : "right"}
            avatar={avatar}
            collapseAvatarOnNarrow={usesAssistantAvatarRail}
            speakerIdentity={speakerIdentity}
            narrowSpeakerIdentity={narrowSpeakerIdentity}
            speakerMarker={speakerMarker}
            onContextMenu={
              message.role === "assistant" ? (event) => onMessageContextMenu(event, message.id) : undefined
            }
            workflowSpineActive={Boolean(workflowSpineKey)}
            workflowSpineContinuesBefore={spineBridgeBefore}
            workflowSpineContinuesAfter={spineBridgeAfter}
          >
            {bubble}
          </ChatBubbleRow>,
        );
      }

  while (timedSyntheticRowIndex < orderedTimedSyntheticRows.length) {
    rows.push(orderedTimedSyntheticRows[timedSyntheticRowIndex].element);
    timedSyntheticRowIndex += 1;
  }

  return <>{rows}</>;
}
