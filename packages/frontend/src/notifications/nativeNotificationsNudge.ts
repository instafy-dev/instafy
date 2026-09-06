import { notificationStorageKey } from "./notificationSession";
import { Capacitor } from "@capacitor/core";

const NATIVE_ASSISTANT_RESPONSE_COUNT_KEY = "instafy.notifications.native_assistant_response_count";
const NATIVE_NUDGE_SEEN_KEY = "instafy.notifications.native_nudge_seen";
const ENABLED_KEY = "instafy.notifications.enabled";

function canUseLocalStorage(): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  try {
    const key = "__instafy_notifications_probe__";
    window.localStorage.setItem(key, "1");
    window.localStorage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

/**
 * Records a newly observed, genuine assistant response and returns whether the
 * native notification nudge should be shown. Callers must not invoke this for
 * user messages, timeline/status rows, or hydrated conversation history.
 */
export function recordGenuineAssistantResponseAndMaybeOfferNativeNotifications(): boolean {
  if (!Capacitor.isNativePlatform() || Capacitor.getPlatform() === "android") {
    return false;
  }
  if (!canUseLocalStorage()) {
    return false;
  }

  const storedPreference = window.localStorage.getItem(notificationStorageKey(ENABLED_KEY));
  if (storedPreference === "1" || storedPreference === "0") {
    return false;
  }
  if (window.localStorage.getItem(notificationStorageKey(NATIVE_NUDGE_SEEN_KEY)) === "1") {
    return false;
  }

  const currentRaw = window.localStorage.getItem(notificationStorageKey(NATIVE_ASSISTANT_RESPONSE_COUNT_KEY)) ?? "0";
  const current = Number.parseInt(currentRaw, 10);
  const next = Number.isFinite(current) ? current + 1 : 1;
  window.localStorage.setItem(notificationStorageKey(NATIVE_ASSISTANT_RESPONSE_COUNT_KEY), String(Math.min(next, 50)));

  if (next < 3) {
    return false;
  }

  window.localStorage.setItem(notificationStorageKey(NATIVE_NUDGE_SEEN_KEY), "1");
  return true;
}
