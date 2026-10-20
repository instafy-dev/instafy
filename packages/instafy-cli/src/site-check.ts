// SPDX-License-Identifier: AGPL-3.0-only
//
// `instafy preview check`: let the agent look at a site it is serving in this space before the person sees it.
// Any site, nothing site-specific: it loads http://127.0.0.1:<port><path> in a headless Chromium inside a frame on
// another origin (the way a side pane shows a site), waits for it to settle, and reports the page title, console and
// page errors, failed requests and a blank page. It writes a desktop and a phone screenshot the agent can open. It is
// local only: it calls no Instafy server.
//
// The browser is the one the runtime image already ships: Playwright (global install, or one the workspace has) and
// its Chromium (the Playwright base image's, or the distro's). Nothing is downloaded. The Shared Browser's CDP port is
// deliberately not used: it carries the user's signed-in profile and is reachable only through its own broker.
//
// Exit codes: 0 no problems, 1 problems found (listed), 2 nothing answers on the port, 3 the port is not allowed,
// 4 no browser available (nothing was checked), 64 bad options.
import { spawnSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import type { Command } from "commander";
import {
  PREVIEW_EXIT_NOT_LISTENING,
  PreviewCommandError,
  parsePreviewPort,
  probeLocalSite,
} from "./local-site.js";

export const CHECK_EXIT_OK = 0;
export const CHECK_EXIT_PROBLEMS = 1;
export const CHECK_EXIT_NOT_LISTENING = PREVIEW_EXIT_NOT_LISTENING;
export const CHECK_EXIT_NO_BROWSER = 4;
/** A bad invocation (a missing --port, a bad --path, --timeout or --wait), never "problems found". */
export const CHECK_EXIT_USAGE = 64;

const MAX_PATH_LENGTH = 512;
const MAX_LIST = 20;
const MAX_TEXT = 300;
// The frame page comes from a throwaway server on loopback, opened as http://localhost:<its port> while the site is
// http://127.0.0.1:<port>: another origin, as in a side pane, and both loopback, so Chromium's local-network-access
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
  /** where it was found: env, workspace, global */
  source: "env" | "workspace" | "global";
};

export type LocateOptions = {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  /** global node_modules folders to look in; default: NODE_PATH, `npm root -g`, the usual system folders */
  globalRoots?: string[];
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
    const out = spawnSync("npm", ["root", "-g"], { encoding: "utf8", timeout: 5_000, stdio: ["ignore", "pipe", "ignore"] });
    npmRootCache = out.status === 0 && out.stdout.trim() ? out.stdout.trim() : null;
  } catch {
    npmRootCache = null;
  }
  return npmRootCache;
}

export function defaultGlobalRoots(env: NodeJS.ProcessEnv = process.env): string[] {
  const roots: string[] = [];
  for (const entry of (env.NODE_PATH ?? "").split(path.delimiter)) if (entry.trim()) roots.push(entry.trim());
  const npmRoot = npmGlobalRoot();
  if (npmRoot) roots.push(npmRoot);
  roots.push("/usr/lib/node_modules", "/usr/local/lib/node_modules", "/opt/homebrew/lib/node_modules");
  return [...new Set(roots)];
}

