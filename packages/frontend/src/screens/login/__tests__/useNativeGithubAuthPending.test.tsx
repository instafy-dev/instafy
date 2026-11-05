// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  claimNativeAuthCallback,
  forgetNativeAuthCallbackClaimsForTests,
  isNativeAuthCallbackClaimed,
  NATIVE_AUTH_ERROR_EVENT,
  NATIVE_AUTH_ERROR_STORAGE_KEY,
  parseNativeAuthCallbackUrl,
  readPendingNativeAuthAttempt,
  readSignInReturnPath,
  writeNativeAuthError,
} from "../../../auth/nativeAuth";

const supabaseMock = vi.hoisted(() => ({
  signInWithOAuth: vi.fn(),
  exchangeCodeForSession: vi.fn(),
  setSession: vi.fn(),
}));

const telemetry = vi.hoisted(() => ({
  post: vi.fn<(event: { kind: string; metadata?: Record<string, unknown> | null }) => Promise<void>>(async () => undefined),
}));

const platform = vi.hoisted(() => ({
  native: false,
  desktop: false,
  desktopListener: null as ((url: string) => void) | null,
  // The callback the shell holds for the next window that drains it.
  parkedDesktopCallback: null as string | null,
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
      setSession: supabaseMock.setSession,
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
  consumeDesktopAuthCallback: async () => {
    const parked = platform.parkedDesktopCallback;
    platform.parkedDesktopCallback = null;
    return parked;
  },
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

const failedExchange = { data: { session: null, user: null }, error: new Error("invalid flow state") };
const signedInExchange = { data: { user: { email: "dev@example.com" } }, error: null };
type ExchangeResult = typeof failedExchange | typeof signedInExchange;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

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
    platform.parkedDesktopCallback = null;
    platform.openDesktopExternalUrl.mockClear();
    platform.browserOpen.mockClear();
    telemetry.post.mockClear();
    supabaseMock.signInWithOAuth.mockReset();
    supabaseMock.signInWithOAuth.mockResolvedValue({ data: { url: "https://auth.example/authorize" }, error: null });
    supabaseMock.exchangeCodeForSession.mockReset();
    supabaseMock.setSession.mockReset();
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

  it("keeps a native sign-in's destination where a new process finds it", async () => {
    platform.native = true;
    await mount();

    await act(async () => handlers?.handleGoogleLogin());
    window.sessionStorage.clear();

    expect(readSignInReturnPath()).toBe("/studio");
  });

  it("shows an error the app-wide handler reported once, not again on the next visit", async () => {
    platform.native = true;
    await mount();
    const message = "Google sign-in was cancelled or refused. Try again.";

    await act(async () => {
      window.sessionStorage.setItem(NATIVE_AUTH_ERROR_STORAGE_KEY, message);
      window.dispatchEvent(new CustomEvent(NATIVE_AUTH_ERROR_EVENT, { detail: message }));
    });
    expect(setError).toHaveBeenLastCalledWith(message);
    expect(window.sessionStorage.getItem(NATIVE_AUTH_ERROR_STORAGE_KEY)).toBeNull();

    await act(async () => root.unmount());
    setError.mockClear();
    root = createRoot(container);
    await mount();
    expect(setError).not.toHaveBeenCalledWith(message);
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
    // The callback is a deep link any app can open: the screen shows a fixed
    // message, and only telemetry records the URL's text. The page shows the
    // error now, so no copy is kept for its next visit.
    expect(setError).toHaveBeenLastCalledWith("GitHub sign-in was cancelled or refused. Try again.");
    expect(window.sessionStorage.getItem(NATIVE_AUTH_ERROR_STORAGE_KEY)).toBeNull();
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

  it("completes a sign-in from the callback the shell held while the page was away", async () => {
    platform.desktop = true;
    supabaseMock.exchangeCodeForSession.mockResolvedValue({
      data: { user: { email: "dev@example.com" } },
      error: null,
    });
    await mount();
    await act(async () => handlers?.handleGithubLogin());
    await act(async () => root.unmount());
    platform.parkedDesktopCallback = "instafy://auth?code=held-code";
    root = createRoot(container);

    await mount();

    expect(supabaseMock.exchangeCodeForSession).toHaveBeenCalledWith("held-code");
    expect(setAwaitingBrowser).toHaveBeenLastCalledWith(null);
  });

  // Any page or app can open instafy://auth, so the desktop shell acts only on
  // what a sign-in it started returns: a code its verifier can exchange, or
  // the provider's refusal.
  describe("desktop callbacks this app did not ask for", () => {
    it("ignores a code when no sign-in is pending, and leaves it unclaimed", async () => {
      platform.desktop = true;
      const callback = "instafy://auth?code=code-from-a-link";
      await mount();

      await act(async () => platform.desktopListener?.(callback));

      expect(supabaseMock.exchangeCodeForSession).not.toHaveBeenCalled();
      expect(setError).not.toHaveBeenCalled();
      expect(setAwaitingBrowser).not.toHaveBeenCalled();
      expect(window.sessionStorage.getItem(NATIVE_AUTH_ERROR_STORAGE_KEY)).toBeNull();
      expect(telemetry.post).not.toHaveBeenCalled();
      expect(claimNativeAuthCallback(parseNativeAuthCallbackUrl(callback)!)).toBe(true);
    });

    it("ignores a held callback the page drains when no sign-in is pending", async () => {
      platform.desktop = true;
      platform.parkedDesktopCallback = "instafy://auth?code=held-code";

      await mount();

      expect(platform.parkedDesktopCallback).toBeNull();
      expect(supabaseMock.exchangeCodeForSession).not.toHaveBeenCalled();
      expect(setError).not.toHaveBeenCalled();
    });

    it("shows no refusal when no sign-in is pending", async () => {
      platform.desktop = true;
      await mount();

      await act(async () => platform.desktopListener?.("instafy://auth?error_description=access_denied"));

      expect(setError).not.toHaveBeenCalled();
      expect(window.sessionStorage.getItem(NATIVE_AUTH_ERROR_STORAGE_KEY)).toBeNull();
    });

    it("never sets a session from a token pair, even while a sign-in is pending", async () => {
      platform.desktop = true;
      supabaseMock.exchangeCodeForSession.mockResolvedValue({
        data: { user: { email: "dev@example.com" } },
        error: null,
      });
      await mount();
      await act(async () => handlers?.handleGithubLogin());

      await act(async () =>
        platform.desktopListener?.(
          "instafy://auth#access_token=another-account&refresh_token=another-account&expires_in=3600&token_type=bearer",
        ),
      );

      expect(supabaseMock.setSession).not.toHaveBeenCalled();
      expect(setError.mock.calls).toEqual([[null]]);
      expect(readPendingNativeAuthAttempt()).not.toBeNull();

      // The sign-in this app started still finishes.
      await act(async () => platform.desktopListener?.("instafy://auth?code=auth-code"));

      expect(supabaseMock.exchangeCodeForSession).toHaveBeenCalledWith("auth-code");
      expect(setAwaitingBrowser).toHaveBeenLastCalledWith(null);
    });

    it("lets the sign-in finish after a refusal it did not send", async () => {
      // A stale browser tab's Cancel, or any app that opens the link.
      platform.desktop = true;
      supabaseMock.exchangeCodeForSession.mockResolvedValue({
        data: { user: { email: "dev@example.com" } },
        error: null,
      });
      await mount();
      await act(async () => handlers?.handleGithubLogin());

      await act(async () => platform.desktopListener?.("instafy://auth?error=access_denied"));
      expect(setError).toHaveBeenLastCalledWith("GitHub sign-in was cancelled or refused. Try again.");
      expect(setAwaitingBrowser).toHaveBeenLastCalledWith(null);

      await act(async () => platform.desktopListener?.("instafy://auth?code=auth-code"));

      expect(supabaseMock.exchangeCodeForSession).toHaveBeenCalledWith("auth-code");
      expect(setError).toHaveBeenLastCalledWith(null);
    });

    it("lets the sign-in finish after a code from another tab fails to exchange", async () => {
      // Pressing the provider twice opens two tabs; only the newer one's code
      // matches the verifier this app holds.
      platform.desktop = true;
      supabaseMock.exchangeCodeForSession
        .mockResolvedValueOnce({ data: { session: null, user: null }, error: new Error("invalid flow state") })
        .mockResolvedValueOnce({ data: { user: { email: "dev@example.com" } }, error: null });
      await mount();
      await act(async () => handlers?.handleGithubLogin());
      await act(async () => handlers?.handleGithubLogin());

      await act(async () => platform.desktopListener?.("instafy://auth?code=older-tab"));
      expect(setError).toHaveBeenLastCalledWith(
        "Sign-in could not be completed on this device. Start signing in again from here.",
      );

      await act(async () => platform.desktopListener?.("instafy://auth?code=newer-tab"));

      expect(supabaseMock.exchangeCodeForSession.mock.calls).toEqual([["older-tab"], ["newer-tab"]]);
      expect(setError).toHaveBeenLastCalledWith(null);
    });

    it("lets the sign-in finish when the page reloads after a refusal", async () => {
      // Cancel at the provider, reload, then go back and approve in the same tab.
      platform.desktop = true;
      supabaseMock.exchangeCodeForSession.mockResolvedValue({
        data: { user: { email: "dev@example.com" } },
        error: null,
      });
      await mount();
      await act(async () => handlers?.handleGithubLogin());
      await act(async () => platform.desktopListener?.("instafy://auth?error=access_denied"));
      expect(setError).toHaveBeenLastCalledWith("GitHub sign-in was cancelled or refused. Try again.");
      await act(async () => root.unmount());
      setError.mockClear();
      root = createRoot(container);

      await mount();
      // The page showed the refusal and kept no copy, so the reloaded page
      // shows nothing, and the sign-in is still waiting for its code.
      expect(setError).not.toHaveBeenCalled();
      expect(readPendingNativeAuthAttempt()).not.toBeNull();
      await act(async () => platform.desktopListener?.("instafy://auth?code=auth-code"));

      expect(supabaseMock.exchangeCodeForSession).toHaveBeenCalledWith("auth-code");
      expect(setError).toHaveBeenLastCalledWith(null);
    });

    it("lets the sign-in finish after the handler throws on a callback", async () => {
      platform.desktop = true;
      supabaseMock.exchangeCodeForSession
        .mockRejectedValueOnce(new TypeError("Failed to fetch"))
        .mockResolvedValueOnce({ data: { user: { email: "dev@example.com" } }, error: null });
      await mount();
      await act(async () => handlers?.handleGithubLogin());

      await act(async () => platform.desktopListener?.("instafy://auth?code=first-try"));
      expect(setError).toHaveBeenLastCalledWith("Failed to fetch");

      await act(async () => platform.desktopListener?.("instafy://auth?code=second-try"));

      expect(supabaseMock.exchangeCodeForSession.mock.calls).toEqual([["first-try"], ["second-try"]]);
      expect(setError).toHaveBeenLastCalledWith(null);
    });

    it("keeps a new sign-in pending when the page comes back after an earlier failure", async () => {
      platform.desktop = true;
      supabaseMock.exchangeCodeForSession.mockResolvedValue({
        data: { user: { email: "dev@example.com" } },
        error: null,
      });
      await mount();
      await act(async () => handlers?.handleGithubLogin());
      await act(async () => platform.desktopListener?.("instafy://auth?error_description=access_denied"));
      // The page showed that failure, so it keeps no copy for the next visit.
      // Seed a failure kept from elsewhere: by the app-wide native handler, or
      // by an older build.
      expect(window.sessionStorage.getItem(NATIVE_AUTH_ERROR_STORAGE_KEY)).toBeNull();
      writeNativeAuthError("access_denied");

      // Try again; the page remounts before the browser comes back.
      await act(async () => handlers?.handleGithubLogin());
      setError.mockClear();
      await act(async () => root.unmount());
      root = createRoot(container);
      await mount();
      // The new sign-in replaced the old failure, so the page does not show it again.
      expect(setError).not.toHaveBeenCalledWith("access_denied");
      await act(async () => platform.desktopListener?.("instafy://auth?code=second-try"));

      expect(supabaseMock.exchangeCodeForSession).toHaveBeenCalledWith("second-try");
    });

    it("shows a failure kept from before a reload and still takes the sign-in's code", async () => {
      platform.desktop = true;
      supabaseMock.exchangeCodeForSession.mockResolvedValue({
        data: { user: { email: "dev@example.com" } },
        error: null,
      });
      await mount();
      await act(async () => handlers?.handleGithubLogin());
      // A failure kept for the next login page, here one that comes back after a reload.
      writeNativeAuthError("access_denied");
      await act(async () => root.unmount());
      root = createRoot(container);
      await mount();

      expect(setError).toHaveBeenCalledWith("access_denied");
      expect(readPendingNativeAuthAttempt()).not.toBeNull();
      await act(async () => platform.desktopListener?.("instafy://auth?code=after-reload"));
      expect(supabaseMock.exchangeCodeForSession).toHaveBeenCalledWith("after-reload");
    });
  });

  it("still ends a native sign-in when its callback is refused or its code fails", async () => {
    // Desktop keeps a sign-in pending after a failure; mobile does not.
    platform.native = true;
    supabaseMock.exchangeCodeForSession.mockResolvedValue({
      data: { session: null, user: null },
      error: new Error("invalid flow state"),
    });
    const listeners = installNativePlugins();
    await mount();

    await act(async () => handlers?.handleGithubLogin());
    expect(readPendingNativeAuthAttempt()).not.toBeNull();
    await act(async () => listeners.appUrlOpen?.({ url: "instafy://auth?error=access_denied" }));
    expect(readPendingNativeAuthAttempt()).toBeNull();

    await act(async () => handlers?.handleGithubLogin());
    expect(readPendingNativeAuthAttempt()).not.toBeNull();
    await act(async () => listeners.appUrlOpen?.({ url: "instafy://auth?code=spent-code" }));
    expect(readPendingNativeAuthAttempt()).toBeNull();
  });

  it("still completes a native callback that arrives with no attempt pending", async () => {
    // Mobile is unchanged: an Android deep link can start a new process after
    // the attempt is gone, and the app-wide handler shares these callbacks.
    platform.native = true;
    supabaseMock.exchangeCodeForSession.mockResolvedValue({
      data: { user: { email: "dev@example.com" } },
      error: null,
    });
    const listeners = installNativePlugins();
    await mount();

    await act(async () => listeners.appUrlOpen?.({ url: "instafy://auth?code=native-code" }));

    expect(supabaseMock.exchangeCodeForSession).toHaveBeenCalledWith("native-code");
  });

  // Every sign-in the apps start is PKCE and returns a code, so a callback
  // carrying session tokens was made by whoever opened the link.
  describe("native callbacks that carry session tokens", () => {
    it.each([
      ["fragment", "instafy://auth#access_token=another-account&refresh_token=another-account&expires_in=3600&token_type=bearer"],
      ["query", "instafy://auth?access_token=another-account&refresh_token=another-account"],
    ])("ignores a token pair in the %s when no sign-in is pending, and leaves it unclaimed", async (_place, callback) => {
      platform.native = true;
      const listeners = installNativePlugins();
      await mount();

      await act(async () => listeners.appUrlOpen?.({ url: callback }));

      expect(supabaseMock.setSession).not.toHaveBeenCalled();
      expect(supabaseMock.exchangeCodeForSession).not.toHaveBeenCalled();
      expect(setError).not.toHaveBeenCalled();
      expect(window.sessionStorage.getItem(NATIVE_AUTH_ERROR_STORAGE_KEY)).toBeNull();
      expect(telemetry.post).not.toHaveBeenCalled();
      expect(claimNativeAuthCallback(parseNativeAuthCallbackUrl(callback)!)).toBe(true);
    });

    it("leaves a native sign-in pending through a token pair, and still completes it with the code", async () => {
      platform.native = true;
      supabaseMock.exchangeCodeForSession.mockResolvedValue(signedInExchange);
      const listeners = installNativePlugins();
      await mount();
      await act(async () => handlers?.handleGithubLogin());

      await act(async () =>
        listeners.appUrlOpen?.({
          url: "instafy://auth#access_token=another-account&refresh_token=another-account&expires_in=3600&token_type=bearer",
        }),
      );

      expect(supabaseMock.setSession).not.toHaveBeenCalled();
      expect(setError.mock.calls).toEqual([[null]]);
      expect(telemetry.post.mock.calls.map(([event]) => event.kind)).toEqual(["auth.login.github.started"]);
      expect(readPendingNativeAuthAttempt()).not.toBeNull();

      await act(async () => listeners.appUrlOpen?.({ url: "instafy://auth?code=auth-code" }));

      expect(supabaseMock.exchangeCodeForSession).toHaveBeenCalledWith("auth-code");
      expect(setError).toHaveBeenLastCalledWith(null);
      expect(readPendingNativeAuthAttempt()).toBeNull();
    });
  });

  // The shell hands a desktop callback over once: it parks it and sends it,
  // and the listener drains the parked copy. One dropped while another is
  // being exchanged would be lost, so it waits its turn instead.
  describe("callbacks that arrive while another is being exchanged", () => {
    const deliver = async (url: string) => {
      platform.parkedDesktopCallback = url;
      await act(async () => platform.desktopListener?.(url));
    };

    const startDesktopSignIn = async () => {
      platform.desktop = true;
      await mount();
      await act(async () => handlers?.handleGithubLogin());
    };

    it("exchanges a code that arrived during a failing exchange once that exchange settles", async () => {
      await startDesktopSignIn();
      const first = deferred<ExchangeResult>();
      supabaseMock.exchangeCodeForSession
        .mockImplementationOnce(() => first.promise)
        .mockResolvedValueOnce(signedInExchange);

      await deliver("instafy://auth?code=older-tab");
      await deliver("instafy://auth?code=newer-tab");
      expect(platform.parkedDesktopCallback).toBeNull();
      expect(supabaseMock.exchangeCodeForSession.mock.calls).toEqual([["older-tab"]]);

      await act(async () => first.resolve(failedExchange));

      expect(supabaseMock.exchangeCodeForSession.mock.calls).toEqual([["older-tab"], ["newer-tab"]]);
      expect(setError).toHaveBeenLastCalledWith(null);
      expect(window.sessionStorage.getItem(NATIVE_AUTH_ERROR_STORAGE_KEY)).toBeNull();
      expect(readPendingNativeAuthAttempt()).toBeNull();
    });

    it("drops a code that waited behind an exchange that signed in", async () => {
      await startDesktopSignIn();
      const first = deferred<ExchangeResult>();
      supabaseMock.exchangeCodeForSession
        .mockImplementationOnce(() => first.promise)
        .mockResolvedValue(signedInExchange);

      await deliver("instafy://auth?code=first");
      await deliver("instafy://auth?code=second");
      await act(async () => first.resolve(signedInExchange));

      expect(supabaseMock.exchangeCodeForSession.mock.calls).toEqual([["first"]]);
      expect(setError).toHaveBeenLastCalledWith(null);
      expect(isNativeAuthCallbackClaimed(parseNativeAuthCallbackUrl("instafy://auth?code=second")!)).toBe(false);
    });

    it("exchanges a code once when the shell delivers it twice while another is exchanged", async () => {
      await startDesktopSignIn();
      const first = deferred<ExchangeResult>();
      // Every exchange fails, so the sign-in stays pending and nothing but the
      // repeat itself could stop a second exchange.
      supabaseMock.exchangeCodeForSession
        .mockImplementationOnce(() => first.promise)
        .mockResolvedValue(failedExchange);

      await deliver("instafy://auth?code=first");
      await deliver("instafy://auth?code=second");
      await deliver("instafy://auth?code=second");
      await act(async () => first.resolve(failedExchange));

      expect(supabaseMock.exchangeCodeForSession.mock.calls).toEqual([["first"], ["second"]]);
    });

    it("exchanges a code once when it is delivered again during its own exchange", async () => {
      await startDesktopSignIn();
      const first = deferred<ExchangeResult>();
      supabaseMock.exchangeCodeForSession
        .mockImplementationOnce(() => first.promise)
        .mockResolvedValue(failedExchange);

      await deliver("instafy://auth?code=first");
      await deliver("instafy://auth?code=first");
      await act(async () => first.resolve(failedExchange));

      expect(supabaseMock.exchangeCodeForSession.mock.calls).toEqual([["first"]]);
    });

    it("keeps only the newest three callbacks waiting", async () => {
      await startDesktopSignIn();
      const first = deferred<ExchangeResult>();
      supabaseMock.exchangeCodeForSession
        .mockImplementationOnce(() => first.promise)
        .mockResolvedValue(failedExchange);

      await deliver("instafy://auth?code=a");
      for (const code of ["b", "c", "d", "e"]) {
        await deliver(`instafy://auth?code=${code}`);
      }
      await act(async () => first.resolve(failedExchange));

      // The person's own code is the one that arrives last, so the oldest
      // waiting callback is the one that gives way.
      expect(supabaseMock.exchangeCodeForSession.mock.calls).toEqual([["a"], ["c"], ["d"], ["e"]]);
      expect(isNativeAuthCallbackClaimed(parseNativeAuthCallbackUrl("instafy://auth?code=b")!)).toBe(false);
    });

    it("gives a repeated callback no place in line, so it cannot push another out", async () => {
      await startDesktopSignIn();
      const first = deferred<ExchangeResult>();
      supabaseMock.exchangeCodeForSession
        .mockImplementationOnce(() => first.promise)
        .mockResolvedValue(failedExchange);

      await deliver("instafy://auth?code=a");
      await deliver("instafy://auth?code=b");
      // A repeat of the code being exchanged, then of one already waiting.
      await deliver("instafy://auth?code=a");
      await deliver("instafy://auth?code=c");
      await deliver("instafy://auth?code=c");
      await deliver("instafy://auth?code=d");
      await act(async () => first.resolve(failedExchange));

      expect(supabaseMock.exchangeCodeForSession.mock.calls).toEqual([["a"], ["b"], ["c"], ["d"]]);
    });

    it("drops waiting callbacks when the page goes away", async () => {
      await startDesktopSignIn();
      const first = deferred<ExchangeResult>();
      supabaseMock.exchangeCodeForSession
        .mockImplementationOnce(() => first.promise)
        .mockResolvedValue(signedInExchange);

      await deliver("instafy://auth?code=a");
      await deliver("instafy://auth?code=b");
      await act(async () => root.unmount());
      root = createRoot(container);
      await act(async () => first.resolve(failedExchange));

      expect(supabaseMock.exchangeCodeForSession.mock.calls).toEqual([["a"]]);
    });

    it("never keeps a token pair waiting, nor sets a session from one", async () => {
      await startDesktopSignIn();
      const first = deferred<ExchangeResult>();
      supabaseMock.exchangeCodeForSession
        .mockImplementationOnce(() => first.promise)
        .mockResolvedValue(failedExchange);
      const tokenPair =
        "instafy://auth#access_token=another-account&refresh_token=another-account&expires_in=3600&token_type=bearer";

      await deliver("instafy://auth?code=a");
      for (const code of ["b", "c", "d"]) {
        await deliver(`instafy://auth?code=${code}`);
      }
      // With the line full, a token pair kept waiting would push "b" out.
      await deliver(tokenPair);
      await act(async () => first.resolve(failedExchange));

      expect(supabaseMock.setSession).not.toHaveBeenCalled();
      expect(supabaseMock.exchangeCodeForSession.mock.calls).toEqual([["a"], ["b"], ["c"], ["d"]]);
      expect(isNativeAuthCallbackClaimed(parseNativeAuthCallbackUrl(tokenPair)!)).toBe(false);
    });

    it("exchanges a live code that arrives while the one held for the page is exchanged", async () => {
      await startDesktopSignIn();
      await act(async () => root.unmount());
      root = createRoot(container);
      const held = deferred<ExchangeResult>();
      supabaseMock.exchangeCodeForSession
        .mockImplementationOnce(() => held.promise)
        .mockResolvedValueOnce(signedInExchange);
      platform.parkedDesktopCallback = "instafy://auth?code=held";

      await mount();
      await deliver("instafy://auth?code=live");
      await act(async () => held.resolve(failedExchange));

      expect(supabaseMock.exchangeCodeForSession.mock.calls).toEqual([["held"], ["live"]]);
      expect(setError).toHaveBeenLastCalledWith(null);
    });

    it("still drops a native callback that arrives while a native exchange is in flight", async () => {
      platform.native = true;
      const listeners = installNativePlugins();
      await mount();
      await act(async () => handlers?.handleGithubLogin());
      const first = deferred<ExchangeResult>();
      supabaseMock.exchangeCodeForSession
        .mockImplementationOnce(() => first.promise)
        .mockResolvedValue(signedInExchange);

      await act(async () => listeners.appUrlOpen?.({ url: "instafy://auth?code=a" }));
      await act(async () => listeners.appUrlOpen?.({ url: "instafy://auth?code=b" }));
      await act(async () => first.resolve(failedExchange));

      expect(supabaseMock.exchangeCodeForSession.mock.calls).toEqual([["a"]]);
    });
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
