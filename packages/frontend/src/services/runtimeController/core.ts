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
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return "";
    }
    if (
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash ||
      trimmed.includes("?") ||
      trimmed.includes("#")
    ) {
      return "";
    }
    if (typeof window !== "undefined" && parsed.protocol === "http:" && parsed.hostname === "127.0.0.1") {
      // Some long-lived browser profiles intermittently fail against 127.0.0.1 while localhost works.
      // Normalize local controller loopback URLs to localhost for browser fetch/EventSource stability.
      parsed.hostname = "localhost";
    }
    parsed.pathname = parsed.pathname.replace(/\/+$/, "") || "/";
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return "";
  }
}

const CONTROLLER_BINDING_STORAGE_KEY = "instafy.controllerBinding";
const CONTROLLER_BINDING_STORAGE_VERSION = 1;
const RETIRED_CONTROLLER_STORAGE_KEYS = [
  "instafy.controllerAccessToken",
  "instafy.controllerBaseUrl",
] as const;
const canonicalControllerBaseUrl = normalizeControllerBaseUrl(controllerUrlResolvedRaw);
export let controllerBaseUrl = canonicalControllerBaseUrl;

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

export const CONTROLLER_AUTH_ERROR_EVENT = "instafy:controller-auth-error";
export const CONTROLLER_RELOAD_REQUIRED_EVENT = "instafy:controller-reload-required";

export interface ControllerAuthErrorDetail {
  status: number;
  message: string;
  url?: string | null;
}

export interface ControllerRequestContext {
  readonly baseUrl: string;
  readonly accessToken: string | null;
  readonly credentialSource: "ambient" | "fixed" | null;
  readonly generation: number;
}

export interface ControllerReloadRequiredDetail {
  reason: "override-switch" | "rejected-override";
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
let controllerBindingInitialized = false;
let controllerReloadPending = false;
let controllerReloadReason: ControllerReloadRequiredDetail["reason"] | null = null;
let controllerBindingGeneration = 0;
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
  return normalizeControllerBaseUrl(normalized) || null;
}

interface ControllerOverrideSource {
  token: string | null;
  baseUrl: string | null;
  hasToken: boolean;
  hasBaseUrl: boolean;
}

interface PersistedControllerBindingV1 {
  version: 1;
  token: string | null;
  baseUrl: string | null;
}

function currentInjectedToken(): string | null {
  return normalizeInjectedToken(injectedControllerToken ?? null);
}

function currentInjectedControllerBaseUrl(): string | null {
  return normalizeInjectedControllerBaseUrl(injectedControllerBaseUrl ?? null);
}

function isLoopbackBrowserLocation(): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  const hostname = window.location.hostname.toLowerCase();
  return (
    hostname === "" ||
    hostname === "localhost" ||
    hostname === "::1" ||
    hostname === "[::1]" ||
    /^127(?:\.\d{1,3}){3}$/.test(hostname)
  );
}

function isHostedProductionControllerEnvironment(): boolean {
  return (
    typeof window !== "undefined" &&
    import.meta.env.PROD &&
    !Capacitor.isNativePlatform() &&
    !isLoopbackBrowserLocation()
  );
}

function isCustomControllerBaseUrl(baseUrl: string | null): boolean {
  return Boolean(baseUrl && baseUrl !== canonicalControllerBaseUrl);
}

function isActiveCustomControllerBaseUrl(): boolean {
  return isCustomControllerBaseUrl(controllerBaseUrl);
}

function emptyControllerOverrideSource(): ControllerOverrideSource {
  return { token: null, baseUrl: null, hasToken: false, hasBaseUrl: false };
}

function failClosedControllerOverrideSource(): ControllerOverrideSource {
  // Mark the absent base as explicitly supplied so the normal source
  // validation rejects the complete binding, including any token.
  return { token: null, baseUrl: null, hasToken: true, hasBaseUrl: true };
}

