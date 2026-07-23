import { describe, expect, it } from "vitest";

import { resolveBrowserChromeOffset } from "../BrowserCursorOverlay";

describe("resolveBrowserChromeOffset", () => {
  it("uses the reported difference for a browser with remote chrome", () => {
    expect(
      resolveBrowserChromeOffset({
        framebufferHeight: 720,
        viewportHeight: 640,
      }),
    ).toBe(80);
  });

  it("uses zero offset for a viewport-only browser", () => {
    expect(
      resolveBrowserChromeOffset({
        framebufferHeight: 720,
        viewportHeight: 720,
      }),
    ).toBe(0);
  });

  it("compares physical framebuffer pixels with scaled viewport pixels", () => {
    expect(
      resolveBrowserChromeOffset({
        framebufferHeight: 1440,
        viewportHeight: 720,
        renderScale: 2,
      }),
    ).toBe(0);
  });

  it("scales the fallback when no viewport height was reported", () => {
    expect(
      resolveBrowserChromeOffset({
        framebufferHeight: 720,
        viewportHeight: null,
        renderScale: 2,
      }),
    ).toBe(160);
  });
});
