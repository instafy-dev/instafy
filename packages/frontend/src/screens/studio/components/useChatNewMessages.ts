import { useCallback, useLayoutEffect, useRef, useState, type MutableRefObject, type RefObject } from "react";
import { isUnreadEligibleConversationMessage } from "../../../conversations/unreadCount";
import { isUUID } from "../../../utils/uuid";
import type { ChatMessage } from "../types";

const LIVE_BOTTOM_THRESHOLD_PX = 24;

interface NewMessagesOptions {
  visitKey: string | null;
  routeKey: string;
  currentUserId: string | null;
  enabled: boolean;
  hasResolvedHistory: boolean;
  arrivalMessages: readonly ChatMessage[];
  messageTargetActive: boolean;
  scrollContainerRef: RefObject<HTMLDivElement | null>;
  shouldAutoScrollRef: MutableRefObject<boolean>;
  isReadingReady: () => boolean;
  onJumpToLatest: () => void;
}

/**
 * The live reader sees the newest message: the chat is on screen, in its live
 * window, and scrolled to the bottom.
 */
function readerAtNewest(node: HTMLDivElement, options: NewMessagesOptions): boolean {
  if (options.messageTargetActive || !options.hasResolvedHistory || !options.isReadingReady() || node.clientHeight <= 0
    || node.ownerDocument.visibilityState === "hidden" || node.closest('[hidden], [inert], [aria-hidden="true"]')
    || (window.history.state?.key ?? "default") !== options.routeKey) return false;
  return node.scrollHeight - node.clientHeight - node.scrollTop <= LIVE_BOTTOM_THRESHOLD_PX;
}

/** Tracks arrivals after the first authorized history read, independently from
 * the historical window being displayed. It never changes the reading position. */
export function useChatNewMessages(options: NewMessagesOptions) {
  const { visitKey, currentUserId, enabled, hasResolvedHistory, arrivalMessages, messageTargetActive,
    scrollContainerRef, shouldAutoScrollRef } = options;
  const scope = visitKey && currentUserId ? JSON.stringify([currentUserId, visitKey]) : null;
  const latest = useRef(options);
  latest.current = options;
  const baseline = useRef<{ scope: string | null; initialized: boolean; newest: number; seenContent: Map<string, boolean> }>({
    scope: null, initialized: false, newest: -Infinity, seenContent: new Map(),
  });
  const [pendingScope, setPendingScope] = useState<string | null>(null);

  useLayoutEffect(() => {
    if (baseline.current.scope !== scope) {
      baseline.current = { scope, initialized: false, newest: -Infinity, seenContent: new Map() };
      setPendingScope(null);
    }
    if (!scope || !hasResolvedHistory) return;
    const known = baseline.current;
    const persisted = arrivalMessages.filter(message => isUUID(message.id) && Number.isFinite(message.timestamp));
    const newest = persisted.reduce((value, message) => Math.max(value, message.timestamp), known.newest);
    if (!known.initialized) {
      known.initialized = true;
      known.newest = newest;
      known.seenContent = new Map(persisted.map(message => [message.id, Boolean(message.content.trim() || message.files?.length)]));
      return;
    }
    let arrived = false;
    for (const message of persisted) {
      if (!isUnreadEligibleConversationMessage(message, currentUserId)) continue;
      const hadContent = known.seenContent.get(message.id);
      if (hadContent === true) continue;
      if (!(message.content.trim() || message.files?.length)) {
        known.seenContent.set(message.id, false);
        continue;
      }
      known.seenContent.set(message.id, true);
      // Persisted streaming rows can be blank in the initial baseline. Their
      // first content is new even if a later message already set the watermark.
      if (hadContent === false || message.timestamp >= known.newest) arrived = true;
    }
    known.newest = newest;
    const node = scrollContainerRef.current;
    // An arrival the reader already sees at the bottom is no news.
    if (arrived && enabled && node && readerAtNewest(node, latest.current)) return;
    if (arrived && (messageTargetActive || !shouldAutoScrollRef.current)) setPendingScope(scope);
  }, [arrivalMessages, currentUserId, enabled, hasResolvedHistory, messageTargetActive, scope, scrollContainerRef, shouldAutoScrollRef]);

  // The visible live reader at the newest message has seen every arrival. It
  // gets there by scrolling, or without a scroll: the chat came back from its
  // Browser view (hidden, it noted a reply) already at the bottom, the
  // transcript resized under it, or its content grew (a reply, a row that
  // finished rendering). A chat that fits on screen never scrolls, and a reply
  // grows the content, not the scroller, so only a scroll or a resize of the
  // scroller left the pill over the newest turn of a chat at the bottom.
  const pending = Boolean(scope && pendingScope === scope);
  const settle = useCallback(() => {
    const node = scrollContainerRef.current;
    const current = latest.current;
    if (!node || !scope || !current.enabled) return;
    if (current.visitKey !== visitKey || current.currentUserId !== currentUserId) return;
    if (readerAtNewest(node, current)) setPendingScope(null);
  }, [currentUserId, scope, scrollContainerRef, visitKey]);
  useLayoutEffect(() => {
    const node = scrollContainerRef.current;
    if (!node || !scope || !enabled || !pending) return;
    settle();
    node.addEventListener("scroll", settle, { passive: true });
    const resize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => settle());
    resize?.observe(node);
    for (const child of Array.from(node.children)) resize?.observe(child);
    const grown = typeof MutationObserver === "undefined" ? null : new MutationObserver(() => settle());
    grown?.observe(node, { childList: true, subtree: true, characterData: true });
    return () => {
      node.removeEventListener("scroll", settle);
      resize?.disconnect();
      grown?.disconnect();
    };
  }, [enabled, pending, scope, scrollContainerRef, settle]);
  // The chat restores its place after it shows again (a frame or two later,
  // with no scroll when it lands where it was): each render asks again while
  // the pill is up, so it goes the moment the place is the newest message.
  useLayoutEffect(() => {
    if (pending) settle();
  });

  const jumpToLatest = useCallback(() => {
    const current = latest.current;
    const node = current.scrollContainerRef.current;
    if (!current.enabled || !current.hasResolvedHistory || !node || (!current.messageTargetActive && !current.isReadingReady())
      || current.visitKey !== visitKey || current.currentUserId !== currentUserId
      || (window.history.state?.key ?? "default") !== current.routeKey) return;
    current.onJumpToLatest();
    setPendingScope(null);
  }, [currentUserId, visitKey]);

  return {
    // Never while the chat is still finding its place: whether the arrival is
    // out of view is known only once it has.
    hasNewMessages: pending && enabled && hasResolvedHistory && (options.messageTargetActive || options.isReadingReady()),
    jumpToLatest,
  };
}
