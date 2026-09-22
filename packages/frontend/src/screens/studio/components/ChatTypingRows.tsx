import { useEffect, useLayoutEffect, useMemo, useRef, useState, type JSX, type ReactNode } from "react";
import { CompressLines } from "iconoir-react";
import { OctoMark } from "../../../components/OctoMark";
import { OCTO_AVATAR_SRC, resolveAgentAvatarImageSrc } from "../../../utils/agentAvatar";
import { ChatActivityBubble } from "./ChatActivityBubble";
import { ChatBubbleRow } from "./ChatBubbleRow";
import { ChatMessageAvatar } from "./ChatMessageAvatar";
import type {
  AssistantAgentIdentity,
  AssistantAvatarRenderOptions,
  AssistantTypingAgent,
} from "./chatAssistantIdentity";

type TypingIndicatorPhase = "typing" | "finalizing" | "thinking" | "waiting" | "compacting";
type TypingIndicatorState = { phase: TypingIndicatorPhase; label: string | null };
type AssistantTypingStatusSnapshot = {
  phase: TypingIndicatorPhase | null;
  label: string;
  ariaLabel: string;
  expanded: boolean;
  clickable: boolean;
  indicator: ReactNode;
};

const ASSISTANT_STATUS_LINGER_MS = 12_000;

function usesCanonicalOctoAvatar({
  handle,
  avatarSeed,
}: {
  handle: string;
  avatarSeed: string;
}): boolean {
  return resolveAgentAvatarImageSrc({ handle, avatarSeed }) === OCTO_AVATAR_SRC;
}

