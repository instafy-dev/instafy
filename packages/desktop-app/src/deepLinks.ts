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

  // Custom-protocol URLs cross OS/process boundaries and can be retained in
  // launch history, so controller bindings must never be transported in them.
  if (hasProtectedControllerOverride(parsed)) {
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
