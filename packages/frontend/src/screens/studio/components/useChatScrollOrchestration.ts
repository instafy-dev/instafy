import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type MutableRefObject,
} from "react";
import type { ChatMessage } from "../types";
import type { AiCredentialsGateState } from "./AiCredentialsStatusBubble";

const AUTO_SCROLL_BOTTOM_THRESHOLD_PX = 24;
const SCROLL_SNAPSHOT_INTERVAL_MS = 250;
const HISTORY_SCROLL_ANCHOR_SETTLE_MS = 1_200;
const HISTORY_SCROLL_USER_MOVE_THRESHOLD_PX = 4;
// Auto-fill keeps pulling older pages while the window is underfilled, but it
// has to stop somewhere or a long thread would page itself in entirely. Page
// count is the wrong brake — an automation thread's command_execution run
// updates collapse to almost no rendered height, so three pages can add nothing
// visible while a normal thread would have filled in one. Brake on rendered
// progress instead: a page that fails to grow the scroll content by at least
// HISTORY_AUTO_FILL_MIN_PROGRESS_PX counts as stalled, and
// HISTORY_AUTO_FILL_MAX_STALLED_PAGES consecutive stalled pages stop the loop.
// HISTORY_AUTO_FILL_SAFETY_CAP_PAGES is the hard backstop that bounds a
// pathological thread which keeps growing just enough to look like progress, so
// the loop can never fetch unboundedly. Either brake marks auto-fill exhausted,
// which is what surfaces the manual "View earlier messages" button.
const HISTORY_AUTO_FILL_SAFETY_CAP_PAGES = 15;
const HISTORY_AUTO_FILL_MAX_STALLED_PAGES = 2;
const HISTORY_AUTO_FILL_MIN_PROGRESS_PX = 4;
const HISTORY_UNDERFILL_THRESHOLD_PX = 4;

type ScrollToBottomOptions = {
  behavior?: "auto" | "smooth";
};

type UseChatScrollControllerOptions = {
  activeConversationId: string | null;
  hasMoreHistory: boolean;
  isHistoryLoading: boolean;
  loadOlderMessages: () => void | Promise<unknown>;
  messages: ChatMessage[];
};

type UseChatAutoScrollSyncOptions = {
  aiOnboardingOpen: boolean;
  autoScrollSuspendedRef: MutableRefObject<boolean>;
  autoScrollPendingRef: MutableRefObject<boolean>;
  composerAutoHidden: boolean;
  composerOverlayHeight: number;
  credentialGateStateForBubble: AiCredentialsGateState | null;
  displayedMessages: ChatMessage[];
  isAssistantTyping: boolean;
  lastScrollHeightRef: MutableRefObject<number>;
  notificationsNudgeAnchorTimestamp: number | null;
  notificationsNudgeOpen: boolean;
  peerTypingLabel: string | null;
  scrollContainerRef: MutableRefObject<HTMLDivElement | null>;
  scrollToBottom: (options?: ScrollToBottomOptions) => void;
  shouldAutoScrollRef: MutableRefObject<boolean>;
};

type ConversationScrollSnapshot = {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  wasAtBottom: boolean;
};

const conversationScrollSnapshots = new Map<string, ConversationScrollSnapshot>();

