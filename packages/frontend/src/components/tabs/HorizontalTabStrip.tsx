import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

export type HorizontalTabStripDirection = -1 | 1;

export interface HorizontalTabStripScrollControlProps {
  direction: HorizontalTabStripDirection;
  canScroll: boolean;
  hasOverflow: boolean;
  scrollByDirection: (direction: HorizontalTabStripDirection) => void;
}

interface HorizontalTabStripProps {
  children: ReactNode;
  className?: string;
  viewportClassName?: string;
  contentClassName?: string;
  overflowActions?: ReactNode;
  inlineOverflowActionsClassName?: string;
  overflowActionsClassName?: string;
  inlineOverflowActionsTestId?: string;
  overflowActionsTestId?: string;
  activeItemId?: string | null;
  activeItemAttribute?: string;
  renderScrollControl?: (
    props: HorizontalTabStripScrollControlProps,
  ) => ReactNode;
  minScrollDistancePx?: number;
  scrollDistanceRatio?: number;
  enableWheelHorizontal?: boolean;
  testId?: string;
}

export function HorizontalTabStrip({
  children,
  className,
  viewportClassName = "no-scrollbar min-w-0 flex-1 overflow-x-auto",
  contentClassName = "flex w-max items-end pr-1",
  overflowActions,
  inlineOverflowActionsClassName = "flex items-end",
  overflowActionsClassName = "flex flex-none items-end",
  inlineOverflowActionsTestId,
  overflowActionsTestId,
  activeItemId = null,
  activeItemAttribute = "data-tab-id",
  renderScrollControl,
  minScrollDistancePx = 160,
  scrollDistanceRatio = 0.7,
  enableWheelHorizontal = true,
  testId,
}: HorizontalTabStripProps) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const [hasOverflow, setHasOverflow] = useState(false);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);

  const syncScrollState = useCallback(() => {
    const node = viewportRef.current;
    if (!node) {
      setHasOverflow(false);
      setCanScrollLeft(false);
      setCanScrollRight(false);
      return;
    }
    const maxScrollLeft = Math.max(0, node.scrollWidth - node.clientWidth);
    const overflow = maxScrollLeft > 1;
    setHasOverflow(overflow);
    if (!overflow) {
      setCanScrollLeft(false);
      setCanScrollRight(false);
      return;
    }
    setCanScrollLeft(node.scrollLeft > 1);
    setCanScrollRight(node.scrollLeft < maxScrollLeft - 1);
  }, []);

  const scrollByDirection = useCallback(
    (direction: HorizontalTabStripDirection) => {
      const node = viewportRef.current;
      if (!node) {
        return;
      }
      const distance = Math.max(
        minScrollDistancePx,
        Math.floor(node.clientWidth * scrollDistanceRatio),
      );
      node.scrollBy({ left: direction * distance, behavior: "smooth" });
    },
    [minScrollDistancePx, scrollDistanceRatio],
  );

  useEffect(() => {
    const node = viewportRef.current;
    if (!node || !enableWheelHorizontal) {
      return;
    }
    const handleWheel = (event: WheelEvent) => {
      if (node.scrollWidth <= node.clientWidth) {
        return;
      }
      if (event.shiftKey) {
        return;
      }
      if (Math.abs(event.deltaX) > 0) {
        return;
      }
      node.scrollLeft += event.deltaY;
      syncScrollState();
      event.preventDefault();
    };
    node.addEventListener("wheel", handleWheel, { passive: false });
    return () => {
      node.removeEventListener("wheel", handleWheel);
    };
  }, [enableWheelHorizontal, syncScrollState]);

  useEffect(() => {
    const node = viewportRef.current;
    if (!node) {
      return;
    }
    syncScrollState();

    const handleScroll = () => {
      syncScrollState();
    };
    const handleResize = () => {
      syncScrollState();
    };
    node.addEventListener("scroll", handleScroll, { passive: true });
    window.addEventListener("resize", handleResize);

    let resizeObserver: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      resizeObserver = new ResizeObserver(() => {
        syncScrollState();
      });
      resizeObserver.observe(node);
      const contentNode = node.firstElementChild;
      if (contentNode instanceof HTMLElement) {
        resizeObserver.observe(contentNode);
      }
    }

    return () => {
      node.removeEventListener("scroll", handleScroll);
      window.removeEventListener("resize", handleResize);
      resizeObserver?.disconnect();
    };
  }, [syncScrollState]);

  useEffect(() => {
    syncScrollState();
  }, [children, overflowActions, syncScrollState]);

  useEffect(() => {
    if (!activeItemId) {
      return;
    }
    const node = viewportRef.current;
    if (!node) {
      return;
    }
    const candidates = Array.from(node.querySelectorAll<HTMLElement>(`[${activeItemAttribute}]`));
    const activeNode = candidates.find(
      (candidate) => candidate.getAttribute(activeItemAttribute) === activeItemId,
    );
    activeNode?.scrollIntoView({ block: "nearest", inline: "nearest" });
    syncScrollState();
  }, [activeItemAttribute, activeItemId, syncScrollState]);

  const hasOverflowActions = Boolean(overflowActions);
  const showInlineOverflowActions = hasOverflowActions && !hasOverflow;
  const showOverflowOverflowActions = hasOverflowActions && hasOverflow;
  const showLeftFade = hasOverflow && canScrollLeft;
  const showRightFade = hasOverflow && canScrollRight;

  const leftControl = useMemo(() => {
    if (!hasOverflow || !renderScrollControl) {
      return null;
    }
    return renderScrollControl({
      direction: -1,
      canScroll: canScrollLeft,
      hasOverflow,
      scrollByDirection,
    });
  }, [canScrollLeft, hasOverflow, renderScrollControl, scrollByDirection]);

  const rightControl = useMemo(() => {
    if (!hasOverflow || !renderScrollControl) {
      return null;
    }
    return renderScrollControl({
      direction: 1,
      canScroll: canScrollRight,
      hasOverflow,
      scrollByDirection,
    });
  }, [canScrollRight, hasOverflow, renderScrollControl, scrollByDirection]);

  return (
    <div
      className={[
        "relative flex min-w-0 flex-1 self-stretch items-end gap-1",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
      data-testid={testId}
    >
      {leftControl}
      <div className="relative min-w-0 flex-1">
        <div ref={viewportRef} className={viewportClassName}>
          <div className={contentClassName}>
            {children}
            {showInlineOverflowActions ? (
              <div
                className={inlineOverflowActionsClassName}
                data-testid={inlineOverflowActionsTestId}
              >
                {overflowActions}
              </div>
            ) : null}
          </div>
        </div>
        {showLeftFade ? (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-y-0 left-0 z-10 w-8 bg-gradient-to-r from-white via-white/92 to-transparent dark:from-slate-950 dark:via-slate-950/92 dark:to-transparent"
          />
        ) : null}
        {showRightFade ? (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-y-0 right-0 z-10 w-10 bg-gradient-to-l from-white via-white/92 to-transparent dark:from-slate-950 dark:via-slate-950/92 dark:to-transparent"
          />
        ) : null}
      </div>
      {showOverflowOverflowActions ? (
        <div
          className={["relative z-20", overflowActionsClassName].filter(Boolean).join(" ")}
          data-testid={overflowActionsTestId}
        >
          {overflowActions}
        </div>
      ) : null}
      {rightControl}
    </div>
  );
}
