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
