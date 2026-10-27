// SPDX-License-Identifier: AGPL-3.0-only
//
// `instafy preview check`: let the agent look at a site it is serving in this space before the person sees it.
// Any site, nothing site-specific: it loads http://127.0.0.1:<port><path> (or [::1]) in a headless Chromium, waits
// for it to settle, and reports the page title, console and page errors, failed requests and a blank page. It writes
// a desktop and a phone screenshot the agent can open. `--framed` loads the site inside a frame on another origin
// instead, for a caller that will show it that way. It is local only: it calls no Instafy server.
//
// What the page may load is Instafy's decision, not the page's: the site's own origin directly; every other public
// address through the runtime image's egress proxy (public addresses on ports 80 and 443 only, connected to the address
// it checked); never another local port, a private or reserved address, or a site the link-only list names. Without the
// proxy nothing off the site's origin is loaded. Blocked requests are listed as `blocked`, not as page errors.
//
// The browser is the one the runtime image already ships: its trusted Playwright (the path the Shared Browser uses, or
// a global install) and its Chromium (the Playwright base image's, or the distro's). Nothing is downloaded, and a
// project's own node_modules is used only with --workspace-playwright. The Shared Browser's CDP port is deliberately
// not used: it carries the user's signed-in profile and is reachable only through its own broker.
//
// Exit codes: 0 no problems, 1 problems found (listed), 2 nothing answers on the port (in time), 3 the port is not allowed,
// 4 no browser available (nothing was checked), 64 bad options, 70 the check itself failed (nothing was checked).
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import http from "node:http";
import net, { type AddressInfo } from "node:net";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import type { Command } from "commander";
import { isLocalHostName, isPrivateAddress } from "@instafy/bind/net";
import { defaultSkillRoots, listedSite, loadLinkOnlyGuard, type LinkOnlyGuard } from "./web-read.js";
import {
  PREVIEW_EXIT_NOT_LISTENING,
  PreviewCommandError,
  noAnswerMessage,
  parsePreviewPort,
  probeLocalSite,
} from "./local-site.js";

export const CHECK_EXIT_OK = 0;
export const CHECK_EXIT_PROBLEMS = 1;
export const CHECK_EXIT_NOT_LISTENING = PREVIEW_EXIT_NOT_LISTENING;
export const CHECK_EXIT_NO_BROWSER = 4;
/** A bad invocation (a missing --port, a bad --path, --timeout or --wait), never "problems found". */
export const CHECK_EXIT_USAGE = 64;
/** The tool itself failed (an unusable --out, a browser that crashed while being set up): nothing was checked. */
export const CHECK_EXIT_INTERNAL = 70;

const MAX_PATH_LENGTH = 512;
const MAX_LIST = 20;
const MAX_TEXT = 300;
// With --framed, the frame page comes from a throwaway server on loopback, opened as http://localhost:<its port> while
// the site is http://127.0.0.1:<port>: another origin, and both loopback, so Chromium's local-network-access
// checks let the frame load (a page answered from memory counts as public and may not frame a loopback site).
// Software WebGL, so canvas and WebGL pages draw in a container without a GPU.
const CHROMIUM_ARGS = ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist", "--disable-dev-shm-usage"];
// What software WebGL logs on its own; it says nothing about the site.
const SOFTWARE_GL_NOISE =
  /GL Driver Message|GPU stall due to ReadPixels|READ-usage buffer was written|WebGL: too many errors|Automatic fallback to software WebGL/;
const PHONE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

export type CheckViewport = {
  name: "desktop" | "phone";
  width: number;
  height: number;
  mobile: boolean;
};

export const VIEWPORTS: CheckViewport[] = [
  { name: "desktop", width: 1280, height: 800, mobile: false },
  { name: "phone", width: 390, height: 844, mobile: true },
];

// ---------------------------------------------------------------------------------------------------------------
// The engine: which Playwright and which Chromium

export type BrowserEngine = {
  /** folder of the playwright (or playwright-core) package */
  playwright: string;
  /** where it was found: the runtime's trusted path, a global folder, or (only when asked) the workspace */
  source: "trusted" | "global" | "workspace";
};

/** The runtime image's trusted Playwright, the same variables the Shared Browser reads. */
export const TRUSTED_PLAYWRIGHT_PATH_ENV = "INSTAFY_SHARED_BROWSER_PLAYWRIGHT_PATH";
export const TRUSTED_NODE_MODULES_ROOT_ENV = "INSTAFY_SHARED_BROWSER_TRUSTED_NODE_MODULES_ROOT";

export type LocateOptions = {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  /** global node_modules folders to look in; default: NODE_PATH, `npm root -g`, the usual system folders */
  globalRoots?: string[];
  /** also look in node_modules from cwd upwards, last; that runs the project's own copy, so only on request */
  workspace?: boolean;
};

function isPlaywrightDir(dir: string): boolean {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")) as { name?: string };
    return pkg.name === "playwright" || pkg.name === "playwright-core";
  } catch {
    return false;
  }
}

function playwrightIn(nodeModules: string): string[] {
  const found: string[] = [];
  for (const name of ["playwright", "playwright-core"]) {
    const dir = path.join(nodeModules, name);
    if (isPlaywrightDir(dir)) found.push(dir);
  }
  // pnpm keeps packages in node_modules/.pnpm/<name>@<version>/node_modules/<name>
  try {
    const store = path.join(nodeModules, ".pnpm");
    for (const entry of fs.readdirSync(store).filter((e) => /^playwright(-core)?@\d/.test(e)).sort().reverse()) {
      const name = entry.startsWith("playwright-core@") ? "playwright-core" : "playwright";
      const dir = path.join(store, entry, "node_modules", name);
      if (isPlaywrightDir(dir)) found.push(dir);
    }
  } catch {
    // no pnpm store
  }
  return found;
}

