import { App } from "@capacitor/app";
import { Capacitor } from "@capacitor/core";
import { resolvePublicAppOrigin } from "../utils/publicAppUrl";
import { isUUID } from "../utils/uuid";
import {
  NATIVE_AUTH_CALLBACK_SCHEME,
  NATIVE_AUTH_LEGACY_CALLBACK_SCHEME,
  parseNativeAuthCallbackUrl,
} from "../auth/nativeAuth";
import { writePendingProjectSwitch } from "../screens/pendingProjectSwitch";

type RouterLike = {
  navigate: (to: string, options?: { replace?: boolean }) => unknown;
};

const SUPPORTED_NATIVE_SCHEMES = new Set([
  NATIVE_AUTH_CALLBACK_SCHEME,
  NATIVE_AUTH_LEGACY_CALLBACK_SCHEME,
]);

function normalizeRoutePath(pathname: string): string {
  const trimmed = pathname.trim();
  if (!trimmed) {
    return "/";
  }
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

function buildNativeRoutePath(parsed: URL): string {
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

function isSupportedNativeScheme(protocol: string): boolean {
  return SUPPORTED_NATIVE_SCHEMES.has(protocol.replace(/:$/, "").toLowerCase());
}

function isAllowedHttpHost(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase();
  if (!normalized) {
    return false;
  }

  const allowedHosts = new Set<string>();
  try {
    allowedHosts.add(new URL(resolvePublicAppOrigin()).hostname.toLowerCase());
  } catch {
    // ignore invalid configured app origins
  }

  if (typeof window !== "undefined" && typeof window.location?.hostname === "string") {
    const currentHost = window.location.hostname.trim().toLowerCase();
    if (currentHost) {
      allowedHosts.add(currentHost);
    }
  }

  return allowedHosts.has(normalized);
}

export function buildNativeStudioDeepLink(params: {
  projectId: string;
  conversationControllerId?: string | null;
  panel?: string | null;
}): string {
  const search = new URLSearchParams();
  search.set("projectId", params.projectId);
  if (params.conversationControllerId) {
    search.set("conversationControllerId", params.conversationControllerId);
  }
  if (params.panel) {
    search.set("panel", params.panel);
  }
  return `instafy://studio?${search.toString()}`;
}

export function resolveNativeAppNavigationTarget(rawUrl: string): string | null {
  const trimmed = rawUrl.trim();
  if (!trimmed) {
    return null;
  }
  if (parseNativeAuthCallbackUrl(trimmed)) {
    return null;
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }

  const protocol = parsed.protocol.toLowerCase();
  let routePath: string | null = null;

  if (isSupportedNativeScheme(protocol)) {
    routePath = buildNativeRoutePath(parsed);
  } else if ((protocol === "https:" || protocol === "http:") && isAllowedHttpHost(parsed.hostname)) {
    routePath = normalizeRoutePath(parsed.pathname);
  } else {
    return null;
  }

  if (routePath === "/auth") {
    return null;
  }

  return `${routePath}${parsed.search}${parsed.hash}`;
}

export function installNativeDeepLinkBootstrap(router: RouterLike): void {
  if (!Capacitor.isNativePlatform()) {
    return;
  }

  let lastHandledUrl: string | null = null;
  let lastHandledAt = 0;

  const maybeNavigate = (rawUrl: string | null | undefined) => {
    if (typeof rawUrl !== "string") {
      return;
    }
    const trimmed = rawUrl.trim();
    if (!trimmed) {
      return;
    }

    const now = Date.now();
    if (trimmed === lastHandledUrl && now - lastHandledAt < 5_000) {
      return;
    }

    const target = resolveNativeAppNavigationTarget(trimmed);
    if (!target) {
      return;
    }

    if (typeof window !== "undefined") {
      try {
        const parsedTarget = new URL(target, window.location.origin);
        const rawProjectId = parsedTarget.searchParams.get("projectId");
        const projectId = rawProjectId && isUUID(rawProjectId.trim()) ? rawProjectId.trim() : null;
        if (projectId) {
          writePendingProjectSwitch(projectId, now);
        }
      } catch {
        // Ignore malformed deep-link targets and fall back to normal navigation.
      }
    }

    lastHandledUrl = trimmed;
    lastHandledAt = now;
    void router.navigate(target);
  };

  void App.getLaunchUrl()
    .then((launchUrl) => {
      maybeNavigate(launchUrl?.url ?? null);
    })
    .catch(() => undefined);

  void App.addListener("appUrlOpen", (event: { url?: string | null }) => {
    maybeNavigate(event.url);
  }).catch(() => undefined);
}
