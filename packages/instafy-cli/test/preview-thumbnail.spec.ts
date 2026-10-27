// The picture on a preview card: what a capture may load, what a picture is, and the no-browser fallback.
// The browser cases drive this checkout's Playwright (as site-check.spec.ts does) and skip where no Chromium starts.
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { afterAll, describe, expect, it } from "vitest";
import {
  captureSiteThumbnail,
  pictureProblem,
  readHeadMeta,
  readThumbnailFile,
  sniffImage,
  staticThumbnail,
  thumbnailBudgetMs,
} from "../src/preview-thumbnail.js";
import { LINK_ONLY_FILE, LINK_ONLY_SCHEMA, linkOnlySite } from "../src/web-read.js";
import {
  classifyRequest,
  cleanDescription,
  launchChromium,
  loadCaptureLinkOnly,
  loadPlaywright,
  locateBrowserEngine,
  startOffSiteRoute,
  type RequestRules,
} from "../src/site-check.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "instafy-preview-thumbnail-"));
const servers: Array<http.Server | net.Server> = [];
const sockets = new Set<net.Socket>();
afterAll(async () => {
  for (const socket of sockets) socket.destroy();
  for (const s of servers) {
    (s as http.Server).closeAllConnections?.();
    await new Promise((r) => s.close(r));
  }
  fs.rmSync(tmp, { recursive: true, force: true });
}, 30_000);

/** A PNG header with its size: enough for the sniffing, which never decodes pixels. */
function pngOf(width: number, height: number, extra = 0): Buffer {
  const head = Buffer.alloc(33 + extra);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(head, 0);
  head.writeUInt32BE(13, 8);
  head.write("IHDR", 12, "latin1");
  head.writeUInt32BE(width, 16);
  head.writeUInt32BE(height, 20);
  return head;
}

function jpegOf(width: number, height: number): Buffer {
  const frame = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 255, width >> 8, width & 255, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x4a, 0x46]), frame, Buffer.from([0xff, 0xd9])]);
}

function webpOf(width: number, height: number): Buffer {
  const data = Buffer.from([0x10, 0x02, 0x00, 0x9d, 0x01, 0x2a, width & 255, width >> 8, height & 255, height >> 8]);
  const chunk = Buffer.concat([Buffer.from("VP8 ", "latin1"), Buffer.from([data.length, 0, 0, 0]), data]);
  const size = Buffer.alloc(4);
  size.writeUInt32LE(chunk.length + 4);
  return Buffer.concat([Buffer.from("RIFF", "latin1"), size, Buffer.from("WEBP", "latin1"), chunk]);
}

