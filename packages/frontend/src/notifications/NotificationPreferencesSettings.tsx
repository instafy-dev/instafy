import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Button } from "../components/Button";
import { SettingsFormLayout } from "../components/SettingsFormLayout";
import { Toggle } from "../components/Toggle";
import { ControlChevron } from "../components/ControlChevron";
import { Text } from "../components/Text";
import { controllerClient } from "../sdk/instafy";
import { disableMessageNotifications, enableMessageNotifications } from "./assistantMessageNotifications";
import { NOTIFICATION_CATEGORIES, NOTIFICATION_CHANNELS, type NotificationPreferences, type NotificationChannel } from "./notificationContract";
import { getNotificationDeviceContext, readNotificationDeviceState, type NotificationDeviceKind, type NotificationDeviceState } from "./notificationDeviceSettings";
import { NOTIFICATION_PREFERENCES_CHANGED_EVENT, type NotificationPreferencesChangedDetail } from "./notificationPreferencesEvents";

const CATEGORY_LABELS = { support: "Support", conversations: "Conversations", runs: "Runs", automations: "Automations" };
const CHANNEL_LABELS = { web_push: "Browser push", apns: "iPhone push", local: "In-app and desktop alerts" };

function devicePermissionDescription(kind: NotificationDeviceKind, state: NotificationDeviceState | null): string | undefined {
  if (!state) return "Checking notification permission…";
  if (kind === "android") return "Push alerts aren't available in the Android app yet. In-app alerts and Home activity remain available.";
  if (state.permission === "unsupported") return "This browser does not support device alerts. Activity remains available in Home.";
  if (state.permission === "unknown") return "Notification permission could not be checked. Try checking again.";
  if (state.permission === "denied") return kind === "ios"
    ? "Notifications are blocked in iPhone Settings. Allow them there, then check again."
    : "Notifications are blocked in browser settings. Allow them there, then check again.";
  if (state.permission === "system") return "Your system notification settings also apply.";
  if (state.permission === "prompt") return "Turning this on asks for notification permission.";
  return undefined;
}

interface PreferencesSnapshot {
  generation: number;
  value: NotificationPreferences | null;
  loading: boolean;
  pending: boolean;
  error: string | null;
  status: string | null;
}

