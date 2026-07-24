// @vitest-environment jsdom

import { Capacitor } from "@capacitor/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canOfferDesktopAcquisition } from "../desktopAcquisition";

describe("canOfferDesktopAcquisition", () => {
  afterEach(() => {
    delete window.instafyDesktop;
    vi.restoreAllMocks();
  });

  it("offers the Desktop journey in a normal web browser", () => {
    vi.spyOn(Capacitor, "isNativePlatform").mockReturnValue(false);

    expect(canOfferDesktopAcquisition()).toBe(true);
  });

  it("does not offer installation from the installed Desktop app", () => {
    vi.spyOn(Capacitor, "isNativePlatform").mockReturnValue(false);
    window.instafyDesktop = {} as typeof window.instafyDesktop;

    expect(canOfferDesktopAcquisition()).toBe(false);
  });

  it("does not offer Desktop installation from a native mobile shell", () => {
    vi.spyOn(Capacitor, "isNativePlatform").mockReturnValue(true);

    expect(canOfferDesktopAcquisition()).toBe(false);
  });
});