export function useChatScrollController({
  activeConversationId,
  hasMoreHistory,
  isHistoryLoading,
  loadOlderMessages,
  messages,
}: UseChatScrollControllerOptions) {
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const [scrollContentNode, setScrollContentNode] = useState<HTMLDivElement | null>(null);
  const [historyWindowUnderfilled, setHistoryWindowUnderfilled] = useState(false);
  const [historyAutoFillExhausted, setHistoryAutoFillExhausted] = useState(false);
  const autoScrollSuspendedRef = useRef(false);
  const shouldAutoScrollRef = useRef(true);
  const autoScrollPendingRef = useRef(false);
  const lastScrollHeightRef = useRef(0);
  const lastComposerScrollTopRef = useRef(0);
  const scrollAnimationFrameRef = useRef<number | null>(null);
  const scrollAnimationStartRef = useRef<number | null>(null);
  const scrollAnimationStartTopRef = useRef(0);
  const historyAutoFillRef = useRef<{
    conversationId: string | null;
    attempts: number;
    stalledPages: number;
    pendingPage: { messages: ChatMessage[]; scrollHeight: number } | null;
  }>({
    conversationId: null,
    attempts: 0,
    stalledPages: 0,
    pendingPage: null,
  });
  const historyPaginationRef = useRef<{ pending: boolean; scrollTop: number; scrollHeight: number }>({
    pending: false,
    scrollTop: 0,
    scrollHeight: 0,
  });
  const activeConversationIdRef = useRef<string | null>(activeConversationId);
  const historyScrollAnchorRef = useRef<{
    active: boolean;
    baseScrollTop: number;
    baseScrollHeight: number;
    appliedScrollTop: number;
    timeoutId: number | null;
  }>({
    active: false,
    baseScrollTop: 0,
    baseScrollHeight: 0,
    appliedScrollTop: 0,
    timeoutId: null,
  });

  const saveCurrentConversationScrollSnapshot = useCallback(() => {
    const conversationId = activeConversationIdRef.current;
    const node = scrollContainerRef.current;
    if (!conversationId || !node || autoScrollSuspendedRef.current) {
      return;
    }
    const distanceFromBottom = node.scrollHeight - (node.scrollTop + node.clientHeight);
    conversationScrollSnapshots.set(conversationId, {
      scrollTop: node.scrollTop,
      scrollHeight: node.scrollHeight,
      clientHeight: node.clientHeight,
      wasAtBottom: distanceFromBottom <= AUTO_SCROLL_BOTTOM_THRESHOLD_PX,
    });
  }, []);

  const cancelScrollAnimation = useCallback(() => {
    if (scrollAnimationFrameRef.current !== null && typeof window !== "undefined") {
      window.cancelAnimationFrame(scrollAnimationFrameRef.current);
    }
    scrollAnimationFrameRef.current = null;
    scrollAnimationStartRef.current = null;
    autoScrollPendingRef.current = false;
  }, []);

  const setAutoScrollSuspended = useCallback(
    (suspended: boolean) => {
      autoScrollSuspendedRef.current = suspended;
      if (!suspended) {
        return;
      }
      cancelScrollAnimation();
      shouldAutoScrollRef.current = false;
    },
    [cancelScrollAnimation],
  );

  const clearHistoryScrollAnchor = useCallback(() => {
    const anchor = historyScrollAnchorRef.current;
    if (anchor.timeoutId !== null && typeof window !== "undefined") {
      window.clearTimeout(anchor.timeoutId);
    }
    historyScrollAnchorRef.current = {
      active: false,
      baseScrollTop: 0,
      baseScrollHeight: 0,
      appliedScrollTop: 0,
      timeoutId: null,
    };
  }, []);

  const measureHistoryWindowUnderfill = useCallback(() => {
    const node = scrollContainerRef.current;
    const underfilled = Boolean(
      node && node.scrollHeight <= node.clientHeight + HISTORY_UNDERFILL_THRESHOLD_PX,
    );
    setHistoryWindowUnderfilled((current) => (current === underfilled ? current : underfilled));
    return underfilled;
  }, []);

  const applyHistoryScrollAnchor = useCallback(() => {
    const node = scrollContainerRef.current;
    const anchor = historyScrollAnchorRef.current;
    if (!node || !anchor.active) {
      return false;
    }

    if (Math.abs(node.scrollTop - anchor.appliedScrollTop) > HISTORY_SCROLL_USER_MOVE_THRESHOLD_PX) {
      clearHistoryScrollAnchor();
      return false;
    }

    const nextScrollTop = anchor.baseScrollTop + Math.max(0, node.scrollHeight - anchor.baseScrollHeight);
    node.scrollTop = nextScrollTop;
    anchor.appliedScrollTop = nextScrollTop;
    lastScrollHeightRef.current = node.scrollHeight;
    return true;
  }, [clearHistoryScrollAnchor]);

  const startHistoryScrollAnchor = useCallback((node: HTMLDivElement) => {
    clearHistoryScrollAnchor();
    historyScrollAnchorRef.current = {
      active: true,
      baseScrollTop: node.scrollTop,
      baseScrollHeight: node.scrollHeight,
      appliedScrollTop: node.scrollTop,
      timeoutId:
        typeof window !== "undefined"
          ? window.setTimeout(() => {
              clearHistoryScrollAnchor();
            }, HISTORY_SCROLL_ANCHOR_SETTLE_MS)
          : null,
    };
  }, [clearHistoryScrollAnchor]);

  const scrollToBottom = useCallback((options?: ScrollToBottomOptions) => {
    const node = scrollContainerRef.current;
    if (!node) {
      return;
    }
    if (autoScrollSuspendedRef.current) {
      cancelScrollAnimation();
      return;
    }
    if (autoScrollPendingRef.current) {
      return;
    }
    cancelScrollAnimation();

    const targetTop = Math.max(0, node.scrollHeight - node.clientHeight);
    const currentTop = node.scrollTop;
    if (Math.abs(targetTop - currentTop) < 1) {
      node.scrollTop = targetTop;
      lastScrollHeightRef.current = node.scrollHeight;
      autoScrollPendingRef.current = false;
      return;
    }

    autoScrollPendingRef.current = true;
    const prefersReducedMotion =
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const behavior = options?.behavior ?? "auto";

    const complete = (finalNode: HTMLDivElement) => {
      autoScrollPendingRef.current = false;
      lastScrollHeightRef.current = finalNode.scrollHeight;
      saveCurrentConversationScrollSnapshot();
      cancelScrollAnimation();
    };

    if (
      behavior === "auto" ||
      prefersReducedMotion ||
      typeof window === "undefined" ||
      typeof window.requestAnimationFrame !== "function" ||
      typeof window.cancelAnimationFrame !== "function"
    ) {
      node.scrollTop = targetTop;
      complete(node);
      return;
    }

    const duration = 360;
    const startTime =
      typeof performance !== "undefined" && typeof performance.now === "function"
        ? performance.now()
        : Date.now();
    scrollAnimationStartRef.current = startTime;
    scrollAnimationStartTopRef.current = currentTop;

    const animate = (time: number) => {
      const container = scrollContainerRef.current;
      if (!container || autoScrollSuspendedRef.current) {
        cancelScrollAnimation();
        return;
      }
      const elapsed = time - (scrollAnimationStartRef.current ?? startTime);
      const progress = Math.min(elapsed / duration, 1);
      const eased = 1 - Math.pow(1 - progress, 3);
      const latestTarget = Math.max(0, container.scrollHeight - container.clientHeight);
      const startTop = scrollAnimationStartTopRef.current ?? container.scrollTop;
      container.scrollTop = startTop + (latestTarget - startTop) * eased;

      if (progress < 1) {
        scrollAnimationFrameRef.current = window.requestAnimationFrame(animate);
      } else {
        container.scrollTop = latestTarget;
        complete(container);
      }
    };

    scrollAnimationFrameRef.current = window.requestAnimationFrame(animate);
  }, [cancelScrollAnimation, saveCurrentConversationScrollSnapshot]);

  useLayoutEffect(() => {
    activeConversationIdRef.current = activeConversationId;
    const node = scrollContainerRef.current;
    if (!node || !activeConversationId) {
      return;
    }
    measureHistoryWindowUnderfill();

    if (autoScrollSuspendedRef.current) {
      cancelScrollAnimation();
      shouldAutoScrollRef.current = false;
      lastScrollHeightRef.current = node.scrollHeight;
      return;
    }

    const snapshot = conversationScrollSnapshots.get(activeConversationId) ?? null;
    if (!snapshot || snapshot.wasAtBottom) {
      shouldAutoScrollRef.current = true;
      scrollToBottom({ behavior: "auto" });
      return;
    }

    cancelScrollAnimation();
    shouldAutoScrollRef.current = false;
    const maxScrollTop = Math.max(0, node.scrollHeight - node.clientHeight);
    node.scrollTop = Math.min(snapshot.scrollTop, maxScrollTop);
    lastScrollHeightRef.current = node.scrollHeight;
  }, [activeConversationId, cancelScrollAnimation, measureHistoryWindowUnderfill, scrollToBottom]);

  const handleScrollContentRef = useCallback((node: HTMLDivElement | null) => {
    setScrollContentNode(node);
  }, []);

  const requestOlderMessages = useCallback(() => {
    if (!hasMoreHistory || isHistoryLoading) {
      return;
    }
    const container = scrollContainerRef.current;
    if (!container || historyPaginationRef.current.pending) {
      return;
    }
    historyPaginationRef.current = {
      pending: true,
      scrollTop: container.scrollTop,
      scrollHeight: container.scrollHeight,
    };
    shouldAutoScrollRef.current = false;
    const result = loadOlderMessages();
    if (result && typeof (result as Promise<unknown>).catch === "function") {
      (result as Promise<unknown>).catch(() => {
        historyPaginationRef.current = { pending: false, scrollTop: 0, scrollHeight: 0 };
      });
    }
  }, [hasMoreHistory, isHistoryLoading, loadOlderMessages]);

  useLayoutEffect(() => {
    const node = scrollContainerRef.current;
    if (!node) {
      return;
    }
    measureHistoryWindowUnderfill();
    lastScrollHeightRef.current = node.scrollHeight;
    return () => {
      cancelScrollAnimation();
      clearHistoryScrollAnchor();
    };
  }, [cancelScrollAnimation, clearHistoryScrollAnchor, measureHistoryWindowUnderfill]);

  useEffect(() => {
    const node = scrollContainerRef.current;
    if (!node) {
      return;
    }
    const handleScroll = () => {
      if (autoScrollPendingRef.current) {
        return;
      }
      saveCurrentConversationScrollSnapshot();
    };
    node.addEventListener("scroll", handleScroll, { passive: true });
    return () => {
      node.removeEventListener("scroll", handleScroll);
    };
  }, [saveCurrentConversationScrollSnapshot]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    const handleNavigationSnapshot = () => {
      saveCurrentConversationScrollSnapshot();
    };
    window.addEventListener("popstate", handleNavigationSnapshot, { capture: true });
    window.addEventListener("pagehide", handleNavigationSnapshot, { capture: true });
    return () => {
      window.removeEventListener("popstate", handleNavigationSnapshot, { capture: true });
      window.removeEventListener("pagehide", handleNavigationSnapshot, { capture: true });
    };
  }, [saveCurrentConversationScrollSnapshot]);

  useEffect(() => {
    if (typeof window === "undefined" || !activeConversationId) {
      return;
    }
    const intervalId = window.setInterval(
      saveCurrentConversationScrollSnapshot,
      SCROLL_SNAPSHOT_INTERVAL_MS,
    );
    return () => {
      window.clearInterval(intervalId);
    };
  }, [activeConversationId, saveCurrentConversationScrollSnapshot]);

  useLayoutEffect(() => {
    if (!scrollContentNode || typeof ResizeObserver === "undefined") {
      return;
    }

    let frameId: number | null = null;
    const syncBottomState = () => {
      frameId = null;
      const node = scrollContainerRef.current;
      if (!node || autoScrollPendingRef.current) {
        return;
      }
      measureHistoryWindowUnderfill();
      if (applyHistoryScrollAnchor()) {
        return;
      }
      if (autoScrollSuspendedRef.current) {
        shouldAutoScrollRef.current = false;
        lastScrollHeightRef.current = node.scrollHeight;
        return;
      }
      const distanceFromBottom = node.scrollHeight - (node.scrollTop + node.clientHeight);
      const isNearBottom = distanceFromBottom <= AUTO_SCROLL_BOTTOM_THRESHOLD_PX;
      if (isNearBottom) {
        shouldAutoScrollRef.current = true;
      }
      if (!shouldAutoScrollRef.current) {
        lastScrollHeightRef.current = node.scrollHeight;
        return;
      }
      scrollToBottom();
    };

    const scheduleSync = () => {
      if (typeof window === "undefined" || typeof window.requestAnimationFrame !== "function") {
        syncBottomState();
        return;
      }
      if (frameId !== null) {
        return;
      }
      frameId = window.requestAnimationFrame(syncBottomState);
    };

    const observer = new ResizeObserver(() => {
      scheduleSync();
    });
    observer.observe(scrollContentNode);

    return () => {
      observer.disconnect();
      if (frameId !== null && typeof window !== "undefined" && typeof window.cancelAnimationFrame === "function") {
        window.cancelAnimationFrame(frameId);
      }
    };
  }, [applyHistoryScrollAnchor, measureHistoryWindowUnderfill, scrollContentNode, scrollToBottom]);

  useLayoutEffect(() => {
    if (!historyPaginationRef.current.pending || isHistoryLoading) {
      return;
    }
    const container = scrollContainerRef.current;
    if (!container) {
      historyPaginationRef.current = { pending: false, scrollTop: 0, scrollHeight: 0 };
      return;
    }
    const { scrollTop, scrollHeight } = historyPaginationRef.current;
    const delta = Math.max(0, container.scrollHeight - scrollHeight);
    container.scrollTop = scrollTop + delta;
    lastScrollHeightRef.current = container.scrollHeight;
    historyPaginationRef.current = { pending: false, scrollTop: 0, scrollHeight: 0 };
    startHistoryScrollAnchor(container);
  }, [isHistoryLoading, messages, startHistoryScrollAnchor]);

  useLayoutEffect(() => {
    if (historyAutoFillRef.current.conversationId === activeConversationId) {
      return;
    }
    historyAutoFillRef.current = {
      conversationId: activeConversationId,
      attempts: 0,
      stalledPages: 0,
      pendingPage: null,
    };
    setHistoryAutoFillExhausted(false);
  }, [activeConversationId]);

  useLayoutEffect(() => {
    if (!activeConversationId || !hasMoreHistory || isHistoryLoading) {
      return;
    }
    if (historyPaginationRef.current.pending) {
      return;
    }
    const node = scrollContainerRef.current;
    if (!node) {
      return;
    }

    const autoFill = historyAutoFillRef.current;

    // Score the page auto-fill last asked for before deciding anything else.
    // The page has integrated once a new `messages` array arrives; comparing
    // identity (not length) keeps an unrelated effect re-run from being scored
    // as a stalled page, and still scores a page that came back empty.
    if (autoFill.pendingPage && autoFill.pendingPage.messages !== messages) {
      const grewBy = node.scrollHeight - autoFill.pendingPage.scrollHeight;
      autoFill.stalledPages =
        grewBy > HISTORY_AUTO_FILL_MIN_PROGRESS_PX ? 0 : autoFill.stalledPages + 1;
      autoFill.pendingPage = null;
    }

    if (!measureHistoryWindowUnderfill()) {
      return;
    }

    if (
      autoFill.stalledPages >= HISTORY_AUTO_FILL_MAX_STALLED_PAGES ||
      autoFill.attempts >= HISTORY_AUTO_FILL_SAFETY_CAP_PAGES
    ) {
      // Consecutive pages added no measurable height, or the safety cap is
      // spent. Either way the window will not fill on its own and an
      // underfilled container cannot be scrolled, so surface the manual
      // affordance instead of dead-ending with history still unreachable.
      setHistoryAutoFillExhausted(true);
      return;
    }

    if (autoFill.pendingPage) {
      // The page auto-fill asked for has not integrated yet — wait for it
      // rather than stacking another request on top of it.
      return;
    }

    autoFill.attempts += 1;
    autoFill.pendingPage = { messages, scrollHeight: node.scrollHeight };
    requestOlderMessages();
  }, [
    activeConversationId,
    hasMoreHistory,
    isHistoryLoading,
    measureHistoryWindowUnderfill,
    messages,
    requestOlderMessages,
  ]);

  // Hide the manual affordance while auto-fill is still expected to satisfy an
  // underfilled window, but never once auto-fill has given up with history
  // remaining — at that point the button is the only way left to reach it.
  const showHistoryLoadButton =
    hasMoreHistory && (!historyWindowUnderfilled || historyAutoFillExhausted);

  return {
    autoScrollSuspendedRef,
    autoScrollPendingRef,
    handleScrollContentRef,
    historyWindowUnderfilled,
    lastComposerScrollTopRef,
    lastScrollHeightRef,
    recordScrollPosition: saveCurrentConversationScrollSnapshot,
    requestOlderMessages,
    scrollContainerRef,
    scrollToBottom,
    setAutoScrollSuspended,
    shouldAutoScrollRef,
    showHistoryLoadButton,
  };
}

