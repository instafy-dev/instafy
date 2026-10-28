// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  claimNativeAuthCallback,
  forgetNativeAuthCallbackClaimsForTests,
  NATIVE_AUTH_ERROR_EVENT,
  NATIVE_AUTH_ERROR_STORAGE_KEY,
  parseNativeAuthCallbackUrl,
} from "../../../auth/nativeAuth";

const supabaseMock = vi.hoisted(() => ({
  signInWithOAuth: vi.fn(),
  exchangeCodeForSession: vi.fn(),
}));

const telemetry = vi.hoisted(() => ({
  post: vi.fn<(event: { kind: string; metadata?: Record<string, unknown> | null }) => Promise<void>>(async () => undefined),
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
  postAuthTelemetryEvent: telemetry.post,
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
    telemetry.post.mockClear();
    supabaseMock.signInWithOAuth.mockReset();
    supabaseMock.signInWithOAuth.mockResolvedValue({ data: { url: "https://auth.example/authorize" }, error: null });
    supabaseMock.exchangeCodeForSession.mockReset();
    setError.mockReset();
    setPendingProvider.mockReset();
    setAwaitingBrowser.mockReset();
    handlers = null;
    forgetNativeAuthCallbackClaimsForTests();
    window.localStorage.clear();
    window.sessionStorage.clear();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    delete (window as { Capacitor?: unknown }).Capacitor;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  const mount = async () => {
    await act(async () => root.render(<Harness />));
  };

  // The Capacitor plugins the hook reads directly; returns the deep-link listener.
  const installNativePlugins = () => {
    const listeners: { appUrlOpen: ((event?: { url?: string | null }) => void) | null } = { appUrlOpen: null };
    (window as { Capacitor?: unknown }).Capacitor = {
      Plugins: {
        App: {
          addListener: (eventName: string, listener: (event?: { url?: string | null }) => void) => {
            if (eventName === "appUrlOpen") listeners.appUrlOpen = listener;
            return { remove: () => undefined };
          },
          getLaunchUrl: async () => null,
        },
        InstafyAuthBridge: {
          addListener: () => ({ remove: () => undefined }),
          consumePendingUrl: async () => null,
        },
      },
    };
    return listeners;
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

  it("opens Google in the native custom tab with the app's deep-link callback", async () => {
    platform.native = true;
    await mount();

    await act(async () => handlers?.handleGoogleLogin());

    expect(supabaseMock.signInWithOAuth).toHaveBeenCalledWith({
      provider: "google",
      options: {
        redirectTo: "instafy://auth",
        queryParams: { apikey: "anon-key", prompt: "select_account" },
        skipBrowserRedirect: true,
      },
    });
    expect(platform.browserOpen).toHaveBeenCalledWith({ url: "https://auth.example/authorize" });
    expect(setPendingProvider.mock.calls).toEqual([["google"], [null]]);
    expect(telemetry.post).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "auth.login.google.started",
        metadata: expect.objectContaining({ provider: "google", platform: "ios" }),
      }),
    );
  });

  it("names Google, in its message and telemetry, when a native Google callback comes back incomplete", async () => {
    platform.native = true;
    let appUrlOpen: ((event?: { url?: string | null }) => void) | null = null;
    (window as { Capacitor?: unknown }).Capacitor = {
      Plugins: {
        App: {
          addListener: (eventName: string, listener: (event?: { url?: string | null }) => void) => {
            if (eventName === "appUrlOpen") appUrlOpen = listener;
            return { remove: () => undefined };
          },
          getLaunchUrl: async () => null,
        },
        InstafyAuthBridge: {
          addListener: () => ({ remove: () => undefined }),
          consumePendingUrl: async () => null,
        },
      },
    };
    await mount();
    await act(async () => handlers?.handleGoogleLogin());
    expect(appUrlOpen).not.toBeNull();

    await act(async () => appUrlOpen?.({ url: "instafy://auth" }));

    expect(setError).toHaveBeenLastCalledWith("Google sign-in returned to the app without completing. Try again.");
    expect(telemetry.post.mock.calls.map(([event]) => event.kind)).toEqual([
      "auth.login.google.started",
      "auth.login.google.callback_received",
      "auth.login.google.callback_incomplete",
    ]);
  });

  // Android can end the app's process while the custom tab is in front; the
  // deep link then starts a new one, with an empty sessionStorage.
  it("still names Google when the callback reaches a new process", async () => {
    platform.native = true;
    installNativePlugins();
    await mount();
    await act(async () => handlers?.handleGoogleLogin());
    await act(async () => root.unmount());
    window.sessionStorage.clear();
    telemetry.post.mockClear();
    root = createRoot(container);
    const listeners = installNativePlugins();
    await mount();

    await act(async () => listeners.appUrlOpen?.({ url: "instafy://auth" }));

    expect(setError).toHaveBeenLastCalledWith("Google sign-in returned to the app without completing. Try again.");
    expect(telemetry.post.mock.calls.map(([event]) => event.kind)).toEqual([
      "auth.login.google.callback_received",
      "auth.login.google.callback_incomplete",
    ]);
  });

  it("leaves a callback alone that the app-wide handler already took", async () => {
    platform.native = true;
    const listeners = installNativePlugins();
    await mount();
    await act(async () => handlers?.handleGoogleLogin());
    // AuthProvider hears the same deep link first and claims it.
    expect(claimNativeAuthCallback(parseNativeAuthCallbackUrl("instafy://auth?code=auth-code")!)).toBe(true);
    setError.mockClear();

    await act(async () => listeners.appUrlOpen?.({ url: "instafy://auth?code=auth-code" }));

    expect(supabaseMock.exchangeCodeForSession).not.toHaveBeenCalled();
    expect(setError).not.toHaveBeenCalled();
    expect(window.sessionStorage.getItem(NATIVE_AUTH_ERROR_STORAGE_KEY)).toBeNull();
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
    // The callback is a deep link any app can open: the screen and the stored
    // error show a fixed message, and only telemetry records the URL's text.
    expect(setError).toHaveBeenLastCalledWith("GitHub sign-in was cancelled or refused. Try again.");
    expect(window.sessionStorage.getItem(NATIVE_AUTH_ERROR_STORAGE_KEY)).toBe(
      "GitHub sign-in was cancelled or refused. Try again.",
    );
    expect(telemetry.post).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "auth.login.github.callback_error", message: "access_denied" }),
    );
    expect(setPendingProvider).toHaveBeenLastCalledWith(null);
  });

  it("names Google when a desktop Google sign-in comes back refused", async () => {
    platform.desktop = true;
    await mount();
    await act(async () => handlers?.handleGoogleLogin());

    await act(async () => platform.desktopListener?.("instafy://auth?error_description=access_denied"));

    expect(setError).toHaveBeenLastCalledWith("Google sign-in was cancelled or refused. Try again.");
    expect(telemetry.post).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "auth.login.google.callback_error",
        metadata: expect.objectContaining({ provider: "google" }),
      }),
    );
  });

  it("reports a second refusal after the login page comes back", async () => {
    platform.desktop = true;
    const refusal = "instafy://auth?error=access_denied&error_description=The+user+denied+the+request";
    await mount();
    await act(async () => handlers?.handleGoogleLogin());
    await act(async () => platform.desktopListener?.(refusal));
    expect(setError).toHaveBeenLastCalledWith("Google sign-in was cancelled or refused. Try again.");
    await act(async () => root.unmount());
    root = createRoot(container);
    await mount();
    setError.mockClear();
    setAwaitingBrowser.mockClear();

    await act(async () => handlers?.handleGoogleLogin());
    await act(async () => platform.desktopListener?.(refusal));

    expect(setError).toHaveBeenLastCalledWith("Google sign-in was cancelled or refused. Try again.");
    expect(setAwaitingBrowser).toHaveBeenLastCalledWith(null);
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
