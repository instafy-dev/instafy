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
