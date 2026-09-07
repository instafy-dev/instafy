// @vitest-environment jsdom

import { Capacitor } from "@capacitor/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canOfferDesktopAcquisition, getAppAcquisitionTarget } from "../desktopAcquisition";

describe("app acquisition target", () => {
  const desktopNavigator = {
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15",
    platform: "MacIntel",
    maxTouchPoints: 0,
  };
  const mockNavigator = (overrides: Partial<typeof desktopNavigator> & { userAgentData?: { mobile?: boolean; platform?: string } } = {}) => {
    vi.spyOn(window, "navigator", "get").mockReturnValue({ ...desktopNavigator, ...overrides } as Navigator);
  };

  beforeEach(() => {
    vi.spyOn(Capacitor, "isNativePlatform").mockReturnValue(false);
    mockNavigator();
  });

  afterEach(() => {
    if (typeof window !== "undefined") delete window.instafyDesktop;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("offers the Desktop journey in a normal web browser", () => {
    expect(getAppAcquisitionTarget()).toBe("desktop");
    expect(canOfferDesktopAcquisition()).toBe(true);
  });

  it("does not offer installation from the installed Desktop app", () => {
    window.instafyDesktop = {} as typeof window.instafyDesktop;

    expect(getAppAcquisitionTarget()).toBeNull();
    expect(canOfferDesktopAcquisition()).toBe(false);
  });

  it("does not offer Desktop installation from a native mobile shell", () => {
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(true);
    mockNavigator({ userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)" });

    expect(getAppAcquisitionTarget()).toBeNull();
    expect(canOfferDesktopAcquisition()).toBe(false);
  });

  it.each([
    ["Android phone", "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Chrome/130 Mobile Safari/537.36"],
    ["Android tablet", "Mozilla/5.0 (Linux; Android 15; Tablet) AppleWebKit/537.36 Chrome/130 Safari/537.36"],
    ["iPhone", "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15"],
    ["iPad", "Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15"],
    ["iPod", "Mozilla/5.0 (iPod touch; CPU iPhone OS 15_0 like Mac OS X) AppleWebKit/605.1.15"],
  ])("offers the mobile journey in an %s browser", (_, userAgent) => {
    mockNavigator({ userAgent });
    expect(getAppAcquisitionTarget()).toBe("mobile");
    expect(canOfferDesktopAcquisition()).toBe(false);
  });

  it.each([
    { mobile: true, platform: "" },
    { mobile: false, platform: "Android" },
    { mobile: false, platform: "iOS" },
  ])("honors mobile OS client hints with reduced user agent strings: %j", (userAgentData) => {
    mockNavigator({ userAgentData });
    expect(getAppAcquisitionTarget()).toBe("mobile");
    expect(canOfferDesktopAcquisition()).toBe(false);
  });

  it("detects iPadOS desktop browsing mode without treating ordinary Macs as mobile", () => {
    mockNavigator({ platform: "MacIntel", maxTouchPoints: 5 });
    expect(getAppAcquisitionTarget()).toBe("mobile");
    mockNavigator({ platform: "MacIntel", maxTouchPoints: 0 });
    expect(getAppAcquisitionTarget()).toBe("desktop");
  });

  it("keeps touch-capable Windows browsers on the desktop journey", () => {
    mockNavigator({ userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)", platform: "Win32", maxTouchPoints: 10 });
    expect(getAppAcquisitionTarget()).toBe("desktop");
    expect(canOfferDesktopAcquisition()).toBe(true);
  });

  it("does not offer installation outside a browser", () => {
    vi.stubGlobal("window", undefined);
    expect(getAppAcquisitionTarget()).toBeNull();
    expect(canOfferDesktopAcquisition()).toBe(false);
  });
});