let npmRootCache: string | null | undefined;
function npmGlobalRoot(): string | null {
  if (npmRootCache !== undefined) return npmRootCache;
  try {
    // From the filesystem root, so a project's .npmrc cannot move the global folder.
    const out = spawnSync("npm", ["root", "-g"], { cwd: path.parse(process.cwd()).root, encoding: "utf8", timeout: 5_000, stdio: ["ignore", "pipe", "ignore"] });
    npmRootCache = out.status === 0 && out.stdout.trim() ? out.stdout.trim() : null;
  } catch {
    npmRootCache = null;
  }
  return npmRootCache;
}

/** Absolute global node_modules folders only: a relative NODE_PATH entry would resolve inside the workspace. */
export function defaultGlobalRoots(env: NodeJS.ProcessEnv = process.env): string[] {
  const roots: string[] = [];
  for (const entry of (env.NODE_PATH ?? "").split(path.delimiter)) if (path.isAbsolute(entry.trim())) roots.push(entry.trim());
  const npmRoot = npmGlobalRoot();
  if (npmRoot && path.isAbsolute(npmRoot)) roots.push(npmRoot);
  roots.push("/usr/lib/node_modules", "/usr/local/lib/node_modules", "/opt/homebrew/lib/node_modules");
  return [...new Set(roots)];
}

/**
 * Find a Playwright package, trusted locations first: the runtime's own path (the variables the Shared Browser uses),
 * then global folders, then, only when asked, the workspace. Nothing is resolved by bare name from the workspace, so
 * a project's node_modules cannot put code into this process unless the caller opted in.
 */
export function locateBrowserEngine(o: LocateOptions = {}): { engine: BrowserEngine | null; tried: string[] } {
  const env = o.env ?? process.env;
  const tried: string[] = [];
  const trustedPath = env[TRUSTED_PLAYWRIGHT_PATH_ENV]?.trim();
  if (trustedPath) {
    if (path.isAbsolute(trustedPath) && isPlaywrightDir(trustedPath)) return { engine: { playwright: trustedPath, source: "trusted" }, tried };
    tried.push(`$${TRUSTED_PLAYWRIGHT_PATH_ENV} is not an absolute path to a playwright package`);
  }
  const trustedRoot = env[TRUSTED_NODE_MODULES_ROOT_ENV]?.trim();
  if (trustedRoot) {
    const found = path.isAbsolute(trustedRoot) ? playwrightIn(trustedRoot) : [];
    if (found.length) return { engine: { playwright: found[0]!, source: "trusted" }, tried };
    tried.push(`no playwright in $${TRUSTED_NODE_MODULES_ROOT_ENV}`);
  }
  for (const root of o.globalRoots ?? defaultGlobalRoots(env)) {
    const found = playwrightIn(root);
    if (found.length) return { engine: { playwright: found[0]!, source: "global" }, tried };
    tried.push(`none in ${root}`);
  }
  if (!o.workspace) {
    tried.push("the workspace was not searched (--workspace-playwright)");
    return { engine: null, tried };
  }
  let dir = path.resolve(o.cwd ?? process.cwd());
  for (let i = 0; i < 16; i += 1) {
    const found = playwrightIn(path.join(dir, "node_modules"));
    if (found.length) return { engine: { playwright: found[0]!, source: "workspace" }, tried };
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  tried.push(`no node_modules/playwright from ${o.cwd ?? process.cwd()} upwards`);
  return { engine: null, tried };
}

/** Chromium binaries to try when Playwright's own browser is missing (a version mismatch, or a distro image). */
export function chromiumCandidates(env: NodeJS.ProcessEnv = process.env, exists: (p: string) => boolean = fs.existsSync): string[] {
  const out: string[] = [];
  const browsersRoots = [env.PLAYWRIGHT_BROWSERS_PATH, "/ms-playwright", path.join(os.homedir(), ".cache", "ms-playwright")]
    .filter((x): x is string => Boolean(x && x !== "0"));
  for (const root of [...new Set(browsersRoots)]) {
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(root).sort().reverse();
    } catch {
      continue;
    }
    for (const e of entries.filter((x) => x.startsWith("chromium_headless_shell-"))) {
      out.push(path.join(root, e, "chrome-headless-shell-linux64", "chrome-headless-shell"));
      out.push(path.join(root, e, "chrome-linux", "headless_shell"));
    }
    for (const e of entries.filter((x) => /^chromium-\d/.test(x))) {
      out.push(path.join(root, e, "chrome-linux64", "chrome"), path.join(root, e, "chrome-linux", "chrome"));
    }
  }
  out.push(
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
  );
  return out.filter((p) => exists(p));
}

type Playwright = { chromium: { launch(o: Record<string, unknown>): Promise<any>; executablePath(): string } };

export function loadPlaywright(engine: BrowserEngine): Playwright {
  const req = createRequire(path.join(engine.playwright, "package.json"));
  const mod = req(engine.playwright) as Playwright & { default?: Playwright };
  const pw = mod?.chromium ? mod : mod?.default;
  if (!pw?.chromium) throw new Error(`${engine.playwright} has no chromium export`);
  return pw;
}

/** Launch headless Chromium: Playwright's own browser first, then the other binaries on this machine. */
export async function launchChromium(
  pw: Playwright,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ browser: any; executable: string }> {
  const errors: string[] = [];
  try {
    const browser = await pw.chromium.launch({ headless: true, args: CHROMIUM_ARGS });
    return { browser, executable: "playwright" };
  } catch (error) {
    errors.push(firstLine(error));
  }
  for (const executablePath of chromiumCandidates(env)) {
    try {
      const browser = await pw.chromium.launch({ headless: true, executablePath, args: CHROMIUM_ARGS });
      return { browser, executable: executablePath };
    } catch (error) {
      errors.push(`${executablePath}: ${firstLine(error)}`);
    }
  }
  throw new NoBrowserError(`No Chromium would start (${errors.join("; ") || "none found"})`);
}

export class NoBrowserError extends Error {}

function firstLine(error: unknown): string {
  return String((error as Error)?.message ?? error).split("\n")[0]!.slice(0, MAX_TEXT);
}

// ---------------------------------------------------------------------------------------------------------------
// What the headless browser may load

