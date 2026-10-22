// The binder: static server + intent endpoint + SSE + apply step + jobs + tokens, for one site or a gallery.
// Every endpoint is served under __bind/.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { BOUND_FILE, executorOf, intentCatalog, loadBound, resolveIntent } from "./bound.mjs";
import { applyDefaults, formatErrors, validate } from "./schema-lite.mjs";
import { checkRecords, collectRecords } from "./apply.mjs";
import { ownSiteWrites, releaseSiteWrites } from "./save-owner.mjs";
import { AgentBudget, DEFAULT_AGENT_BUDGET_PER_HOUR } from "./budget.mjs";
import { EventHub } from "./sse.mjs";
import { JobManager } from "./jobs.mjs";
import {
  COMMAND_NAMES, MAX_COMMAND_BYTES, MAX_INTENT_BYTES, MAX_PARAMS_BYTES, PROTOCOL_VERSION, checkIntentEnvelope, hostMessage, safeText,
} from "./protocol.mjs";
import { adminToken, bindDir, tokensEqual, viewerToken } from "./tokens.mjs";
import { agentExecutorRefusal, agentUnavailableReason, agentUsesOwnerConversation, resolveControllerConfig } from "./config.mjs";
import { ControllerClient } from "./controller.mjs";
import { checkUriParams } from "./net.mjs";
import { runScript } from "./executors/script.mjs";
import { runAgent } from "./executors/agent.mjs";
import { serveStatic } from "./static.mjs";
import { defaultPreviewStateFile, previewHostParts, previewTunnelReader } from "./preview-host.mjs";

const LOOPBACK_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

/** The controller settings when the agent executor is off: no URL, no conversation and, above all, no login. */
function offControllerConfig() {
  const config = { controllerUrl: null, tokenSource: "off", hasToken: false, conversationId: null, agentConversationId: null, spaceId: null, profile: null, configFile: null, note: null };
  Object.defineProperty(config, "token", { value: null, enumerable: false });
  return config;
}
// CSP host-source has no IPv6 literal form, so [::1] cannot be listed.
const LOOPBACK_ANCESTORS = ["http://localhost:*", "http://127.0.0.1:*"];

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const CLIENT_FILE = path.join(HERE, "..", "client", "bind-client.js");
const ENDPOINT_RE = /^(.*?)\/__bind\/([A-Za-z.-]+)$/;
/** Site folders never served: handler code, tests and packages. */
const PRIVATE_DIRS = new Set(["handlers", "test", "tests", "node_modules"]);
/** Site files that need the viewer token: the manifest and everything the binder writes. */
const VIEWER_ONLY_RE = /^(bound\.json|data\/version\.json|data\/records\/.*)$/;

/**
 * A site path the way a case-insensitive filesystem (macOS, Windows) reads it: lower case, with the Windows aliases
 * of a name cut (trailing dots and spaces, an ":stream" suffix). The guards below compare this form, so
 * `/Bound.json`, `/DATA/records/x.json` or `/handlers./x.mjs` are the files they name, not other files.
 */
export function guardKey(rel) {
  return String(rel).split(/[\\/]/).map((seg) => {
    const name = seg.toLowerCase();
    const colon = name.indexOf(":");
    return trimEnd(colon >= 0 ? name.slice(0, colon) : name, ". ");
  }).filter(Boolean).join("/");
}

/** `text` without any of `chars` at its end (a plain loop: no regex backtracking on long runs). */
export function trimEnd(text, chars) {
  let end = text.length;
  while (end > 0 && chars.includes(text[end - 1])) end -= 1;
  return text.slice(0, end);
}

/**
 * Is a request path (relative to the site, decoded) one of the never-served folders, or a file that needs the viewer
 * token? Checks the path as asked and, when it names a file, the real path of that file inside the site (an 8.3 short
 * name or any other spelling the filesystem resolves), so no spelling reaches what the canonical name guards.
 */
export function guardedPath(siteRealDir, rel) {
  const keys = [guardKey(rel)];
  try {
    const real = fs.realpathSync.native(path.join(siteRealDir, ...String(rel).split("/").filter(Boolean)));
    const inside = path.relative(siteRealDir, real);
    if (inside && !inside.startsWith("..") && !path.isAbsolute(inside)) keys.push(guardKey(inside.split(path.sep).join("/")));
  } catch {
    // no such file: the asked spelling is all there is
  }
  return {
    hidden: keys.some((key) => PRIVATE_DIRS.has(key.split("/")[0])),
    viewerOnly: keys.some((key) => VIEWER_ONLY_RE.test(key)),
  };
}

function json(res, status, body, headers = {}) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "content-length": Buffer.byteLength(text),
    ...headers,
  });
  res.end(text);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let done = false;
    req.on("data", (chunk) => {
      if (done) return;
      size += chunk.length;
      if (size > limit) {
        done = true;
        req.pause();
        reject(Object.assign(new Error("body too large"), { status: 413 }));
      } else chunks.push(chunk);
    });
    req.on("end", () => {
      if (!done) resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", reject);
  });
}

/** Answer a body that broke its limit and drop the connection once the answer is out. */
function refuseBody(req, res, error, body) {
  if (error.status === 413) res.once("finish", () => req.destroy());
  return json(res, error.status || 400, body, error.status === 413 ? { connection: "close" } : {});
}

