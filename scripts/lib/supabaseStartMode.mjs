// Supabase CLI v2.92.0 --exclude uses image basenames. Auth email needs
// Postgres, GoTrue, Kong, Mailpit and PostgREST (status exposes API_URL through
// PostgREST). Keep this fixed profile coupled to the serial image selection.
export const AUTH_ONLY_EXCLUDED_CONTAINERS = Object.freeze([
  "realtime", "storage-api", "imgproxy", "edge-runtime", "postgres-meta",
  "studio", "logflare", "vector", "supavisor",
]);

// These browser fixtures call local Auth, database and controller APIs, never
// Edge Functions. Preserve every other service in this explicit test profile.
export const BROWSER_TEST_EXCLUDED_CONTAINERS = Object.freeze(["edge-runtime"]);

export function parseSupabaseDatabaseOnly(value) {
  if (value == null || value === "" || value === "0") {
    return false;
  }
  if (value === "1") {
    return true;
  }
  throw new Error("SUPABASE_DATABASE_ONLY must be unset, 0, or 1");
}

export function parseSupabaseAuthOnly(value) {
  if (value == null || value === "" || value === "0") return false;
  if (value === "1") return true;
  throw new Error("SUPABASE_AUTH_ONLY must be unset, 0, or 1");
}

export function parseSupabaseBrowserTest(value) {
  if (value == null || value === "" || value === "0") return false;
  if (value === "1") return true;
  throw new Error("SUPABASE_BROWSER_TEST must be unset, 0, or 1");
}

export function resolveSupabaseStartMode(databaseValue, authValue, browserValue) {
  const databaseOnly = parseSupabaseDatabaseOnly(databaseValue);
  const authOnly = parseSupabaseAuthOnly(authValue);
  const browserTest = parseSupabaseBrowserTest(browserValue);
  if (databaseOnly && authOnly) {
    throw new Error("SUPABASE_DATABASE_ONLY and SUPABASE_AUTH_ONLY are mutually exclusive");
  }
  if (browserTest && (databaseOnly || authOnly)) {
    throw new Error("SUPABASE_BROWSER_TEST, SUPABASE_DATABASE_ONLY and SUPABASE_AUTH_ONLY are mutually exclusive");
  }
  return databaseOnly ? "database" : authOnly ? "auth-email" : browserTest ? "browser-test" : "full";
}

export function buildSupabaseStartArgs(
  value,
  { ignoreHealthCheck = false, authOnly, browserTest } = {},
) {
  const mode = resolveSupabaseStartMode(value, authOnly, browserTest);
  if (mode === "database") {
    return ["db", "start"];
  }
  const args = ["start"];
  if (mode === "auth-email") args.push("--exclude", AUTH_ONLY_EXCLUDED_CONTAINERS.join(","));
  if (mode === "browser-test") args.push("--exclude", BROWSER_TEST_EXCLUDED_CONTAINERS.join(","));
  if (ignoreHealthCheck) args.push("--ignore-health-check");
  return args;
}
