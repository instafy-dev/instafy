export function parseSupabaseDatabaseOnly(value) {
  if (value == null || value === "" || value === "0") {
    return false;
  }
  if (value === "1") {
    return true;
  }
  throw new Error("SUPABASE_DATABASE_ONLY must be unset, 0, or 1");
}

export function buildSupabaseStartArgs(
  value,
  { ignoreHealthCheck = false } = {},
) {
  if (parseSupabaseDatabaseOnly(value)) {
    return ["db", "start"];
  }
  return ignoreHealthCheck ? ["start", "--ignore-health-check"] : ["start"];
}
