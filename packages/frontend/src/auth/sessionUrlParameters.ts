/**
 * The URL parameters auth-js acts on when it reads the page's address
 * (access_token, error_description, and a PKCE code), plus the rest of a
 * token-shaped sign-in result, so that none of it lingers in the address.
 * `type`, `mode`, `redirect`, `token` and `cliState` are not here: the login,
 * recovery, invite and CLI pages read them.
 */
const SESSION_URL_PARAMETERS = new Set([
  "access_token",
  "refresh_token",
  "code",
  "error",
  "error_code",
  "error_description",
  "provider_token",
  "provider_refresh_token",
  "expires_in",
  "expires_at",
  "token_type",
]);

function isSessionUrlParameter(key: string): boolean {
  return SESSION_URL_PARAMETERS.has(key.trim().toLowerCase());
}

/**
 * The address without its session parameters, or null when it has none.
 *
 * The query loses only those keys. A fragment carrying any of them is dropped
 * whole: auth-js reads the entire fragment as parameters (a hash-router
 * fragment such as `#/route?error_description=x` included), and no page needs
 * a fragment shaped like that.
 */
export function withoutSessionUrlParameters(href: string): string | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }

  let changed = false;
  const query = new URLSearchParams(url.search);
  for (const key of [...query.keys()]) {
    if (isSessionUrlParameter(key)) {
      query.delete(key);
      changed = true;
    }
  }
  if (changed) {
    const remaining = query.toString();
    url.search = remaining ? `?${remaining}` : "";
  }

  const fragment = url.hash.replace(/^#/, "");
  if (fragment && [...new URLSearchParams(fragment).keys()].some(isSessionUrlParameter)) {
    url.hash = "";
    changed = true;
  }

  return changed ? url.toString() : null;
}

const ERROR_URL_PARAMETERS = new Set(["error", "error_code", "error_description"]);

function isErrorUrlParameter(key: string): boolean {
  return ERROR_URL_PARAMETERS.has(key.trim().toLowerCase());
}

