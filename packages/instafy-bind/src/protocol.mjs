// Message shapes shared by the binder and the bind client (map-pack ENGINE-SPEC v0.2 §9.3-§9.4).
import { randomBytes } from "node:crypto";

export const PROTOCOL_VERSION = 2;
export const HOST_SOURCE = "instafy-host";
export const INTENT_SOURCES = ["instafy-map", "instafy-site"];
export const HOST_TYPES = ["hello", "ack", "progress", "results", "done", "error", "command"];
export const ACK_STATUSES = ["queued", "needs_confirm", "rejected", "running"];
export const ERROR_CODES = ["not_found", "timeout", "policy", "upstream", "unavailable", "invalid", "cancelled", "dry_run", "internal"];
export const COMMAND_NAMES = ["select", "flyTo", "setLens", "setTime", "highlight", "toast", "reload"];
export const RESERVED_INTENTS = ["cancel"];

export const INTENT_ID_RE = /^int_[a-z0-9]{1,12}_[a-z0-9]{2,8}$/;
export const INTENT_NAME_RE = /^[a-z][a-z0-9_]{0,47}$/;
/** The records-schema ref shape without whitespace or other free text: "<collection>:<id>". */
export const ENVELOPE_REF_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,47}:[A-Za-z0-9_.:-]{1,120}$/;
/** ui and attr hints from the page: short tokens only (they reach logs, prompts and other viewers). */
export const ENVELOPE_TOKEN_RE = /^[A-Za-z0-9_.:-]{1,60}$/;
/** Cancel keys returned to the submitting viewer only. */
export const CANCEL_KEY_RE = /^[A-Za-z0-9_-]{16,64}$/;
/** The whole POST body. */
export const MAX_INTENT_BYTES = 8 * 1024;
/** Serialised params (map-pack §9.2). */
export const MAX_PARAMS_BYTES = 4 * 1024;
export const MAX_COMMAND_BYTES = 4 * 1024;

const base36 = (bytes) => [...randomBytes(bytes)].map((b) => (b % 36).toString(36)).join("");

/** "int_" + base36(now) + "_" + 4 random base36 characters. */
export function newIntentId(now = Date.now()) {
  return `int_${now.toString(36)}_${base36(4)}`;
}

export function newJobId(now = Date.now()) {
  return `job_${now.toString(36)}_${base36(6)}`;
}

/** Host -> site message with the protocol envelope. */
export function hostMessage(type, fields = {}) {
  return { source: HOST_SOURCE, v: PROTOCOL_VERSION, type, ...fields, at: new Date().toISOString() };
}

/** Clip text for progress/error messages (140 characters, like map-pack). */
export function clip(text, max = 140) {
  const value = String(text ?? "").replace(/\s+/g, " ").trim();
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/**
 * Structural check of an intent message before the per-intent params check.
 * Returns null when the envelope is fine, else a short reason.
 */
export function checkIntentEnvelope(msg) {
  if (!msg || typeof msg !== "object" || Array.isArray(msg)) return "body must be a JSON object";
  if (!INTENT_SOURCES.includes(msg.source)) return `source must be one of ${INTENT_SOURCES.join(", ")}`;
  if (msg.v !== PROTOCOL_VERSION) return `v must be ${PROTOCOL_VERSION}`;
  if (msg.type !== "intent") return 'type must be "intent"';
  if (typeof msg.id !== "string" || !INTENT_ID_RE.test(msg.id)) return "id must look like int_<base36>_<rand>";
  if (typeof msg.name !== "string" || !INTENT_NAME_RE.test(msg.name)) return "name must match ^[a-z][a-z0-9_]{0,47}$";
  if (!msg.params || typeof msg.params !== "object" || Array.isArray(msg.params)) return "params must be an object";
  if (msg.ref !== undefined && msg.ref !== null && (typeof msg.ref !== "string" || !ENVELOPE_REF_RE.test(msg.ref))) {
    return "ref must look like <collection>:<id> (letters, digits, _ . : -)";
  }
  for (const key of ["ui", "attr"]) {
    const value = msg[key];
    if (value !== undefined && value !== null && (typeof value !== "string" || !ENVELOPE_TOKEN_RE.test(value))) {
      return `${key} must be a short token (letters, digits, _ . : -)`;
    }
  }
  return null;
}

/**
 * Make text safe for a terminal or a log line: C0/C1 control characters (escape sequences included) become "?",
 * newlines stay only when `multiline` is set.
 */
export function safeText(text, { multiline = false } = {}) {
  const value = String(text ?? "");
  const cleaned = value.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "?");
  return multiline ? cleaned : cleaned.replace(/\n/g, "\\n");
}

/** Deterministic JSON for coalescing keys (sorted object keys). */
export function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
