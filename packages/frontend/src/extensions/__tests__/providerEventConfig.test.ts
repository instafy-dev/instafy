import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_PROVIDER_EVENT_CONFIG,
  getProviderEventConfig,
  resetProviderEventConfig,
  setProviderEventConfig,
} from "../providerEventConfig";

describe("providerEventConfig", () => {
  afterEach(() => {
    resetProviderEventConfig();
    vi.unstubAllGlobals();
  });

  it("returns the defaults when no override is stored", () => {
    expect(getProviderEventConfig()).toEqual(DEFAULT_PROVIDER_EVENT_CONFIG);
  });

  it("persists normalized overrides to localStorage", () => {
    const store = new Map<string, string>();
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => {
          store.set(key, value);
        },
        removeItem: (key: string) => {
          store.delete(key);
        },
      },
    });

    expect(
      setProviderEventConfig({
        logMaxEntries: 12,
        coalesceWindowMs: 4_500,
        triggerMaxEntries: 5,
      }),
    ).toEqual({
      logMaxEntries: 12,
      coalesceWindowMs: 4_500,
      triggerMaxEntries: 5,
    });
    expect(getProviderEventConfig()).toEqual({
      logMaxEntries: 12,
      coalesceWindowMs: 4_500,
      triggerMaxEntries: 5,
    });
  });

  it("clamps invalid override values to safe bounds", () => {
    expect(
      setProviderEventConfig({
        logMaxEntries: -10,
        coalesceWindowMs: 999_999,
        triggerMaxEntries: 0,
      }),
    ).toEqual({
      logMaxEntries: 1,
      coalesceWindowMs: 60_000,
      triggerMaxEntries: 1,
    });
  });
});
