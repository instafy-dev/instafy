import { describe, expect, it } from "vitest";
import { buildNativeOtaChannelMarker } from "../../nativeOtaChannel";
import { resolveNativeOtaChannel } from "../../src/mobile/ota/shared";

describe("native OTA compiled channel", () => {
  it.each([undefined, "", "  "])("preserves the stable default for %s", (value) => {
    expect(buildNativeOtaChannelMarker(value)).toBe("instafy-native-ota-channel:stable");
  });
  it.each(["internal", " INTERNAL ", "beta", "stable"])("embeds the actual normalized channel %s", (value) => {
    expect(buildNativeOtaChannelMarker(value)).toBe(`instafy-native-ota-channel:${value.trim().toLowerCase()}`);
  });
  it("derives the runtime channel from the literal injected by the Vite configuration", () => {
    expect(__INSTAFY_NATIVE_OTA_CHANNEL__).toBe(buildNativeOtaChannelMarker(import.meta.env.VITE_OTA_CHANNEL));
    expect(resolveNativeOtaChannel()).toBe(__INSTAFY_NATIVE_OTA_CHANNEL__.slice("instafy-native-ota-channel:".length));
  });
});
