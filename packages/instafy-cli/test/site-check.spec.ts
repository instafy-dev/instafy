// `instafy preview check`: a headless look at a local site, framed on another origin.
// The browser tests drive the Playwright this checkout has (pnpm store) with Playwright's Chromium or, on a Mac
// without it, Google Chrome; they skip where neither exists.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { Command } from "commander";
import { afterAll, describe, expect, it } from "vitest";
import {
  CHECK_EXIT_NO_BROWSER,
  CHECK_EXIT_NOT_LISTENING,
  CHECK_EXIT_OK,
  CHECK_EXIT_PROBLEMS,
  CHECK_EXIT_USAGE,
  blankVerdict,
  chromiumCandidates,
  formatSiteCheck,
  launchChromium,
  loadPlaywright,
  locateBrowserEngine,
  parseCheckPath,
  registerPreviewCheckCommand,
  runPreviewCheckCli,
  runSiteCheck,
} from "../src/site-check.js";

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

const engine = locateBrowserEngine().engine;
let browserOk = false;
if (engine) {
  try {
    const { browser } = await launchChromium(loadPlaywright(engine));
    await browser.close();
    browserOk = true;
  } catch {
    browserOk = false;
  }
}

describe("preview check: pure parts", () => {
  it("accepts a path with a query and hash, refuses others", () => {
    expect(parseCheckPath(undefined)).toBe("/");
    expect(parseCheckPath("/docs/?x=1#t=22&s=intro:3")).toBe("/docs/?x=1#t=22&s=intro:3");
    expect(() => parseCheckPath("docs")).toThrow();
    expect(() => parseCheckPath("//evil.example/")).toThrow();
    expect(() => parseCheckPath("/a b")).toThrow();
  });

  it("calls a single-colour screen, an empty page and a refused frame blank", () => {
    const base = { dominant: 0.4, text: 120, media: 1, elements: 12, framed: "ok" as const };
    expect(blankVerdict(base)).toEqual({ blank: false, reason: null });
    // a canvas that drew nothing
    expect(blankVerdict({ ...base, dominant: 0.999, text: 0 }).blank).toBe(true);
    // a heading alone on a plain background is a page, not a blank one
    expect(blankVerdict({ ...base, dominant: 0.999, text: 5, media: 0, elements: 1 }).blank).toBe(false);
    expect(blankVerdict({ ...base, text: 0, media: 0, elements: 1 }).blank).toBe(true);
    expect(blankVerdict({ ...base, text: 0, media: 2, elements: 2 }).blank).toBe(false);
    expect(blankVerdict({ ...base, framed: "refused" }).reason).toMatch(/frame/);
    expect(blankVerdict({ ...base, framed: "missing" }).reason).toMatch(/did not load/);
  });

  it("finds Playwright in the workspace, then in a global folder (NODE_PATH-style), and honours an explicit path", () => {
    const fakeGlobal = path.join(tmp, "global");
    fs.mkdirSync(path.join(fakeGlobal, "playwright"), { recursive: true });
    fs.writeFileSync(path.join(fakeGlobal, "playwright", "package.json"), JSON.stringify({ name: "playwright" }));
    const nowhere = path.join(tmp, "empty-ws");
    fs.mkdirSync(nowhere, { recursive: true });
    // tmp dirs sit outside any checkout, so only the global folder has one
    const found = locateBrowserEngine({ env: {}, cwd: nowhere, globalRoots: [path.join(tmp, "none"), fakeGlobal] });
    expect(found.engine).toEqual({ playwright: path.join(fakeGlobal, "playwright"), source: "global" });
    expect(locateBrowserEngine({ env: {}, cwd: nowhere, globalRoots: [] }).engine).toBeNull();
    const explicit = locateBrowserEngine({ env: { INSTAFY_PREVIEW_CHECK_PLAYWRIGHT: path.join(fakeGlobal, "playwright") }, cwd: nowhere, globalRoots: [] });
    expect(explicit.engine?.source).toBe("env");
    const bad = locateBrowserEngine({ env: { INSTAFY_PREVIEW_CHECK_PLAYWRIGHT: path.join(tmp, "nope") }, cwd: nowhere, globalRoots: [fakeGlobal] });
    expect(bad.engine).toBeNull();
    // this checkout's own pnpm store
    expect(locateBrowserEngine({ env: {}, cwd: process.cwd(), globalRoots: [] }).engine?.source).toBe("workspace");
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
    expect(chromiumCandidates({ INSTAFY_PREVIEW_CHECK_CHROMIUM: "/x/chrome" }, exists)).toEqual(["/x/chrome"]);
  });

  it("is registered as `preview check` with its options", () => {
    const program = new Command();
    const preview = program.command("preview");
    const check = registerPreviewCheckCommand(preview);
    expect(check.name()).toBe("check");
    const flags = check.options.map((o) => o.long);
    expect(flags).toEqual(["--port", "--path", "--phone", "--out", "--timeout", "--wait", "--json"]);
  });
});

