// `instafy preview check`: a headless look at a local site.
// The browser tests drive the Playwright this checkout has (pnpm store) with Playwright's Chromium or, on a Mac
// without it, Google Chrome; they skip where neither exists. CI's CLI job runs this file; the browser cases skip there when it has no Chromium.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import net from "node:net";
import { Command } from "commander";
import { afterAll, describe, expect, it } from "vitest";
import {
  CHECK_EXIT_INTERNAL,
  CHECK_EXIT_NO_BROWSER,
  CHECK_EXIT_NOT_LISTENING,
  CHECK_EXIT_OK,
  CHECK_EXIT_PROBLEMS,
  CHECK_EXIT_USAGE,
  blankVerdict,
  chromiumCandidates,
  defaultGlobalRoots,
  formatSiteCheck,
  framePage,
  incompleteBlankCheck,
  isSiteUrl,
  launchChromium,
  loadPlaywright,
  locateBrowserEngine,
  makeDefaultOutDir,
  measureDominantShare,
  parseCheckPath,
  registerPreviewCheckCommand,
  runPreviewCheckCli,
  runSiteCheck,
  siteUrlFor,
} from "../src/site-check.js";
import { reservedPreviewPorts } from "../src/local-site.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "instafy-site-check-"));
const servers: http.Server[] = [];
afterAll(async () => {
  for (const s of servers) await new Promise((r) => s.close(r));
  fs.rmSync(tmp, { recursive: true, force: true });
});

type Route = { status?: number; type?: string; body: string; headers?: Record<string, string> };
async function serve(routes: Record<string, Route>): Promise<number> {
  const server = http.createServer((req, res) => {
    const route = routes[(req.url ?? "/").split("?")[0]!];
    if (!route) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
      return;
    }
    res.writeHead(route.status ?? 200, { "content-type": route.type ?? "text/html; charset=utf-8", ...(route.headers ?? {}) });
    res.end(route.body);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  servers.push(server);
  return (server.address() as { port: number }).port;
}

async function freePort(): Promise<number> {
  const s = http.createServer();
  s.listen(0, "127.0.0.1");
  await once(s, "listening");
  const port = (s.address() as { port: number }).port;
  await new Promise((r) => s.close(r));
  return port;
}

const GOOD = `<!doctype html><html><head><title>Coffee walk</title><meta name="viewport" content="width=device-width"></head>
<body style="margin:0;font:16px system-ui;background:#f4efe6">
<h1 style="background:#2a6;color:#fff;padding:24px">Coffee walk</h1><p>Three cafés within ten minutes.</p>
<canvas id="c" width="200" height="100"></canvas>
<script>
  const g = document.getElementById('c').getContext('2d'); g.fillStyle = '#c33'; g.fillRect(10, 10, 120, 60);
</script></body></html>`;

const BROKEN = `<!doctype html><html><head><title>Broken</title></head><body><p>Some text so it is not blank.</p>
<script src="/missing.js"></script>
<script>console.error('boom: data.json had no rows'); setTimeout(() => { throw new Error('kaput'); }, 0);</script>
</body></html>`;

const BLANK = `<!doctype html><html><head><title>Nothing</title></head><body></body></html>`;

// A page that follows the person's light or dark mode, and says which one it found in its title and description.
const FOLLOWS_MODE = `<!doctype html><html><head><title>Visit notes</title><meta name="color-scheme" content="light dark">
<meta name="description" content="Visit notes"><meta name="viewport" content="width=device-width">
<style>body{margin:0;font:16px system-ui;background:#fbfaf7;color:#0f172a}
@media (prefers-color-scheme: dark){body{background:#141414;color:#fbfaf7}}</style></head>
<body><h1 style="padding:24px">Visit notes</h1><p>Open daily, 09:00 to 19:30.</p>
<script>
  const mode = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark mode' : 'light mode';
  document.title = mode;
  document.querySelector('meta[name="description"]').setAttribute('content', 'Visit notes in ' + mode);
</script></body></html>`;

// The browser cases drive this checkout's own Playwright, handed over the way the runtime image hands over its
// trusted copy: as an absolute path in INSTAFY_SHARED_BROWSER_PLAYWRIGHT_PATH.
const checkoutEngine = locateBrowserEngine({ env: {}, globalRoots: [], workspace: true }).engine;
const browserEnv: NodeJS.ProcessEnv = { ...process.env, INSTAFY_SHARED_BROWSER_PLAYWRIGHT_PATH: checkoutEngine?.playwright ?? "" };
let browserOk = false;
if (checkoutEngine) {
  try {
    const { browser } = await launchChromium(loadPlaywright(checkoutEngine));
    await browser.close();
    browserOk = true;
  } catch {
    browserOk = false;
  }
}
// no Playwright anywhere: the trusted path points nowhere and no global folder is searched
const NO_ENGINE = { env: { INSTAFY_SHARED_BROWSER_PLAYWRIGHT_PATH: "/definitely/not/here" }, globalRoots: [] as string[] };

async function canListenOnIpv6(): Promise<boolean> {
  const s = http.createServer();
  try {
    s.listen(0, "::1");
    await once(s, "listening");
    return true;
  } catch {
    return false;
  } finally {
    s.close();
  }
}
const ipv6 = await canListenOnIpv6();

async function serveOn(host: string, routes: Record<string, Route>, port = 0): Promise<number> {
  const server = http.createServer((req, res) => {
    const route = routes[(req.url ?? "/").split("?")[0]!];
    res.writeHead(route?.status ?? (route ? 200 : 404), { "content-type": route?.type ?? "text/html; charset=utf-8", ...(route?.headers ?? {}) });
    res.end(route?.body ?? "not found");
  });
  server.listen(port, host);
  await once(server, "listening");
  servers.push(server);
  return (server.address() as { port: number }).port;
}

/** Two servers whose ports share a prefix: the site on p and another on p*10+k (e.g. 3000 and 30001). */
async function servePrefixPair(site: Record<string, Route>, other: Record<string, Route>): Promise<[number, number]> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    // 2100-2999: clear of Instafy's ports and Chromium's blocked ("unsafe") ports, as are 21000-29999
    const p = 2100 + Math.floor(Math.random() * 900);
    if (reservedPreviewPorts({}).has(p)) continue;
    let sitePort: number;
    try {
      sitePort = await serveOn("127.0.0.1", site, p);
    } catch {
      continue;
    }
    for (let k = 0; k < 10; k += 1) {
      try {
        return [sitePort, await serveOn("127.0.0.1", other, p * 10 + k)];
      } catch {
        // taken; try the next
      }
    }
  }
  throw new Error("no free port pair");
}

