import { useEffect, useLayoutEffect, useMemo, useRef, useState, type JSX, type ReactNode } from "react";
import { CompressLines } from "iconoir-react";
import { AI_TILE_SHAPE_CLASS } from "../../../components/OctoCoin";
import { OCTO_AVATAR_SRC, resolveAgentAvatarImageSrc } from "../../../utils/agentAvatar";
import { ChatActivityBubble } from "./ChatActivityBubble";
import { ChatBubbleRow } from "./ChatBubbleRow";
import { ChatMessageAvatar } from "./ChatMessageAvatar";
import type {
  AssistantAgentIdentity,
  AssistantAvatarRenderOptions,
  AssistantTypingAgent,
} from "./chatAssistantIdentity";
import type { TypingIndicatorPhase, TypingIndicatorState } from "./typingIndicatorState";
import { useSteadyActivityLabel } from "./useSteadyActivityLabel";

type AssistantTypingStatusSnapshot = {
  phase: TypingIndicatorPhase | null;
  label: string;
  ariaLabel: string;
  expanded: boolean;
  clickable: boolean;
  wraps: boolean;
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
  // The same steady label as the turn's own line, which takes over from this
  // row: a turn opens with one "Starting…", not three labels in a second.
  // The runtime-busy notice (the one label that wraps) asks the person to
  // act, so it never waits behind the label before it.
  const label = useSteadyActivityLabel(snapshot.label, !hidden, snapshot.wraps);
  // A screen reader hears the label on screen: the words that came with it,
  // not those of a newer label the row still holds back.
  const ariaLabels = useRef(new Map<string, string>());
  ariaLabels.current.set(snapshot.label, snapshot.ariaLabel);
  for (const key of [...ariaLabels.current.keys()]) {
    if (key !== label && key !== snapshot.label) ariaLabels.current.delete(key);
  }
  const ariaLabel = ariaLabels.current.get(label) ?? snapshot.ariaLabel;
  // One line in a fixed box, whatever the label: a multi-agent count or a
  // fallback that wrapped at phone width changed the row's height each time
  // the runs changed. Only the runtime-busy notice, a sentence to read, wraps.
  const labelClassName = snapshot.wraps
    ? ""
    : snapshot.clickable && snapshot.expanded
      ? "overflow-x-auto whitespace-nowrap"
      : "truncate";

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
      {!hidden ? <span className="sr-only">{ariaLabel}</span> : null}
      {!hidden ? snapshot.indicator : null}
      <span
        className={["instafy-status-sweep min-w-0 max-w-full text-xs", labelClassName].join(" ")}
        data-sweep-text={label}
        title={snapshot.wraps ? undefined : label}
        aria-hidden="true"
      >
        {label}
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
  latestDisplayedMessageEndsActiveTurn = false,
  typingStatusWraps = false,
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
  /** The newest row is already the reply of a run this row speaks for. */
  latestDisplayedMessageEndsActiveTurn?: boolean;
  /** The label is the runtime-busy notice, which wraps instead of truncating. */
  typingStatusWraps?: boolean;
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
  const compactThinkingOcto = hasMultipleTypingAgents
    ? typingAgents.find((agent) => agent.isThinking && usesCanonicalOctoAvatar(agent)) ?? null
    : usesCanonicalOcto && typingIndicatorState?.phase === "thinking"
      ? { handle: typingAgentHandle, avatarSeed: typingAgentAvatarSeed }
      : null;
  // Strings rather than the object keep the status snapshot memo stable.
  const compactThinkingOctoHandle = compactThinkingOcto?.handle ?? null;
  const compactThinkingOctoAvatarSeed = compactThinkingOcto?.avatarSeed ?? null;
  const assistantStatusSnapshot = useMemo<AssistantTypingStatusSnapshot>(
    () => ({
      phase: typingIndicatorState?.phase ?? null,
      // The words are the panel's: one "Starting…" until the turn's first step.
      label: typingStatusLabel,
      ariaLabel: typingStatusAriaLabel,
      expanded: isThinkingLabelExpanded,
      // Only the run's own words (a run held for an approval) can run long enough to expand.
      clickable: Boolean(
        typingIndicatorState?.label && !hasMultipleTypingAgents && typingStatusLabel === typingIndicatorState.label,
      ),
      wraps: typingStatusWraps,
      indicator:
        !hasMultipleTypingAgents && typingIndicatorState?.phase === "compacting" ? (
          <CompressLines
            className="h-3.5 w-3.5 flex-shrink-0 text-slate-500 dark:text-slate-300"
            aria-hidden="true"
          />
        ) : compactThinkingOctoHandle !== null ? (
          // Phones hide the avatar gutter, so this is the row's only face. It
          // is the same chat face as the gutter and the posted reply header,
          // at the header's inline size, so Octo keeps its coin (OctoCoin,
          // docs/Brand.md) instead of turning into the bare logo mark.
          <span className="flex flex-shrink-0 sm:hidden">
            <ChatMessageAvatar
              kind="assistant"
              agent={{
                handle: compactThinkingOctoHandle,
                avatarSeed: compactThinkingOctoAvatarSeed,
              }}
              motion="thinking"
              scrollReactive
              size="xs"
              testId="assistant-thinking-octo-compact"
            />
          </span>
        ) : null,
    }),
    [
      compactThinkingOctoAvatarSeed,
      compactThinkingOctoHandle,
      hasMultipleTypingAgents,
      isThinkingLabelExpanded,
      typingIndicatorState?.label,
      typingIndicatorState?.phase,
      typingStatusAriaLabel,
      typingStatusLabel,
      typingStatusWraps,
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
  // Whether that anchor was already the reply of a run the status spoke for:
  // then no reply is on its way and the spacer has no place to hold.
  const statusAnchorEndsTurnRef = useRef(false);
  const wasShowingAssistantStatusRef = useRef(false);

  useEffect(() => {
    if (showAssistantStatus) {
      if (!wasShowingAssistantStatusRef.current) {
        wasShowingAssistantStatusRef.current = true;
        statusAnchorMessageIdRef.current = latestDisplayedMessageId ?? null;
        statusAnchorEndsTurnRef.current = false;
      }
      if (
        latestDisplayedMessageEndsActiveTurn &&
        (latestDisplayedMessageId ?? null) === statusAnchorMessageIdRef.current
      ) {
        statusAnchorEndsTurnRef.current = true;
      }
      setLingeringAssistantStatus(assistantStatusSnapshot);
      return;
    }
    wasShowingAssistantStatusRef.current = false;

    if (!lingeringAssistantStatus) {
      return;
    }
    if (
      (latestDisplayedMessageId ?? null) !== statusAnchorMessageIdRef.current ||
      statusAnchorEndsTurnRef.current
    ) {
      setLingeringAssistantStatus(null);
      return;
    }

    const timeoutId = window.setTimeout(() => {
      setLingeringAssistantStatus(null);
    }, ASSISTANT_STATUS_LINGER_MS);

    return () => window.clearTimeout(timeoutId);
  }, [
    assistantStatusSnapshot,
    latestDisplayedMessageEndsActiveTurn,
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
                <span aria-hidden="true" className="flex h-8 shrink-0 -space-x-4">
                  {typingAgents.slice(0, 2).map((agent) => (
                    <span
                      key={`typing-agent-${agent.handle}`}
                      data-testid="assistant-typing-stack-face"
                      // The same separator the conversation roster paints on
                      // each face: a thin ring in the chat surface's own
                      // background keeps the overlapping tiles apart and
                      // follows their corners.
                      className={`shrink-0 ${AI_TILE_SHAPE_CLASS} *:ring-1 *:ring-white dark:*:ring-[var(--color-studio-dark-panel)]`}
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
