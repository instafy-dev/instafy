export const INSTAFY_DESKTOP_PROTOCOL = "instafy";

const TRUSTED_PRODUCTION_ORIGIN = "https://prod.instafy.dev";
const PROTECTED_CONTROLLER_QUERY_KEYS = new Set([
  "controlleraccesstoken",
  "controllerurl",
]);

function hasProtectedControllerOverride(parsed: URL): boolean {
  for (const key of parsed.searchParams.keys()) {
    if (PROTECTED_CONTROLLER_QUERY_KEYS.has(key.trim().toLowerCase())) {
      return true;
    }
  }
  return false;
}

function normalizeRoutePath(pathname: string): string {
  const trimmed = pathname.trim();
  if (!trimmed) {
    return "/";
  }
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

function buildDeepLinkRoutePath(parsed: URL): string {
  const host = parsed.hostname.trim();
  const pathname = parsed.pathname.trim();
  if (pathname && pathname !== "/") {
    return normalizeRoutePath(pathname);
  }
  if (host) {
    return normalizeRoutePath(host);
  }
  return "/";
}

export function findInstafyDesktopDeepLinkArg(argv: string[]): string | null {
  return (
    argv.find((arg) =>
      arg.trim().toLowerCase().startsWith(`${INSTAFY_DESKTOP_PROTOCOL}://`),
    ) ?? null
  );
}

export function resolveDesktopDeepLinkTargetUrl(rawUrl: string, startUrl: string): string | null {
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

  if (parsed.protocol.toLowerCase() !== `${INSTAFY_DESKTOP_PROTOCOL}:`) {
    return null;
  }

  const routePath = buildDeepLinkRoutePath(parsed);
  if (routePath === "/auth") {
    // Not a navigation target: an auth callback carries the session in its
    // fragment and must reach the renderer as data. Loading it as a URL would
    // discard the fragment and strand the sign-in. See
    // isDesktopAuthCallbackDeepLink, which the caller uses to route it.
    return null;
  }

  let target: URL;
  try {
    target = new URL(startUrl);
  } catch {
    return null;
  }

  if (
    target.origin === TRUSTED_PRODUCTION_ORIGIN &&
    hasProtectedControllerOverride(parsed)
  ) {
    return null;
  }

  target.pathname = routePath;
  target.search = parsed.search;
  target.hash = parsed.hash;
  return target.toString();
}

// An OAuth provider returning through instafy://auth#access_token=... . The
// shell must hand this to the renderer rather than navigate to it: the
// fragment is the session, and navigation drops it.
export function isDesktopAuthCallbackDeepLink(rawUrl: string | null | undefined): boolean {
  if (typeof rawUrl !== "string" || !rawUrl.trim()) {
    return false;
  }
  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    return false;
  }
  if (parsed.protocol.toLowerCase() !== `${INSTAFY_DESKTOP_PROTOCOL}:`) {
    return false;
  }
  return buildDeepLinkRoutePath(parsed) === "/auth";
}