describe("preview check: pure parts", () => {
  it("accepts a path with a query and hash, refuses others", () => {
    expect(parseCheckPath(undefined)).toBe("/");
    expect(parseCheckPath("/docs/?x=1#t=22&s=intro:3")).toBe("/docs/?x=1#t=22&s=intro:3");
    expect(() => parseCheckPath("docs")).toThrow();
    expect(() => parseCheckPath("//evil.example/")).toThrow();
    expect(() => parseCheckPath("/a b")).toThrow();
  });

  it("builds the site URL percent-encoded and on the site's origin, and escapes it in the frame page", () => {
    const url = siteUrlFor("http://127.0.0.1:4173", '/search?q="shoes"<b>#"x"');
    expect(url).toBe("http://127.0.0.1:4173/search?q=%22shoes%22%3Cb%3E#%22x%22");
    const page = framePage('http://127.0.0.1:4173/?q="><script>alert(1)</script>&a=1');
    expect(page.toLowerCase()).not.toContain("<script");
    expect(page).toContain('src="http://127.0.0.1:4173/?q=&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;&amp;a=1"');
  });

  it("counts a URL as the site's only on the exact origin (3000 is not 30001)", () => {
    expect(isSiteUrl("http://127.0.0.1:3000/app.js", "http://127.0.0.1:3000")).toBe(true);
    expect(isSiteUrl("http://127.0.0.1:30001/api", "http://127.0.0.1:3000")).toBe(false);
    expect(isSiteUrl("http://127.0.0.1:3000.evil.example/", "http://127.0.0.1:3000")).toBe(false);
    expect(isSiteUrl("http://[::1]:3000/", "http://[::1]:3000")).toBe(true);
    expect(isSiteUrl("data:text/plain,hi", "http://127.0.0.1:3000")).toBe(false);
  });

  it("calls a single-colour screen and an empty page blank, and a refused frame blank only when framed", () => {
    const base = { dominant: 0.4, text: 120, media: 1, elements: 12, framed: "ok" as const };
    expect(blankVerdict(base)).toEqual({ blank: false, reason: null });
    // a canvas that drew nothing
    expect(blankVerdict({ ...base, dominant: 0.999, text: 0 }).blank).toBe(true);
    // a heading alone on a plain background is a page, not a blank one
    expect(blankVerdict({ ...base, dominant: 0.999, text: 5, media: 0, elements: 1 }).blank).toBe(false);
    expect(blankVerdict({ ...base, text: 0, media: 0, elements: 1 }).blank).toBe(true);
    expect(blankVerdict({ ...base, text: 0, media: 2, elements: 2 }).blank).toBe(false);
    expect(blankVerdict({ ...base, framed: "refused" }).reason).toMatch(/refuses to be framed/);
    expect(blankVerdict({ ...base, framed: "missing" }).reason).toMatch(/did not load/);
  });

  it("a screenshot that cannot be measured is said out loud, and is a problem when the page has no text", async () => {
    // the measuring helper page failing (it crashed, or the image would not decode)
    expect(await measureDominantShare(() => Promise.reject(new Error("Target closed")))).toBeNull();
    expect(await measureDominantShare(() => Promise.resolve(Number.NaN))).toBeNull();
    expect(await measureDominantShare(() => Promise.resolve(0.42))).toBe(0.42);
    // a canvas page that drew nothing: without the measurement, the single-colour rule cannot catch it
    const canvasOnly = { dominant: null, text: 0, media: 1, elements: 3, framed: "ok" as const };
    expect(blankVerdict(canvasOnly).blank).toBe(false);
    expect(incompleteBlankCheck(null, 0)).toEqual({ error: true, message: expect.stringMatching(/^blank check incomplete: could not read the screenshot/) });
    expect(incompleteBlankCheck(null, 40)).toEqual({ error: false, message: expect.stringMatching(/^blank check incomplete/) });
    expect(incompleteBlankCheck(0.4, 0)).toBeNull();
  });

  it("each run's default screenshot folder is new and private to this user", () => {
    const a = makeDefaultOutDir(4173);
    const b = makeDefaultOutDir(4173);
    try {
      expect(a).not.toBe(b);
      for (const dir of [a, b]) {
        expect(path.dirname(dir)).toBe(path.resolve(os.tmpdir()));
        expect(path.basename(dir)).toMatch(/^instafy-preview-check-4173-/);
        const stat = fs.lstatSync(dir);
        expect(stat.isDirectory() && !stat.isSymbolicLink()).toBe(true);
        if (process.platform !== "win32") expect(stat.mode & 0o777).toBe(0o700);
      }
    } finally {
      fs.rmSync(a, { recursive: true, force: true });
      fs.rmSync(b, { recursive: true, force: true });
    }
  });

  describe("finding Playwright: trusted locations first, the workspace only on request", () => {
    const pkg = (dir: string) => {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "playwright" }));
      return dir;
    };
    const trusted = pkg(path.join(tmp, "image", "node_modules", "playwright"));
    const global = pkg(path.join(tmp, "global", "playwright"));
    const workspace = path.join(tmp, "project");
    pkg(path.join(workspace, "node_modules", "playwright"));
    const nested = path.join(workspace, "src", "app");
    fs.mkdirSync(nested, { recursive: true });

    it("the runtime's trusted path wins over a global and a workspace copy", () => {
      const env = { INSTAFY_SHARED_BROWSER_PLAYWRIGHT_PATH: trusted };
      const found = locateBrowserEngine({ env, cwd: nested, globalRoots: [path.join(tmp, "global")], workspace: true });
      expect(found.engine).toEqual({ playwright: trusted, source: "trusted" });
      const byRoot = locateBrowserEngine({
        env: { INSTAFY_SHARED_BROWSER_TRUSTED_NODE_MODULES_ROOT: path.join(tmp, "image", "node_modules") },
        cwd: nested,
        globalRoots: [path.join(tmp, "global")],
        workspace: true,
      });
      expect(byRoot.engine).toEqual({ playwright: trusted, source: "trusted" });
    });

    it("a global copy wins over the workspace, and the workspace is never searched unless asked", () => {
      expect(locateBrowserEngine({ env: {}, cwd: nested, globalRoots: [path.join(tmp, "none"), path.join(tmp, "global")], workspace: true }).engine).toEqual({
        playwright: global,
        source: "global",
      });
      const refused = locateBrowserEngine({ env: {}, cwd: nested, globalRoots: [] });
      expect(refused.engine).toBeNull();
      expect(refused.tried.join("; ")).toMatch(/--workspace-playwright/);
      expect(locateBrowserEngine({ env: {}, cwd: nested, globalRoots: [], workspace: true }).engine).toEqual({
        playwright: path.join(workspace, "node_modules", "playwright"),
        source: "workspace",
      });
    });

    it("a relative trusted path or NODE_PATH entry is ignored (it would resolve inside the workspace)", () => {
      expect(locateBrowserEngine({ env: { INSTAFY_SHARED_BROWSER_PLAYWRIGHT_PATH: "node_modules/playwright" }, cwd: workspace, globalRoots: [] }).engine).toBeNull();
      expect(defaultGlobalRoots({ NODE_PATH: ["node_modules", path.join(tmp, "global")].join(path.delimiter) })).not.toContain("node_modules");
      expect(defaultGlobalRoots({ NODE_PATH: path.join(tmp, "global") })).toContain(path.join(tmp, "global"));
    });
  });

  it("lists the image's Chromium binaries: Playwright's headless shell first, then the distro's", () => {
    const root = path.join(tmp, "ms-playwright");
    const shell = path.join(root, "chromium_headless_shell-1228", "chrome-headless-shell-linux64", "chrome-headless-shell");
    const full = path.join(root, "chromium-1228", "chrome-linux64", "chrome");
    for (const f of [shell, full]) {
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, "");
    }
    const exists = (p: string) => p === shell || p === full || p === "/usr/bin/chromium";
    expect(chromiumCandidates({ PLAYWRIGHT_BROWSERS_PATH: root }, exists)).toEqual([shell, full, "/usr/bin/chromium"]);
  });

  it("is registered as `preview check` with its options", () => {
    const program = new Command();
    const preview = program.command("preview");
    const check = registerPreviewCheckCommand(preview);
    expect(check.name()).toBe("check");
    const flags = check.options.map((o) => o.long);
    expect(flags).toEqual(["--port", "--path", "--phone", "--desktop", "--framed", "--workspace-playwright", "--out", "--timeout", "--wait", "--json", "--picture-to"]);
    // The runtime's own option is not offered in help.
    expect(check.options.filter((o) => o.hidden).map((o) => o.long)).toEqual(["--picture-to"]);
    expect(check.helpInformation()).not.toContain("--picture-to");
  });
});