/**
 * The rules for one page load. `direct` origins load without the proxy: the site's own (and with --framed the frame
 * page's). `offSite` says whether anything else may go out at all: through the egress proxy, or nowhere when this
 * machine has none. `linkOnly` is the link-only list; null when it did not load, which blocks every request off the site.
 */
export type RequestRules = {
  direct: string[];
  offSite: "proxy" | "blocked";
  linkOnly: LinkOnlyGuard | null;
};

export type RequestVerdict = { kind: "direct" } | { kind: "proxy" } | { kind: "blocked"; reason: string };

const blocked = (reason: string): RequestVerdict => ({ kind: "blocked", reason });

function isLoopbackAddress(ip: string): boolean {
  return net.isIPv4(ip) ? ip.startsWith("127.") : /^(?:0*:)*:?0*1$/.test(ip) || ip === "::ffff:127.0.0.1";
}

/** Where one request may go. Nothing a page says changes it. */
export function classifyRequest(raw: string, rules: RequestRules): RequestVerdict {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return blocked("not a valid address");
  }
  // In-page data, never a request.
  if (url.protocol === "data:" || url.protocol === "blob:" || url.protocol === "about:") return { kind: "direct" };
  const scheme = url.protocol === "ws:" ? "http:" : url.protocol === "wss:" ? "https:" : url.protocol;
  if (scheme !== "http:" && scheme !== "https:") return blocked(`${url.protocol.replace(/:$/, "")} addresses are not loaded`);
  if (rules.direct.includes(`${scheme}//${url.host}`)) return { kind: "direct" };
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (net.isIP(host)) {
    if (isLoopbackAddress(host)) return blocked("another local server: only the site's own port is loaded");
    if (isPrivateAddress(host)) return blocked("a private or reserved address");
  } else if (isLocalHostName(host) || host.endsWith(".localhost")) {
    return blocked("a local host name");
  }
  if (url.username || url.password) return blocked("an address with a user name or password");
  if (url.port && url.port !== "80" && url.port !== "443") return blocked(`port ${url.port}: only the web ports 80 and 443 are loaded`);
  if (rules.offSite === "blocked") return blocked("this machine has no egress proxy, so nothing off the site is loaded");
  if (!rules.linkOnly) return blocked("the link-only site list could not be loaded");
  const web = new URL(url.href);
  web.protocol = scheme;
  // Either kind: a "no-agents" site is never fetched, and a "no-reuse" one's content must not end up in a picture that
  // Instafy keeps and shows (a check's desktop picture becomes the card's).
  const listed = listedSite(web, rules.linkOnly);
  if (listed) {
    return blocked(
      listed.kind === "no-reuse"
        ? `${listed.name} bars reusing its content (${listed.reason})`
        : `${listed.name} is link-only (${listed.reason})`,
    );
  }
  return { kind: "proxy" };
}

/** The link-only list the capture enforces: the bundled one plus any a skill in reach adds (as `instafy web read`). */
export function loadCaptureLinkOnly(cwd: string, env: NodeJS.ProcessEnv): LinkOnlyGuard | null {
  try {
    return loadLinkOnlyGuard(defaultSkillRoots(cwd, env));
  } catch {
    return null;
  }
}

/** Where requests off the site go for one run: the image's egress proxy, or a local stand-in that refuses them all. */
export type OffSiteRoute = { server: string; kind: "proxy" | "blocked"; stop: () => Promise<void> };

/** The runtime image's egress proxy: only its fixed install locations, never one found in the workspace. */
export const EGRESS_PROXY_LOCATIONS = ["/usr/local/bin/browser-egress-proxy", "/usr/bin/browser-egress-proxy"];
const EGRESS_PROXY_READY_MS = 3_000;

async function freeLoopbackPort(): Promise<number> {
  const server = net.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function proxyAnswers(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const request = http.get({ host: "127.0.0.1", port, path: "/healthz", timeout: 500 }, (response) => {
      response.resume();
      resolve(response.statusCode === 200);
    });
    request.on("timeout", () => request.destroy());
    request.on("error", () => resolve(false));
  });
}

