import { useCallback, useEffect, useRef, useState } from "react";
import { controllerClient } from "../sdk/instafy";
import { useStatus } from "../status/useStatus";
import type { NotificationPage, NotificationPreferences, ProductNotification } from "./notificationContract";
import { claimNotificationPresentation, NOTIFICATION_RECEIVED_EVENT } from "./notificationPresentation";
import { NOTIFICATION_PREFERENCES_CHANGED_EVENT } from "./notificationPreferencesEvents";
import { NOTIFICATION_FEED_CHANGED_EVENT } from "./notificationFeedEvents";
import { areMessageNotificationsEnabled, isAppInForeground, notifyAssistantMessage } from "./assistantMessageNotifications";
import { useGatedInterval } from "../runtime/pollingGate";
import { announceConversationReplies, isConversationOpen } from "./openConversations";

// A timer tick reads only the newest unread page and refreshes the rest only
// when that page or the unread total changed. Web Push, native push and the
// open space's event stream deliver the urgent cases sooner.
const POLL_ACTIVE_MS = 30_000;
const POLL_IDLE_MS = 300_000;

const EMPTY_PAGE: NotificationPage = { items: [], nextCursor: null, unreadCount: 0, asOf: "" };

/** Everything a tick compares: the unread total and the newest unread rows' states. */
function unreadSignature(page: NotificationPage): string {
  return `${page.unreadCount}|${page.items.map(item => `${item.id}:${item.seenAt ?? ""}:${item.readAt ?? ""}:${item.archivedAt ?? ""}`).join(",")}`;
}

/** The conversation a notification is about (a reply, a failed run), from its canonical Studio URL. */
export function notificationConversationId(item: ProductNotification): string | null {
  try {
    const id = new URL(item.url, "https://instafy.invalid").searchParams.get("conversationControllerId");
    if (id) return id.toLowerCase();
  } catch { /* canonical URLs always parse */ }
  return item.resourceType === "conversation" && item.resourceId ? item.resourceId.toLowerCase() : null;
}

/** The conversation a `conversation.reply` notification points at. */
export function replyConversationId(item: ProductNotification): string | null {
  return item.eventName === "conversation.reply" ? notificationConversationId(item) : null;
}

/** The longest chat name a toast quotes; a longer one is cut with "…". */
const TOAST_CHAT_NAME_MAX_CHARS = 60;

/**
 * What a toast in Studio says: a reply names its chat when Studio knows the
 * chat's name, so the person knows which chat it is before they open it. A
 * notification shown outside Studio keeps the registry text alone.
 */
export function notificationToastText(item: ProductNotification, chatName: string | null): string {
  const name = chatName?.replace(/\s+/g, " ").trim() ?? "";
  if (!replyConversationId(item) || !name) return item.body;
  const shown = [...name].length > TOAST_CHAT_NAME_MAX_CHARS
    ? `${[...name].slice(0, TOAST_CHAT_NAME_MAX_CHARS - 1).join("").trimEnd()}…`
    : name;
  return `There is a new reply in “${shown}”.`;
}

export interface HomeNotifications {
  page: NotificationPage;
  loading: boolean;
  error: string | null;
  refresh: (options?: { force?: boolean }) => Promise<void>;
  loadMore: () => Promise<void>;
  markRead: (items: ProductNotification[]) => Promise<boolean>;
}

/**
 * Account-owned data and delivery. Home owns the inbox UI; Settings owns preferences. `chatName`: a chat's name by
 * its controller id, when this tab knows it.
 */