function readStoredControllerOverrideSource(storage: Storage): ControllerOverrideSource {
  let persistedBinding: string | null;
  try {
    persistedBinding = storage.getItem(CONTROLLER_BINDING_STORAGE_KEY);
  } catch (_error) {
    return failClosedControllerOverrideSource();
  }

  if (persistedBinding !== null) {
    try {
      const parsed = JSON.parse(persistedBinding) as Partial<PersistedControllerBindingV1> | null;
      if (
        !parsed ||
        typeof parsed !== "object" ||
        parsed.version !== CONTROLLER_BINDING_STORAGE_VERSION ||
        !(typeof parsed.token === "string" || parsed.token === null) ||
        !(typeof parsed.baseUrl === "string" || parsed.baseUrl === null)
      ) {
        return failClosedControllerOverrideSource();
      }
      return {
        token: normalizeInjectedToken(parsed.token),
        baseUrl: normalizeInjectedControllerBaseUrl(parsed.baseUrl),
        hasToken: parsed.token !== null,
        hasBaseUrl: parsed.baseUrl !== null,
      };
    } catch (_error) {
      return failClosedControllerOverrideSource();
    }
  }

  return emptyControllerOverrideSource();
}

function resolveControllerOverrideSource(source: ControllerOverrideSource): {
  token: string | null;
  baseUrl: string | null;
} {
  // An explicitly supplied but invalid base URL invalidates its token too.
  // Otherwise an attacker-controlled custom credential could silently be
  // redirected to the canonical controller.
  if (source.hasBaseUrl && !source.baseUrl) {
    return { token: null, baseUrl: null };
  }

  const customBaseUrl = isCustomControllerBaseUrl(source.baseUrl)
    ? source.baseUrl
    : null;
  if (
    customBaseUrl &&
    (!source.token || isHostedProductionControllerEnvironment())
  ) {
    return { token: null, baseUrl: null };
  }
  return {
    token: source.token,
    baseUrl: customBaseUrl,
  };
}

function syncResolvedControllerBaseUrl() {
  const injectedBaseUrl = currentInjectedControllerBaseUrl();
  const customOverrideAllowed =
    !isCustomControllerBaseUrl(injectedBaseUrl) ||
    (!isHostedProductionControllerEnvironment() && Boolean(currentInjectedToken()));
  controllerBaseUrl =
    customOverrideAllowed && injectedBaseUrl
      ? injectedBaseUrl
      : canonicalControllerBaseUrl;
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

function setInjectedControllerOverrides(
  token: string | null | undefined,
  baseUrl: string | null | undefined,
) {
  const previousToken = currentInjectedToken();
  const previousBaseUrl = currentInjectedControllerBaseUrl();
  let normalizedToken = normalizeInjectedToken(token);
  let normalizedBaseUrl = normalizeInjectedControllerBaseUrl(baseUrl);
  if (normalizedBaseUrl === canonicalControllerBaseUrl) {
    normalizedBaseUrl = null;
  }
  if (isCustomControllerBaseUrl(normalizedBaseUrl)) {
    if (isHostedProductionControllerEnvironment()) {
      // The token and custom base form one credential pair. Do not redirect
      // the custom credential to the canonical controller when hosted web
      // policy rejects its base URL.
      normalizedToken = null;
      normalizedBaseUrl = null;
    } else if (!normalizedToken) {
      normalizedBaseUrl = null;
    }
  }

  injectedControllerToken = normalizedToken;
  injectedControllerBaseUrl = normalizedBaseUrl;
  if (
    controllerBindingInitialized &&
    (normalizedToken !== previousToken || normalizedBaseUrl !== previousBaseUrl)
  ) {
    controllerBindingGeneration += 1;
  }
  if (!controllerBindingInitialized) {
    syncResolvedControllerBaseUrl();
  }
  persistInjectedControllerOverrides(normalizedToken, normalizedBaseUrl, true);
}

function persistInjectedControllerOverrides(
  token: string | null,
  baseUrl: string | null,
  updateGlobals: boolean,
) {
  if (typeof window !== "undefined") {
    if (updateGlobals) {
      window.__INSTAFY_CONTROLLER_TOKEN__ = token;
      window.__INSTAFY_CONTROLLER_BASE_URL__ = baseUrl;
    }
    let storage: Storage;
    try {
      storage = window.sessionStorage;
      const binding: PersistedControllerBindingV1 = {
        version: CONTROLLER_BINDING_STORAGE_VERSION,
        token,
        baseUrl,
      };
      // One setItem is the commit point. A failed/interrupted replacement
      // leaves the previous complete binding intact rather than exposing a
      // token-only or base-only intermediate state.
      storage.setItem(CONTROLLER_BINDING_STORAGE_KEY, JSON.stringify(binding));
    } catch (_error) {
      // ignore storage failures (e.g., private browsing)
      return;
    }

    // These split-key credential inputs are no longer accepted. Remove any
    // residue without ever reading or migrating it into the active binding.
    for (const legacyKey of RETIRED_CONTROLLER_STORAGE_KEYS) {
      try {
        storage.removeItem(legacyKey);
      } catch (_error) {
        // ignore best-effort legacy cleanup failures
      }
    }
  }
}

function setInjectedControllerToken(token: string | null | undefined) {
  setInjectedControllerOverrides(token, currentInjectedControllerBaseUrl());
}

function setInjectedControllerBaseUrl(url: string | null | undefined) {
  setInjectedControllerOverrides(currentInjectedToken(), url);
}

function purgeControllerOverrideParamsFromLocation() {
  if (typeof window === "undefined") {
    return;
  }
  try {
    const url = new URL(window.location.href);
    const hasControllerBaseUrl = url.searchParams.has("controllerUrl");
    const hasControllerToken = url.searchParams.has("controllerAccessToken");
    if (!hasControllerBaseUrl && !hasControllerToken) {
      return;
    }
    url.searchParams.delete("controllerUrl");
    url.searchParams.delete("controllerAccessToken");
    window.history.replaceState(
      window.history.state,
      "",
      `${url.pathname}${url.search}${url.hash}`,
    );
  } catch (_error) {
    // ignore unavailable history/location implementations
  }
}

function requestControllerDocumentReload(
  reason: ControllerReloadRequiredDetail["reason"],
) {
  if (controllerReloadPending) {
    return;
  }
  controllerReloadPending = true;
  controllerReloadReason = reason;
  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent(CONTROLLER_RELOAD_REQUIRED_EVENT, {
        detail: { reason } satisfies ControllerReloadRequiredDetail,
      }),
    );
  }
}

