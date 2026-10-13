#!/usr/bin/env node
// Generates the social card, packages/frontend/public/og-image.png (1200x630,
// opaque RGB), from scripts/og-image/card.html: the landing hero cropped, with
// the Octo mark drawn from its canonical geometry and Cub drawn by the shipping
// WebGL engine (docs/Brand.md, Social card). Then points every reference to the
// card (index.html and the SEO default in src/utils/seo.ts) at the new file's
// content-versioned URL, so link unfurlers drop their cached copy.
//
//   pnpm generate:og-image                     # write the card and update its URL
//   node scripts/generate-og-image.mjs --out /tmp/card.png [--query "t=7&u=104"]
//   node scripts/generate-og-image.mjs --out /tmp/ink.png --query "ink=1&settle=7&inkMs=1250"
//
// With --out the card goes to that path only and no reference is touched;
// --query passes review overrides to the template (see card-entry.js LAYOUT).
// Everything is served locally from the repo and node_modules (Inter from the
// pinned @fontsource/inter); any other request is blocked. The page runs on a
// paused fake clock the generator steps, so an ink card (Cub live, booped, his
// crew ink on the ledge) is as repeatable as the still one. The output is
// deterministic for a given Chromium build: equal pixels give equal bytes.

import { Buffer } from "node:buffer";
import fs from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { decodePng } from "./lib/png-ink-bounds.mjs";
import {
  SOCIAL_CARD_HEIGHT,
  SOCIAL_CARD_PATH,
  SOCIAL_CARD_REFERENCES,
  SOCIAL_CARD_WIDTH,
  encodeOpaqueRgbPng,
  replaceSocialCardUrls,
  socialCardImageUrl,
} from "./lib/og-image.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const templateDir = path.join(repoRoot, "scripts/og-image");
const frontendDir = path.join(repoRoot, "packages/frontend");
const requireFromFrontend = createRequire(path.join(frontendDir, "package.json"));

const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const outArg = option("--out");
const query = option("--query") ?? "";
const outPath = path.resolve(repoRoot, outArg ?? SOCIAL_CARD_PATH);
const updateReferences = !outArg;
if (updateReferences && query) {
  console.error("[generate-og-image] --query is for review renders; pass --out as well.");
  process.exit(1);
}

const FONT_WEIGHTS = [400, 500, 600, 700, 800];
/** The page's fake clock starts here, paused; BOOT_MS of it takes Cub through his boot and the card's first frames. */
const CLOCK_ORIGIN = Date.UTC(2026, 0, 1);
const BOOT_MS = 100;
const fontsDir = path.join(path.dirname(requireFromFrontend.resolve("@fontsource/inter/package.json")), "files");

async function bundleCardScript() {
  const { build } = await import(requireFromFrontend.resolve("vite"));
  const result = await build({
    configFile: false,
    root: frontendDir,
    envDir: templateDir,
    mode: "production",
    logLevel: "warn",
    resolve: { alias: { "@frontend-src": path.join(frontendDir, "src") } },
    build: {
      write: false,
      minify: false,
      copyPublicDir: false,
      reportCompressedSize: false,
      lib: { entry: path.join(templateDir, "card-entry.js"), formats: ["iife"], name: "InstafySocialCard" },
      rollupOptions: { output: { inlineDynamicImports: true } },
    },
  });
  const outputs = (Array.isArray(result) ? result : [result]).flatMap((entry) => entry.output);
  const chunk = outputs.find((entry) => entry.type === "chunk" && entry.isEntry);
  if (!chunk) throw new Error("the card script did not bundle");
  return chunk.code;
}

