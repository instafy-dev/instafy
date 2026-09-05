/** Build-time literal consumed by the native OTA resolver and inspectable in shipped JavaScript. */
export function buildNativeOtaChannelMarker(configuredChannel: string | undefined): string {
  return `instafy-native-ota-channel:${configuredChannel?.trim().toLowerCase() || "stable"}`;
}
