import { useCallback, useEffect, useRef, useState } from "react";
import { Bell } from "iconoir-react";
import { controllerClient } from "../sdk/instafy";
import { Button, IconButton } from "../components/Button";
import { StudioDialogModal } from "../components/aria/StudioModal";
import { StudioDialogHeader } from "../components/aria/StudioDialogLayout";
import { useStatus } from "../status/useStatus";
import { NOTIFICATION_CATEGORIES, NOTIFICATION_CHANNELS, type NotificationPage, type NotificationPreferences, type ProductNotification, type NotificationPreference } from "./notificationContract";
import { claimNotificationPresentation, NOTIFICATION_RECEIVED_EVENT } from "./notificationPresentation";
import { areMessageNotificationsEnabled, enableMessageNotifications, isAppInForeground, notifyAssistantMessage } from "./assistantMessageNotifications";
import { useNativeBackButtonAction } from "../native/useNativeBackButtonAction";

const CATEGORY_LABELS = { support: "Support", conversations: "Conversations", runs: "Runs", automations: "Automations" };
const CHANNEL_LABELS = { web_push: "Browser push", apns: "iPhone push", local: "In-app and desktop alerts" };
const EMPTY_PAGE: NotificationPage = { items: [], nextCursor: null, unreadCount: 0, asOf: "" };

