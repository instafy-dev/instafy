// Viewer and admin tokens. Both live under .bind/ (mode 0700, files 0600); the static server never serves dotfiles.
import fs from "node:fs";
import path from "node:path";
import { randomBytes, timingSafeEqual } from "node:crypto";

export const BIND_DIR = ".bind";
const TOKEN_RE = /^[A-Za-z0-9_-]{16,128}$/;

export function randomToken(bytes = 24) {
  return randomBytes(bytes).toString("base64url");
}

export function bindDir(dir) {
  const full = path.join(dir, BIND_DIR);
  fs.mkdirSync(full, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(full, 0o700);
  } catch {
    // best effort on unusual file systems
  }
  // Tokens and the binder's log stay on this machine: a space's files are committed and synced, and the admin
  // token must not end up in its history.
  const ignore = path.join(full, ".gitignore");
  try {
    if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, "# instafy-bind: tokens and logs stay on this machine\n*\n", { mode: 0o600 });
  } catch {
    // best effort
  }
  return full;
}

/** Read a token file, or create it with a fresh token. `rotate` always writes a new one. */
export function ensureTokenFile(file, { rotate = false } = {}) {
  if (!rotate) {
    try {
      const value = fs.readFileSync(file, "utf8").trim();
      if (TOKEN_RE.test(value)) return value;
    } catch {
      // create below
    }
  }
  const token = randomToken();
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${token}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
  fs.chmodSync(file, 0o600);
  return token;
}

/** Per-site viewer token, shared in the URL as #k=<token>. */
export function viewerToken(siteDir, options) {
  return ensureTokenFile(path.join(bindDir(siteDir), "viewer-token"), options);
}

/** Admin token for commands and confirmations, in <root>/.bind/admin-token. The site never sees it. */
export function adminToken(rootDir, options) {
  return ensureTokenFile(path.join(bindDir(rootDir), "admin-token"), options);
}

export function readAdminToken(rootDir) {
  const value = fs.readFileSync(path.join(rootDir, BIND_DIR, "admin-token"), "utf8").trim();
  if (!TOKEN_RE.test(value)) throw new Error("malformed .bind/admin-token");
  return value;
}

/** Constant-time string comparison. */
export function tokensEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** Walk up from dir to the folder holding .bind/server.json (written by `serve`). */
export function findServerState(dir) {
  let current = path.resolve(dir);
  for (;;) {
    const file = path.join(current, BIND_DIR, "server.json");
    if (fs.existsSync(file)) {
      return { root: current, state: JSON.parse(fs.readFileSync(file, "utf8")) };
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

export function writeServerState(rootDir, state) {
  const file = path.join(bindDir(rootDir), "server.json");
  fs.writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  return file;
}

export function removeServerState(rootDir, pid = process.pid) {
  const file = path.join(rootDir, BIND_DIR, "server.json");
  try {
    const state = JSON.parse(fs.readFileSync(file, "utf8"));
    if (state.pid === pid) fs.rmSync(file, { force: true });
  } catch {
    // already gone
  }
}
