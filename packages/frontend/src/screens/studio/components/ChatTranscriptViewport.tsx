import {
  type CSSProperties,
  type MouseEventHandler,
  type ReactNode,
  type RefObject,
  type UIEventHandler,
} from "react";
import "./ChatTranscriptViewport.css";

// The 32px presence controls have 8px above and below them. Keep transcript
// padding and programmatic message reveals below the same readable edge.
const CHAT_TRANSCRIPT_HEADER_INSET_PX = 48;

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
