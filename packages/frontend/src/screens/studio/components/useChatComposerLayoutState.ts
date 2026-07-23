import { Capacitor } from "@capacitor/core";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
  type MutableRefObject,
} from "react";
import { getChatScrollObstructionPaddingPx } from "./browserSessionLayout";

const AUTO_SCROLL_BOTTOM_THRESHOLD_PX = 24;
const BROWSER_SURFACE_GAP_PX = 8;
const NATIVE_KEYBOARD_MIN_OCCLUSION_PX = 96;

export function isNativeKeyboardViewportOpen({
  closedViewportHeight,
  layoutViewportHeight,
  visualViewportHeight,
  visualViewportOffsetTop,
}: {
  closedViewportHeight: number;
  layoutViewportHeight: number;
  visualViewportHeight: number;
  visualViewportOffsetTop: number;
}): boolean {
  const baselineHeight = Math.max(closedViewportHeight, layoutViewportHeight);
  if (!Number.isFinite(baselineHeight) || baselineHeight <= 0) {
    return false;
  }
  const visibleBottom = Math.max(0, visualViewportHeight) + Math.max(0, visualViewportOffsetTop);
  const occludedHeight = Math.max(0, baselineHeight - visibleBottom);
  return occludedHeight >= Math.max(NATIVE_KEYBOARD_MIN_OCCLUSION_PX, baselineHeight * 0.18);
}

type UseChatComposerLayoutStateOptions = {
  activeConversationId: string | null;
  autoScrollPendingRef: MutableRefObject<boolean>;
  browserModeActive: boolean;
  browserSessionOpen: boolean;
  chatSendQueueExpanded: boolean;
  compactBrowserViewport: boolean;
  composerGhostSuggestionRemainder: string | null;
  composerOverlayRef: MutableRefObject<HTMLDivElement | null>;
  editingQueuedItemActive: boolean;
  hasMoreHistory: boolean;
  imageAttachmentCount: number;
  inputValue: string;
  isChatInputFocused: () => boolean;
  isHistoryLoading: boolean;
  lastComposerScrollTopRef: MutableRefObject<number>;
  lastScrollHeightRef: MutableRefObject<number>;
  queuedSummaryItemCount: number;
  recordScrollPosition: () => void;
  requestOlderMessages: () => void;
  rootRef: MutableRefObject<HTMLDivElement | null>;
  scrollContainerRef: MutableRefObject<HTMLDivElement | null>;
  sendingAttachment: boolean;
  shouldAutoScrollRef: MutableRefObject<boolean>;
  showBrowserSessionPageStrip: boolean;
  totalQueuedCount: number;
  touchLikeInput: boolean;
  voiceHoldActive: boolean;
  voiceInputListening: boolean;
};

