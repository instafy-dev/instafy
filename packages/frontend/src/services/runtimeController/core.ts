import { supabase } from "../../lib/supabaseClient";
import { Capacitor } from "@capacitor/core";

const controllerUrlRaw = (import.meta.env.VITE_CONTROLLER_URL ?? "").trim();
const defaultControllerUrl = "https://controller.instafy.dev";
const controllerUrlResolvedRaw =
  controllerUrlRaw ||
  (typeof window !== "undefined" && Capacitor.isNativePlatform()
    ? defaultControllerUrl
    : "");

function normalizeControllerBaseUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    return "";
  }
  try {
    const parsed = new URL(trimmed);
    if (typeof window !== "undefined" && parsed.protocol === "http:" && parsed.hostname === "127.0.0.1") {
      // Some long-lived browser profiles intermittently fail against 127.0.0.1 while localhost works.
      // Normalize local controller loopback URLs to localhost for browser fetch/EventSource stability.
      parsed.hostname = "localhost";
    }
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return trimmed.replace(/\/$/, "");
  }
}

const CONTROLLER_BASE_URL_STORAGE_KEY = "instafy.controllerBaseUrl";
export let controllerBaseUrl = normalizeControllerBaseUrl(controllerUrlResolvedRaw);

export let runtimeControllerEnabled = controllerBaseUrl.length > 0;

// Controller API naming note:
// `idleTtlSeconds` controls when the controller considers a runtime "stale" based on `last_seen_at`
// (which is updated by agent lease/heartbeat traffic). It's effectively a heartbeat timeout, not a
// UI "user idle" duration. Keep it >= the controller's production minimum (300s) so behavior is
// consistent between dev (debug builds accept smaller TTLs) and production (release builds clamp).
export const CONTROLLER_RUNTIME_IDLE_TTL_SECONDS_MIN = 300;
export const CONTROLLER_RUNTIME_IDLE_TTL_SECONDS_DEFAULT = 300;

export function coerceControllerRuntimeIdleTtlSeconds(
  value: number | null | undefined,
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return CONTROLLER_RUNTIME_IDLE_TTL_SECONDS_DEFAULT;
  }
  const floored = Math.floor(value);
  if (floored <= 0) {
    return CONTROLLER_RUNTIME_IDLE_TTL_SECONDS_DEFAULT;
  }
  return Math.max(CONTROLLER_RUNTIME_IDLE_TTL_SECONDS_MIN, floored);
}

const CONTROLLER_TOKEN_STORAGE_KEY = "instafy.controllerAccessToken";

export const CONTROLLER_AUTH_ERROR_EVENT = "instafy:controller-auth-error";

export interface ControllerAuthErrorDetail {
  status: number;
  message: string;
  url?: string | null;
}

export interface ControllerApiErrorPayload {
  status: number;
  message: string;
  code: string | null;
  details: unknown;
  url?: string | null;
}

export class ControllerApiError extends Error {
  readonly status: number;
  readonly code: string | null;
  readonly details: unknown;
  readonly url: string | null;

  constructor(payload: ControllerApiErrorPayload) {
    super(payload.message);
    this.name = "ControllerApiError";
    this.status = payload.status;
    this.code = payload.code;
    this.details = payload.details;
    this.url = payload.url ?? null;
  }
}

const UUID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/;

let injectedControllerToken: string | null | undefined;
let injectedControllerBaseUrl: string | null | undefined;
let lastControllerAuthErrorAt = 0;
let overrideDroppedForAuthErrorAt = 0;

function normalizeInjectedToken(token: string | null | undefined): string | null {
  const normalized = typeof token === "string" ? token.trim() : "";
  if (!normalized) {
    return null;
  }
  const lowered = normalized.toLowerCase();
  if (lowered === "null" || lowered === "undefined") {
    return null;
  }
  return normalized;
}

function normalizeInjectedControllerBaseUrl(url: string | null | undefined): string | null {
  const normalized = typeof url === "string" ? url.trim() : "";
  if (!normalized) {
    return null;
  }
  const lowered = normalized.toLowerCase();
  if (lowered === "null" || lowered === "undefined") {
    return null;
  }
  return normalizeControllerBaseUrl(normalized);
}

function readControllerAccessTokenFromLocationSearch(): string | null {
  if (typeof window === "undefined") {
    return null;
  }
  return readControllerAccessTokenFromSearch(window.location.search);
}

