import { Capacitor } from "@capacitor/core";

import { desktopCanReceiveAuthCallback, isDesktopShell } from "../lib/desktopShell";

export const NATIVE_AUTH_CALLBACK_URL = "instafy://auth";
export const NATIVE_AUTH_CALLBACK_SCHEME = "instafy";
export const NATIVE_AUTH_CALLBACK_HOST = "auth";
export const NATIVE_AUTH_LEGACY_CALLBACK_SCHEME = "dev.instafy.studio";

export const NATIVE_AUTH_ERROR_STORAGE_KEY = "instafy.login.nativeAuthError";
export const NATIVE_AUTH_ATTEMPT_STORAGE_KEY = "instafy.login.nativeAuthAttempt";
export const NATIVE_AUTH_CALLBACK_ATTEMPT_STORAGE_KEY = "instafy.login.nativeAuthCallbackAttempt";
export const NATIVE_AUTH_ERROR_EVENT = "instafy.nativeAuthError";
export const NATIVE_AUTH_SUCCESS_EVENT = "instafy.nativeAuthSuccess";

export interface PendingNativeAuthAttempt {
  attemptId: string;
  provider: string;
  startedAt: string;
  platform: string;
}

/** The OAuth providers the login screen offers. */
export type NativeAuthProvider = "github" | "google";

export const NATIVE_AUTH_PROVIDER_LABELS: Record<NativeAuthProvider, string> = {
  github: "GitHub",
  google: "Google",
};

/**
 * The provider a callback belongs to, read from the attempt that opened the
 * browser, so its telemetry kind and its message name that provider. With no
 * attempt (or one naming an unknown provider) it is GitHub, the only provider
 * native sign-in offered before Google.
 */
export function nativeAuthAttemptProvider(
  attempt: Pick<PendingNativeAuthAttempt, "provider"> | null,
): NativeAuthProvider {
  return attempt?.provider === "google" ? "google" : "github";
}

/**
 * What sign-in says when the callback reports a provider error. The callback
 * is a deep link that any app can open, so the screen and the stored error
 * never repeat the URL's error text; only telemetry records it.
 */
export function nativeAuthCallbackErrorMessage(provider: NativeAuthProvider): string {
  return `${NATIVE_AUTH_PROVIDER_LABELS[provider]} sign-in was cancelled or refused. Try again.`;
}

function normalizeCallbackPathname(pathname: string): string {
  const trimmed = pathname.trim();
  if (!trimmed) {
    return "/";
  }
  const withoutTrailing = trimmed.replace(/\/+$/g, "");
  if (!withoutTrailing) {
    return "/";
  }
  const withLeadingSlash = withoutTrailing.startsWith("/") ? withoutTrailing : `/${withoutTrailing}`;
  return withLeadingSlash.replace(/^\/+/, "/");
}

function isSupportedNativeAuthScheme(rawScheme: string): boolean {
  return (
    rawScheme === NATIVE_AUTH_CALLBACK_SCHEME ||
    rawScheme === NATIVE_AUTH_LEGACY_CALLBACK_SCHEME
  );
}

const claimedNativeAuthCallbacks = new Set<string>();

/**
 * Claims a parsed callback for the one handler that acts on it. The app-wide
 * handler (AuthProvider) and the login page's handler both listen for
 * instafy://auth, and on Android both receive the same deep link. Each used to
 * keep its own record of handled URLs, so both exchanged the code: the first
 * signed in, the second found the code spent and reported a failure over the
 * good sign-in. Claim synchronously, before any await, and act only on true.
 *
 * A code is keyed by itself, since it can be exchanged once, so a remounted
 * login page replaying the launch URL cannot spend it again. Any other
 * callback is keyed by its URL until the next sign-in starts: a refusal
 * carries nothing unique to its attempt, so a second refusal of a later
 * attempt would otherwise be dropped.
 */
