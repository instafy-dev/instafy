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
