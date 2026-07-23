import { Capacitor } from "@capacitor/core";
import type { OtaPlatform } from "@instafy/ota-contracts";
import { controllerBaseUrl, runtimeControllerEnabled } from "../../sdk/instafy";

export function hasWindow(): boolean {
  return typeof window !== "undefined";
}

export function resolveNativeOtaPlatform(): OtaPlatform | null {
  const platform = Capacitor.getPlatform();
  if (platform === "ios" || platform === "android") {
    return platform;
  }
  return null;
}

export function resolveNativeOtaChannel(): string {
  const envValue =
    typeof import.meta.env.VITE_OTA_CHANNEL === "string"
      ? import.meta.env.VITE_OTA_CHANNEL.trim().toLowerCase()
      : "";
  return envValue || "stable";
}

export function otaIsSupportedOnThisClient(): boolean {
  if (!hasWindow() || !runtimeControllerEnabled || !controllerBaseUrl) {
    return false;
  }
  if (!Capacitor.isNativePlatform()) {
    return false;
  }
  return resolveNativeOtaPlatform() !== null;
}