export function claimNativeAuthCallback(callbackUrl: URL): boolean {
  const hashParams = new URLSearchParams(callbackUrl.hash.replace(/^#/, ""));
  const code = (callbackUrl.searchParams.get("code") ?? hashParams.get("code") ?? "").trim();
  const key = code ? `code:${code}` : `url:${callbackUrl.href}`;
  if (claimedNativeAuthCallbacks.has(key)) {
    return false;
  }
  claimedNativeAuthCallbacks.add(key);
  return true;
}

/** Called when a sign-in starts, so its callback can repeat the last one's URL. */
export function releaseNativeAuthCallbackUrlClaims(): void {
  for (const key of claimedNativeAuthCallbacks) {
    if (key.startsWith("url:")) {
      claimedNativeAuthCallbacks.delete(key);
    }
  }
}

export function forgetNativeAuthCallbackClaimsForTests(): void {
  claimedNativeAuthCallbacks.clear();
}

export function parseNativeAuthCallbackUrl(rawUrl: string): URL | null {
  const trimmed = rawUrl.trim();
  if (!trimmed) {
    return null;
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }

  const scheme = parsed.protocol.replace(/:$/, "").toLowerCase();
  if (!isSupportedNativeAuthScheme(scheme)) {
    return null;
  }

  const host = parsed.hostname.toLowerCase();
  const pathname = normalizeCallbackPathname(parsed.pathname);
  if (host !== NATIVE_AUTH_CALLBACK_HOST && pathname !== `/${NATIVE_AUTH_CALLBACK_HOST}`) {
    return null;
  }

  return parsed;
}

export function resolveSupabaseRedirectTo(webPath: string): string | undefined {
  if (typeof window === "undefined") {
    return undefined;
  }
  if (Capacitor.isNativePlatform()) {
    return NATIVE_AUTH_CALLBACK_URL;
  }
  // The desktop shell loads a hosted origin (prod.instafy.dev) that is not in
  // Supabase's redirect allow-list, so a web-style redirectTo is rejected and
  // the provider falls back to site_url -- which is how signing in from the
  // app stranded the user on the marketing site with the session in the wrong
  // browser. instafy://auth is already allow-listed for mobile and returns to
  // the app through the same deep link.
  if (isDesktopShell() && desktopCanReceiveAuthCallback()) {
    return NATIVE_AUTH_CALLBACK_URL;
  }
  const path = webPath.trim().startsWith("/") ? webPath.trim() : `/${webPath.trim()}`;
  return `${window.location.origin}${path}`;
}

function generateNativeAuthAttemptId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `attempt-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
}

function normalizePendingNativeAuthAttempt(value: unknown): PendingNativeAuthAttempt | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const attempt = value as Record<string, unknown>;
  const attemptId = typeof attempt.attemptId === "string" ? attempt.attemptId.trim() : "";
  const provider = typeof attempt.provider === "string" ? attempt.provider.trim().toLowerCase() : "";
  const startedAt = typeof attempt.startedAt === "string" ? attempt.startedAt.trim() : "";
  const platform = typeof attempt.platform === "string" ? attempt.platform.trim().toLowerCase() : "";
  if (!attemptId || !provider || !startedAt || !platform) {
    return null;
  }
  return {
    attemptId,
    provider,
    startedAt,
    platform,
  };
}

export function createPendingNativeAuthAttempt(provider: string): PendingNativeAuthAttempt {
  const normalizedProvider = provider.trim().toLowerCase() || "unknown";
  return {
    attemptId: generateNativeAuthAttemptId(),
    provider: normalizedProvider,
    startedAt: new Date().toISOString(),
    platform: Capacitor.getPlatform(),
  };
}

/**
 * How long a started sign-in still names the callback that comes back: long
 * enough for a slow provider sign-in, after which an abandoned attempt is
 * ignored rather than labelling an unrelated callback.
 */
const PENDING_NATIVE_AUTH_ATTEMPT_MAX_AGE_MS = 30 * 60 * 1000;

// The attempt lives in localStorage, not sessionStorage. Android can end the
// app's process while the provider's custom tab is in front; the deep link then
// starts a new process with an empty sessionStorage. The PKCE verifier is in
// localStorage, so the sign-in still completes, and the attempt has to survive
// with it or the callback names the wrong provider.
export function readPendingNativeAuthAttempt(): PendingNativeAuthAttempt | null {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    const raw = window.localStorage?.getItem(NATIVE_AUTH_ATTEMPT_STORAGE_KEY);
    if (!raw) {
      return null;
    }
    const attempt = normalizePendingNativeAuthAttempt(JSON.parse(raw));
    const startedAt = attempt ? Date.parse(attempt.startedAt) : Number.NaN;
    if (!Number.isFinite(startedAt) || Math.abs(Date.now() - startedAt) > PENDING_NATIVE_AUTH_ATTEMPT_MAX_AGE_MS) {
      return null;
    }
    return attempt;
  } catch {
    return null;
  }
}

export function writePendingNativeAuthAttempt(attempt: PendingNativeAuthAttempt | null) {
  if (typeof window === "undefined") {
    return;
  }
  try {
    if (!attempt) {
      window.localStorage?.removeItem(NATIVE_AUTH_ATTEMPT_STORAGE_KEY);
      return;
    }
    window.localStorage?.setItem(NATIVE_AUTH_ATTEMPT_STORAGE_KEY, JSON.stringify(attempt));
  } catch {
    // ignore storage failures
  }
}

export function clearPendingNativeAuthAttempt() {
  writePendingNativeAuthAttempt(null);
}

export function readNativeAuthCallbackAttemptId(): string | null {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    const value = window.sessionStorage?.getItem(NATIVE_AUTH_CALLBACK_ATTEMPT_STORAGE_KEY);
    return typeof value === "string" && value.trim().length > 0 ? value : null;
  } catch {
    return null;
  }
}

export function writeNativeAuthCallbackAttemptId(attemptId: string | null) {
  if (typeof window === "undefined") {
    return;
  }
  try {
    if (!attemptId) {
      window.sessionStorage?.removeItem(NATIVE_AUTH_CALLBACK_ATTEMPT_STORAGE_KEY);
      return;
    }
    window.sessionStorage?.setItem(NATIVE_AUTH_CALLBACK_ATTEMPT_STORAGE_KEY, attemptId);
  } catch {
    // ignore storage failures
  }
}

export function clearNativeAuthCallbackAttemptId() {
  writeNativeAuthCallbackAttemptId(null);
}

export function readNativeAuthError(): string | null {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    const value = window.sessionStorage?.getItem(NATIVE_AUTH_ERROR_STORAGE_KEY);
    return typeof value === "string" && value.trim().length > 0 ? value : null;
  } catch {
    return null;
  }
}

export function writeNativeAuthError(message: string | null) {
  if (typeof window === "undefined") {
    return;
  }
  try {
    if (!message) {
      window.sessionStorage?.removeItem(NATIVE_AUTH_ERROR_STORAGE_KEY);
      return;
    }
    window.sessionStorage?.setItem(NATIVE_AUTH_ERROR_STORAGE_KEY, message);
  } catch {
    // ignore storage failures
  }
}
