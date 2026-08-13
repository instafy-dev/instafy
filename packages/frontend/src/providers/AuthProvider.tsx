import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { AuthChangeEvent, Session, User } from "@supabase/supabase-js";
import { Capacitor } from "@capacitor/core";
import { hasSupabaseConfig, supabase, supabaseAnonKey, supabaseUrl } from "../lib/supabaseClient";
import { describeExchangeError, requestPasswordRecovery } from "../auth/pkce";
import {
  clearNativeAuthCallbackAttemptId,
  clearPendingNativeAuthAttempt,
  NATIVE_AUTH_ERROR_EVENT,
  NATIVE_AUTH_SUCCESS_EVENT,
  parseNativeAuthCallbackUrl,
  readPendingNativeAuthAttempt,
  writeNativeAuthCallbackAttemptId,
  writeNativeAuthError,
} from "../auth/nativeAuth";
import {
  consumePendingNativeAuthBridgeUrl,
  listenForNativeAuthBridgeUrl,
} from "../auth/nativeAuthBridge";
import { useWorkspaceStore } from "../store";
import { clearProjectState } from "../workspace/projectClear";
import { ensureNativePushTokenRegistered } from "../notifications/nativePushRegistration";
import { areMessageNotificationsEnabled } from "../notifications/assistantMessageNotifications";
import { ensureWebPushSubscriptionRegistered } from "../notifications/webPushRegistration";
import { postAuthTelemetryEvent } from "../services/runtimeController/authTelemetry";
import {
  isInvalidRefreshTokenError,
  signInWithPasswordRecoveringInvalidRefreshToken,
} from "./authSessionRecovery";

const REQUIRE_AUTH = import.meta.env.VITE_REQUIRE_AUTH !== "false";
const DEV_GUEST_FALLBACK_FLAG_KEY = "instafy.devGuestFallback";
const DEV_GUEST_FALLBACK_USER_ID_KEY = "instafy.devGuestFallbackUserId";
const DEV_GUEST_FALLBACK_EMAIL_KEY = "instafy.devGuestFallbackEmail";
const DEV_GUEST_EMAIL = import.meta.env.VITE_DEV_GUEST_EMAIL;
const DEV_GUEST_PASSWORD = import.meta.env.VITE_DEV_GUEST_PASSWORD;

interface AuthContextValue {
  session: Session | null;
  user: User | null;
  loading: boolean;
  sendEmailOtp: (email: string) => Promise<void>;
  verifyEmailOtp: (email: string, token: string) => Promise<void>;
  signInWithPassword: (email: string, password: string) => Promise<void>;
  signUpWithPassword: (email: string, password: string) => Promise<void>;
  sendPasswordResetEmail: (email: string) => Promise<void>;
  updatePassword: (password: string) => Promise<void>;
  signInAnonymously: () => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

function readLocalStorageValue(key: string): string | null {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeLocalStorageValue(key: string, value: string) {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // ignore storage failures (private browsing, disabled storage, etc.)
  }
}

function removeLocalStorageValue(key: string) {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.removeItem(key);
  } catch {
    // ignore storage failures (private browsing, disabled storage, etc.)
  }
}

function clearDevGuestFallbackState() {
  removeLocalStorageValue(DEV_GUEST_FALLBACK_FLAG_KEY);
  removeLocalStorageValue(DEV_GUEST_FALLBACK_USER_ID_KEY);
  removeLocalStorageValue(DEV_GUEST_FALLBACK_EMAIL_KEY);
}

function isLocalDevHost(): boolean {
  if (!import.meta.env.DEV || typeof window === "undefined") {
    return false;
  }
  const hostname = window.location.hostname.toLowerCase();
  return hostname === "127.0.0.1" || hostname === "localhost";
}

function parseNumericValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return null;
}

function extractExpiresAtFromStoredSession(value: unknown): number | null {
  if (!value) {
    return null;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      const nested = extractExpiresAtFromStoredSession(entry);
      if (nested !== null) {
        return nested;
      }
    }
    return null;
  }
  if (typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  const direct = parseNumericValue(record.expires_at);
  if (direct !== null) {
    return direct;
  }
  if ("currentSession" in record) {
    const nested = extractExpiresAtFromStoredSession(record.currentSession);
    if (nested !== null) {
      return nested;
    }
  }
  if ("session" in record) {
    const nested = extractExpiresAtFromStoredSession(record.session);
    if (nested !== null) {
      return nested;
    }
  }
  return null;
}

