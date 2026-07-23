type PlaywrightEnvironment = Readonly<Record<string, string | undefined>>;

const NON_LOCAL_TARGET_URL_ENV_KEYS = [
  "PLAYWRIGHT_BASE_URL",
  "PLAYWRIGHT_ELECTRON_SHARED_BROWSER_BASE_URL",
  "VITE_SUPABASE_URL",
  "SUPABASE_URL",
] as const;

function isLocalTargetUrl(value: string): boolean {
  try {
    const hostname = new URL(value).hostname.toLowerCase().replace(/^\[|\]$/g, "");
    return (
      hostname === "localhost" ||
      hostname === "::1" ||
      hostname === "0.0.0.0" ||
      hostname === "host.docker.internal" ||
      /^127(?:\.\d{1,3}){3}$/.test(hostname)
    );
  } catch {
    // An unparseable configured target is not safe enough for a generic
    // service-role cleanup. The target-specific fixture must own cleanup.
    return false;
  }
}

/**
 * The shared touched-project log belongs to the local Playwright stack. An
 * external run can inherit stale project ids from another run, so generic
 * teardown must never use that file to mutate a hosted database.
 */
export function shouldSkipGenericTunnelGrantCleanup(
  env: PlaywrightEnvironment,
): boolean {
  if ((env.PLAYWRIGHT_EXTERNAL_BASE_URL ?? "").trim().length > 0) {
    return true;
  }
  if ((env.PLAYWRIGHT_EXTERNAL_STACK ?? "").trim() === "1") {
    return true;
  }

  return NON_LOCAL_TARGET_URL_ENV_KEYS.some((key) => {
    const value = (env[key] ?? "").trim();
    return value.length > 0 && !isLocalTargetUrl(value);
  });
}

export async function runGenericTunnelGrantCleanup(
  env: PlaywrightEnvironment,
  cleanup: () => Promise<void>,
): Promise<boolean> {
  if (shouldSkipGenericTunnelGrantCleanup(env)) {
    return false;
  }
  await cleanup();
  return true;
}
