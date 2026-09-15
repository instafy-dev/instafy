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
    if (arrived && (messageTargetActive || !shouldAutoScrollRef.current)) setPendingScope(scope);
  }, [arrivalMessages, currentUserId, hasResolvedHistory, messageTargetActive, scope, shouldAutoScrollRef]);

  useLayoutEffect(() => {
    const node = scrollContainerRef.current;
    if (!node || !scope || !enabled) return;
    const onScroll = () => {
      const current = latest.current;
      if (current.visitKey !== visitKey || current.currentUserId !== currentUserId || current.messageTargetActive
        || !current.hasResolvedHistory || !current.isReadingReady() || node.clientHeight <= 0
        || node.ownerDocument.visibilityState === "hidden" || node.closest('[hidden], [inert], [aria-hidden="true"]')
        || (window.history.state?.key ?? "default") !== current.routeKey) return;
      if (node.scrollHeight - node.clientHeight - node.scrollTop <= LIVE_BOTTOM_THRESHOLD_PX) setPendingScope(null);
    };
    node.addEventListener("scroll", onScroll, { passive: true });
    return () => node.removeEventListener("scroll", onScroll);
  }, [currentUserId, enabled, scope, scrollContainerRef, visitKey]);

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
    hasNewMessages: Boolean(scope && pendingScope === scope && enabled && hasResolvedHistory),
    jumpToLatest,
  };
}