function listSupabaseAuthStorageKeys(): string[] {
  if (typeof window === "undefined") {
    return [];
  }
  const keys: string[] = [];
  try {
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index);
      if (!key) {
        continue;
      }
      if (/^sb-.*-auth-token$/.test(key)) {
        keys.push(key);
      }
    }
  } catch {
    return [];
  }
  return keys;
}

function clearExpiredLocalDevSupabaseSessions() {
  if (!isLocalDevHost()) {
    return;
  }
  const nowSeconds = Math.floor(Date.now() / 1000);
  for (const key of listSupabaseAuthStorageKeys()) {
    try {
      const raw = window.localStorage.getItem(key);
      if (!raw) {
        continue;
      }
      const parsed = JSON.parse(raw) as unknown;
      const expiresAt = extractExpiresAtFromStoredSession(parsed);
      if (expiresAt === null) {
        continue;
      }
      // If this access token already expired, skip refresh attempts and drop it up front.
      if (expiresAt <= nowSeconds - 30) {
        window.localStorage.removeItem(key);
      }
    } catch {
      // ignore malformed storage rows
    }
  }
}

function clearSupabaseAuthStorage() {
  for (const key of listSupabaseAuthStorageKeys()) {
    try {
      window.localStorage.removeItem(key);
    } catch {
      // ignore storage failures
    }
  }
}

function resolveDevGuestCredentials(): { email: string; password: string } | null {
  if (!import.meta.env.DEV) {
    return null;
  }
  const explicitEmail = DEV_GUEST_EMAIL?.trim() || "";
  const explicitPassword = DEV_GUEST_PASSWORD?.trim() || "";
  if (explicitEmail && explicitPassword) {
    return { email: explicitEmail, password: explicitPassword };
  }
  if (!isLocalDevHost()) {
    return null;
  }
  return { email: "playwright@instafy.dev", password: "Playwright123!" };
}

function isAnonymousProviderDisabledError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  const normalizedMessage = message.toLowerCase();
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? (error as { code?: unknown }).code
      : undefined;
  const normalizedCode = typeof code === "string" ? code.toLowerCase() : "";
  return (
    normalizedCode === "anonymous_provider_disabled" ||
    (normalizedMessage.includes("anonymous") && normalizedMessage.includes("disabled"))
  );
}

