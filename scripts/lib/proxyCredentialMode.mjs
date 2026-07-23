import path from "node:path";

const ENABLED_VALUES = new Set(["1", "true", "yes", "on"]);

/**
 * Local Studio uses controller-backed, per-user credentials by default.
 * Static proxy credentials are a legacy debugging path and must be opted into
 * explicitly; ambient OPENAI_API_KEY/CODEX_* variables never select it.
 */
export function localProxyStaticAuthEnabled(env = process.env) {
  const value = String(env.RUNTIME_PROXY_STATIC_AUTH ?? "")
    .trim()
    .toLowerCase();
  return ENABLED_VALUES.has(value);
}

export function localProxyCredentialMode(env = process.env) {
  return localProxyStaticAuthEnabled(env) ? "remote_static" : "remote_dynamic";
}

/**
 * BYOC startup may remove a stale credential only from its repo-owned,
 * disposable directory. It must never unlink an ambient or user-owned path.
 */
export function isIsolatedByocProxyAuthPath(authPath, byocRoot) {
  if (!authPath || !byocRoot) return false;
  return (
    path.resolve(authPath) === path.resolve(path.join(byocRoot, "auth.json"))
  );
}