describe("preview check: exits", () => {
  it("exit 2 when nothing listens on either loopback address, before looking for a browser", async () => {
    const port = await freePort();
    const result = await runSiteCheck({ port, outDir: path.join(tmp, "none"), ...NO_ENGINE });
    expect(result.code).toBe(CHECK_EXIT_NOT_LISTENING);
    expect(result.message).toMatch(/Nothing is answering on port \d+ at 127\.0\.0\.1 or \[::1\]/);
  });

  it("a server that takes the connection but has not answered yet is not told to start the site (exit 2, says so)", async () => {
    const hung = net.createServer((socket) => {
      setTimeout(() => socket.destroy(), 2_000);
    });
    hung.listen(0, "127.0.0.1");
    await once(hung, "listening");
    const port = (hung.address() as { port: number }).port;
    try {
      // the probe waits as long as the page load may (--timeout), not a fixed 5 s
      const started = Date.now();
      const result = await runSiteCheck({ port, timeoutMs: 400, outDir: path.join(tmp, "hung"), ...NO_ENGINE });
      expect(Date.now() - started).toBeLessThan(1_900);
      expect(result.code).toBe(CHECK_EXIT_NOT_LISTENING);
      expect(result.message).toMatch(/^A server accepted the connection on port \d+ but did not answer \(127\.0\.0\.1: no answer within 0\.4 s\)/);
      expect(result.message).toMatch(/still be starting or compiling/);
      expect(result.message).not.toMatch(/Start the site first/);
    } finally {
      hung.close();
    }
  });

  it.skipIf(!ipv6)("a site listening only on [::1] is found, not reported as nothing listening", async () => {
    const port = await serveOn("::1", { "/": { body: GOOD } });
    const result = await runSiteCheck({ port, outDir: path.join(tmp, "v6-none"), ...NO_ENGINE });
    expect(result.code).toBe(CHECK_EXIT_NO_BROWSER);
  });

  it("a site that answers 500 is up: it goes on to the browser pass (which lists the 500), not exit 2", async () => {
    const port = await serve({ "/": { status: 500, body: "Internal Server Error" } });
    const result = await runSiteCheck({ port, outDir: path.join(tmp, "500"), ...NO_ENGINE });
    expect(result.code).toBe(CHECK_EXIT_NO_BROWSER);
    expect(result.message ?? "").not.toMatch(/Nothing is answering/);
  });

  it("a bad invocation exits 64, never 1 (which means problems were found)", async () => {
    const silent = { out: () => {}, err: () => {} };
    expect(await runPreviewCheckCli({}, silent)).toBe(CHECK_EXIT_USAGE);
    expect(await runPreviewCheckCli({ port: "4173", timeout: "soon" }, silent)).toBe(CHECK_EXIT_USAGE);
    expect(await runPreviewCheckCli({ port: "4173", wait: "-1" }, silent)).toBe(CHECK_EXIT_USAGE);
    expect(await runPreviewCheckCli({ port: "4173", path: "no-slash" }, silent)).toBe(CHECK_EXIT_USAGE);
    expect(CHECK_EXIT_USAGE).not.toBe(CHECK_EXIT_PROBLEMS);
  });

  it("the tool's own failure (an unusable --out) exits 70 and says nothing was checked, never 1", async () => {
    const port = await serve({ "/": { body: GOOD } });
    const file = path.join(tmp, "a-file");
    fs.writeFileSync(file, "");
    const out: string[] = [];
    const code = await runPreviewCheckCli(
      { port: String(port), out: path.join(file, "shots"), json: true },
      { out: (s: string) => out.push(s), err: () => {}, env: browserEnv },
    );
    expect(code).toBe(CHECK_EXIT_INTERNAL);
    expect(JSON.parse(out[0]!)).toMatchObject({ ok: false, exitCode: CHECK_EXIT_INTERNAL, skipped: true, error: expect.stringMatching(/nothing was checked/) });
  });

  it("the instafy binary runs it as `instafy preview check` (a missing --port exits 64; a reserved port exits 3)", () => {
    const bin = path.resolve(__dirname, "..", "bin", "instafy.js");
    const run = (args: string[], env: NodeJS.ProcessEnv = {}) =>
      spawnSync(process.execPath, [bin, ...args], { encoding: "utf8", env: { ...process.env, HOME: tmp, ...env } });
    const missing = run(["preview", "check", "--json"]);
    expect(missing.status, missing.stderr).toBe(CHECK_EXIT_USAGE);
    expect(JSON.parse(missing.stdout)).toMatchObject({ ok: false, exitCode: CHECK_EXIT_USAGE });
    expect(run(["preview", "check", "--port", "9222"]).status).toBe(3);
    expect(run(["preview", "check", "--port", "9333"], { INSTAFY_PLAYWRIGHT_CDP_PORT: "9333" }).status).toBe(3);
  });

  it("exit 3 for a reserved port, a port an Instafy setting moved, and an extra denied port", async () => {
    const run = async (port: string, env: NodeJS.ProcessEnv = {}) => {
      const out: string[] = [];
      const code = await runPreviewCheckCli({ port, json: true }, { out: (s: string) => out.push(s), err: () => {}, env });
      return { code, body: JSON.parse(out[0]!) };
    };
    expect(await run("9223")).toMatchObject({ code: 3, body: { ok: false, exitCode: 3 } });
    expect((await run("9333", { INSTAFY_PLAYWRIGHT_CDP_PORT: "9333" })).code).toBe(3);
    expect((await run("54400", { ORIGIN_BIND_PORT: "54400" })).code).toBe(3);
    expect((await run("4321", { INSTAFY_PREVIEW_DENY_PORTS: "4000, 4321" })).code).toBe(3);
  });

  it("exit 4 and a SKIPPED message when no browser engine exists; stale screenshots are removed", async () => {
    const port = await serve({ "/": { body: GOOD } });
    const outDir = path.join(tmp, "skipped");
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, "desktop.png"), "old");
    const result = await runSiteCheck({ port, outDir, ...NO_ENGINE });
    expect(result.code).toBe(CHECK_EXIT_NO_BROWSER);
    expect(result.message).toMatch(/SKIPPED/);
    expect(fs.existsSync(path.join(outDir, "desktop.png"))).toBe(false);
  });
});

