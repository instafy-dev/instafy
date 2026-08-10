import { Capacitor } from "@capacitor/core";

import { isDesktopShell } from "../lib/desktopShell";

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
  if (isDesktopShell()) {
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

export function readPendingNativeAuthAttempt(): PendingNativeAuthAttempt | null {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    const raw = window.sessionStorage?.getItem(NATIVE_AUTH_ATTEMPT_STORAGE_KEY);
    if (!raw) {
      return null;
    }
    return normalizePendingNativeAuthAttempt(JSON.parse(raw));
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
      window.sessionStorage?.removeItem(NATIVE_AUTH_ATTEMPT_STORAGE_KEY);
      return;
    }
    window.sessionStorage?.setItem(NATIVE_AUTH_ATTEMPT_STORAGE_KEY, JSON.stringify(attempt));
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
