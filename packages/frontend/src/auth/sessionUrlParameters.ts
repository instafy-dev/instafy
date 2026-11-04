/**
 * The URL parameters auth-js acts on when it reads the page's address
 * (access_token, error_description, and a PKCE code), plus the rest of a
 * token-shaped sign-in result, so that none of it lingers in the address.
 * `type`, `mode`, `redirect`, `token` and `state` are not here: the login,
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
