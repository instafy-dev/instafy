// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  claimNativeAuthCallback,
  createPendingNativeAuthAttempt,
  forgetNativeAuthCallbackClaimsForTests,
  NATIVE_AUTH_ERROR_EVENT,
  NATIVE_AUTH_ERROR_STORAGE_KEY,
  NATIVE_AUTH_SUCCESS_EVENT,
  parseNativeAuthCallbackUrl,
  readNativeAuthCallbackAttemptId,
  readPendingNativeAuthAttempt,
  writePendingNativeAuthAttempt,
} from "../../auth/nativeAuth";
import { holdOtherAccountLink, readOtherAccountLink } from "../../auth/otherAccountLink";

// The app shell as the handler sees it. On Android the auth bridge keeps the
// last callback for a drain, and a urlOpen it fired before anyone listened
// reaches the first listener when it is added.
const native = vi.hoisted(() => ({
  platform: "ios" as "ios" | "android" | "web",
  launchUrl: null as string | null,
  pendingBridgeUrl: null as string | null,
  retainedBridgeUrl: null as string | null,
  appUrlOpen: null as ((event: { url?: string }) => void) | null,
  resume: null as (() => void) | null,
  bridgeUrlOpen: null as ((url: string) => void) | null,
  browserClose: vi.fn(async () => undefined),
}));

const supabaseAuth = vi.hoisted(() => ({
  exchangeCodeForSession: vi.fn(),
  setSession: vi.fn(),
  getSession: vi.fn(),
  signOut: vi.fn<() => Promise<{ error: Error | null }>>(async () => ({ error: null })),
  onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => undefined } } }),
}));

const telemetry = vi.hoisted(() => ({
  post: vi.fn<(event: { kind: string; message?: string | null }) => Promise<void>>(async () => undefined),
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: {
    isNativePlatform: () => native.platform !== "web",
    getPlatform: () => native.platform,
  },
}));
vi.mock("@capacitor/app", () => ({
  App: {
    getLaunchUrl: async () => (native.launchUrl ? { url: native.launchUrl } : undefined),
    addListener: async (eventName: string, listener: (event: { url?: string }) => void) => {
      if (eventName === "appUrlOpen") native.appUrlOpen = listener;
      if (eventName === "resume") native.resume = () => listener({});
      return { remove: async () => undefined };
    },
  },
}));
vi.mock("@capacitor/browser", () => ({ Browser: { close: native.browserClose } }));
// Like the real module, the bridge answers on Android only.
vi.mock("../../auth/nativeAuthBridge", () => ({
  consumePendingNativeAuthBridgeUrl: async () => {
    if (native.platform !== "android") return null;
    const url = native.pendingBridgeUrl;
    native.pendingBridgeUrl = null;
    return url;
  },
  listenForNativeAuthBridgeUrl: async (listener: (url: string) => void) => {
    if (native.platform !== "android") return null;
    native.bridgeUrlOpen = listener;
    const retained = native.retainedBridgeUrl;
    native.retainedBridgeUrl = null;
    if (retained) listener(retained);
    return { remove: async () => undefined };
  },
}));
vi.mock("../../lib/supabaseClient", () => ({
  hasSupabaseConfig: true,
  supabaseUrl: "https://supabase.example",
  supabaseAnonKey: "anon-key",
  supabase: { auth: supabaseAuth },
}));
vi.mock("../../store", () => ({
  useWorkspaceStore: { getState: () => ({ setWorkspaceScope: () => undefined }) },
}));
vi.mock("../../workspace/projectClear", () => ({ clearProjectState: () => undefined }));
vi.mock("../../screens/studio/components/previewHost/locationSites", () => ({
  setLocationSitesAccount: () => undefined,
}));
vi.mock("../../screens/studio/components/previewHost/followStore", () => ({
  setFollowAccount: () => undefined,
}));
vi.mock("../../notifications/notificationLifecycle", () => ({
  changeNotificationSession: async () => undefined,
  releaseNotificationSession: async () => undefined,
}));
vi.mock("../../notifications/notificationActions", () => ({
  installNotificationActionListeners: () => () => undefined,
}));
vi.mock("../../services/runtimeController/authTelemetry", () => ({
  postAuthTelemetryEvent: telemetry.post,
}));