function readControllerBaseUrlFromLocationSearch(): string | null {
  if (typeof window === "undefined") {
    return null;
  }
  return readControllerBaseUrlFromSearch(window.location.search);
}

export function readControllerAccessTokenFromSearch(search: string): string | null {
  try {
    const params = new URLSearchParams(search);
    return normalizeInjectedToken(params.get("controllerAccessToken"));
  } catch (_error) {
    return null;
  }
}

export function readControllerBaseUrlFromSearch(search: string): string | null {
  try {
    const params = new URLSearchParams(search);
    return normalizeInjectedControllerBaseUrl(params.get("controllerUrl"));
  } catch {
    return null;
  }
}

export function syncControllerAccessTokenFromSearch(search: string): string | null {
  const searchToken = readControllerAccessTokenFromSearch(search);
  if (searchToken && searchToken !== currentInjectedToken()) {
    setInjectedControllerToken(searchToken);
  }
  return currentInjectedToken();
}

export function syncControllerBaseUrlFromSearch(search: string): string | null {
  const searchControllerBaseUrl = readControllerBaseUrlFromSearch(search);
  if (searchControllerBaseUrl && searchControllerBaseUrl !== currentInjectedControllerBaseUrl()) {
    setInjectedControllerBaseUrl(searchControllerBaseUrl);
  }
  return currentInjectedControllerBaseUrl();
}

function currentInjectedToken(): string | null {
  return normalizeInjectedToken(injectedControllerToken ?? null);
}

function currentInjectedControllerBaseUrl(): string | null {
  return normalizeInjectedControllerBaseUrl(injectedControllerBaseUrl ?? null);
}

function syncResolvedControllerBaseUrl() {
  controllerBaseUrl =
    currentInjectedControllerBaseUrl() ?? normalizeControllerBaseUrl(controllerUrlResolvedRaw);
  runtimeControllerEnabled = controllerBaseUrl.length > 0;
}

function tryDecodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length < 2) {
    return null;
  }
  const payloadPart = parts[1] ?? "";
  if (!payloadPart) {
    return null;
  }

  const padded = payloadPart
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(payloadPart.length + ((4 - (payloadPart.length % 4)) % 4), "=");

  try {
    const decoded =
      typeof window !== "undefined" && typeof window.atob === "function"
        ? window.atob(padded)
        : typeof globalThis.atob === "function"
          ? globalThis.atob(padded)
          : null;
    if (!decoded) {
      return null;
    }
    const parsed = JSON.parse(decoded) as unknown;
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch (_error) {
    return null;
  }
}

function isLikelyExpiredJwt(token: string): boolean {
  const payload = tryDecodeJwtPayload(token);
  const exp = payload?.exp;
  if (typeof exp !== "number" || !Number.isFinite(exp)) {
    return false;
  }
  const expiresAtMs = exp * 1000;
  return expiresAtMs - Date.now() < 30_000;
}

function setInjectedControllerToken(token: string | null | undefined) {
  injectedControllerToken = normalizeInjectedToken(token);
  if (typeof window !== "undefined") {
    window.__INSTAFY_CONTROLLER_TOKEN__ = injectedControllerToken ?? null;
    try {
      if (window.sessionStorage) {
        if (injectedControllerToken) {
          window.sessionStorage.setItem(
            CONTROLLER_TOKEN_STORAGE_KEY,
            injectedControllerToken,
          );
        } else {
          window.sessionStorage.removeItem(CONTROLLER_TOKEN_STORAGE_KEY);
        }
      }
    } catch (_error) {
      // ignore storage failures (e.g., private browsing)
    }
  }
}

function setInjectedControllerBaseUrl(url: string | null | undefined) {
  injectedControllerBaseUrl = normalizeInjectedControllerBaseUrl(url);
  syncResolvedControllerBaseUrl();
  if (typeof window !== "undefined") {
    window.__INSTAFY_CONTROLLER_BASE_URL__ = injectedControllerBaseUrl ?? null;
    try {
      if (window.sessionStorage) {
        if (injectedControllerBaseUrl) {
          window.sessionStorage.setItem(
            CONTROLLER_BASE_URL_STORAGE_KEY,
            injectedControllerBaseUrl,
          );
        } else {
          window.sessionStorage.removeItem(CONTROLLER_BASE_URL_STORAGE_KEY);
        }
      }
    } catch (_error) {
      // ignore storage failures (e.g., private browsing)
    }
  }
}