describe("preview check: exits", () => {
  it("exit 2 when nothing listens, before looking for a browser", async () => {
    const port = await freePort();
    const result = await runSiteCheck({ port, env: { INSTAFY_PREVIEW_CHECK_PLAYWRIGHT: "/definitely/not/here" } });
    expect(result.code).toBe(CHECK_EXIT_NOT_LISTENING);
    expect(result.message).toMatch(/Nothing is answering/);
  });

  it("a site that answers 500 is up: it goes on to the browser pass (which lists the 500), not exit 2", async () => {
    const port = await serve({ "/": { status: 500, body: "Internal Server Error" } });
    const result = await runSiteCheck({ port, env: { INSTAFY_PREVIEW_CHECK_PLAYWRIGHT: "/definitely/not/here" } });
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

  it("the instafy binary runs it as `instafy preview check` (a missing --port exits 64; a reserved port exits 3)", () => {
    const bin = path.resolve(__dirname, "..", "bin", "instafy.js");
    const run = (args: string[]) => spawnSync(process.execPath, [bin, ...args], { encoding: "utf8", env: { ...process.env, HOME: tmp } });
    const missing = run(["preview", "check", "--json"]);
    expect(missing.status, missing.stderr).toBe(CHECK_EXIT_USAGE);
    expect(JSON.parse(missing.stdout)).toMatchObject({ ok: false, exitCode: CHECK_EXIT_USAGE });
    expect(run(["preview", "check", "--port", "9222"]).status).toBe(3);
  });

  it("exit 3 for a reserved port (the Shared Browser's CDP port among them)", async () => {
    const out: string[] = [];
    const code = await runPreviewCheckCli({ port: "9223", json: true }, { out: (s: string) => out.push(s), err: () => {} });
    expect(code).toBe(3);
    expect(JSON.parse(out[0]!)).toMatchObject({ ok: false, exitCode: 3 });
  });

  it("exit 4 and a SKIPPED message when no browser engine exists; stale screenshots are removed", async () => {
    const port = await serve({ "/": { body: GOOD } });
    const outDir = path.join(tmp, "skipped");
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, "desktop.png"), "old");
    const result = await runSiteCheck({ port, outDir, env: { INSTAFY_PREVIEW_CHECK_PLAYWRIGHT: "/definitely/not/here" } });
    expect(result.code).toBe(CHECK_EXIT_NO_BROWSER);
    expect(result.message).toMatch(/SKIPPED/);
    expect(fs.existsSync(path.join(outDir, "desktop.png"))).toBe(false);
  });
});