export function useNotificationCenter({ userId, accessToken, navigate }: { userId: string | null; accessToken: string | null; navigate: (url: string) => void }) {
  const [open, setOpen] = useState(false);
  useNativeBackButtonAction(open && Boolean(userId), () => setOpen(false));
  const [view, setView] = useState<"all" | "unread">("all");
  const [pageSnapshot, setPageSnapshot] = useState<{ userId: string | null; page: NotificationPage }>({ userId: null, page: EMPTY_PAGE });
  const page = pageSnapshot.userId === userId ? pageSnapshot.page : EMPTY_PAGE;
  const setPage = useCallback((update: NotificationPage | ((old: NotificationPage) => NotificationPage)) => {
    setPageSnapshot((old) => ({ userId, page: typeof update === "function" ? update(old.userId === userId ? old.page : EMPTY_PAGE) : update }));
  }, [userId]);
  const [preferenceSnapshot, setPreferenceSnapshot] = useState<{ userId: string | null; value: NotificationPreferences | null }>({ userId: null, value: null });
  const preferences = preferenceSnapshot.userId === userId ? preferenceSnapshot.value : null;
  const setPreferences = useCallback((value: NotificationPreferences | null) => setPreferenceSnapshot({ userId, value }), [userId]);
  const [settings, setSettings] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { showStatus, hideStatus } = useStatus();
  const identity = useRef({ userId, accessToken, generation: 0 });
  if (identity.current.userId !== userId || identity.current.accessToken !== accessToken) {
    identity.current = { userId, accessToken, generation: identity.current.generation + 1 };
  }
  const identityGeneration = identity.current.generation;
  const requests = useRef(0);
  const toastIds = useRef(new Set<string>());
  const openRef = useRef(open);
  openRef.current = open;
  const paginatedRef = useRef(false);
  const preferencesRef = useRef(preferences);
  preferencesRef.current = preferences;
  useEffect(() => { paginatedRef.current = false; }, [userId, view]);
  const current = useCallback((id: string, token: string) => identity.current.userId === id && identity.current.accessToken === token && identity.current.generation === identityGeneration, [identityGeneration]);

  const refresh = useCallback(async (before?: string) => {
    if (!userId || !accessToken) return;
    const generation = ++requests.current;
    try {
      const next = await controllerClient.notifications.list({ view, before, accessToken });
      if (!current(userId, accessToken) || generation !== requests.current) return;
      paginatedRef.current = Boolean(before);
      setPage((old) => ({ ...next, items: before ? [...old.items, ...next.items.filter((item) => !old.items.some((entry) => entry.id === item.id))] : next.items }));
      setError(null);
    } catch (caught) {
      if (current(userId, accessToken) && generation === requests.current) setError(caught instanceof Error ? caught.message : "Unable to load notifications.");
    }
  }, [accessToken, current, setPage, userId, view]);

  useEffect(() => {
    setPage(EMPTY_PAGE); setPreferences(null); setOpen(false); setSettings(false); setError(null); setPending(false);
    requests.current += 1;
    const ids = toastIds.current;
    return () => { requests.current += 1; for (const id of ids) hideStatus(id); ids.clear(); };
  }, [userId, hideStatus, setPage, setPreferences]);

  useEffect(() => {
    if (!userId || !accessToken) return;
    let active = true;
    void controllerClient.notifications.getPreferences(accessToken).then((result) => {
      if (active && current(userId, accessToken)) setPreferences(result);
    }).catch(() => { if (active && current(userId, accessToken)) setError("Unable to load notification preferences."); });
    return () => { active = false; };
  }, [userId, accessToken, current, setPreferences]);

  useEffect(() => {
    if (!userId || !accessToken) return;
    let stopped = false;
    const poll = async () => {
      if (stopped) return;
      if (!(openRef.current && paginatedRef.current)) await refresh();
      if (!current(userId, accessToken) || stopped) return;
      // Poll independently of the selected filter; pagination never drives presentation.
      let unread: NotificationPage;
      try { unread = await controllerClient.notifications.list({ view: "unread", accessToken }); } catch { return; }
      if (!current(userId, accessToken) || stopped) return;
      setPage((old) => ({ ...old, unreadCount: unread.unreadCount }));
      for (const item of [...unread.items].reverse()) {
        if (item.seenAt || item.archivedAt || item.readAt) continue;
        const prefs = preferencesRef.current;
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
        if (!current(userId, accessToken) || stopped || !(await claimNotificationPresentation(userId, item.id))) continue;
        if (!current(userId, accessToken) || stopped) return;
        let presented = false;
        if (foreground) {
          const id = `notification:${userId}:${item.id}`;
          toastIds.current.add(id);
          showStatus(item.body, "info", 10_000, { id, nonPreemptive: true, actionLabel: "View", onShow: () => {
            if (current(userId, accessToken) && isAppInForeground()) {
              void controllerClient.notifications.updateState({ id: item.id, action: "seen", accessToken }).catch(() => {});
            }
          }, onClose: () => toastIds.current.delete(id), onAction: () => {
            if (!current(userId, accessToken)) return;
            void controllerClient.notifications.updateState({ id: item.id, action: "read", accessToken }).then(() => refresh()).catch(() => {});
            navigate(item.url);
          } });
        } else {
          presented = await notifyAssistantMessage({ title: "Instafy", body: prefs.hidePreviews ? "You have a new notification." : item.body, url: item.url, eventId: item.id, accountId: userId });
        }
        // A queued toast is not proof of visibility; its local claim suppresses
        // duplicates without advancing server seen/read state.
        if (!foreground && presented) void controllerClient.notifications.updateState({ id: item.id, action: "seen", accessToken }).catch(() => {});
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 20_000);
    const receive = () => void poll();
    window.addEventListener("focus", receive);
    window.addEventListener(NOTIFICATION_RECEIVED_EVENT, receive);
    return () => { stopped = true; window.clearInterval(timer); window.removeEventListener("focus", receive); window.removeEventListener(NOTIFICATION_RECEIVED_EVENT, receive); };
  }, [accessToken, current, navigate, refresh, setPage, showStatus, userId]);

  const mutate = async (operation: () => Promise<unknown>) => {
    if (!userId || !accessToken || pending) return;
    setPending(true); setError(null); requests.current += 1;
    try { await operation(); if (current(userId, accessToken)) await refresh(); }
    catch (caught) { if (current(userId, accessToken)) setError(caught instanceof Error ? caught.message : "Unable to save notification changes."); }
    finally { if (current(userId, accessToken)) setPending(false); }
  };
  const changePreferences = (patch: Partial<NotificationPreferences>) => mutate(async () => {
    const result = await controllerClient.notifications.savePreferences({ ...patch, accessToken: accessToken ?? undefined });
    if (userId && accessToken && current(userId, accessToken)) setPreferences(result);
  });
  const changeChannel = (preference: NotificationPreference) => changePreferences({ preferences: [preference] });
  const read = (item: ProductNotification) => mutate(() => controllerClient.notifications.updateState({ id: item.id, action: "read", accessToken: accessToken ?? undefined }));
  const openItem = (item: ProductNotification) => { void read(item); setOpen(false); navigate(item.url); };
  const bell = userId ? <IconButton variant="ghost" radius="full" className="relative h-10 w-10 shrink-0" aria-label={page.unreadCount ? `Notifications, ${page.unreadCount} unread` : "Notifications"} data-testid="notification-center-bell" onPress={() => { setOpen(true); void refresh(); }}>
    <Bell className="h-5 w-5" aria-hidden="true" />
    {page.unreadCount > 0 ? <span className="absolute right-0 top-0 rounded-full bg-primary-600 px-1 text-[10px] font-semibold text-white" data-testid="notification-center-unread">{page.unreadCount > 99 ? "99+" : page.unreadCount}</span> : null}
  </IconButton> : null;
  const dialog = <StudioDialogModal isOpen={open && Boolean(userId)} onOpenChange={setOpen} isDismissable dialogAriaLabel="Notifications" modalClassName="max-w-xl overflow-hidden" data-testid="notification-center">
    <StudioDialogHeader title="Notifications" onClose={() => setOpen(false)} trailing={<Button variant="ghost" onPress={() => setSettings((value) => !value)}>{settings ? "Inbox" : "Preferences"}</Button>} />
    <div className="max-h-[70dvh] overflow-y-auto p-4 text-sm text-slate-700 dark:text-slate-200">
      {error ? <p role="alert" className="mb-3 text-rose-600">{error}</p> : null}
      {settings ? preferences ? <div className="space-y-5">
        <label className="flex items-center gap-2"><input type="checkbox" checked={preferences.hidePreviews} disabled={pending} onChange={(event) => void changePreferences({ hidePreviews: event.target.checked })} />Hide lock-screen previews</label>
        <p className="text-xs text-slate-500">Your notification center remains available when external alerts are off.</p>
        <div className="overflow-x-auto"><table className="w-full text-left"><thead><tr><th scope="col">Category</th>{NOTIFICATION_CHANNELS.map((channel) => <th className="p-2 text-xs" scope="col" key={channel}>{CHANNEL_LABELS[channel]}</th>)}</tr></thead><tbody>{NOTIFICATION_CATEGORIES.map((category) => <tr key={category}><th scope="row" className="py-3 font-medium">{CATEGORY_LABELS[category]}</th>{NOTIFICATION_CHANNELS.map((channel) => <td className="p-2" key={channel}><input type="checkbox" aria-label={`${CATEGORY_LABELS[category]} ${CHANNEL_LABELS[channel]}`} disabled={pending} checked={preferences.preferences.find((pref) => pref.category === category && pref.channel === channel)?.enabled ?? true} onChange={(event) => void changeChannel({ category, channel, enabled: event.target.checked })} /></td>)}</tr>)}</tbody></table></div>
        <Button isDisabled={pending} onPress={() => void mutate(async () => { if (!(await enableMessageNotifications())) throw new Error("Notifications are unavailable or permission was not granted on this device."); })}>Enable alerts on this device</Button>
      </div> : <p>Loading preferences…</p> : <>
        <div className="mb-3 flex items-center gap-2"><Button variant={view === "all" ? "primary" : "ghost"} onPress={() => setView("all")}>All</Button><Button variant={view === "unread" ? "primary" : "ghost"} onPress={() => setView("unread")}>Unread</Button><Button className="ml-auto" variant="ghost" isDisabled={pending || !page.unreadCount || !page.asOf} onPress={() => void mutate(() => controllerClient.notifications.readAll({ before: page.asOf, accessToken: accessToken ?? undefined }))}>Mark all read</Button></div>
        {page.items.length === 0 ? <p className="py-8 text-center text-slate-500">{view === "unread" ? "You're all caught up." : "No notifications yet."}</p> : <ul className="space-y-2">{page.items.map((item) => <li key={item.id} className={`rounded-xl border border-slate-200 p-3 dark:border-slate-700 ${item.readAt ? "" : "bg-primary-50 dark:bg-primary-950/20"}`} data-testid={`notification-${item.id}`}>
          <button type="button" className="w-full text-left" onClick={() => openItem(item)}><span className="block font-medium">{item.body}</span><time className="mt-1 block text-xs text-slate-500" dateTime={item.occurredAt}>{new Date(item.occurredAt).toLocaleString()}</time></button>
          <div className="mt-2 flex gap-2">{!item.readAt ? <Button variant="ghost" size="xs" isDisabled={pending} onPress={() => void read(item)}>Mark read</Button> : null}<Button variant="ghost" size="xs" isDisabled={pending} onPress={() => void mutate(() => controllerClient.notifications.updateState({ id: item.id, action: "archive", accessToken: accessToken ?? undefined }))}>Archive</Button></div>
        </li>)}</ul>}
        {page.nextCursor ? <Button className="mt-4" isDisabled={pending} onPress={() => void refresh(page.nextCursor ?? undefined)}>Load more</Button> : null}
      </>}
    </div>
  </StudioDialogModal>;
  return { bell, dialog };
}
