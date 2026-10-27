// SPDX-License-Identifier: AGPL-3.0-only
//
// The picture on a preview's card. `instafy preview open` takes one once the site is live: the site's own page at
// 1280×800 in the runtime's headless Chromium, as a 640×400 JPEG, with the page's own `<meta name="description">`. The
// page loads as an anonymous first visit (no person's session, cookies, location or browser profile) under the same
// request rules as `instafy preview check`: the site's own loopback origin directly, other public addresses through the
// image's egress proxy, never another local port, a private address or a link-only site.
//
// Without a browser (a self-hosted machine without Chromium) the page's HTML is read from 127.0.0.1 and its `og:image`
// is used when it is on the site's own origin and is a real JPEG, PNG or WebP; an image anywhere else is never fetched.
// `--thumbnail <file>` hands in a picture a skill made itself. The whole capture has a 15 s budget and never changes
// the command's exit code. Nothing here calls an Instafy server: preview.ts uploads the result.
import fs from "node:fs";
import http from "node:http";
import {
  NoBrowserError,
  THUMBNAIL_HEIGHT,
  THUMBNAIL_WIDTH,
  applyRequestRules,
  cleanDescription,
  closePopups,
  contextProxy,
  launchChromium,
  loadCaptureLinkOnly,
  loadPlaywright,
  locateBrowserEngine,
  pageThumbnail,
  readPageDescription,
  startOffSiteRoute,
  type OffSiteRoute,
  type RequestRules,
} from "./site-check.js";

export const THUMBNAIL_BUDGET_MS = 15_000;
/** A slow machine may allow the picture more time (1 to 120 s); the default is 15 s. */
export const THUMBNAIL_BUDGET_ENV = "INSTAFY_PREVIEW_THUMBNAIL_BUDGET_MS";

export function thumbnailBudgetMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env[THUMBNAIL_BUDGET_ENV]);
  return Number.isInteger(raw) && raw >= 1_000 && raw <= 120_000 ? raw : THUMBNAIL_BUDGET_MS;
}
const NETWORK_IDLE_MS = 6_000;
const SETTLE_MS = 1_000;
/** A picture a skill hands in, or a site's own og:image: at most this big. */
export const MAX_THUMBNAIL_FILE_BYTES = 512 * 1024;
const MAX_HTML_BYTES = 512 * 1024;
const MIN_SIDE = 64;
const MAX_SIDE = 2000;

export type ThumbnailContentType = "image/jpeg" | "image/png" | "image/webp";
export type ThumbnailSource = "capture" | "og_image" | "file";

export type Thumbnail = {
  image: Buffer;
  contentType: ThumbnailContentType;
  width: number;
  height: number;
  source: ThumbnailSource;
  description: string | null;
};

export type ThumbnailAttempt =
  | { ok: true; thumbnail: Thumbnail; blocked: string[] }
  | { ok: false; status: "skipped" | "failed"; reason: string };

// ---------------------------------------------------------------------------------------------------------------
// What a picture is, from its bytes

export type ImageFacts = { contentType: ThumbnailContentType; width: number; height: number };

function jpegFacts(b: Buffer): ImageFacts | null {
  let pos = 2;
  while (pos + 4 <= b.length) {
    if (b[pos] !== 0xff) return null;
    while (b[pos] === 0xff) pos += 1;
    const marker = b[pos]!;
    pos += 1;
    if (marker === 0xd9 || marker === 0xda) return null;
    if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) continue;
    if (pos + 2 > b.length) return null;
    const length = b.readUInt16BE(pos);
    if (length < 2) return null;
    const frame = (marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf);
    if (frame) {
      if (pos + 7 > b.length) return null;
      return { contentType: "image/jpeg", height: b.readUInt16BE(pos + 3), width: b.readUInt16BE(pos + 5) };
    }
    pos += length;
  }
  return null;
}

