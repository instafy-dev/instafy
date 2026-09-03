import type {
  CSSProperties,
  MouseEventHandler,
  ReactNode,
  RefObject,
  UIEventHandler,
} from "react";
import { AssistantSpeakerIdentityPill } from "./AssistantSpeakerIdentityPill";
import { HumanSpeakerIdentityPill } from "./chatHumanIdentity";
import type { StickyChatSpeaker } from "./chatSpeakerMarker";

export function ChatSpeakerStickyOverlay({
  ref,
  speaker,
}: {
  ref?: RefObject<HTMLDivElement | null>;
  speaker: StickyChatSpeaker | null;
}) {
  return (
    <div
      ref={ref}
      aria-hidden={speaker ? undefined : "true"}
      data-chat-speaker-overlay="true"
      data-testid="chat-speaker-sticky-overlay"
      className="relative"
    >
      <div
        className={[
          "relative w-fit max-w-full transition-[opacity,transform] duration-150 ease-out",
          speaker ? "translate-y-0 opacity-100" : "-translate-y-1 opacity-0",
        ].join(" ")}
      >
        {speaker ? (
          speaker.kind === "assistant" ? (
            <AssistantSpeakerIdentityPill
              handle={speaker.handle}
              agentIdentity={{ handle: speaker.handle, avatarSeed: speaker.avatarSeed }}
            />
          ) : (
            <HumanSpeakerIdentityPill avatarSeed={speaker.avatarSeed} label={speaker.label} />
          )
        ) : null}
      </div>
    </div>
  );
}

/**
 * The message scroll container.
 *
 * Presence — including the sticky speaker pill — lives in the roster row
 * above this component, not here: ChatPanel's own comment on that row states
 * the rule: one placement at every width, a flow row (never an overlay) so it
 * cannot cover message text, and outside the scroller so it never scrolls
 * away. Three backdrop bands tried behind a floating pill (a solid hold, a
 * tint fade, a backdrop blur), and even a later top-edge content mask that
 * replaced them, all read as a grey band above the chat. This scroller is
 * plain and fully opaque: text simply scrolls under the panel edge like any
 * other scroll container.
 */
export function ChatTranscriptViewport({
  ariaLabel,
  children,
  onContextMenu,
  onScroll,
  scrollContainerRef,
  scrollPaddingBottom,
}: {
  ariaLabel: string;
  children: ReactNode;
  onContextMenu?: MouseEventHandler<HTMLDivElement>;
  onScroll?: UIEventHandler<HTMLDivElement>;
  scrollContainerRef: RefObject<HTMLDivElement | null>;
  scrollPaddingBottom?: CSSProperties["paddingBottom"] | null;
}) {
  const scrollStyle: CSSProperties = {};
  if (scrollPaddingBottom) {
    scrollStyle.paddingBottom = scrollPaddingBottom;
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="chat-transcript-viewport">
      <div
        className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto px-3 pb-4 pt-2 sm:px-4 sm:pb-2"
        data-testid="chat-message-scroll"
        aria-label={ariaLabel}
        role="log"
        onScroll={onScroll}
        onContextMenu={onContextMenu}
        ref={scrollContainerRef}
        style={scrollStyle}
      >
        {children}
      </div>
    </div>
  );
}