/** Find a Playwright package: $INSTAFY_PREVIEW_CHECK_PLAYWRIGHT, then the workspace (cwd upwards), then global. */
export function locateBrowserEngine(o: LocateOptions = {}): { engine: BrowserEngine | null; tried: string[] } {
  const env = o.env ?? process.env;
  const tried: string[] = [];
  const explicit = env.INSTAFY_PREVIEW_CHECK_PLAYWRIGHT?.trim();
  if (explicit) {
    const dir = path.resolve(explicit);
    if (isPlaywrightDir(dir)) return { engine: { playwright: dir, source: "env" }, tried };
    tried.push(`$INSTAFY_PREVIEW_CHECK_PLAYWRIGHT=${explicit}: not a playwright package`);
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
  for (const root of o.globalRoots ?? defaultGlobalRoots(env)) {
    const found = playwrightIn(root);
    if (found.length) return { engine: { playwright: found[0]!, source: "global" }, tried };
    tried.push(`none in ${root}`);
  }
  return { engine: null, tried };
}

/** Chromium binaries to try when Playwright's own browser is missing (a version mismatch, or a distro image). */
export function chromiumCandidates(env: NodeJS.ProcessEnv = process.env, exists: (p: string) => boolean = fs.existsSync): string[] {
  const out: string[] = [];
  const explicit = env.INSTAFY_PREVIEW_CHECK_CHROMIUM?.trim();
  if (explicit) return [explicit];
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
  if (!env.INSTAFY_PREVIEW_CHECK_CHROMIUM?.trim()) {
    try {
      const browser = await pw.chromium.launch({ headless: true, args: CHROMIUM_ARGS });
      return { browser, executable: "playwright" };
    } catch (error) {
      errors.push(firstLine(error));
    }
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
};

export type SiteCheckReport = {
  ok: boolean;
  url: string;
  title: string;
  engine: { playwright: string; chromium: string };
  viewports: ViewportReport[];
  problems: number;
};

export type SiteCheckOptions = {
  port: number;
  path?: string;
  phone?: boolean;
  outDir?: string;
  timeoutMs?: number;
  waitMs?: number;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  /** test hook: where to look for a global Playwright */
  globalRoots?: string[];
};

export function parseCheckPath(raw: string | undefined): string {
  const value = raw?.trim() || "/";
  if (!value.startsWith("/") || value.startsWith("//") || value.length > MAX_PATH_LENGTH || /[\s\\]/.test(value)) {
    throw new PreviewCommandError("Path must start with / and contain no spaces or backslashes (a ?query and #hash are fine).", CHECK_EXIT_USAGE);
  }
  return value;
}

export function defaultOutDir(port: number): string {
  return path.join(os.tmpdir(), "instafy-preview-check", `port-${port}`);
}

// The frame page: shows the site in a full-size frame on another origin, as a side pane does.
function framePage(siteUrl: string): string {
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>instafy preview check</title>
<style>html,body{margin:0;height:100%;background:#fff}iframe{display:block;border:0;width:100%;height:100%}</style>
<iframe id="site" src=${JSON.stringify(siteUrl)} allow="fullscreen; clipboard-write"></iframe>`;
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

/** Is a screenshot one colour? `dominant` is the share of the most common (coarsely quantized) colour. */
export function blankVerdict(input: {
  dominant: number;
  text: number;
  media: number;
  elements: number;
  framed: "ok" | "refused" | "missing";
}): { blank: boolean; reason: string | null } {
  if (input.framed === "refused") {
    return { blank: true, reason: "the site refuses to be shown in a frame (X-Frame-Options or CSP frame-ancestors), so a pane that frames it stays empty" };
  }
  if (input.framed === "missing") return { blank: true, reason: "the page did not load" };
  // One colour with no visible text: a canvas or app that drew nothing. Text alone on a plain background (a minimal
  // page) is not blank, though it covers far less than 0.5% of the screen.
  if (input.dominant >= 0.995 && input.text === 0) return { blank: true, reason: "the screen is a single colour" };
  if (input.text === 0 && input.media === 0 && input.elements < 3) return { blank: true, reason: "the page has no text, images or canvas" };
  return { blank: false, reason: null };
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

async function checkViewport(
  browser: any,
  hostUrl: string,
  vp: CheckViewport,
  siteUrl: string,
  siteOrigin: string,
  outDir: string,
  timeoutMs: number,
  waitMs: number,
): Promise<ViewportReport> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const context = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    deviceScaleFactor: vp.mobile ? 2 : 1,
    isMobile: vp.mobile,
    hasTouch: vp.mobile,
    ...(vp.mobile ? { userAgent: PHONE_UA } : {}),
    reducedMotion: "reduce",
    serviceWorkers: "block",
    acceptDownloads: false,
  });
  const t0 = Date.now();
  let status: number | null = null;
  try {
    const page = await context.newPage();
    const ours = (u: string) => u.startsWith(siteOrigin);
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
      const why = r.failure()?.errorText ?? "failed";
      // X-Frame-Options or CSP frame-ancestors: reported once, as the reason the frame stays empty
      if (ours(u) && r.isNavigationRequest() && /ERR_BLOCKED_BY_RESPONSE/.test(why)) {
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

    await page.goto(hostUrl, { waitUntil: "load", timeout: timeoutMs });
    await page.waitForLoadState("networkidle", { timeout: Math.min(8_000, timeoutMs) }).catch(() => {
      warnings.push("the network was still busy after 8 s (screenshot taken anyway)");
    });
    const frame = page.frames().find((f: any) => f !== page.mainFrame() && String(f.url()).startsWith(siteOrigin));
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
    const helper = await context.newPage();
    const dominant = await helper.evaluate(DOMINANT_COLOUR, png.toString("base64")).catch(() => 0);
    await helper.close();
    const blank = blankVerdict({ dominant, text: snap.text, media: snap.media, elements: snap.elements, framed });
    if (blank.blank) errors.push(`blank page: ${blank.reason}`);
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
    };
  } finally {
    await context.close().catch(() => {});
  }
}

export async function runSiteCheck(opts: SiteCheckOptions): Promise<{ code: number; report: SiteCheckReport | null; message?: string }> {
  const env = opts.env ?? process.env;
  const port = parsePreviewPort(opts.port);
  const sitePath = parseCheckPath(opts.path);
  const outDir = path.resolve(opts.outDir ?? defaultOutDir(port));
  const viewports = VIEWPORTS.filter((v) => !opts.phone || v.name === "phone");
  // old screenshots would look like a check that happened
  for (const v of VIEWPORTS) fs.rmSync(path.join(outDir, `${v.name}.png`), { force: true });

  const probePath = sitePath.replace(/[?#].*$/, "") || "/";
  const probe = await probeLocalSite(port, probePath);
  // Any HTTP answer means a server is up: a 500 is a problem the browser pass lists (exit 1), not "start the site".
  if (!probe.listening && !(probe.status && probe.status > 0)) {
    return {
      code: CHECK_EXIT_NOT_LISTENING,
      report: null,
      message: `Nothing is answering on http://127.0.0.1:${port}${probePath} (${probe.reason ?? "no answer"}). Start the site first, then check again.`,
    };
  }

  const { engine, tried } = locateBrowserEngine({ env, cwd: opts.cwd, globalRoots: opts.globalRoots });
  if (!engine) {
    return { code: CHECK_EXIT_NO_BROWSER, report: null, message: `SKIPPED, nothing was checked: Playwright not found (${tried.join("; ")}).` };
  }
  let launched: { browser: any; executable: string };
  try {
    launched = await launchChromium(loadPlaywright(engine), env);
  } catch (error) {
    return { code: CHECK_EXIT_NO_BROWSER, report: null, message: `SKIPPED, nothing was checked: ${firstLine(error)}` };
  }
  fs.mkdirSync(outDir, { recursive: true });
  const siteOrigin = `http://127.0.0.1:${port}`;
  const url = `${siteOrigin}${sitePath}`;
  const reports: ViewportReport[] = [];
  const host = await startFrameHost(url);
  try {
    for (const vp of viewports) {
      reports.push(await checkViewport(launched.browser, host.url, vp, url, siteOrigin, outDir, opts.timeoutMs ?? 30_000, opts.waitMs ?? 600));
    }
  } finally {
    await launched.browser.close().catch(() => {});
    host.close();
  }
  const problems = reports.reduce((n, r) => n + r.errors.length, 0);
  const report: SiteCheckReport = {
    ok: problems === 0,
    url,
    title: reports.find((r) => r.title)?.title ?? "",
    engine: { playwright: engine.playwright, chromium: launched.executable },
    viewports: reports,
    problems,
  };
  return { code: problems ? CHECK_EXIT_PROBLEMS : CHECK_EXIT_OK, report };
}

export function formatSiteCheck(report: SiteCheckReport): string {
  const lines: string[] = [];
  lines.push(`${report.ok ? "✓" : "✗"} ${report.url} · "${report.title || "(no title)"}"`);
  for (const r of report.viewports) {
    const timing = `${(r.ms / 1000).toFixed(1)} s${r.status ? `, HTTP ${r.status}` : ""}`;
    lines.push(`${r.errors.length ? "✗" : "✓"} ${r.name} ${r.width}×${r.height}: ${r.screenshot ?? "no screenshot"} (${timing})`);
    for (const e of r.errors) lines.push(`    error: ${e}`);
    for (const w of r.warnings.slice(0, 8)) lines.push(`    warn:  ${w}`);
  }
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
  out?: string;
  timeout?: string;
  wait?: string;
  json?: boolean;
};

/** The CLI action; returns the exit code. */
export async function runPreviewCheckCli(opts: PreviewCheckCliOptions, io = { out: console.log, err: console.error }): Promise<number> {
  const num = (raw: string | undefined, name: string, min: number, max: number) => {
    if (raw === undefined) return undefined;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < min || n > max) throw new PreviewCommandError(`${name} must be a whole number from ${min} to ${max}.`, CHECK_EXIT_USAGE);
    return n;
  };
  try {
    if (opts.port === undefined) throw new PreviewCommandError("--port <port> is required.", CHECK_EXIT_USAGE);
    const result = await runSiteCheck({
      port: parsePreviewPort(opts.port),
      path: opts.path,
      phone: opts.phone,
      outDir: opts.out,
      timeoutMs: num(opts.timeout, "--timeout", 1_000, 120_000),
      waitMs: num(opts.wait, "--wait", 0, 30_000),
    });
    if (!result.report) {
      if (opts.json) io.out(JSON.stringify({ ok: false, exitCode: result.code, error: result.message, skipped: result.code === CHECK_EXIT_NO_BROWSER }));
      else io.err(result.message ?? "check failed");
      return result.code;
    }
    io.out(opts.json ? JSON.stringify(result.report) : formatSiteCheck(result.report));
    return result.code;
  } catch (error) {
    const code = error instanceof PreviewCommandError ? error.exitCode : 1;
    if (opts.json) io.out(JSON.stringify({ ok: false, exitCode: code, error: firstLine(error) }));
    else io.err(firstLine(error));
    return code;
  }
}

/** `instafy preview check`, registered under the `preview` command group. */
export function registerPreviewCheckCommand(preview: Command): Command {
  return preview
    .command("check")
    .description(
      "Load a local site in a headless browser, framed on another origin, and report its title, errors, failed " +
        "requests and a blank page; writes desktop and phone screenshots " +
        "(exit 1: problems, 2: nothing listening, 3: port not allowed, 4: no browser, 64: bad options)",
    )
    .option("--port <port>", "Local port the site listens on (1024-65535)")
    .option("--path <path>", "Path to load (default /); a ?query and #hash are fine")
    .option("--phone", "Only the phone size (390×844); default: desktop 1280×800 and phone")
    .option("--out <dir>", "Folder for desktop.png and phone.png (default: <tmp>/instafy-preview-check/port-<port>)")
    .option("--timeout <ms>", "Page load timeout in ms (default 30000)")
    .option("--wait <ms>", "Extra settle time after load in ms (default 600)")
    .option("--json", "Output JSON")
    .action(async (opts: PreviewCheckCliOptions) => {
      process.exitCode = await runPreviewCheckCli(opts);
    });
}
