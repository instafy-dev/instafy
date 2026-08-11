import { describe, expect, it } from "vitest";

import {
  DESKTOP_TITLE_BAR_HEIGHT_PX,
  DESKTOP_TITLE_BAR_TAB_OFFSET_PX,
  desktopTitleBarFree,
  desktopWindowChrome,
  isDesktopShell,
  showBackToLanding,
} from "./desktopShell";

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

describe("desktopTitleBarFree", () => {
  it("is true only when the shell declares it", () => {
    expect(desktopTitleBarFree({ instafyDesktop: { titleBarFree: true } })).toBe(true);
  });

  it("is false on a shell that predates the integrated title bar", () => {
    // The whole point of the flag. The frontend is published to the web and
    // reaches installed apps at once, so it routinely runs inside older
    // shells. Those still paint a full-width drag strip at maximum z-index
    // across the top row: a tab raised into it receives a window drag rather
    // than a click, so every tab in the app stops responding. Absent property
    // must mean "keep the stock layout", never "assume the new one".
    expect(desktopTitleBarFree({ instafyDesktop: {} })).toBe(false);
    expect(desktopTitleBarFree({ instafyDesktop: { titleBarFree: false } })).toBe(false);
    // Truthy-but-not-true must not pass either: only an explicit boolean from
    // a shell that really narrowed its drag region counts.
    expect(desktopTitleBarFree({ instafyDesktop: { titleBarFree: "yes" } })).toBe(false);
    expect(desktopTitleBarFree({ instafyDesktop: { titleBarFree: 1 } })).toBe(false);
  });

  it("is false outside the desktop shell", () => {
    expect(desktopTitleBarFree({})).toBe(false);
    expect(desktopTitleBarFree(undefined)).toBe(false);
  });
});

describe("integrated title bar geometry", () => {
  it("matches the tab strip height so the rail meets the tab underline", () => {
    // Not an arbitrary inset: the rail's top edge and the tab strip's
    // underline have to land on the same row, or the rail sits short of the
    // line and the seam is visible. 48px is the tab strip's own height.
    expect(DESKTOP_TITLE_BAR_HEIGHT_PX).toBe(48);
  });

  it("offsets the first tab clear of the window buttons", () => {
    // Traffic lights are three 12px dots on a 20px pitch from x=13, ending at
    // x=65. The strip starts at the rail's edge (64), so the offset must carry
    // the first tab past 65.
    expect(64 + DESKTOP_TITLE_BAR_TAB_OFFSET_PX).toBeGreaterThan(65);
  });
});