export function useChatAutoScrollSync({
  aiOnboardingOpen,
  autoScrollSuspendedRef,
  autoScrollPendingRef,
  composerAutoHidden,
  composerOverlayHeight,
  credentialGateStateForBubble,
  displayedMessages,
  isAssistantTyping,
  lastScrollHeightRef,
  notificationsNudgeAnchorTimestamp,
  notificationsNudgeOpen,
  peerTypingLabel,
  scrollContainerRef,
  scrollToBottom,
  shouldAutoScrollRef,
}: UseChatAutoScrollSyncOptions) {
  useLayoutEffect(() => {
    if (autoScrollSuspendedRef.current) {
      shouldAutoScrollRef.current = false;
      return;
    }
    if (autoScrollPendingRef.current) {
      return;
    }
    const node = scrollContainerRef.current;
    if (!node) {
      return;
    }
    const currentBottom = node.scrollTop + node.clientHeight;
    const previousHeight = lastScrollHeightRef.current || node.scrollHeight;
    const wasAtBottom = previousHeight - currentBottom <= AUTO_SCROLL_BOTTOM_THRESHOLD_PX;
    if (wasAtBottom) {
      shouldAutoScrollRef.current = true;
    }
    if (!shouldAutoScrollRef.current) {
      return;
    }
    scrollToBottom({ behavior: "auto" });
  }, [
    aiOnboardingOpen,
    autoScrollSuspendedRef,
    autoScrollPendingRef,
    credentialGateStateForBubble,
    displayedMessages,
    isAssistantTyping,
    lastScrollHeightRef,
    notificationsNudgeAnchorTimestamp,
    notificationsNudgeOpen,
    peerTypingLabel,
    scrollContainerRef,
    scrollToBottom,
    shouldAutoScrollRef,
  ]);

  useLayoutEffect(() => {
    if (
      autoScrollSuspendedRef.current ||
      composerOverlayHeight <= 0 ||
      !shouldAutoScrollRef.current
    ) {
      return;
    }
    scrollToBottom();
  }, [autoScrollSuspendedRef, composerOverlayHeight, scrollToBottom, shouldAutoScrollRef]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    const viewport = window.visualViewport;
    if (!viewport) {
      return;
    }

    let frameId: number | null = null;
    const handleViewportResize = () => {
      if (autoScrollSuspendedRef.current || !shouldAutoScrollRef.current) {
        return;
      }
      if (frameId !== null) {
        return;
      }
      if (typeof window.requestAnimationFrame !== "function") {
        scrollToBottom();
        return;
      }
      frameId = window.requestAnimationFrame(() => {
        frameId = null;
        scrollToBottom();
      });
    };

    viewport.addEventListener("resize", handleViewportResize);
    window.addEventListener("resize", handleViewportResize);

    return () => {
      viewport.removeEventListener("resize", handleViewportResize);
      window.removeEventListener("resize", handleViewportResize);
      if (frameId !== null && typeof window.cancelAnimationFrame === "function") {
        window.cancelAnimationFrame(frameId);
      }
    };
  }, [autoScrollSuspendedRef, composerAutoHidden, scrollToBottom, shouldAutoScrollRef]);
}
