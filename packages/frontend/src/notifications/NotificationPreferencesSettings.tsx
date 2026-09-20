import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "../components/Button";
import { Card } from "../components/Card";
import { Checkbox } from "../components/Checkbox";
import { Text } from "../components/Text";
import { controllerClient } from "../sdk/instafy";
import { enableMessageNotifications } from "./assistantMessageNotifications";
import { NOTIFICATION_CATEGORIES, NOTIFICATION_CHANNELS, type NotificationPreferences } from "./notificationContract";
import { NOTIFICATION_PREFERENCES_CHANGED_EVENT, type NotificationPreferencesChangedDetail } from "./notificationPreferencesEvents";

const CATEGORY_LABELS = { support: "Support", conversations: "Conversations", runs: "Runs", automations: "Automations" };
const CHANNEL_LABELS = { web_push: "Browser push", apns: "iPhone push", local: "In-app and desktop alerts" };

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
  const identity = useRef({ userId, accessToken, generation: 0 });
  if (identity.current.userId !== userId || identity.current.accessToken !== accessToken) {
    identity.current = { userId, accessToken, generation: identity.current.generation + 1 };
  }
  const generation = identity.current.generation;
  const mounted = useRef(false);
  const requests = useRef(0);
  const pendingGeneration = useRef<number | null>(null);
  const [snapshot, setSnapshot] = useState<PreferencesSnapshot | null>(null);
  // Hide prior-account and prior-token data during render, before effects run.
  const state = snapshot?.generation === generation ? snapshot : null;
  const preferences = state?.value;
  const current = useCallback(() => mounted.current && identity.current.generation === generation, [generation]);

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
    const refresh = (event: Event) => {
      const detail = (event as CustomEvent<NotificationPreferencesChangedDetail>).detail;
      // Our own save already returns authoritative preferences. Another view
      // or an old session finishing a save must be read with this session.
      if (detail?.userId === userId && pendingGeneration.current !== generation) void load();
    };
    window.addEventListener(NOTIFICATION_PREFERENCES_CHANGED_EVENT, refresh);
    return () => window.removeEventListener(NOTIFICATION_PREFERENCES_CHANGED_EVENT, refresh);
  }, [generation, load, userId]);

  const change = async (patch: Partial<NotificationPreferences> | "enable-device") => {
    if (!userId || !accessToken || !current() || !state?.value || pendingGeneration.current === generation) return;
    pendingGeneration.current = generation;
    requests.current += 1;
    setSnapshot((previous) => previous?.generation === generation ? { ...previous, pending: true, error: null, status: null } : previous);
    try {
      if (patch === "enable-device") {
        const enabled = await enableMessageNotifications();
        if (!current()) return;
        if (!enabled) throw new Error("Notifications are unavailable or permission was not granted on this device.");
        setSnapshot((previous) => previous?.generation === generation ? { ...previous, status: "Alerts are enabled on this device." } : previous);
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
      if (current()) setSnapshot((previous) => previous?.generation === generation ? {
        ...previous, error: caught instanceof Error ? caught.message : "Unable to save notification preferences.",
      } : previous);
    } finally {
      if (current()) {
        pendingGeneration.current = null;
        setSnapshot((previous) => previous?.generation === generation ? { ...previous, pending: false } : previous);
      }
    }
  };

  if (!userId || !accessToken) return <Text tone="muted">Sign in to manage notification preferences.</Text>;

  return (
    <section className="@container/notification-settings min-w-0 space-y-4" aria-label="Notification preferences" data-testid="notification-preferences-settings">
      <Text variant="caption" tone="muted">Choose which alerts reach you. Activity stays available in Home when alerts are off.</Text>
      {state?.error ? (
        <div className="flex flex-wrap items-start gap-2">
          <p role="alert" className="min-w-0 flex-1 text-sm text-rose-600 dark:text-rose-400">{state.error}</p>
          {!state.value ? <Button variant="ghost" size="sm" onPress={() => void load()}>Retry</Button> : null}
        </div>
      ) : null}
      {!state || state.loading ? <Text role="status" tone="muted">Loading notification preferences…</Text> : preferences ? (
        <>
          <div className="grid min-w-0 grid-cols-1 gap-3 @min-[34rem]/notification-settings:grid-cols-2">
            {NOTIFICATION_CATEGORIES.map((category) => (
              <Card key={category} radius="2xl" shadow="none" padding="sm" className="min-w-0">
                <fieldset className="min-w-0" disabled={state.pending}>
                  <legend className="mb-2 text-sm font-semibold text-slate-700 dark:text-slate-200">{CATEGORY_LABELS[category]}</legend>
                  {NOTIFICATION_CHANNELS.map((channel) => (
                    <Checkbox
                      key={channel}
                      label={CHANNEL_LABELS[channel]}
                      aria-label={`${CATEGORY_LABELS[category]} ${CHANNEL_LABELS[channel]}`}
                      className="min-h-11 py-2.5"
                      isSelected={preferences.preferences.find((preference) => preference.category === category && preference.channel === channel)?.enabled ?? true}
                      isDisabled={state.pending}
                      onChange={(enabled) => void change({ preferences: [{ category, channel, enabled }] })}
                    />
                  ))}
                </fieldset>
              </Card>
            ))}
          </div>
          <Card radius="2xl" shadow="none" padding="sm">
            <Checkbox
              label="Hide lock-screen previews"
              description="Show a generic alert. Turning this off shows the type of activity, never message or report contents."
              className="min-h-11 py-1"
              isSelected={preferences.hidePreviews}
              isDisabled={state.pending}
              onChange={(hidePreviews) => void change({ hidePreviews })}
            />
          </Card>
          <Card radius="2xl" shadow="none" padding="sm" className="space-y-3">
            <div>
              <Text as="h3" variant="bodyStrong" tone="secondary">This device</Text>
              <Text variant="caption" tone="muted" className="mt-1">Push and desktop alerts also need permission on this device.</Text>
            </div>
            <Button variant="outline" className="min-h-11 max-w-full whitespace-normal" isDisabled={state.pending} onPress={() => void change("enable-device")}>
              Enable alerts on this device
            </Button>
          </Card>
          <p role="status" className="min-h-5 text-xs text-slate-500 dark:text-slate-400">{state.pending ? "Updating notifications…" : state.status}</p>
        </>
      ) : null}
    </section>
  );
}