function webpFacts(b: Buffer): ImageFacts | null {
  let pos = 12;
  while (pos + 8 <= b.length) {
    const kind = b.toString("latin1", pos, pos + 4);
    const length = b.readUInt32LE(pos + 4);
    const data = pos + 8;
    if (kind === "VP8X" && data + 10 <= b.length) {
      if (b[data]! & 0x02) return null; // animated
      return { contentType: "image/webp", width: 1 + b.readUIntLE(data + 4, 3), height: 1 + b.readUIntLE(data + 7, 3) };
    }
    if (kind === "VP8 " && data + 10 <= b.length) {
      if (b[data + 3] !== 0x9d || b[data + 4] !== 0x01 || b[data + 5] !== 0x2a) return null;
      return { contentType: "image/webp", width: b.readUInt16LE(data + 6) & 0x3fff, height: b.readUInt16LE(data + 8) & 0x3fff };
    }
    if (kind === "VP8L" && data + 5 <= b.length) {
      if (b[data] !== 0x2f) return null;
      const bits = b.readUInt32LE(data + 1);
      return { contentType: "image/webp", width: 1 + (bits & 0x3fff), height: 1 + ((bits >>> 14) & 0x3fff) };
    }
    pos = data + length + (length % 2);
  }
  return null;
}

/** JPEG, PNG or WebP by its magic bytes and header, with its size; null for anything else (SVG, GIF, HTML, …). */
export function sniffImage(bytes: Buffer): ImageFacts | null {
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return jpegFacts(bytes);
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) && bytes.toString("latin1", 12, 16) === "IHDR") {
    return { contentType: "image/png", width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  if (bytes.length >= 16 && bytes.toString("latin1", 0, 4) === "RIFF" && bytes.toString("latin1", 8, 12) === "WEBP") return webpFacts(bytes);
  return null;
}

/** Why a picture cannot go on a card, or null when it can. */
export function pictureProblem(bytes: Buffer, facts: ImageFacts | null): string | null {
  if (bytes.length > MAX_THUMBNAIL_FILE_BYTES) return `it is over ${MAX_THUMBNAIL_FILE_BYTES / 1024} KiB`;
  if (!facts) return "it is not a JPEG, PNG or WebP";
  if (facts.width < MIN_SIDE || facts.height < MIN_SIDE || facts.width > MAX_SIDE || facts.height > MAX_SIDE) {
    return `it is ${facts.width}×${facts.height}; a picture must be ${MIN_SIDE} to ${MAX_SIDE} pixels each way`;
  }
  return null;
}

/** `--thumbnail <file>`: a picture a skill made itself (JPEG, PNG or WebP, at most 512 KiB and 2000×2000). */
export function readThumbnailFile(file: string): ThumbnailAttempt {
  let bytes: Buffer;
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) return { ok: false, status: "skipped", reason: `--thumbnail ${file} is not a file` };
    if (stat.size > MAX_THUMBNAIL_FILE_BYTES) {
      return { ok: false, status: "skipped", reason: `--thumbnail ${file}: it is over ${MAX_THUMBNAIL_FILE_BYTES / 1024} KiB` };
    }
    bytes = fs.readFileSync(file);
  } catch (error) {
    return { ok: false, status: "skipped", reason: `--thumbnail ${file} could not be read (${(error as NodeJS.ErrnoException).code ?? "error"})` };
  }
  const facts = sniffImage(bytes);
  const problem = pictureProblem(bytes, facts);
  if (problem || !facts) return { ok: false, status: "skipped", reason: `--thumbnail ${file}: ${problem}` };
  return { ok: true, thumbnail: { image: bytes, ...facts, source: "file", description: null }, blocked: [] };
}

// ---------------------------------------------------------------------------------------------------------------
// Without a browser: the page's own og:image, on its own origin only

function decodeEntities(value: string): string {
  return value
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d{1,6});/g, (_m, code) => String.fromCodePoint(Math.min(Number(code), 0x10ffff)))
    .replace(/&#x([0-9a-f]{1,6});/gi, (_m, code) => String.fromCodePoint(Math.min(parseInt(code, 16), 0x10ffff)))
    .replace(/&amp;/gi, "&");
}

