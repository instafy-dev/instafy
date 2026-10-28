import { useCallback, useEffect, useRef } from "react";
import {
  consumeDesktopAuthCallback,
  desktopCanReceiveAuthCallback,
  isDesktopShell,
  onDesktopAuthCallback,
  openDesktopExternalUrl,
} from "../../lib/desktopShell";
import { Capacitor } from "@capacitor/core";
import {
  claimNativeAuthCallback,
  clearNativeAuthCallbackAttemptId,
  clearPendingNativeAuthAttempt,
  createPendingNativeAuthAttempt,
  isNativeAuthCallbackClaimed,
  isTokenPairNativeAuthCallback,
  NATIVE_AUTH_ERROR_EVENT,
  NATIVE_AUTH_PROVIDER_LABELS,
  NATIVE_AUTH_SUCCESS_EVENT,
  nativeAuthAttemptProvider,
  nativeAuthCallbackErrorMessage,
  type NativeAuthProvider,
  parseNativeAuthCallbackUrl,
  readNativeAuthCallbackAttemptId,
  readNativeAuthCallbackParams,
  readPendingNativeAuthAttempt,
  readNativeAuthError,
  releaseNativeAuthCallbackUrlClaims,
  resolveSupabaseRedirectTo,
  type PendingNativeAuthAttempt,
  writeNativeAuthCallbackAttemptId,
  writeSignInReturnPath,
  writePendingNativeAuthAttempt,
  writeNativeAuthError,
} from "../../auth/nativeAuth";
import { hasSupabaseConfig, supabase, supabaseAnonKey } from "../../lib/supabaseClient";
import { describeExchangeError } from "../../auth/pkce";
import { postAuthTelemetryEvent } from "../../services/runtimeController/authTelemetry";

// How many desktop callbacks wait while another is being exchanged.
const MAX_WAITING_DESKTOP_CALLBACKS = 3;

// The OAuth providers the login page offers. Everything downstream of the
// entry function -- pending attempts, deep links, telemetry metadata -- is
// already provider-generic (attempts carry `provider: string`); only the
// entry function and its user-facing strings need to know which provider a
// click meant.
export type LoginOAuthProvider = NativeAuthProvider;

export const OAUTH_PROVIDER_LABELS: Record<LoginOAuthProvider, string> = NATIVE_AUTH_PROVIDER_LABELS;

/**
 * The query the auth server forwards to the provider. `prompt=select_account`
 * asks GitHub and Google for their account picker: without it the provider
 * silently uses whichever account the browser is signed into, so choosing a
 * remembered account (or meaning a different one) landed on an authorize
 * screen for the wrong account with no way to switch from there. The auth
 * server passes it through unchanged (checked against production).
 */
export function oauthLoginQueryParams(anonKey: string | null | undefined): Record<string, string> {
  return anonKey ? { apikey: anonKey, prompt: "select_account" } : { prompt: "select_account" };
}

interface UseNativeGithubAuthOptions {
  redirectTarget: string;
  setError: (value: string | null) => void;
  /** The provider whose button shows the pending spinner, or null. */
  setPendingProvider: (value: LoginOAuthProvider | null) => void;
  /** The provider the desktop shell handed off to the system browser, or null. */
  setAwaitingBrowser: (value: LoginOAuthProvider | null) => void;
}

/**
 * All GitHub OAuth plumbing for the login screen: web redirect flow plus the
 * Capacitor native flow (custom tabs, deep-link callback handling, resume
 * timeouts, telemetry). Owns no UI: status surfaces through the setters the
 * page passes in (pending provider, desktop browser wait, error), so the page
 * keeps one pending control shared with the email/OTP flows.
 */