/** The address without error parameters, or null when it has none. */
function withoutErrorUrlParameters(url: URL): string | null {
  let changed = false;
  const query = new URLSearchParams(url.search);
  for (const key of [...query.keys()]) {
    if (isErrorUrlParameter(key)) {
      query.delete(key);
      changed = true;
    }
  }
  if (changed) {
    const remaining = query.toString();
    url.search = remaining ? `?${remaining}` : "";
  }
  const fragment = url.hash.replace(/^#/, "");
  if (fragment && [...new URLSearchParams(fragment).keys()].some(isErrorUrlParameter)) {
    url.hash = "";
    changed = true;
  }
  return changed ? url.toString() : null;
}

/** The parameters the way auth-js reads them: the fragment's, then the query's, which win. */
function authUrlParameters(url: URL): Map<string, string> {
  const params = new Map<string, string>();
  const fragment = url.hash.replace(/^#/, "");
  if (fragment) {
    for (const [key, value] of new URLSearchParams(fragment)) {
      params.set(key, value);
    }
  }
  for (const [key, value] of url.searchParams) {
    params.set(key, value);
  }
  return params;
}

/**
 * The key supabase-js stores the session under when none is given: the first
 * label of the project URL's hostname (sb-127-auth-token for a local stack).
 */
export function supabaseAuthStorageKey(supabaseUrl: string | null | undefined): string | null {
  const trimmed = (supabaseUrl ?? "").trim();
  if (!/^https?:\/\//i.test(trimmed)) {
    return null;
  }
  try {
    const base = new URL(trimmed.endsWith("/") ? trimmed : `${trimmed}/`);
    return `sb-${base.hostname.split(".")[0]}-auth-token`;
  } catch {
    return null;
  }
}

/**
 * The claims of a JSON web token, read without checking its signature. Only
 * for deciding what to show or which way to go; never proof of anything.
 */
export function unverifiedJwtClaims(token: string): { sub?: string; email?: string } | null {
  const parts = token.split(".");
  if (parts.length !== 3) {
    return null;
  }
  try {
    const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
    const bytes = Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
    const payload: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (!payload || typeof payload !== "object") {
      return null;
    }
    const { sub, email } = payload as { sub?: unknown; email?: unknown };
    return {
      sub: typeof sub === "string" ? sub : undefined,
      email: typeof email === "string" ? email : undefined,
    };
  } catch {
    return null;
  }
}

export type StoredSessionUser = { id: string; email: string | null };

/**
 * Who the stored session belongs to, read the way auth-js would find it, or
 * null when no usable session is stored (or storage cannot be read).
 */
export function readStoredSessionUser(
  storage: Pick<Storage, "getItem"> | null | undefined,
  storageKey: string | null,
): StoredSessionUser | null {
  if (!storage || !storageKey) {
    return null;
  }
  let session: unknown;
  try {
    const raw = storage.getItem(storageKey);
    session = raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
  if (!session || typeof session !== "object") {
    return null;
  }
  const { access_token: accessToken, refresh_token: refreshToken, user } = session as Record<string, unknown>;
  if (typeof accessToken !== "string" || typeof refreshToken !== "string" || !("expires_at" in session)) {
    return null;
  }
  const claims = unverifiedJwtClaims(accessToken);
  const storedUser = user && typeof user === "object" ? (user as { id?: unknown; email?: unknown }) : {};
  const id = typeof storedUser.id === "string" ? storedUser.id : claims?.sub;
  if (!id) {
    return null;
  }
  const email = typeof storedUser.email === "string" ? storedUser.email : (claims?.email ?? null);
  return { id, email };
}

/** Another account's sign-in a link carried, held until the person chooses it. */
export type OtherAccountLink = {
  accessToken: string;
  refreshToken: string;
  /** Read from the token without checking it: shown to the person, never trusted. */
  email: string | null;
  /** A password-reset link: the reset form follows once the person switches. */
  recovery: boolean;
};

/**
 * The signed-in account's own sign-in a link carried. Checked with the server
 * after start-up and then put in place of the stored session, which may be
 * dead (signed out elsewhere) or too old for a password change.
 */
export type OwnAccountLink = {
  userId: string;
  accessToken: string;
  refreshToken: string;
};

export type WebSessionAddress = {
  /** The address to put in place before the client starts, or null to leave it. */
  cleaned: string | null;
  /** A PKCE code to exchange explicitly, which cannot end the session if it fails. */
  deferredCode: string | null;
  otherAccountLink: OtherAccountLink | null;
  ownAccountLink: OwnAccountLink | null;
};

/**
 * Storage this page cannot read or write. Nobody can then be told apart, so
 * the address is treated as it is when someone is signed in.
 */
export const UNREADABLE_SESSION_STORAGE = "unreadable";

function isRecoveryMarker(value: string | null | undefined): boolean {
  return (value ?? "").trim().toLowerCase() === "recovery";
}

/**
 * What the web page does with its address before the Supabase client reads
 * it, given who is signed in.
 *
 * Signed out, the address works as it always has: an OAuth return, or a link
 * from an email opened on any device. Only its error parameters are removed:
 * nothing shows them, and auth-js answers one by deleting the PKCE verifier of
 * a sign-in that another tab may have in progress.
 *
 * Signed in, nothing in the address may end or replace the session, so every
 * session parameter is removed and auth-js finds nothing to act on.
 * - A PKCE code this browser can redeem (its verifier is stored) is handed
 *   back to be exchanged explicitly: a failed explicit exchange leaves the
 *   session alone, where auth-js reading it from the address would remove it.
 * - Tokens are never consumed: auth-js checks them with the server and
 *   removes the session when that fails, which a forged token would arrange.
 *   A link for the signed-in account is handed back to be checked and applied
 *   (ownAccountLink), and its reset form stays. Another account's link is held
 *   for the person to choose on the login page, where the address moves.
 * - A link that failed (it expired, or was already used) cannot say whose it
 *   was. It and another account's link lose the reset marker, so the reset
 *   form never acts on the account that is signed in.
 */
export function decideWebSessionAddress({
  href,
  signedInUser,
  hasCodeVerifier,
}: {
  href: string;
  signedInUser: StoredSessionUser | typeof UNREADABLE_SESSION_STORAGE | null;
  hasCodeVerifier: boolean;
}): WebSessionAddress {
  const unchanged: WebSessionAddress = {
    cleaned: null,
    deferredCode: null,
    otherAccountLink: null,
    ownAccountLink: null,
  };
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return unchanged;
  }

  if (!signedInUser) {
    return { ...unchanged, cleaned: withoutErrorUrlParameters(url) };
  }

  const params = authUrlParameters(url);
  const stripped = withoutSessionUrlParameters(href);
  if (!stripped) {
    return unchanged;
  }
  const cleanedUrl = new URL(stripped);
  const decision: WebSessionAddress = { ...unchanged };
  const removeRecoveryMarkers = () => {
    for (const key of ["mode", "type"]) {
      if (isRecoveryMarker(cleanedUrl.searchParams.get(key))) {
        cleanedUrl.searchParams.delete(key);
      }
    }
  };

  const hasError = ["error", "error_code", "error_description"].some((key) => params.has(key));
  if (hasError) {
    removeRecoveryMarkers();
  }
  const code = (params.get("code") ?? "").trim();
  if (code && hasCodeVerifier && !hasError && signedInUser !== UNREADABLE_SESSION_STORAGE) {
    decision.deferredCode = code;
  }

  const accessToken = (params.get("access_token") ?? "").trim();
  const refreshToken = (params.get("refresh_token") ?? "").trim();
  if (accessToken && !hasError) {
    const recovery = isRecoveryMarker(params.get("type")) || isRecoveryMarker(url.searchParams.get("mode"));
    const claims = unverifiedJwtClaims(accessToken);
    const accountId = signedInUser === UNREADABLE_SESSION_STORAGE ? null : signedInUser.id;
    if (accountId && claims?.sub && claims.sub.toLowerCase() === accountId.toLowerCase()) {
      if (recovery) {
        cleanedUrl.pathname = "/login";
        cleanedUrl.searchParams.set("mode", "recovery");
      }
      if (refreshToken) {
        decision.ownAccountLink = { userId: accountId, accessToken, refreshToken };
      }
    } else {
      removeRecoveryMarkers();
      if (refreshToken) {
        decision.otherAccountLink = { accessToken, refreshToken, email: claims?.email ?? null, recovery };
        cleanedUrl.pathname = "/login";
      }
    }
  }

  decision.cleaned = cleanedUrl.toString();
  return decision;
}
