import { describe, expect, it } from "vitest";

import { isDesktopShell, showBackToLanding } from "./desktopShell";

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