export function useNativeGithubAuth({
  redirectTarget,
  setError,
  setPendingProvider,
  setAwaitingBrowser,
}: UseNativeGithubAuthOptions) {
  const nativeAuthBrowserListenerRef = useRef<{ remove: () => Promise<void> | void } | null>(null);
  const nativeAuthBrowserFinishedTimeoutRef = useRef<number | null>(null);
  const nativeAuthResumeListenerRef = useRef<{ remove: () => Promise<void> | void } | null>(null);

  const postGithubAuthTelemetry = (
    kind: string,
    level: "info" | "warning" | "error",
    message: string | null,
    attempt: PendingNativeAuthAttempt | null,
    metadata: Record<string, unknown> = {},
  ) => {
    void postAuthTelemetryEvent({
      kind,
      level,
      message,
      metadata: {
        provider: attempt?.provider ?? "github",
        attemptId: attempt?.attemptId ?? null,
        startedAt: attempt?.startedAt ?? null,
        platform: attempt?.platform ?? Capacitor.getPlatform(),
        ...metadata,
      },
    });
  };

  const clearNativeAuthLaunchState = () => {
    if (nativeAuthBrowserFinishedTimeoutRef.current !== null) {
      window.clearTimeout(nativeAuthBrowserFinishedTimeoutRef.current);
      nativeAuthBrowserFinishedTimeoutRef.current = null;
    }
    void nativeAuthBrowserListenerRef.current?.remove?.();
    nativeAuthBrowserListenerRef.current = null;
    void nativeAuthResumeListenerRef.current?.remove?.();
    nativeAuthResumeListenerRef.current = null;
  };

  /** Clears every pending-native-attempt marker; part of the page's transient-state reset. */
  const resetNativeAuthState = useCallback(() => {
    if (nativeAuthBrowserFinishedTimeoutRef.current !== null) {
      window.clearTimeout(nativeAuthBrowserFinishedTimeoutRef.current);
      nativeAuthBrowserFinishedTimeoutRef.current = null;
    }
    clearNativeAuthCallbackAttemptId();
    clearPendingNativeAuthAttempt();
    void nativeAuthBrowserListenerRef.current?.remove?.();
    nativeAuthBrowserListenerRef.current = null;
    void nativeAuthResumeListenerRef.current?.remove?.();
    nativeAuthResumeListenerRef.current = null;
  }, []);

  const failPendingGithubLoginAttempt = useCallback(
    (
      kind: string,
      nextMessage: string,
      metadata: Record<string, unknown> = {},
      telemetryMessage: string = nextMessage,
      { keepPendingAttempt = false }: { keepPendingAttempt?: boolean } = {},
    ) => {
      const pendingAttempt = readPendingNativeAuthAttempt();
      clearNativeAuthCallbackAttemptId();
      if (!keepPendingAttempt) {
        clearPendingNativeAuthAttempt();
      }
      clearNativeAuthLaunchState();
      // This page shows the error now; a stored copy would show it again on the
      // next visit to the login page, after any later sign-in.
      writeNativeAuthError(null);
      setAwaitingBrowser(null);
      setError(nextMessage);
      setPendingProvider(null);
      postGithubAuthTelemetry(kind, "warning", telemetryMessage, pendingAttempt, metadata);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const completePendingGithubLoginAttempt = useCallback(
    (
      completionMethod: "exchange_code_for_session",
      nextUserEmail: string | null,
    ) => {
      const pendingAttempt = readPendingNativeAuthAttempt();
      const completedProvider = nativeAuthAttemptProvider(pendingAttempt);
      postGithubAuthTelemetry(`auth.login.${completedProvider}.completed`, "info", null, pendingAttempt, {
        completionMethod,
        userEmail: nextUserEmail,
        source: "login_page_direct_plugins",
      });
      clearNativeAuthCallbackAttemptId();
      clearPendingNativeAuthAttempt();
      clearNativeAuthLaunchState();
      writeNativeAuthError(null);
      setAwaitingBrowser(null);
      setError(null);
      setPendingProvider(null);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const scheduleNativeAuthCompletionCheck = (
    expectedAttemptId: string,
    source: "app_resume" | "browser_finished",
  ) => {
    if (nativeAuthBrowserFinishedTimeoutRef.current !== null) {
      window.clearTimeout(nativeAuthBrowserFinishedTimeoutRef.current);
    }
    nativeAuthBrowserFinishedTimeoutRef.current = window.setTimeout(() => {
      nativeAuthBrowserFinishedTimeoutRef.current = null;
      const pendingAttempt = readPendingNativeAuthAttempt();
      if (!pendingAttempt || pendingAttempt.attemptId !== expectedAttemptId) {
        return;
      }
      if (readNativeAuthCallbackAttemptId() === expectedAttemptId) {
        return;
      }
      const attemptProvider = nativeAuthAttemptProvider(pendingAttempt);
      const attemptLabel = OAUTH_PROVIDER_LABELS[attemptProvider];
      failPendingGithubLoginAttempt(
        `auth.login.${attemptProvider}.browser_finished_without_completion`,
        `${attemptLabel} sign-in did not complete. Try again.`,
        { source },
      );
    }, 1500);
  };

  const installAndroidNativeAuthResumeListener = async (expectedAttemptId: string) => {
    try {
      const { App } = await import("@capacitor/app");
      nativeAuthResumeListenerRef.current = await App.addListener("resume", () => {
        scheduleNativeAuthCompletionCheck(expectedAttemptId, "app_resume");
      });
    } catch {
      // ignore missing app plugin / listener failures
    }
  };

  // Surface a native auth error persisted by a previous launch.
  useEffect(() => {
    const nativeAuthError = readNativeAuthError();
    if (!nativeAuthError) {
      return;
    }
    clearNativeAuthCallbackAttemptId();
    // This page keeps no copy of a failure it shows, so a stored one now
    // comes from the app-wide native handler or was left by an older build.
    // On desktop it must still not end a sign-in that is pending: the code
    // that sign-in is waiting for can still arrive.
    if (!isDesktopShell()) {
      clearPendingNativeAuthAttempt();
    }
    writeNativeAuthError(null);
    setError(nativeAuthError);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    if (!Capacitor.isNativePlatform()) {
      return;
    }

    const handleError = (event: Event) => {
      const message = (event as CustomEvent<string>).detail;
      if (typeof message !== "string" || message.trim().length === 0) {
        return;
      }
      if (nativeAuthBrowserFinishedTimeoutRef.current !== null) {
        window.clearTimeout(nativeAuthBrowserFinishedTimeoutRef.current);
        nativeAuthBrowserFinishedTimeoutRef.current = null;
      }
      clearNativeAuthCallbackAttemptId();
      clearPendingNativeAuthAttempt();
      clearNativeAuthLaunchState();
      // AuthProvider stores the error for a login page that is not open; this
      // one is, and shows it now.
      writeNativeAuthError(null);
      setAwaitingBrowser(null);
      setError(message);
      setPendingProvider(null);
    };

    const handleSuccess = () => {
      if (nativeAuthBrowserFinishedTimeoutRef.current !== null) {
        window.clearTimeout(nativeAuthBrowserFinishedTimeoutRef.current);
        nativeAuthBrowserFinishedTimeoutRef.current = null;
      }
      clearNativeAuthCallbackAttemptId();
      clearPendingNativeAuthAttempt();
      clearNativeAuthLaunchState();
      setAwaitingBrowser(null);
      setError(null);
      setPendingProvider(null);
    };

    window.addEventListener(NATIVE_AUTH_ERROR_EVENT, handleError);
    window.addEventListener(NATIVE_AUTH_SUCCESS_EVENT, handleSuccess);

    return () => {
      window.removeEventListener(NATIVE_AUTH_ERROR_EVENT, handleError);
      window.removeEventListener(NATIVE_AUTH_SUCCESS_EVENT, handleSuccess);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    return () => {
      if (nativeAuthBrowserFinishedTimeoutRef.current !== null) {
        window.clearTimeout(nativeAuthBrowserFinishedTimeoutRef.current);
        nativeAuthBrowserFinishedTimeoutRef.current = null;
      }
      void nativeAuthBrowserListenerRef.current?.remove?.();
      nativeAuthBrowserListenerRef.current = null;
      void nativeAuthResumeListenerRef.current?.remove?.();
      nativeAuthResumeListenerRef.current = null;
    };
  }, []);

  // Direct-plugin callback handling: consume deep-link/launch URLs delivered
  // while the OAuth custom tab was in the foreground.
  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    // The desktop shell is a *web* platform as far as Capacitor is concerned,
    // so this effect must not bail on it: it also owns the Electron IPC
    // transport for the shared instafy://auth callback.
    const desktopCallbackAvailable = isDesktopShell() && desktopCanReceiveAuthCallback();
    if (!Capacitor.isNativePlatform() && !desktopCallbackAvailable) {
      return;
    }
    if (!hasSupabaseConfig || !supabase?.auth) {
      return;
    }

    type DirectPluginListenerHandle = { remove?: () => Promise<void> | void };
    type DirectAppPlugin = {
      addListener?: (
        eventName: "appUrlOpen" | "resume",
        listenerFunc: (event?: { url?: string | null }) => void,
      ) => Promise<DirectPluginListenerHandle> | DirectPluginListenerHandle;
      getLaunchUrl?: () => Promise<{ url?: string | null } | null>;
    };
    type DirectNativeAuthBridgePlugin = {
      addListener?: (
        eventName: "urlOpen",
        listenerFunc: (event?: { url?: string | null }) => void,
      ) => Promise<DirectPluginListenerHandle> | DirectPluginListenerHandle;
      consumePendingUrl?: () => Promise<{ url?: string | null } | null>;
    };

    const capacitorPlugins = (window as typeof window & {
      Capacitor?: {
        Plugins?: {
          App?: DirectAppPlugin;
          InstafyAuthBridge?: DirectNativeAuthBridgePlugin;
        };
      };
    }).Capacitor?.Plugins;

    const appPlugin = capacitorPlugins?.App;
    const nativeAuthBridgePlugin = capacitorPlugins?.InstafyAuthBridge;
    // Deliberately NOT an early return. The Capacitor plugins are absent under
    // Electron, and returning here made the desktop wiring below unreachable:
    // the shell parked the OAuth callback correctly and nothing ever came to
    // collect it, leaving sign-in stuck on "finish in your browser". The guard
    // now scopes only the native listeners that actually need those plugins.
    const nativePluginsAvailable = Boolean(appPlugin && nativeAuthBridgePlugin);

    let cancelled = false;
    let inFlight = false;
    // Desktop callbacks that arrived while another was being exchanged. The
    // shell hands each callback over once, so one dropped here is lost.
    const waitingDesktopCallbacks: string[] = [];
    let bridgeListener: DirectPluginListenerHandle | null = null;
    let appUrlListener: DirectPluginListenerHandle | null = null;
    let resumeListener: DirectPluginListenerHandle | null = null;
    let resumeDrainTimeout: number | null = null;

    const handleCallbackUrl = async (rawUrl: string, transport: "desktop" | "native") => {
      if (cancelled) {
        return;
      }
      const trimmed = (rawUrl ?? "").trim();
      if (!trimmed || (inFlight && transport === "native")) {
        return;
      }

      const parsed = parseNativeAuthCallbackUrl(trimmed);
      if (!parsed) {
        return;
      }
      const { code, accessToken, refreshToken, oauthError } = readNativeAuthCallbackParams(parsed);
      // Session tokens instead of a code: see isTokenPairNativeAuthCallback.
      // Checked before the claim, so neither this handler nor AuthProvider's
      // acts on it.
      if (isTokenPairNativeAuthCallback({ code, accessToken, refreshToken, oauthError })) {
        return;
      }

      const pendingAttempt = readPendingNativeAuthAttempt();
      // Any page or app can open instafy://auth. So on desktop a callback is
      // acted on only while a sign-in this app started is pending, and only
      // when it is what that sign-in returns: a PKCE code, which only this
      // app's verifier can exchange, or the provider's refusal. A callback
      // with no sign-in pending would let whoever opened the link sign this
      // app in or out. It is dropped unclaimed and without a message, since
      // its contents are the sender's.
      if (transport === "desktop" && (!pendingAttempt || (!code && !oauthError))) {
        return;
      }
      if (inFlight) {
        // A desktop callback: keep it until the exchange in progress settles.
        // Bounded, and the newest kept, since the person's own code is the
        // one that arrives last.
        if (!isNativeAuthCallbackClaimed(parsed) && !waitingDesktopCallbacks.includes(trimmed)) {
          waitingDesktopCallbacks.push(trimmed);
          if (waitingDesktopCallbacks.length > MAX_WAITING_DESKTOP_CALLBACKS) {
            waitingDesktopCallbacks.shift();
          }
        }
        return;
      }
      if (!claimNativeAuthCallback(parsed)) {
        return;
      }
      if (pendingAttempt?.attemptId) {
        writeNativeAuthCallbackAttemptId(pendingAttempt.attemptId);
      }
      const provider = nativeAuthAttemptProvider(pendingAttempt);
      const kind = (event: string) => `auth.login.${provider}.${event}`;
      // On desktop a failed callback shows its error but leaves the sign-in
      // pending, also across a reload of this page: the refusal or the code
      // that would not exchange may come from another browser tab, or from
      // whoever opened the link, and the code this sign-in is waiting for can
      // still follow. The attempt ends on success, when a sign-in starts or
      // the page resets for another way of signing in, or 30 minutes after
      // it started.
      const failureOptions = { keepPendingAttempt: transport === "desktop" };

      inFlight = true;
      try {
        postGithubAuthTelemetry(kind("callback_received"), "info", null, pendingAttempt, {
          hasCode: Boolean(code),
          hasAccessToken: Boolean(accessToken),
          hasRefreshToken: Boolean(refreshToken),
          hasError: Boolean(oauthError),
          source: "login_page_direct_plugins",
        });

        if (oauthError) {
          failPendingGithubLoginAttempt(
            kind("callback_error"),
            nativeAuthCallbackErrorMessage(provider),
            {
              phase: "callback",
              source: "login_page_direct_plugins",
            },
            oauthError,
            failureOptions,
          );
          return;
        }

        if (code) {
          const result = await supabase.auth.exchangeCodeForSession(code);
          if (result.error) {
            failPendingGithubLoginAttempt(
              kind("exchange_failed"),
              describeExchangeError(result.error.message),
              {
                phase: "exchange_code_for_session",
                source: "login_page_direct_plugins",
              },
              undefined,
              failureOptions,
            );
            return;
          }
          completePendingGithubLoginAttempt(
            "exchange_code_for_session",
            result.data.user?.email ?? result.data.session?.user?.email ?? null,
          );
          return;
        }

        failPendingGithubLoginAttempt(
          kind("callback_incomplete"),
          `${OAUTH_PROVIDER_LABELS[provider]} sign-in returned to the app without completing. Try again.`,
          {
            phase: "callback",
            source: "login_page_direct_plugins",
          },
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failPendingGithubLoginAttempt(
          kind("callback_handler_failed"),
          message,
          {
            phase: "callback_handler",
            source: "login_page_direct_plugins",
          },
          undefined,
          failureOptions,
        );
      } finally {
        inFlight = false;
        // Each waiting callback takes the full path again: after a sign-in
        // completes, the gate drops the rest, since no attempt is pending.
        while (!inFlight && !cancelled && waitingDesktopCallbacks.length > 0) {
          const next = waitingDesktopCallbacks.shift();
          if (next) {
            void handleCallbackUrl(next, "desktop");
          }
        }
      }
    };

    const drainPendingBridgeUrl = async () => {
      const result = await nativeAuthBridgePlugin?.consumePendingUrl?.();
      const pendingUrl = typeof result?.url === "string" ? result.url.trim() : "";
      if (pendingUrl) {
        await handleCallbackUrl(pendingUrl, "native");
      }
    };

    // The desktop shell returns through the same instafy://auth callback, so
    // it reuses handleCallbackUrl -- the parsing and the telemetry are
    // identical. The transport differs (an Electron IPC message rather than a
    // Capacitor plugin event), and desktop accepts less: only a code or a
    // refusal, and only for a sign-in this app started. Drain first, because
    // the callback can land before this effect runs (the app may have been
    // launched cold by the deep link, or been running with no window at all).
    let desktopUnsubscribe: (() => void) | null = null;
    if (isDesktopShell() && desktopCanReceiveAuthCallback()) {
      desktopUnsubscribe = onDesktopAuthCallback((url) => {
        void handleCallbackUrl(url, "desktop");
        // The shell parks every callback *and* sends it, so a live delivery
        // leaves a copy behind. Clear it, or the next mount of this page
        // drains a spent token and reports a failure over a good sign-in.
        // The drained copy is discarded: handleCallbackUrl has already acted
        // on this callback, kept it until the exchange in progress settles,
        // or dropped it unclaimed.
        void consumeDesktopAuthCallback();
      });
      void consumeDesktopAuthCallback().then((pending) => {
        if (pending) {
          void handleCallbackUrl(pending, "desktop");
        }
      });
    }

    (async () => {
      if (!nativePluginsAvailable || !appPlugin || !nativeAuthBridgePlugin) {
        return;
      }
      bridgeListener = (await nativeAuthBridgePlugin.addListener?.("urlOpen", (event) => {
        const url = typeof event?.url === "string" ? event.url : "";
        void handleCallbackUrl(url, "native");
      })) ?? null;
      await drainPendingBridgeUrl();
      const launchUrl = await appPlugin.getLaunchUrl?.();
      if (typeof launchUrl?.url === "string" && launchUrl.url.trim().length > 0) {
        await handleCallbackUrl(launchUrl.url, "native");
      }
      appUrlListener = (await appPlugin.addListener?.("appUrlOpen", (event) => {
        const url = typeof event?.url === "string" ? event.url : "";
        void handleCallbackUrl(url, "native");
      })) ?? null;
      resumeListener = (await appPlugin.addListener?.("resume", () => {
        if (resumeDrainTimeout !== null) {
          window.clearTimeout(resumeDrainTimeout);
        }
        resumeDrainTimeout = window.setTimeout(() => {
          resumeDrainTimeout = null;
          void drainPendingBridgeUrl();
        }, 0);
      })) ?? null;
    })().catch(() => {
      // ignore installation failures; the provider-level listener remains a fallback
    });

    return () => {
      cancelled = true;
      if (resumeDrainTimeout !== null) {
        window.clearTimeout(resumeDrainTimeout);
      }
      desktopUnsubscribe?.();
      void bridgeListener?.remove?.();
      void appUrlListener?.remove?.();
      void resumeListener?.remove?.();
    };
  }, [completePendingGithubLoginAttempt, failPendingGithubLoginAttempt]);

  // A web sign-in keeps its button pending until the page unloads. Coming back
  // with the browser's Back button can restore that page from the back/forward
  // cache, spinner and all, so release the pending control when that happens.
  useEffect(() => {
    const handlePageShow = (event: PageTransitionEvent) => {
      if (event.persisted) {
        setPendingProvider(null);
      }
    };
    window.addEventListener("pageshow", handlePageShow);
    return () => window.removeEventListener("pageshow", handlePageShow);
  }, [setPendingProvider]);

  const handleOAuthLogin = useCallback(async (provider: LoginOAuthProvider) => {
    const providerLabel = OAUTH_PROVIDER_LABELS[provider];
    if (typeof window === "undefined") {
      return;
    }
    if (!hasSupabaseConfig || !supabase?.auth || typeof supabase.auth.signInWithOAuth !== "function") {
      setError(`${providerLabel} login is not available.`);
      return;
    }
    resetNativeAuthState();
    // A new sign-in supersedes a stored failure, so a remount of this page
    // before the callback returns does not show it again.
    writeNativeAuthError(null);
    releaseNativeAuthCallbackUrlClaims();
    setError(null);
    setAwaitingBrowser(null);
    setPendingProvider(provider);
    let nativeAttempt: PendingNativeAuthAttempt | null = null;
    try {
      const redirectTo = resolveSupabaseRedirectTo("/login");
      const queryParams = oauthLoginQueryParams(supabaseAnonKey);
      writeSignInReturnPath(redirectTarget, {
        durable: Capacitor.isNativePlatform() || (isDesktopShell() && desktopCanReceiveAuthCallback()),
      });
      if (Capacitor.isNativePlatform()) {
        const nativePlatform = Capacitor.getPlatform();
        nativeAttempt = createPendingNativeAuthAttempt(provider);
        const result = await supabase.auth.signInWithOAuth({
          provider,
          options: { redirectTo, queryParams, skipBrowserRedirect: true },
        });
        if (result.error) {
          throw result.error;
        }
        const url = result.data?.url;
        if (!url) {
          throw new Error(`Unable to start ${providerLabel} login.`);
        }
        writePendingNativeAuthAttempt(nativeAttempt);
        postGithubAuthTelemetry(`auth.login.${provider}.started`, "info", null, nativeAttempt, {
          launchMode: nativePlatform === "android" ? "custom_tab" : "custom_tab",
        });
        if (nativePlatform === "android") {
          await installAndroidNativeAuthResumeListener(nativeAttempt.attemptId);
        }
        const { Browser } = await import("@capacitor/browser");
        await Browser.close().catch(() => undefined);
        try {
          nativeAuthBrowserListenerRef.current = await Browser.addListener("browserFinished", () => {
            if (!nativeAttempt?.attemptId) {
              return;
            }
            scheduleNativeAuthCompletionCheck(nativeAttempt.attemptId, "browser_finished");
          });
        } catch {
          // ignore browsers that do not support browserFinished
        }
        await Browser.open({ url });
        setPendingProvider(null);
        return;
      }

      // The desktop shell is neither Capacitor-native nor a browser tab, and
      // it had no branch here at all: it fell through to the web path, whose
      // in-window navigation the shell's will-navigate guard then bounced to
      // the system browser. Sign-in therefore completed in the browser and the
      // app never saw it. Open the provider deliberately instead, and let the
      // instafy://auth deep link bring the session back.
      if (isDesktopShell() && desktopCanReceiveAuthCallback()) {
        const desktopResult = await supabase.auth.signInWithOAuth({
          provider,
          options: { redirectTo, queryParams, skipBrowserRedirect: true },
        });
        if (desktopResult.error) {
          throw desktopResult.error;
        }
        const url = desktopResult.data?.url;
        if (!url) {
          throw new Error(`Unable to start ${providerLabel} login.`);
        }
        // The callback returns through the handler above, which names its
        // provider from the attempt; with none, Google was reported as GitHub.
        nativeAttempt = createPendingNativeAuthAttempt(provider);
        writePendingNativeAuthAttempt(nativeAttempt);
        await openDesktopExternalUrl(url);
        setAwaitingBrowser(provider);
        setPendingProvider(null);
        return;
      }

      const result = await supabase.auth.signInWithOAuth({
        provider,
        options: { redirectTo, queryParams },
      });
      if (result.error) {
        throw result.error;
      }
    } catch (err) {
      const details = err instanceof Error ? err.message : `Unable to continue with ${providerLabel}.`;
      if (nativeAttempt) {
        clearNativeAuthCallbackAttemptId();
        clearPendingNativeAuthAttempt();
        clearNativeAuthLaunchState();
        postGithubAuthTelemetry(`auth.login.${provider}.start_failed`, "error", details, nativeAttempt);
      }
      setError(details);
      setPendingProvider(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [redirectTarget, resetNativeAuthState]);

  const handleGithubLogin = useCallback(() => handleOAuthLogin("github"), [handleOAuthLogin]);
  const handleGoogleLogin = useCallback(() => handleOAuthLogin("google"), [handleOAuthLogin]);

  return { handleGithubLogin, handleGoogleLogin, resetNativeAuthState };
}
