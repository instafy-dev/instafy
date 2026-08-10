// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@capacitor/core", () => ({ Capacitor: { isNativePlatform: () => false, getPlatform: () => "web" } }));

const { resolveSupabaseRedirectTo, NATIVE_AUTH_CALLBACK_URL } = await import("../nativeAuth");

afterEach(() => {
  delete (window as { instafyDesktop?: unknown }).instafyDesktop;
});

describe("resolveSupabaseRedirectTo", () => {
  it("returns the deep link inside the desktop shell", () => {
    // The bug: the shell loads prod.instafy.dev, which is NOT in Supabase's
    // redirect allow-list, so a web-style redirectTo was rejected and the
    // provider fell back to site_url -- landing the user on the marketing
    // site with their session in the browser instead of the app.
    (window as { instafyDesktop?: unknown }).instafyDesktop = {
      onAuthCallback: () => () => {},
      consumePendingAuthCallback: async () => null,
    };
    expect(resolveSupabaseRedirectTo("/login")).toBe(NATIVE_AUTH_CALLBACK_URL);
  });

  it("keeps the web redirect for a shell too old to receive the callback", () => {
    // The frontend is hosted and updates independently of the app. Sending an
    // old shell to the provider with nowhere to put the result would turn a
    // sign-in that finished in the wrong place into one that finishes nowhere.
    (window as { instafyDesktop?: unknown }).instafyDesktop = {};
    expect(resolveSupabaseRedirectTo("/login")).toBe(`${window.location.origin}/login`);
  });

  it("still returns a same-origin URL on the web", () => {
    expect(resolveSupabaseRedirectTo("/login")).toBe(`${window.location.origin}/login`);
  });
});
