export const INSTAFY_DESKTOP_PROTOCOL = "instafy";

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

// The parameters the page's auth client acts on when it reads its own
// address, plus the rest of a token-shaped sign-in result. Sign-in results
// come back through instafy://auth only, so a navigation link carrying one
// was not made by Instafy: opened as a page, it would replace or end the
// session.
const SESSION_QUERY_KEYS = new Set([
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

function hasSessionParameter(parsed: URL): boolean {
  for (const key of parsed.searchParams.keys()) {
    if (SESSION_QUERY_KEYS.has(key.trim().toLowerCase())) {
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
    // Not a navigation target: an auth callback reaches the renderer as data,
    // and the renderer decides whether it belongs to a sign-in it started.
    // See isDesktopAuthCallbackDeepLink, which the caller uses to route it.
    return null;
  }

  let target: URL;
  try {
    target = new URL(startUrl);
  } catch {
    return null;
  }

  // Custom-protocol URLs cross OS/process boundaries and can be retained in
  // launch history, so controller bindings must never be transported in them.
  if (hasProtectedControllerOverride(parsed)) {
    return null;
  }
  // Nor session state: see SESSION_QUERY_KEYS.
  if (hasSessionParameter(parsed)) {
    return null;
  }

  target.pathname = routePath;
  target.search = parsed.search;
  // No Instafy link carries a fragment, and the page's auth client reads one
  // (#access_token=..., #error_description=...) the way it reads the query.
  target.hash = "";
  return target.toString();
}

// An OAuth provider returning through instafy://auth?code=... (or with a
// fragment). The shell must hand this to the renderer rather than navigate to
// it: navigation drops the fragment, and the renderer decides whether the
// callback belongs to a sign-in it started.
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

/** How long the shell holds an auth callback no window has collected yet. */
export const DESKTOP_AUTH_CALLBACK_TTL_MS = 10 * 60 * 1000;

/**
 * The one auth callback the shell holds for a renderer that is not listening
 * yet (a cold start, or no window open). A sign-in collects its callback
 * within seconds of it arriving; one left over long after that belongs to no
 * sign-in anyone is waiting for, so it expires instead of reaching whichever
 * login screen opens next. Taking it always empties the slot.
 */
export function createHeldDesktopAuthCallback({
  ttlMs = DESKTOP_AUTH_CALLBACK_TTL_MS,
  now = Date.now,
}: { ttlMs?: number; now?: () => number } = {}) {
  let held: { url: string; receivedAt: number } | null = null;
  return {
    hold(url: string): void {
      held = { url, receivedAt: now() };
    },
    take(): string | null {
      const current = held;
      held = null;
      if (!current) {
        return null;
      }
      return Math.abs(now() - current.receivedAt) <= ttlMs ? current.url : null;
    },
  };
}

/** Only IDs-only Studio notification routes may cross the renderer IPC boundary. */
export function resolveDesktopNotificationTargetUrl(value: unknown, startUrl: string): string | null {
  if (typeof value !== "string" || value.length > 512 || !value.startsWith("/") || value.startsWith("//")) return null;
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  try {
    const base = new URL(startUrl);
    const url = new URL(value, base);
    if (url.origin !== base.origin || url.pathname !== "/studio" || url.hash) return null;
    const keys = [...url.searchParams.keys()];
    const support = url.searchParams.get("supportReportId");
    const project = url.searchParams.get("projectId");
    const conversation = url.searchParams.get("conversationControllerId");
    if (keys.length === 0 || (keys.length === 1 && support && uuid.test(support)) ||
      (keys.length === 1 && project && uuid.test(project)) ||
      (keys.length === 2 && project && conversation && uuid.test(project) && uuid.test(conversation)) ||
      (keys.length === 2 && project && uuid.test(project) && url.searchParams.get("panel") === "automations")) return url.toString();
  } catch { /* Reject malformed URLs. */ }
  return null;
}

const SAFE_NOTIFICATION_BODIES = new Set(["There is a new reply to your support report.", "Your support report has been resolved.", "There is a new reply in your conversation.", "A run could not finish.", "Your automation has finished.", "Your automation could not finish."]);
export function resolveDesktopNotificationBody(value: unknown): string {
  return typeof value === "string" && SAFE_NOTIFICATION_BODIES.has(value) ? value : "You have a new notification.";
}

/** Preserve event identity through a cold start/login without carrying notification content. */
export function resolveDesktopNotificationClickTargetUrl(payload: unknown, startUrl: string): string | null {
  if (!payload || typeof payload !== "object") return null;
  const value = payload as Record<string, unknown>;
  const target = resolveDesktopNotificationTargetUrl(value.url, startUrl);
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!target || typeof value.eventId !== "string" || typeof value.accountId !== "string" ||
    !uuid.test(value.eventId) || !uuid.test(value.accountId)) return null;
  const url = new URL(target);
  url.searchParams.set("notificationEventId", value.eventId.toLowerCase());
  url.searchParams.set("notificationAccountId", value.accountId.toLowerCase());
  return url.toString();
}
