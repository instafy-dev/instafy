// Preview mode (`serve --preview`): serve a bound site inside Studio's preview card without a viewer token.
// SPDX-License-Identifier: AGPL-3.0-only
//
// Why this is safe. `instafy preview open --port N` connects a private tunnel to 127.0.0.1:N. The tunnel broker's
// Traefik only routes that tunnel through a capability host `p-<26 base32 label>--<32 hex tunnel id>.<preview
// domain>`, behind the broker's forwardAuth, which lets through only space members holding a live per-Open session
// (tunnel-broker ingress.rs; runtime-controller previews/sessions.rs). Traefik keeps the Host header and the rathole
// hop is plain TCP, so the binder sees that capability host. The site backend holds no credential (see
// SITE-BACKEND-CONTRACT.md): forwardAuth on the capability host is the auth, so the binder needs no token of its own.
//
// What the binder still checks, because without a token anything that reaches the port could act:
// - it listens on loopback only (enforced by createBinder), so only this runtime's own processes and its tunnels
//   reach it;
// - the Host header is a loopback name at the binder's port, or a capability host `p-<label>--<id>.<suffix>` where
//   <id> is a preview `instafy preview open` recorded for this port (~/.instafy/cli-preview-state.json) AND <suffix>
//   is exactly the preview domain (and port) the controller told the CLI that preview is viewed under (`hostSuffix`).
//   The tunnel id alone is not a secret: every member's frame address carries it and it leaks as a Referer, so a
//   DNS-rebinding page named `p-<any label>--<id>.attacker.example` could otherwise pose as the preview host. The
//   attacker cannot serve a page from the real preview domain, so pinning the domain is what stops rebinding. A state
//   entry without a hostSuffix (an older CLI) is never accepted. A public tunnel (`instafy tunnel`, Host
//   `<uuid>.<tunnel domain>`) or any other name gets 421;
// - intents still need Origin == Host (same origin) and a JSON body (CORS preflight), as with a token;
// - frame messages (Ask Octo, location, follow mode) are taken only from the Studio origin `instafy preview open`
//   recorded for that preview (`studioOrigin`, from the controller): the capability host sends
//   `frame-ancestors 'self' <studio origin>` and the bind client trusts no other parent. The label is a bearer that
//   also leaks in Origin headers, so without this any page that framed the preview URL could act as its host. A
//   preview without a recorded Studio origin is still shown, but its page takes no host messages at all.
//
// The card. A page someone asked for ends with its card: run in the site's folder, `instafy preview open --start`
// serves the site with `serve --preview`, keeps it serving after the turn and posts the card. So in a space `init`
// names that command as its next step, and until a preview of the space shows the site any check ends with it. A check
// that passes on a new page runs it itself (titled from the page): one whose card was never opened, which the space's
// record of its pages (`.instafy/pages/pages.json`, the CLI's space-pages.ts) does not hold. A page it holds had its
// card, in this chat or another, and may be stopped on purpose, or stopped with the machine; its check only names the
// command. The command serves a site only from inside the space's workspace (the CLI's resolveWorkspaceRoot:
// WORKSPACE_PROJECT_DIR, else WORKSPACE_DIR/<space>); anywhere else the binder runs on its own and names no card.
// Whether a preview shows a folder is read from the same state file: `instafy preview open` records with each preview
// its space and the folder its site is served from (`siteDir`, relative to the space's workspace), which the runtime
// also reads to take a card's picture again after a turn changes that folder. That folder is the one the CLI runs in
// when it is given --serve-cmd, else the one the process on the port runs in, so in a space the command `serve
// --preview` prints for its card runs in the folder it serves, with --serve-cmd.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** The capability host the broker routes private previews by (Traefik HostRegexp), plus an optional port. */
export const PREVIEW_HOST_RE = /^p-[a-z2-7]{26}--([0-9a-f]{32})\.([a-z0-9-]+(?:\.[a-z0-9-]+)*(?::\d{1,5})?)$/;

/** Where the Instafy CLI records the previews it opened (instafy-cli src/preview.ts previewStateFile). */
export function defaultPreviewStateFile() {
  return path.join(os.homedir(), ".instafy", "cli-preview-state.json");
}

/** The tunnel id (32 lowercase hex) of a capability Host header, or null. */
export function previewTunnelOf(hostHeader) {
  return previewHostParts(hostHeader)?.tunnel ?? null;
}

/** `{ tunnel, suffix }` of a capability Host header (suffix = the domain and any port after the first label), or null. */
export function previewHostParts(hostHeader) {
  const match = PREVIEW_HOST_RE.exec(String(hostHeader || "").trim().toLowerCase());
  return match ? { tunnel: match[1], suffix: match[2] } : null;
}