async function startEgressProxy(binary: string): Promise<OffSiteRoute | null> {
  const port = await freeLoopbackPort();
  // Its own instance on a free loopback port, with nothing of this process's environment.
  const child = spawn(binary, [], {
    env: { PATH: "/usr/local/bin:/usr/bin:/bin", INSTAFY_BROWSER_EGRESS_PROXY_BIND: `127.0.0.1:${port}` },
    stdio: "ignore",
  });
  let exited = false;
  child.on("exit", () => {
    exited = true;
  });
  child.on("error", () => {
    exited = true;
  });
  const stop = async () => {
    if (exited) return;
    child.kill("SIGTERM");
    await Promise.race([once(child, "exit"), new Promise((resolve) => setTimeout(resolve, 1_000))]);
  };
  const deadline = Date.now() + EGRESS_PROXY_READY_MS;
  while (!exited && Date.now() < deadline) {
    if (await proxyAnswers(port)) return { server: `http://127.0.0.1:${port}`, kind: "proxy", stop };
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  await stop();
  return null;
}

/** A proxy that refuses every request, so a page cannot reach anything off the site even past the request rules. */
async function startRefusingProxy(): Promise<OffSiteRoute> {
  const server = http.createServer((_req, res) => {
    res.writeHead(403, { "content-type": "text/plain" });
    res.end("blocked: only the site itself is loaded here");
  });
  server.on("connect", (_req, socket: net.Socket) => {
    socket.on("error", () => {});
    socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  return { server: `http://127.0.0.1:${port}`, kind: "blocked", stop: () => new Promise((resolve) => server.close(() => resolve())) };
}

/**
 * Where this run sends requests off the site. `proxyServer` is a test hook: a proxy the caller runs itself.
 */
export async function startOffSiteRoute(options: { proxyServer?: string; locations?: string[] } = {}): Promise<OffSiteRoute> {
  if (options.proxyServer) return { server: options.proxyServer, kind: "proxy", stop: async () => {} };
  for (const binary of options.locations ?? EGRESS_PROXY_LOCATIONS) {
    let usable = false;
    try {
      usable = fs.statSync(binary).isFile();
    } catch {
      usable = false;
    }
    if (!usable) continue;
    const route = await startEgressProxy(binary).catch(() => null);
    if (route) return route;
  }
  return startRefusingProxy();
}

/** The proxy settings for a context: everything goes through `route`, except the direct origins. */
export function contextProxy(route: OffSiteRoute, direct: string[]): { server: string; bypass: string } {
  return { server: route.server, bypass: direct.map((origin) => new URL(origin).host).join(",") };
}

/**
 * Applies `rules` to every request and WebSocket of a context. A blocked one is aborted and passed to `onBlocked`
 * with its reason.
 */
export async function applyRequestRules(context: any, rules: RequestRules, onBlocked: (url: string, reason: string) => void) {
  await context.route("**/*", async (route: any) => {
    const url = String(route.request().url());
    const verdict = classifyRequest(url, rules);
    if (verdict.kind === "blocked") {
      onBlocked(url, verdict.reason);
      await route.abort("blockedbyclient").catch(() => {});
      return;
    }
    await route.continue().catch(() => {});
  });
  if (typeof context.routeWebSocket === "function") {
    await context.routeWebSocket(
      (url: URL) => classifyRequest(url.href, rules).kind === "blocked",
      (socket: any) => {
        const url = String(socket.url());
        const verdict = classifyRequest(url, rules);
        onBlocked(url, verdict.kind === "blocked" ? verdict.reason : "blocked");
        void Promise.resolve(socket.close({ code: 1008, reason: "blocked" })).catch(() => {});
      },
    );
  }
}

/** Windows the site opens are closed at once. */
export function closePopups(page: any) {
  page.on("popup", (popup: any) => void popup.close().catch(() => {}));
}

/** A request the egress proxy refused (it answers CONNECT for a private address or another port with 403). */
const PROXY_REFUSED = /ERR_TUNNEL_CONNECTION_FAILED|ERR_PROXY_CONNECTION_FAILED/;

// ---------------------------------------------------------------------------------------------------------------
// The card's picture

/** The card's picture: 640×400, half the desktop size. */
export const THUMBNAIL_WIDTH = 640;
export const THUMBNAIL_HEIGHT = 400;
/** Over this at quality 70 it is taken again at 50, and skipped when still over. */
export const MAX_CAPTURE_BYTES = 256 * 1024;
const PAGE_DESCRIPTION_MAX = 300;

/** One plain line, no control or direction characters, at most 300 characters; null when nothing is left. */
export function cleanDescription(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const text = raw
    .replace(/[\u202A-\u202E\u2066-\u2069\u200E\u200F\u061C]/g, "")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text ? [...text].slice(0, PAGE_DESCRIPTION_MAX).join("").trim() : null;
}

/** The page's own `<meta name="description">`, cleaned. */
export async function readPageDescription(frame: any): Promise<string | null> {
  const raw = await frame
    .evaluate(() => document.querySelector('meta[name="description" i]')?.getAttribute("content") ?? null)
    .catch(() => null);
  return cleanDescription(raw);
}

/**
 * What the page shows now as a 640×400 JPEG: the viewport at half size, quality 70, or 50 when that is over 256 KiB.
 * `skipped` says why there is none.
 */
export async function pageThumbnail(page: any, context: any): Promise<{ image: Buffer } | { skipped: string }> {
  const cdp = await context.newCDPSession(page);
  try {
    const metrics = await cdp.send("Page.getLayoutMetrics");
    const view = metrics.cssVisualViewport ?? metrics.visualViewport ?? {};
    const clip = {
      x: Number(view.pageX) || 0,
      y: Number(view.pageY) || 0,
      width: THUMBNAIL_WIDTH * 2,
      height: THUMBNAIL_HEIGHT * 2,
      scale: 0.5,
    };
    for (const quality of [70, 50]) {
      const { data } = await cdp.send("Page.captureScreenshot", { format: "jpeg", quality, clip, captureBeyondViewport: false });
      const image = Buffer.from(String(data), "base64");
      if (image.length <= MAX_CAPTURE_BYTES) return { image };
    }
    return { skipped: `the picture was over ${MAX_CAPTURE_BYTES / 1024} KiB even at quality 50` };
  } finally {
    await cdp.detach().catch(() => {});
  }
}

/** The desktop page's picture from a check, for the card of the preview on that port. */
export type CheckThumbnail = { image: Buffer; description: string | null } | { skipped: string };

// ---------------------------------------------------------------------------------------------------------------
// The check


export type ViewportReport = {
  name: CheckViewport["name"];
  width: number;
  height: number;
  screenshot: string | null;
  title: string;
  status: number | null;
  ms: number;
  blank: { blank: boolean; reason: string | null };
  errors: string[];
  warnings: string[];
  /** requests Instafy did not let the page make, with the reason; never page errors */
  blocked: string[];
};

export type SiteCheckReport = {
  ok: boolean;
  url: string;
  title: string;
  framed: boolean;
  engine: { playwright: string; chromium: string };
  viewports: ViewportReport[];
  problems: number;
  /** where requests off the site went: through the egress proxy, or nowhere (this machine has none) */
  offSite: "proxy" | "blocked";
  /** the card's picture: uploaded for the open preview on this port and path, or why not */
  thumbnail?: "uploaded" | "skipped" | "failed";
  thumbnailReason?: string;
};

export type SiteCheckOptions = {
  port: number;
  path?: string;
  phone?: boolean;
  /** load the site inside a frame on another origin instead of as the page itself */
  framed?: boolean;
  outDir?: string;
  timeoutMs?: number;
  waitMs?: number;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  /** search the workspace's node_modules for Playwright too (last) */
  workspacePlaywright?: boolean;
  /** test hook: where to look for a global Playwright */
  globalRoots?: string[];
  /** take a picture of the desktop page for the card (`instafy preview check` does when a preview is open on the port) */
  thumbnail?: boolean;
  /** test hook: send requests off the site to this proxy instead of the image's egress proxy */
  proxyServer?: string;
};

export function parseCheckPath(raw: string | undefined): string {
  const value = raw?.trim() || "/";
  if (!value.startsWith("/") || value.startsWith("//") || value.length > MAX_PATH_LENGTH || /[\s\\]/.test(value)) {
    throw new PreviewCommandError("Path must start with / and contain no spaces or backslashes (a ?query and #hash are fine).", CHECK_EXIT_USAGE);
  }
  return value;
}

/** The site URL for a path, percent-encoded by the URL parser and pinned to the site's origin. */
export function siteUrlFor(siteOrigin: string, sitePath: string): string {
  const url = new URL(sitePath, siteOrigin);
  if (url.origin !== siteOrigin) throw new PreviewCommandError("Path must stay on the site's own origin.", CHECK_EXIT_USAGE);
  return url.href;
}

/** Exact origin match: http://127.0.0.1:30001 is not the site on :3000. */
export function isSiteUrl(url: string, siteOrigin: string): boolean {
  try {
    return new URL(url).origin === siteOrigin;
  } catch {
    return false;
  }
}

/**
 * A new folder for one run's screenshots: a random name under the temp folder, made by mkdtemp, so it is readable
 * only by this user and nobody can create it first, swap the screenshots or plant links in it on a shared /tmp.
 */
export function makeDefaultOutDir(port: number): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `instafy-preview-check-${port}-`));
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** The page that holds the site in a full-size frame on another origin (`--framed`). */
export function framePage(siteUrl: string): string {
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>instafy preview check</title>
<style>html,body{margin:0;height:100%;background:#fff}iframe{display:block;border:0;width:100%;height:100%}</style>
<iframe id="site" src="${escapeAttribute(siteUrl)}" allow="fullscreen; clipboard-write"></iframe>`;
}

async function startFrameHost(siteUrl: string): Promise<{ url: string; close: () => void }> {
  const body = framePage(siteUrl);
  const server = http.createServer((req, res) => {
    if (req.url !== "/") {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(body);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  return { url: `http://localhost:${port}/`, close: () => server.close() };
}

/**
 * Is a screenshot one colour? `dominant` is the share of the most common (coarsely quantized) colour, or null when it
 * could not be measured; then the single-colour rule cannot apply (see `incompleteBlankCheck`).
 */
export function blankVerdict(input: {
  dominant: number | null;
  text: number;
  media: number;
  elements: number;
  framed: "ok" | "refused" | "missing";
}): { blank: boolean; reason: string | null } {
  // Only reachable with --framed: the caller asked whether the site can be shown inside a frame.
  if (input.framed === "refused") {
    return { blank: true, reason: "the site refuses to be framed (X-Frame-Options or CSP frame-ancestors), so the frame stays empty" };
  }
  if (input.framed === "missing") return { blank: true, reason: "the page did not load" };
  // One colour with no visible text: a canvas or app that drew nothing. Text alone on a plain background (a minimal
  // page) is not blank, though it covers far less than 0.5% of the screen.
  if (input.dominant !== null && input.dominant >= 0.995 && input.text === 0) return { blank: true, reason: "the screen is a single colour" };
  if (input.text === 0 && input.media === 0 && input.elements < 3) return { blank: true, reason: "the page has no text, images or canvas" };
  return { blank: false, reason: null };
}

/** The dominant-colour share, or null when measuring failed or gave something that is not a share. */
export async function measureDominantShare(measure: () => Promise<number>): Promise<number | null> {
  try {
    const share = await measure();
    return Number.isFinite(share) && share >= 0 && share <= 1 ? share : null;
  } catch {
    return null;
  }
}

/**
 * Said out loud when the screenshot could not be measured, never silently passed. With no text on the page only the
 * screenshot could show it drew something (a canvas that drew nothing still counts as media), so that is a problem;
 * with text it is a warning.
 */
export function incompleteBlankCheck(dominant: number | null, text: number): { error: boolean; message: string } | null {
  if (dominant !== null) return null;
  return text === 0
    ? { error: true, message: "blank check incomplete: could not read the screenshot, and the page has no text to show it drew anything" }
    : { error: false, message: "blank check incomplete: could not read the screenshot, so a single-colour screen would not be caught" };
}

const FRAME_SNAPSHOT = () => {
  const visible = (el: Element) => {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2 || r.bottom < 0 || r.right < 0 || r.top > innerHeight || r.left > innerWidth) return false;
    const s = getComputedStyle(el);
    return s.visibility !== "hidden" && s.display !== "none" && Number(s.opacity) > 0.05;
  };
  const body = document.body;
  const text = (body?.innerText ?? "").replace(/\s+/g, " ").trim().length;
  let media = 0;
  let elements = 0;
  for (const el of Array.from(body?.querySelectorAll("*") ?? [])) {
    if (/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|LINK|META)$/.test(el.tagName)) continue;
    if (!visible(el)) continue;
    elements += 1;
    if (/^(CANVAS|IMG|SVG|VIDEO|IFRAME|PICTURE|OBJECT|EMBED)$/i.test(el.tagName)) media += 1;
  }
  return { text, media, elements, title: document.title };
};

