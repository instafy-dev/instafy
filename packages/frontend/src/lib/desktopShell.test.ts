import { describe, expect, it } from "vitest";

import { desktopWindowChrome, isDesktopShell, showBackToLanding } from "./desktopShell";

describe("isDesktopShell", () => {
  it("detects the preload bridge the desktop shell injects", () => {
    expect(isDesktopShell({ instafyDesktop: {} })).toBe(true);
    expect(isDesktopShell({})).toBe(false);
    expect(isDesktopShell(undefined)).toBe(false);
  });
});

describe("showBackToLanding", () => {
  const web = { isNativeApp: false, isExtensionEmbed: false };

  it("shows the landing link only for plain web visitors", () => {
    expect(showBackToLanding({ ...web, shellWindow: {} })).toBe(true);
  });

  it("hides the landing link inside the desktop shell", () => {
    // The regression this guards: the login page knew about native apps and
    // extension embeds but not the Electron shell, so the packaged desktop
    // app rendered a live "Back to landing" link that navigated the app
    // window to the marketing site (seen in Instafy Studio 0.2.1).
    expect(showBackToLanding({ ...web, shellWindow: { instafyDesktop: {} } })).toBe(false);
  });

  it("keeps hiding it for native apps and extension embeds", () => {
    expect(
      showBackToLanding({ isNativeApp: true, isExtensionEmbed: false, shellWindow: {} }),
    ).toBe(false);
    expect(
      showBackToLanding({ isNativeApp: false, isExtensionEmbed: true, shellWindow: {} }),
    ).toBe(false);
  });
});

describe("desktopWindowChrome", () => {
  it("returns null outside the shell so browsers never get shell chrome", () => {
    expect(desktopWindowChrome({})).toBe(null);
    expect(desktopWindowChrome(undefined)).toBe(null);
  });

  it("degrades an older app shell to the stock layout", () => {
    // An app built before the integrated title bar exposes the bridge but not
    // windowChrome; the frontend must keep stock spacing or the traffic
    // lights of the still-visible title bar would double up with the inset.
    expect(desktopWindowChrome({ instafyDesktop: {} })).toBe("system");
  });

  it("reports the integrated chrome only on the exact capability value", () => {
    expect(desktopWindowChrome({ instafyDesktop: { windowChrome: "hiddenInset" } })).toBe(
      "hiddenInset",
    );
    expect(desktopWindowChrome({ instafyDesktop: { windowChrome: "weird" } })).toBe("system");
  });
});
