import {
  useLayoutEffect,
  useState,
  type CSSProperties,
  type MouseEventHandler,
  type ReactNode,
  type RefObject,
  type UIEventHandler,
} from "react";
import "./ChatTranscriptViewport.css";
import "./ChatReadingLayout.css";

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
  identityLayout = "participants",
  onContextMenu,
  onScroll,
  onScrollbarWidthChange,
  scrollContainerRef,
  scrollPaddingBottom,
}: {
  ariaLabel: string;
  children: ReactNode;
  header?: ReactNode;
  identityLayout?: "solo" | "participants";
  onContextMenu?: MouseEventHandler<HTMLDivElement>;
  onScroll?: UIEventHandler<HTMLDivElement>;
  onScrollbarWidthChange?: (width: number) => void;
  scrollContainerRef: RefObject<HTMLDivElement | null>;
  scrollPaddingBottom?: CSSProperties["paddingBottom"] | null;
}) {
  const [scrollbarWidth, setScrollbarWidth] = useState(0);
  useLayoutEffect(() => {
    const scroller = scrollContainerRef.current;
    if (!scroller) return;
    const measure = () => {
      const width = Math.max(0, scroller.offsetWidth - scroller.clientWidth);
      setScrollbarWidth(width);
      onScrollbarWidthChange?.(width);
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(scroller);
    window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [onScrollbarWidthChange, scrollContainerRef]);

  const scrollStyle: CSSProperties = {};
  if (header) {
    scrollStyle.paddingTop = CHAT_TRANSCRIPT_HEADER_INSET_PX;
    scrollStyle.scrollPaddingTop = CHAT_TRANSCRIPT_HEADER_INSET_PX;
  }
  if (scrollPaddingBottom) {
    scrollStyle.paddingBottom = scrollPaddingBottom;
  }

  return (
    <div className="chat-transcript-viewport relative flex min-h-0 flex-1 flex-col" data-testid="chat-transcript-viewport" data-chat-identity-layout={identityLayout}>
      {header ? (
        <div className="chat-transcript-header pointer-events-none absolute inset-x-0 top-0 z-10" data-testid="chat-transcript-header" style={{ paddingInlineEnd: scrollbarWidth }}>
          {header}
        </div>
      ) : null}
      <div
        className={["studio-scrollbar chat-transcript-scroll chat-reading-inset min-h-0 flex-1 overflow-x-hidden overflow-y-auto pb-4 pt-2 sm:pb-2", header ? "chat-transcript-scroll-with-header" : ""].join(" ")}
        data-testid="chat-message-scroll"
        aria-label={ariaLabel}
        role="log"
        tabIndex={-1}
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