function AssistantTypingStatusLine({
  snapshot,
  hidden = false,
  onToggleThinkingLabel,
}: {
  snapshot: AssistantTypingStatusSnapshot;
  hidden?: boolean;
  onToggleThinkingLabel: () => void;
}) {
  const isFinalizing = snapshot.phase === "finalizing";
  const labelClassName = snapshot.clickable
    ? snapshot.expanded
      ? "overflow-x-auto whitespace-nowrap"
      : "truncate"
    : "";

  return (
    <div
      data-testid="assistant-typing-indicator"
      className={[
        "flex min-h-8 w-fit max-w-full min-w-0 items-center gap-2 px-1 text-sm",
        isFinalizing
          ? "text-primary-700 dark:text-primary-200"
          : "text-slate-500 dark:text-slate-400",
        snapshot.clickable && !hidden ? "cursor-pointer" : "",
        hidden ? "invisible pointer-events-none" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      aria-live={hidden ? undefined : "polite"}
      aria-hidden={hidden ? "true" : undefined}
      onClick={() => {
        if (snapshot.clickable && !hidden) {
          onToggleThinkingLabel();
        }
      }}
    >
      {!hidden ? <span className="sr-only">{snapshot.ariaLabel}</span> : null}
      {!hidden ? snapshot.indicator : null}
      <span
        className={["instafy-status-sweep min-w-0 max-w-full text-xs", labelClassName].join(" ")}
        data-sweep-text={snapshot.label}
        title={snapshot.clickable ? snapshot.label : undefined}
        aria-hidden="true"
      >
        {snapshot.label}
      </span>
    </div>
  );
}

export function ChatTypingRows({
  peerTypingLabel,
  isAssistantTyping,
  isAssistantTypingCoveredByJobThreadPreview,
  typingAgents,
  hasMultipleTypingAgents,
  typingAgentHandle,
  typingAgentAvatarSeed,
  typingIndicatorState,
  typingStatusLabel,
  typingStatusAriaLabel,
  suppressAssistantStatus,
  isThinkingLabelExpanded,
  onToggleThinkingLabel,
  latestDisplayedMessageId,
  renderAssistantAvatar,
}: {
  peerTypingLabel: string | null;
  isAssistantTyping: boolean;
  isAssistantTypingCoveredByJobThreadPreview: boolean;
  typingAgents: AssistantTypingAgent[];
  hasMultipleTypingAgents: boolean;
  typingAgentHandle: string;
  typingAgentAvatarSeed: string;
  typingIndicatorState: TypingIndicatorState | null;
  typingStatusLabel: string;
  typingStatusAriaLabel: string;
  suppressAssistantStatus?: boolean;
  isThinkingLabelExpanded: boolean;
  onToggleThinkingLabel: () => void;
  latestDisplayedMessageId: string | null;
  renderAssistantAvatar: (
    metadata?: Record<string, unknown> | null,
    messageAgentIdentity?: AssistantAgentIdentity | null,
    options?: AssistantAvatarRenderOptions,
  ) => JSX.Element;
}) {
  const showAssistantStatus =
    isAssistantTyping && !isAssistantTypingCoveredByJobThreadPreview && !suppressAssistantStatus;
  const usesCanonicalOcto = usesCanonicalOctoAvatar({
    handle: typingAgentHandle,
    avatarSeed: typingAgentAvatarSeed,
  });
  const showCompactThinkingOcto = hasMultipleTypingAgents
    ? typingAgents.some((agent) => agent.isThinking && usesCanonicalOctoAvatar(agent))
    : usesCanonicalOcto && typingIndicatorState?.phase === "thinking";
  const assistantStatusSnapshot = useMemo<AssistantTypingStatusSnapshot>(
    () => ({
      phase: typingIndicatorState?.phase ?? null,
      label:
        typingIndicatorState?.label && !hasMultipleTypingAgents
          ? typingIndicatorState.label
          : typingStatusLabel,
      ariaLabel: typingStatusAriaLabel,
      expanded: isThinkingLabelExpanded,
      clickable: Boolean(typingIndicatorState?.label && !hasMultipleTypingAgents),
      indicator:
        !hasMultipleTypingAgents && typingIndicatorState?.phase === "compacting" ? (
          <CompressLines
            className="h-3.5 w-3.5 flex-shrink-0 text-slate-500 dark:text-slate-300"
            aria-hidden="true"
          />
        ) : showCompactThinkingOcto ? (
          <span
            data-testid="assistant-thinking-octo-compact"
            aria-hidden="true"
            className="block h-4 w-4 flex-shrink-0 text-brand-ink dark:text-brand-paper sm:hidden"
          >
            <OctoMark className="h-full w-full" motion="thinking" scrollReactive />
          </span>
        ) : null,
    }),
    [
      hasMultipleTypingAgents,
      isThinkingLabelExpanded,
      showCompactThinkingOcto,
      typingIndicatorState?.label,
      typingIndicatorState?.phase,
      typingStatusAriaLabel,
      typingStatusLabel,
    ],
  );
  const [lingeringAssistantStatus, setLingeringAssistantStatus] =
    useState<AssistantTypingStatusSnapshot | null>(null);
  const latestDisplayedMessageIdRef = useRef(latestDisplayedMessageId);
  // The latest message when the status row appeared. The hidden spacer that
  // outlives the status exists to hold the place of a reply that has not
  // landed yet; when the reply landed while the status was up, the spacer
  // is a second octo avatar under a finished answer, for up to twelve
  // seconds.
  const statusAnchorMessageIdRef = useRef<string | null>(null);
  const wasShowingAssistantStatusRef = useRef(false);

  useEffect(() => {
    if (showAssistantStatus) {
      if (!wasShowingAssistantStatusRef.current) {
        wasShowingAssistantStatusRef.current = true;
        statusAnchorMessageIdRef.current = latestDisplayedMessageId ?? null;
      }
      setLingeringAssistantStatus(assistantStatusSnapshot);
      return;
    }
    wasShowingAssistantStatusRef.current = false;

    if (!lingeringAssistantStatus) {
      return;
    }
    if ((latestDisplayedMessageId ?? null) !== statusAnchorMessageIdRef.current) {
      setLingeringAssistantStatus(null);
      return;
    }

    const timeoutId = window.setTimeout(() => {
      setLingeringAssistantStatus(null);
    }, ASSISTANT_STATUS_LINGER_MS);

    return () => window.clearTimeout(timeoutId);
  }, [
    assistantStatusSnapshot,
    latestDisplayedMessageId,
    lingeringAssistantStatus,
    showAssistantStatus,
  ]);

  useLayoutEffect(() => {
    if (latestDisplayedMessageIdRef.current === latestDisplayedMessageId) {
      return;
    }
    latestDisplayedMessageIdRef.current = latestDisplayedMessageId;
    setLingeringAssistantStatus(null);
  }, [latestDisplayedMessageId]);

  useLayoutEffect(() => {
    if (!suppressAssistantStatus) {
      return;
    }
    setLingeringAssistantStatus(null);
  }, [suppressAssistantStatus]);

  const assistantStatusToRender = showAssistantStatus
    ? assistantStatusSnapshot
    : lingeringAssistantStatus;
  const assistantAvatarMotion =
    showAssistantStatus && assistantStatusToRender?.phase === "thinking" ? "thinking" : "idle";

  return (
    <>
      {peerTypingLabel ? (
        <ChatBubbleRow
          align="left"
          speakerMarker={{ kind: "boundary" }}
          avatar={(
            <div className="self-center">
              <ChatMessageAvatar kind="human" />
            </div>
          )}
        >
          <ChatActivityBubble
            testId="human-typing-indicator"
            label={peerTypingLabel}
            surfaceTone="default"
            width="peer"
            density="comfortable"
            dotSize="md"
            contentGapClassName="gap-2"
            className="text-slate-500 dark:text-slate-400"
          />
        </ChatBubbleRow>
      ) : null}
      {assistantStatusToRender ? (
        <ChatBubbleRow
          align="left"
          collapseAvatarOnNarrow
          speakerMarker={
            hasMultipleTypingAgents
              ? { kind: "boundary" }
              : {
                  kind: "assistant",
                  handle: typingAgentHandle,
                  avatarSeed: typingAgentAvatarSeed || typingAgentHandle,
                }
          }
          avatar={(
            <div className="self-center">
              {hasMultipleTypingAgents ? (
                <span aria-hidden="true" className="relative h-8 w-12 shrink-0">
                  {typingAgents.slice(0, 2).map((agent, index) => (
                    <span
                      key={`typing-agent-${agent.handle}`}
                      className={`absolute top-0 ${index === 0 ? "left-0" : "left-4"}`}
                    >
                      <ChatMessageAvatar
                        kind="assistant"
                        agent={{ handle: agent.handle, avatarSeed: agent.avatarSeed }}
                        motion={showAssistantStatus && agent.isThinking ? "thinking" : "idle"}
                        scrollReactive
                      />
                    </span>
                  ))}
                </span>
              ) : (
                renderAssistantAvatar(
                  null,
                  { handle: typingAgentHandle, avatarSeed: typingAgentAvatarSeed },
                  { motion: assistantAvatarMotion, scrollReactive: true },
                )
              )}
            </div>
          )}
        >
          <AssistantTypingStatusLine
            snapshot={assistantStatusToRender}
            hidden={!showAssistantStatus}
            onToggleThinkingLabel={onToggleThinkingLabel}
          />
        </ChatBubbleRow>
      ) : null}
    </>
  );
}
