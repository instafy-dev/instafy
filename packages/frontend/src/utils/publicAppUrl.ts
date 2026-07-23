import { Capacitor } from "@capacitor/core";

const DEFAULT_PUBLIC_APP_ORIGIN = "https://instafy.dev";

function readConfiguredPublicAppOrigin(): string | null {
  const configured = import.meta.env.VITE_PUBLIC_APP_URL;
  if (typeof configured !== "string") {
    return null;
  }
  const trimmed = configured.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function resolvePublicAppOrigin(): string {
  const configured = readConfiguredPublicAppOrigin();
  if (configured) {
    return configured;
  }
  if (typeof window !== "undefined" && !Capacitor.isNativePlatform()) {
    return window.location.origin;
  }
  return DEFAULT_PUBLIC_APP_ORIGIN;
}

export function resolvePublicAppUrl(path: string): string {
  const normalizedPath = path.trim().startsWith("/") ? path.trim() : `/${path.trim()}`;
  return new URL(normalizedPath, resolvePublicAppOrigin()).toString();
}
