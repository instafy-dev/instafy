import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.doUnmock("@capacitor/core");
  vi.resetModules();
});

describe("resolvePublicAppUrl", () => {
  it("uses the current web origin in the browser", async () => {
    vi.stubGlobal("window", {
      location: new URL("https://preview.instafy.dev/studio"),
    });

    const module = await import("../publicAppUrl");
    expect(module.resolvePublicAppUrl("/invite?token=abc")).toBe("https://preview.instafy.dev/invite?token=abc");
  });

  it("uses the hosted app origin on native", async () => {
    vi.doMock("@capacitor/core", () => ({
      Capacitor: {
        isNativePlatform: () => true,
      },
    }));

    const module = await import("../publicAppUrl");
    expect(module.resolvePublicAppUrl("/invite?token=abc")).toBe("https://instafy.dev/invite?token=abc");
  });
});
