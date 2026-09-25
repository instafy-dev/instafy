import { useConversationFileOpener } from "../../../workspace/ConversationFileContext";
import { type ComponentType, type ReactNode, useCallback, useId, useMemo, useState } from "react";
import { Globe, MediaImage, NavArrowRight, Xmark } from "iconoir-react";
import { Badge } from "../../../components/Badge";
import { Button } from "../../../components/Button";
import { Spinner } from "../../../components/Spinner";
import { Surface } from "../../../components/Surface";
import { Text } from "../../../components/Text";
import { resolveCameraRequestTimelinePresentation } from "../../../camera/cameraRemoteRequestPresentation";
import { useStatus } from "../../../status/useStatus";
import { useWorkspaceTabs } from "../../../workspace/WorkspaceTabsProvider";
import { formatProviderEventSummaryLine } from "../../../extensions/providerEventPresentation";
import type {
  ChatMessage,
  ChatMessageCommitRange,
  ChatMessageFileChange,
} from "../types";
import { CHAT_BUBBLE_MAX_WIDTH } from "./chatBubbleWidth";
import { extractMessageDetails } from "./chatMessageMetadata";
import { resolveTimelineStatusBadge } from "./chatMessageDetailHelpers";
import { normalizeActivityText, splitActivityLeadAndDetails, truncate } from "./chatContentHelpers";
import { extractLocalCapabilityArtifact } from "./chatMessagePresentation";
import { resolveSpineToneFromStatus, ThreadSpine } from "./ThreadSpine";
import { summaryToggleClass } from "./ChatFileChangeList";

type NotchedMessageShellProps = {
  align: "left" | "right";
  testId?: string;
  messageType?: string;
  showNotch?: boolean;
  className?: string;
  children: ReactNode;
};

type MessageContentProps = {
  content: string;
  className?: string;
  projectId?: string | null;
  mentionableAgentHandles?: string[] | null;
};

type ChatFileChangeListProps = {
  files: ChatMessageFileChange[];
  projectId?: string | null;
  commitRange?: ChatMessageCommitRange | null;
  messageId?: string | null;
  messageTimestamp?: number | null;
};