type Route = { status?: number; type?: string; body: string | Buffer };
async function serve(routes: Record<string, Route>, seen: string[] = []): Promise<number> {
  const server = http.createServer((req, res) => {
    seen.push(req.url ?? "");
    const route = routes[(req.url ?? "/").split("?")[0]!];
    res.writeHead(route?.status ?? (route ? 200 : 404), { "content-type": route?.type ?? "text/html; charset=utf-8" });
    res.end(route?.body ?? "not found");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  servers.push(server);
  return (server.address() as { port: number }).port;
}

describe("a preview's picture: what it is, from its bytes", () => {
  it("reads JPEG, PNG and WebP sizes from the header, and nothing else is a picture", () => {
    expect(sniffImage(jpegOf(640, 400))).toEqual({ contentType: "image/jpeg", width: 640, height: 400 });
    expect(sniffImage(pngOf(800, 500))).toEqual({ contentType: "image/png", width: 800, height: 500 });
    expect(sniffImage(webpOf(320, 200))).toEqual({ contentType: "image/webp", width: 320, height: 200 });
    for (const other of ['<svg xmlns="http://www.w3.org/2000/svg"/>', "GIF89a\x40\x00\x40\x00", "<html>not an image</html>", ""]) {
      expect(sniffImage(Buffer.from(other, "latin1"))).toBeNull();
    }
  });

  it("refuses a picture too small, too large or over 512 KiB", () => {
    expect(pictureProblem(pngOf(640, 400), sniffImage(pngOf(640, 400)))).toBeNull();
    expect(pictureProblem(pngOf(32, 32), sniffImage(pngOf(32, 32)))).toMatch(/64 to 2000/);
    expect(pictureProblem(pngOf(4000, 400), sniffImage(pngOf(4000, 400)))).toMatch(/64 to 2000/);
    const big = pngOf(640, 400, 600 * 1024);
    expect(pictureProblem(big, sniffImage(big))).toMatch(/512 KiB/);
    expect(pictureProblem(Buffer.from("<svg/>"), null)).toMatch(/not a JPEG, PNG or WebP/);
  });

  it("takes a skill's own picture from --thumbnail, and skips one that is not a picture", () => {
    const good = path.join(tmp, "map.png");
    fs.writeFileSync(good, pngOf(640, 400));
    const ok = readThumbnailFile(good);
    expect(ok).toMatchObject({ ok: true, thumbnail: { contentType: "image/png", width: 640, height: 400, source: "file", description: null } });
    const svg = path.join(tmp, "map.svg");
    fs.writeFileSync(svg, "<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>");
    expect(readThumbnailFile(svg)).toMatchObject({ ok: false, status: "skipped", reason: expect.stringMatching(/not a JPEG, PNG or WebP/) });
    expect(readThumbnailFile(path.join(tmp, "missing.png"))).toMatchObject({ ok: false, status: "skipped" });
  });

  it("reads a page's description and og:image from its own meta tags, as one plain line", () => {
    const html = `<head><meta property="og:image" content="/og.png"><meta content='Trip · 3 days\n &amp; 14 places' name="description"></head>`;
    expect(readHeadMeta(html)).toEqual({ description: "Trip · 3 days & 14 places", ogImage: "/og.png" });
    expect(cleanDescription("  a‮b\u0007c  ")).toBe("ab c");
    expect(cleanDescription("x".repeat(400))).toHaveLength(300);
    expect(cleanDescription("   ")).toBeNull();
  });
});

describe("what a capture or check may load", () => {
  const site = "http://127.0.0.1:4173";
  const linkOnly = loadCaptureLinkOnly(tmp, {});
  const rules: RequestRules = { direct: [site], offSite: "proxy", linkOnly };

  it("loads the site's own origin directly, its WebSockets included, and in-page data", () => {
    expect(linkOnly).not.toBeNull();
    expect(classifyRequest(`${site}/app.js`, rules)).toEqual({ kind: "direct" });
    expect(classifyRequest("ws://127.0.0.1:4173/@vite/hmr", rules)).toEqual({ kind: "direct" });
    expect(classifyRequest("data:image/png;base64,AAAA", rules)).toEqual({ kind: "direct" });
  });

  it("blocks another local port, localhost names, private and metadata addresses, and other ports", () => {
    for (const url of [
      "http://127.0.0.1:41730/api",
      "http://127.0.0.1:5432/",
      "ws://127.0.0.1:9222/devtools",
      "http://[::1]:4173/",
      "http://localhost:4173/",
      "http://api.localhost/",
      "http://10.1.2.3/e.png",
      "http://192.168.1.1/",
      "http://169.254.169.254/latest/meta-data/",
      "http://100.64.0.1/",
      "http://router/",
      "https://example.com:8443/x",
      "ftp://example.com/x",
    ]) {
      expect(classifyRequest(url, rules).kind, url).toBe("blocked");
    }
    expect(classifyRequest("http://127.0.0.1:41730/api", rules)).toEqual({ kind: "blocked", reason: expect.stringMatching(/another local server/) });
  });

  it("blocks link-only sites, their subdomains and their translator copies, and sends other public addresses to the proxy", () => {
    expect(classifyRequest("https://www.booking.com/hotel/pt/x.html", rules)).toEqual({ kind: "blocked", reason: expect.stringMatching(/link-only/) });
    expect(classifyRequest("wss://booking.com/socket", rules).kind).toBe("blocked");
    expect(classifyRequest("https://tile.openstreetmap.org/1/1/1.png", rules)).toEqual({ kind: "proxy" });
    expect(classifyRequest("https://example.org:443/a", rules)).toEqual({ kind: "proxy" });
  });

  it("blocks a site whose terms bar reusing its content too, which readers may read: the picture is kept and shown", () => {
    const skills = path.join(tmp, "reuse-space", ".agents", "skills");
    const file = path.join(skills, "instafy-web-research", "references", LINK_ONLY_FILE);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({
      schema: LINK_ONLY_SCHEMA,
      sites: [{ name: "Example Reviews", match: ["reviews.example"], kind: "no-reuse", why: "terms bar copying its reviews" }],
    }));
    const withCopy = loadCaptureLinkOnly(path.join(tmp, "reuse-space"), {});
    expect(withCopy).not.toBeNull();
    // `instafy web read` reads it; the capture and the check do not load it into a picture.
    expect(linkOnlySite("https://www.reviews.example/item/1", withCopy!)).toBeNull();
    expect(classifyRequest("https://www.reviews.example/photo.jpg", { ...rules, linkOnly: withCopy })).toEqual({
      kind: "blocked",
      reason: expect.stringMatching(/^Example Reviews bars reusing its content/),
    });
    expect(classifyRequest("https://www.booking.com/x.png", { ...rules, linkOnly: withCopy })).toEqual({ kind: "blocked", reason: expect.stringMatching(/link-only/) });
    expect(classifyRequest("https://tile.openstreetmap.org/1/1/1.png", { ...rules, linkOnly: withCopy })).toEqual({ kind: "proxy" });
  });

  it("blocks everything off the site without a proxy, or without the link-only list", () => {
    expect(classifyRequest("https://tile.openstreetmap.org/1/1/1.png", { ...rules, offSite: "blocked" }).kind).toBe("blocked");
    expect(classifyRequest("https://tile.openstreetmap.org/1/1/1.png", { ...rules, linkOnly: null }).kind).toBe("blocked");
    expect(classifyRequest(`${site}/still-fine.js`, { ...rules, offSite: "blocked", linkOnly: null })).toEqual({ kind: "direct" });
  });

  it("without the image's egress proxy, requests off the site go to a local stand-in that refuses them all", async () => {
    const route = await startOffSiteRoute({ locations: [path.join(tmp, "no-such-proxy")] });
    try {
      expect(route.kind).toBe("blocked");
      const status = await new Promise<number>((resolve) => {
        const url = new URL(route.server);
        http.get({ host: url.hostname, port: Number(url.port), path: "http://example.com/" }, (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        }).on("error", () => resolve(-1));
      });
      expect(status).toBe(403);
    } finally {
      await route.stop();
    }
  });
});

describe("without a browser: the page's own og:image, on its own origin only", () => {
  it("uploads a same-origin og:image with the page's description", async () => {
    const port = await serve({
      "/": { body: `<!doctype html><title>Map</title><meta name="description" content="Map · 14 places"><meta property="og:image" content="/og.png">` },
      "/og.png": { type: "image/png", body: pngOf(1200, 630) },
    });
    const result = await staticThumbnail(`http://127.0.0.1:${port}`, "/");
    expect(result).toMatchObject({ ok: true, thumbnail: { source: "og_image", contentType: "image/png", width: 1200, height: 630, description: "Map · 14 places" } });
  });

  it("never fetches an og:image on another host, nor one that is not a picture", async () => {
    const elsewhereSeen: string[] = [];
    const elsewhere = await serve({ "/og.png": { type: "image/png", body: pngOf(1200, 630) } }, elsewhereSeen);
    const port = await serve({
      "/": { body: `<meta property="og:image" content="http://127.0.0.1:${elsewhere}/og.png">` },
      "/fake": { body: `<meta property="og:image" content="/og.svg">` },
      "/og.svg": { type: "image/svg+xml", body: "<svg xmlns='http://www.w3.org/2000/svg'/>" },
    });
    expect(await staticThumbnail(`http://127.0.0.1:${port}`, "/")).toMatchObject({ ok: false, status: "skipped", reason: expect.stringMatching(/not on the site itself/) });
    expect(elsewhereSeen).toEqual([]);
    expect(await staticThumbnail(`http://127.0.0.1:${port}`, "/fake")).toMatchObject({ ok: false, status: "skipped", reason: expect.stringMatching(/not a JPEG, PNG or WebP/) });
  });

  it("has a 15 s budget unless the machine allows more (1 to 120 s)", () => {
    expect(thumbnailBudgetMs({})).toBe(15_000);
    expect(thumbnailBudgetMs({ INSTAFY_PREVIEW_THUMBNAIL_BUDGET_MS: "30000" })).toBe(30_000);
    for (const bad of ["0", "500", "999999", "soon", "15000.5"]) expect(thumbnailBudgetMs({ INSTAFY_PREVIEW_THUMBNAIL_BUDGET_MS: bad })).toBe(15_000);
  });

  it("is what a capture falls back to when no browser engine is here", async () => {
    const port = await serve({ "/": { body: `<meta property="og:image" content="/og.png">` }, "/og.png": { type: "image/png", body: pngOf(640, 400) } });
    const result = await captureSiteThumbnail({ port, path: "/", env: { INSTAFY_SHARED_BROWSER_PLAYWRIGHT_PATH: "/definitely/not/here" }, globalRoots: [] });
    expect(result).toMatchObject({ ok: true, thumbnail: { source: "og_image" } });
  });
});

// This checkout's Playwright, handed over as the runtime image hands over its trusted copy.
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

/** A stand-in for the egress proxy: it serves `public.example` itself and records every request it is sent. */
async function testProxy(seen: string[]): Promise<string> {
  const pixel = pngOf(64, 64);
  const server = http.createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    if (req.url?.startsWith("http://public.example/")) {
      res.writeHead(200, { "content-type": "image/png" });
      res.end(pixel);
      return;
    }
    res.writeHead(403);
    res.end();
  });
  server.on("connect", (req, socket: net.Socket) => {
    seen.push(`CONNECT ${req.url}`);
    socket.on("error", () => {});
    socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  servers.push(server);
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

describe.skipIf(!browserOk)("with a browser: the site's own page", () => {
  it(
    "capture blocks another loopback port, a private address and a link-only host, and loads a public one through the proxy",
    { timeout: 180_000 },
    async () => {
      const otherSeen: string[] = [];
      const other = await serve({ "/secret.png": { type: "image/png", body: pngOf(64, 64) } }, otherSeen);
      const proxied: string[] = [];
      const proxyServer = await testProxy(proxied);
      const port = await serve({
        "/": {
          body: `<!doctype html><title>Lisbon weekend</title><meta name="description" content="Trip · 3 days · 14 places">
<body style="margin:0;background:#e8f0e6;font:16px system-ui"><h1 style="padding:24px;background:#2a6;color:#fff">Lisbon weekend</h1>
<img src="http://127.0.0.1:${other}/secret.png"><img src="http://10.1.2.3/e.png"><img src="https://www.booking.com/x.png">
<img src="http://public.example/pic.png"></body>`,
        },
      });
      const result = await captureSiteThumbnail({ port, path: "/", env: browserEnv, proxyServer, budgetMs: 60_000 });
      expect(result.ok, JSON.stringify(result)).toBe(true);
      if (!("thumbnail" in result)) return;
      expect(sniffImage(result.thumbnail.image)).toEqual({ contentType: "image/jpeg", width: 640, height: 400 });
      expect(result.thumbnail.image.length).toBeLessThanOrEqual(256 * 1024);
      expect(result.thumbnail).toMatchObject({ source: "capture", description: "Trip · 3 days · 14 places" });
      const blocked = result.blocked.join("\n");
      expect(blocked).toContain(`http://127.0.0.1:${other}/secret.png`);
      expect(blocked).toContain("http://10.1.2.3/e.png");
      expect(blocked).toMatch(/booking\.com\/x\.png \(Booking\.com is link-only/);
      // The other local server and the blocked hosts were never reached; the public one came through the proxy.
      expect(otherSeen).toEqual([]);
      expect(proxied).toContain("GET http://public.example/pic.png");
      expect(proxied.join("\n")).not.toMatch(/booking|10\.1\.2\.3|127\.0\.0\.1/);
    },
  );

  it("a capture that runs past its budget fails without hanging", { timeout: 120_000 }, async () => {
    // A server that takes the connection and never answers.
    const hung = net.createServer((socket) => {
      sockets.add(socket);
    });
    hung.listen(0, "127.0.0.1");
    await once(hung, "listening");
    servers.push(hung);
    const port = (hung.address() as { port: number }).port;
    const started = Date.now();
    const result = await captureSiteThumbnail({ port, path: "/", env: browserEnv, budgetMs: 3_000 });
    expect(result).toMatchObject({ ok: false, status: "failed" });
    expect(Date.now() - started).toBeLessThan(60_000);
  });
});