function createFallbackUser(email: string, idOverride?: string | null): User {
  const globalCrypto =
    typeof globalThis !== "undefined" ? (globalThis.crypto as Crypto | undefined) : undefined;
  const uuid =
    typeof idOverride === "string" && idOverride.trim().length > 0
      ? idOverride.trim()
      : typeof globalCrypto?.randomUUID === "function"
      ? globalCrypto.randomUUID()
      : "00000000-0000-4000-8000-000000000000";
  const stableEmail = email.replace(/[^a-z0-9@._+-]/gi, "") || "dev@instafy.local";
  return {
    id: uuid,
    app_metadata: {},
    user_metadata: { email: stableEmail },
    aud: "authenticated",
    created_at: new Date().toISOString(),
    email: stableEmail,
    phone: "",
    confirmed_at: new Date().toISOString(),
    identities: [],
    last_sign_in_at: new Date().toISOString(),
    role: "authenticated",
    factors: []
  } as User;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const baseFallback = !hasSupabaseConfig || !REQUIRE_AUTH;
  const [devGuestFallbackEnabled, setDevGuestFallbackEnabled] = useState(() => {
    if (baseFallback) {
      return false;
    }
    if (!import.meta.env.DEV) {
      return false;
    }
    return readLocalStorageValue(DEV_GUEST_FALLBACK_FLAG_KEY) === "1";
  });
  const shouldUseFallback = baseFallback || devGuestFallbackEnabled;
  const [session, setSession] = useState<Session | null>(null);
  const [user, setUser] = useState<User | null>(() =>
    shouldUseFallback
      ? createFallbackUser(
          readLocalStorageValue(DEV_GUEST_FALLBACK_EMAIL_KEY) ?? "dev@instafy.local",
          readLocalStorageValue(DEV_GUEST_FALLBACK_USER_ID_KEY)
        )
      : null
  );
  const [loading, setLoading] = useState(!shouldUseFallback);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    if (!Capacitor.isNativePlatform()) {
      return;
    }
    if (shouldUseFallback) {
      return;
    }
    if (!hasSupabaseConfig || !supabase?.auth) {
      return;
    }

    let cancelled = false;
    const handled = new Set<string>();
    let inFlight = false;
    let resumeCheckTimeout: number | null = null;

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

    const closeAuthBrowser = async () => {
      try {
        const { Browser } = await import("@capacitor/browser");
        await Browser.close();
      } catch {
        // ignore missing browser plugin / close failures
      }
    };

    const notifyNativeAuthError = (message: string) => {
      try {
        window.dispatchEvent(new CustomEvent(NATIVE_AUTH_ERROR_EVENT, { detail: message }));
      } catch {
        // ignore event dispatch failures
      }
    };

    const notifyNativeAuthSuccess = () => {
      try {
        window.dispatchEvent(new CustomEvent(NATIVE_AUTH_SUCCESS_EVENT));
      } catch {
        // ignore event dispatch failures
      }
    };

    const postNativeAuthTelemetry = (
      kind: string,
      level: "info" | "warning" | "error" = "info",
      message: string | null = null,
      metadata: Record<string, unknown> = {},
    ) => {
      const pendingAttempt = readPendingNativeAuthAttempt();
      void postAuthTelemetryEvent({
        kind,
        level,
        message,
        metadata: {
          provider: pendingAttempt?.provider ?? "github",
          attemptId: pendingAttempt?.attemptId ?? null,
          startedAt: pendingAttempt?.startedAt ?? null,
          platform: pendingAttempt?.platform ?? Capacitor.getPlatform(),
          ...metadata,
        },
      });
    };

    const failNativeAuthAttempt = async (
      kind: string,
      level: "warning" | "error",
      message: string,
      metadata: Record<string, unknown> = {},
    ) => {
      postNativeAuthTelemetry(kind, level, message, metadata);
      clearNativeAuthCallbackAttemptId();
      clearPendingNativeAuthAttempt();
      writeNativeAuthError(message);
      notifyNativeAuthError(message);
      await closeAuthBrowser();
    };

    const completeNativeAuthAttempt = async (
      completionMethod: "exchange_code_for_session" | "set_session",
      nextSession: Session | null,
      nextUser: User | null,
    ) => {
      postNativeAuthTelemetry("auth.login.github.completed", "info", null, {
        completionMethod,
      });
      clearNativeAuthCallbackAttemptId();
      clearPendingNativeAuthAttempt();
      writeNativeAuthError(null);
      setSession(nextSession);
      setUser(nextUser);
      notifyNativeAuthSuccess();
      await closeAuthBrowser();
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

        postNativeAuthTelemetry("auth.login.github.callback_received", "info", null, {
          hasCode: Boolean(code),
          hasAccessToken: Boolean(accessToken),
          hasRefreshToken: Boolean(refreshToken),
          hasError: Boolean(oauthError),
        });

        if (oauthError) {
          await failNativeAuthAttempt("auth.login.github.callback_error", "warning", oauthError, {
            phase: "callback",
          });
          return;
        }

        if (code) {
          let result: Awaited<ReturnType<typeof supabase.auth.exchangeCodeForSession>>;
          try {
            result = await supabase.auth.exchangeCodeForSession(code);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            await failNativeAuthAttempt("auth.login.github.exchange_failed", "error", message, {
              phase: "exchange_code_for_session",
              thrown: true,
            });
            return;
          }
          if (result.error) {
            await failNativeAuthAttempt(
              "auth.login.github.exchange_failed",
              "error",
              describeExchangeError(result.error.message),
              {
                phase: "exchange_code_for_session",
              },
            );
            return;
          }
          await completeNativeAuthAttempt(
            "exchange_code_for_session",
            result.data.session ?? null,
            result.data.user ?? null,
          );
          return;
        }

        if (accessToken && refreshToken) {
          let result: Awaited<ReturnType<typeof supabase.auth.setSession>>;
          try {
            result = await supabase.auth.setSession({
              access_token: accessToken,
              refresh_token: refreshToken,
            });
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            await failNativeAuthAttempt("auth.login.github.session_failed", "error", message, {
              phase: "set_session",
              thrown: true,
            });
            return;
          }
          if (result.error) {
            await failNativeAuthAttempt("auth.login.github.session_failed", "error", result.error.message, {
              phase: "set_session",
            });
            return;
          }
          await completeNativeAuthAttempt("set_session", result.data.session ?? null, result.data.user ?? null);
          return;
        }

        const nextMessage = "GitHub sign-in returned to the app without completing. Try again.";
        await failNativeAuthAttempt("auth.login.github.callback_incomplete", "warning", nextMessage, {
          phase: "callback",
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await failNativeAuthAttempt("auth.login.github.callback_handler_failed", "error", message, {
          phase: "callback_handler",
        });
      } finally {
        inFlight = false;
      }
    };

    let listener: { remove: () => Promise<void> | void } | null = null;
    let resumeListener: { remove: () => Promise<void> | void } | null = null;
    let nativeAuthBridgeListener: { remove: () => Promise<void> | void } | null = null;

    const drainPendingNativeAuthBridgeUrl = async () => {
      const pendingUrl = await consumePendingNativeAuthBridgeUrl();
      if (pendingUrl) {
        await handleCallbackUrl(pendingUrl);
      }
    };

    (async () => {
      try {
        const { App } = await import("@capacitor/app");
        nativeAuthBridgeListener = await listenForNativeAuthBridgeUrl((url) => {
          void handleCallbackUrl(url);
        });
        await drainPendingNativeAuthBridgeUrl();
        const launchUrl = await App.getLaunchUrl();
        if (launchUrl?.url) {
          await handleCallbackUrl(launchUrl.url);
        }
        listener = await App.addListener("appUrlOpen", (event: { url?: string }) => {
          void handleCallbackUrl(event?.url ?? "");
        });
        resumeListener = await App.addListener("resume", () => {
          if (resumeCheckTimeout !== null) {
            window.clearTimeout(resumeCheckTimeout);
          }
          resumeCheckTimeout = window.setTimeout(() => {
            resumeCheckTimeout = null;
            void drainPendingNativeAuthBridgeUrl();
          }, 0);
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn("[auth] unable to install native auth listener:", message);
      }
    })();

    return () => {
      cancelled = true;
      if (resumeCheckTimeout !== null) {
        window.clearTimeout(resumeCheckTimeout);
        resumeCheckTimeout = null;
      }
      if (listener) {
        void listener.remove();
      }
      if (resumeListener) {
        void resumeListener.remove();
      }
      if (nativeAuthBridgeListener) {
        void nativeAuthBridgeListener.remove();
      }
    };
  }, [shouldUseFallback]);

  useEffect(() => {
    if (!user) {
      return;
    }
    if (!areMessageNotificationsEnabled()) {
      return;
    }
    void ensureNativePushTokenRegistered();
    void ensureWebPushSubscriptionRegistered();
  }, [user]);

  useEffect(() => {
    if (loading) {
      return;
    }
    const scope = user?.id?.trim() || "anonymous";
    useWorkspaceStore.getState().setWorkspaceScope(scope);
  }, [loading, user?.id]);

  useEffect(() => {
    if (shouldUseFallback) {
      if (import.meta.env.DEV && devGuestFallbackEnabled) {
        const email = readLocalStorageValue(DEV_GUEST_FALLBACK_EMAIL_KEY) ?? "guest@instafy.local";
        const id = readLocalStorageValue(DEV_GUEST_FALLBACK_USER_ID_KEY);
        setUser((current) => current ?? createFallbackUser(email, id));
      }
      setLoading(false);
      return;
    }
    setLoading(true);
    let cancelled = false;
    let unsubscribe: (() => void) | undefined;

    async function bootstrap() {
      try {
        clearExpiredLocalDevSupabaseSessions();
        const { data: listener } = supabase.auth.onAuthStateChange(
          (_event: AuthChangeEvent, nextSession: Session | null) => {
            if (cancelled) {
              return;
            }
            setSession(nextSession);
            setUser(nextSession?.user ?? null);
          }
        );
        unsubscribe = () => listener.subscription.unsubscribe();

        const { data, error } = await supabase.auth.getSession();
        if (error) {
          if (isInvalidRefreshTokenError(error)) {
            await supabase.auth.signOut({ scope: "local" }).catch(() => {});
            clearSupabaseAuthStorage();
          }
          if (!cancelled) {
            setSession(null);
            setUser(null);
          }
          return;
        }

        if (!cancelled) {
          setSession(data.session);
          setUser(data.session?.user ?? null);
        }
      } catch (error) {
        if (isInvalidRefreshTokenError(error)) {
          await supabase.auth.signOut({ scope: "local" }).catch(() => {});
          clearSupabaseAuthStorage();
        }
        if (!cancelled) {
          setSession(null);
          setUser(null);
        }
        const message = error instanceof Error ? error.message : String(error);
        console.warn("[auth] session bootstrap failed:", message);
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    void bootstrap();
    return () => {
      cancelled = true;
      if (unsubscribe) {
        unsubscribe();
      }
    };
  }, [devGuestFallbackEnabled, shouldUseFallback]);

  const value = useMemo<AuthContextValue>(
    () => ({
      session,
      user,
      loading,
      async sendEmailOtp(email) {
        if (baseFallback) {
          setUser(createFallbackUser(email));
          setSession(null);
          return;
        }
        if (devGuestFallbackEnabled) {
          clearDevGuestFallbackState();
          setDevGuestFallbackEnabled(false);
        }
        const { error } = await supabase.auth.signInWithOtp({
          email,
          options: {
            shouldCreateUser: true
          }
        });
        if (error) {
          throw error;
        }
      },
      async verifyEmailOtp(email, token) {
        if (baseFallback) {
          setUser(createFallbackUser(email));
          setSession(null);
          return;
        }
        if (devGuestFallbackEnabled) {
          clearDevGuestFallbackState();
          setDevGuestFallbackEnabled(false);
        }
        const normalizedToken = token.trim();
        const result = await supabase.auth.verifyOtp({ email, token: normalizedToken, type: "email" });
        if (result.error) {
          const fallback = await supabase.auth.verifyOtp({
            email,
            token: normalizedToken,
            type: "magiclink",
          });
          if (fallback.error) {
            throw result.error;
          }
          setSession(fallback.data.session ?? null);
          setUser(fallback.data.user ?? null);
          return;
        }
        setSession(result.data.session ?? null);
        setUser(result.data.user ?? null);
      },
      async signInWithPassword(email, password) {
        if (baseFallback) {
          setUser(createFallbackUser(email));
          setSession(null);
          return;
        }
        if (devGuestFallbackEnabled) {
          clearDevGuestFallbackState();
          setDevGuestFallbackEnabled(false);
        }
        await signInWithPasswordRecoveringInvalidRefreshToken(
          supabase.auth,
          { email, password },
          { clearAuthStorage: clearSupabaseAuthStorage },
        );
      },
      async signUpWithPassword(email, password) {
        if (baseFallback) {
          setUser(createFallbackUser(email));
          setSession(null);
          return;
        }
        if (devGuestFallbackEnabled) {
          clearDevGuestFallbackState();
          setDevGuestFallbackEnabled(false);
        }
        const { error } = await supabase.auth.signUp({
          email,
          password,
          options: {
            emailRedirectTo:
              typeof window === "undefined" ? undefined : `${window.location.origin}/studio`,
          },
        });
        if (error) {
          throw error;
        }
      },
      async sendPasswordResetEmail(email) {
        if (baseFallback) {
          setUser(createFallbackUser(email));
          setSession(null);
          return;
        }
        if (devGuestFallbackEnabled) {
          clearDevGuestFallbackState();
          setDevGuestFallbackEnabled(false);
        }
        // Deliberately NOT resetPasswordForEmail: under PKCE that mails a
        // ?code= link only exchangeable where the request was made, and email
        // links routinely open in a different browser or device (desktop and
        // mobile shells always hand them to the system browser). The direct
        // recover call carries no code challenge, so the link stays
        // token-shaped and works wherever it is opened. See src/auth/pkce.ts.
        await requestPasswordRecovery({
          supabaseUrl: supabaseUrl!,
          anonKey: supabaseAnonKey!,
          email,
          redirectTo:
            typeof window === "undefined"
              ? undefined
              : `${window.location.origin}/login?mode=recovery`,
        });
      },
      async updatePassword(password) {
        if (baseFallback) {
          return;
        }
        if (devGuestFallbackEnabled) {
          clearDevGuestFallbackState();
          setDevGuestFallbackEnabled(false);
        }
        const { error } = await supabase.auth.updateUser({ password });
        if (error) {
          throw error;
        }
      },
      async signInAnonymously() {
        if (baseFallback) {
          setUser(createFallbackUser("guest@instafy.local"));
          setSession(null);
          return;
        }
        const devGuestCredentials = resolveDevGuestCredentials();
        const tryDevGuestPasswordSignIn = async (): Promise<boolean> => {
          if (!devGuestCredentials) {
            return false;
          }
          let result = await supabase.auth.signInWithPassword({
            email: devGuestCredentials.email,
            password: devGuestCredentials.password,
          });
          if (result.error && isInvalidRefreshTokenError(result.error)) {
            await supabase.auth.signOut({ scope: "local" }).catch(() => {});
            clearSupabaseAuthStorage();
            result = await supabase.auth.signInWithPassword({
              email: devGuestCredentials.email,
              password: devGuestCredentials.password,
            });
          }
          if (result.error) {
            return false;
          }
          clearDevGuestFallbackState();
          setDevGuestFallbackEnabled(false);
          setSession(result.data.session ?? null);
          setUser(result.data.user ?? null);
          return true;
        };

        if (import.meta.env.DEV) {
          const passwordSignInWorked = await tryDevGuestPasswordSignIn();
          if (passwordSignInWorked) {
            return;
          }
        }

        const { data, error } = await supabase.auth.signInAnonymously();
        if (error) {
          const anonymousDisabled = isAnonymousProviderDisabledError(error);
          if (anonymousDisabled && import.meta.env.DEV) {
            // Local auth storage can hold stale refresh state for long-lived browser profiles.
            // Clear it before dev guest fallback to avoid sticky login failures.
            await supabase.auth.signOut({ scope: "local" }).catch(() => {});
            clearSupabaseAuthStorage();
            const passwordSignInWorked = await tryDevGuestPasswordSignIn();
            if (passwordSignInWorked) {
              return;
            }

            const nextEmail = "guest@instafy.local";
            const existingId = readLocalStorageValue(DEV_GUEST_FALLBACK_USER_ID_KEY);
            const id =
              existingId && existingId.trim().length > 0
                ? existingId.trim()
                : typeof crypto?.randomUUID === "function"
                  ? crypto.randomUUID()
                  : "00000000-0000-4000-8000-000000000000";
            writeLocalStorageValue(DEV_GUEST_FALLBACK_FLAG_KEY, "1");
            writeLocalStorageValue(DEV_GUEST_FALLBACK_EMAIL_KEY, nextEmail);
            writeLocalStorageValue(DEV_GUEST_FALLBACK_USER_ID_KEY, id);
            setDevGuestFallbackEnabled(true);
            setUser(createFallbackUser(nextEmail, id));
            setSession(null);
            return;
          }
          throw error;
        }
        clearDevGuestFallbackState();
        setDevGuestFallbackEnabled(false);
        setSession(data?.session ?? null);
        setUser(data?.user ?? null);
      },
      async signOut() {
        if (baseFallback || devGuestFallbackEnabled) {
          clearDevGuestFallbackState();
          setDevGuestFallbackEnabled(false);
          setUser(null);
          setSession(null);
          clearProjectState();
          return;
        }
        const { error } = await supabase.auth.signOut();
        if (error) {
          throw error;
        }
        clearProjectState();
      }
    }),
    [baseFallback, devGuestFallbackEnabled, loading, session, user]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth must be used within AuthProvider");
  }
  return context;
}