/** The `<meta>` tags of a page's HTML that a card uses: its description and its og:image. */
export function readHeadMeta(html: string): { description: string | null; ogImage: string | null } {
  let description: string | null = null;
  let ogImage: string | null = null;
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    const attrs = new Map<string, string>();
    for (const match of tag.matchAll(/([a-zA-Z:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g)) {
      attrs.set(match[1]!.toLowerCase(), decodeEntities(match[2] ?? match[3] ?? match[4] ?? ""));
    }
    const content = attrs.get("content");
    if (content === undefined) continue;
    const name = (attrs.get("name") ?? "").toLowerCase();
    const property = (attrs.get("property") ?? "").toLowerCase();
    if (description === null && name === "description") description = cleanDescription(content);
    if (ogImage === null && (property === "og:image" || property === "og:image:url" || name === "og:image")) ogImage = content.trim() || null;
  }
  return { description, ogImage };
}

/** One GET to the site on 127.0.0.1 (never anywhere else), at most `maxBytes`. */
function getLocal(url: URL, maxBytes: number, timeoutMs: number): Promise<{ status: number; type: string; body: Buffer } | null> {
  return new Promise((resolve) => {
    const request = http.get(
      { host: url.hostname.replace(/^\[|\]$/g, ""), port: Number(url.port), path: `${url.pathname}${url.search}`, timeout: timeoutMs, headers: { accept: "text/html,image/*;q=0.8" } },
      (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > maxBytes) {
            request.destroy();
            resolve(null);
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () => resolve({ status: response.statusCode ?? 0, type: String(response.headers["content-type"] ?? ""), body: Buffer.concat(chunks) }));
        response.on("error", () => resolve(null));
      },
    );
    request.on("timeout", () => request.destroy());
    request.on("error", () => resolve(null));
  });
}

/** The page's own facts read without a browser: its description, and its og:image when that is on its own origin. */
export async function staticThumbnail(siteOrigin: string, sitePath: string, budgetMs = THUMBNAIL_BUDGET_MS): Promise<ThumbnailAttempt> {
  const deadline = Date.now() + budgetMs;
  const pageUrl = new URL(sitePath, siteOrigin);
  const page = await getLocal(pageUrl, MAX_HTML_BYTES, Math.max(500, Math.min(5_000, deadline - Date.now())));
  if (!page || page.status >= 400 || !/html/i.test(page.type)) {
    return { ok: false, status: "skipped", reason: "no browser here, and the page could not be read for an og:image" };
  }
  const { description, ogImage } = readHeadMeta(page.body.toString("utf8"));
  let imageUrl: URL | null = null;
  try {
    imageUrl = ogImage ? new URL(ogImage, pageUrl) : null;
  } catch {
    imageUrl = null;
  }
  if (!imageUrl) return { ok: false, status: "skipped", reason: "no browser here, and the page names no og:image" };
  // Another host's image is never fetched, nor shown.
  if (imageUrl.origin !== new URL(siteOrigin).origin) {
    return { ok: false, status: "skipped", reason: "no browser here, and the page's og:image is not on the site itself" };
  }
  const image = await getLocal(imageUrl, MAX_THUMBNAIL_FILE_BYTES, Math.max(500, Math.min(5_000, deadline - Date.now())));
  if (!image || image.status >= 400) return { ok: false, status: "skipped", reason: "no browser here, and the page's og:image could not be loaded" };
  const facts = sniffImage(image.body);
  const problem = pictureProblem(image.body, facts);
  if (problem || !facts) return { ok: false, status: "skipped", reason: `no browser here, and the page's og:image cannot be used: ${problem}` };
  return { ok: true, thumbnail: { image: image.body, ...facts, source: "og_image", description }, blocked: [] };
}

// ---------------------------------------------------------------------------------------------------------------
// With a browser: the page itself

export type CaptureOptions = {
  port: number;
  path: string;
  /** the address the site answers on (the preview's tunnel dials 127.0.0.1) */
  host?: "127.0.0.1" | "::1";
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  budgetMs?: number;
  /** test hooks: where to look for a global Playwright, and a proxy for requests off the site */
  globalRoots?: string[];
  proxyServer?: string;
};

