import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * Resolve a secret for a service launched by the local harness.
 *
 * An explicit value wins and is left for the service to validate. Otherwise a
 * random per-checkout secret is generated once and kept, owner-only, at
 * `filePath`, so restarts agree on it and no local service relies on a value
 * published in the source. A stored value shorter than `minBytes` is replaced.
 * `label` names the secret in the warning when it cannot be kept; the value
 * itself is never printed.
 */
export function ensureLocalSecret({ explicit, filePath, minBytes = 32, label = "secret", warn = console.warn }) {
  const configured = String(explicit ?? "").trim();
  if (configured) {
    return configured;
  }

  try {
    const stored = fs.readFileSync(filePath, "utf-8").trim();
    if (Buffer.byteLength(stored, "utf-8") >= minBytes) {
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
    warn(`[runtime-dev] Unable to persist the ${label} ${filePath}: ${error.message}`);
  }
  return generated;
}
