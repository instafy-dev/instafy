// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";
import {
  browserTransportPreferenceKey,
  parseBrowserTransportPreference,
  readBrowserTransportPreference,
  writeBrowserTransportPreference,
} from "../browserTransportPreference";

describe("browser transport preference", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("accepts only supported transport values", () => {
    expect(parseBrowserTransportPreference("personal")).toBe("personal");
    expect(parseBrowserTransportPreference("shared")).toBe("shared");
    expect(parseBrowserTransportPreference("other")).toBeNull();
    expect(parseBrowserTransportPreference(null)).toBeNull();
  });

  it("persists the explicit choice per signed-in user", () => {
    writeBrowserTransportPreference("user-1", "shared");

    expect(readBrowserTransportPreference("user-1")).toBe("shared");
    expect(readBrowserTransportPreference("user-2")).toBeNull();
    expect(window.localStorage.getItem(browserTransportPreferenceKey("user-1"))).toBe(
      "shared",
    );
  });
});
