export const DEFAULT_CONTROLLER_URL = "http://127.0.0.1:8788";

export function normalizePlaywrightControllerUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    return DEFAULT_CONTROLLER_URL;
  }
  const normalized = trimmed.includes("host.docker.internal")
    ? trimmed.replace("host.docker.internal", "127.0.0.1")
    : trimmed;
  return normalized.replace(/\/+$/, "");
}

export function resolvePlaywrightControllerUrl(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const raw =
    env.PLAYWRIGHT_CONTROLLER_URL ||
    env.CONTROLLER_URL ||
    env.VITE_CONTROLLER_URL ||
    DEFAULT_CONTROLLER_URL;
  return normalizePlaywrightControllerUrl(raw);
}
