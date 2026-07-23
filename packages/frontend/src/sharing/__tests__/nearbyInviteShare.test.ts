import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.doUnmock("@capacitor/core");
  vi.doUnmock("@capacitor/share");
  vi.resetModules();
});

describe("nearbyInviteShare", () => {
  it("offers nearby sharing when the native Share plugin is available", async () => {
    vi.doMock("@capacitor/core", () => ({
      Capacitor: {
        isNativePlatform: () => true,
        isPluginAvailable: (name: string) => name === "Share",
      },
    }));

    const module = await import("../nearbyInviteShare");
    expect(module.canUseNearbyInviteShare()).toBe(true);
    expect(module.nearbyInviteShareRequiresPreparedUrl()).toBe(false);
  });

  it("shares through the native Share plugin on mobile", async () => {
    const canShare = vi.fn().mockResolvedValue({ value: true });
    const share = vi.fn().mockResolvedValue({ activityType: "mock" });

    vi.doMock("@capacitor/core", () => ({
      Capacitor: {
        isNativePlatform: () => true,
        isPluginAvailable: (name: string) => name === "Share",
      },
    }));
    vi.doMock("@capacitor/share", () => ({
      Share: {
        canShare,
        share,
      },
    }));

    const module = await import("../nearbyInviteShare");
    const payload = module.buildNearbyInviteSharePayload({
      role: "builder",
      url: "https://instafy.dev/invite?token=abc",
    });

    await module.shareNearbyInvite(payload);

    expect(canShare).toHaveBeenCalledTimes(1);
    expect(share).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Edit this Instafy space",
        url: "https://instafy.dev/invite?token=abc",
      }),
    );
  });

  it("shares through the browser share API when available", async () => {
    const share = vi.fn().mockResolvedValue(undefined);
    const canShare = vi.fn().mockReturnValue(true);

    vi.doMock("@capacitor/core", () => ({
      Capacitor: {
        isNativePlatform: () => false,
        isPluginAvailable: () => false,
      },
    }));
    vi.stubGlobal("navigator", {
      share,
      canShare,
    });

    const module = await import("../nearbyInviteShare");
    const payload = module.buildNearbyInviteSharePayload({
      role: "viewer",
      url: "https://instafy.dev/invite?token=xyz",
    });

    expect(module.canUseNearbyInviteShare()).toBe(true);
    expect(module.nearbyInviteShareRequiresPreparedUrl()).toBe(true);
    await module.shareNearbyInvite(payload);

    expect(canShare).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "View this Instafy space",
        url: "https://instafy.dev/invite?token=xyz",
      }),
    );
    expect(share).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "View this Instafy space",
        url: "https://instafy.dev/invite?token=xyz",
      }),
    );
  });

  it("only treats an actual share cancellation as a dismissal", async () => {
    vi.doMock("@capacitor/core", () => ({
      Capacitor: {
        isNativePlatform: () => false,
        isPluginAvailable: () => false,
      },
    }));

    const module = await import("../nearbyInviteShare");
    const aborted = Object.assign(new Error("The operation was aborted"), {
      name: "AbortError",
    });
    const denied = Object.assign(new Error("Share requires user activation"), {
      name: "NotAllowedError",
    });

    expect(module.isNearbyInviteShareDismissalError(aborted)).toBe(true);
    expect(module.isNearbyInviteShareDismissalError(denied)).toBe(false);
  });
});
