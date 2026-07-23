import { describe, expect, it } from "vitest";
import { nativeRuntimeConfigDisablesOta } from "../nativeRuntimeConfig";

describe("nativeRuntimeConfigDisablesOta", () => {
  it("disables OTA only for an explicitly debuggable Android runtime", () => {
    expect(nativeRuntimeConfigDisablesOta({ platform: "android", disableNativeOta: true })).toBe(true);
    expect(nativeRuntimeConfigDisablesOta({ platform: "android", disableNativeOta: false })).toBe(false);
    expect(nativeRuntimeConfigDisablesOta({ platform: "android" })).toBe(false);
    expect(nativeRuntimeConfigDisablesOta({ platform: "ios", disableNativeOta: true })).toBe(false);
    expect(nativeRuntimeConfigDisablesOta({ platform: "web", disableNativeOta: true })).toBe(false);
  });
});
