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
  clearNativeAuthCallbackAttemptId,
  clearPendingNativeAuthAttempt,
  createPendingNativeAuthAttempt,
  NATIVE_AUTH_ERROR_EVENT,
  NATIVE_AUTH_SUCCESS_EVENT,
  parseNativeAuthCallbackUrl,
  readNativeAuthCallbackAttemptId,
  readPendingNativeAuthAttempt,
  readNativeAuthError,
  resolveSupabaseRedirectTo,
  type PendingNativeAuthAttempt,
  writeNativeAuthCallbackAttemptId,
  writePendingNativeAuthAttempt,
  writeNativeAuthError,
} from "../../auth/nativeAuth";
import { hasSupabaseConfig, supabase, supabaseAnonKey } from "../../lib/supabaseClient";
import { describeExchangeError } from "../../auth/pkce";
import { postAuthTelemetryEvent } from "../../services/runtimeController/authTelemetry";

export const OAUTH_REDIRECT_TARGET_KEY = "instafy.login.oauthRedirectTarget";

// The OAuth providers the login page offers. Everything downstream of the
// entry function -- pending attempts, deep links, telemetry metadata -- is
// already provider-generic (attempts carry `provider: string`); only the
// entry function and its user-facing strings need to know which provider a
// click meant.
export type LoginOAuthProvider = "github" | "google";

const OAUTH_PROVIDER_LABELS: Record<LoginOAuthProvider, string> = {
  github: "GitHub",
  google: "Google",
};

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
  setMessage: (value: string | null) => void;
  setSubmitting: (value: boolean) => void;
}

/**
 * All GitHub OAuth plumbing for the login screen — web redirect flow plus the
 * Capacitor native flow (custom tabs, deep-link callback handling, resume
 * timeouts, telemetry). Owns no UI: status surfaces through the setters the
 * page passes in, so the page's error/message/submitting state stays shared
 * with the email/OTP flows.
 */
