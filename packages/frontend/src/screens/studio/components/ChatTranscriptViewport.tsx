import type {
  CSSProperties,
  MouseEventHandler,
  ReactNode,
  RefObject,
  UIEventHandler,
} from "react";
import { AssistantSpeakerIdentityPill } from "./AssistantSpeakerIdentityPill";
import { ChatColumn } from "./ChatColumn";
import { HumanSpeakerIdentityPill } from "./chatHumanIdentity";
import type { StickyChatSpeaker } from "./chatSpeakerMarker";

/**
 * Height of the dissolve at the transcript's top edge. The sticky speaker pill
 * sits 8px (the scroller's top padding) below that edge and is ~30px tall, so
 * 40px runs the fade from nothing at the edge to fully opaque just under the
 * pill's bottom edge.
 */
export const CHAT_TRANSCRIPT_FADE_PX = 40;

/**
 * Alpha-only mask, so it is the same in both themes: whatever scrolls under
 * the pill dissolves into the panel instead of being painted over.
 */
export const CHAT_TRANSCRIPT_FADE_MASK_IMAGE = `linear-gradient(to bottom, transparent 0, black ${CHAT_TRANSCRIPT_FADE_PX}px)`;

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
 * The transcript scroller plus the sticky speaker pill that floats over its
 * top edge.
 *
 * Nothing is painted over the transcript. Three backdrop bands behind the pill
 * (a solid hold, a tint fade, a backdrop blur) all read as a grey area above
 * the chat, because any overlay on a dark panel smears bright text into haze.
 * Instead the scroller itself carries an alpha mask, anchored to its own box
 * (not the scrolled content), so whatever passes under the pill dissolves at
 * the visible top edge — and the pill lives OUTSIDE the masked element, as an
 * absolutely-positioned sibling, so it is never faded with the text.
 *
 * The mask is on exactly when a sticky speaker is present: the pill is the
 * reason the fade exists, and without one the first message runs to the top
 * edge unfaded.
 */
export function ChatTranscriptViewport({
  ariaLabel,
  children,
  onContextMenu,
  onScroll,
  scrollContainerRef,
  scrollPaddingBottom,
  stickySpeaker,
  stickySpeakerOverlayRef,
}: {
  ariaLabel: string;
  children: ReactNode;
  onContextMenu?: MouseEventHandler<HTMLDivElement>;
  onScroll?: UIEventHandler<HTMLDivElement>;
  scrollContainerRef: RefObject<HTMLDivElement | null>;
  scrollPaddingBottom?: CSSProperties["paddingBottom"] | null;
  stickySpeaker: StickyChatSpeaker | null;
  stickySpeakerOverlayRef?: RefObject<HTMLDivElement | null>;
}) {
  const fadeActive = stickySpeaker !== null;
  const scrollStyle: CSSProperties = {};
  if (scrollPaddingBottom) {
    scrollStyle.paddingBottom = scrollPaddingBottom;
  }
  if (fadeActive) {
    scrollStyle.maskImage = CHAT_TRANSCRIPT_FADE_MASK_IMAGE;
    scrollStyle.WebkitMaskImage = CHAT_TRANSCRIPT_FADE_MASK_IMAGE;
  }

  return (
    <div className="relative flex min-h-0 flex-1 flex-col" data-testid="chat-transcript-viewport">
      <div
        className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto px-3 pb-4 pt-2 sm:px-4 sm:pb-2"
        data-testid="chat-message-scroll"
        data-chat-transcript-fade={fadeActive ? "true" : undefined}
        aria-label={ariaLabel}
        role="log"
        onScroll={onScroll}
        onContextMenu={onContextMenu}
        ref={scrollContainerRef}
        style={scrollStyle}
      >
        {children}
      </div>
      {/* Same horizontal inset and top padding as the scroller, so the pill
          sits exactly where the inline speaker label it covers would be. The
          layer never takes pointer events: text under the pill stays
          selectable, as it was when the pill scrolled inside the transcript. */}
      <div
        className="pointer-events-none absolute inset-x-0 top-0 z-30 px-3 pt-2 sm:px-4"
        data-testid="chat-speaker-sticky-layer"
      >
        <ChatColumn>
          <ChatSpeakerStickyOverlay ref={stickySpeakerOverlayRef} speaker={stickySpeaker} />
        </ChatColumn>
      </div>
    </div>
  );
}