const DOMINANT_COLOUR = async (b64: string) => {
  const img = new Image();
  img.src = `data:image/png;base64,${b64}`;
  await img.decode();
  const w = 160;
  const h = Math.max(1, Math.round((img.height / img.width) * w));
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const g = c.getContext("2d")!;
  g.imageSmoothingEnabled = false;
  g.drawImage(img, 0, 0, w, h);
  const data = g.getImageData(0, 0, w, h).data;
  const counts = new Map<number, number>();
  let max = 0;
  for (let i = 0; i < data.length; i += 4) {
    const key = ((data[i]! >> 3) << 10) | ((data[i + 1]! >> 3) << 5) | (data[i + 2]! >> 3);
    const n = (counts.get(key) ?? 0) + 1;
    counts.set(key, n);
    if (n > max) max = n;
  }
  return max / (w * h);
};

type ViewportNetwork = { rules: RequestRules; route: OffSiteRoute };

async function checkViewport(
  browser: any,
  target: { pageUrl: string; framed: boolean },
  vp: CheckViewport,
  siteOrigin: string,
  outDir: string,
  timeoutMs: number,
  waitMs: number,
  network: ViewportNetwork,
  takeThumbnail: boolean,
): Promise<ViewportReport & { thumbnail?: CheckThumbnail }> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const blockedRequests = new Map<string, string>();
  const noteBlocked = (url: string, reason: string) => {
    if (!blockedRequests.has(url)) blockedRequests.set(url, reason);
  };
  const blockedList = () => [...blockedRequests].map(([url, reason]) => `${url.slice(0, 200)} (${reason})`).slice(0, MAX_LIST);
  // A fresh, anonymous context per size: no person's session, cookies, location or browser profile, no service
  // workers, no downloads, no permissions.
  const context = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    deviceScaleFactor: vp.mobile ? 2 : 1,
    isMobile: vp.mobile,
    hasTouch: vp.mobile,
    ...(vp.mobile ? { userAgent: PHONE_UA } : {}),
    reducedMotion: "reduce",
    serviceWorkers: "block",
    acceptDownloads: false,
    proxy: contextProxy(network.route, network.rules.direct),
  });
  const t0 = Date.now();
  let status: number | null = null;
  try {
    await applyRequestRules(context, network.rules, noteBlocked);
    const page = await context.newPage();
    closePopups(page);
    const ours = (u: string) => isSiteUrl(u, siteOrigin);
    const shortUrl = (u: string) => (ours(u) ? u.slice(siteOrigin.length) || "/" : u).slice(0, 200);
    page.on("console", (m: any) => {
      const text = String(m.text());
      if (/^Failed to load resource/.test(text)) return; // the request handlers below know the URL
      if (SOFTWARE_GL_NOISE.test(text)) return;
      if (/^Refused to display .* in a frame/.test(text)) return; // the refused frame is reported below
      if (m.type() === "error") errors.push(`console.error: ${text.slice(0, MAX_TEXT)}`);
    });
    page.on("pageerror", (e: Error) => errors.push(`uncaught: ${String(e?.message ?? e).split("\n")[0]!.slice(0, MAX_TEXT)}`));
    let refused = false;
    page.on("requestfailed", (r: any) => {
      const u = String(r.url());
      if (/\/favicon\.ico(\?|$)/.test(u)) return;
      // Instafy stopped it: listed as blocked, not as the page's failure.
      if (blockedRequests.has(u)) return;
      const why = r.failure()?.errorText ?? "failed";
      if (!ours(u) && PROXY_REFUSED.test(why)) {
        noteBlocked(u, "the egress proxy refused it: not a public address, or not a web port");
        return;
      }
      // X-Frame-Options or CSP frame-ancestors: reported once, as the reason the frame stays empty
      if (target.framed && ours(u) && r.isNavigationRequest() && /ERR_BLOCKED_BY_RESPONSE/.test(why)) {
        refused = true;
        return;
      }
      if (/ERR_ABORTED/.test(why)) return; // cancelled by the page itself (a fetch or image it no longer needs)
      (ours(u) ? errors : warnings).push(`request failed: ${shortUrl(u)} (${why})`);
    });
    page.on("response", (r: any) => {
      const u = String(r.url());
      const s = Number(r.status());
      if (r.request().isNavigationRequest() && ours(u) && status === null) status = s;
      if (s < 400 || /\/favicon\.ico(\?|$)/.test(u)) return;
      (ours(u) ? errors : warnings).push(`HTTP ${s}: ${shortUrl(u)}`);
    });

    await page.goto(target.pageUrl, { waitUntil: "load", timeout: timeoutMs });
    await page.waitForLoadState("networkidle", { timeout: Math.min(8_000, timeoutMs) }).catch(() => {
      warnings.push("the network was still busy after 8 s (screenshot taken anyway)");
    });
    const frame = target.framed
      ? page.frames().find((f: any) => f !== page.mainFrame() && isSiteUrl(String(f.url()), siteOrigin))
      : page.mainFrame();
    let framed: "ok" | "refused" | "missing" = "ok";
    let snap = { text: 0, media: 0, elements: 0, title: "" };
    if (refused) framed = "refused";
    else if (!frame) framed = "missing";
    else {
      await frame.evaluate(() => (document as Document & { fonts?: { ready: Promise<unknown> } }).fonts?.ready).catch(() => {});
      await page.waitForTimeout(waitMs);
      snap = await frame.evaluate(FRAME_SNAPSHOT).catch(() => snap);
    }
    if (status !== null && status >= 400) framed = "missing";
    const file = path.join(outDir, `${vp.name}.png`);
    const png: Buffer = await page.screenshot({ path: file });
    const dominant = await measureDominantShare(async () => {
      const helper = await context.newPage();
      try {
        return await helper.evaluate(DOMINANT_COLOUR, png.toString("base64"));
      } finally {
        await helper.close().catch(() => {});
      }
    });
    const blank = blankVerdict({ dominant, text: snap.text, media: snap.media, elements: snap.elements, framed });
    if (blank.blank) errors.push(`blank page: ${blank.reason}`);
    else {
      const incomplete = incompleteBlankCheck(dominant, snap.text);
      if (incomplete) (incomplete.error ? errors : warnings).push(incomplete.message);
    }
    let thumbnail: CheckThumbnail | undefined;
    if (takeThumbnail) {
      thumbnail = blank.blank
        ? { skipped: "the page looked blank" }
        : await pageThumbnail(page, context)
            .then(async (shot) => ("image" in shot ? { image: shot.image, description: await readPageDescription(page.mainFrame()) } : shot))
            .catch((error: unknown) => ({ skipped: `the picture could not be taken: ${firstLine(error)}` }));
    }
    return {
      name: vp.name,
      width: vp.width,
      height: vp.height,
      screenshot: file,
      title: snap.title.slice(0, 200),
      status,
      ms: Date.now() - t0,
      blank,
      errors: [...new Set(errors)].slice(0, MAX_LIST),
      warnings: [...new Set(warnings)].slice(0, MAX_LIST),
      blocked: blockedList(),
      ...(thumbnail ? { thumbnail } : {}),
    };
  } catch (error) {
    errors.push(`the page did not load: ${firstLine(error)}`);
    return {
      name: vp.name,
      width: vp.width,
      height: vp.height,
      screenshot: null,
      title: "",
      status,
      ms: Date.now() - t0,
      blank: { blank: true, reason: "the page did not load" },
      errors: [...new Set(errors)].slice(0, MAX_LIST),
      warnings: [...new Set(warnings)].slice(0, MAX_LIST),
      blocked: blockedList(),
      ...(takeThumbnail ? { thumbnail: { skipped: "the page did not load" } } : {}),
    };
  } finally {
    await context.close().catch(() => {});
  }
}