import { AuthProvider, useAuth } from "../AuthProvider";

const SIGNED_IN_SESSION = {
  access_token: "signed-in-access-token",
  refresh_token: "signed-in-refresh-token",
  user: { id: "signed-in-user", email: "me@example.com" },
};
const CODE_USER = { id: "code-user", email: "me@example.com" };
const CODE_SIGN_IN = {
  data: { session: { access_token: "code-access-token", user: CODE_USER }, user: CODE_USER },
  error: null,
};

const TOKEN_PAIR_IN_FRAGMENT =
  "instafy://auth#access_token=another-account-access-token&refresh_token=another-account-refresh-token&expires_in=3600&token_type=bearer";
const TOKEN_PAIR_IN_QUERY =
  "instafy://auth?access_token=another-account-access-token&refresh_token=another-account-refresh-token";

type CallbackSource = {
  source: string;
  platform: "ios" | "android";
  /** Puts the callback where the app finds it as it starts. */
  beforeMount?: (url: string) => void;
  /** Delivers the callback to the running app. */
  afterMount?: (url: string) => void;
};

const SOURCES: CallbackSource[] = [
  {
    source: "the iOS launch URL",
    platform: "ios",
    beforeMount: (url) => {
      native.launchUrl = url;
    },
  },
  { source: "appUrlOpen on iOS", platform: "ios", afterMount: (url) => native.appUrlOpen?.({ url }) },
  { source: "appUrlOpen on Android", platform: "android", afterMount: (url) => native.appUrlOpen?.({ url }) },
  { source: "urlOpen on the Android bridge", platform: "android", afterMount: (url) => native.bridgeUrlOpen?.(url) },
  {
    source: "the Android bridge drain",
    platform: "android",
    beforeMount: (url) => {
      native.pendingBridgeUrl = url;
    },
  },
];

const TOKEN_PAIR_CASES = SOURCES.flatMap((source) => [
  { ...source, placement: "fragment", url: TOKEN_PAIR_IN_FRAGMENT },
  { ...source, placement: "query", url: TOKEN_PAIR_IN_QUERY },
]);

