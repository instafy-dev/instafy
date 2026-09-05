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
  // Derive the actual channel from the archived literal, not separate attestation metadata.
  return __INSTAFY_NATIVE_OTA_CHANNEL__.slice("instafy-native-ota-channel:".length);
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