/** Cookie that carries the viewer token for pages that don't run the bind client. */
export function tokenCookieName(siteDir) {
  return `bind_k_${createHash("sha256").update(siteDir).digest("hex").slice(0, 12)}`;
}

function readCookie(req, name) {
  for (const part of String(req.headers.cookie || "").split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return "";
}

/** "hash" when the site's index.html loads the bind client (it reads #k=), else "query" (?k= sets a cookie). */
function linkStyleOf(siteDir) {
  try {
    const html = fs.readFileSync(path.join(siteDir, "index.html"), "utf8");
    return CLIENT_TAG_RE.test(html) ? "hash" : "query";
  } catch {
    return "hash";
  }
}

function nativeRealpath(dir) {
  try {
    return fs.realpathSync.native(dir);
  } catch {
    return dir;
  }
}

function readJsonMaybe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

/**
 * Find the site folders: the root itself when it has bound.json, else each subfolder that has one (a gallery). With
 * `plain`, a folder with only an index.html (a plain static site: no intents) is a site too.
 */
export function discoverSites(root, { plain = false } = {}) {
  if (fs.existsSync(path.join(root, BOUND_FILE))) return [{ name: path.basename(path.resolve(root)), prefix: "", dir: fs.realpathSync(root) }];
  const sites = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name === "node_modules") continue;
    if (fs.existsSync(path.join(root, entry.name, BOUND_FILE))) sites.push({ name: entry.name, prefix: `/${entry.name}`, dir: fs.realpathSync(path.join(root, entry.name)) });
  }
  if (!sites.length && plain && fs.existsSync(path.join(root, "index.html"))) {
    return [{ name: path.basename(path.resolve(root)), prefix: "", dir: fs.realpathSync(root), plain: true }];
  }
  return sites;
}

const CLIENT_TAG_RE = /__bind\/client\.js/;
/**
 * A plain site's pages get the bind client when they don't load it themselves, so every site Studio shows can be
 * presented and followed (and ask for location) without the page knowing about it.
 */
export function withBindClient(html, prefix = "") {
  if (CLIENT_TAG_RE.test(html)) return html;
  const tag = `<script src="${prefix}/__bind/client.js"></script>`;
  const at = html.search(/<\/head\s*>/i);
  if (at >= 0) return html.slice(0, at) + tag + html.slice(at);
  const body = html.search(/<\/body\s*>/i);
  return body >= 0 ? html.slice(0, body) + tag + html.slice(body) : html + tag;
}

/**
 * Create a binder.
 * @param {object} options
 * @param {string} options.root a site folder (with bound.json) or a gallery folder
 * @param {number} [options.port] 0 picks a free port
 * @param {string} [options.host]
 * @param {boolean} [options.noToken] skip the viewer token (localhost only)
 * @param {boolean} [options.preview] preview mode: no viewer token; also answer the private preview capability host
 *   that `instafy preview open --port <port>` opened for this port (see preview-host.mjs for why that is safe)
 * @param {string} [options.previewStateFile] the CLI's preview state (tests; default ~/.instafy/cli-preview-state.json)
 * @param {boolean} [options.agentExecutor] the owner's opt-in (serve --agent-executor) to run agent intents as Octo turns
 *   on their own Instafy login, for clicks made on this machine only. Off by default: "Ask Octo" clicks are then asks
 *   that the page hands to Studio, which sends them as the clicker's own chat message, and the binder holds no
 *   Instafy credential at all
 * @param {boolean} [options.dryRun] agent intents clicked on this machine print their prompt instead of dispatching
 * @param {boolean} [options.confirm] every job waits for confirmation
 * @param {boolean} [options.allowLocal] let URL params and handler fetches reach private addresses
 * @param {boolean} [options.trustProxy] believe x-forwarded-host (only behind your own proxy)
 * @param {number} [options.agentBudget] Octo dispatches per site per hour (repairs included)
 * @param {string[]} [options.allowEnv] credential-like env names bound.json may pass to handlers
 * @param {boolean} [options.save] in a space's checkout, commit the data files the binder writes (default on; see
 *   save-owner.mjs). Off (`serve --no-save`) leaves them as changed files, which a stop keeps as unsaved work
 * @param {{delayMs?: number, maxDelayMs?: number}} [options.saveOptions] commit timing (tests)
 * @param {(level: string, text: string) => void} [options.log]
 * @param {(prompt: string, job: object) => void} [options.onDryRun]
 * @param {(config: object) => object|null} [options.createClient] controller client factory (tests)
 * @param {object} [options.hubOptions] EventHub limits (tests)
 */