describe("AuthProvider's native sign-in callback handler", () => {
  let container: HTMLDivElement;
  let root: Root;
  let auth: ReturnType<typeof useAuth> | null = null;
  const events = { errors: [] as string[], successes: 0 };
  const onError = (event: Event) => {
    events.errors.push(String((event as CustomEvent).detail));
  };
  const onSuccess = () => {
    events.successes += 1;
  };

  function AuthProbe() {
    auth = useAuth();
    return null;
  }

  // Waits inside act, so the state the handler sets lands in a React batch.
  const waitFor = (assertion: () => void) =>
    act(async () => {
      await vi.waitFor(assertion);
    });

  const mount = async () => {
    await act(async () => {
      root.render(
        <AuthProvider>
          <AuthProbe />
        </AuthProvider>,
      );
    });
    // The handler installs its resume listener last, after the drain and the
    // launch URL.
    await waitFor(() => {
      expect(native.resume).not.toBeNull();
      expect(auth?.loading).toBe(false);
    });
  };

  // Gives a callback the handler should leave alone every chance to act.
  const settle = async () => {
    for (let turn = 0; turn < 5; turn += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }
  };

  const deliver = async ({ beforeMount, afterMount }: CallbackSource, url: string) => {
    beforeMount?.(url);
    await mount();
    if (afterMount) {
      await act(async () => afterMount(url));
    }
    await settle();
  };

  // A sign-in the app started, as it keeps it in localStorage.
  const startSignIn = (provider: "github" | "google") => {
    const attempt = createPendingNativeAuthAttempt(provider);
    writePendingNativeAuthAttempt(attempt);
    return attempt;
  };

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    native.platform = "ios";
    native.launchUrl = null;
    native.pendingBridgeUrl = null;
    native.retainedBridgeUrl = null;
    native.appUrlOpen = null;
    native.resume = null;
    native.bridgeUrlOpen = null;
    native.browserClose.mockClear();
    supabaseAuth.exchangeCodeForSession.mockReset();
    supabaseAuth.setSession.mockReset();
    supabaseAuth.setSession.mockResolvedValue({ data: { session: null, user: null }, error: null });
    supabaseAuth.getSession.mockReset();
    supabaseAuth.getSession.mockResolvedValue({ data: { session: null }, error: null });
    supabaseAuth.signOut.mockClear();
    telemetry.post.mockClear();
    auth = null;
    events.errors = [];
    events.successes = 0;
    window.addEventListener(NATIVE_AUTH_ERROR_EVENT, onError);
    window.addEventListener(NATIVE_AUTH_SUCCESS_EVENT, onSuccess);
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
    window.removeEventListener(NATIVE_AUTH_ERROR_EVENT, onError);
    window.removeEventListener(NATIVE_AUTH_SUCCESS_EVENT, onSuccess);
    window.localStorage.clear();
    window.sessionStorage.clear();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  // Every sign-in the apps start is PKCE and comes back with a code. A
  // callback carrying session tokens was made by whoever opened the link, so
  // acting on it would sign the app in to their account, or out of this one.
  describe.each([
    { state: "while signed in", session: SIGNED_IN_SESSION, provider: null },
    { state: "while a sign-in is pending", session: null, provider: "github" as const },
  ])("a token pair $state", ({ session, provider }) => {
    it.each(TOKEN_PAIR_CASES)(
      "is ignored and left unclaimed when it comes in the $placement from $source",
      async (callback) => {
        native.platform = callback.platform;
        supabaseAuth.getSession.mockResolvedValue({ data: { session }, error: null });
        const attempt = provider ? startSignIn(provider) : null;

        await deliver(callback, callback.url);

        expect(supabaseAuth.setSession).not.toHaveBeenCalled();
        expect(supabaseAuth.exchangeCodeForSession).not.toHaveBeenCalled();
        expect(supabaseAuth.signOut).not.toHaveBeenCalled();
        expect(events.errors).toEqual([]);
        expect(events.successes).toBe(0);
        expect(window.sessionStorage.getItem(NATIVE_AUTH_ERROR_STORAGE_KEY)).toBeNull();
        expect(native.browserClose).not.toHaveBeenCalled();
        expect(telemetry.post).not.toHaveBeenCalled();
        expect(auth?.user?.id ?? null).toBe(session?.user.id ?? null);
        expect(readPendingNativeAuthAttempt()).toEqual(attempt);
        expect(claimNativeAuthCallback(parseNativeAuthCallbackUrl(callback.url)!)).toBe(true);
      },
    );
  });

  it.each([
    { tokens: "only an access token", url: "instafy://auth#access_token=another-account-access-token" },
    { tokens: "only a refresh token", url: "instafy://auth?refresh_token=another-account-refresh-token" },
  ])("ignores a callback carrying $tokens without ending the pending sign-in", async ({ url }) => {
    // Half a pair is still the sender's tokens, not what a PKCE sign-in returns.
    native.platform = "android";
    const attempt = startSignIn("github");
    await mount();

    await act(async () => native.bridgeUrlOpen?.(url));
    await settle();

    expect(supabaseAuth.setSession).not.toHaveBeenCalled();
    expect(events.errors).toEqual([]);
    expect(window.sessionStorage.getItem(NATIVE_AUTH_ERROR_STORAGE_KEY)).toBeNull();
    expect(native.browserClose).not.toHaveBeenCalled();
    expect(telemetry.post).not.toHaveBeenCalled();
    expect(readPendingNativeAuthAttempt()).toEqual(attempt);
    expect(claimNativeAuthCallback(parseNativeAuthCallbackUrl(url)!)).toBe(true);
  });

  it("completes a pending sign-in from its code once, though Android delivers it three times", async () => {
    native.platform = "android";
    startSignIn("github");
    supabaseAuth.exchangeCodeForSession.mockResolvedValue(CODE_SIGN_IN);
    const url = "instafy://auth?code=auth-code";
    await mount();

    // Coming back from the custom tab fires the bridge's urlOpen and
    // appUrlOpen, and the bridge keeps the URL for the drain after resume.
    native.pendingBridgeUrl = url;
    await act(async () => {
      native.bridgeUrlOpen?.(url);
      native.appUrlOpen?.({ url });
      native.resume?.();
    });
    await waitFor(() => {
      expect(native.pendingBridgeUrl).toBeNull();
      expect(native.browserClose).toHaveBeenCalled();
    });
    await settle();

    expect(supabaseAuth.exchangeCodeForSession.mock.calls).toEqual([["auth-code"]]);
    expect(readPendingNativeAuthAttempt()).toBeNull();
    expect(readNativeAuthCallbackAttemptId()).toBeNull();
    expect(events.successes).toBe(1);
    expect(events.errors).toEqual([]);
    expect(window.sessionStorage.getItem(NATIVE_AUTH_ERROR_STORAGE_KEY)).toBeNull();
    expect(native.browserClose).toHaveBeenCalledTimes(1);
    expect(auth?.user?.id).toBe(CODE_USER.id);
  });

  it("still completes the sign-in it started after ignoring a token pair", async () => {
    startSignIn("github");
    supabaseAuth.exchangeCodeForSession.mockResolvedValue(CODE_SIGN_IN);
    await mount();

    await act(async () => native.appUrlOpen?.({ url: TOKEN_PAIR_IN_FRAGMENT }));
    await act(async () => native.appUrlOpen?.({ url: "instafy://auth?code=auth-code" }));
    await waitFor(() => expect(native.browserClose).toHaveBeenCalled());

    expect(supabaseAuth.setSession).not.toHaveBeenCalled();
    expect(supabaseAuth.exchangeCodeForSession.mock.calls).toEqual([["auth-code"]]);
    expect(readPendingNativeAuthAttempt()).toBeNull();
    expect(events.successes).toBe(1);
    expect(auth?.user?.id).toBe(CODE_USER.id);
  });

  // Android can end the app's process while the custom tab is in front. The
  // deep link then starts a new one, which finds the attempt in localStorage
  // and the same callback three times: the bridge's retained urlOpen, its
  // drain and the launch URL.
  it.each([
    { timing: "as the bridge listener is added", retainedBeforeListening: true },
    { timing: "after the drain and the launch URL", retainedBeforeListening: false },
  ])(
    "exchanges the code once after Android restarts the app, with the retained event arriving $timing",
    async ({ retainedBeforeListening }) => {
      native.platform = "android";
      startSignIn("google");
      supabaseAuth.exchangeCodeForSession.mockResolvedValue(CODE_SIGN_IN);
      const url = "instafy://auth?code=cold-start-code";
      native.launchUrl = url;
      native.pendingBridgeUrl = url;
      if (retainedBeforeListening) {
        native.retainedBridgeUrl = url;
      }

      await mount();
      if (!retainedBeforeListening) {
        await act(async () => native.bridgeUrlOpen?.(url));
      }
      await waitFor(() => expect(native.browserClose).toHaveBeenCalled());
      await settle();

      // The bridge handed over both of its copies.
      expect(native.retainedBridgeUrl).toBeNull();
      expect(native.pendingBridgeUrl).toBeNull();
      expect(supabaseAuth.exchangeCodeForSession.mock.calls).toEqual([["cold-start-code"]]);
      expect(readPendingNativeAuthAttempt()).toBeNull();
      expect(events.successes).toBe(1);
      expect(events.errors).toEqual([]);
      // The attempt that outlived the process still names the provider.
      expect(telemetry.post.mock.calls.map(([event]) => event.kind)).toEqual([
        "auth.login.google.callback_received",
        "auth.login.google.completed",
      ]);
    },
  );

  it("ends a pending sign-in the provider refused with a fixed message, never the link's own text", async () => {
    startSignIn("google");
    await mount();

    await act(async () =>
      native.appUrlOpen?.({
        url: "instafy://auth?error=access_denied&error_description=Call+support+at+evil.example",
      }),
    );
    await waitFor(() => expect(native.browserClose).toHaveBeenCalled());

    const message = "Google sign-in was cancelled or refused. Try again.";
    expect(events.errors).toEqual([message]);
    expect(window.sessionStorage.getItem(NATIVE_AUTH_ERROR_STORAGE_KEY)).toBe(message);
    expect(events.successes).toBe(0);
    expect(readPendingNativeAuthAttempt()).toBeNull();
    expect(supabaseAuth.exchangeCodeForSession).not.toHaveBeenCalled();
    expect(supabaseAuth.setSession).not.toHaveBeenCalled();
    // The callback is a deep link any app can open: only telemetry records its text.
    expect(telemetry.post).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "auth.login.google.callback_error", message: "Call support at evil.example" }),
    );
  });
});

