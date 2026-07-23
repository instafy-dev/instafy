import { describe, expect, it } from "vitest";
import { resolveNativeOtaDisabled } from "../bootstrap";

describe("resolveNativeOtaDisabled", () => {
  it("honors the non-persistent physical UI-test override", () => {
    expect(
      resolveNativeOtaDisabled({
        search: "?disableNativeOta=0",
        persistedValue: null,
        uiTestOverride: true,
      }),
    ).toBe(true);
  });

  it("disables native OTA when the deep-link query flag is present", () => {
    expect(
      resolveNativeOtaDisabled({
        search: "?projectId=123&disableNativeOta=1",
        persistedValue: null,
      }),
    ).toBe(true);
  });

  it("allows the deep-link query flag to re-enable native OTA", () => {
    expect(
      resolveNativeOtaDisabled({
        search: "?disableNativeOta=0",
        persistedValue: "1",
      }),
    ).toBe(false);
  });

  it("falls back to persisted storage when no override is present", () => {
    expect(
      resolveNativeOtaDisabled({
        search: "?projectId=123",
        persistedValue: "1",
      }),
    ).toBe(true);
    expect(
      resolveNativeOtaDisabled({
        search: "?projectId=123",
        persistedValue: null,
      }),
    ).toBe(false);
  });
});
