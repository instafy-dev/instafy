// @vitest-environment jsdom

import { Capacitor } from "@capacitor/core";
import { afterEach, describe, expect, it, vi } from "vitest";

const getSession = vi.hoisted(() => vi.fn());

vi.mock("../../../../lib/supabaseClient", () => ({
  supabase: { auth: { getSession } },
}));

vi.mock("../../../../sdk/instafy", () => ({
  controllerBaseUrl: "https://controller.instafy.dev",
}));

import {
  canUseDesktopCodexAuthJson,
  connectDesktopCodexAuthJson,
  isLikelyDesktopDevice,
} from "../desktopCodexAuthJson";

describe("desktopCodexAuthJson", () => {
  afterEach(() => {
    window.instafyDesktop = undefined;
    getSession.mockReset();
    delete (window.navigator as Navigator & { userAgentData?: unknown }).userAgentData;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("offers manual auth.json import on pointer-based web desktops", () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn().mockImplementation((query: string) => ({
        matches: query === "(pointer: fine)",
      })),
    );

    expect(isLikelyDesktopDevice()).toBe(true);
  });

  it("never asks a native phone to find auth.json, even with a connected pointer", () => {
    vi.spyOn(Capacitor, "isNativePlatform").mockReturnValue(true);
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: true }));

    expect(isLikelyDesktopDevice()).toBe(false);
  });

  it("never asks an Android web browser to find desktop auth.json", () => {
    vi.spyOn(window.navigator, "userAgent", "get").mockReturnValue(
      "Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 Chrome/126 Mobile Safari/537.36",
    );
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: true }));

    expect(isLikelyDesktopDevice()).toBe(false);
  });

  it("recognizes Android client hints when desktop-site mode masks the user agent", () => {
    Object.defineProperty(window.navigator, "userAgentData", {
      configurable: true,
      value: { mobile: false, platform: "Android" },
    });
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: true }));

    expect(isLikelyDesktopDevice()).toBe(false);
  });

  it("asks native Desktop to connect the default login without returning auth.json", async () => {
    getSession.mockResolvedValue({
      data: {
        session: {
          access_token: "visible-session-token",
          user: { id: "22222222-2222-4222-8222-222222222222" },
        },
      },
    });
    const connectDefaultCodexAuthJson = vi.fn().mockResolvedValue({
      credentialId: "11111111-1111-4111-8111-111111111111",
      kind: "codex_auth_json",
      isDefault: true,
    });
    window.instafyDesktop = {
      notify: vi.fn(),
      codexAuthJsonStatus: vi.fn().mockResolvedValue({ exists: true }),
      connectDefaultCodexAuthJson,
    };

    expect(canUseDesktopCodexAuthJson()).toBe(true);
    await expect(
      connectDesktopCodexAuthJson({
        label: "Codex on this computer",
        makeDefault: true,
      }),
    ).resolves.toEqual({
      success: true,
      credentialId: "11111111-1111-4111-8111-111111111111",
      kind: "codex_auth_json",
      isDefault: true,
    });
    expect(connectDefaultCodexAuthJson).toHaveBeenCalledWith({
      controllerUrl: "https://controller.instafy.dev",
      label: "Codex on this computer",
      makeDefault: true,
    });
    expect(window.instafyDesktop).not.toHaveProperty("readDefaultCodexAuthJson");
    expect(window.instafyDesktop).not.toHaveProperty("pickCodexAuthJson");
  });

  it("returns a stable secret-free error when native onboarding fails", async () => {
    getSession.mockResolvedValue({
      data: {
        session: {
          access_token: "visible-session-token",
          user: { id: "22222222-2222-4222-8222-222222222222" },
        },
      },
    });
    window.instafyDesktop = {
      notify: vi.fn(),
      codexAuthJsonStatus: vi.fn().mockResolvedValue({ exists: true }),
      connectDefaultCodexAuthJson: vi
        .fn()
        .mockRejectedValue(new Error("secret-access-token-marker")),
    };

    const result = await connectDesktopCodexAuthJson();
    expect(result).toEqual({
      success: false,
      error: "Unable to connect ~/.codex/auth.json from this computer.",
    });
    expect(JSON.stringify(result)).not.toContain("secret-access-token-marker");
  });

  it("does not offer Desktop connect when the sealed native method is absent", () => {
    window.instafyDesktop = {
      notify: vi.fn(),
      codexAuthJsonStatus: vi.fn().mockResolvedValue({ exists: true }),
    };
    expect(canUseDesktopCodexAuthJson()).toBe(false);
  });

  it("does not invoke native onboarding without the visible Supabase session", async () => {
    const connectDefaultCodexAuthJson = vi.fn();
    getSession.mockResolvedValue({ data: { session: null } });
    window.instafyDesktop = {
      notify: vi.fn(),
      codexAuthJsonStatus: vi.fn().mockResolvedValue({ exists: true }),
      connectDefaultCodexAuthJson,
    };

    await expect(connectDesktopCodexAuthJson()).resolves.toEqual({
      success: false,
      error: "Sign in to connect your local Codex login.",
    });
    expect(connectDefaultCodexAuthJson).not.toHaveBeenCalled();
  });
});
