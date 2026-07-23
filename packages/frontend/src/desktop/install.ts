import { Capacitor } from "@capacitor/core";

export const INSTAFY_DESKTOP_INSTALL_URL = "https://instafy.dev/install";

const DESKTOP_SETUP_SHARE_PAYLOAD = {
  title: "Set up Instafy Desktop",
  text: "Open this on the computer where you use Codex and sign in to Instafy.",
  url: INSTAFY_DESKTOP_INSTALL_URL,
};

export function canShareDesktopSetupLink(): boolean {
  if (Capacitor.isNativePlatform()) {
    return Capacitor.isPluginAvailable("Share");
  }
  if (typeof navigator === "undefined" || typeof navigator.share !== "function") {
    return false;
  }
  return typeof navigator.canShare !== "function" || navigator.canShare(DESKTOP_SETUP_SHARE_PAYLOAD);
}

export async function shareDesktopSetupLink(): Promise<void> {
  if (Capacitor.isNativePlatform()) {
    const { Share } = await import("@capacitor/share");
    const availability = await Share.canShare();
    if (!availability.value) {
      throw new Error("Sharing is unavailable on this device.");
    }
    await Share.share({
      ...DESKTOP_SETUP_SHARE_PAYLOAD,
      dialogTitle: "Send Desktop setup link",
    });
    return;
  }

  if (typeof navigator === "undefined" || typeof navigator.share !== "function") {
    throw new Error("Sharing is unavailable in this browser.");
  }
  await navigator.share(DESKTOP_SETUP_SHARE_PAYLOAD);
}