function errorLine(error: unknown): string {
  return String((error as Error)?.message ?? error).split("\n")[0]!.slice(0, 300);
}

/**
 * A picture of the site for its card, within the budget: the page in a headless browser, else (no browser here) the
 * page's own og:image. Never throws.
 */
export async function captureSiteThumbnail(options: CaptureOptions): Promise<ThumbnailAttempt> {
  const env = options.env ?? process.env;
  const budget = options.budgetMs ?? thumbnailBudgetMs(env);
  const deadline = Date.now() + budget;
  const host = options.host === "::1" ? "[::1]" : "127.0.0.1";
  const siteOrigin = `http://${host}:${options.port}`;
  const left = () => Math.max(0, deadline - Date.now());

  const { engine } = locateBrowserEngine({ env, cwd: options.cwd, globalRoots: options.globalRoots });
  if (!engine) return staticThumbnail(siteOrigin, options.path, left());
  let launched: { browser: any; executable: string };
  try {
    launched = await launchChromium(loadPlaywright(engine), env);
  } catch (error) {
    if (error instanceof NoBrowserError) return staticThumbnail(siteOrigin, options.path, left());
    return { ok: false, status: "failed", reason: `the browser would not start: ${errorLine(error)}` };
  }

  const blocked = new Map<string, string>();
  let route: OffSiteRoute | null = null;
  let timer: NodeJS.Timeout | null = null;
  const work = (async (): Promise<ThumbnailAttempt> => {
    route = await startOffSiteRoute({ proxyServer: options.proxyServer });
    const rules: RequestRules = {
      direct: [siteOrigin],
      offSite: route.kind,
      linkOnly: loadCaptureLinkOnly(options.cwd ?? process.cwd(), env),
    };
    // An anonymous first visit: a fresh context with no session, cookies, location or profile; no service workers,
    // no downloads, no permissions.
    const context = await launched.browser.newContext({
      viewport: { width: THUMBNAIL_WIDTH * 2, height: THUMBNAIL_HEIGHT * 2 },
      deviceScaleFactor: 1,
      reducedMotion: "reduce",
      serviceWorkers: "block",
      acceptDownloads: false,
      proxy: contextProxy(route, rules.direct),
    });
    await applyRequestRules(context, rules, (url, reason) => {
      if (!blocked.has(url)) blocked.set(url, reason);
    });
    const page = await context.newPage();
    closePopups(page);
    const url = new URL(options.path, siteOrigin).href;
    const response = await page.goto(url, { waitUntil: "load", timeout: Math.max(1_000, left()) });
    if (response && response.status() >= 400) {
      return { ok: false, status: "skipped", reason: `the page answered HTTP ${response.status()}` };
    }
    await page.waitForLoadState("networkidle", { timeout: Math.max(1, Math.min(NETWORK_IDLE_MS, left())) }).catch(() => {});
    await page.waitForTimeout(Math.min(SETTLE_MS, left()));
    const description = await readPageDescription(page.mainFrame());
    const shot = await pageThumbnail(page, context);
    if ("skipped" in shot) return { ok: false, status: "skipped", reason: shot.skipped };
    return {
      ok: true,
      thumbnail: { image: shot.image, contentType: "image/jpeg", width: THUMBNAIL_WIDTH, height: THUMBNAIL_HEIGHT, source: "capture", description },
      blocked: [...blocked].map(([url, reason]) => `${url.slice(0, 200)} (${reason})`).slice(0, 20),
    };
  })();
  const outOfTime = new Promise<ThumbnailAttempt>((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, status: "failed", reason: `the picture took longer than ${Math.round(budget / 1000)} s` }), budget);
  });
  try {
    return await Promise.race([work.catch((error: unknown): ThumbnailAttempt => ({ ok: false, status: "failed", reason: errorLine(error) })), outOfTime]);
  } finally {
    if (timer) clearTimeout(timer);
    // Closing the browser ends whatever the page was still doing.
    await launched.browser.close().catch(() => {});
    await work.catch(() => undefined);
    await (route as OffSiteRoute | null)?.stop().catch(() => {});
  }
}