export function isControllerDocumentReloadPending(): boolean {
  return controllerReloadPending;
}

export function subscribeToControllerReloadRequired(
  listener: (detail: ControllerReloadRequiredDetail) => void,
): () => void {
  if (typeof window === "undefined") {
    return () => {};
  }
  const handleReloadRequired = (event: Event) => {
    listener(
      (event as CustomEvent<ControllerReloadRequiredDetail>).detail,
    );
  };
  window.addEventListener(
    CONTROLLER_RELOAD_REQUIRED_EVENT,
    handleReloadRequired,
  );
  // The event may have fired before a React parent effect mounted. Replay
  // the durable pending state so the document cannot remain half-switched.
  if (controllerReloadPending && controllerReloadReason) {
    listener({ reason: controllerReloadReason });
  }
  return () => {
    window.removeEventListener(
      CONTROLLER_RELOAD_REQUIRED_EVENT,
      handleReloadRequired,
    );
  };
}

function clearInjectedCustomControllerPair() {
  setInjectedControllerOverrides(null, null);
  purgeControllerOverrideParamsFromLocation();
  requestControllerDocumentReload("rejected-override");
}

function initializeInjectedControllerOverrides() {
  if (
    typeof injectedControllerToken !== "undefined" &&
    typeof injectedControllerBaseUrl !== "undefined"
  ) {
    return;
  }
  if (typeof window === "undefined") {
    injectedControllerToken = null;
    injectedControllerBaseUrl = null;
    syncResolvedControllerBaseUrl();
    controllerBindingInitialized = true;
    return;
  }

  const globalSource: ControllerOverrideSource = {
    token: normalizeInjectedToken(window.__INSTAFY_CONTROLLER_TOKEN__),
    baseUrl: normalizeInjectedControllerBaseUrl(window.__INSTAFY_CONTROLLER_BASE_URL__),
    hasToken: typeof window.__INSTAFY_CONTROLLER_TOKEN__ === "string",
    hasBaseUrl: typeof window.__INSTAFY_CONTROLLER_BASE_URL__ === "string",
  };
  let storedSource = emptyControllerOverrideSource();
  try {
    storedSource = readStoredControllerOverrideSource(window.sessionStorage);
  } catch (_error) {
    // ignore storage read failures
  }

  // Select one complete source as a unit. URL query parameters and the old
  // split session-storage keys are deliberately ignored.
  const source = globalSource.hasToken || globalSource.hasBaseUrl
    ? globalSource
    : storedSource;
  const resolvedSource = resolveControllerOverrideSource(source);
  setInjectedControllerOverrides(resolvedSource.token, resolvedSource.baseUrl);
  controllerBindingInitialized = true;
  purgeControllerOverrideParamsFromLocation();
}