export function NotificationPreferencesSettings({ userId, accessToken }: {
  userId: string | null;
  accessToken: string | null;
}) {
  const deviceDescriptionId = useId();
  const [deviceCleanupAccount, setDeviceCleanupAccount] = useState<string | null>(null);
  const identity = useRef({ userId, accessToken, generation: 0 });
  if (identity.current.userId !== userId || identity.current.accessToken !== accessToken) {
    identity.current = { userId, accessToken, generation: identity.current.generation + 1 };
  }
  const generation = identity.current.generation;
  const { kind: deviceKind, channel: primaryChannel } = getNotificationDeviceContext();
  const [deviceSnapshot, setDeviceSnapshot] = useState<{ generation: number; value: NotificationDeviceState } | null>(null);
  const deviceRequests = useRef(0);
  const deviceState = deviceSnapshot?.generation === generation ? deviceSnapshot.value : null;
  const mounted = useRef(false);
  const requests = useRef(0);
  const pendingGeneration = useRef<number | null>(null);
  const [snapshot, setSnapshot] = useState<PreferencesSnapshot | null>(null);
  // Hide prior-account and prior-token data during render, before effects run.
  const state = snapshot?.generation === generation ? snapshot : null;
  const preferences = state?.value;
  const current = useCallback(() => mounted.current && identity.current.generation === generation, [generation]);

  const refreshDevicePermission = useCallback(async () => {
    if (!userId || !accessToken || !current()) return;
    const request = ++deviceRequests.current;
    // AuthProvider's session effect runs after descendant Settings effects.
    const value = await readNotificationDeviceState(deviceKind, userId);
    if (current() && request === deviceRequests.current) setDeviceSnapshot({ generation, value });
  }, [accessToken, current, deviceKind, generation, userId]);

  const load = useCallback(async () => {
    if (!userId || !accessToken || !current()) return;
    const request = ++requests.current;
    setSnapshot({ generation, value: null, loading: true, pending: false, error: null, status: null });
    try {
      const value = await controllerClient.notifications.getPreferences(accessToken);
      if (current() && request === requests.current) {
        setSnapshot((previous) => previous?.generation === generation ? { ...previous, value, loading: false } : previous);
      }
    } catch (caught) {
      if (!current() || request !== requests.current) return;
      const message = caught instanceof Error ? caught.message : "Unable to load notification preferences.";
      setSnapshot((previous) => previous?.generation === generation ? {
        ...previous, loading: false,
        error: message === "Unable to load notification preferences (404)" ? "Notification preferences are unavailable on this server." : message,
      } : previous);
    }
  }, [accessToken, current, generation, userId]);

  useEffect(() => {
    mounted.current = true;
    pendingGeneration.current = null;
    void load();
    return () => { mounted.current = false; requests.current += 1; };
  }, [load]);

  useEffect(() => {
    void refreshDevicePermission();
    const refresh = () => { if (document.visibilityState === "visible") void refreshDevicePermission(); };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      deviceRequests.current += 1;
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [refreshDevicePermission]);

  useEffect(() => {
    const refresh = (event: Event) => {
      const detail = (event as CustomEvent<NotificationPreferencesChangedDetail>).detail;
      // Our own save already returns authoritative preferences. Another view
      // or an old session finishing a save must be read with this session.
      if (detail?.userId === userId && pendingGeneration.current !== generation) void load();
    };
    window.addEventListener(NOTIFICATION_PREFERENCES_CHANGED_EVENT, refresh);
    return () => window.removeEventListener(NOTIFICATION_PREFERENCES_CHANGED_EVENT, refresh);
  }, [generation, load, userId]);

  const change = async (patch: Partial<NotificationPreferences> | "enable-device" | "disable-device") => {
    if (!userId || !accessToken || !current() || !state?.value || pendingGeneration.current === generation) return;
    pendingGeneration.current = generation;
    requests.current += 1;
    setSnapshot((previous) => previous?.generation === generation ? { ...previous, pending: true, error: null, status: typeof patch === "string" ? "Updating device alerts…" : null } : previous);
    try {
      if (typeof patch === "string") {
        let updated = false;
        try {
          updated = await (patch === "enable-device" ? enableMessageNotifications() : disableMessageNotifications());
        } finally {
          // Disabling clears the local preference even if push cleanup fails.
          // Always reread it; never imply that a failed cleanup re-enabled alerts.
          if (current()) await refreshDevicePermission();
        }
        if (!current()) return;
        if (!updated) throw new Error(patch === "enable-device"
          ? "Notifications could not be enabled. Check permission and your connection, then try again."
          : "Alerts are off in this app, but push delivery could not be disconnected. Retry to finish turning them off.");
        setDeviceCleanupAccount(null);
        setSnapshot((previous) => previous?.generation === generation ? {
          ...previous, status: patch === "enable-device" ? "Notifications are on for this device." : "Notifications are off for this device.",
        } : previous);
      } else {
        const value = await controllerClient.notifications.savePreferences({ ...patch, accessToken });
        // A completed save still matters after leaving Settings. The presenter
        // matches the account and reloads using its current session; no values
        // from an old request are copied into another view or account.
        window.dispatchEvent(new CustomEvent<NotificationPreferencesChangedDetail>(NOTIFICATION_PREFERENCES_CHANGED_EVENT, { detail: { userId } }));
        if (!current()) return;
        setSnapshot((previous) => previous?.generation === generation ? { ...previous, value, status: "Notification preferences saved." } : previous);
      }
    } catch (caught) {
      if (current()) {
        if (patch === "disable-device") setDeviceCleanupAccount(userId);
        setSnapshot((previous) => previous?.generation === generation ? {
          ...previous, status: null,
          error: patch === "disable-device" ? null
            : caught instanceof Error ? caught.message : "Unable to save notification preferences.",
        } : previous);
      }
    } finally {
      if (current()) {
        pendingGeneration.current = null;
        setSnapshot((previous) => previous?.generation === generation ? { ...previous, pending: false } : previous);
      }
    }
  };

  if (!userId || !accessToken) return <Text tone="muted">Sign in to manage notification preferences.</Text>;

  const canChangeDevice = deviceState && ["prompt", "granted", "system"].includes(deviceState.permission);
  const deviceEnabled = Boolean(deviceState?.enabledForAccount &&
    (deviceState.permission === "granted" || deviceState.permission === "system"));
  const deviceDescription = devicePermissionDescription(deviceKind, deviceState);
  const canRecheckDevice = deviceState?.permission === "denied" || deviceState?.permission === "unknown";
  const channelControls = (channel: NotificationChannel) => (
    <fieldset className="min-w-0" disabled={state?.pending} data-testid={`notification-channel-${channel}`}>
      <legend className="text-sm font-semibold text-slate-700 dark:text-slate-200">{CHANNEL_LABELS[channel]}</legend>
      <div className="mt-2 divide-y divide-slate-200/70 dark:divide-[color:var(--color-studio-dark-divider)]">
        {NOTIFICATION_CATEGORIES.map((category) => (
          <Toggle key={category} layout="row"
            label={CATEGORY_LABELS[category]}
            aria-label={`${CATEGORY_LABELS[category]} ${CHANNEL_LABELS[channel]}`}
            className="min-h-11 py-2.5"
            isSelected={preferences?.preferences.find((preference) => preference.category === category && preference.channel === channel)?.enabled ?? true}
            isDisabled={state?.pending}
            onChange={(enabled) => void change({ preferences: [{ category, channel, enabled }] })}
          />
        ))}
      </div>
    </fieldset>
  );

  return (
    <section className="min-w-0 space-y-4" aria-label="Notification preferences" data-testid="notification-preferences-settings">
      <SettingsFormLayout>
        <Text variant="caption" tone="muted">Choose which alerts reach you. Activity stays available in Home when alerts are off.</Text>
        {state?.error ? (
          <div className="flex flex-wrap items-start gap-2">
            <p role="alert" className="min-w-0 flex-1 text-sm text-rose-600 dark:text-rose-400">{state.error}</p>
            {!state.value ? <Button variant="ghost" size="sm" onPress={() => void load()}>Retry</Button> : null}
          </div>
        ) : null}
        {deviceCleanupAccount === userId ? <div className="flex flex-wrap items-start gap-2">
          <p role="alert" className="min-w-0 flex-1 text-sm text-rose-600 dark:text-rose-400">Alerts are off in this app, but push delivery could not be disconnected. Retry to finish turning them off.</p>
          <Button variant="ghost" size="sm" isDisabled={state?.pending || !preferences} onPress={() => void change("disable-device")}>Retry turning off</Button>
        </div> : null}
        {!state || state.loading ? <Text role="status" tone="muted">Loading notification preferences…</Text> : preferences ? (
          <>
            <div data-testid="notification-device-permission" className="space-y-2">
              <Toggle layout="row"
                label="Notifications on this device"
                aria-label="Notifications on this device"
                aria-describedby={deviceDescription ? deviceDescriptionId : undefined}
                description={deviceDescription ? <span id={deviceDescriptionId}>{deviceDescription}</span> : undefined}
                className="min-h-11 py-2.5"
                isSelected={deviceEnabled}
                isDisabled={state.pending || !canChangeDevice}
                onChange={(enabled) => void change(enabled ? "enable-device" : "disable-device")}
              />
              {canRecheckDevice ? <Button variant="outline" radius="xl" isDisabled={state.pending} onPress={() => void refreshDevicePermission()}>
                Check permission
              </Button> : null}
            </div>
            <div>
              {channelControls(primaryChannel)}
              <Text as="p" variant="caption" tone="muted" className="mt-2">These preferences apply to this delivery channel across your account.</Text>
            </div>
            <Toggle layout="row"
              label="Hide lock-screen previews"
              aria-label="Hide lock-screen previews"
              description="Show a generic alert. Turning this off shows the type of activity, never message or report contents."
              className="min-h-11 py-1"
              isSelected={preferences.hidePreviews}
              isDisabled={state.pending}
              onChange={(hidePreviews) => void change({ hidePreviews })}
            />
            <details className="group/channels border-t border-slate-200/70 pt-2 dark:border-[color:var(--color-studio-dark-divider)]" data-testid="notification-other-channels">
              <summary className="flex min-h-11 cursor-pointer items-center gap-3 rounded-lg text-sm font-medium text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/40 dark:text-slate-200">
                Other delivery channels
                <span className="ml-auto transition-transform group-open/channels:rotate-180 motion-reduce:transition-none"><ControlChevron /></span>
              </summary>
              <div className="space-y-5 pt-3">
                <Text as="p" variant="caption" tone="muted">Manage the other alert channels for your account. Each channel is saved separately.</Text>
                {NOTIFICATION_CHANNELS.filter((channel) => channel !== primaryChannel).map((channel) => <div key={channel}>{channelControls(channel)}</div>)}
              </div>
            </details>
            <p role="status" aria-label="Notification saving status" className="min-h-5 text-xs text-slate-500 dark:text-slate-400">{state.pending ? state.status ?? "Saving changes…" : state.status ?? "Changes save automatically."}</p>
          </>
        ) : null}
      </SettingsFormLayout>
    </section>
  );
}
