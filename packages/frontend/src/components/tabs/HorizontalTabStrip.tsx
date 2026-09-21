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
  const revealedActiveItemRef = useRef<HTMLElement | null>(null);
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

  const findActiveItem = useCallback(() => {
    const candidates = viewportRef.current?.querySelectorAll<HTMLElement>(`[${activeItemAttribute}]`) ?? [];
    return Array.from(candidates).find(
      (candidate) => candidate.getAttribute(activeItemAttribute) === activeItemId,
    );
  }, [activeItemAttribute, activeItemId]);

  const revealActiveItem = useCallback(() => {
    const node = viewportRef.current;
    // A strip can remain mounted while responsive navigation hides it. Reveal
    // the active item after it has a visible viewport again.
    if (!node || node.clientWidth === 0 || !activeItemId) {
      return;
    }
    const activeNode = findActiveItem();
    if (!activeNode) {
      return;
    }
    const viewportLeft = node.getBoundingClientRect().left + node.clientLeft;
    const viewportRight = viewportLeft + node.clientWidth;
    const activeBounds = activeNode.getBoundingClientRect();
    // Adjust only this strip; scrollIntoView can also move the surrounding page.
    if (activeBounds.left < viewportLeft || activeBounds.width > node.clientWidth) {
      node.scrollLeft += activeBounds.left - viewportLeft;
    } else if (activeBounds.right > viewportRight) {
      node.scrollLeft += activeBounds.right - viewportRight;
    }
    revealedActiveItemRef.current = activeNode;
    syncScrollState();
  }, [activeItemId, findActiveItem, syncScrollState]);

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
      revealActiveItem();
      syncScrollState();
    };
    node.addEventListener("scroll", handleScroll, { passive: true });
    window.addEventListener("resize", handleResize);

    let resizeObserver: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      resizeObserver = new ResizeObserver(handleResize);
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
  }, [revealActiveItem, syncScrollState]);

  useEffect(() => {
    syncScrollState();
    // Restored tabs may arrive after their active ID, including a layout whose
    // overall width did not change. Ordinary child rerenders retain manual scroll.
    if (findActiveItem() !== revealedActiveItemRef.current) {
      revealActiveItem();
    }
  }, [children, findActiveItem, overflowActions, revealActiveItem, syncScrollState]);

  useEffect(() => {
    // Overflow controls take space when they first appear. Repeat after that
    // layout change, but not when scrolling only updates enabled controls.
    revealActiveItem();
  }, [hasOverflow, revealActiveItem]);

  const hasOverflowActions = Boolean(overflowActions);
  const showInlineOverflowActions = hasOverflowActions && !hasOverflow;
  const showOverflowOverflowActions = hasOverflowActions && hasOverflow;
  const showLeftFade = hasOverflow && canScrollLeft;
  const showRightFade = hasOverflow && canScrollRight;
  // Fade only scrolling content. Painted overlays also cover the rail's
  // dividers and assume a background color that may not match their host.
  const scrollMask = showLeftFade || showRightFade
    ? `linear-gradient(to right, ${showLeftFade ? "transparent, black 32px" : "black"}, ${showRightFade ? "black calc(100% - 40px), transparent" : "black"})`
    : undefined;

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
        <div
          ref={viewportRef}
          className={viewportClassName}
          style={{ maskImage: scrollMask, WebkitMaskImage: scrollMask }}
        >
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