describe.skipIf(!browserOk)("preview check: in a browser", () => {
  it("a healthy page passes: title, both screenshots, HTTP 200", { timeout: 90_000 }, async () => {
    const port = await serve({ "/": { body: GOOD } });
    const outDir = path.join(tmp, "good");
    const result = await runSiteCheck({ port, outDir });
    expect(result.code, JSON.stringify(result.report?.viewports.map((v) => v.errors))).toBe(CHECK_EXIT_OK);
    const r = result.report!;
    expect(r.title).toBe("Coffee walk");
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
    const result = await runSiteCheck({ port, outDir: path.join(tmp, "broken"), phone: true });
    expect(result.code).toBe(CHECK_EXIT_PROBLEMS);
    const errors = result.report!.viewports[0]!.errors.join("\n");
    expect(errors).toMatch(/console\.error: boom: data\.json had no rows/);
    expect(errors).toMatch(/uncaught: .*kaput/);
    expect(errors).toMatch(/HTTP 404: \/missing\.js/);
  });

  it("a minimal page (one heading on a plain background) passes", { timeout: 90_000 }, async () => {
    const port = await serve({ "/": { body: `<!doctype html><title>Hello</title><h1>Hello</h1>` } });
    const result = await runSiteCheck({ port, outDir: path.join(tmp, "minimal") });
    expect(result.code, JSON.stringify(result.report?.viewports.map((v) => v.errors))).toBe(CHECK_EXIT_OK);
  });

  it("a blank page is a problem", { timeout: 90_000 }, async () => {
    const port = await serve({ "/": { body: BLANK } });
    const result = await runSiteCheck({ port, outDir: path.join(tmp, "blank"), phone: true });
    expect(result.code).toBe(CHECK_EXIT_PROBLEMS);
    expect(result.report!.viewports[0]!.blank.blank).toBe(true);
    expect(result.report!.viewports[0]!.errors.join("\n")).toMatch(/blank page/);
  });

  it("a site that refuses to be framed is reported (a pane could not show it)", { timeout: 90_000 }, async () => {
    const port = await serve({ "/": { body: GOOD, headers: { "x-frame-options": "DENY" } } });
    const result = await runSiteCheck({ port, outDir: path.join(tmp, "deny"), phone: true });
    expect(result.code).toBe(CHECK_EXIT_PROBLEMS);
    expect(result.report!.viewports[0]!.blank.reason).toMatch(/refuses to be shown in a frame/);
  });

  it("--phone takes only the phone screenshot, at phone size, and the path (with a hash) is loaded", { timeout: 90_000 }, async () => {
    const port = await serve({
      "/docs/": {
        body: `<!doctype html><title>Docs</title><body style="background:#eef"><h1 style="background:#246;color:#fff;padding:40px">Section 2</h1><p>How the setup works.</p>
<script>addEventListener('load', () => setTimeout(() => { document.title = 'Docs ' + location.hash + ' ' + innerWidth; }, 150));</script>`,
      },
    });
    const outDir = path.join(tmp, "phone");
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, "desktop.png"), "stale");
    const out: string[] = [];
    const code = await runPreviewCheckCli(
      { port: String(port), path: "/docs/#s=2", phone: true, out: outDir, json: true },
      { out: (s: string) => out.push(s), err: () => {} },
    );
    expect(code).toBe(CHECK_EXIT_OK);
    const r = JSON.parse(out[0]!);
    expect(r.viewports).toHaveLength(1);
    expect(r.viewports[0].name).toBe("phone");
    expect(r.title).toBe("Docs #s=2 390");
    expect(fs.existsSync(path.join(outDir, "phone.png"))).toBe(true);
    expect(fs.existsSync(path.join(outDir, "desktop.png"))).toBe(false);
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
  it("checks the page before it is shown, and says exit 4 means nothing was checked", () => {
    const text = fs.readFileSync(skill, "utf8");
    const check = text.indexOf("instafy preview check --port <port>");
    expect(check).toBeGreaterThan(-1);
    // before the step that asks to expose the port
    expect(check).toBeLessThan(text.indexOf("Ask consent before exposing"));
    expect(text).toMatch(/exit 4[^\n]*nothing was checked/i);
  });
});
