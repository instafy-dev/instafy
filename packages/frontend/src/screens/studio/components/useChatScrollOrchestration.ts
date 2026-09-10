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
import { chatScrollSnapshotKey, type ChatScrollHistoryVisit } from "./chatScrollHistory";

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
const CHAT_SCROLL_MESSAGE_SELECTOR = "[data-chat-scroll-message-id]";
const MAX_CHAT_SCROLL_SNAPSHOTS = 200;

function readTranscriptTopInset(node: HTMLDivElement): number {
  const inset = Number.parseFloat(getComputedStyle(node).scrollPaddingTop);
  return Number.isFinite(inset) ? Math.max(0, inset) : 0;
}

type MessageScrollAnchor = { messageId: string; offset: number };

function readVisibleMessageAnchor(node: HTMLDivElement): MessageScrollAnchor | null {
  const rows = node.querySelectorAll<HTMLElement>(CHAT_SCROLL_MESSAGE_SELECTOR);
  const viewport = node.getBoundingClientRect();
  const readableTop = viewport.top + readTranscriptTopInset(node);
  // Rows remain in transcript order, including any deferred-rendering shells.
  // Find the first visible one without measuring every earlier message.
  let low = 0;
  let high = rows.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (rows[middle].getBoundingClientRect().bottom <= readableTop) low = middle + 1;
    else high = middle;
  }
  const row = rows[low];
  if (!row) return null;
  const rect = row.getBoundingClientRect();
  const messageId = row.dataset.chatScrollMessageId;
  return messageId && rect.top < viewport.bottom
    ? { messageId, offset: rect.top - viewport.top }
    : null;
}

function findMessageAnchorRow(node: HTMLDivElement, anchor: MessageScrollAnchor): HTMLElement | null {
  // Compare dataset values rather than interpolating arbitrary message IDs in a selector.
  for (const row of node.querySelectorAll<HTMLElement>(CHAT_SCROLL_MESSAGE_SELECTOR)) {
    if (row.dataset.chatScrollMessageId === anchor.messageId) return row;
  }
  return null;
}

type ScrollToBottomOptions = {
  behavior?: "auto" | "smooth";
};

type UseChatScrollControllerOptions = {
  activeConversationId: string | null;
  historyVisit: ChatScrollHistoryVisit | null;
  hasMoreHistory: boolean;
  isHistoryLoading: boolean;
  isInitialHistoryLoading?: boolean;
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
  anchor: MessageScrollAnchor | null;
  revealedMessageId: string | null;
};

const conversationScrollSnapshots = new Map<string, ConversationScrollSnapshot>();

export function getConversationScrollAnchorMessageId(snapshotKey: string | null): string | null {
  const snapshot = snapshotKey ? conversationScrollSnapshots.get(snapshotKey) : null;
  return snapshot && !snapshot.wasAtBottom ? snapshot.anchor?.messageId ?? null : null;
}

