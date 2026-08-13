/**
 * PKCE migration helpers.
 *
 * Sign-in runs on the PKCE flow: authorization codes in the URL, verifier
 * proof on exchange, no tokens in fragments that extensions and server logs
 * can see. Two deliberate carve-outs keep the flip from breaking real users,
 * and both live here so the reasoning has one home.
 */

/**
 * Detects a legacy implicit-flow callback: tokens delivered in the URL hash.
 *
 * Why this exists: auth-js (2.75.0) classifies any URL carrying access_token
 * as an implicit callback, and when the client is configured for PKCE it
 * throws "Not a valid PKCE flow url." AND calls _removeSession() -- wiping
 * whatever session was already stored -- with the error swallowed by
 * initialize(). Mid-rollout there are real URLs shaped like this: sign-ins
 * started before the publish, recovery emails sitting in inboxes. For those
 * loads the client is constructed in implicit mode instead; every other load
 * runs PKCE. The shape check mirrors auth-js's own (_isImplicitGrantCallback
 * keys on access_token presence).
 */
export function hasImplicitAuthHash(hash: string | null | undefined): boolean {
  if (typeof hash !== "string" || hash.length <= 1) {
    return false;
  }
  const params = new URLSearchParams(hash.startsWith("#") ? hash.slice(1) : hash);
  return params.has("access_token");
}

export function resolveSupabaseFlowType(
  hash: string | null | undefined,
): "pkce" | "implicit" {
  return hasImplicitAuthHash(hash) ? "implicit" : "pkce";
}

/**
 * Maps raw GoTrue PKCE exchange failures to something a human can act on.
 *
 * The missing-verifier case deserves its own message: it means the exchange
 * ran in a different storage context than the one that started sign-in (a
 * cleared profile, a different browser, a link forwarded across devices).
 * "invalid request: both auth code and code verifier should be non-empty" is
 * not something a user can act on; "start again on this device" is.
 */
export function describeExchangeError(rawMessage: string): string {
  const message = rawMessage.toLowerCase();
  if (message.includes("code verifier") || message.includes("flow state")) {
    return "Sign-in could not be completed on this device. Start signing in again from here.";
  }
  if (message.includes("expired")) {
    return "The sign-in link expired. Start signing in again.";
  }
  return rawMessage;
}

/**
 * Requests a password-recovery email WITHOUT a PKCE challenge.
 *
 * resetPasswordForEmail on a PKCE-configured client stores a code verifier in
 * the requesting context and mails a ?code= link that can only be exchanged
 * where that verifier lives. The desktop shell and the Capacitor apps always
 * open email links in the system browser -- a different storage context -- and
 * cross-device recovery (request on the phone, open on the laptop) is the
 * normal case for a forgotten password. Calling the recover endpoint directly,
 * with no code_challenge, keeps the emailed link token-shaped so it works
 * wherever it is opened; the implicit-shape client shim above then consumes it.
 */
export async function requestPasswordRecovery(options: {
  supabaseUrl: string;
  anonKey: string;
  email: string;
  redirectTo?: string;
  fetchImpl?: typeof fetch;
}): Promise<void> {
  const { supabaseUrl, anonKey, email, redirectTo, fetchImpl } = options;
  const doFetch = fetchImpl ?? fetch;
  const url = new URL("/auth/v1/recover", supabaseUrl);
  if (redirectTo) {
    url.searchParams.set("redirect_to", redirectTo);
  }
  const response = await doFetch(url.toString(), {
    method: "POST",
    headers: {
      apikey: anonKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ email }),
  });
  if (!response.ok) {
    let message = `Unable to send a reset email (HTTP ${response.status}).`;
    try {
      const payload = (await response.json()) as { msg?: string; error_description?: string };
      message = payload.msg ?? payload.error_description ?? message;
    } catch {
      // keep the status-based message
    }
    throw new Error(message);
  }
}

/**
 * Where auth emails should land: back on /login, carrying the caller's
 * pending ?redirect= so an invitee returns to their invitation instead of
 * being stranded in the studio. The login page owns callback handling
 * (exchange, shim, friendly errors), so it is the right landing surface for
 * every emailed continuation.
 */
export function loginEmailRedirectTo(location?: {
  origin: string;
  search: string;
}): string | undefined {
  const loc =
    location ?? (typeof window === "undefined" ? undefined : window.location);
  if (!loc) {
    return undefined;
  }
  const redirect = new URLSearchParams(loc.search).get("redirect");
  const target = new URL("/login", loc.origin);
  if (redirect && redirect.startsWith("/") && !redirect.startsWith("//")) {
    target.searchParams.set("redirect", redirect);
  }
  return target.toString();
}

async function challengeFreeAuthRequest(options: {
  supabaseUrl: string;
  anonKey: string;
  path: string;
  body: Record<string, unknown>;
  redirectTo?: string;
  fetchImpl?: typeof fetch;
}): Promise<void> {
  const { supabaseUrl, anonKey, path, body, redirectTo, fetchImpl } = options;
  const doFetch = fetchImpl ?? fetch;
  const url = new URL(path, supabaseUrl);
  if (redirectTo) {
    url.searchParams.set("redirect_to", redirectTo);
  }
  const response = await doFetch(url.toString(), {
    method: "POST",
    headers: { apikey: anonKey, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    let message = `Request failed (HTTP ${response.status}).`;
    try {
      const payload = (await response.json()) as { msg?: string; error_description?: string };
      message = payload.msg ?? payload.error_description ?? message;
    } catch {
      // keep the status-based message
    }
    throw new Error(message);
  }
}

/**
 * Password sign-up WITHOUT a PKCE challenge, for the same reason as
 * recovery: the confirmation email routinely gets opened on a different
 * device than the one that filled the form (sign up on the laptop, tap the
 * email on the phone), and a ?code= link only works where the verifier
 * lives. Challenge-free keeps the confirmation link token-shaped; the
 * implicit-mode shim consumes it wherever it is opened.
 */
export async function requestEmailSignup(options: {
  supabaseUrl: string;
  anonKey: string;
  email: string;
  password: string;
  redirectTo?: string;
  fetchImpl?: typeof fetch;
}): Promise<void> {
  const { email, password, ...rest } = options;
  await challengeFreeAuthRequest({
    ...rest,
    path: "/auth/v1/signup",
    body: { email, password },
  });
}

/**
 * Email OTP WITHOUT a PKCE challenge. The typed 6-digit code path is
 * context-free either way; this exists for the emailed LINK variant, which
 * some templates include -- under PKCE that link would trap anyone opening
 * it outside the requesting browser.
 */
export async function requestEmailOtp(options: {
  supabaseUrl: string;
  anonKey: string;
  email: string;
  shouldCreateUser?: boolean;
  redirectTo?: string;
  fetchImpl?: typeof fetch;
}): Promise<void> {
  const { email, shouldCreateUser, ...rest } = options;
  await challengeFreeAuthRequest({
    ...rest,
    path: "/auth/v1/otp",
    body: { email, create_user: shouldCreateUser ?? false },
  });
}
