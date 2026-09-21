import { useCallback, useEffect, useRef, useState } from "react";
import { controllerClient } from "../sdk/instafy";
import { useStatus } from "../status/useStatus";
import type { NotificationPage, NotificationPreferences, ProductNotification } from "./notificationContract";
import { claimNotificationPresentation, NOTIFICATION_RECEIVED_EVENT } from "./notificationPresentation";
import { NOTIFICATION_PREFERENCES_CHANGED_EVENT } from "./notificationPreferencesEvents";
import { areMessageNotificationsEnabled, isAppInForeground, notifyAssistantMessage } from "./assistantMessageNotifications";
import { useGatedInterval } from "../runtime/pollingGate";

const POLL_ACTIVE_MS = 20_000;
const POLL_IDLE_MS = 120_000;

const EMPTY_PAGE: NotificationPage = { items: [], nextCursor: null, unreadCount: 0, asOf: "" };

export interface HomeNotifications {
  page: NotificationPage;
  loading: boolean;
  error: string | null;
  refresh: (options?: { force?: boolean }) => Promise<void>;
  loadMore: () => Promise<void>;
  markRead: (items: ProductNotification[]) => Promise<boolean>;
}

/** Account-owned data and delivery. Home owns the inbox UI; Settings owns preferences. */
export function useNotificationCenter({ userId, accessToken, navigate }: { userId: string | null; accessToken: string | null; navigate: (url: string) => void }): HomeNotifications {
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
  const inFlight = useRef<{ session: typeof session; promise: Promise<void> } | null>(null);
  const preferencesRef = useRef<{ session: typeof session; value: NotificationPreferences } | null>(null);
  // The newest unread page from the last refresh, so presentation does not
  // request it a second time on every tick.
  const latestUnread = useRef<{ session: typeof session; items: ProductNotification[] } | null>(null);
  const toastIds = useRef(new Set<string>());
  const pollRef = useRef<(() => Promise<void>) | null>(null);
  const { showStatus, hideStatus } = useStatus();

  const refresh = useCallback((options?: { force?: boolean }): Promise<void> => {
    if (!userId || !accessToken || !current()) return Promise.resolve();
    if (options?.force) { requests.current += 1; inFlight.current = null; }
    if (inFlight.current?.session === session) return inFlight.current.promise;
    const generation = ++requests.current;
    const valid = () => current() && generation === requests.current;
    patch({ loading: true });
    const promise = (async () => {
      try {
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
        do {
          unread = await controllerClient.notifications.list({ view: "unread", before: unreadCursor, accessToken });
          if (!valid()) return;
          if (!unreadCursor) latestUnread.current = { session, items: unread.items };
          unread.items.forEach(item => items.set(item.id, item));
          if (!unread.nextCursor || unread.nextCursor === unreadCursor) break;
          unreadCursor = unread.nextCursor;
        } while (valid());
        if (valid()) patch({ page: { ...next, items: [...items.values()].sort((a, b) => b.occurredAt.localeCompare(a.occurredAt)), unreadCount: unread!.unreadCount }, error: null });
      } catch (caught) {
        const message = caught instanceof Error ? caught.message : "Unable to load notifications.";
        if (valid()) patch({ error: message === "Unable to load notifications (404)" ? "Notifications are unavailable on this server." : message });
      } finally {
        if (valid()) patch({ loading: false });
        if (valid()) inFlight.current = null;
      }
    })();
    inFlight.current = { session, promise };
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
    const poll = async () => {
      if (stopped || presenting) return;
      presenting = true;
      try {
      await refresh();
      if (!current() || stopped) return;
      // Presentation is independent of Home's paging and never marks a row
      // read. It reuses the unread page refresh() just fetched.
      const unread = latestUnread.current?.session === session ? latestUnread.current.items : null;
      if (!unread) return;
      for (const item of [...unread].reverse()) {
        if (item.seenAt || item.archivedAt || item.readAt) continue;
        const prefs = preferencesRef.current?.session === session ? preferencesRef.current.value : null;
        if (!prefs || prefs.preferences.some((pref) => pref.category === item.category && pref.channel === "local" && !pref.enabled)) continue;
        const foreground = isAppInForeground();
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
          showStatus(item.body, "info", 10_000, { id, nonPreemptive: true, actionLabel: "View", onShow: () => {
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
      } finally { presenting = false; }
    };
    pollRef.current = poll;
    void poll();
    const receive = () => void poll();
    window.addEventListener("focus", receive);
    window.addEventListener(NOTIFICATION_RECEIVED_EVENT, receive);
    return () => { stopped = true; pollRef.current = null; window.removeEventListener("focus", receive); window.removeEventListener(NOTIFICATION_RECEIVED_EVENT, receive); };
  }, [accessToken, current, navigate, refresh, session, showStatus, userId]);
  // Every 20 s while the user is active, every 2 min once idle, never while
  // hidden; focus and NOTIFICATION_RECEIVED_EVENT stay the wake path.
  useGatedInterval(() => void pollRef.current?.(), POLL_ACTIVE_MS, { idleMs: POLL_IDLE_MS });

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
