// The environment of a process started to outlive the command (or Octo turn) that started it.
// SPDX-License-Identifier: AGPL-3.0-only
//
// Shared by `instafy bind serve --detach` and `instafy preview open --start` (the CLI loads this file from its bundled
// copy of the binder), so both strip the same credentials.

const CREDENTIAL_ENV_RE = /(TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|PRIVATE|(^|_)KEY$|_KEY_|API_?KEY)/;

/**
 * `env` without credentials a long-lived process does not need. Such a process outlives the job that started it, and
 * every process in a runtime can read its /proc/<pid>/environ, so it keeps no runtime job token or other CONTROLLER_*
 * value (except CONTROLLER_BASE_URL, which is not secret), no SUPABASE_* value and no credential-like name (space
 * secrets, logins). Names in `keep` are kept anyway. Everything else (PATH, HOME, the space and conversation ids,
 * plain settings) is kept.
 */
export function credentialFreeEnv(env = process.env, keep = []) {
  const out = {};
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) continue;
    const kept =
      keep.includes(name) ||
      name === "CONTROLLER_BASE_URL" ||
      (!/^(CONTROLLER|SUPABASE)_/.test(name) && !CREDENTIAL_ENV_RE.test(name));
    if (kept) out[name] = value;
  }
  return out;
}
