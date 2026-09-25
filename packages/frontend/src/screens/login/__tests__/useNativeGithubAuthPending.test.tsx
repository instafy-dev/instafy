// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NATIVE_AUTH_ERROR_EVENT } from "../../../auth/nativeAuth";

const supabaseMock = vi.hoisted(() => ({
  signInWithOAuth: vi.fn(),
  exchangeCodeForSession: vi.fn(),
}));

const platform = vi.hoisted(() => ({
  native: false,
  desktop: false,
  desktopListener: null as ((url: string) => void) | null,
  openDesktopExternalUrl: vi.fn(async () => undefined),
  browserOpen: vi.fn(async () => undefined),
}));

vi.mock("../../../lib/supabaseClient", () => ({
  hasSupabaseConfig: true,
  supabaseAnonKey: "anon-key",
  supabase: {
    auth: {
      signInWithOAuth: supabaseMock.signInWithOAuth,
      exchangeCodeForSession: supabaseMock.exchangeCodeForSession,
    },
  },
}));
vi.mock("../../../lib/desktopShell", () => ({
  isDesktopShell: () => platform.desktop,
  desktopCanReceiveAuthCallback: () => platform.desktop,
  onDesktopAuthCallback: (listener: (url: string) => void) => {
    platform.desktopListener = listener;
    return () => {};
  },
  consumeDesktopAuthCallback: async () => null,
  openDesktopExternalUrl: platform.openDesktopExternalUrl,
}));
vi.mock("@capacitor/core", () => ({
  Capacitor: {
    isNativePlatform: () => platform.native,
    getPlatform: () => (platform.native ? "ios" : "web"),
  },
}));
vi.mock("@capacitor/browser", () => ({
  Browser: {
    close: async () => undefined,
    addListener: async () => ({ remove: () => undefined }),
    open: platform.browserOpen,
  },
}));
vi.mock("../../../services/runtimeController/authTelemetry", () => ({
  postAuthTelemetryEvent: vi.fn(async () => undefined),
}));

import { useNativeGithubAuth } from "../useNativeGithubAuth";

// The hook reports status through the page's setters. A web redirect keeps its
// provider pending until the page unloads; the native custom tab and the
// desktop shell release the button once the provider is open, and only the
// desktop shell reports a wait the page must describe.
describe("useNativeGithubAuth pending status", () => {
  let container: HTMLDivElement;
  let root: Root;
  let handlers: ReturnType<typeof useNativeGithubAuth> | null;
  const setError = vi.fn();
  const setPendingProvider = vi.fn();
  const setAwaitingBrowser = vi.fn();

  function Harness() {
    handlers = useNativeGithubAuth({
      redirectTarget: "/studio",
      setError,
      setPendingProvider,
      setAwaitingBrowser,
    });
    return null;
  }

  beforeEach(async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    platform.native = false;
    platform.desktop = false;
    platform.desktopListener = null;
    platform.openDesktopExternalUrl.mockClear();
    platform.browserOpen.mockClear();
    supabaseMock.signInWithOAuth.mockReset();
    supabaseMock.signInWithOAuth.mockResolvedValue({ data: { url: "https://auth.example/authorize" }, error: null });
    supabaseMock.exchangeCodeForSession.mockReset();
    setError.mockReset();
    setPendingProvider.mockReset();
    setAwaitingBrowser.mockReset();
    handlers = null;
    window.localStorage.clear();
    window.sessionStorage.clear();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  const mount = async () => {
    await act(async () => root.render(<Harness />));
  };

  it("keeps the provider pending through a web redirect and reports no browser wait", async () => {
    await mount();

    await act(async () => handlers?.handleGithubLogin());

    expect(setPendingProvider.mock.calls).toEqual([["github"]]);
    expect(setAwaitingBrowser.mock.calls).toEqual([[null]]);
  });

  it("releases the button once the native custom tab opens, without a browser wait", async () => {
    platform.native = true;
    await mount();

    await act(async () => handlers?.handleGithubLogin());

    expect(platform.browserOpen).toHaveBeenCalledWith({ url: "https://auth.example/authorize" });
    expect(setPendingProvider.mock.calls).toEqual([["github"], [null]]);
    expect(setAwaitingBrowser.mock.calls).toEqual([[null]]);
  });

  it("clears the pending state when the native bridge reports a failed sign-in", async () => {
    platform.native = true;
    await mount();

    await act(async () => {
      window.dispatchEvent(new CustomEvent(NATIVE_AUTH_ERROR_EVENT, { detail: "Sign-in was cancelled." }));
    });

    expect(setAwaitingBrowser).toHaveBeenLastCalledWith(null);
    expect(setError).toHaveBeenLastCalledWith("Sign-in was cancelled.");
    expect(setPendingProvider).toHaveBeenLastCalledWith(null);
  });

  it("releases the button and reports the browser wait once the desktop shell opens the provider", async () => {
    platform.desktop = true;
    await mount();

    await act(async () => handlers?.handleGoogleLogin());

    expect(platform.openDesktopExternalUrl).toHaveBeenCalledWith("https://auth.example/authorize");
    expect(setAwaitingBrowser).toHaveBeenLastCalledWith("google");
    expect(setPendingProvider.mock.calls).toEqual([["google"], [null]]);
  });

  it("ends the desktop browser wait when the callback reports an error", async () => {
    platform.desktop = true;
    await mount();
    await act(async () => handlers?.handleGithubLogin());
    expect(setAwaitingBrowser).toHaveBeenLastCalledWith("github");

    await act(async () => platform.desktopListener?.("instafy://auth?error_description=access_denied"));

    expect(setAwaitingBrowser).toHaveBeenLastCalledWith(null);
    expect(setError).toHaveBeenLastCalledWith("access_denied");
    expect(setPendingProvider).toHaveBeenLastCalledWith(null);
  });

  it("ends the desktop browser wait when the callback completes sign-in", async () => {
    platform.desktop = true;
    supabaseMock.exchangeCodeForSession.mockResolvedValue({
      data: { user: { email: "dev@example.com" } },
      error: null,
    });
    await mount();
    await act(async () => handlers?.handleGithubLogin());

    await act(async () => platform.desktopListener?.("instafy://auth?code=auth-code"));

    expect(supabaseMock.exchangeCodeForSession).toHaveBeenCalledWith("auth-code");
    expect(setAwaitingBrowser).toHaveBeenLastCalledWith(null);
    expect(setError).toHaveBeenLastCalledWith(null);
  });

  it("reports a failed start as an error and releases the button", async () => {
    supabaseMock.signInWithOAuth.mockResolvedValue({ data: null, error: new Error("Provider is not enabled.") });
    await mount();

    await act(async () => handlers?.handleGithubLogin());

    expect(setError).toHaveBeenLastCalledWith("Provider is not enabled.");
    expect(setPendingProvider).toHaveBeenLastCalledWith(null);
  });

  it("releases a pending button when Back restores the page from the cache", async () => {
    await mount();

    await act(async () => {
      window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: false }));
    });
    expect(setPendingProvider).not.toHaveBeenCalled();

    await act(async () => {
      window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
    });
    expect(setPendingProvider).toHaveBeenCalledWith(null);
  });
});