export async function runSiteCheck(
  opts: SiteCheckOptions,
): Promise<{ code: number; report: SiteCheckReport | null; message?: string; thumbnail?: CheckThumbnail }> {
  const env = opts.env ?? process.env;
  const port = parsePreviewPort(opts.port, env);
  const sitePath = parseCheckPath(opts.path);
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const viewports = VIEWPORTS.filter((v) => !opts.phone || v.name === "phone");
  let outDir: string | null = null;
  if (opts.outDir !== undefined) {
    outDir = path.resolve(opts.outDir);
    // An unusable --out fails here, before anything else, as the tool's own failure (exit 70).
    fs.mkdirSync(outDir, { recursive: true });
    // old screenshots would look like a check that happened
    for (const v of VIEWPORTS) fs.rmSync(path.join(outDir, `${v.name}.png`), { force: true });
  }

  const probePath = sitePath.replace(/[?#].*$/, "") || "/";
  // As long as the page load may take: a dev server compiling its first request is running, not missing.
  const probe = await probeLocalSite(port, probePath, timeoutMs);
  // Any HTTP answer means a server is up: a 500 is a problem the browser pass lists (exit 1), not "start the site".
  if (!probe.host) {
    return {
      code: CHECK_EXIT_NOT_LISTENING,
      report: null,
      message: noAnswerMessage(port, probe, `port ${port} at 127.0.0.1 or [::1]`, "check again"),
    };
  }

  const siteOrigin = `http://${probe.host}:${port}`;
  const url = siteUrlFor(siteOrigin, sitePath);

  const { engine, tried } = locateBrowserEngine({ env, cwd: opts.cwd, globalRoots: opts.globalRoots, workspace: opts.workspacePlaywright });
  if (!engine) {
    return { code: CHECK_EXIT_NO_BROWSER, report: null, message: `SKIPPED, nothing was checked: Playwright not found (${tried.join("; ")}).` };
  }
  let launched: { browser: any; executable: string };
  try {
    launched = await launchChromium(loadPlaywright(engine), env);
  } catch (error) {
    return { code: CHECK_EXIT_NO_BROWSER, report: null, message: `SKIPPED, nothing was checked: ${firstLine(error)}` };
  }
  const reports: ViewportReport[] = [];
  let host: { url: string; close: () => void } | null = null;
  let route: OffSiteRoute | null = null;
  let thumbnail: CheckThumbnail | undefined;
  try {
    const shots = outDir ?? makeDefaultOutDir(port);
    host = opts.framed ? await startFrameHost(url) : null;
    route = await startOffSiteRoute({ proxyServer: opts.proxyServer });
    const rules: RequestRules = {
      direct: host ? [siteOrigin, new URL(host.url).origin] : [siteOrigin],
      offSite: route.kind,
      linkOnly: loadCaptureLinkOnly(opts.cwd ?? process.cwd(), env),
    };
    const target = { pageUrl: host?.url ?? url, framed: Boolean(opts.framed) };
    for (const vp of viewports) {
      // The card shows the site as a page of its own, so only the plain desktop load is pictured.
      const takeThumbnail = Boolean(opts.thumbnail) && vp.name === "desktop" && !opts.framed;
      const { thumbnail: shot, ...report } = await checkViewport(
        launched.browser, target, vp, siteOrigin, shots, timeoutMs, opts.waitMs ?? 600, { rules, route }, takeThumbnail,
      );
      if (shot) thumbnail = shot;
      reports.push(report);
    }
  } finally {
    await launched.browser.close().catch(() => {});
    host?.close();
    await route?.stop().catch(() => {});
  }
  const problems = reports.reduce((n, r) => n + r.errors.length, 0);
  const report: SiteCheckReport = {
    ok: problems === 0,
    url,
    title: reports.find((r) => r.title)?.title ?? "",
    framed: Boolean(opts.framed),
    engine: { playwright: engine.playwright, chromium: launched.executable },
    viewports: reports,
    problems,
    offSite: route?.kind ?? "blocked",
  };
  return { code: problems ? CHECK_EXIT_PROBLEMS : CHECK_EXIT_OK, report, ...(thumbnail ? { thumbnail } : {}) };
}

export function formatSiteCheck(report: SiteCheckReport): string {
  const lines: string[] = [];
  lines.push(`${report.ok ? "✓" : "✗"} ${report.url}${report.framed ? " (framed)" : ""} · "${report.title || "(no title)"}"`);
  for (const r of report.viewports) {
    const timing = `${(r.ms / 1000).toFixed(1)} s${r.status ? `, HTTP ${r.status}` : ""}`;
    lines.push(`${r.errors.length ? "✗" : "✓"} ${r.name} ${r.width}×${r.height}: ${r.screenshot ?? "no screenshot"} (${timing})`);
    for (const e of r.errors) lines.push(`    error: ${e}`);
    for (const w of r.warnings.slice(0, 8)) lines.push(`    warn:  ${w}`);
    for (const b of r.blocked.slice(0, 8)) lines.push(`    blocked: ${b}`);
  }
  if (report.viewports.some((r) => r.blocked.length)) {
    lines.push("Blocked requests are Instafy's rule for this check, not the site's errors: people opening the preview reach only the site itself and public addresses.");
  }
  if (report.thumbnail === "uploaded") lines.push("The preview card's picture was updated.");
  else if (report.thumbnail) lines.push(`The preview card's picture was not updated (${report.thumbnailReason ?? report.thumbnail}).`);
  lines.push(
    report.ok
      ? "No problems found. Open the screenshots and check layout, legibility and overlap on both sizes."
      : "Fix every error above, reload the site, and run the check again. Open the screenshots either way.",
  );
  return lines.join("\n");
}

export type PreviewCheckCliOptions = {
  port?: string;
  path?: string;
  phone?: boolean;
  framed?: boolean;
  workspacePlaywright?: boolean;
  out?: string;
  timeout?: string;
  wait?: string;
  json?: boolean;
};

/**
 * Gives the check's desktop picture to the card of the preview open on that port and path, when there is one: `null`
 * when no preview is open there (nothing is uploaded and nothing is said).
 */
export type CheckThumbnailUploader = (input: {
  port: number;
  path: string;
  image: Buffer;
  description: string | null;
}) => Promise<{ status: "uploaded" | "skipped" | "failed"; reason?: string } | null>;

export type PreviewCheckIo = {
  out: (s: string) => void;
  err: (s: string) => void;
  env?: NodeJS.ProcessEnv;
  /** whether a preview is open on this port and path, so a picture is worth taking */
  hasOpenPreview?: (port: number, path: string) => boolean;
  uploadThumbnail?: CheckThumbnailUploader;
  /** test hook: see SiteCheckOptions.proxyServer */
  proxyServer?: string;
};

/** The CLI action; returns the exit code. */
export async function runPreviewCheckCli(opts: PreviewCheckCliOptions, io: PreviewCheckIo = { out: console.log, err: console.error }): Promise<number> {
  const env = io.env ?? process.env;
  const num = (raw: string | undefined, name: string, min: number, max: number) => {
    if (raw === undefined) return undefined;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < min || n > max) throw new PreviewCommandError(`${name} must be a whole number from ${min} to ${max}.`, CHECK_EXIT_USAGE);
    return n;
  };
  try {
    if (opts.port === undefined) throw new PreviewCommandError("--port <port> is required.", CHECK_EXIT_USAGE);
    const port = parsePreviewPort(opts.port, env);
    const sitePath = parseCheckPath(opts.path);
    const wantsThumbnail = Boolean(io.uploadThumbnail && io.hasOpenPreview?.(port, sitePath));
    const result = await runSiteCheck({
      port,
      path: opts.path,
      thumbnail: wantsThumbnail,
      proxyServer: io.proxyServer,
      phone: opts.phone,
      framed: opts.framed,
      workspacePlaywright: opts.workspacePlaywright,
      outDir: opts.out,
      timeoutMs: num(opts.timeout, "--timeout", 1_000, 120_000),
      waitMs: num(opts.wait, "--wait", 0, 30_000),
      env,
    });
    if (!result.report) {
      if (opts.json) io.out(JSON.stringify({ ok: false, exitCode: result.code, error: result.message, skipped: result.code === CHECK_EXIT_NO_BROWSER }));
      else io.err(result.message ?? "check failed");
      return result.code;
    }
    if (wantsThumbnail && result.thumbnail && io.uploadThumbnail) {
      // The picture never changes the check's exit code.
      const shot = result.thumbnail;
      const outcome =
        "skipped" in shot
          ? { status: "skipped" as const, reason: shot.skipped }
          : await io
              .uploadThumbnail({ port, path: sitePath, image: shot.image, description: shot.description })
              .catch((error: unknown) => ({ status: "failed" as const, reason: firstLine(error) }));
      if (outcome) {
        result.report.thumbnail = outcome.status;
        if (outcome.reason) result.report.thumbnailReason = outcome.reason;
      }
    }
    io.out(opts.json ? JSON.stringify(result.report) : formatSiteCheck(result.report));
    return result.code;
  } catch (error) {
    // Anything unexpected is the tool's own failure, never "problems found in the site".
    const known = error instanceof PreviewCommandError;
    const code = known ? error.exitCode : CHECK_EXIT_INTERNAL;
    const message = known ? firstLine(error) : `The check itself failed, so nothing was checked: ${firstLine(error)}`;
    if (opts.json) io.out(JSON.stringify({ ok: false, exitCode: code, error: message, skipped: !known }));
    else io.err(message);
    return code;
  }
}

/** `instafy preview check`, registered under the `preview` command group. */
export function registerPreviewCheckCommand(
  preview: Command,
  card: Pick<PreviewCheckIo, "hasOpenPreview" | "uploadThumbnail"> = {},
): Command {
  return preview
    .command("check")
    .description(
      "Load a local site in a headless browser and report its title, errors, failed requests and a blank page; " +
        "writes desktop and phone screenshots, and refreshes the picture on the card of a preview open on that port " +
        "(exit 1: problems, 2: nothing answering, 3: port not allowed, 4: no browser, 64: bad options, " +
        "70: the check itself failed)",
    )
    .option("--port <port>", "Local port the site listens on (1024-65535)")
    .option("--path <path>", "Path to load (default /); a ?query and #hash are fine")
    .option("--phone", "Only the phone size (390×844); default: desktop 1280×800 and phone")
    .option("--framed", "Load the site inside a frame on another origin, and report a site that refuses to be framed")
    .option("--workspace-playwright", "Also look for Playwright in this project's node_modules (runs the project's own copy)")
    .option("--out <dir>", "Folder for desktop.png and phone.png (default: a new private folder under the temp folder each run; the report names it)")
    .option("--timeout <ms>", "Page load timeout in ms (default 30000)")
    .option("--wait <ms>", "Extra settle time after load in ms (default 600)")
    .option("--json", "Output JSON")
    .action(async (opts: PreviewCheckCliOptions) => {
      process.exitCode = await runPreviewCheckCli(opts, { out: console.log, err: console.error, ...card });
    });
}