export function useNativeGithubAuth({
  redirectTarget,
  setError,
  setMessage,
  setSubmitting,
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
    ) => {
      const pendingAttempt = readPendingNativeAuthAttempt();
      clearNativeAuthCallbackAttemptId();
      clearPendingNativeAuthAttempt();
      clearNativeAuthLaunchState();
      writeNativeAuthError(nextMessage);
      setMessage(null);
      setError(nextMessage);
      setSubmitting(false);
      postGithubAuthTelemetry(kind, "warning", nextMessage, pendingAttempt, metadata);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const completePendingGithubLoginAttempt = useCallback(
    (
      completionMethod: "exchange_code_for_session" | "set_session",
      nextUserEmail: string | null,
    ) => {
      const pendingAttempt = readPendingNativeAuthAttempt();
      const completedProvider = pendingAttempt?.provider ?? "github";
      postGithubAuthTelemetry(`auth.login.${completedProvider}.completed`, "info", null, pendingAttempt, {
        completionMethod,
        userEmail: nextUserEmail,
        source: "login_page_direct_plugins",
      });
      clearNativeAuthCallbackAttemptId();
      clearPendingNativeAuthAttempt();
      clearNativeAuthLaunchState();
      writeNativeAuthError(null);
      setMessage(null);
      setError(null);
      setSubmitting(false);
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
      const attemptProvider = pendingAttempt.provider ?? "github";
      const attemptLabel =
        OAUTH_PROVIDER_LABELS[attemptProvider as LoginOAuthProvider] ?? "GitHub";
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
    clearPendingNativeAuthAttempt();
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
      setMessage(null);
      setError(message);
      setSubmitting(false);
    };

    const handleSuccess = () => {
      if (nativeAuthBrowserFinishedTimeoutRef.current !== null) {
        window.clearTimeout(nativeAuthBrowserFinishedTimeoutRef.current);
        nativeAuthBrowserFinishedTimeoutRef.current = null;
      }
      clearNativeAuthCallbackAttemptId();
      clearPendingNativeAuthAttempt();
      clearNativeAuthLaunchState();
      setMessage(null);
      setError(null);
      setSubmitting(false);
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
    const handled = new Set<string>();
    let inFlight = false;
    let bridgeListener: DirectPluginListenerHandle | null = null;
    let appUrlListener: DirectPluginListenerHandle | null = null;
    let resumeListener: DirectPluginListenerHandle | null = null;
    let resumeDrainTimeout: number | null = null;

    const extractAuthParam = (
      url: URL,
      hashParams: URLSearchParams,
      key: string,
    ): string | null => {
      const fromSearch = url.searchParams.get(key);
      if (typeof fromSearch === "string" && fromSearch.trim().length > 0) {
        return fromSearch.trim();
      }
      const fromHash = hashParams.get(key);
      if (typeof fromHash === "string" && fromHash.trim().length > 0) {
        return fromHash.trim();
      }
      return null;
    };

    const handleCallbackUrl = async (rawUrl: string) => {
      if (cancelled) {
        return;
      }
      const trimmed = (rawUrl ?? "").trim();
      if (!trimmed || handled.has(trimmed) || inFlight) {
        return;
      }

      const parsed = parseNativeAuthCallbackUrl(trimmed);
      if (!parsed) {
        return;
      }

      const pendingAttempt = readPendingNativeAuthAttempt();
      if (pendingAttempt?.attemptId) {
        writeNativeAuthCallbackAttemptId(pendingAttempt.attemptId);
      }

      inFlight = true;
      handled.add(trimmed);
      try {
        const hash = parsed.hash.startsWith("#") ? parsed.hash.slice(1) : parsed.hash;
        const hashParams = new URLSearchParams(hash);
        const code = extractAuthParam(parsed, hashParams, "code");
        const accessToken = extractAuthParam(parsed, hashParams, "access_token");
        const refreshToken = extractAuthParam(parsed, hashParams, "refresh_token");
        const oauthError =
          extractAuthParam(parsed, hashParams, "error_description") ??
          extractAuthParam(parsed, hashParams, "error") ??
          null;

        postGithubAuthTelemetry("auth.login.github.callback_received", "info", null, pendingAttempt, {
          hasCode: Boolean(code),
          hasAccessToken: Boolean(accessToken),
          hasRefreshToken: Boolean(refreshToken),
          hasError: Boolean(oauthError),
          source: "login_page_direct_plugins",
        });

        if (oauthError) {
          failPendingGithubLoginAttempt("auth.login.github.callback_error", oauthError, {
            phase: "callback",
            source: "login_page_direct_plugins",
          });
          return;
        }

        if (code) {
          const result = await supabase.auth.exchangeCodeForSession(code);
          if (result.error) {
            failPendingGithubLoginAttempt(
              "auth.login.github.exchange_failed",
              describeExchangeError(result.error.message),
              {
                phase: "exchange_code_for_session",
                source: "login_page_direct_plugins",
              },
            );
            return;
          }
          completePendingGithubLoginAttempt(
            "exchange_code_for_session",
            result.data.user?.email ?? result.data.session?.user?.email ?? null,
          );
          return;
        }

        if (accessToken && refreshToken) {
          const result = await supabase.auth.setSession({
            access_token: accessToken,
            refresh_token: refreshToken,
          });
          if (result.error) {
            failPendingGithubLoginAttempt("auth.login.github.session_failed", result.error.message, {
              phase: "set_session",
              source: "login_page_direct_plugins",
            });
            return;
          }
          completePendingGithubLoginAttempt(
            "set_session",
            result.data.session?.user?.email ?? result.data.user?.email ?? null,
          );
          return;
        }

        failPendingGithubLoginAttempt(
          "auth.login.github.callback_incomplete",
          "GitHub sign-in returned to the app without completing. Try again.",
          {
            phase: "callback",
            source: "login_page_direct_plugins",
          },
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failPendingGithubLoginAttempt("auth.login.github.callback_handler_failed", message, {
          phase: "callback_handler",
          source: "login_page_direct_plugins",
        });
      } finally {
        inFlight = false;
      }
    };

    const drainPendingBridgeUrl = async () => {
      const result = await nativeAuthBridgePlugin?.consumePendingUrl?.();
      const pendingUrl = typeof result?.url === "string" ? result.url.trim() : "";
      if (pendingUrl) {
        await handleCallbackUrl(pendingUrl);
      }
    };

    // The desktop shell returns through the same instafy://auth callback, so
    // it reuses handleCallbackUrl verbatim -- the parsing, the PKCE-or-token
    // branch, and the telemetry are identical. Only the transport differs:
    // an Electron IPC message rather than a Capacitor plugin event. Drain
    // first, because the callback can land before this effect runs (the app
    // may have been launched cold by the deep link, or been running with no
    // window at all).
    let desktopUnsubscribe: (() => void) | null = null;
    if (isDesktopShell() && desktopCanReceiveAuthCallback()) {
      desktopUnsubscribe = onDesktopAuthCallback((url) => {
        void handleCallbackUrl(url);
        // The shell parks every callback *and* sends it, so a live delivery
        // leaves a copy behind. Clear it, or the next mount of this page
        // drains a spent token and reports a failure over a good sign-in.
        // handleCallbackUrl has already recorded the URL synchronously, so
        // the drained value is deduplicated rather than replayed.
        void consumeDesktopAuthCallback();
      });
      void consumeDesktopAuthCallback().then((pending) => {
        if (pending) {
          void handleCallbackUrl(pending);
        }
      });
    }

    (async () => {
      if (!nativePluginsAvailable || !appPlugin || !nativeAuthBridgePlugin) {
        return;
      }
      bridgeListener = (await nativeAuthBridgePlugin.addListener?.("urlOpen", (event) => {
        const url = typeof event?.url === "string" ? event.url : "";
        void handleCallbackUrl(url);
      })) ?? null;
      await drainPendingBridgeUrl();
      const launchUrl = await appPlugin.getLaunchUrl?.();
      if (typeof launchUrl?.url === "string" && launchUrl.url.trim().length > 0) {
        await handleCallbackUrl(launchUrl.url);
      }
      appUrlListener = (await appPlugin.addListener?.("appUrlOpen", (event) => {
        const url = typeof event?.url === "string" ? event.url : "";
        void handleCallbackUrl(url);
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
    setError(null);
    setMessage(null);
    setSubmitting(true);
    let nativeAttempt: PendingNativeAuthAttempt | null = null;
    try {
      const redirectTo = resolveSupabaseRedirectTo("/login");
      const queryParams = oauthLoginQueryParams(supabaseAnonKey);
      if (redirectTarget.startsWith("/") && !redirectTarget.startsWith("//")) {
        try {
          window.sessionStorage?.setItem(OAUTH_REDIRECT_TARGET_KEY, redirectTarget);
        } catch {
          // ignore session storage failures
        }
      }
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
        setSubmitting(false);
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
        await openDesktopExternalUrl(url);
        setMessage(`Finish signing in with ${providerLabel} in your browser…`);
        setSubmitting(false);
        return;
      }

      const result = await supabase.auth.signInWithOAuth({
        provider,
        options: { redirectTo, queryParams },
      });
      if (result.error) {
        throw result.error;
      }
      setMessage(`Redirecting to ${providerLabel}…`);
    } catch (err) {
      const details = err instanceof Error ? err.message : `Unable to continue with ${providerLabel}.`;
      if (nativeAttempt) {
        clearNativeAuthCallbackAttemptId();
        clearPendingNativeAuthAttempt();
        clearNativeAuthLaunchState();
        postGithubAuthTelemetry(`auth.login.${provider}.start_failed`, "error", details, nativeAttempt);
      }
      setError(details);
      setSubmitting(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [redirectTarget, resetNativeAuthState]);

  const handleGithubLogin = useCallback(() => handleOAuthLogin("github"), [handleOAuthLogin]);
  const handleGoogleLogin = useCallback(() => handleOAuthLogin("google"), [handleOAuthLogin]);

  return { handleGithubLogin, handleGoogleLogin, resetNativeAuthState };
}