if (typeof window !== "undefined") {
  initializeInjectedControllerOverrides();
}

declare global {
  interface Window {
    __INSTAFY_CONTROLLER_TOKEN__?: string | null;
    __INSTAFY_CONTROLLER_BASE_URL__?: string | null;
  }
}

export function clearControllerAccessTokenOverride() {
  if (isActiveCustomControllerBaseUrl()) {
    clearInjectedCustomControllerPair();
    return;
  }
  const hadInjectedToken = Boolean(currentInjectedToken());
  setInjectedControllerToken(null);
  purgeControllerOverrideParamsFromLocation();
  if (hadInjectedToken) {
    requestControllerDocumentReload("rejected-override");
  }
}

export function clearControllerBaseUrlOverride() {
  if (isActiveCustomControllerBaseUrl()) {
    clearInjectedCustomControllerPair();
    return;
  }
  setInjectedControllerBaseUrl(null);
  purgeControllerOverrideParamsFromLocation();
}

function createControllerRequestContext(
  accessToken: string | null,
  credentialSource: ControllerRequestContext["credentialSource"],
): ControllerRequestContext {
  return Object.freeze({
    baseUrl: controllerBaseUrl,
    accessToken,
    credentialSource: accessToken ? credentialSource : null,
    generation: controllerBindingGeneration,
  });
}

function controllerRequestContextIsCurrent(
  context: ControllerRequestContext,
): boolean {
  if (
    controllerReloadPending ||
    context.baseUrl !== controllerBaseUrl ||
    context.generation !== controllerBindingGeneration ||
    !context.accessToken
  ) {
    return false;
  }

  const injectedToken = currentInjectedToken();
  if (injectedToken) {
    return (
      context.credentialSource === "fixed" &&
      context.accessToken === injectedToken
    );
  }

  return context.credentialSource === "ambient";
}