function initializeInjectedControllerToken() {
  if (typeof window === "undefined") {
    return;
  }
  if (typeof injectedControllerToken !== "undefined") {
    return;
  }
  if (typeof window.__INSTAFY_CONTROLLER_TOKEN__ === "string") {
    setInjectedControllerToken(window.__INSTAFY_CONTROLLER_TOKEN__);
  }
  const locationToken = readControllerAccessTokenFromLocationSearch();
  if (locationToken) {
    setInjectedControllerToken(locationToken);
    return;
  }
  try {
    const stored = window.sessionStorage?.getItem(CONTROLLER_TOKEN_STORAGE_KEY);
    if (stored && stored.trim().length > 0) {
      setInjectedControllerToken(stored);
    }
  } catch (_error) {
    // ignore storage read failures
  }
}

function initializeInjectedControllerBaseUrl() {
  if (typeof window === "undefined") {
    return;
  }
  if (typeof injectedControllerBaseUrl !== "undefined") {
    return;
  }
  if (typeof window.__INSTAFY_CONTROLLER_BASE_URL__ === "string") {
    setInjectedControllerBaseUrl(window.__INSTAFY_CONTROLLER_BASE_URL__);
  }
  const locationControllerBaseUrl = readControllerBaseUrlFromLocationSearch();
  if (locationControllerBaseUrl) {
    setInjectedControllerBaseUrl(locationControllerBaseUrl);
    return;
  }
  try {
    const stored = window.sessionStorage?.getItem(CONTROLLER_BASE_URL_STORAGE_KEY);
    if (stored && stored.trim().length > 0) {
      setInjectedControllerBaseUrl(stored);
      return;
    }
  } catch (_error) {
    // ignore storage read failures
  }
  syncResolvedControllerBaseUrl();
}

if (typeof window !== "undefined") {
  initializeInjectedControllerToken();
  initializeInjectedControllerBaseUrl();
  window.addEventListener("message", (event: MessageEvent) => {
    const data = event.data;
    if (!data || typeof data !== "object") {
      return;
    }
    if (data.type === "instafy:setControllerAccessToken") {
      const tokenValue = typeof data.token === "string" ? data.token : null;
      setInjectedControllerToken(tokenValue);
    }
    if (data.type === "instafy:setControllerBaseUrl") {
      const urlValue = typeof data.url === "string" ? data.url : null;
      setInjectedControllerBaseUrl(urlValue);
    }
  });
}

declare global {
  interface Window {
    __INSTAFY_CONTROLLER_TOKEN__?: string | null;
    __INSTAFY_CONTROLLER_BASE_URL__?: string | null;
  }
}

export function clearControllerAccessTokenOverride() {
  setInjectedControllerToken(null);
}

export function clearControllerBaseUrlOverride() {
  setInjectedControllerBaseUrl(null);
}

export function emitControllerAuthError(detail: ControllerAuthErrorDetail) {
  if (typeof window === "undefined") {
    return;
  }
  // An injected override token (invite link / device handoff) outlives the
  // session that minted it and is preferred over the signed-in user's own
  // Supabase token. When the controller rejects it, the override is the
  // suspect — drop it and let the next request use the real session instead
  // of force-signing-out a freshly authenticated user. Requests already in
  // flight when the override is dropped still carry the dead token, so their
  // 401s get the same treatment for a short grace window. A 401 outside that
  // window with no override present escalates to the sign-out flow below.
  if (detail.status === 401) {
    if (currentInjectedToken()) {
      setInjectedControllerToken(null);
      overrideDroppedForAuthErrorAt = Date.now();
      return;
    }
    if (Date.now() - overrideDroppedForAuthErrorAt < 5000) {
      return;
    }
  }
  const now = Date.now();
  if (now - lastControllerAuthErrorAt < 2000) {
    return;
  }
  lastControllerAuthErrorAt = now;
  window.dispatchEvent(
    new CustomEvent(CONTROLLER_AUTH_ERROR_EVENT, {
      detail: {
        status: detail.status,
        message: detail.message,
        url: detail.url ?? null,
      } satisfies ControllerAuthErrorDetail,
    }),
  );
}

