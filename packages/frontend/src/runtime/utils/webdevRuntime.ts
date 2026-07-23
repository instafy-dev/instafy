export const WEBDEV_RUNTIME_LOCAL_IMAGE = "runtime-agent:webdev";
export const WEBDEV_RUNTIME_BUILD_TARGET = "runtime-webdev";
export const WEBDEV_RUNTIME_DISPLAY_NAME = "Webdev runtime (Playwright)";
export const WEBDEV_RUNTIME_FLAVOR = "webdev";
export const DEFAULT_RUNTIME_REMOTE_IMAGE = "ghcr.io/instafy-dev/instafy-runtime-agent:latest";
export const DEFAULT_RUNTIME_LOCAL_IMAGE = WEBDEV_RUNTIME_LOCAL_IMAGE;
export const DEFAULT_RUNTIME_BUILD_TARGET = WEBDEV_RUNTIME_BUILD_TARGET;
export const LEGACY_DEFAULT_RUNTIME_REMOTE_IMAGE = "ghcr.io/instafy-dev/instafy-runtime-agent:latest";
export const LEGACY_DEFAULT_RUNTIME_LOCAL_IMAGE = "runtime-agent:local";
export const BROWSER_SESSION_RUNTIME_ENV: Record<string, string> = {
  INSTAFY_ENABLE_BROWSER_SESSION: "1",
  INSTAFY_VNC_PORT: "5900",
  INSTAFY_VNC_GEOMETRY: "1280x720",
};

function resolveProtocol(protocol?: string): string {
  if (typeof protocol === "string" && protocol.trim().length > 0) {
    return protocol.trim().toLowerCase();
  }
  if (typeof window !== "undefined" && typeof window.location?.protocol === "string") {
    return window.location.protocol.trim().toLowerCase();
  }
  return "";
}

function normalizeHost(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

function readString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function isProductionFrontendBuild(): boolean {
  return Boolean(import.meta.env.PROD) || import.meta.env.MODE === "production";
}

export function shouldUseLocalWebdevRuntime(
  hostname?: string,
  protocol?: string,
  productionBuild = isProductionFrontendBuild(),
): boolean {
  if (productionBuild) {
    return false;
  }
  const resolvedProtocol = resolveProtocol(protocol);
  if (resolvedProtocol === "capacitor:") {
    return false;
  }
  const host =
    normalizeHost(hostname) ||
    (typeof window !== "undefined" ? normalizeHost(window.location.hostname) : "");
  if (!host) {
    return false;
  }
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host === "[::1]" ||
    host.endsWith(".local")
  );
}

export function getWebdevRuntimeEnv(): Record<string, string> {
  // The browser client asks only for a harmless flavor. The exact managed
  // provider maps that flavor to its deploy-pinned image; image and capability
  // environment overrides are never selected by a browser client.
  return { ...BROWSER_SESSION_RUNTIME_ENV };
}

export function getDefaultRuntimeEnv(
  hostname?: string,
  protocol?: string,
  productionBuild?: boolean,
): Record<string, string> {
  if (shouldUseLocalWebdevRuntime(hostname, protocol, productionBuild)) {
    return {
      RUNTIME_AGENT_IMAGE: DEFAULT_RUNTIME_LOCAL_IMAGE,
      RUNTIME_AGENT_BUILD_TARGET: DEFAULT_RUNTIME_BUILD_TARGET,
    };
  }
  // Hosted production providers already have the deploy-selected runtime image.
  // Do not send a frontend image override for the default runtime path.
  return {};
}

export function getDefaultRuntimeMetadata(
  source: string,
  hostname?: string,
  protocol?: string,
  productionBuild?: boolean,
): Record<string, unknown> {
  const env = getDefaultRuntimeEnv(hostname, protocol, productionBuild);
  const metadata: Record<string, unknown> = {
    source,
    runtimeImagePreset: "default",
  };
  if (env.RUNTIME_AGENT_IMAGE) {
    metadata.runtimeAgentImage = env.RUNTIME_AGENT_IMAGE;
  }
  if (Object.keys(env).length > 0) {
    metadata.env = env;
  }
  return metadata;
}

export function extractRuntimeAgentImage(
  metadata: Record<string, unknown> | null | undefined,
): string | null {
  const source = readRecord(metadata);
  if (!source) {
    return null;
  }
  const direct =
    readString(source.runtimeAgentImage) ??
    readString(source.runtime_agent_image) ??
    readString(source["runtime-agent-image"]);
  if (direct) {
    return direct;
  }
  const env = readRecord(source.env);
  if (!env) {
    return null;
  }
  return (
    readString(env.RUNTIME_AGENT_IMAGE) ??
    readString(env.runtime_agent_image) ??
    readString(env.runtimeAgentImage)
  );
}

export function runtimeImageLooksWebdev(imageRef: string | null | undefined): boolean {
  const normalized = normalizeHost(imageRef);
  if (!normalized) {
    return false;
  }
  return (
    normalized.includes("runtime-agent:webdev") ||
    normalized.includes("/instafy-runtime-agent:webdev") ||
    normalized.endsWith(":webdev")
  );
}

export function runtimeImageLooksDefault(imageRef: string | null | undefined): boolean {
  const normalized = normalizeHost(imageRef);
  if (!normalized) {
    return false;
  }
  return (
    normalized === DEFAULT_RUNTIME_LOCAL_IMAGE ||
    normalized === DEFAULT_RUNTIME_REMOTE_IMAGE ||
    normalized === LEGACY_DEFAULT_RUNTIME_LOCAL_IMAGE ||
    normalized === LEGACY_DEFAULT_RUNTIME_REMOTE_IMAGE ||
    normalized.endsWith("/instafy-runtime-agent:latest") ||
    normalized.endsWith(":latest")
  );
}
