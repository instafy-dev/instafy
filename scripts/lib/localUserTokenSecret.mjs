import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// The controller's floor outside DEV_MODE (RFC 7518 section 3.2 for HS256).
export const MIN_USER_TOKEN_SECRET_BYTES = 32;

/**
 * Resolve USER_TOKEN_SECRET for a controller launched by the local harness.
 *
 * An explicit value wins and is left for the controller to validate. Otherwise
 * a random per-checkout secret is generated once and kept, owner-only, at
 * `filePath`, so restarts keep sessions valid and no local controller signs
 * sessions with the development fallback published in the source.
 */
export function ensureLocalUserTokenSecret({ explicit, filePath, warn = console.warn }) {
  const configured = String(explicit ?? "").trim();
  if (configured) {
    return configured;
  }

  try {
    const stored = fs.readFileSync(filePath, "utf-8").trim();
    if (Buffer.byteLength(stored, "utf-8") >= MIN_USER_TOKEN_SECRET_BYTES) {
      return stored;
    }
  } catch {}

  const generated = crypto.randomBytes(32).toString("hex");
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${generated}\n`, { encoding: "utf-8", mode: 0o600 });
    // `mode` applies only when the file is created; tighten a replaced one too.
    fs.chmodSync(filePath, 0o600);
  } catch (error) {
    warn(
      `[runtime-dev] Unable to persist the controller session secret ${filePath}: ${error.message}`
    );
  }
  return generated;
}
