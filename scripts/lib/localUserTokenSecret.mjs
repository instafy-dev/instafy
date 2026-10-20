import { ensureLocalSecret } from "./localSecret.mjs";

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
  return ensureLocalSecret({
    explicit,
    filePath,
    minBytes: MIN_USER_TOKEN_SECRET_BYTES,
    label: "controller session secret",
    warn,
  });
}