export function useChatComposerLayoutState({
  activeConversationId,
  autoScrollPendingRef,
  browserModeActive,
  browserSessionOpen,
  chatSendQueueExpanded,
  compactBrowserViewport,
  composerGhostSuggestionRemainder,
  composerOverlayRef,
  editingQueuedItemActive,
  hasMoreHistory,
  imageAttachmentCount,
  inputValue,
  isChatInputFocused,
  isHistoryLoading,
  lastComposerScrollTopRef,
  lastScrollHeightRef,
  queuedSummaryItemCount,
  recordScrollPosition,
  requestOlderMessages,
  rootRef,
  scrollContainerRef,
  sendingAttachment,
  shouldAutoScrollRef,
  showBrowserSessionPageStrip,
  totalQueuedCount,
  touchLikeInput,
  voiceHoldActive,
  voiceInputListening,
}: UseChatComposerLayoutStateOptions) {
  const [nativeKeyboardOpen, setNativeKeyboardOpen] = useState(false);
  const [composerOverlayHeight, setComposerOverlayHeight] = useState(0);
  const [composerScrollOverlapPaddingPx, setComposerScrollOverlapPaddingPx] = useState(0);
  const [composerAutoHidden, setComposerAutoHidden] = useState(false);
  const browserSurfaceGapPx = browserModeActive ? 0 : BROWSER_SURFACE_GAP_PX;

  const canAutoHideComposer = useMemo(() => {
    return (
      touchLikeInput &&
      compactBrowserViewport &&
      !nativeKeyboardOpen &&
      !isChatInputFocused() &&
      !voiceInputListening &&
      !voiceHoldActive &&
      inputValue.trim().length === 0 &&
      imageAttachmentCount === 0 &&
      !sendingAttachment &&
      !editingQueuedItemActive &&
      totalQueuedCount === 0
    );
  }, [
    compactBrowserViewport,
    editingQueuedItemActive,
    imageAttachmentCount,
    inputValue,
    isChatInputFocused,
    nativeKeyboardOpen,
    sendingAttachment,
    totalQueuedCount,
    touchLikeInput,
    voiceHoldActive,
    voiceInputListening,
  ]);

  const chatScrollPaddingBottom = useMemo(() => {
    if (showBrowserSessionPageStrip) {
      return undefined;
    }
    if (composerScrollOverlapPaddingPx <= 0) {
      return undefined;
    }
    return `${Math.ceil(composerScrollOverlapPaddingPx + 12)}px`;
  }, [composerScrollOverlapPaddingPx, showBrowserSessionPageStrip]);

  const browserPageStripBottomInset = useMemo(() => {
    if (composerOverlayHeight <= 0) {
      return undefined;
    }
    return `${Math.ceil(composerOverlayHeight + browserSurfaceGapPx)}px`;
  }, [browserSurfaceGapPx, composerOverlayHeight]);

  const browserModalBottomInset = useMemo(() => {
    if (showBrowserSessionPageStrip) {
      return `${browserSurfaceGapPx}px`;
    }
    if (composerOverlayHeight <= 0) {
      return undefined;
    }
    return `${Math.ceil(composerOverlayHeight + browserSurfaceGapPx)}px`;
  }, [browserSurfaceGapPx, composerOverlayHeight, showBrowserSessionPageStrip]);

  const handleScroll = useCallback(() => {
    const node = scrollContainerRef.current;
    if (!node || autoScrollPendingRef.current) {
      return;
    }
    const distanceFromBottom = node.scrollHeight - (node.scrollTop + node.clientHeight);
    shouldAutoScrollRef.current = distanceFromBottom <= AUTO_SCROLL_BOTTOM_THRESHOLD_PX;
    if (shouldAutoScrollRef.current) {
      lastScrollHeightRef.current = node.scrollHeight;
    }
    recordScrollPosition();
    const currentScrollTop = node.scrollTop;
    const scrollDelta = currentScrollTop - lastComposerScrollTopRef.current;
    lastComposerScrollTopRef.current = currentScrollTop;
    if (canAutoHideComposer) {
      if (scrollDelta > 10 && currentScrollTop > 72 && distanceFromBottom > AUTO_SCROLL_BOTTOM_THRESHOLD_PX) {
        setComposerAutoHidden(true);
      } else if (
        scrollDelta < -10 ||
        currentScrollTop <= 16 ||
        distanceFromBottom <= AUTO_SCROLL_BOTTOM_THRESHOLD_PX
      ) {
        setComposerAutoHidden(false);
      }
    }
    if (node.scrollTop <= 48 && hasMoreHistory && !isHistoryLoading) {
      requestOlderMessages();
    }
  }, [
    autoScrollPendingRef,
    canAutoHideComposer,
    hasMoreHistory,
    isHistoryLoading,
    lastComposerScrollTopRef,
    lastScrollHeightRef,
    recordScrollPosition,
    requestOlderMessages,
    scrollContainerRef,
    shouldAutoScrollRef,
  ]);

  useLayoutEffect(() => {
    setComposerAutoHidden(false);
    lastComposerScrollTopRef.current = scrollContainerRef.current?.scrollTop ?? 0;
  }, [activeConversationId, lastComposerScrollTopRef, scrollContainerRef]);

  useEffect(() => {
    // Software-keyboard occlusion happens on touch-like web browsers (mobile
    // Safari, Android Chrome) exactly like in the native shells; only
    // fine-pointer desktop sessions are exempt, where window resizes would
    // read as keyboard churn.
    if (!Capacitor.isNativePlatform() && !touchLikeInput) {
      setNativeKeyboardOpen(false);
      return;
    }
    if (typeof window === "undefined" || typeof document === "undefined") {
      return;
    }

    const root = rootRef.current;
    if (!root) {
      return;
    }

    let blurTimer: number | null = null;
    let frameId: number | null = null;
    const closedViewportHeightByOrientation = new Map<string, number>();

    const isKeyboardRelevantNode = (node: EventTarget | null) => {
      if (!node || typeof node !== "object") {
        return false;
      }
      const element = node as HTMLElement;
      if (!root.contains(element)) {
        return false;
      }
      if (element.isContentEditable) {
        return true;
      }
      const tag = element.tagName?.toLowerCase?.() ?? "";
      return tag === "input" || tag === "textarea";
    };

    const computeKeyboardOpen = () => {
      const active = document.activeElement as HTMLElement | null;
      const visualViewport = window.visualViewport;
      const visibleViewportHeight = Math.max(
        window.innerHeight,
        (visualViewport?.height ?? window.innerHeight) + (visualViewport?.offsetTop ?? 0),
      );
      const orientationKey = window.innerWidth > window.innerHeight ? "landscape" : "portrait";
      if (!isKeyboardRelevantNode(active)) {
        closedViewportHeightByOrientation.set(orientationKey, visibleViewportHeight);
        return false;
      }
      const closedViewportHeight = closedViewportHeightByOrientation.get(orientationKey);
      if (!closedViewportHeight) {
        closedViewportHeightByOrientation.set(orientationKey, visibleViewportHeight);
        return false;
      }
      return isNativeKeyboardViewportOpen({
        closedViewportHeight,
        layoutViewportHeight: window.innerHeight,
        visualViewportHeight: visualViewport?.height ?? window.innerHeight,
        visualViewportOffsetTop: visualViewport?.offsetTop ?? 0,
      });
    };

    const syncKeyboardOpen = () => {
      frameId = null;
      setNativeKeyboardOpen(computeKeyboardOpen());
    };

    const scheduleKeyboardSync = () => {
      if (frameId !== null) {
        return;
      }
      frameId = window.requestAnimationFrame(syncKeyboardOpen);
    };

    const handleFocusIn = (event: FocusEvent) => {
      if (!isKeyboardRelevantNode(event.target)) {
        return;
      }
      if (blurTimer !== null) {
        window.clearTimeout(blurTimer);
        blurTimer = null;
      }
      scheduleKeyboardSync();
    };

    const handleFocusOut = () => {
      if (blurTimer !== null) {
        window.clearTimeout(blurTimer);
      }
      blurTimer = window.setTimeout(() => {
        scheduleKeyboardSync();
        blurTimer = null;
      }, 0);
    };

    root.addEventListener("focusin", handleFocusIn);
    root.addEventListener("focusout", handleFocusOut);
    window.addEventListener("resize", scheduleKeyboardSync);
    window.visualViewport?.addEventListener("resize", scheduleKeyboardSync);
    window.visualViewport?.addEventListener("scroll", scheduleKeyboardSync);
    scheduleKeyboardSync();

    return () => {
      root.removeEventListener("focusin", handleFocusIn);
      root.removeEventListener("focusout", handleFocusOut);
      window.removeEventListener("resize", scheduleKeyboardSync);
      window.visualViewport?.removeEventListener("resize", scheduleKeyboardSync);
      window.visualViewport?.removeEventListener("scroll", scheduleKeyboardSync);
      if (blurTimer !== null) {
        window.clearTimeout(blurTimer);
      }
      if (frameId !== null) {
        window.cancelAnimationFrame(frameId);
      }
    };
  }, [rootRef, touchLikeInput]);

  useEffect(() => {
    const overlay = composerOverlayRef.current;
    if (!overlay) {
      setComposerOverlayHeight(0);
      return;
    }

    const syncHeight = () => {
      const nextHeight = Math.ceil(overlay.getBoundingClientRect().height);
      setComposerOverlayHeight((current) => (current === nextHeight ? current : nextHeight));
    };

    syncHeight();
    if (typeof ResizeObserver === "undefined") {
      return;
    }

    const observer = new ResizeObserver(() => syncHeight());
    observer.observe(overlay);
    return () => observer.disconnect();
  }, [
    activeConversationId,
    browserSessionOpen,
    chatSendQueueExpanded,
    composerGhostSuggestionRemainder,
    composerOverlayRef,
    editingQueuedItemActive,
    imageAttachmentCount,
    inputValue,
    nativeKeyboardOpen,
    queuedSummaryItemCount,
  ]);

  useEffect(() => {
    if (!canAutoHideComposer) {
      setComposerAutoHidden(false);
    }
  }, [canAutoHideComposer]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const overlay = composerOverlayRef.current;
    const scrollContainer = scrollContainerRef.current;
    if (!overlay || !scrollContainer) {
      setComposerScrollOverlapPaddingPx(0);
      return;
    }

    let frameId: number | null = null;
    const syncOverlap = () => {
      frameId = null;
      const visualViewport = window.visualViewport;
      const overlapPx = getChatScrollObstructionPaddingPx({
        scrollContainerBottom: scrollContainer.getBoundingClientRect().bottom,
        composerOverlayTop: overlay.getBoundingClientRect().top,
        visualViewportHeight: visualViewport ? visualViewport.height : null,
        visualViewportOffsetTop: visualViewport ? visualViewport.offsetTop : null,
      });
      setComposerScrollOverlapPaddingPx((current) => (current === overlapPx ? current : overlapPx));
    };
    const scheduleSync = () => {
      if (frameId !== null) {
        return;
      }
      frameId = window.requestAnimationFrame(syncOverlap);
    };

    scheduleSync();
    window.addEventListener("resize", scheduleSync);
    window.visualViewport?.addEventListener("resize", scheduleSync);
    window.visualViewport?.addEventListener("scroll", scheduleSync);

    if (typeof ResizeObserver === "undefined") {
      return () => {
        window.removeEventListener("resize", scheduleSync);
        window.visualViewport?.removeEventListener("resize", scheduleSync);
        window.visualViewport?.removeEventListener("scroll", scheduleSync);
        if (frameId !== null) {
          window.cancelAnimationFrame(frameId);
        }
      };
    }

    const observer = new ResizeObserver(() => scheduleSync());
    observer.observe(overlay);
    observer.observe(scrollContainer);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", scheduleSync);
      window.visualViewport?.removeEventListener("resize", scheduleSync);
      window.visualViewport?.removeEventListener("scroll", scheduleSync);
      if (frameId !== null) {
        window.cancelAnimationFrame(frameId);
      }
    };
  }, [
    activeConversationId,
    browserSessionOpen,
    composerOverlayRef,
    scrollContainerRef,
    showBrowserSessionPageStrip,
  ]);

  return {
    browserModalBottomInset,
    browserPageStripBottomInset,
    chatScrollPaddingBottom,
    composerAutoHidden,
    composerOverlayHeight,
    handleScroll,
    nativeKeyboardOpen,
  };
}
