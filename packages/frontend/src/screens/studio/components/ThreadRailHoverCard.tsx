import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type MutableRefObject,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";

// The rail chip hover card mirrors the workspace-file preview's interaction
// grammar (ChatMessageContent): the same open/close delays, the same floating
// surface styling, Escape and outside-pointerdown dismissal, and the same
// composer-aware placement — so the two previews feel like one system (#179).
const THREAD_RAIL_HOVER_CARD_WIDTH_PX = 320;
const THREAD_RAIL_HOVER_CARD_MAX_HEIGHT_PX = 240;
const THREAD_RAIL_HOVER_CARD_OPEN_DELAY_MS = 220;
const THREAD_RAIL_HOVER_CARD_CLOSE_DELAY_MS = 120;

type ThreadRailHoverCardPosition = {
  left: number;
  top?: number;
  bottom?: number;
  width: number;
};

export type ThreadRailHoverCardContent = {
  // The step's history label (resolveThreadCompactUpdateHistoryLabel) — the
  // card's header row.
  header: string;
  // Actor handle rendered next to the header when the step came from a
  // specific agent.
  headerDetail?: string | null;
  // Short excerpt of what the step did. The card is a scent, not a viewer.
  bodyText?: string | null;
  // One-line-per-step listing (the overflow "+N" chip's elided labels).
  bodyLines?: string[] | null;
  // Monospace body for code-shaped excerpts, matching the diff preview.
  mono?: boolean;
};

function hasHoverCardBody(card: ThreadRailHoverCardContent | null): card is ThreadRailHoverCardContent {
  if (!card) {
    return false;
  }
  if (typeof card.bodyText === "string" && card.bodyText.trim().length > 0) {
    return true;
  }
  return Array.isArray(card.bodyLines) && card.bodyLines.length > 0;
}

function resolveThreadRailHoverCardPosition(anchor: HTMLElement): ThreadRailHoverCardPosition {
  const rect = anchor.getBoundingClientRect();
  const viewportWidth = typeof window === "undefined" ? THREAD_RAIL_HOVER_CARD_WIDTH_PX : window.innerWidth;
  const viewportHeight = typeof window === "undefined" ? 720 : window.innerHeight;
  const composerOverlay =
    typeof document === "undefined"
      ? null
      : document.querySelector<HTMLElement>('[data-testid="chat-composer-overlay"]');
  const composerTop = composerOverlay?.getBoundingClientRect().top;
  const lowerBoundary =
    typeof composerTop === "number" && Number.isFinite(composerTop) && composerTop > 0 && composerTop < viewportHeight - 8
      ? Math.max(120, composerTop - 12)
      : viewportHeight;
  const width = Math.min(THREAD_RAIL_HOVER_CARD_WIDTH_PX, Math.max(200, viewportWidth - 24));
  const left = Math.min(Math.max(12, rect.left), Math.max(12, viewportWidth - width - 12));
  const bottomTop = rect.bottom + 8;
  const availableBelow = lowerBoundary - bottomTop;
  const availableAbove = rect.top - 8;

  if (availableBelow >= THREAD_RAIL_HOVER_CARD_MAX_HEIGHT_PX || availableBelow >= availableAbove) {
    return { left, top: bottomTop, width };
  }

  return {
    bottom: Math.max(12, viewportHeight - rect.top + 8),
    left,
    width,
  };
}

// Only one rail card should be visible at a time: adjacent chips overlap, so a
// newly opened card closes whichever chip's card was showing before it.
let closeActiveThreadRailHoverCard: (() => void) | null = null;