export function createBinder(options) {
  const root = path.resolve(options.root);
  const {
    port = 4180, host = "127.0.0.1", noToken = false, dryRun = false, confirm = false, allowLocal = false,
    log: externalLog = () => {}, onDryRun = () => {}, pollMs, killGraceMs, publicOrigins = [], lookup, env = process.env,
    trustProxy = false, agentBudget = DEFAULT_AGENT_BUDGET_PER_HOUR, allowEnv = [], preview = false,
    previewStateFile = defaultPreviewStateFile(), agentExecutor = false, save = true, saveOptions = {},
  } = options;
  // Preview mode is tokenless too: the broker's forwardAuth on the capability host is the auth.
  const tokenless = noToken || preview;

  // A public URL without a viewer token would let anyone with the link run the site's checks: refuse it. (With
  // --preview a --public-url name needs the viewer token: only the loopback names and the preview card are tokenless.)
  if (noToken && publicOrigins.length) throw new Error("--no-token cannot be combined with --public-url: a public link needs the viewer token (serve without --no-token and share the #k= link)");
  if (tokenless && !["127.0.0.1", "localhost", "::1"].includes(host)) {
    throw new Error(`${preview ? "--preview" : "--no-token"} is only allowed when serving on localhost (--host 127.0.0.1)`);
  }
  const previewTunnels = preview ? previewTunnelReader(previewStateFile) : null;
  if (agentExecutor && agentExecutorRefusal(env)) throw new Error(agentExecutorRefusal(env));

  const siteEntries = discoverSites(root, { plain: true });
  if (siteEntries.length === 0) throw new Error(`${root} has no ${BOUND_FILE} (and no subfolder with one) and no index.html. Run \`instafy-bind init ${options.root}\`.`);

  // The message log: .bind/binder.log (NDJSON, never served). Dry-run prompts land here too ("prompt" level,
  // log file only). Every line is cleaned of control characters at this sink: refs, handler output and controller
  // errors can come from viewers or web pages and must not drive the owner's terminal.
  let logFile = null;
  const log = (level, raw) => {
    const text = safeText(raw, { multiline: level === "prompt" });
    if (level !== "prompt") externalLog(level, text);
    try {
      logFile ??= path.join(bindDir(root), "binder.log");
      fs.appendFileSync(logFile, `${JSON.stringify({ at: new Date().toISOString(), level, text })}\n`, { mode: 0o600 });
    } catch {
      // logging must not break serving
    }
  };

  const configArgs = {
    serverUrl: options.serverUrl, accessToken: options.accessToken, conversation: options.conversation,
    agentConversation: options.agentConversation, space: options.space, env, cwd: root,
  };
  // "Ask Octo" is host-mediated (docs/Bound-Sites.md, "Ask Octo"): the page hands the click to Studio, which sends it as
  // the clicker's own chat message, billed like typing it. So by default the binder never reads an Instafy login. Only
  // the owner's explicit --agent-executor turns agent intents into Octo turns on the owner's login, and only for clicks
  // made on this machine (ownerLocal): a click through the preview host, a tunnel or a proxy can be anyone's, and
  // owner-paid asks from other people have no opt-in.
  const controllerConfig = agentExecutor ? resolveControllerConfig(configArgs) : offControllerConfig();
  const agentReason = dryRun || !agentExecutor ? null : agentUnavailableReason(controllerConfig);
  // A saved login may be refreshed by the CLI while serve runs: after a 401, read it again once.
  const refreshToken = () => {
    if (controllerConfig.tokenSource !== "config") return null;
    const again = resolveControllerConfig(configArgs);
    return again.tokenSource === "config" ? again.token : null;
  };
  const client = dryRun || !agentExecutor || agentReason
    ? null
    : options.createClient
      ? options.createClient(controllerConfig)
      : new ControllerClient({ controllerUrl: controllerConfig.controllerUrl, token: controllerConfig.token, refreshToken });
  if (client && agentUsesOwnerConversation(controllerConfig)) {
    log("warn", "agent intents post into your own conversation (--agent-conversation equals --conversation): every viewer click becomes a turn there");
  }
  // A preview binder with a public URL answers whoever has the public link. Agent intents run Octo turns on the
  // owner's login and credits, so they are not offered there (script intents are); owner-paid asks from strangers
  // need an explicit opt-in that does not exist yet (SITE-BACKEND-CONTRACT public_octo).
  const publicAgentReason = tokenless && publicOrigins.length && !dryRun
    ? "not offered on a public link (anyone with the link could spend the owner's Octo turns)"
    : null;
  // dry_run and ready apply to clicks made on this machine; every other click of an agent intent is an ask via Studio.
  const agentState = dryRun ? "dry_run" : !agentExecutor ? "host" : agentReason || publicAgentReason ? "unavailable" : "ready";
  const ownerTurns = agentState === "dry_run" || agentState === "ready";
  const admin = adminToken(root);

  const sites = siteEntries.map((entry) => {
    const bound = entry.plain ? { intents: {} } : loadBound(entry.dir);
    // runnable: what the binder runs for anyone. asks: agent intents, which a click hands to Studio. ownerRunnable:
    // agent intents the binder itself runs, for clicks made on this machine only (--agent-executor or --dry-run).
    const runnable = new Set();
    const asks = new Set();
    const ownerRunnable = new Set();
    const unavailable = {};
    const resolved = {};
    for (const [name, def] of Object.entries(bound.intents)) {
      const r = resolveIntent(def, { siteDir: entry.dir });
      if (!r.ok) unavailable[name] = r.reason;
      else if (r.executor === "agent") {
        asks.add(name);
        resolved[name] = r;
        if (ownerTurns) ownerRunnable.add(name);
        else if (agentExecutor) unavailable[name] = `agent: ${agentReason || publicAgentReason} (clicks in Studio still ask Octo as the clicker)`;
      } else {
        runnable.add(name);
        resolved[name] = r;
      }
    }
    const site = {
      ...entry,
      realDir: nativeRealpath(entry.dir),
      bound,
      title: bound.title || entry.name,
      runnable,
      asks,
      ownerRunnable,
      unavailable,
      resolved,
      // --preview keeps a token for --public-url names; its loopback names and the preview card need none
      token: noToken || (preview && !publicOrigins.length) ? null : viewerToken(entry.dir),
      cookie: tokenCookieName(entry.dir),
      linkStyle: linkStyleOf(entry.dir),
      hub: new EventHub(options.hubOptions),
      session: agentSession(entry.dir),
      budget: new AgentBudget({ dir: entry.dir, perHour: agentBudget }),
    };
    // The binder owns what it writes for clicks: in a space's checkout it commits those files (save-owner.mjs).
    site.saver = save
      ? ownSiteWrites(entry.dir, { ...saveOptions, label: `the ${entry.name} site`, log: (level, text) => log(level, `[${entry.name}] ${text}`) })
      : null;
    site.jobs = new JobManager({
      site,
      hub: site.hub,
      confirmAll: confirm,
      log: (level, text) => log(level, `[${site.name}] ${text}`),
      runExecutor: (job, ctx) => runJob(site, job, ctx),
      admit: (def, executor) => {
        if (executor !== "agent" || dryRun || site.budget.remaining() > 0) return null;
        return { http: 429, body: { reason: "budget", retry_after_s: site.budget.retryAfterS() } };
      },
    });
    for (const [name, reason] of Object.entries(unavailable)) log("warn", `[${site.name}] intent ${name} is not available: ${reason}`);
    return site;
  });

  /**
   * Where a site's agent turns go: --agent-conversation when given, else the site's own thread (created in the space
   * on first use, as a child of the owner's conversation, and remembered in .bind/agent-thread.json).
   */
  function agentSession(siteDir) {
    const session = {
      conversationId: controllerConfig.agentConversationId,
      spaceId: controllerConfig.spaceId,
      parentConversationId: controllerConfig.conversationId,
      creating: null,
      onThread: null,
    };
    if (session.conversationId) return session;
    const file = path.join(siteDir, ".bind", "agent-thread.json");
    const saved = readJsonMaybe(file);
    if (saved && saved.controller === controllerConfig.controllerUrl && saved.space === controllerConfig.spaceId && typeof saved.conversationId === "string") {
      session.conversationId = saved.conversationId;
    }
    session.onThread = (id) => {
      log("info", `created the site's Octo thread ${id}`);
      try {
        fs.writeFileSync(path.join(bindDir(siteDir), "agent-thread.json"), `${JSON.stringify({ controller: controllerConfig.controllerUrl, space: controllerConfig.spaceId, conversationId: id, created_at: new Date().toISOString() })}\n`, { mode: 0o600 });
      } catch (error) {
        log("warn", `could not save the thread id: ${error.message}`);
      }
    };
    return session;
  }

  function runJob(site, job, ctx) {
    const def = job.def;
    if (job.executor === "script") {
      return runScript({
        handler: site.resolved[job.name].handler,
        siteDir: site.dir,
        input: { intent: job.intent, bound: def, site: { dir: site.dir, title: site.title } },
        signal: ctx.signal,
        onProgress: ctx.progress,
        onRecords: ctx.records,
        log: ctx.log,
        allowLocal,
        envNames: def.env || [],
        allowEnv,
        ...(killGraceMs !== undefined ? { killGraceMs } : {}),
      });
    }
    return runAgent({
      name: job.name,
      def,
      intent: job.intent,
      siteTitle: site.title,
      client,
      session: site.session,
      budget: site.budget,
      signal: ctx.signal,
      onProgress: ctx.progress,
      onRecords: ctx.records,
      log: ctx.log,
      dryRun,
      onDryRun: (prompt) => onDryRun(prompt, job),
      check: (records) =>
        checkRecords(structuredClone(records), { name: job.name, def, intent: job.intent, job: job.id }).rejected.map((r) => `records[${r.index}]: ${r.reason}`),
      ...(pollMs !== undefined ? { pollMs } : {}),
    });
  }

  const siteFor = (prefixPath) =>
    sites.find((site) => site.prefix === "" || prefixPath === site.prefix || prefixPath.startsWith(`${site.prefix}/`)) || null;

  /** The viewer token from the x-bind-token header or the site cookie (?k= in the query only where allowQuery). */
  function viewerOk(site, req, url, { allowQuery = false } = {}) {
    if (!tokenNeeded(site, req)) return true;
    const offered = req.headers["x-bind-token"] || (allowQuery ? url.searchParams.get("k") : "") || readCookie(req, site.cookie) || "";
    return tokensEqual(String(offered), site.token);
  }

  /** Is this request's Host one of the --public-url names? */
  function publicHost(req) {
    const offered = String(req.headers.host || "").toLowerCase();
    return publicOrigins.some((origin) => {
      try {
        return new URL(origin).host.toLowerCase() === offered;
      } catch {
        return false;
      }
    });
  }

  /** Does this request need the viewer token? Always with one, except in preview mode off the --public-url names. */
  function tokenNeeded(site, req) {
    if (!site.token) return false;
    return !preview || publicHost(req);
  }

  /** A request that carries the token in the x-bind-token header: a browser only sends that same-origin (CORS preflight). */
  const headerTokenOk = (site, req) => Boolean(site.token) && tokensEqual(String(req.headers["x-bind-token"] || ""), site.token);

  /**
   * DNS rebinding guard for --no-token and --preview: without a token anything that reaches the port could act, so
   * only the names this binder was started for are accepted. With a token a rebinding page has nothing to send.
   * Preview mode also accepts the capability host of a preview opened for this port (preview-host.mjs).
   */
  function hostOk(req) {
    if (!tokenless) return true;
    const port = address?.port;
    const names = ["127.0.0.1", "localhost", "[::1]", host.includes(":") ? `[${host}]` : host];
    const allowed = new Set(names.map((name) => `${name}:${port}`.toLowerCase()));
    // Loopback names without a port too: the tunnel broker's health probe sends `Host: localhost`. No web page
    // outside this machine has a loopback origin, so these cannot be used for DNS rebinding.
    for (const name of ["127.0.0.1", "localhost", "[::1]"]) allowed.add(name);
    for (const origin of publicOrigins) {
      try {
        allowed.add(new URL(origin).host.toLowerCase());
      } catch {
        // ignored
      }
    }
    const offered = String(req.headers.host || "").toLowerCase();
    return allowed.has(offered) || previewHostOk(offered);
  }

  /**
   * A capability host whose tunnel is a preview `instafy preview open` recorded for this binder's port, on exactly the
   * preview domain it recorded for it (the tunnel id alone is not secret; see preview-host.mjs).
   */
  function previewHostOk(hostHeader) {
    return previewStudioOrigins(hostHeader) !== null;
  }

  /**
   * The Studio origins that frame the preview this capability host belongs to ([] when `instafy preview open` recorded
   * none), or null when the host is not a preview of this port.
   */
  function previewStudioOrigins(hostHeader) {
    if (!previewTunnels) return null;
    const parts = previewHostParts(hostHeader);
    const studios = parts ? previewTunnels(address?.port).get(parts.tunnel)?.get(parts.suffix) : null;
    return studios ? [...studios] : null;
  }

  /**
   * Who may host this page in a frame and talk to it (Ask Octo, location, follow mode): bound.json parentOrigins, plus
   * on a preview capability host the Studio origin recorded for that preview. The bind client takes host messages
   * from these origins only (and its own), so with none listed a framing page gets nothing.
   */
  function parentOriginsFor(site, req) {
    const studios = req ? previewStudioOrigins(String(req.headers.host || "").toLowerCase()) || [] : [];
    return [...new Set([...(site.bound.parentOrigins || []), ...studios])];
  }

  /**
   * Admin calls (commands to every viewer, confirmations) come from `instafy-bind command|confirm` on this machine,
   * which uses the binder's own loopback URL. Refuse them on any other name (the preview capability host, a
   * --public-url tunnel, a proxy) even with the admin token, so a token that leaked cannot be used from outside.
   */
  function adminLocal(req) {
    const socket = String(req.socket?.remoteAddress || "").replace(/^::ffff:/, "");
    if (!/^(127\.|::1$)/.test(socket)) return false;
    if (req.headers["x-forwarded-for"] || req.headers["x-forwarded-host"]) return false;
    const offered = String(req.headers.host || "").toLowerCase();
    const own = `${host.includes(":") ? `[${host}]` : host}:${address?.port}`.toLowerCase();
    return LOOPBACK_HOST.test(offered) || offered === own;
  }

  /** A click by the owner on this machine: the same test as admin calls (loopback socket and name, no proxy). */
  const ownerLocal = (req) => adminLocal(req);

  function adminOk(req) {
    if (!adminLocal(req)) return false;
    const header = req.headers.authorization || "";
    const value = header.startsWith("Bearer ") ? header.slice(7).trim() : req.headers["x-bind-admin"] || "";
    return tokensEqual(String(value), admin);
  }

  function originOk(req) {
    const origin = req.headers.origin;
    if (!origin || origin === "null") return !origin;
    let originHost;
    try {
      originHost = new URL(origin).host;
    } catch {
      return false;
    }
    const own = [trustProxy ? req.headers["x-forwarded-host"] : null, req.headers.host].filter(Boolean).flatMap((h) => String(h).split(",").map((x) => x.trim()));
    if (own.includes(originHost)) return true;
    return publicOrigins.some((allowed) => {
      try {
        return new URL(allowed).host === originHost;
      } catch {
        return false;
      }
    });
  }

  /**
   * Who opened a request, for per-source limits: the socket's address, or, when the socket is loopback (the preview
   * tunnel, a local proxy), the address the closest proxy appended to x-forwarded-for (Traefik replaces the header
   * for clients it does not trust, so the last entry is the one it saw). A loopback request with no such header is
   * this machine itself and is not limited per source.
   */
  function sourceOf(req) {
    const socket = String(req.socket?.remoteAddress || "").replace(/^::ffff:/, "");
    if (socket && !/^(127\.|::1$)/.test(socket)) return socket;
    const forwarded = String(req.headers["x-forwarded-for"] || "").split(",").map((x) => x.trim()).filter(Boolean);
    return forwarded.at(-1) || null;
  }

  /** The intents the binder runs for this request: agent intents too when the owner clicked on this machine. */
  function runnableFor(site, req) {
    return site.ownerRunnable.size && ownerLocal(req) ? new Set([...site.runnable, ...site.ownerRunnable]) : site.runnable;
  }

  /** The agent intents a click on this request hands to Studio (an ask as the clicker), not to the binder. */
  function asksFor(site, req) {
    return site.ownerRunnable.size && ownerLocal(req) ? new Set() : site.asks;
  }

  function hello(site, req) {
    return hostMessage("hello", {
      capabilities: { intents: [...runnableFor(site, req)], asks: [...asksFor(site, req)] },
      parentOrigins: parentOriginsFor(site, req),
    });
  }

  async function handleIntent(site, req, res, url) {
    if (!viewerOk(site, req, url)) return json(res, 401, { status: "rejected", reason: "token" });
    // A header token proves a same-origin script (or a non-browser client); a cookie alone needs the Origin check.
    if (!headerTokenOk(site, req) && !originOk(req)) return json(res, 403, { status: "rejected", reason: "origin" });
    if (!String(req.headers["content-type"] || "").toLowerCase().startsWith("application/json")) {
      return json(res, 415, { status: "rejected", reason: "content-type must be application/json" });
    }
    let body;
    try {
      body = await readBody(req, MAX_INTENT_BYTES);
    } catch (error) {
      return refuseBody(req, res, error, { status: "rejected", reason: error.status === 413 ? "too_large" : "bad body" });
    }
    let msg;
    try {
      msg = JSON.parse(body);
    } catch {
      return json(res, 400, { status: "rejected", reason: "body is not JSON" });
    }
    const envelope = checkIntentEnvelope(msg);
    if (envelope) return json(res, 400, { status: "rejected", id: msg?.id, reason: envelope });
    delete msg.by; // unverified hint; the binder stamps its own observer

    if (msg.name === "cancel") {
      const target = msg.params?.id;
      const result = typeof target === "string" ? site.jobs.cancel(target, msg.params?.key) : null;
      if (result?.denied) return json(res, 403, { status: "rejected", id: msg.id, reason: "only the viewer who sent an intent can cancel it" });
      return result ? json(res, 200, { status: "cancelled", id: msg.id, job: result.job.id }) : json(res, 404, { status: "rejected", id: msg.id, reason: "no active job for that id" });
    }
    const def = site.bound.intents[msg.name];
    if (!def || !Object.prototype.hasOwnProperty.call(site.bound.intents, msg.name)) {
      return json(res, 404, { status: "rejected", id: msg.id, reason: "unknown intent" });
    }
    // An agent intent from anyone but the owner on this machine is an ask: the page hands it to Studio, which sends
    // it as the clicker's own message. The binder never starts an Octo turn for it (and holds no login to do so).
    // (The owner's own click on this machine with --agent-executor but no usable login hears why instead, below.)
    const ownerHearsWhy = agentExecutor && ownerLocal(req) && site.unavailable[msg.name];
    if (site.asks.has(msg.name) && !runnableFor(site, req).has(msg.name) && !ownerHearsWhy) {
      return json(res, 409, { status: "rejected", id: msg.id, reason: "ask_via_host" });
    }
    if (!runnableFor(site, req).has(msg.name)) return json(res, 404, { status: "rejected", id: msg.id, reason: site.unavailable[msg.name] || "not available" });
    const params = applyDefaults(def.params, msg.params);
    if (Buffer.byteLength(JSON.stringify(params)) > MAX_PARAMS_BYTES) return json(res, 400, { status: "rejected", id: msg.id, reason: "params_too_large" });
    const errors = validate(def.params, params);
    if (errors.length) return json(res, 400, { status: "rejected", id: msg.id, reason: formatErrors(errors) });
    // URL params: public addresses only, and inside agent.allowed_origins for agent intents (the page a viewer
    // points Octo's browser at is part of the prompt's attack surface).
    const allowedOrigins = executorOf(def) === "agent" ? def.agent?.allowed_origins || null : null;
    const ssrf = await checkUriParams(def.params, params, { allowLocal, allowedOrigins, ...(lookup ? { lookup } : {}) });
    if (ssrf) return json(res, 400, { status: "rejected", id: msg.id, reason: `policy: ${ssrf}` });
    msg.params = params;
    const result = site.jobs.submit(msg, def);
    return json(res, result.http, result.body);
  }

  async function handleCommand(site, req, res) {
    if (!adminLocal(req)) return json(res, 403, { ok: false, reason: "admin calls are only accepted on the binder's loopback address" });
    if (!adminOk(req)) return json(res, 401, { ok: false, reason: "admin token required" });
    if (req.headers.origin && !originOk(req)) return json(res, 403, { ok: false, reason: "origin" });
    let body;
    try {
      body = JSON.parse(await readBody(req, MAX_COMMAND_BYTES));
    } catch (error) {
      return refuseBody(req, res, error, { ok: false, reason: error.status === 413 ? "too_large" : "body is not JSON" });
    }
    if (!COMMAND_NAMES.includes(body?.name)) return json(res, 400, { ok: false, reason: `name must be one of ${COMMAND_NAMES.join(", ")}` });
    const args = body.args ?? {};
    if (!args || typeof args !== "object" || Array.isArray(args)) return json(res, 400, { ok: false, reason: "args must be an object" });
    const event = site.hub.broadcast(hostMessage("command", { command: { name: body.name, args } }));
    log("info", `[${site.name}] command ${body.name} -> ${site.hub.size} viewer(s)`);
    return json(res, 202, { ok: true, event, viewers: site.hub.size });
  }

  async function handleConfirm(site, req, res) {
    if (!adminLocal(req)) return json(res, 403, { ok: false, reason: "admin calls are only accepted on the binder's loopback address" });
    if (!adminOk(req)) return json(res, 401, { ok: false, reason: "admin token required" });
    let body;
    try {
      body = JSON.parse(await readBody(req, 1024));
    } catch (error) {
      return refuseBody(req, res, error, { ok: false, reason: error.status === 413 ? "too_large" : "body is not JSON" });
    }
    const ids = body?.job === "all" ? site.jobs.pendingConfirmations().map((j) => j.id) : [body?.job];
    const done = ids.map((id) => site.jobs.confirm(id, body?.ok !== false)).filter(Boolean);
    return done.length ? json(res, 200, { ok: true, jobs: done.map((j) => j.id) }) : json(res, 404, { ok: false, reason: "no job waiting for confirmation" });
  }

  async function handleEndpoint(site, endpoint, req, res, url) {
    const method = req.method;
    const allow = (expected) => {
      if (method === expected || (expected === "GET" && method === "HEAD")) return true;
      json(res, 405, { ok: false, reason: "method not allowed" }, { allow: expected });
      return false;
    };
    switch (endpoint) {
      case "health":
        if (!allow("GET")) return;
        return json(res, 200, {
          ok: true, host: "instafy-bind", v: PROTOCOL_VERSION, intents: [...runnableFor(site, req)],
          catalog: intentCatalog(site.bound, runnableFor(site, req)),
          asks: intentCatalog(site.bound, asksFor(site, req)).map((def) => ({ ...def, via: "host" })),
          site: { title: site.title }, token: tokenNeeded(site, req),
          viewer: viewerOk(site, req, url), parentOrigins: parentOriginsFor(site, req),
          executors: { script: "ready", agent: agentState },
        });
      case "session": {
        // The client trades #k= for an HttpOnly cookie once, so EventSource, polling and the page's own fetches
        // carry the token without it sitting in URLs or in page-readable storage.
        if (!allow("POST")) return;
        if (!headerTokenOk(site, req)) return json(res, 401, { ok: false, reason: "token" });
        return json(res, 200, { ok: true }, { "set-cookie": tokenCookie(site, req) });
      }
      case "client.js":
        if (!allow("GET")) return;
        res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-cache", "x-content-type-options": "nosniff" });
        return res.end(method === "HEAD" ? undefined : fs.readFileSync(CLIENT_FILE));
      case "intent":
        if (!allow("POST")) return;
        return handleIntent(site, req, res, url);
      case "events":
        if (!allow("GET")) return;
        if (!viewerOk(site, req, url, { allowQuery: true })) return json(res, 401, { ok: false, reason: "token" });
        site.hub.attach(req, res, { hello: hello(site, req), lastEventId: req.headers["last-event-id"] ?? url.searchParams.get("lastEventId"), source: sourceOf(req) });
        return;
      case "jobs":
        if (!allow("GET")) return;
        if (!viewerOk(site, req, url) && !adminOk(req)) return json(res, 401, { ok: false, reason: "token" });
        return json(res, 200, { jobs: site.jobs.list() });
      case "records":
        if (!allow("GET")) return;
        if (!viewerOk(site, req, url)) return json(res, 401, { ok: false, reason: "token" });
        return json(res, 200, collectRecords(site.dir, site.bound));
      case "command":
        if (!allow("POST")) return;
        return handleCommand(site, req, res);
      case "confirm":
        if (!allow("POST")) return;
        return handleConfirm(site, req, res);
      default:
        return json(res, 404, { ok: false, reason: "unknown endpoint" });
    }
  }

  function galleryIndex(res) {
    const items = sites.map((s) => `<li><a href="${escapeHtml(s.prefix)}/">${escapeHtml(s.title)}</a></li>`).join("");
    const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Bound sites</title><body style="font:16px system-ui;margin:24px"><h1>Bound sites</h1><ul>${items}</ul><p>Share links with their #k= token are printed by <code>instafy-bind serve</code>.</p></body>`;
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" });
    res.end(html);
    return true;
  }

  function tokenCookie(site, req) {
    const secure = trustProxy && req.headers["x-forwarded-proto"] === "https" ? "; Secure" : "";
    return `${site.cookie}=${site.token}; Path=${site.prefix || "/"}; HttpOnly; SameSite=Lax${secure}`;
  }

  /**
   * frame-ancestors for HTML: the site itself plus bound.json parentOrigins. On a preview capability host, the Studio
   * origin `instafy preview open` recorded for it as well. A preview with no recorded Studio origin (an older
   * controller or CLI) gets no header, so Studio can still show it, but its page then takes no host messages
   * (parentOriginsFor): no asks, no location from the host and no follow mode.
   */
  function frameHeaders(site, req) {
    const hostHeader = String(req?.headers.host || "").toLowerCase();
    const studios = req ? previewStudioOrigins(hostHeader) : null;
    if (studios) {
      const origins = parentOriginsFor(site, req);
      return studios.length ? { "content-security-policy": `frame-ancestors 'self' ${origins.join(" ")}` } : {};
    }
    // Preview mode on a loopback name: `instafy preview check` frames the site from a throwaway page on another
    // loopback port, so loopback origins may frame it too. Only pages served from this machine have such an origin,
    // and preview mode has no viewer token for a framing page to steal anyway.
    const loopback = preview && LOOPBACK_HOST.test(hostHeader) ? LOOPBACK_ANCESTORS : [];
    const ancestors = ["'self'", ...loopback, ...(site?.bound.parentOrigins || [])].join(" ");
    return { "content-security-policy": `frame-ancestors ${ancestors}` };
  }

  const server = http.createServer((req, res) => {
    let url;
    try {
      url = new URL(req.url, "http://binder.local");
    } catch {
      return json(res, 400, { ok: false });
    }
    if (!hostOk(req)) {
      const reason = preview
        ? `unexpected Host header: this binder answers localhost and the private preview opened with \`instafy preview open --port ${address?.port}\``
        : "unexpected Host header (start serve with --public-url for other names)";
      return json(res, 421, { ok: false, reason });
    }
    const match = ENDPOINT_RE.exec(url.pathname);
    if (match) {
      const site = siteFor(match[1]);
      if (!site) return json(res, 404, { ok: false, reason: "no bound site here" });
      Promise.resolve(handleEndpoint(site, match[2], req, res, url)).catch((error) => {
        log("error", `${req.method} ${url.pathname}: ${error.stack || error.message}`);
        if (!res.headersSent) json(res, 500, { ok: false, reason: "internal error" });
        else res.end();
      });
      return;
    }
    // Token handoff for pages without the bind client: GET <page>?k=<token> sets an HttpOnly cookie scoped to the
    // site and redirects to the clean URL, so same-origin fetch and EventSource carry the token on their own.
    const offered = req.method === "GET" ? url.searchParams.get("k") : null;
    if (offered) {
      const site = siteFor(url.pathname);
      if (site?.token && tokensEqual(offered, site.token)) {
        url.searchParams.delete("k");
        res.writeHead(303, {
          location: `${url.pathname}${url.search}`,
          "set-cookie": tokenCookie(site, req),
          "cache-control": "no-store",
          "referrer-policy": "no-referrer",
        });
        return res.end();
      }
    }
    const gallery = sites.length > 1 || sites[0].prefix !== "";
    if (gallery && (url.pathname === "/" || url.pathname === "")) return galleryIndex(res);
    // Only discovered site folders are served; a gallery root's other folders never are.
    const site = siteFor(url.pathname);
    if (!site) return json(res, 404, { ok: false, reason: "not found" });
    if (url.pathname === site.prefix) {
      res.writeHead(301, { location: `${site.prefix}/${url.search}` });
      return res.end();
    }
    let rel;
    try {
      rel = decodeURIComponent(url.pathname.slice(site.prefix.length)).replace(/^\/+/, "");
    } catch {
      return json(res, 400, { ok: false });
    }
    const guard = guardedPath(site.realDir, rel);
    if (guard.hidden) return json(res, 404, { ok: false, reason: "not found" });
    if (guard.viewerOnly && !viewerOk(site, req, url)) return json(res, 401, { ok: false, reason: "token" });
    serveStatic(req, res, site.dir, url.pathname.slice(site.prefix.length) || "/", {
      query: url.search.slice(1),
      redirectBase: site.prefix,
      htmlHeaders: frameHeaders(site, req),
      htmlTransform: site.plain ? (html) => withBindClient(html, site.prefix) : null,
    });
  });
  server.keepAliveTimeout = 5000;
  server.headersTimeout = 15_000;
  server.requestTimeout = 30_000;

  let address = null;
  const binder = {
    root,
    sites,
    server,
    controller: controllerConfig,
    preview,
    agentState,
    agentReason: agentReason || publicAgentReason,
    get url() {
      return address ? `http://${host.includes(":") ? `[${host}]` : host}:${address.port}` : null;
    },
    shareUrl(site, base = binder.url, style = site.linkStyle) {
      const publicBase = publicOrigins.some((origin) => trimEnd(origin, "/") === trimEnd(String(base), "/"));
      if (!site.token || (preview && !publicBase)) return `${base}${site.prefix}/`;
      return style === "query" ? `${base}${site.prefix}/?k=${site.token}` : `${base}${site.prefix}/#k=${site.token}`;
    },
    adminToken: admin,
    listen() {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          server.off("error", reject);
          address = server.address();
          resolve(binder);
        });
      });
    },
    async close() {
      for (const site of sites) {
        site.jobs.close();
        site.hub.close();
        // What is left is committed now, so a stopped binder leaves nothing it wrote unsaved.
        if (site.saver) releaseSiteWrites(site.dir);
      }
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
  return binder;
}

export { executorOf };
