import { useEffect, useRef, useSyncExternalStore, type RefObject } from "react";
import { readConversationProductNotifications } from "../services/runtimeController/productNotifications";
import { UUID_PATTERN } from "./notificationContract";
import { getNotificationSession, isNotificationSessionCurrent } from "./notificationSession";
import { NOTIFICATION_RECEIVED_EVENT } from "./notificationPresentation";

const MESSAGE_SELECTOR = "[data-chat-message-id]";
/**
 * A row that presents several persisted messages as one (an agent job thread
 * renders as `agent-job-thread:<jobId>`) lists their source UUIDs here, so the
 * replies it shows are acknowledged like any other visible message.
 */
export const GROUPED_MESSAGE_IDS_ATTRIBUTE = "data-chat-message-ids";
const BATCH_SIZE = 100;
const COALESCE_MS = 250;
const MAX_ATTEMPTS = 3;

/** A message as the chat's newest page lists it. */
export type ArrivedMessage = { id: string; timestamp: number };

function subscribeSession(change: () => void): () => void {
  window.addEventListener("instafy:notification-session", change);
  return () => window.removeEventListener("instafy:notification-session", change);
}

/** The persisted source message UUIDs a rendered row stands for. */
export function acknowledgementIdsFor(element: Element): string[] {
  const own = element.getAttribute("data-chat-message-id") ?? "";
  const grouped = element.getAttribute(GROUPED_MESSAGE_IDS_ATTRIBUTE) ?? "";
  return [...new Set([own, ...grouped.split(/\s+/)]
    .map((id) => id.trim().toLowerCase())
    .filter((id) => UUID_PATTERN.test(id)))];
}

function isRendered(element: Element): boolean {
  if (!element.isConnected) return false;
  for (let node: Element | null = element; node; node = node.parentElement) {
    if (node.hasAttribute("hidden") || node.hasAttribute("inert") || node.getAttribute("aria-hidden") === "true") return false;
    const style = getComputedStyle(node);
    if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse" || style.opacity === "0") return false;
  }
  return true;
}

/** The persisted messages of a newest page: lowercase UUID ids, with a time. */
function persistedArrivals(messages: readonly ArrivedMessage[]): ArrivedMessage[] {
  return messages
    .map((message) => ({ id: typeof message.id === "string" ? message.id.trim().toLowerCase() : "", timestamp: message.timestamp }))
    .filter((message) => UUID_PATTERN.test(message.id) && Number.isFinite(message.timestamp));
}

/**
 * Existing message shells carry their exact controller message UUID. Observe
 * those shells, not hydrated history or a conversation's latest timestamp.
 * No IntersectionObserver means no automatic read acknowledgement of a row.
 *
 * A message that lands in the chat while the person has it open (`open`: its
 * Chat or its Browser view is on screen) and the window is visible counts as
 * read as it lands, wherever the transcript is scrolled: the person is in that
 * chat, and Home and the badges do not flag it. Only messages that arrive
 * after the chat's first history read (`arrivals`) land; history never does.
 */
