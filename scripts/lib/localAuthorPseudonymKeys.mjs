import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// The controller's bounds for one keyring entry (runtime-controller
// author_identity.rs): `v<version>:<base64 key of 32 to 64 bytes>`.
const MIN_KEY_BYTES = 32;
const MAX_KEY_BYTES = 64;
const ENTRY_PATTERN = /^v[1-9][0-9]{0,3}:([A-Za-z0-9+/]+={0,2})$/;

/** Whether `raw` is a keyring the controller would accept. */
export function isValidAuthorPseudonymKeys(raw) {
  const entries = String(raw ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (entries.length === 0) {
    return false;
  }
  const versions = new Set();
  const keys = new Set();
  for (const entry of entries) {
    const match = ENTRY_PATTERN.exec(entry);
    if (!match || match[1].length % 4 !== 0) {
      return false;
    }
    const version = entry.slice(0, entry.indexOf(":"));
    const key = Buffer.from(match[1], "base64");
    // One key per version, and a new version needs a new key.
    if (versions.has(version) || keys.has(key.toString("hex"))) {
      return false;
    }
    versions.add(version);
    keys.add(key.toString("hex"));
    if (key.length < MIN_KEY_BYTES || key.length > MAX_KEY_BYTES) {
      return false;
    }
  }
  return true;
}

/**
 * Resolve INSTAFY_AUTHOR_PSEUDONYM_KEYS for a controller launched by the
 * local harness. The controller refuses to start with a hosted gateway
 * endpoint and no keyring.
 *
 * An explicit value wins and is left for the controller to validate.
 * Otherwise a random per-checkout key is generated once and kept,
 * owner-only, at `filePath`. A stored keyring is never replaced while it is
 * valid: replacing it would rename every local author.
 */
export function ensureLocalAuthorPseudonymKeys({ explicit, filePath, warn = console.warn }) {
  const configured = String(explicit ?? "").trim();
  if (configured) {
    return configured;
  }

  try {
    const stored = fs.readFileSync(filePath, "utf-8").trim();
    if (isValidAuthorPseudonymKeys(stored)) {
      return stored;
    }
  } catch {}

  const generated = `v1:${crypto.randomBytes(32).toString("base64")}`;
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${generated}\n`, { encoding: "utf-8", mode: 0o600 });
    // `mode` applies only when the file is created; tighten a replaced one too.
    fs.chmodSync(filePath, 0o600);
  } catch (error) {
    warn(
      `[runtime-dev] Unable to persist the author pseudonym keys ${filePath}: ${error.message}`
    );
  }
  return generated;
}