export function useChatScrollController({
  activeConversationId,
  historyVisit,
  hasMoreHistory,
  isHistoryLoading,
  isInitialHistoryLoading = false,
  loadOlderMessages,
  messages,
}: UseChatScrollControllerOptions) {
  const scrollSnapshotKey = historyVisit?.conversationId === activeConversationId
    ? chatScrollSnapshotKey(historyVisit)
    : null;
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const [scrollContentNode, setScrollContentNode] = useState<HTMLDivElement | null>(null);
  const [layoutRevision, setLayoutRevision] = useState(0);
  const [historyWindowUnderfilled, setHistoryWindowUnderfilled] = useState(false);
  const [historyAutoFillExhausted, setHistoryAutoFillExhausted] = useState(false);
  const [highlightedMessageId, setHighlightedMessageId] = useState<string | null>(null);
  const highlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const autoScrollSuspendedRef = useRef(false);
  const shouldAutoScrollRef = useRef(true);
  const autoScrollPendingRef = useRef(false);
  const lastScrollHeightRef = useRef(0);
  const lastComposerScrollTopRef = useRef(0);
  const scrollAnimationFrameRef = useRef<number | null>(null);
  const scrollAnimationStartRef = useRef<number | null>(null);
  const scrollAnimationStartTopRef = useRef(0);
  const historyAutoFillRef = useRef<{
    snapshotKey: string | null;
    attempts: number;
    stalledPages: number;
    pendingPage: { messages: ChatMessage[]; scrollHeight: number } | null;
  }>({
    snapshotKey: null,
    attempts: 0,
    stalledPages: 0,
    pendingPage: null,
  });
  // Only the request-time scrollHeight is remembered: the landing offsets the
  // container's *current* scrollTop by how much the content grew. Storing the
  // request-time scrollTop too would snap the user back to wherever they were
  // when the page was asked for, undoing any scrolling they did while it loaded.
  const historyPaginationRef = useRef<{ pending: boolean; scrollHeight: number }>({
    pending: false,
    scrollHeight: 0,
  });
  // Only a committed, route/data-matched visit can own geometry. During route
  // hydration this is null, even if the old transcript is still on screen.
  const activeSnapshotKeyRef = useRef<string | null>(null);
  const activeMessageTargetRef = useRef<string | null>(null);
  const pendingMessageTargetRef = useRef<string | null>(null);
  const restoredSnapshotKeyRef = useRef<string | null>(null);
  const restoringInitialHistoryRef = useRef(false);
  const historyScrollAnchorRef = useRef<{
    active: boolean;
    baseScrollTop: number;
    baseScrollHeight: number;
    appliedScrollTop: number;
    timeoutId: number | null;
    messageAnchor: MessageScrollAnchor | null;
  }>({
    active: false,
    baseScrollTop: 0,
    baseScrollHeight: 0,
    appliedScrollTop: 0,
    timeoutId: null,
    messageAnchor: null,
  });

  const saveCurrentConversationScrollSnapshot = useCallback(() => {
    const snapshotKey = activeSnapshotKeyRef.current;
    const node = scrollContainerRef.current;
    if (!snapshotKey || !node || node.clientHeight <= 0 || pendingMessageTargetRef.current || autoScrollSuspendedRef.current || autoScrollPendingRef.current) {
      return;
    }
    const distanceFromBottom = node.scrollHeight - (node.scrollTop + node.clientHeight);
    conversationScrollSnapshots.delete(snapshotKey);
    conversationScrollSnapshots.set(snapshotKey, {
      scrollTop: node.scrollTop,
      scrollHeight: node.scrollHeight,
      clientHeight: node.clientHeight,
      wasAtBottom: distanceFromBottom <= AUTO_SCROLL_BOTTOM_THRESHOLD_PX,
      anchor: distanceFromBottom <= AUTO_SCROLL_BOTTOM_THRESHOLD_PX ? null : readVisibleMessageAnchor(node),
      revealedMessageId: activeMessageTargetRef.current,
    });
    if (conversationScrollSnapshots.size > MAX_CHAT_SCROLL_SNAPSHOTS) {
      const oldest = conversationScrollSnapshots.keys().next().value;
      if (oldest) conversationScrollSnapshots.delete(oldest);
    }
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
      const wasSuspended = autoScrollSuspendedRef.current;
      autoScrollSuspendedRef.current = suspended;
      if (!suspended) {
        if (wasSuspended && pendingMessageTargetRef.current) setLayoutRevision((revision) => revision + 1);
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
      messageAnchor: null,
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

    const anchorRow = anchor.messageAnchor ? findMessageAnchorRow(node, anchor.messageAnchor) : null;
    if (anchor.messageAnchor && !anchorRow) {
      clearHistoryScrollAnchor();
      return false;
    }
    const nextScrollTop = anchorRow && anchor.messageAnchor
      ? node.scrollTop + anchorRow.getBoundingClientRect().top - node.getBoundingClientRect().top - anchor.messageAnchor.offset
      : anchor.baseScrollTop + Math.max(0, node.scrollHeight - anchor.baseScrollHeight);
    node.scrollTop = nextScrollTop;
    anchor.appliedScrollTop = node.scrollTop;
    lastScrollHeightRef.current = node.scrollHeight;
    return true;
  }, [clearHistoryScrollAnchor]);

  const startHistoryScrollAnchor = useCallback((node: HTMLDivElement, messageAnchor: MessageScrollAnchor | null = null) => {
    clearHistoryScrollAnchor();
    historyScrollAnchorRef.current = {
      active: true,
      baseScrollTop: node.scrollTop,
      baseScrollHeight: node.scrollHeight,
      appliedScrollTop: node.scrollTop,
      messageAnchor,
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
    if (!node || !activeSnapshotKeyRef.current || pendingMessageTargetRef.current) {
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
      if (!container || !activeSnapshotKeyRef.current || autoScrollSuspendedRef.current) {
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
    const conversationChanged = restoredSnapshotKeyRef.current !== scrollSnapshotKey;
    activeSnapshotKeyRef.current = scrollSnapshotKey;
    activeMessageTargetRef.current = historyVisit?.messageId ?? null;
    restoredSnapshotKeyRef.current = scrollSnapshotKey;
    if (conversationChanged) {
      const requestedMessageId = activeMessageTargetRef.current;
      const saved = scrollSnapshotKey ? conversationScrollSnapshots.get(scrollSnapshotKey) : null;
      // A placeholder's bottom position must never count as having revealed
      // an explicit target. Only snapshots captured after that reveal can
      // restore a later reading position on Back/Forward.
      pendingMessageTargetRef.current = scrollSnapshotKey && requestedMessageId && saved?.revealedMessageId !== requestedMessageId
        ? requestedMessageId : null;
      historyPaginationRef.current = { pending: false, scrollHeight: 0 };
      clearHistoryScrollAnchor();
      cancelScrollAnimation();
      if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
      setHighlightedMessageId(null);
    }
    const node = scrollContainerRef.current;
    if (!node || !scrollSnapshotKey) {
      cancelScrollAnimation();
      shouldAutoScrollRef.current = false;
      autoScrollPendingRef.current = true;
      restoringInitialHistoryRef.current = true;
      return;
    }
    measureHistoryWindowUnderfill();

    if (autoScrollSuspendedRef.current) {
      cancelScrollAnimation();
      shouldAutoScrollRef.current = false;
      lastScrollHeightRef.current = node.scrollHeight;
      return;
    }

    const snapshot = conversationScrollSnapshots.get(scrollSnapshotKey) ?? null;
    if (isInitialHistoryLoading || node.clientHeight <= 0) {
      cancelScrollAnimation();
      shouldAutoScrollRef.current = false;
      // Neither hydration placeholders nor hidden panels are a reading position.
      autoScrollPendingRef.current = true;
      restoringInitialHistoryRef.current = true;
      return;
    }
    const targetMessageId = pendingMessageTargetRef.current;
    if (targetMessageId) {
      cancelScrollAnimation();
      shouldAutoScrollRef.current = false;
      const anchor = { messageId: targetMessageId, offset: readTranscriptTopInset(node) + 24 };
      const row = findMessageAnchorRow(node, anchor);
      if (!row || row.dataset.chatRowDeferred === "true") {
        autoScrollPendingRef.current = true;
        restoringInitialHistoryRef.current = true;
        return;
      }
      restoringInitialHistoryRef.current = false;
      node.scrollTop = Math.max(0, Math.min(
        node.scrollTop + row.getBoundingClientRect().top - node.getBoundingClientRect().top - anchor.offset,
        node.scrollHeight - node.clientHeight,
      ));
      lastScrollHeightRef.current = node.scrollHeight;
      pendingMessageTargetRef.current = null;
      startHistoryScrollAnchor(node, anchor);
      saveCurrentConversationScrollSnapshot();
      setHighlightedMessageId(targetMessageId);
      highlightTimerRef.current = setTimeout(() => setHighlightedMessageId(null), 3_000);
      // Selecting a search result unmounts its focused button. Give that empty
      // focus position a destination without overriding a control the reader
      // deliberately focused while this message's context was loading.
      const ownerDocument = row.ownerDocument;
      const focusedElement = ownerDocument.activeElement;
      if (!focusedElement || focusedElement === ownerDocument.body || focusedElement === ownerDocument.documentElement) {
        row.focus({ preventScroll: true });
      }
      return;
    }
    if (!conversationChanged && !restoringInitialHistoryRef.current) {
      // Pagination already owns its prepend/settle correction. Otherwise only
      // reanchor a reader; normal new-message bottom-following stays with the
      // existing scroll synchronizer.
      if (historyPaginationRef.current.pending) return;
      if (historyScrollAnchorRef.current.active) {
        if (!historyScrollAnchorRef.current.messageAnchor) {
          applyHistoryScrollAnchor();
          return;
        }
        clearHistoryScrollAnchor();
      }
      if (!snapshot?.anchor || snapshot.wasAtBottom) return;
    }
    restoringInitialHistoryRef.current = false;
    if (historyPaginationRef.current.pending) return;
    if (!snapshot || snapshot.wasAtBottom) {
      cancelScrollAnimation();
      shouldAutoScrollRef.current = true;
      scrollToBottom({ behavior: "auto" });
      return;
    }

    cancelScrollAnimation();
    shouldAutoScrollRef.current = false;
    const maxScrollTop = Math.max(0, node.scrollHeight - node.clientHeight);
    const anchorRow = snapshot.anchor ? findMessageAnchorRow(node, snapshot.anchor) : null;
    const target = anchorRow && snapshot.anchor
      ? node.scrollTop + anchorRow.getBoundingClientRect().top - node.getBoundingClientRect().top - snapshot.anchor.offset
      // An evicted anchor belongs to older history. Start at the oldest loaded
      // row so the reader can continue paging back, rather than jumping to an
      // unrelated message at the former absolute offset.
      : snapshot.anchor ? 0 : snapshot.scrollTop;
    node.scrollTop = Math.max(0, Math.min(target, maxScrollTop));
    lastScrollHeightRef.current = node.scrollHeight;
    if (anchorRow && snapshot.anchor) startHistoryScrollAnchor(node, snapshot.anchor);
    saveCurrentConversationScrollSnapshot();
  }, [scrollSnapshotKey, historyVisit?.messageId, applyHistoryScrollAnchor, cancelScrollAnimation, clearHistoryScrollAnchor, isInitialHistoryLoading, layoutRevision, measureHistoryWindowUnderfill, messages, saveCurrentConversationScrollSnapshot, scrollToBottom, startHistoryScrollAnchor]);

  useEffect(() => () => { if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current); }, []);

  const handleScrollContentRef = useCallback((node: HTMLDivElement | null) => {
    setScrollContentNode(node);
  }, []);

  const requestOlderMessages = useCallback(() => {
    if (!activeSnapshotKeyRef.current || restoringInitialHistoryRef.current || !hasMoreHistory || isHistoryLoading) {
      return;
    }
    const container = scrollContainerRef.current;
    if (!container || historyPaginationRef.current.pending) {
      return;
    }
    const request = {
      pending: true,
      scrollHeight: container.scrollHeight,
    };
    historyPaginationRef.current = request;
    shouldAutoScrollRef.current = false;
    const result = loadOlderMessages();
    if (result && typeof (result as Promise<unknown>).catch === "function") {
      (result as Promise<unknown>).catch(() => {
        if (historyPaginationRef.current === request) {
          historyPaginationRef.current = { pending: false, scrollHeight: 0 };
        }
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
    if (typeof window === "undefined" || !scrollSnapshotKey) {
      return;
    }
    const intervalId = window.setInterval(
      saveCurrentConversationScrollSnapshot,
      SCROLL_SNAPSHOT_INTERVAL_MS,
    );
    return () => {
      window.clearInterval(intervalId);
    };
  }, [scrollSnapshotKey, saveCurrentConversationScrollSnapshot]);

  useLayoutEffect(() => {
    if (!scrollContentNode || typeof ResizeObserver === "undefined") {
      return;
    }

    let frameId: number | null = null;
    const syncBottomState = () => {
      frameId = null;
      const node = scrollContainerRef.current;
      if (!node || !activeSnapshotKeyRef.current) return;
      if (restoringInitialHistoryRef.current && node.clientHeight > 0) {
        setLayoutRevision((revision) => revision + 1);
        return;
      }
      if (autoScrollPendingRef.current) {
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
    // A docked/hidden transcript can regain a viewport without changing content.
    if (scrollContainerRef.current) observer.observe(scrollContainerRef.current);

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
      historyPaginationRef.current = { pending: false, scrollHeight: 0 };
      return;
    }
    const { scrollHeight } = historyPaginationRef.current;
    const delta = Math.max(0, container.scrollHeight - scrollHeight);
    // Offset from where the user is *now*, not where they were at request time:
    // trackpad momentum keeps them moving while the page is in flight, and the
    // prepend must keep the text under their eyes wherever that carried them.
    container.scrollTop = container.scrollTop + delta;
    lastScrollHeightRef.current = container.scrollHeight;
    historyPaginationRef.current = { pending: false, scrollHeight: 0 };
    startHistoryScrollAnchor(container);
  }, [isHistoryLoading, messages, startHistoryScrollAnchor]);

  useLayoutEffect(() => {
    if (historyAutoFillRef.current.snapshotKey === scrollSnapshotKey) {
      return;
    }
    historyAutoFillRef.current = {
      snapshotKey: scrollSnapshotKey,
      attempts: 0,
      stalledPages: 0,
      pendingPage: null,
    };
    setHistoryAutoFillExhausted(false);
  }, [scrollSnapshotKey]);

  useLayoutEffect(() => {
    if (!scrollSnapshotKey || restoringInitialHistoryRef.current || !hasMoreHistory || isHistoryLoading) {
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
    scrollSnapshotKey,
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
    highlightedMessageId,
    historyWindowUnderfilled,
    lastComposerScrollTopRef,
    lastScrollHeightRef,
    recordScrollPosition: saveCurrentConversationScrollSnapshot,
    scrollSnapshotKey,
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
