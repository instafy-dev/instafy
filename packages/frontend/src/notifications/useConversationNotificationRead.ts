import { useEffect, useRef, useSyncExternalStore, type RefObject } from "react";
import { readConversationProductNotifications } from "../services/runtimeController/productNotifications";
import { UUID_PATTERN } from "./notificationContract";
import { getNotificationSession, isNotificationSessionCurrent } from "./notificationSession";
import { NOTIFICATION_RECEIVED_EVENT } from "./notificationPresentation";
import { isAppForeground, subscribeAppForeground } from "../native/appForeground";

const MESSAGE_SELECTOR = "[data-chat-message-id]";
const BATCH_SIZE = 100;
const COALESCE_MS = 250;
const MAX_ATTEMPTS = 3;

function subscribeSession(change: () => void): () => void {
  window.addEventListener("instafy:notification-session", change);
  return () => window.removeEventListener("instafy:notification-session", change);
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

/**
 * Existing message shells carry their exact controller message UUID. Observe
 * those shells, not hydrated history or a conversation's latest timestamp.
 * No IntersectionObserver means no automatic read acknowledgement.
 */
export function useConversationNotificationRead({
  currentUserId,
  conversationId,
  rootRef,
  enabled = true,
}: {
  currentUserId: string | null;
  conversationId: string | null;
  rootRef: RefObject<HTMLElement | null>;
  enabled?: boolean;
}): void {
  const session = useSyncExternalStore(subscribeSession, getNotificationSession, () => null);
  const identity = useRef({ currentUserId, conversationId, enabled, session });
  identity.current = { currentUserId, conversationId, enabled, session };

  useEffect(() => {
    const root = rootRef.current;
    if (!enabled || !root || !currentUserId || !conversationId || !session ||
      session.userId !== currentUserId || !UUID_PATTERN.test(conversationId) ||
      typeof IntersectionObserver === "undefined") return;
    let stopped = false;
    let inFlight = false;
    let failures = 0;
    let timer: number | null = null;
    let exposureGeneration = 0;
    const observed = new Map<Element, string>();
    const visible = new Set<Element>();
    const acknowledged = new Set<string>();
    const current = () => !stopped && identity.current.currentUserId === currentUserId &&
      identity.current.conversationId === conversationId && identity.current.enabled &&
      identity.current.session === session && isNotificationSessionCurrent(session);
    const clearTimer = () => {
      if (timer !== null) window.clearTimeout(timer);
      timer = null;
    };
    const visibleIds = () => [...new Set([...visible]
      .filter((element) => {
        if (!root.contains(element) || !isRendered(element) || typeof document.elementFromPoint !== "function") return false;
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
      .map((element) => observed.get(element))
      .filter((id): id is string => Boolean(id && !acknowledged.has(id))))].slice(0, BATCH_SIZE);
    const schedule = (delay = COALESCE_MS) => {
      if (!current() || !isAppForeground() || inFlight || timer !== null || visibleIds().length === 0) return;
      timer = window.setTimeout(() => { timer = null; void flush(); }, delay);
    };
    const flush = async () => {
      if (!current() || !isAppForeground() || inFlight) return;
      const messageIds = visibleIds();
      if (!messageIds.length) return;
      inFlight = true;
      const generation = exposureGeneration;
      let retryDelay: number | null = null;
      try {
        await readConversationProductNotifications({
          conversationId, messageIds, expectedUserId: currentUserId,
          accessToken: session.accessToken,
          isCurrent: () => current() && generation === exposureGeneration && isAppForeground(),
        });
        if (!current() || generation !== exposureGeneration || !isAppForeground()) return;
        messageIds.forEach((id) => acknowledged.add(id));
        failures = 0;
        window.dispatchEvent(new Event(NOTIFICATION_RECEIVED_EVENT));
        retryDelay = COALESCE_MS;
      } catch {
        if (!current() || generation !== exposureGeneration) return;
        failures += 1;
        if (failures < MAX_ATTEMPTS) retryDelay = 1_000 * 2 ** (failures - 1);
      } finally {
        inFlight = false;
        if (retryDelay !== null) schedule(retryDelay);
        else if (generation !== exposureGeneration) schedule();
      }
    };
    // A viewport root accounts for both the chat's scroll clipping and whether
    // the entire chat pane is outside the window or hidden by another tab.
    const observer = new IntersectionObserver((entries) => {
      if (!current()) return;
      for (const entry of entries) {
        if (!observed.has(entry.target)) continue;
        if (isAppForeground() && entry.isIntersecting &&
          entry.intersectionRect.width > 0 && entry.intersectionRect.height > 0) {
          visible.add(entry.target);
        } else visible.delete(entry.target);
      }
      failures = 0;
      schedule();
    }, { root: null, threshold: [0, Number.EPSILON] });
    const synchronize = () => {
      const elements = new Set(root.querySelectorAll(MESSAGE_SELECTOR));
      for (const element of observed.keys()) {
        if (!elements.has(element) || observed.get(element) !== element.getAttribute("data-chat-message-id")?.toLowerCase()) {
          observer.unobserve(element);
          observed.delete(element);
          visible.delete(element);
        }
      }
      for (const element of elements) {
        const id = element.getAttribute("data-chat-message-id")?.toLowerCase() ?? "";
        if (!UUID_PATTERN.test(id) || observed.has(element)) continue;
        observed.set(element, id);
        observer.observe(element);
      }
      const renderedIds = new Set(observed.values());
      for (const id of acknowledged) if (!renderedIds.has(id)) acknowledged.delete(id);
    };
    synchronize();
    const mutations = new MutationObserver(synchronize);
    mutations.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-chat-message-id"] });
    const refreshVisibility = () => {
      exposureGeneration += 1;
      clearTimer();
      visible.clear();
      failures = 0;
      observer.disconnect();
      if (isAppForeground() && current()) {
        // Require a fresh browser observation after backgrounding; stale
        // intersections must not acknowledge a newly selected hidden pane.
        for (const element of observed.keys()) observer.observe(element);
      }
    };
    const unsubscribeForeground = subscribeAppForeground(refreshVisibility);
    window.addEventListener("focus", refreshVisibility);
    window.addEventListener("online", refreshVisibility);
    const reconsiderExposure = () => { failures = 0; schedule(); };
    root.addEventListener("scroll", reconsiderExposure, { passive: true });
    root.addEventListener("focusin", reconsiderExposure);
    root.addEventListener("pointerup", reconsiderExposure);
    return () => {
      stopped = true;
      clearTimer();
      observer.disconnect();
      mutations.disconnect();
      unsubscribeForeground();
      window.removeEventListener("focus", refreshVisibility);
      window.removeEventListener("online", refreshVisibility);
      root.removeEventListener("scroll", reconsiderExposure);
      root.removeEventListener("focusin", reconsiderExposure);
      root.removeEventListener("pointerup", reconsiderExposure);
    };
  }, [conversationId, currentUserId, enabled, rootRef, session]);
}
