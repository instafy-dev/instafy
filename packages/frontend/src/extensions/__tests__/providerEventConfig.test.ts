import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_PROVIDER_EVENT_CONFIG,
  getProviderEventConfig,
  resetProviderEventConfig,
} from "../providerEventConfig";

describe("providerEventConfig", () => {
  afterEach(() => {
    resetProviderEventConfig();
    vi.unstubAllGlobals();
  });

  it("returns the defaults when no override is stored", () => {
    expect(getProviderEventConfig()).toEqual(DEFAULT_PROVIDER_EVENT_CONFIG);
  });

  it("clamps invalid stored override values to safe bounds", async () => {
    vi.stubGlobal("window", {
      localStorage: {
        getItem: () =>
          JSON.stringify({
            logMaxEntries: -10,
            coalesceWindowMs: 999_999,
            triggerMaxEntries: 0,
          }),
        removeItem: () => {},
      },
    });
    // The module reads storage once, so load a fresh copy to read the stubbed value.
    vi.resetModules();
    const fresh = await import("../providerEventConfig");

    expect(fresh.getProviderEventConfig()).toEqual({
      logMaxEntries: 1,
      coalesceWindowMs: 60_000,
      triggerMaxEntries: 1,
    });
  });
});