export function useNotificationCenter({ userId, accessToken, navigate, chatName }: {
  userId: string | null;
  accessToken: string | null;
  navigate: (url: string) => void;
  chatName?: (conversationId: string) => string | null;
}): HomeNotifications {
  const chatNameRef = useRef(chatName);
  chatNameRef.current = chatName;
  const identity = useRef({ userId, accessToken });
  if (identity.current.userId !== userId || identity.current.accessToken !== accessToken) identity.current = { userId, accessToken };
  const session = identity.current;
  const mounted = useRef(true);
  const current = useCallback(() => mounted.current && identity.current === session, [session]);
  const [snapshot, setSnapshot] = useState<{ session: typeof session; page: NotificationPage; error: string | null; loading: boolean }>({ session, page: EMPTY_PAGE, error: null, loading: Boolean(userId) });
  const state = snapshot.session === session ? snapshot : { page: EMPTY_PAGE, error: null, loading: Boolean(userId) };
  const patch = useCallback((update: Partial<Omit<typeof snapshot, "session">>) => {
    if (current()) setSnapshot(old => ({ ...(old.session === session ? old : { page: EMPTY_PAGE, error: null, loading: false }), ...update, session }));
  }, [current, session]);
  const requests = useRef(0);
  const depth = useRef({ session, value: 1 });
  if (depth.current.session !== session) depth.current = { session, value: 1 };
  const oldest = useRef<{ session: typeof session; at: string; id: string } | null>(null);
  const inFlight = useRef<{ session: typeof session; promise: Promise<void>; check: boolean } | null>(null);
  // The newest unread page as of the last complete refresh, for timer checks.
  const unreadSeen = useRef<{ session: typeof session; signature: string } | null>(null);
  const preferencesRef = useRef<{ session: typeof session; value: NotificationPreferences } | null>(null);
  // The newest unread page from the last refresh, so presentation does not
  // request it a second time on every tick.
  const latestUnread = useRef<{ session: typeof session; items: ProductNotification[] } | null>(null);
  const toastIds = useRef(new Set<string>());
  // Reply notifications already announced to the open chat, per session.
  const announced = useRef<{ session: typeof session; ids: Set<string> } | null>(null);
  const pollRef = useRef<((options?: { check?: boolean }) => Promise<void>) | null>(null);
  const { showStatus, hideStatus } = useStatus();

  const refresh = useCallback((options?: { force?: boolean; ifUnreadChanged?: boolean }): Promise<void> => {
    if (!userId || !accessToken || !current()) return Promise.resolve();
    const check = Boolean(options?.ifUnreadChanged && !options.force);
    if (options?.force) { requests.current += 1; inFlight.current = null; }
    // A check joins any request in flight; a full refresh replaces a check.
    if (inFlight.current?.session === session && (check || !inFlight.current.check)) return inFlight.current.promise;
    const generation = ++requests.current;
    const valid = () => current() && generation === requests.current;
    if (!check) patch({ loading: true });
    const promise = (async () => {
      try {
        let firstUnread: NotificationPage | undefined;
        if (check) {
          firstUnread = await controllerClient.notifications.list({ view: "unread", accessToken });
          if (!valid()) return;
          latestUnread.current = { session, items: firstUnread.items };
          if (unreadSeen.current?.session === session && unreadSeen.current.signature === unreadSignature(firstUnread)) return;
        }
        // Refresh the loaded range, including read state, rather than discarding
        // older pages while somebody is reading Home.
        let before: string | undefined;
        let next = EMPTY_PAGE;
        const items = new Map<string, ProductNotification>();
        const boundary = oldest.current?.session === session ? oldest.current : null;
        let pages = 0;
        while (valid()) {
          next = await controllerClient.notifications.list({ view: "all", before, accessToken });
          if (!valid()) return;
          pages += 1;
          next.items.forEach(item => items.set(item.id, item));
          const last = next.items.at(-1);
          const covered = !boundary || items.has(boundary.id) || (last && last.occurredAt < boundary.at);
          if (!next.nextCursor || next.nextCursor === before || (pages >= depth.current.value && covered)) break;
          before = next.nextCursor;
        }
        if (valid()) {
          depth.current.value = pages;
          const last = next.items.at(-1);
          if (last) oldest.current = { session, id: last.id, at: last.occurredAt };
        }
        // Unread destinations may be older than Recent's first page. Include
        // all unread pages so Home's single badge counts destinations, not just
        // whichever notification page happens to be open.
        let unreadCursor: string | undefined;
        let unread: NotificationPage;
        let signature = "";
        do {
          unread = !unreadCursor && firstUnread ? firstUnread : await controllerClient.notifications.list({ view: "unread", before: unreadCursor, accessToken });
          if (!valid()) return;
          if (!unreadCursor) {
            latestUnread.current = { session, items: unread.items };
            signature = unreadSignature(unread);
          }
          unread.items.forEach(item => items.set(item.id, item));
          if (!unread.nextCursor || unread.nextCursor === unreadCursor) break;
          unreadCursor = unread.nextCursor;
        } while (valid());
        if (valid()) {
          patch({ page: { ...next, items: [...items.values()].sort((a, b) => b.occurredAt.localeCompare(a.occurredAt)), unreadCount: unread!.unreadCount }, error: null });
          unreadSeen.current = { session, signature };
          if (check) window.dispatchEvent(new CustomEvent(NOTIFICATION_FEED_CHANGED_EVENT, { detail: { userId } }));
        }
      } catch (caught) {
        const message = caught instanceof Error ? caught.message : "Unable to load notifications.";
        if (valid()) {
          // The next check refreshes everything, which also clears this error.
          unreadSeen.current = null;
          patch({ error: message === "Unable to load notifications (404)" ? "Notifications are unavailable on this server." : message });
        }
      } finally {
        if (valid() && !check) patch({ loading: false });
        if (valid()) inFlight.current = null;
      }
    })();
    inFlight.current = { session, promise, check };
    return promise;
  }, [accessToken, current, patch, session, userId]);

  useEffect(() => {
    mounted.current = true;
    const ids = toastIds.current;
    return () => { mounted.current = false; requests.current += 1; if (inFlight.current?.session === session) inFlight.current = null; for (const id of ids) hideStatus(id); ids.clear(); };
  }, [session, hideStatus]);

  useEffect(() => {
    if (!userId || !accessToken) return;
    let active = true;
    const refreshPreferences = () => {
      void controllerClient.notifications.getPreferences(accessToken).then(value => {
        if (active && current()) preferencesRef.current = { session, value };
      }).catch(() => { /* Preferences errors are shown in Settings; never guess delivery consent. */ });
    };
    refreshPreferences();
    const changed = (event: Event) => {
      if ((event as CustomEvent<{ userId: string }>).detail?.userId === userId) refreshPreferences();
    };
    window.addEventListener(NOTIFICATION_PREFERENCES_CHANGED_EVENT, changed);
    return () => { active = false; window.removeEventListener(NOTIFICATION_PREFERENCES_CHANGED_EVENT, changed); };
  }, [userId, accessToken, current, session]);

  useEffect(() => {
    if (!userId || !accessToken) return;
    let stopped = false;
    let presenting = false;
    // A push that lands while a pass is presenting may postdate the page that
    // pass read, so it runs one full pass right after. A timer check that
    // lands then adds nothing and is dropped.
    let refreshAfter = false;
    const poll = async (options?: { check?: boolean }) => {
      if (stopped) return;
      if (presenting) {
        if (!options?.check) refreshAfter = true;
        return;
      }
      presenting = true;
      try {
      await refresh(options?.check ? { ifUnreadChanged: true } : undefined);
      if (!current() || stopped) return;
      // Presentation is independent of Home's paging and never marks a row
      // read. It reuses the unread page refresh() just fetched.
      const unread = latestUnread.current?.session === session ? latestUnread.current.items : null;
      if (!unread) return;
      // The durable feed is the safety net for a missed live chat event: tell
      // the chat about each new reply once so an open conversation re-reads
      // its newest page instead of waiting for input to resume its own poll.
      if (announced.current?.session !== session) announced.current = { session, ids: new Set() };
      const announcedIds = announced.current.ids;
      const replyConversations: string[] = [];
      for (const item of unread) {
        if (item.readAt || item.archivedAt || announcedIds.has(item.id)) continue;
        const conversationId = replyConversationId(item);
        if (!conversationId) continue;
        announcedIds.add(item.id);
        replyConversations.push(conversationId);
      }
      announceConversationReplies(replyConversations);
      for (const item of [...unread].reverse()) {
        if (item.seenAt || item.archivedAt || item.readAt) continue;
        const prefs = preferencesRef.current?.session === session ? preferencesRef.current.value : null;
        if (!prefs || prefs.preferences.some((pref) => pref.category === item.category && pref.channel === "local" && !pref.enabled)) continue;
        const foreground = isAppInForeground();
        if (foreground && isConversationOpen(notificationConversationId(item))) {
          // The open chat is the presentation for its own replies and failed
          // runs; a banner here repeats what is on screen and its View only
          // reopens the same chat. Mark it seen so it does not toast later
          // from another view; the chat's read hook marks a reply read.
          void controllerClient.notifications.updateState({ id: item.id, action: "seen", accessToken, expectedUserId: userId, isCurrent: current }).catch(() => {});
          continue;
        }
        if (!foreground && !areMessageNotificationsEnabled()) continue;
        const { Capacitor } = await import("@capacitor/core");
        if (Capacitor.isNativePlatform()) {
          if (!foreground) continue;
        } else if (!window.instafyDesktop) {
          const webPushEnabled = prefs.preferences.find((pref) => pref.category === item.category && pref.channel === "web_push")?.enabled ?? true;
          const { hasActiveWebPushSubscription } = await import("./webPushRegistration");
          // Web Push must show a notification even while the page is focused.
          // Let the worker own presentation whenever this channel is active.
          if (webPushEnabled && await hasActiveWebPushSubscription()) continue;
        }
        if (!current() || stopped || !(await claimNotificationPresentation(userId, item.id))) continue;
        if (!current() || stopped) return;
        let presented = false;
        if (foreground) {
          const id = `notification:${userId}:${item.id}`;
          toastIds.current.add(id);
          const conversationId = replyConversationId(item);
          const text = notificationToastText(item, conversationId ? chatNameRef.current?.(conversationId) ?? null : null);
          showStatus(text, "info", 10_000, { id, nonPreemptive: true, actionLabel: "View", onShow: () => {
            if (current() && isAppInForeground()) {
              void controllerClient.notifications.updateState({ id: item.id, action: "seen", accessToken, expectedUserId: userId, isCurrent: current }).catch(() => {});
            }
          }, onClose: () => toastIds.current.delete(id), onAction: () => {
            if (!current()) return;
            void controllerClient.notifications.updateState({ id: item.id, action: "read", accessToken, expectedUserId: userId, isCurrent: current }).then(() => refresh()).catch(() => {});
            navigate(item.url);
          } });
        } else {
          presented = await notifyAssistantMessage({ title: "Instafy", body: prefs.hidePreviews ? "You have a new notification." : item.body, url: item.url, eventId: item.id, accountId: userId });
        }
        // A queued toast is not proof of visibility; its local claim suppresses
        // duplicates without advancing server seen/read state.
        if (!foreground && presented) void controllerClient.notifications.updateState({ id: item.id, action: "seen", accessToken, expectedUserId: userId, isCurrent: current }).catch(() => {});
      }
      } finally {
        presenting = false;
        if (refreshAfter && !stopped) {
          refreshAfter = false;
          void poll();
        }
      }
    };
    pollRef.current = poll;
    void poll();
    const receive = () => void poll();
    window.addEventListener(NOTIFICATION_RECEIVED_EVENT, receive);
    return () => { stopped = true; pollRef.current = null; window.removeEventListener(NOTIFICATION_RECEIVED_EVENT, receive); };
  }, [accessToken, current, navigate, refresh, session, showStatus, userId]);
  // A check every 30 s while the user is active, every 5 min once idle, never
  // while hidden, and once when the user comes back (window focus counts as
  // input) unless the last check was under 30 s ago. A push
  // (NOTIFICATION_RECEIVED_EVENT) refreshes everything at once.
  useGatedInterval(() => void pollRef.current?.({ check: true }), POLL_ACTIVE_MS, { idleMs: POLL_IDLE_MS });

  const markRead = useCallback(async (items: ProductNotification[]): Promise<boolean> => {
    if (!userId || !accessToken || !current()) return false;
    const ids = [...new Set(items.filter(item => !item.readAt && !item.archivedAt).map(item => item.id))];
    try {
      // Only the displayed snapshot is acknowledged. Concurrent arrivals stay unread.
      await Promise.all(ids.map(id => controllerClient.notifications.updateState({ id, action: "read", accessToken, expectedUserId: userId, isCurrent: current })));
      if (!current()) return false;
      // Supersede a pre-acknowledgement poll; it must not restore old unread rows.
      requests.current += 1;
      inFlight.current = null;
      await refresh();
      if (current()) window.dispatchEvent(new Event(NOTIFICATION_RECEIVED_EVENT));
      return current();
    } catch (caught) {
      if (current()) patch({ error: caught instanceof Error ? caught.message : "Unable to mark this as read." });
      return false;
    }
  }, [accessToken, current, patch, refresh, userId]);

  const loadMore = useCallback(async () => {
    if (!current()) return;
    await refresh();
    if (!current()) return;
    depth.current.value += 1;
    await refresh();
  }, [current, refresh]);

  return { ...state, refresh, loadMore, markRead };
}