describe.skipIf(!browserOk)("preview check: in a browser", () => {
  const check = (o: Omit<Parameters<typeof runSiteCheck>[0], "env">) => runSiteCheck({ ...o, env: browserEnv });

  it("a healthy page passes: title, both screenshots, HTTP 200", { timeout: 90_000 }, async () => {
    const port = await serve({ "/": { body: GOOD } });
    const outDir = path.join(tmp, "good");
    const result = await check({ port, outDir });
    expect(result.code, JSON.stringify(result.report?.viewports.map((v) => v.errors))).toBe(CHECK_EXIT_OK);
    const r = result.report!;
    expect(r.title).toBe("Coffee walk");
    expect(r.engine.playwright).toBe(checkoutEngine!.playwright);
    expect(r.viewports.map((v) => [v.name, v.width])).toEqual([["desktop", 1280], ["phone", 390]]);
    for (const v of r.viewports) {
      expect(fs.readFileSync(v.screenshot!).subarray(1, 4).toString()).toBe("PNG");
      expect(v.blank.blank).toBe(false);
      expect(v.status).toBe(200);
    }
    expect(formatSiteCheck(r)).toMatch(/No problems found/);
  });

  it("console errors, uncaught exceptions and the site's own failed requests are problems (exit 1)", { timeout: 90_000 }, async () => {
    const port = await serve({ "/": { body: BROKEN } });
    const result = await check({ port, outDir: path.join(tmp, "broken"), phone: true });
    expect(result.code).toBe(CHECK_EXIT_PROBLEMS);
    const errors = result.report!.viewports[0]!.errors.join("\n");
    expect(errors).toMatch(/console\.error: boom: data\.json had no rows/);
    expect(errors).toMatch(/uncaught: .*kaput/);
    expect(errors).toMatch(/HTTP 404: \/missing\.js/);
  });

  it("another server whose port starts with the site's (3000 vs 30001) is another origin: blocked and listed as such, not an error", { timeout: 180_000 }, async () => {
    const siteRoutes: Record<string, Route> = {};
    // Records every path the other server is asked for.
    const otherSeen: string[] = [];
    const other = new Proxy({} as Record<string, Route>, { get: (_t, key) => { otherSeen.push(String(key)); return undefined; } });
    const [port, otherPort] = await servePrefixPair(siteRoutes, other);
    expect(String(otherPort).startsWith(String(port))).toBe(true);
    // the routes are read per request, so the page can name the other port now
    siteRoutes["/"] = { body: GOOD.replace("</body>", `<img src="http://127.0.0.1:${otherPort}/gone.png" alt=""></body>`) };
    const result = await check({ port, outDir: path.join(tmp, "prefix"), phone: true });
    expect(result.code, JSON.stringify(result.report?.viewports.map((v) => v.errors))).toBe(CHECK_EXIT_OK);
    const v = result.report!.viewports[0]!;
    expect(v.blocked.join("\n")).toContain(`http://127.0.0.1:${otherPort}/gone.png (another local server`);
    expect([...v.errors, ...v.warnings].join("\n")).not.toContain(String(otherPort));
    expect(formatSiteCheck(result.report!)).toMatch(/blocked: http:\/\/127\.0\.0\.1:\d+\/gone\.png/);
    expect(otherSeen).toEqual([]);
  });

  it("a redirect hop to a link-only site is blocked and listed, never sent on to the egress proxy", { timeout: 180_000 }, async () => {
    // A stand-in for the egress proxy that records what it is sent; public.example/to-booking redirects to Booking.
    const proxied: string[] = [];
    const proxy = http.createServer((req, res) => {
      proxied.push(`${req.method} ${req.url}`);
      if (req.url === "http://public.example/to-booking") {
        res.writeHead(302, { location: "https://www.booking.com/hotel/pt/x.html" });
        res.end();
        return;
      }
      res.writeHead(403);
      res.end();
    });
    proxy.on("connect", (req, socket: net.Socket) => {
      proxied.push(`CONNECT ${req.url}`);
      socket.on("error", () => {});
      socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
    });
    proxy.listen(0, "127.0.0.1");
    await once(proxy, "listening");
    servers.push(proxy);
    const port = await serve({
      "/": { body: GOOD.replace("</body>", `<img src="/to-booking.png" alt=""><iframe src="http://public.example/to-booking"></iframe></body>`) },
      "/to-booking.png": { status: 302, body: "", headers: { location: "http://www.booking.com/logo.png" } },
    });
    const proxyServer = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`;
    const result = await check({ port, outDir: path.join(tmp, "redirect-hops"), phone: true, proxyServer });
    expect(result.code, JSON.stringify(result.report?.viewports.map((v) => v.errors))).toBe(CHECK_EXIT_OK);
    const v = result.report!.viewports[0]!;
    expect(v.blocked.join("\n")).toMatch(/https?:\/\/www\.booking\.com\/logo\.png \(Booking\.com is link-only/);
    expect(v.blocked.join("\n")).toMatch(/https:\/\/www\.booking\.com\/hotel\/pt\/x\.html \(Booking\.com is link-only/);
    expect([...v.errors, ...v.warnings].join("\n")).not.toMatch(/booking/);
    expect(proxied).toContain("GET http://public.example/to-booking");
    expect(proxied.join("\n")).not.toMatch(/booking\.com/);
  });

  // A page that draws itself after it loads, and says so with its ready mark.
  const drawsLater = (ms: number | null) => `<!doctype html><html data-instafy-ready="false"><title>Loading</title>
<body style="font:16px system-ui"><h1 id="h">Loading</h1><script>${
    ms === null
      ? ""
      : `setTimeout(() => { document.title = "Drawn"; document.getElementById("h").textContent = "Drawn"; document.documentElement.setAttribute("data-instafy-ready", "true"); }, ${ms});`
  }</script></body></html>`;

  it("a page with its own ready mark is looked at once it says it is drawn", { timeout: 90_000 }, async () => {
    const port = await serve({ "/": { body: drawsLater(3_000) } });
    const result = await check({ port, outDir: path.join(tmp, "ready-mark"), phone: true });
    expect(result.code, JSON.stringify(result.report?.viewports.map((v) => v.errors))).toBe(CHECK_EXIT_OK);
    expect(result.report!.title).toBe("Drawn");
  });

  it("a page that never says it is drawn is said to be, and does not replace the card's picture", { timeout: 90_000 }, async () => {
    const port = await serve({ "/": { body: drawsLater(null) } });
    const result = await check({ port, outDir: path.join(tmp, "never-ready"), timeoutMs: 8_000, thumbnail: true });
    const desktop = result.report!.viewports.find((v) => v.name === "desktop")!;
    expect(desktop.warnings.join("\n")).toMatch(/still said it was drawing \(data-instafy-ready\)/);
    expect(result.thumbnail).toEqual({ skipped: "the page never said it was ready, so the card keeps its picture" });
  });

  it("a minimal page (one heading on a plain background) passes", { timeout: 90_000 }, async () => {
    const port = await serve({ "/": { body: `<!doctype html><title>Hello</title><h1>Hello</h1>` } });
    const result = await check({ port, outDir: path.join(tmp, "minimal") });
    expect(result.code, JSON.stringify(result.report?.viewports.map((v) => v.errors))).toBe(CHECK_EXIT_OK);
  });

  it("a blank page is a problem", { timeout: 90_000 }, async () => {
    const port = await serve({ "/": { body: BLANK } });
    const result = await check({ port, outDir: path.join(tmp, "blank"), phone: true });
    expect(result.code).toBe(CHECK_EXIT_PROBLEMS);
    expect(result.report!.viewports[0]!.blank.blank).toBe(true);
    expect(result.report!.viewports[0]!.errors.join("\n")).toMatch(/blank page/);
  });

  it("a site that refuses to be framed passes by default (it is shown as a link) and is reported only with --framed", { timeout: 90_000 }, async () => {
    const port = await serve({ "/": { body: GOOD, headers: { "x-frame-options": "DENY" } } });
    const plain = await check({ port, outDir: path.join(tmp, "deny"), phone: true });
    expect(plain.code, JSON.stringify(plain.report?.viewports.map((v) => v.errors))).toBe(CHECK_EXIT_OK);
    expect(plain.report!.problems).toBe(0);
    expect(plain.report!.title).toBe("Coffee walk");
    const framed = await check({ port, outDir: path.join(tmp, "deny-framed"), phone: true, framed: true });
    expect(framed.code).toBe(CHECK_EXIT_PROBLEMS);
    expect(framed.report!.viewports[0]!.blank.reason).toMatch(/refuses to be framed/);
  });

  it("--framed loads a path with quotes in its query inside the frame, intact", { timeout: 90_000 }, async () => {
    const port = await serve({
      "/search": { body: `<!doctype html><title>x</title><h1>Results</h1><script>document.title = decodeURIComponent(location.search)</script>` },
    });
    const result = await check({ port, path: '/search?q="shoes"<b>', outDir: path.join(tmp, "quoted"), phone: true, framed: true });
    expect(result.code, JSON.stringify(result.report?.viewports.map((v) => v.errors))).toBe(CHECK_EXIT_OK);
    expect(result.report!.title).toBe('?q="shoes"<b>');
  });

  it.skipIf(!ipv6)("a site listening only on [::1] is checked there", { timeout: 90_000 }, async () => {
    const port = await serveOn("::1", { "/": { body: GOOD } });
    const result = await check({ port, outDir: path.join(tmp, "v6"), phone: true });
    expect(result.code, JSON.stringify(result.report?.viewports.map((v) => v.errors))).toBe(CHECK_EXIT_OK);
    expect(result.report!.url).toBe(`http://[::1]:${port}/`);
    expect(result.report!.title).toBe("Coffee walk");
  });

  it("--phone takes only the phone screenshot, at phone size, and the path (with a hash) is loaded", { timeout: 90_000 }, async () => {
    const port = await serve({
      "/docs/": {
        body: `<!doctype html><title>Docs</title><meta name="viewport" content="width=device-width"><body style="background:#eef"><h1 style="background:#246;color:#fff;padding:40px">Section 2</h1><p>How the setup works.</p>
<script>addEventListener('load', () => setTimeout(() => { document.title = 'Docs ' + location.hash + ' ' + innerWidth; }, 150));</script>`,
      },
    });
    const outDir = path.join(tmp, "phone");
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, "desktop.png"), "stale");
    const out: string[] = [];
    const code = await runPreviewCheckCli(
      { port: String(port), path: "/docs/#s=2", phone: true, out: outDir, json: true },
      { out: (s: string) => out.push(s), err: () => {}, env: browserEnv },
    );
    expect(code).toBe(CHECK_EXIT_OK);
    const r = JSON.parse(out[0]!);
    expect(r.viewports).toHaveLength(1);
    expect(r.viewports[0].name).toBe("phone");
    expect(r.title).toBe("Docs #s=2 390");
    expect(fs.existsSync(path.join(outDir, "phone.png"))).toBe(true);
    expect(fs.existsSync(path.join(outDir, "desktop.png"))).toBe(false);
  });

  // The end of a turn checks a site only for its card's picture, which comes from the desktop size.
  it("--desktop takes only the desktop screenshot, and the card's picture from it", { timeout: 90_000 }, async () => {
    const port = await serve({ "/": { body: GOOD } });
    const outDir = path.join(tmp, "desktop-only");
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, "phone.png"), "stale");
    const out: string[] = [];
    const uploads: number[] = [];
    const code = await runPreviewCheckCli(
      { port: String(port), desktop: true, out: outDir, json: true },
      {
        out: (s: string) => out.push(s),
        err: () => {},
        env: browserEnv,
        hasOpenPreview: () => true,
        uploadThumbnail: async ({ image }) => {
          uploads.push(image.length);
          return { status: "uploaded" };
        },
      },
    );
    expect(code).toBe(CHECK_EXIT_OK);
    const r = JSON.parse(out[0]!);
    expect(r.viewports.map((v: { name: string; width: number }) => [v.name, v.width])).toEqual([["desktop", 1280]]);
    expect(r.thumbnail).toBe("uploaded");
    expect(uploads).toHaveLength(1);
    expect(fs.existsSync(path.join(outDir, "desktop.png"))).toBe(true);
    expect(fs.existsSync(path.join(outDir, "phone.png"))).toBe(false);
  });

  // A preview keeps one picture, which Studio shows in its dark theme too: a page that follows the person's mode is
  // pictured dark. The desktop size, which the picture comes from, loads in dark mode and the phone size in light, so
  // one check shows both looks.
  it("loads the desktop size in dark mode and the phone size in light, and takes the card's picture in dark mode", { timeout: 90_000 }, async () => {
    const port = await serve({ "/": { body: FOLLOWS_MODE } });
    const out: string[] = [];
    const pictures: Array<string | null> = [];
    const code = await runPreviewCheckCli(
      { port: String(port), out: path.join(tmp, "modes"), json: true },
      {
        out: (s: string) => out.push(s),
        err: () => {},
        env: browserEnv,
        hasOpenPreview: () => true,
        uploadThumbnail: async ({ description }) => {
          pictures.push(description);
          return { status: "uploaded" };
        },
      },
    );
    expect(code).toBe(CHECK_EXIT_OK);
    const r = JSON.parse(out[0]!);
    // Each size's title is the mode the page found itself in.
    expect(r.viewports.map((v: { name: string; colorScheme: string; title: string }) => [v.name, v.colorScheme, v.title])).toEqual([
      ["desktop", "dark", "dark mode"],
      ["phone", "light", "light mode"],
    ]);
    expect(pictures).toEqual(["Visit notes in dark mode"]);
    expect(formatSiteCheck(r)).toMatch(/✓ desktop 1280×800, dark mode: .*desktop\.png/);
    expect(formatSiteCheck(r)).toMatch(/✓ phone 390×844, light mode: .*phone\.png/);
  });

  // A turn that ends after its own check tried, and failed, to picture the site is not checked again for nothing.
  it("a picture the check could not take is recorded as tried, and nothing is uploaded", { timeout: 90_000 }, async () => {
    const port = await serve({ "/": { body: `<!doctype html><title>Nothing yet</title><body style="margin:0;background:#fff"></body>` } });
    const tried: Array<{ port: number; path: string; takenAt: number }> = [];
    const uploads: number[] = [];
    const before = Date.now();
    const out: string[] = [];
    await runPreviewCheckCli(
      { port: String(port), desktop: true, out: path.join(tmp, "tried"), json: true },
      {
        out: (s: string) => out.push(s),
        err: () => {},
        env: browserEnv,
        hasOpenPreview: () => true,
        uploadThumbnail: async ({ image }) => {
          uploads.push(image.length);
          return { status: "uploaded" };
        },
        pictureTried: async (input) => {
          tried.push(input);
        },
      },
    );
    expect(JSON.parse(out[0]!)).toMatchObject({ thumbnail: "skipped", thumbnailReason: "the page looked blank" });
    expect(uploads).toEqual([]);
    expect(tried).toEqual([{ port, path: "/", takenAt: expect.any(Number) }]);
    expect(tried[0]!.takenAt).toBeGreaterThanOrEqual(before);
  });
});

describe("preview check: the previews skill tells the agent to run it", () => {
  const skill = path.resolve(
    __dirname,
    "..",
    "..",
    "runtime-agent",
    "assets",
    "instafy",
    ".agents",
    "skills",
    "instafy-frontend-previews",
    "SKILL.md",
  );
  it("checks the page it shows on the port the card got, before any public link, and says exit 4 or 70 means nothing was checked", () => {
    const text = fs.readFileSync(skill, "utf8");
    const check = text.indexOf("instafy preview check --port <port>");
    expect(check).toBeGreaterThan(-1);
    // the port is the one `instafy preview open --start` picked, and the check comes before any step that exposes
    // the port publicly
    expect(text).toContain("Check it: `instafy preview check --port <port>` (the JSON's).");
    const tunnel = text.indexOf("instafy tunnel start");
    expect(tunnel).toBeGreaterThan(-1);
    expect(check).toBeLessThan(tunnel);
    // the card speaks for itself: the person is never sent to it
    expect(text).not.toMatch(/open it from the card/i);
    expect(text).toMatch(/exit 4[^\n]*70[^\n]*nothing was checked/i);
  });
});