type SharedRenderProps = {
  NotchedMessageShell: ComponentType<NotchedMessageShellProps>;
  MessageContent: ComponentType<MessageContentProps>;
  ChatFileChangeList: ComponentType<ChatFileChangeListProps>;
  chatLeftSpineOffsetClass: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resolveMessageStatus(message: ChatMessage): {
  status: string | null;
  metadataRecord: Record<string, unknown> | null;
} {
  const details = extractMessageDetails(message.metadata);
  const metadataRecord =
    message.metadata && isRecord(message.metadata)
      ? (message.metadata as Record<string, unknown>)
      : null;
  const statusFromDetails = details && typeof details.status === "string" ? (details.status as string) : null;
  const statusFromMetadata =
    metadataRecord && typeof metadataRecord.status === "string"
      ? (metadataRecord.status as string)
      : null;

  return {
    status: statusFromDetails ?? statusFromMetadata,
    metadataRecord,
  };
}

export function ReasoningEntry({
  message,
  projectId,
  ChatFileChangeList,
}: {
  message: ChatMessage;
  projectId?: string | null;
} & Pick<SharedRenderProps, "ChatFileChangeList">) {
  const [expanded, setExpanded] = useState<boolean>(false);
  const contentId = useId();
  const hasLongContent = message.content.length > 420;
  const display = expanded || !hasLongContent ? message.content : truncate(message.content, 180);
  const { status } = resolveMessageStatus(message);
  const statusBadge = resolveTimelineStatusBadge("reasoning", status);

  return (
    <div
      data-testid="chat-bubble-assistant"
      data-message-type="reasoning"
      className={`${CHAT_BUBBLE_MAX_WIDTH.notice} py-1 text-sm text-slate-600 dark:text-slate-300`}
    >
      <div className="flex flex-wrap items-center gap-1.5">
        {hasLongContent ? (
          <button
            type="button"
            className={summaryToggleClass}
            onClick={() => setExpanded((value: boolean) => !value)}
            aria-expanded={expanded}
            aria-controls={contentId}
            title={expanded ? "Hide agent reasoning" : "Show agent reasoning"}
          >
            <span className="truncate">Agent thinking</span>
            <NavArrowRight
              className={`-ml-0.5 h-3.5 w-3.5 shrink-0 text-slate-400 transition-transform dark:text-slate-500 ${
                expanded ? "rotate-180" : ""
              }`}
              aria-hidden="true"
            />
          </button>
        ) : (
          <span className="inline-flex h-7 items-center text-xs font-medium text-slate-700 dark:text-slate-200">
            Agent thinking
          </span>
        )}
        {statusBadge ? (
          <Badge size="xs" className={statusBadge.className}>
            {statusBadge.showSpinner ? (
              <>
                <Spinner aria-hidden="true" tone="primary" size="xs" />
                <span className="sr-only">In progress</span>
              </>
            ) : null}
            {statusBadge.label}
          </Badge>
        ) : null}
      </div>
      <Text
        as="p"
        variant="body"
        tone="inherit"
        id={contentId}
        className="mt-1 whitespace-pre-wrap text-slate-600 dark:text-slate-300"
      >
        {display}
      </Text>
      {message.files && message.files.length > 0 ? (
        <ChatFileChangeList files={message.files} projectId={projectId} commitRange={message.commitRange ?? null} messageId={message.id} messageTimestamp={message.timestamp} />
      ) : null}
    </div>
  );
}

export function LocalCapabilityInlineEntry({
  message,
  projectId,
  mentionableAgentHandles,
  NotchedMessageShell,
  MessageContent,
  ChatFileChangeList,
  chatLeftSpineOffsetClass,
}: {
  message: ChatMessage;
  projectId?: string | null;
  mentionableAgentHandles?: string[] | null;
} & SharedRenderProps) {
  const { status, metadataRecord } = resolveMessageStatus(message);
  const statusBadge = resolveTimelineStatusBadge("local_capability_result", status);
  const content = normalizeActivityText(message.content);
  const cameraRequestSummary =
    metadataRecord?.cameraRequest && isRecord(metadataRecord.cameraRequest)
      ? (metadataRecord.cameraRequest as Record<string, unknown>)
      : null;
  const providerEventSummary = formatProviderEventSummaryLine(
    metadataRecord?.providerEvents ?? metadataRecord?.capabilityEvents,
  );
  const cameraRequestPresentation = cameraRequestSummary
    ? resolveCameraRequestTimelinePresentation({
        deviceLabel:
          typeof cameraRequestSummary.deviceLabel === "string"
            ? cameraRequestSummary.deviceLabel
            : null,
        requestState:
          typeof cameraRequestSummary.requestState === "string"
            ? cameraRequestSummary.requestState
            : null,
        presenceStatus:
          typeof cameraRequestSummary.presenceStatus === "string"
            ? cameraRequestSummary.presenceStatus
            : null,
        requiresPermission: cameraRequestSummary.requiresPermission === true,
        hasRecentFailure: cameraRequestSummary.hasRecentFailure === true,
      })
    : null;

  return (
    <NotchedMessageShell
      align="left"
      testId="chat-bubble-assistant"
      messageType="local_capability_result"
      className="pr-2"
    >
      <ThreadSpine
        tone={resolveSpineToneFromStatus(status) ?? "primary"}
        className={`pointer-events-none absolute top-0 h-full ${chatLeftSpineOffsetClass}`}
        notches={[{ maskLine: true }]}
      />
      <div className="flex min-w-0 items-start gap-2">
        <Globe aria-hidden="true" className="mt-[2px] h-3.5 w-3.5 flex-shrink-0 text-slate-500" />
        <div className="min-w-0 flex-1">
          <MessageContent
            content={content}
            projectId={projectId ?? null}
            mentionableAgentHandles={mentionableAgentHandles}
          />
          {cameraRequestPresentation?.label ? (
            <div
              className={[
                "mt-1.5 inline-flex max-w-full items-center gap-1.5 rounded-full border px-2 py-1 text-xxs font-medium",
                cameraRequestPresentation.tone === "warning"
                  ? "border-secondary-200 bg-secondary-50 text-secondary-700 dark:border-secondary-500/30 dark:bg-secondary-500/10 dark:text-secondary-100"
                  : "border-primary-200 bg-primary-50 text-primary-700 dark:border-primary-500/30 dark:bg-primary-500/10 dark:text-primary-100",
              ].join(" ")}
            >
              {cameraRequestPresentation.showSpinner ? (
                <Spinner aria-hidden="true" tone="primary" size="xs" />
              ) : cameraRequestPresentation.tone === "warning" ? (
                <Xmark aria-hidden="true" className="h-3 w-3 shrink-0" />
              ) : (
                <MediaImage aria-hidden="true" className="h-3 w-3 shrink-0" />
              )}
              <span className="truncate">{cameraRequestPresentation.label}</span>
            </div>
          ) : null}
          {providerEventSummary ? (
            <Text as="p" variant="caption" tone="muted" className="mt-1 text-slate-500 dark:text-slate-400">
              {providerEventSummary}
            </Text>
          ) : null}
          {message.files && message.files.length > 0 ? (
            <div className="mt-2">
              <ChatFileChangeList files={message.files} projectId={projectId} commitRange={message.commitRange ?? null} messageId={message.id} messageTimestamp={message.timestamp} />
            </div>
          ) : null}
        </div>
        {statusBadge ? (
          <Badge size="xs" className={statusBadge.className}>
            {statusBadge.showSpinner ? (
              <>
                <Spinner aria-hidden="true" tone="primary" size="xs" />
                <span className="sr-only">In progress</span>
              </>
            ) : null}
            {statusBadge.label}
          </Badge>
        ) : null}
      </div>
    </NotchedMessageShell>
  );
}

export function StatusActivityEntry({
  message,
  projectId,
  NotchedMessageShell,
  ChatFileChangeList,
  chatLeftSpineOffsetClass,
}: {
  message: ChatMessage;
  projectId?: string | null;
} & Pick<SharedRenderProps, "NotchedMessageShell" | "ChatFileChangeList" | "chatLeftSpineOffsetClass">) {
  const { showStatus } = useStatus();
  const { openPanelTab, requestUrlPush } = useWorkspaceTabs();
  const [expanded, setExpanded] = useState<boolean>(false);
  const [promotionState, setPromotionState] = useState<"idle" | "saving" | "saved">("idle");
  const contentId = useId();
  const content = normalizeActivityText(message.content);
  const { lead: contentLead, details: contentDetails } = splitActivityLeadAndDetails(content);
  const fullText = contentDetails ? `${contentLead} | ${contentDetails}` : contentLead;
  const hasLongContent = fullText.length > 420;
  const displayText = expanded || !hasLongContent ? fullText : truncate(fullText, 180);
  const { lead: displayLead, details: displayDetails } = splitActivityLeadAndDetails(displayText);
  const { status, metadataRecord } = resolveMessageStatus(message);
  const statusBadge = resolveTimelineStatusBadge("status", status);
  const resolvedArtifact = useMemo(
    () => extractLocalCapabilityArtifact(message),
    [message],
  );
  const artifact = resolvedArtifact?.artifact ?? null;
  const providerEventSummary = formatProviderEventSummaryLine(
    metadataRecord?.providerEvents ?? metadataRecord?.capabilityEvents,
  );
  const canPromoteArtifact = Boolean(projectId && resolvedArtifact);

  const openConversationFile = useConversationFileOpener();
  const openWorkspaceFile = useCallback(
    (path: string) => {
      if (typeof window === "undefined") {
        return;
      }
      const detail = {
        path,
        source: "chat-local-capability",
        returnTarget: "assistant" as const,
        projectId: projectId ?? null,
        markdownView: "preview" as const,
        preferPreview: true,
      };
      if (openConversationFile) {
        openConversationFile(detail);
        return;
      }
      const runtimeWindow = window as typeof window & {
        __INSTAFY_PENDING_OPEN_WORKSPACE_FILE__?: typeof detail | null;
      };
      runtimeWindow.__INSTAFY_PENDING_OPEN_WORKSPACE_FILE__ = detail;
      requestUrlPush();
      openPanelTab("code");
      window.dispatchEvent(new CustomEvent("instafy:open-workspace-file", { detail }));
    },
    [openConversationFile, openPanelTab, projectId, requestUrlPush],
  );

  const handlePromoteArtifact = useCallback(async () => {
    if (!projectId || !resolvedArtifact || promotionState === "saving") {
      return;
    }
    setPromotionState("saving");
    try {
      await resolvedArtifact.registration.promote({
        projectId,
        artifact: resolvedArtifact.artifact,
      });
      if (typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent("instafy:workspace-commit", { detail: { projectId } }));
      }
      setPromotionState("saved");
      showStatus(resolvedArtifact.artifact.saveSuccessMessage, "success", 3000);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      setPromotionState("idle");
      showStatus(
        errorMessage || resolvedArtifact.artifact.saveErrorMessage,
        "error",
        4500,
      );
    }
  }, [projectId, promotionState, resolvedArtifact, showStatus]);

  const handleOpenArtifact = useCallback(() => {
    if (!artifact?.suggestedPath) {
      return;
    }
    openWorkspaceFile(artifact.suggestedPath);
  }, [artifact, openWorkspaceFile]);

  return (
    <NotchedMessageShell align="left" messageType="status" className="pr-2">
      <ThreadSpine
        tone={resolveSpineToneFromStatus(status) ?? "primary"}
        className={`pointer-events-none absolute top-0 h-full ${chatLeftSpineOffsetClass}`}
        notches={[{ maskLine: true }]}
      />
      <Surface
        tone="default"
        radius="2xl"
        shadow="sm"
        data-testid="chat-bubble-assistant"
        data-message-type="status"
        className={`${CHAT_BUBBLE_MAX_WIDTH.notice} px-3 py-2.5 text-sm text-slate-600`}
      >
        <div className="flex flex-wrap items-center gap-1.5">
          {hasLongContent ? (
            <button
              type="button"
              className={summaryToggleClass}
              onClick={() => setExpanded((value: boolean) => !value)}
              aria-expanded={expanded}
              aria-controls={contentId}
              title={expanded ? "Hide activity details" : "Show activity details"}
            >
              <Globe className="-ml-0.5 h-3.5 w-3.5 shrink-0 text-slate-400 dark:text-slate-500" aria-hidden="true" />
              <span className="truncate">Real-world action</span>
              <NavArrowRight
                className={`-ml-0.5 h-3.5 w-3.5 shrink-0 text-slate-400 transition-transform dark:text-slate-500 ${
                  expanded ? "rotate-180" : ""
                }`}
                aria-hidden="true"
              />
            </button>
          ) : (
            <span className="inline-flex h-7 items-center gap-1.5 text-xs font-medium text-slate-700 dark:text-slate-200">
              <Globe className="-ml-0.5 h-3.5 w-3.5 shrink-0 text-slate-400 dark:text-slate-500" aria-hidden="true" />
              Real-world action
            </span>
          )}
          {statusBadge ? (
            <Badge size="xs" className={statusBadge.className}>
              {statusBadge.showSpinner ? (
                <>
                  <Spinner aria-hidden="true" tone="primary" size="xs" />
                  <span className="sr-only">In progress</span>
                </>
              ) : null}
              {statusBadge.label}
            </Badge>
          ) : null}
        </div>
        <Text
          as="p"
          variant="body"
          tone="inherit"
          id={contentId}
          className="mt-2 whitespace-pre-wrap text-slate-600"
        >
          <span className="font-medium text-slate-700 dark:text-slate-200">{displayLead}</span>
          {displayDetails ? <span className="text-slate-500 dark:text-slate-400"> {displayDetails}</span> : null}
        </Text>
        {providerEventSummary ? (
          <Text as="p" variant="caption" tone="muted" className="mt-2 text-slate-500 dark:text-slate-400">
            {providerEventSummary}
          </Text>
        ) : null}
        {artifact ? (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Badge size="xs" className="text-slate-600">
              {promotionState === "saved" ? artifact.savedLabel : artifact.readyLabel}
            </Badge>
            <Button
              onPress={handlePromoteArtifact}
              variant="outline"
              size="xs"
              isDisabled={!canPromoteArtifact || promotionState === "saving" || promotionState === "saved"}
              data-testid="chat-local-capability-save-memory"
            >
              {promotionState === "saving" ? "Saving…" : promotionState === "saved" ? "Saved" : "Save to memory"}
            </Button>
            <Button
              onPress={handleOpenArtifact}
              variant="ghost"
              size="xs"
              isDisabled={promotionState !== "saved" || !artifact.suggestedPath}
              data-testid="chat-local-capability-open-memory"
            >
              Open block
            </Button>
          </div>
        ) : null}
        {message.files && message.files.length > 0 ? (
          <div className="mt-3">
            <ChatFileChangeList files={message.files} projectId={projectId} commitRange={message.commitRange ?? null} messageId={message.id} messageTimestamp={message.timestamp} />
          </div>
        ) : null}
      </Surface>
    </NotchedMessageShell>
  );
}
