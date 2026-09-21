import {
  useRef,
  type CSSProperties,
  type MouseEventHandler,
  type ReactNode,
  type RefObject,
  type UIEventHandler,
} from "react";
import { AssistantSpeakerIdentityPill } from "./AssistantSpeakerIdentityPill";
import { HumanSpeakerIdentityPill } from "./chatHumanIdentity";
import type { StickyChatSpeaker } from "./chatSpeakerMarker";
import "./ChatTranscriptViewport.css";

// The 32px presence controls have 8px above and below them. Keep transcript
// padding and programmatic message reveals below the same readable edge.
export const CHAT_TRANSCRIPT_HEADER_INSET_PX = 48;

export function ChatSpeakerStickyOverlay({
  ref,
  speaker,
}: {
  ref?: RefObject<HTMLDivElement | null>;
  speaker: StickyChatSpeaker | null;
}) {
  // The pill fades rather than pops, and the roster beside it must not move
  // when it does. Two things keep the box the same height with and without
  // a speaker: the last speaker stays rendered while hidden, so the fade-out
  // has a pill to fade and the box keeps its height, and before any speaker
  // has shown the box reserves the pill's height, which is its face plus a
  // 1px border each side: 28px inline below sm, 32px beside the avatar
  // gutter at sm+ (see SPEAKER_PILL_CLASS_NAME). Measured before this, the
  // roster row grew from 40px to 44px when a pill appeared and the roster
  // avatars dropped 2px with it.
  const lastSpeakerRef = useRef<StickyChatSpeaker | null>(null);
  if (speaker) {
    lastSpeakerRef.current = speaker;
  }
  const shown = speaker ?? lastSpeakerRef.current;
  return (
    <div
      ref={ref}
      aria-hidden={speaker ? undefined : "true"}
      data-chat-speaker-overlay="true"
      data-testid="chat-speaker-sticky-overlay"
      className="relative min-h-[30px] sm:min-h-[34px]"
    >
      <div
        className={[
          "relative flex w-fit max-w-full transition-[opacity,transform] duration-150 ease-out",
          speaker ? "translate-y-0 opacity-100" : "-translate-y-1 opacity-0",
        ].join(" ")}
      >
        {shown ? (
          shown.kind === "assistant" ? (
            <AssistantSpeakerIdentityPill
              handle={shown.handle}
              agentIdentity={{ handle: shown.handle, avatarSeed: shown.avatarSeed }}
            />
          ) : (
            <HumanSpeakerIdentityPill avatarSeed={shown.avatarSeed} label={shown.label} />
          )
        ) : null}
      </div>
    </div>
  );
}

/**
 * The message scroll container.
 *
 * Presence stays fixed while messages scroll behind it. Fade the transcript
 * itself to the existing conversation surface; painting a tinted backdrop
 * here produces a separate grey band in both themes.
 */
export function ChatTranscriptViewport({
  ariaLabel,
  children,
  header,
  onContextMenu,
  onScroll,
  scrollContainerRef,
  scrollPaddingBottom,
}: {
  ariaLabel: string;
  children: ReactNode;
  header?: ReactNode;
  onContextMenu?: MouseEventHandler<HTMLDivElement>;
  onScroll?: UIEventHandler<HTMLDivElement>;
  scrollContainerRef: RefObject<HTMLDivElement | null>;
  scrollPaddingBottom?: CSSProperties["paddingBottom"] | null;
}) {
  const scrollStyle: CSSProperties = {};
  if (header) {
    scrollStyle.paddingTop = CHAT_TRANSCRIPT_HEADER_INSET_PX;
    scrollStyle.scrollPaddingTop = CHAT_TRANSCRIPT_HEADER_INSET_PX;
  }
  if (scrollPaddingBottom) {
    scrollStyle.paddingBottom = scrollPaddingBottom;
  }

  return (
    <div className="relative flex min-h-0 flex-1 flex-col" data-testid="chat-transcript-viewport">
      {header ? (
        <div className="chat-transcript-header pointer-events-none absolute inset-x-0 top-0 z-10" data-testid="chat-transcript-header">
          {header}
        </div>
      ) : null}
      <div
        className={["min-h-0 flex-1 overflow-x-hidden overflow-y-auto px-3 pb-4 pt-2 sm:px-4 sm:pb-2", header ? "chat-transcript-scroll-with-header" : ""].join(" ")}
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
