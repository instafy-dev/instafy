#!/usr/bin/env node
// Regenerates the landing layout the Cub geometry tests run on
// (src/screens/landing/cub/__tests__/fixtures/landingLayout.json) from the real
// landing page. Run it whenever the hero, the example window, its top bar or
// the roster move, against a running dev server of this package:
//
//   pnpm dev                       # or any `vite` dev server for packages/frontend
//   node scripts/capture-cub-landing-layout.mjs [http://127.0.0.1:5173]
//   node scripts/capture-cub-landing-layout.mjs --check [http://127.0.0.1:5173]
//
// At each width it opens the landing with reduced motion (the first scenario,
// finished, nothing in motion), measures Cub's anchors with the page's own
// measureLandingAnchors (served by the dev server) and records the perch the
// engine chose. --check writes nothing: it fails when any anchor of the live
// page has drifted more than 2 px from the fixture, or a perch changed.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, "../src/screens/landing/cub/__tests__/fixtures/landingLayout.json");
const args = process.argv.slice(2);
const check = args.includes("--check");
const base = (args.find((arg) => !arg.startsWith("--")) || "http://127.0.0.1:5173").replace(/\/$/, "");

const LANDING_LAYOUT_SIZES = [
  [1440, 900],
  [1280, 800],
  // A mid-width corner, where the page margin beside the corner is the
  // approved hero's 40 px gutter (the corner drape hangs in it).
  [1120, 800],
  [1024, 768],
  [820, 900],
  [390, 844],
];

const browser = await chromium.launch();
const layouts = {};
try {
  for (const [width, height] of LANDING_LAYOUT_SIZES) {
    const mobile = width < 768;
    const context = await browser.newContext({
      viewport: { width, height },
      deviceScaleFactor: 2,
      isMobile: mobile,
      hasTouch: mobile,
      reducedMotion: "reduce",
      colorScheme: "light",
    });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${base}/?cub-dev=0`, { waitUntil: "networkidle" });
    await page.evaluate(() => document.fonts.ready);
    await page.waitForFunction(() => window.__cub && document.querySelector("[data-cub-gl]"), null, { timeout: 30_000 });
    await page.waitForTimeout(300);
    const anchors = await page.evaluate(async () => {
      const { measureLandingAnchors } = await import("/src/screens/landing/cub/landingCub.ts");
      const hero = document.querySelector('[data-testid="landing-hero"]');
      const layer = document.querySelector('[data-testid="landing-cub-layer"]');
      const a = measureLandingAnchors(hero, layer);
      const r = layer.getBoundingClientRect();
      const round = (value) => (typeof value === "number" ? Math.round(value * 100) / 100 : value);
      const walk = (value) =>
        Array.isArray(value)
          ? value.map(walk)
          : value && typeof value === "object"
            ? Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, walk(entry)]))
            : round(value);
      return walk({ ...a, width: r.width, height: r.height });
    });
    const mode = await page.evaluate(() => window.__cub.getState().mode);
    if (errors.length) throw new Error(`${width}px: ${errors.join("; ")}`);
    layouts[`${width}x${height}`] = { dpr: 2, mode, anchors };
    console.log(`${width}x${height}: ${mode}`);
    await context.close();
  }
} finally {
  await browser.close();
}

if (check) {
  const fixture = JSON.parse(readFileSync(out, "utf8"));
  const drift = [];
  const compare = (path, a, b) => {
    if (typeof a === "number" && typeof b === "number") {
      if (Math.abs(a - b) > 2) drift.push(`${path}: ${b} in the fixture, ${a} on the page`);
    } else if (Array.isArray(a) && Array.isArray(b)) {
      if (a.length !== b.length) drift.push(`${path}: ${b.length} entries in the fixture, ${a.length} on the page`);
      else a.forEach((entry, index) => compare(`${path}[${index}]`, entry, b[index]));
    } else if (a && b && typeof a === "object" && typeof b === "object") {
      for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) compare(`${path}.${key}`, a[key], b[key]);
    } else if (a !== b) drift.push(`${path}: ${JSON.stringify(b)} in the fixture, ${JSON.stringify(a)} on the page`);
  };
  for (const [size, layout] of Object.entries(layouts)) compare(size, layout, fixture[size]);
  if (drift.length) {
    console.error(`The landing layout drifted from the fixture; rerun without --check:\n  ${drift.slice(0, 40).join("\n  ")}`);
    process.exit(1);
  }
  console.log("The fixture matches the page.");
} else {
  writeFileSync(out, `${JSON.stringify(layouts, null, 1)}\n`);
  console.log(`wrote ${out}`);
}
