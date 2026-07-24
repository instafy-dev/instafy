const DEFAULT_DOWNLOADS_BASE_URL = "https://downloads.instafy.dev";
const DEFAULT_DESKTOP_DOWNLOADS_PREFIX = "desktop-app";

export type DesktopDownloadsBuildEnv = {
  VITE_DOWNLOADS_BASE_URL?: string;
  VITE_DESKTOP_DOWNLOADS_PREFIX?: string;
};

export type DesktopDownloadsConfig = {
  downloadsBaseUrl: string;
  desktopPrefix: string;
  desktopBaseUrl: string;
};

function normalizeDownloadsBaseUrl(value: string | undefined): string {
  const configured = value?.trim() || DEFAULT_DOWNLOADS_BASE_URL;
  let parsed: URL;
  try {
    parsed = new URL(configured);
  } catch {
    throw new Error("VITE_DOWNLOADS_BASE_URL must be a valid HTTPS origin.");
  }

  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.port ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error("VITE_DOWNLOADS_BASE_URL must be a credential-free HTTPS origin.");
  }

  return parsed.origin;
}

function normalizeDesktopPrefix(value: string | undefined): string {
  const prefix = value?.trim() || DEFAULT_DESKTOP_DOWNLOADS_PREFIX;
  if (
    prefix.startsWith("/") ||
    prefix.endsWith("/") ||
    prefix
      .split("/")
      .some((segment) => !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(segment))
  ) {
    throw new Error("VITE_DESKTOP_DOWNLOADS_PREFIX contains an unsafe path segment.");
  }
  return prefix;
}

export function resolveDesktopDownloadsConfig(
  env: DesktopDownloadsBuildEnv,
): DesktopDownloadsConfig {
  const downloadsBaseUrl = normalizeDownloadsBaseUrl(env.VITE_DOWNLOADS_BASE_URL);
  const desktopPrefix = normalizeDesktopPrefix(env.VITE_DESKTOP_DOWNLOADS_PREFIX);
  return {
    downloadsBaseUrl,
    desktopPrefix,
    desktopBaseUrl: `${downloadsBaseUrl}/${desktopPrefix}`,
  };
}

export const desktopDownloadsConfig = resolveDesktopDownloadsConfig(import.meta.env);