const normalizeSuffix = (raw) => {
  const suffix = String(raw || "").trim().toLowerCase().replace(/^\.+/, "");
  return /^[a-z0-9-]+(?:\.[a-z0-9-]+)*(?::\d{1,5})?$/.test(suffix) ? suffix : null;
};

const normalizeTunnelId = (raw) => {
  const hex = String(raw || "").trim().toLowerCase().replace(/-/g, "");
  return /^[0-9a-f]{32}$/.test(hex) ? hex : null;
};

const normalizeOrigin = (raw) => {
  if (typeof raw !== "string") return null;
  try {
    const url = new URL(raw.trim());
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) return null;
    return url.origin;
  } catch {
    return null;
  }
};

/**
 * The previews opened for a local port, read from the CLI's state file: a Map of tunnel id → Map of the host suffixes
 * it is viewed under → the Studio origins that frame it (empty when unknown). Entries without a hostSuffix are left out. The file is small and is written by `instafy preview open`
 * after the binder starts, so it is read on use (cached until it changes).
 */
export function previewTunnelReader(file = defaultPreviewStateFile()) {
  let cacheKey = null;
  let cached = [];
  return function tunnelsForPort(port) {
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      cacheKey = null;
      cached = [];
      return new Map();
    }
    const key = `${stat.mtimeMs}:${stat.size}`;
    if (key !== cacheKey) {
      cacheKey = key;
      try {
        const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
        cached = Array.isArray(parsed?.previews) ? parsed.previews.filter((p) => p && typeof p === "object") : [];
      } catch {
        cached = [];
      }
    }
    const previews = new Map();
    for (const entry of cached) {
      if (Number(entry.localPort) !== Number(port)) continue;
      const id = normalizeTunnelId(entry.previewId);
      const suffix = normalizeSuffix(entry.hostSuffix);
      if (!id || !suffix) continue;
      if (!previews.has(id)) previews.set(id, new Map());
      const suffixes = previews.get(id);
      if (!suffixes.has(suffix)) suffixes.set(suffix, new Set());
      const studio = normalizeOrigin(entry.studioOrigin);
      if (studio) suffixes.get(suffix).add(studio);
    }
    return previews;
  };
}

const clean = (value) => (typeof value === "string" && value.trim() ? value.trim() : null);

/** The folder's real path, or the path itself when it cannot be resolved. */
function realOr(dir) {
  try {
    return fs.realpathSync(path.resolve(String(dir)));
  } catch {
    return path.resolve(String(dir));
  }
}

