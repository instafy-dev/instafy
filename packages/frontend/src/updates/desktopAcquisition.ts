import { Capacitor } from "@capacitor/core";

export function canOfferDesktopAcquisition(): boolean {
  return (
    typeof window !== "undefined" &&
    !Capacitor.isNativePlatform() &&
    typeof window.instafyDesktop !== "object"
  );
}
