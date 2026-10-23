import type { NotificationPreferences } from "../../../src/notifications/notificationContract";

// Inert effects only: no authentication, network, clipboard, native permissions or sharing.
const surface = new URLSearchParams(location.search).get("surface");
const pause = () => new Promise<void>((resolve) => setTimeout(resolve, 650));
let preferences: NotificationPreferences = { hidePreviews: true, preferences: [] };
let firstLoad = true;
let enabled = false;
export function reportAction(message: string) {
  window.dispatchEvent(new CustomEvent("settings-review-action", { detail: message }));
}
export const controllerClient = { notifications: {
  async getPreferences() {
    if (surface === "notifications-error" && firstLoad) {
      firstLoad = false;
      throw new Error("Unable to load notification preferences. Check your connection, then try again.");
    }
    return preferences;
  },
  async savePreferences(patch: Partial<NotificationPreferences>) {
    await pause();
    preferences = {
      hidePreviews: patch.hidePreviews ?? preferences.hidePreviews,
      preferences: patch.preferences ? [...preferences.preferences.filter((old) => !patch.preferences!.some((next) => old.category === next.category && old.channel === next.channel)), ...patch.preferences] : preferences.preferences,
    };
    return preferences;
  },
} };
export const getNotificationDeviceContext = () => ({ kind: "browser", channel: "web_push" });
export const readNotificationDeviceState = async () => ({ permission: surface === "notifications-blocked" ? "denied" : enabled ? "granted" : "prompt", enabledForAccount: enabled });
export async function enableMessageNotifications() { await pause(); enabled = true; return true; }
export async function disableMessageNotifications() { await pause(); enabled = false; return true; }
export async function writeClipboardText() { await pause(); reportAction("Invite link copied in this local review."); }
export const canUseNearbyInviteShare = () => true;
export const isNearbyInviteShareDismissalError = () => false;
export async function shareNearbyInvite() { await pause(); reportAction("Share invite selected in this local review."); }
export const useStatus = () => ({ showStatus: reportAction, hideStatus: () => {} });