describe("AuthProvider's signOut on the web", () => {
  // Another account's sign-in, as the Supabase client holds it from start-up
  // when a link for that account opens a page already signed in.
  const OTHER_ACCOUNT_LINK = {
    accessToken: "another-account-access-token",
    refreshToken: "another-account-refresh-token",
    email: "someone-else@example.com",
    recovery: false,
  };

  let container: HTMLDivElement;
  let root: Root;
  let auth: ReturnType<typeof useAuth> | null = null;

  function AuthProbe() {
    auth = useAuth();
    return null;
  }

  const mountSignedIn = async () => {
    await act(async () => {
      root.render(
        <AuthProvider>
          <AuthProbe />
        </AuthProvider>,
      );
    });
    await act(async () => {
      await vi.waitFor(() => expect(auth?.user?.id).toBe(SIGNED_IN_SESSION.user.id));
    });
  };

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    native.platform = "web";
    supabaseAuth.getSession.mockReset();
    supabaseAuth.getSession.mockResolvedValue({ data: { session: SIGNED_IN_SESSION }, error: null });
    supabaseAuth.signOut.mockReset();
    auth = null;
    window.localStorage.clear();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    holdOtherAccountLink(null);
    window.localStorage.clear();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("drops a link held for another account, so it is not offered to whoever signs in next", async () => {
    holdOtherAccountLink(OTHER_ACCOUNT_LINK);
    await mountSignedIn();
    expect(readOtherAccountLink()).toEqual(OTHER_ACCOUNT_LINK);

    await act(async () => auth!.signOut());

    expect(supabaseAuth.signOut).toHaveBeenCalledTimes(1);
    expect(readOtherAccountLink()).toBeNull();
  });

  // Dropped before anything else, so a sign-out that fails partway leaves no link behind.
  it("drops the link even when signing out fails", async () => {
    const failure = new Error("Sign-out failed");
    supabaseAuth.signOut.mockResolvedValueOnce({ error: failure });
    holdOtherAccountLink(OTHER_ACCOUNT_LINK);
    await mountSignedIn();

    await act(async () => {
      await expect(auth!.signOut()).rejects.toBe(failure);
    });

    expect(readOtherAccountLink()).toBeNull();
  });
});