export function emitControllerAuthError(
  detail: ControllerAuthErrorDetail,
  requestContext?: ControllerRequestContext,
) {
  if (typeof window === "undefined") {
    return;
  }
  if (
    detail.status === 401 &&
    requestContext &&
    (!requestContext.accessToken || !controllerRequestContextIsCurrent(requestContext))
  ) {
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
    if (controllerReloadPending) {
      return;
    }
    if (isActiveCustomControllerBaseUrl()) {
      clearInjectedCustomControllerPair();
      overrideDroppedForAuthErrorAt = Date.now();
      return;
    }
    if (currentInjectedToken()) {
      clearControllerAccessTokenOverride();
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

export async function emitControllerAuthErrorForRequest(
  detail: ControllerAuthErrorDetail,
  requestContext: ControllerRequestContext,
): Promise<boolean> {
  if (!controllerRequestContextIsCurrent(requestContext)) {
    return false;
  }

  const injectedToken = currentInjectedToken();
  if (injectedToken) {
    if (injectedToken !== requestContext.accessToken) {
      return false;
    }
    emitControllerAuthError(detail, requestContext);
    return true;
  }

  // Supabase may refresh the browser session while a controller request is
  // in flight. Re-read it before allowing a 401 to sign out the current user;
  // a response for token A must not invalidate a newer token B.
  try {
    const result = await supabase.auth.getSession();
    const currentSessionToken = normalizeInjectedToken(
      result.data.session?.access_token ?? null,
    );
    if (
      currentSessionToken !== requestContext.accessToken ||
      !controllerRequestContextIsCurrent(requestContext)
    ) {
      return false;
    }
  } catch (_error) {
    // Without a current-session comparison, mutating auth state is unsafe.
    return false;
  }
  emitControllerAuthError(detail, requestContext);
  return true;
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
  requestContext?: ControllerRequestContext,
): Promise<string> {
  const payload = await readControllerApiError(response, fallback, requestContext);
  return payload.message;
}

export async function readControllerApiError(
  response: Response,
  fallback: string,
  requestContext?: ControllerRequestContext,
): Promise<ControllerApiErrorPayload> {
  const base = `${fallback} (${response.status})`;
  try {
    const text = await response.text();
    if (!text) {
      if (response.status === 401 && requestContext) {
        await emitControllerAuthErrorForRequest({
          status: response.status,
          message: base,
          url: response.url,
        }, requestContext);
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
        if (response.status === 401 && requestContext) {
          await emitControllerAuthErrorForRequest({
            status: response.status,
            message,
            url: response.url,
          }, requestContext);
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
    if (response.status === 401 && requestContext) {
      await emitControllerAuthErrorForRequest({
        status: response.status,
        message,
        url: response.url,
      }, requestContext);
    }
    return {
      status: response.status,
      message,
      code: null,
      details: null,
      url: response.url,
    };
  } catch (_error) {
    if (response.status === 401 && requestContext) {
      await emitControllerAuthErrorForRequest({
        status: response.status,
        message: base,
        url: response.url,
      }, requestContext);
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

export async function resolveControllerRequestContext(
  desired: string | null,
): Promise<ControllerRequestContext> {
  initializeInjectedControllerOverrides();
  if (controllerReloadPending) {
    return createControllerRequestContext(null, null);
  }

  const customBaseIsActive = isActiveCustomControllerBaseUrl();
  const injectedToken = currentInjectedToken();
  if (customBaseIsActive) {
    if (!injectedToken || isLikelyExpiredJwt(injectedToken)) {
      clearInjectedCustomControllerPair();
      return createControllerRequestContext(null, null);
    }
    // A custom controller may only receive the token injected alongside that
    // base URL. Even an explicitly supplied caller token may be an ambient
    // Supabase/user token whose audience is the canonical controller.
    return createControllerRequestContext(injectedToken, "fixed");
  }

  const desiredToken = normalizeInjectedToken(desired);
  if (desiredToken) {
    return createControllerRequestContext(desiredToken, "fixed");
  }

  if (injectedToken) {
    if (isLikelyExpiredJwt(injectedToken)) {
      clearControllerAccessTokenOverride();
    } else {
      return createControllerRequestContext(injectedToken, "fixed");
    }
  }

  if (controllerReloadPending) {
    return createControllerRequestContext(null, null);
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
      if (controllerReloadPending) {
        return createControllerRequestContext(null, null);
      }
      const expiresAt = result.data.session?.expires_at
        ? result.data.session.expires_at * 1000
        : null;
      const tokenStale =
        typeof expiresAt === "number" ? expiresAt - Date.now() < 30_000 : false;
      if (tokenStale && typeof authClient.refreshSession === "function") {
        const refreshed = await authClient.refreshSession().catch(() => null);
        if (controllerReloadPending) {
          return createControllerRequestContext(null, null);
        }
        if (refreshed?.data?.session) {
          result = refreshed;
        }
      }
      const sessionToken = normalizeInjectedToken(result.data.session?.access_token ?? null);
      if (sessionToken) {
        return createControllerRequestContext(sessionToken, "ambient");
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(
      "[runtime-controller] unable to resolve access token:",
      message,
    );
  }

  return createControllerRequestContext(null, null);
}

export async function resolveControllerAccessToken(
  desired: string | null,
): Promise<string | null> {
  return (await resolveControllerRequestContext(desired)).accessToken;
}