export function ThreadRailChipButton({
  card,
  ariaLabel,
  title,
  className,
  style,
  onClick,
  dataCount,
  testId,
  children,
}: {
  card: ThreadRailHoverCardContent | null;
  ariaLabel: string;
  // Native tooltip fallback for chips whose card is suppressed (no derivable
  // excerpt); chips with a card drop it so the two tooltips never stack.
  title?: string;
  className: string;
  style?: CSSProperties;
  onClick?: () => void;
  dataCount?: string;
  testId?: string;
  children: ReactNode;
}) {
  const anchorRef = useRef<HTMLButtonElement | null>(null);
  const cardRef = useRef<HTMLSpanElement | null>(null);
  const openTimerRef = useRef<number | null>(null);
  const closeTimerRef = useRef<number | null>(null);
  const [cardOpen, setCardOpen] = useState(false);
  const [cardPosition, setCardPosition] = useState<ThreadRailHoverCardPosition | null>(null);
  const showCard = hasHoverCardBody(card);

  const clearTimer = useCallback((timerRef: MutableRefObject<number | null>) => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  // Stable identity for the module-level single-open registry and the
  // document-level listeners.
  const closeCardRef = useRef<() => void>(() => {});
  const closeCard = useCallback(() => {
    clearTimer(openTimerRef);
    clearTimer(closeTimerRef);
    setCardOpen(false);
    setCardPosition(null);
    if (closeActiveThreadRailHoverCard === closeCardRef.current) {
      closeActiveThreadRailHoverCard = null;
    }
  }, [clearTimer]);
  useEffect(() => {
    closeCardRef.current = closeCard;
  }, [closeCard]);

  const openCard = useCallback(() => {
    const anchor = anchorRef.current;
    if (!anchor || !showCard) {
      return;
    }
    if (closeActiveThreadRailHoverCard && closeActiveThreadRailHoverCard !== closeCardRef.current) {
      closeActiveThreadRailHoverCard();
    }
    closeActiveThreadRailHoverCard = closeCardRef.current;
    setCardPosition(resolveThreadRailHoverCardPosition(anchor));
    setCardOpen(true);
  }, [showCard]);

  const scheduleClose = useCallback(() => {
    clearTimer(closeTimerRef);
    closeTimerRef.current = window.setTimeout(() => {
      closeCardRef.current();
    }, THREAD_RAIL_HOVER_CARD_CLOSE_DELAY_MS);
  }, [clearTimer]);

  const cancelScheduledClose = useCallback(() => {
    clearTimer(closeTimerRef);
  }, [clearTimer]);

  const handleMouseEnter = useCallback(() => {
    clearTimer(closeTimerRef);
    clearTimer(openTimerRef);
    openTimerRef.current = window.setTimeout(openCard, THREAD_RAIL_HOVER_CARD_OPEN_DELAY_MS);
  }, [clearTimer, openCard]);

  const handleMouseLeave = useCallback(() => {
    clearTimer(openTimerRef);
    scheduleClose();
  }, [clearTimer, scheduleClose]);

  // Hover is a mouse affordance; touch keeps the plain tap-to-toggle (v1).
  const handlePointerEnter = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      if (event.pointerType !== "mouse") {
        return;
      }
      handleMouseEnter();
    },
    [handleMouseEnter],
  );

  const handlePointerLeave = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      if (event.pointerType !== "mouse") {
        return;
      }
      handleMouseLeave();
    },
    [handleMouseLeave],
  );

  // Keyboard focus opens the same card immediately — the chip is the
  // affordance, not the pointer.
  const handleFocus = useCallback(() => {
    clearTimer(closeTimerRef);
    openCard();
  }, [clearTimer, openCard]);

  const handleBlur = useCallback(() => {
    closeCard();
  }, [closeCard]);

  const handleClick = useCallback(() => {
    // Clicking expands the thread (or whatever the chip's action is) — the
    // scent card yields to the real thing.
    closeCard();
    onClick?.();
  }, [closeCard, onClick]);

  useEffect(() => {
    if (!cardOpen) {
      return;
    }
    const updatePosition = () => {
      const anchor = anchorRef.current;
      if (!anchor) {
        return;
      }
      setCardPosition(resolveThreadRailHoverCardPosition(anchor));
    };
    const handlePointerDownOutside = (event: globalThis.PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) {
        return;
      }
      if (anchorRef.current?.contains(target) || cardRef.current?.contains(target)) {
        return;
      }
      closeCardRef.current();
    };
    // Escape mirrors the file-preview card — every dismissible floating
    // surface answers the keyboard.
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        closeCardRef.current();
      }
    };
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    document.addEventListener("pointerdown", handlePointerDownOutside, true);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
      document.removeEventListener("pointerdown", handlePointerDownOutside, true);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [cardOpen]);

  useEffect(() => {
    return () => {
      clearTimer(openTimerRef);
      clearTimer(closeTimerRef);
      if (closeActiveThreadRailHoverCard === closeCardRef.current) {
        closeActiveThreadRailHoverCard = null;
      }
    };
  }, [clearTimer]);

  return (
    <span className="relative inline-flex">
      <button
        ref={anchorRef}
        type="button"
        aria-label={ariaLabel}
        title={showCard ? undefined : title ?? ariaLabel}
        className={className}
        style={style}
        data-count={dataCount}
        data-testid={testId}
        onClick={handleClick}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
        onPointerEnter={handlePointerEnter}
        onPointerLeave={handlePointerLeave}
        onFocus={handleFocus}
        onBlur={handleBlur}
      >
        {children}
      </button>
      {cardOpen && cardPosition && showCard ? (
        <span
          ref={cardRef}
          role="tooltip"
          data-testid="agent-thread-compact-event-preview"
          className="fixed z-50 block overflow-hidden rounded-2xl border border-slate-200 bg-white text-left shadow-xl shadow-slate-950/15 ring-1 ring-slate-950/5 dark:border-[color:var(--color-studio-dark-floating-border)] dark:bg-[var(--color-studio-dark-floating)] dark:shadow-black/25 dark:ring-white/[0.08]"
          style={{
            bottom: cardPosition.bottom,
            left: cardPosition.left,
            top: cardPosition.top,
            width: cardPosition.width,
            maxHeight: THREAD_RAIL_HOVER_CARD_MAX_HEIGHT_PX,
          }}
          onMouseEnter={cancelScheduledClose}
          onMouseLeave={scheduleClose}
        >
          <span className="flex min-w-0 items-baseline gap-1.5 border-b border-slate-200/70 px-3 py-2 dark:border-[color:var(--color-studio-dark-divider)]">
            <span
              className="min-w-0 truncate text-xs font-semibold text-slate-800 dark:text-slate-100"
              data-testid="agent-thread-compact-event-preview-header"
            >
              {card.header}
            </span>
            {card.headerDetail ? (
              <span className="min-w-0 flex-none truncate text-xxs text-slate-500 dark:text-slate-400">
                {card.headerDetail}
              </span>
            ) : null}
          </span>
          <span
            data-testid="agent-thread-compact-event-preview-body"
            className="block max-h-[11rem] overflow-auto px-3 py-2"
          >
            {card.bodyLines && card.bodyLines.length > 0 ? (
              <span className="block text-xs leading-5 text-slate-700 dark:text-slate-200">
                {card.bodyLines.map((line, index) => (
                  <span key={`${line}-${index}`} className="block truncate">
                    {line}
                  </span>
                ))}
              </span>
            ) : (
              <span
                className={
                  card.mono
                    ? "block whitespace-pre-wrap break-words font-mono text-[0.72rem] leading-5 text-slate-700 dark:text-slate-200"
                    : "block whitespace-pre-wrap break-words text-xs leading-5 text-slate-700 dark:text-slate-200"
                }
              >
                {card.bodyText}
              </span>
            )}
          </span>
        </span>
      ) : null}
    </span>
  );
}
