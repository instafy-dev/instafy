import { Capacitor } from "@capacitor/core";

export function getAppAcquisitionTarget(): "desktop" | "mobile" | null {
  if (
    typeof window === "undefined" ||
    Capacitor.isNativePlatform() ||
    typeof window.instafyDesktop === "object"
  ) {
    return null;
  }

  try {
    const navigatorWithHints = window.navigator as Navigator & {
      userAgentData?: { mobile?: boolean; platform?: string };
    };
    const isMobile =
      navigatorWithHints.userAgentData?.mobile === true ||
      /Android|iOS|iPhone|iPad|iPod/i.test(navigatorWithHints.userAgentData?.platform ?? "") ||
      /Android|iPhone|iPad|iPod/i.test(navigatorWithHints.userAgent) ||
      // iPadOS can identify itself as macOS, including in desktop browsing mode.
      (navigatorWithHints.platform === "MacIntel" && navigatorWithHints.maxTouchPoints > 1);
    return isMobile ? "mobile" : "desktop";
  } catch {
    return null;
  }
}

export function canOfferDesktopAcquisition(): boolean {
  return getAppAcquisitionTarget() === "desktop";
}
