// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";
import {
  browserTransportPreferenceKey,
  browserSessionTransportKey,
  readBrowserSessionTransport,
  writeBrowserSessionTransport,
  resolveBrowserTransportSelection,
  parseBrowserTransportPreference,
  readBrowserTransportPreference,
  writeBrowserTransportPreference,
} from "../browserTransportPreference";

describe("browser transport preference", () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
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
  it("keeps conversation choices separate from defaults, other conversations, projects and users", () => {
    writeBrowserTransportPreference("user-1", "shared");
    writeBrowserSessionTransport("user-1", "project-1", "conversation-1", "personal");
    expect(readBrowserSessionTransport("user-1", "project-1", "conversation-1")).toBe("personal");
    expect(readBrowserTransportPreference("user-1")).toBe("shared");
    expect(readBrowserSessionTransport("user-2", "project-1", "conversation-1")).toBeNull();
    expect(readBrowserSessionTransport("user-1", "project-2", "conversation-1")).toBeNull();
    expect(readBrowserSessionTransport("user-1", "project-1", "conversation-2")).toBeNull();
  });

  it("retains the live tab location and restores a saved location in a new tab", () => {
    writeBrowserSessionTransport("u", "p", "c", "personal");
    window.localStorage.setItem(browserSessionTransportKey("u", "p", "c"), "shared");
    expect(readBrowserSessionTransport("u", "p", "c")).toBe("personal");
    window.sessionStorage.clear();
    expect(readBrowserSessionTransport("u", "p", "c")).toBe("shared");
  });

  it.each([
    [null, null, true, "personal"],
    [null, null, false, "shared"],
    [null, "shared", true, "shared"],
    [null, "personal", false, "shared"],
    ["shared", "personal", true, "shared"],
    ["personal", "shared", true, "personal"],
    ["personal", null, false, "personal"],
  ] as const)("resumes %s before preference %s (device available: %s)", (resume, preference, personalAvailable, expected) => {
    expect(resolveBrowserTransportSelection({ resume, preference, personalAvailable })).toBe(expected);
  });

});