export function normalizeOriginEndpointForClient(endpoint: string): string {
  const trimmed = (endpoint ?? "").trim();
  if (!trimmed) {
    return trimmed;
  }
  try {
    const url = new URL(trimmed);
    if (url.hostname === "0.0.0.0" || url.hostname === "::") {
      url.hostname = "127.0.0.1";
    }
    if (url.hostname === "host.docker.internal") {
      const localFallback = "127.0.0.1";
      if (typeof window === "undefined") {
        url.hostname = localFallback;
      } else {
        const currentHost = window.location.hostname;
        if (
          currentHost === "localhost" ||
          currentHost === "127.0.0.1" ||
          currentHost === "" ||
          currentHost === "::1"
        ) {
          url.hostname = localFallback;
        }
      }
      return url.toString().replace(/\/+$/, "");
    }
    return url.toString().replace(/\/+$/, "");
  } catch (_error) {
    if (trimmed.includes("host.docker.internal")) {
      return trimmed
        .replace("host.docker.internal", "127.0.0.1")
        .replace(/\/+$/, "");
    }
    return trimmed.replace(/\/+$/, "");
  }
}

export function normalizeUuidParam(
  value: string | null | undefined,
): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed || !UUID_PATTERN.test(trimmed)) {
    return null;
  }
  return trimmed;
}

export function safeJson(
  value: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null {
  if (!value) {
    return null;
  }
  try {
    return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
  } catch (_error) {
    return null;
  }
}

export async function readControllerError(
  response: Response,
  fallback: string,
): Promise<string> {
  const payload = await readControllerApiError(response, fallback);
  return payload.message;
}

export async function readControllerApiError(
  response: Response,
  fallback: string,
): Promise<ControllerApiErrorPayload> {
  const base = `${fallback} (${response.status})`;
  try {
    const text = await response.text();
    if (!text) {
      if (response.status === 401) {
        emitControllerAuthError({
          status: response.status,
          message: base,
          url: response.url,
        });
      }
      return {
        status: response.status,
        message: base,
        code: null,
        details: null,
        url: response.url,
      };
    }
    try {
      const data = JSON.parse(text) as Record<string, unknown>;
      if (typeof data.message === "string" && data.message.trim().length > 0) {
        const message = data.message.trim();
        if (response.status === 401) {
          emitControllerAuthError({
            status: response.status,
            message,
            url: response.url,
          });
        }
        return {
          status: response.status,
          message,
          code: typeof data.code === "string" && data.code.trim().length > 0
            ? data.code.trim()
            : null,
          details: data.details ?? null,
          url: response.url,
        };
      }
    } catch (_error) {
      // ignore JSON parse failure, fall back to raw text
    }
    const message = `${base}: ${text}`;
    if (response.status === 401) {
      emitControllerAuthError({
        status: response.status,
        message,
        url: response.url,
      });
    }
    return {
      status: response.status,
      message,
      code: null,
      details: null,
      url: response.url,
    };
  } catch (_error) {
    if (response.status === 401) {
      emitControllerAuthError({
        status: response.status,
        message: base,
        url: response.url,
      });
    }
    return {
      status: response.status,
      message: base,
      code: null,
      details: null,
      url: response.url,
    };
  }
}

export async function resolveControllerAccessToken(
  desired: string | null,
): Promise<string | null> {
  const desiredToken = normalizeInjectedToken(desired);
  if (desiredToken) {
    return desiredToken;
  }

  if (typeof injectedControllerToken === "undefined") {
    initializeInjectedControllerToken();
  }
  syncControllerAccessTokenFromSearch(
    typeof window !== "undefined" ? window.location.search : "",
  );
  const injectedToken = currentInjectedToken();
  if (injectedToken) {
    if (isLikelyExpiredJwt(injectedToken)) {
      setInjectedControllerToken(null);
    } else {
      return injectedToken;
    }
  }

  const authClient = (
    supabase as {
      auth?: {
        getSession?: () => Promise<{
          data: { session: { access_token: string | null; expires_at?: number | null } | null };
        }>;
        refreshSession?: () => Promise<{
          data: { session: { access_token: string | null; expires_at?: number | null } | null };
        }>;
      };
    }
  ).auth;

  try {
    if (authClient && typeof authClient.getSession === "function") {
      let result = await authClient.getSession();
      const expiresAt = result.data.session?.expires_at
        ? result.data.session.expires_at * 1000
        : null;
      const tokenStale =
        typeof expiresAt === "number" ? expiresAt - Date.now() < 30_000 : false;
      if (tokenStale && typeof authClient.refreshSession === "function") {
        const refreshed = await authClient.refreshSession().catch(() => null);
        if (refreshed?.data?.session) {
          result = refreshed;
        }
      }
      const sessionToken = normalizeInjectedToken(result.data.session?.access_token ?? null);
      if (sessionToken) {
        return sessionToken;
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(
      "[runtime-controller] unable to resolve access token:",
      message,
    );
  }

  return null;
}