/** A word the shell reads as it is: the text, or the text in single quotes. */
export function shellWord(text) {
  const word = String(text);
  return /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`;
}

/** `command` said from where the binder ran, for the site in `dir`: in a subshell that runs it in that folder, so a
 *  command chained after it still runs here. */
export function inFolder(dir, command) {
  const where = String(dir || ".");
  return path.resolve(where) === path.resolve(".") ? command : `(cd ${shellWord(where)} && ${command})`;
}

/** The card's command as the arguments of `instafy`, run in the site's folder: it serves the folder and posts its card. */
export function cardArgs(title) {
  return ["preview", "open", "--title", title, "--serve-cmd", "instafy bind serve . --port {port} --preview", "--start", "--json"];
}

/** The card's command for the site in `dir`, said from where `init` or `check` ran. The turn writes the title, unless
 *  it is given. */
export function cardCommand(dir, title = "<short title>") {
  return inFolder(dir, `instafy ${cardArgs(title).map(shellWord).join(" ")}`);
}

/** Whether `dir` is in the space's workspace, where the card's command serves a site from. */
export function inSpace(dir, env = process.env) {
  const root = clean(env.WORKSPACE_PROJECT_DIR) ?? clean(env.WORKSPACE_DIR);
  if (root === null) return false;
  const rel = path.relative(realOr(root), realOr(dir));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

/** The workspace a preview of `space` has its folder in, as the CLI resolves it (resolveWorkspaceRoot), or null when it
 *  is not this space's. One machine can run several spaces as one user (a desktop runtime): they share the CLI's
 *  record, and another space's preview is never this site's, whatever its folder is called. This space is the one the
 *  CLI reads from the environment (resolveProject: SPACE_ID, else CONTROLLER_SPACE_ID). WORKSPACE_PROJECT_DIR is the
 *  space's own folder, so without its id no preview is placed there; WORKSPACE_DIR/<space> places each in its own. */
function workspaceOf(env, space) {
  const own = clean(env.SPACE_ID) ?? clean(env.CONTROLLER_SPACE_ID);
  if (typeof space !== "string" || (own !== null && space !== own)) return null;
  const project = clean(env.WORKSPACE_PROJECT_DIR);
  if (project) return space === own ? project : null;
  const base = clean(env.WORKSPACE_DIR);
  return base && /^[\w-]+$/.test(space) ? path.join(base, space) : null;
}

/** The space's workspace as the CLI resolves it (resolveWorkspaceRoot): WORKSPACE_PROJECT_DIR, else
 *  WORKSPACE_DIR/<space> for the space the environment names; null without one. */
function spaceWorkspace(env) {
  const project = clean(env.WORKSPACE_PROJECT_DIR);
  if (project) return project;
  const base = clean(env.WORKSPACE_DIR);
  const own = clean(env.SPACE_ID) ?? clean(env.CONTROLLER_SPACE_ID);
  return base && own && /^[\w-]+$/.test(own) ? path.join(base, own) : null;
}

/** The space's record of its pages, in its workspace: `instafy preview open` writes each page's folder there the first
 *  time its card is opened, with the chat the card went to (the CLI's space-pages.ts). */
const PAGES_RECORD = path.join(".instafy", "pages", "pages.json");

/** Whether the space's record of its pages holds the site in `dir`: a page whose card was opened before, in this chat or
 *  another, which a person may have stopped since, or which stopped with the machine. */
export function pageRecorded(dir, { env = process.env } = {}) {
  const root = spaceWorkspace(env);
  if (root === null) return false;
  const folder = path.relative(realOr(root), realOr(dir)).split(path.sep).join("/");
  if (!folder || folder === ".." || folder.startsWith("../") || path.isAbsolute(folder)) return false;
  let pages;
  try {
    pages = JSON.parse(fs.readFileSync(path.join(root, PAGES_RECORD), "utf8"))?.pages;
  } catch {
    return false;
  }
  return Array.isArray(pages) && pages.some((page) => typeof page?.folder === "string" && page.folder.replace(/^\.\//, "").replace(/\/+$/, "") === folder);
}

/** The preview the CLI opened for this space that shows the site in `dir` (one it recorded with that folder as the
 *  folder its site is served from), or null. */
function previewOf(dir, { env = process.env, file = defaultPreviewStateFile() } = {}) {
  let previews;
  try {
    previews = JSON.parse(fs.readFileSync(file, "utf8"))?.previews;
  } catch {
    return null;
  }
  if (!Array.isArray(previews)) return null;
  const folder = realOr(dir);
  return previews.find((entry) => {
    if (!entry || typeof entry !== "object" || typeof entry.siteDir !== "string") return false;
    const root = workspaceOf(env, entry.projectId);
    return root !== null && realOr(path.resolve(root, entry.siteDir)) === folder;
  }) ?? null;
}

/** Whether a preview the CLI opened for this space shows the site in `dir`: one it recorded with that folder as the
 *  folder its site is served from. */
export function previewShows(dir, options = {}) {
  return previewOf(dir, options) !== null;
}

/** The port the site in `dir` is served on for the preview that shows it, or null. */
export function previewPort(dir, options = {}) {
  const port = Number(previewOf(dir, options)?.localPort);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : null;
}

// How long a look at a page as drawn may take: Chromium starting, then each size loading (30 s at most each) and its
// screenshot. A check never waits on it longer.
export const LOOK_TIMEOUT_MS = 120_000;

/** The page check (`instafy preview check`) of the site served on `port`, with the text each size drew: `{ report }`,
 *  its JSON, or `{ error }`, why it could not look, within `timeoutMs`. */
export function lookAtPage(port, { timeoutMs = LOOK_TIMEOUT_MS, env = process.env } = {}) {
  const run = spawnSync("instafy", ["preview", "check", "--port", String(port), "--json", "--text"], {
    env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024,
  });
  if (run.error) {
    const code = run.error.code;
    return { error: code === "ENOENT" ? "the instafy command was not found" : code === "ETIMEDOUT" ? `the page check did not finish within ${Math.round(timeoutMs / 1000)} s` : run.error.message };
  }
  let answer = null;
  try {
    answer = JSON.parse(String(run.stdout ?? "").trim());
  } catch {
    // not its JSON: what it said is the reason
  }
  if (answer && Array.isArray(answer.viewports)) return { report: answer };
  const said = String((answer && answer.error) || run.stderr || run.stdout || "").trim().split("\n").slice(-2).join(" ").trim();
  return { error: said || `the page check ended with ${run.signal ?? `exit ${run.status}`}` };
}
