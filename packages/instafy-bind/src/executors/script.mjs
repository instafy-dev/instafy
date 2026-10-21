// Script executor: run a handler as a child process (map-pack ENGINE-SPEC v0.2 §10 handler contract).
// stdin: one JSON object {intent, bound, site}. stdout: NDJSON lines
//   {"type":"progress","step":1,"of":2,"message":"...","source":"..."}
//   {"type":"records","records":[...]}
//   {"type":"done","summary":"..."}
//   {"type":"error","code":"not_found|upstream|invalid|policy","message":"..."}
// stderr goes to the binder log. Handlers never write site files; the binder applies records.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { defaultStateFile } from "../lookup.mjs";

const KIT = pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "handler-kit.mjs")).href;
const MAX_LINE = 1024 * 1024;
export const KILL_GRACE_MS = 3000;
const HANDLER_CODES = ["not_found", "upstream", "invalid", "policy", "timeout"];

/**
 * The line of a crashed handler's stderr that says what went wrong. Node ends an uncaught error with a stack, the
 * error's own fields and "Node.js vX"; the useful line is the "SomethingError: message" one.
 */
export function crashLine(stderr) {
  const lines = String(stderr || "").split("\n").map((line) => line.trim()).filter(Boolean);
  const error = lines.find((line) => /^([A-Z]\w*)?(Error|Exception)\b( \[[A-Z0-9_]+\])?:/.test(line));
  if (error) return error;
  const useful = lines.filter((line) => !/^(Node\.js v\d|at |\^+$|[{}]$|\w+: .*,$|node:)/.test(line));
  return useful.at(-1) || "";
}

/** Names that look like credentials. bound.json may declare them in `env` only when serve passes --allow-env NAME. */
export const SECRET_ENV_RE = /(TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|PRIVATE|(^|_)KEY$|_KEY_|API_?KEY)/;
const RESERVED_ENV_RE = /^(INSTAFY|CONTROLLER|SUPABASE|RUNTIME|BIND|UW)_/;

/** Why a declared env name is not passed to handlers, or null when it is. */
export function envNameRefusal(name, allowEnv = []) {
  if (RESERVED_ENV_RE.test(name)) return "reserved for Instafy and the binder";
  if (SECRET_ENV_RE.test(name) && !allowEnv.includes(name)) return "looks like a secret; pass --allow-env " + name + " to serve to allow it";
  return null;
}

/**
 * The environment a handler sees: a small allowlist plus the intent's declared `env` names (never controller
 * tokens, never credential-like names unless allowed). HOME points at the binder's cache folder, so a handler's
 * libraries do not pick up the owner's dotfiles. Handlers are still trusted code: they run as the owner.
 */
export function handlerEnv({ siteDir, intentId, allowLocal, extra = [], allowEnv = [], env = process.env }) {
  const out = {};
  for (const key of ["PATH", "LANG", "LC_ALL", "TMPDIR", "TZ", "SYSTEMROOT", "TEMP", "TMP"]) {
    if (env[key] !== undefined) out[key] = env[key];
  }
  for (const key of extra) {
    if (envNameRefusal(key, allowEnv)) continue;
    if (env[key] !== undefined) out[key] = env[key];
  }
  const cache = path.join(os.homedir(), ".cache", "instafy-bind");
  const home = path.join(cache, "home");
  try {
    fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  } catch {
    // the handler still runs; HOME just may not exist
  }
  Object.assign(out, {
    HOME: home, USERPROFILE: home,
    BIND_SITE: siteDir, BIND_INTENT_ID: intentId, BIND_CACHE: cache, BIND_ALLOW_LOCAL: allowLocal ? "1" : "0", BIND_KIT: KIT,
    UW_SITE: siteDir, UW_INTENT_ID: intentId, UW_CACHE: path.join(os.homedir(), ".cache", "uw"),
    // outside lookups (src/lookup.mjs): the same health file as the binder and the agent's commands, the declared
    // providers, and this click as the "turn": a viewer's click always asks a site that was down once more, and
    // within the click a site found down is not asked again
    INSTAFY_LOOKUP_STATE: defaultStateFile(env),
    INSTAFY_TURN_STARTED_AT: new Date().toISOString(),
    ...(env.INSTAFY_LOOKUP_PROVIDERS ? { INSTAFY_LOOKUP_PROVIDERS: env.INSTAFY_LOOKUP_PROVIDERS } : {}),
  });
  return out;
}

/**
 * Run one handler. Resolves {summary} on done; rejects with an Error carrying `code`.
 * @param {object} o
 * @param {string} o.handler absolute path
 * @param {object} o.input {intent, bound, site}
 * @param {AbortSignal} o.signal abort reason {code, message} kills the child (SIGTERM, then SIGKILL)
 * @param {(p: object) => void} o.onProgress
 * @param {(records: object[]) => void} o.onRecords
 */
export function runScript({ handler, siteDir, input, signal, onProgress = () => {}, onRecords = () => {}, log = () => {}, allowLocal = false, envNames = [], allowEnv = [], killGraceMs = KILL_GRACE_MS }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [handler], {
      cwd: siteDir,
      env: handlerEnv({ siteDir, intentId: input.intent.id, allowLocal, extra: envNames, allowEnv }),
      stdio: ["pipe", "pipe", "pipe"],
    });
    let settled = false;
    let done = null;
    let failure = null;
    let buffer = "";
    let killTimer = null;
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };
    const fail = (code, message) => Object.assign(new Error(message), { code });

    const onAbort = () => {
      const reason = signal.reason || {};
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), killGraceMs);
      killTimer.unref?.();
      settle(reject, fail(reason.code || "cancelled", reason.message || "aborted"));
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }

    const handleLine = (line) => {
      if (!line.trim()) return;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        log("warn", `handler stdout (not JSON): ${line.slice(0, 200)}`);
        return;
      }
      if (msg?.type === "progress") onProgress(msg);
      else if (msg?.type === "records") {
        if (Array.isArray(msg.records)) onRecords(msg.records);
        else log("warn", "handler records message without a records array");
      } else if (msg?.type === "done") done = { summary: typeof msg.summary === "string" ? msg.summary : null };
      else if (msg?.type === "error") {
        failure = fail(HANDLER_CODES.includes(msg.code) ? msg.code : "upstream", String(msg.message || msg.code || "handler error"));
      } else log("warn", `handler sent an unknown message type: ${String(msg?.type).slice(0, 40)}`);
    };

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (!settled) handleLine(line);
      }
      if (buffer.length > MAX_LINE) {
        log("warn", "handler line longer than 1 MB; dropped");
        buffer = "";
      }
    });
    child.stderr.setEncoding("utf8");
    let stderrTail = "";
    child.stderr.on("data", (chunk) => {
      stderrTail = (stderrTail + chunk).slice(-2000);
      for (const line of chunk.split("\n")) if (line.trim()) log("debug", `handler: ${line.slice(0, 300)}`);
    });
    child.on("error", (error) => settle(reject, fail("internal", `could not start handler: ${error.message}`)));
    child.on("close", (code, sig) => {
      if (killTimer) clearTimeout(killTimer);
      signal?.removeEventListener?.("abort", onAbort);
      if (buffer.trim() && !settled) handleLine(buffer);
      if (failure) return settle(reject, failure);
      if (done) return settle(resolve, done);
      if (code === 0) return settle(resolve, { summary: null });
      const line = crashLine(stderrTail);
      settle(reject, fail("upstream", `handler exited with ${sig || `code ${code}`}${line ? `: ${line.slice(0, 160)}` : ""}`));
    });
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify(input));
  });
}
