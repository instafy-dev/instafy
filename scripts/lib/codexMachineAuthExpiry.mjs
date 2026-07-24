import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const CODEX_MACHINE_AUTH_MINIMUM_REMAINING_MS = 30 * 60 * 1000;

const MAX_AUTH_JSON_BYTES = 1024 * 1024;
const MAX_ACCESS_TOKEN_CHARS = 64 * 1024;

export class CodexMachineAuthPreflightError extends Error {
  constructor(message) {
    super(message);
    this.name = "CodexMachineAuthPreflightError";
  }
}

function unusableAuthError() {
  return new CodexMachineAuthPreflightError(
    "The runner user's Codex machine-auth file is unavailable or does not contain a readable access-token expiry.",
  );
}

function parseAccessTokenExpiryMs(value) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    value.auth_mode !== "chatgpt"
  ) {
    throw unusableAuthError();
  }
  const tokens = value.tokens;
  if (!tokens || typeof tokens !== "object" || Array.isArray(tokens)) {
    throw unusableAuthError();
  }
  const accessToken = tokens.access_token;
  if (
    typeof accessToken !== "string" ||
    accessToken.length === 0 ||
    accessToken.length > MAX_ACCESS_TOKEN_CHARS
  ) {
    throw unusableAuthError();
  }
  const parts = accessToken.split(".");
  if (parts.length !== 3 || !parts[1]) {
    throw unusableAuthError();
  }
  try {
    const claims = JSON.parse(
      Buffer.from(parts[1], "base64url").toString("utf8"),
    );
    if (
      !claims ||
      typeof claims !== "object" ||
      Array.isArray(claims) ||
      typeof claims.exp !== "number" ||
      !Number.isSafeInteger(claims.exp) ||
      claims.exp <= 0 ||
      claims.exp > Math.floor(Number.MAX_SAFE_INTEGER / 1000)
    ) {
      throw unusableAuthError();
    }
    return claims.exp * 1000;
  } catch (error) {
    if (error instanceof CodexMachineAuthPreflightError) {
      throw error;
    }
    throw unusableAuthError();
  }
}

function readPrivateAuthJson(authPath) {
  const noFollow = fs.constants.O_NOFOLLOW ?? 0;
  let descriptor = null;
  try {
    descriptor = fs.openSync(authPath, fs.constants.O_RDONLY | noFollow);
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_AUTH_JSON_BYTES) {
      throw unusableAuthError();
    }
    if (process.platform !== "win32") {
      const currentUserId =
        typeof process.getuid === "function" ? process.getuid() : null;
      if (
        (currentUserId !== null && stat.uid !== currentUserId) ||
        (stat.mode & 0o077) !== 0
      ) {
        throw unusableAuthError();
      }
    }
    return JSON.parse(fs.readFileSync(descriptor, "utf8"));
  } catch (error) {
    if (error instanceof CodexMachineAuthPreflightError) {
      throw error;
    }
    throw unusableAuthError();
  } finally {
    if (descriptor !== null) {
      try {
        fs.closeSync(descriptor);
      } catch {
        // The sanitized preflight result is sufficient.
      }
    }
  }
}

export function defaultCodexMachineAuthPath() {
  return path.join(os.homedir(), ".codex", "auth.json");
}

export function requireFreshCodexMachineAuth({
  authPath = defaultCodexMachineAuthPath(),
  minimumRemainingMs = CODEX_MACHINE_AUTH_MINIMUM_REMAINING_MS,
  nowMs = Date.now(),
} = {}) {
  if (
    !Number.isFinite(nowMs) ||
    !Number.isFinite(minimumRemainingMs) ||
    minimumRemainingMs < CODEX_MACHINE_AUTH_MINIMUM_REMAINING_MS
  ) {
    throw new CodexMachineAuthPreflightError(
      "The Codex machine-auth preflight configuration is invalid.",
    );
  }
  const expiresAtMs = parseAccessTokenExpiryMs(readPrivateAuthJson(authPath));
  const remainingMs = expiresAtMs - nowMs;
  if (remainingMs < minimumRemainingMs) {
    const remainingMinutes = Math.floor(remainingMs / 60_000);
    throw new CodexMachineAuthPreflightError(
      `The runner user's Codex access token must remain valid for at least 30 minutes (${remainingMinutes} minutes remain). Run codex login on the canary runner, then retry.`,
    );
  }
  return { expiresAtMs, remainingMs };
}