export function useConversationNotificationRead({
  currentUserId,
  conversationId,
  rootRef,
  enabled = true,
  arrivals = null,
  open = false,
}: {
  currentUserId: string | null;
  conversationId: string | null;
  rootRef: RefObject<HTMLElement | null>;
  /** The chat's transcript is on screen: a message counts as read once its row shows. */
  enabled?: boolean;
  /**
   * The chat's newest messages (useConversationHistoryState's
   * `latestArrivalMessages`) once its first history read has resolved; null
   * until then. Those listed the first time are history; later ones land.
   */
  arrivals?: readonly ArrivedMessage[] | null;
  /** The chat is open in either view: Chat or its Browser view. */
  open?: boolean;
}): void {
  const session = useSyncExternalStore(subscribeSession, getNotificationSession, () => null);
  const active = enabled || open;
  const identity = useRef({ currentUserId, conversationId, active, open, session });
  identity.current = { currentUserId, conversationId, active, open, session };
  const scope = currentUserId && conversationId && session ? JSON.stringify([currentUserId, conversationId, session.userId]) : null;
  /** Messages that landed while the chat was open, still to acknowledge, for one chat. */
  const landed = useRef<{ scope: string | null; ids: Set<string> }>({ scope: null, ids: new Set() });
  /** What the chat's newest page listed so far: the first list is history. */
  const arrived = useRef<{ scope: string | null; known: Set<string>; newest: number } | null>(null);
  /** Asks the acknowledging effect to look again once a message landed. */
  const wake = useRef<() => void>(() => {});

  useEffect(() => {
    if (landed.current.scope !== scope) landed.current = { scope, ids: new Set() };
    if (arrived.current && arrived.current.scope !== scope) arrived.current = null;
    if (!scope || !arrivals) return;
    const persisted = persistedArrivals(arrivals);
    const newest = persisted.reduce((value, message) => Math.max(value, message.timestamp), arrived.current?.newest ?? -Infinity);
    if (!arrived.current) {
      arrived.current = { scope, known: new Set(persisted.map((message) => message.id)), newest };
      return;
    }
    const known = arrived.current;
    const landing = open && document.visibilityState === "visible";
    let added = false;
    for (const message of persisted) {
      if (known.known.has(message.id)) continue;
      known.known.add(message.id);
      // An older message the newest page now lists is history, not news.
      if (!landing || message.timestamp < known.newest) continue;
      landed.current.ids.add(message.id);
      added = true;
    }
    known.newest = newest;
    if (added) wake.current();
  }, [arrivals, open, scope]);

  useEffect(() => {
    const root = rootRef.current;
    if (!active || !currentUserId || !conversationId || !session ||
      session.userId !== currentUserId || !UUID_PATTERN.test(conversationId)) return;
    const observeRows = enabled && root !== null && typeof IntersectionObserver !== "undefined";
    let stopped = false;
    let inFlight = false;
    let failures = 0;
    let timer: number | null = null;
    const observed = new Map<Element, { key: string; ids: string[] }>();
    const visible = new Set<Element>();
    const acknowledged = new Set<string>();
    const current = () => !stopped && identity.current.currentUserId === currentUserId &&
      identity.current.conversationId === conversationId && identity.current.active &&
      identity.current.session === session && isNotificationSessionCurrent(session);
    const clearTimer = () => {
      if (timer !== null) window.clearTimeout(timer);
      timer = null;
    };
    const landedIds = () => landed.current.scope === scope ? [...landed.current.ids].filter((id) => !acknowledged.has(id)) : [];
    const visibleIds = () => [...new Set([...landedIds(), ...[...visible]
      .filter((element) => {
        if (!root || !root.contains(element) || !isRendered(element) || typeof document.elementFromPoint !== "function") return false;
        const bounds = element.getBoundingClientRect();
        const rootBounds = root.getBoundingClientRect();
        // Intersections can stay positive while scrolling without another IO
        // callback. Hit-test current geometry, never a stale entry rectangle.
        const left = Math.max(0, bounds.left, rootBounds.left);
        const top = Math.max(0, bounds.top, rootBounds.top);
        const right = Math.min(window.innerWidth, bounds.right, rootBounds.right);
        const bottom = Math.min(window.innerHeight, bounds.bottom, rootBounds.bottom);
        if (right <= left || bottom <= top) return false;
        // Intersection alone includes content behind opaque modal overlays.
        // Confirm a point in the displayed part of this exact message is hit.
        const topmost = document.elementFromPoint((left + right) / 2, (top + bottom) / 2);
        return topmost !== null && element.contains(topmost);
      })
      .flatMap((element) => observed.get(element)?.ids ?? [])
      .filter((id) => !acknowledged.has(id))])].slice(0, BATCH_SIZE);
    const schedule = (delay = COALESCE_MS) => {
      if (!current() || document.visibilityState !== "visible" || inFlight || timer !== null || visibleIds().length === 0) return;
      timer = window.setTimeout(() => { timer = null; void flush(); }, delay);
    };
    const flush = async () => {
      if (!current() || document.visibilityState !== "visible" || inFlight) return;
      const messageIds = visibleIds();
      if (!messageIds.length) return;
      inFlight = true;
      let retryDelay: number | null = null;
      try {
        await readConversationProductNotifications({
          conversationId, messageIds, expectedUserId: currentUserId,
          accessToken: session.accessToken,
          isCurrent: () => current() && document.visibilityState === "visible",
        });
        if (!current()) return;
        messageIds.forEach((id) => {
          acknowledged.add(id);
          if (landed.current.scope === scope) landed.current.ids.delete(id);
        });
        failures = 0;
        window.dispatchEvent(new Event(NOTIFICATION_RECEIVED_EVENT));
        retryDelay = COALESCE_MS;
      } catch {
        if (!current()) return;
        failures += 1;
        if (failures < MAX_ATTEMPTS) retryDelay = 1_000 * 2 ** (failures - 1);
      } finally {
        inFlight = false;
        if (retryDelay !== null) schedule(retryDelay);
      }
    };
    wake.current = () => { failures = 0; schedule(); };
    // A viewport root accounts for both the chat's scroll clipping and whether
    // the entire chat pane is outside the window or hidden by another tab.
    const observer = observeRows ? new IntersectionObserver((entries) => {
      if (!current()) return;
      for (const entry of entries) {
        if (!observed.has(entry.target)) continue;
        if (document.visibilityState === "visible" && entry.isIntersecting &&
          entry.intersectionRect.width > 0 && entry.intersectionRect.height > 0) {
          visible.add(entry.target);
        } else visible.delete(entry.target);
      }
      failures = 0;
      schedule();
    }, { root: null, threshold: [0, Number.EPSILON] }) : null;
    const synchronize = () => {
      if (!root || !observer) return;
      const elements = new Set(root.querySelectorAll(MESSAGE_SELECTOR));
      for (const [element, entry] of observed) {
        if (!elements.has(element) || entry.key !== acknowledgementIdsFor(element).join(" ")) {
          observer.unobserve(element);
          observed.delete(element);
          visible.delete(element);
        }
      }
      for (const element of elements) {
        if (observed.has(element)) continue;
        const ids = acknowledgementIdsFor(element);
        if (!ids.length) continue;
        observed.set(element, { key: ids.join(" "), ids });
        observer.observe(element);
      }
      const renderedIds = new Set([...observed.values()].flatMap((entry) => entry.ids));
      for (const id of acknowledged) if (!renderedIds.has(id)) acknowledged.delete(id);
    };
    synchronize();
    const mutations = observer && root ? new MutationObserver(synchronize) : null;
    if (mutations && root) {
      mutations.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-chat-message-id", GROUPED_MESSAGE_IDS_ATTRIBUTE] });
    }
    const refreshVisibility = () => {
      clearTimer();
      visible.clear();
      failures = 0;
      observer?.disconnect();
      if (document.visibilityState === "visible" && current()) {
        // Require a fresh browser observation after backgrounding; stale
        // intersections must not acknowledge a newly selected hidden pane.
        if (observer) for (const element of observed.keys()) observer.observe(element);
        // What landed while the window was visible is still read.
        schedule();
      }
    };
    document.addEventListener("visibilitychange", refreshVisibility);
    window.addEventListener("focus", refreshVisibility);
    window.addEventListener("online", refreshVisibility);
    const reconsiderExposure = () => { failures = 0; schedule(); };
    root?.addEventListener("scroll", reconsiderExposure, { passive: true });
    root?.addEventListener("focusin", reconsiderExposure);
    root?.addEventListener("pointerup", reconsiderExposure);
    // Something that landed before this effect began (the view changed as it landed).
    schedule();
    return () => {
      stopped = true;
      wake.current = () => {};
      clearTimer();
      observer?.disconnect();
      mutations?.disconnect();
      document.removeEventListener("visibilitychange", refreshVisibility);
      window.removeEventListener("focus", refreshVisibility);
      window.removeEventListener("online", refreshVisibility);
      root?.removeEventListener("scroll", reconsiderExposure);
      root?.removeEventListener("focusin", reconsiderExposure);
      root?.removeEventListener("pointerup", reconsiderExposure);
    };
  }, [active, conversationId, currentUserId, enabled, rootRef, scope, session]);
}