function serve(files) {
  const server = http.createServer((request, response) => {
    const pathname = new URL(request.url ?? "/", "http://card.localhost").pathname;
    const file = files.get(pathname);
    if (!file) {
      response.writeHead(404);
      response.end();
      return;
    }
    response.writeHead(200, { "content-type": file.type, "cache-control": "no-store" });
    response.end(file.body);
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

async function render(origin) {
  const { chromium } = requireFromFrontend("@playwright/test");
  // SwiftShader keeps Cub's WebGL2 frame on the CPU, the same on every run.
  const browser = await chromium.launch({
    channel: "chromium",
    args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist", "--font-render-hinting=none"],
  });
  try {
    const context = await browser.newContext({
      viewport: { width: SOCIAL_CARD_WIDTH, height: SOCIAL_CARD_HEIGHT },
      deviceScaleFactor: 1,
      colorScheme: "light",
      reducedMotion: "reduce",
      locale: "en-US",
    });
    await context.route("**/*", (route) =>
      route.request().url().startsWith(`${origin}/`) ? route.continue() : route.abort(),
    );
    // The page's timers, frames and clock are fake and paused: they move only
    // as far as runFor steps them, so a live Cub (an ink card) draws the same
    // frame on every run.
    await context.clock.install({ time: CLOCK_ORIGIN });
    await context.clock.pauseAt(CLOCK_ORIGIN);
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("requestfailed", (request) => errors.push(`blocked or failed: ${request.url()}`));
    await page.goto(`${origin}/card.html${query ? `?${query}` : ""}`, { waitUntil: "load" });
    await page.waitForSelector("body[data-mounted], body[data-ready]", { timeout: 60_000 });
    await page.clock.runFor(BOOT_MS);
    await page.waitForSelector("body[data-ready]", { timeout: 60_000 });
    const info = await page.evaluate(() => ({
      ready: document.body.dataset.ready,
      card: window.__card
        ? { status: window.__card.status, mode: window.__card.mode, u: window.__card.u, ink: window.__card.ink }
        : null,
      error: window.__cardError ?? null,
      fonts: [...document.fonts].filter((font) => font.status === "loaded").length,
    }));
    if (info.ready !== "1" || errors.length) {
      throw new Error(`the card did not render: ${JSON.stringify(info)} ${errors.join("; ")}`);
    }
    if (info.card?.mode !== "corner") throw new Error(`Cub must take the corner perch; got ${info.card?.mode}`);
    const ink = info.card.ink;
    if (ink) {
      // Boop him `settle` s after he booted, then stop the clock `inkMs` later.
      const now = await page.evaluate(() => performance.now());
      await page.clock.runFor(Math.max(0, Math.round(ink.bootAt + ink.settle * 1000 - now)));
      await page.evaluate(() => window.__cub.boop());
      await page.clock.runFor(ink.inkMs);
      const state = await page.evaluate(() => window.__cub.getState());
      if (state.ink !== 1) {
        throw new Error(`the boop must leave one set of ink (is there room on the ledge?): ${JSON.stringify(state)}`);
      }
    }
    const png = await page.screenshot({
      clip: { x: 0, y: 0, width: SOCIAL_CARD_WIDTH, height: SOCIAL_CARD_HEIGHT },
      animations: "disabled",
      caret: "hide",
    });
    return { png, info };
  } finally {
    await browser.close();
  }
}

const script = await bundleCardScript();
const files = new Map([
  ["/card.html", { type: "text/html; charset=utf-8", body: fs.readFileSync(path.join(templateDir, "card.html")) }],
  ["/card.js", { type: "text/javascript; charset=utf-8", body: Buffer.from(script) }],
  ...FONT_WEIGHTS.map((weight) => [
    `/fonts/inter-${weight}.woff2`,
    { type: "font/woff2", body: fs.readFileSync(path.join(fontsDir, `inter-latin-${weight}-normal.woff2`)) },
  ]),
]);
const server = await serve(files);
let rendered;
try {
  rendered = await render(`http://127.0.0.1:${server.address().port}`);
} finally {
  server.close();
}

const image = decodePng(rendered.png);
if (image.width !== SOCIAL_CARD_WIDTH || image.height !== SOCIAL_CARD_HEIGHT) {
  throw new Error(`expected ${SOCIAL_CARD_WIDTH}x${SOCIAL_CARD_HEIGHT}; got ${image.width}x${image.height}`);
}
const card = encodeOpaqueRgbPng(image);
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, card);
const url = socialCardImageUrl(card);
const { ink } = rendered.info.card;
const inkNote = ink ? `, ink ${ink.inkMs} ms after a boop at ${ink.settle} s` : "";
console.log(
  `[generate-og-image] wrote ${path.relative(repoRoot, outPath)} (${card.length} bytes, Cub ${rendered.info.card.mode} u ${rendered.info.card.u}${inkNote}, ${rendered.info.fonts} font faces)`,
);

if (updateReferences) {
  for (const relativePath of SOCIAL_CARD_REFERENCES) {
    const absolutePath = path.join(repoRoot, relativePath);
    const before = fs.readFileSync(absolutePath, "utf8");
    const after = replaceSocialCardUrls(before, url);
    if (after !== before) fs.writeFileSync(absolutePath, after);
  }
  console.log(`[generate-og-image] the card's URL is now ${url}`);
}
