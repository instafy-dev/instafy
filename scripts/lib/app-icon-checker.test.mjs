import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

import {
  compareToFullBleedReference,
  findIconLinks,
  FULL_BLEED_MARGIN,
  FULL_BLEED_REFERENCE_TOLERANCE,
  fullBleedFit,
  octoInkBox,
  octoNodeCenters,
  rasterizeFullBleedCoverage,
} from "./app-icon-checker.mjs";
import {
  androidNightDirectory,
  createCrewNodeTargets,
  createCrewTokenContracts,
  DESKTOP_ICNS_CONTRACTS,
  DESKTOP_ICO_CONTRACTS,
  expectedTileInk,
  FAVICON_ENTRY_CONTRACTS,
  PNG_FAVICON_TARGET,
  STALE_ASSET_PATHS,
  IOS_APP_ICON_IMAGES,
  IOS_SPLASH_IMAGES,
  macGridBody,
  PNG_ASSET_CONTRACTS,
} from "./app-icon-contracts.mjs";
import { decodeIcnsArgb, decodeIcnsEntries, decodeIcoEntries } from "./icon-containers.mjs";
import {
  countNonGreyscalePixels,
  countOffInkVisiblePixels,
  countOffPalettePixels,
  countVisiblePixelsOutside,
  decodePng,
  measureInkBounds,
  measureInkRadius,
  pixelAt,
} from "./png-ink-bounds.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const NAVY = [15, 23, 42];
const WHITE = [255, 255, 255];
const PINK = [255, 60, 159];
const VIOLET = [166, 114, 250];

/** A width x height RGBA image filled with `fill`, plus a pixel setter. */
function image(width, height, fill) {
  const pixels = Buffer.alloc(width * height * 4);
  for (let offset = 0; offset < pixels.length; offset += 4) pixels.set(fill, offset);
  return {
    width,
    height,
    pixels,
    set(x, y, rgba) {
      pixels.set(rgba, (y * width + x) * 4);
      return this;
    },
  };
}

function blend(background, ink, coverage) {
  return background.map((channel, index) => Math.round(channel + (ink[index] - channel) * coverage));
}

test("one-ink bounds drop crew-colored nodes, multi-ink bounds keep them", () => {
  // A white body at x 3..5 with a pink node out at x 0 and a violet one at x 8.
  const tile = image(10, 4, [...NAVY, 255]);
  for (let x = 3; x <= 5; x += 1) tile.set(x, 1, [...WHITE, 255]);
  tile.set(0, 3, [...PINK, 255]).set(8, 2, [...VIOLET, 255]);

  const bodyOnly = measureInkBounds(tile, { ink: WHITE, background: NAVY });
  assert.deepEqual([bodyOnly.minX, bodyOnly.maxX, bodyOnly.minY, bodyOnly.maxY], [3, 5, 1, 1]);

  const crew = measureInkBounds(tile, { inks: [WHITE, PINK, VIOLET], background: NAVY });
  assert.deepEqual([crew.minX, crew.maxX, crew.minY, crew.maxY], [0, 8, 1, 3]);
});

test("an antialiased crew edge counts from half coverage", () => {
  const tile = image(4, 1, [...NAVY, 255])
    .set(1, 0, [...blend(NAVY, PINK, 0.6), 255])
    .set(2, 0, [...blend(NAVY, PINK, 0.4), 255]);
  const bounds = measureInkBounds(tile, { inks: [WHITE, PINK], background: NAVY });
  assert.equal(bounds.minX, 1);
  assert.equal(bounds.maxX, 1);
});

test("transparent artwork is judged over the given background", () => {
  const badge = image(3, 1, [0, 0, 0, 0]).set(1, 0, [...WHITE, 128]);
  const bounds = measureInkBounds(badge, { ink: WHITE, background: NAVY });
  assert.equal(bounds.minX, 1);
  assert.equal(countOffPalettePixels(badge, { inks: [WHITE], background: NAVY }), 0);
});

test("off-palette counting flags crew color on a one-ink asset only", () => {
  const tile = image(5, 1, [...NAVY, 255])
    .set(0, 0, [...WHITE, 255])
    .set(1, 0, [...blend(NAVY, WHITE, 0.3), 255])
    .set(3, 0, [...PINK, 255])
    .set(4, 0, [...blend(NAVY, PINK, 0.5), 255]);
  assert.equal(countOffPalettePixels(tile, { inks: [WHITE], background: NAVY }), 2);
  assert.equal(countOffPalettePixels(tile, { inks: [WHITE, PINK], background: NAVY }), 0);
});

test("decodePng reads an 8-bit RGBA PNG and pixelAt bounds-checks", () => {
  const raw = Buffer.from([0, ...PINK, 255, ...NAVY, 128]);
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    return Buffer.concat([length, Buffer.from(type, "ascii"), data, Buffer.alloc(4)]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(2, 0);
  header.writeUInt32BE(1, 4);
  header.set([8, 6, 0, 0, 0], 8);
  const png = Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    chunk("IHDR", header),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
  const decoded = decodePng(png);
  assert.deepEqual(pixelAt(decoded, 0, 0), [...PINK, 255]);
  assert.deepEqual(pixelAt(decoded, 1, 0), [...NAVY, 128]);
  assert.throws(() => pixelAt(decoded, 2, 0), RangeError);
});

test("node centers follow crew slots left to right through the transforms", () => {
  const geometry = {
    transform: "translate(-1.3 -1.7)",
    circles: [
      { cx: 54.34, cy: 46.39, r: 3.5 },
      { cx: 12.25, cy: 52.36, r: 3.5 },
      { cx: 42.07, cy: 50.39, r: 3.5 },
      { cx: 23.71, cy: 56.36, r: 3.5 },
    ],
  };
  const centers = octoNodeCenters(geometry, { distributionScale: 0.85 });
  assert.deepEqual(
    centers.map(({ x }) => Number(x.toFixed(4))),
    [14.1075, 23.8485, 39.4545, 49.884],
  );
  assert.equal(Number(centers[0].y.toFixed(4)), 47.861);
  assert.equal(Number(centers[0].r.toFixed(4)), 2.975);

  const untransformed = octoNodeCenters({ transform: "", circles: [{ cx: 8, cy: 52, r: 4 }] });
  assert.deepEqual(untransformed, [{ x: 8, y: 52, r: 4 }]);
  assert.throws(() => octoNodeCenters({ transform: "rotate(5)", circles: [] }), /unsupported/);
});

test("the shipped geometry and brand config keep the crew contracts consistent", () => {
  const brand = JSON.parse(fs.readFileSync(path.join(repoRoot, "scripts/app-icon-brand.json"), "utf8"));
  const geometry = JSON.parse(
    fs.readFileSync(path.join(repoRoot, "packages/frontend/src/assets/octo-mark.geometry.json"), "utf8"),
  );

  // Every crew asset is at least the crew threshold, and each node is wide
  // enough there for its center pixel to be solid color.
  const nodeRadius = Math.min(
    ...octoNodeCenters(geometry, { distributionScale: brand.distributionScale }).map(({ r }) => r),
  );
  for (const { relativePath, placement } of createCrewNodeTargets(
    { crewLight: [], crewDark: [] },
    { distributionScale: brand.distributionScale, maskableScale: brand.maskableScale },
  )) {
    assert.ok(placement.side >= brand.crewTileMinPx, `${relativePath} is below the crew threshold`);
    assert.ok((nodeRadius / 64) * placement.side > Math.SQRT2, `${relativePath} nodes are too small`);
  }

  // Full-bleed, the main cut's ink box is 56 of 64 units tall, which is what
  // the favicon and full-bleed desktop contracts expect.
  const box = octoInkBox(geometry);
  const fit = fullBleedFit(geometry);
  assert.equal(Number((fit.scale * box.height).toFixed(6)), 64 - 2 * FULL_BLEED_MARGIN);
  for (const { size, fit: entryFit, expectedInk } of FAVICON_ENTRY_CONTRACTS) {
    if (entryFit !== "full-bleed") continue;
    assert.ok(Math.abs(expectedInk.height - (56 / 64) * size) < 1e-9, `${size}px height`);
    assert.ok(
      Math.abs(expectedInk.width - ((fit.scale * box.width) / 64) * size) < 0.01 * size,
      `${size}px width`,
    );
  }
  assert.deepEqual(
    [PNG_FAVICON_TARGET.expectedInk.width, PNG_FAVICON_TARGET.expectedInk.height],
    [expectedTileInk(32, "full-bleed").width, expectedTileInk(32, "full-bleed").height],
  );

  // Dark-mode overrides are emitted only for the lifted slots (green, violet).
  assert.deepEqual(
    createCrewTokenContracts(brand.colors.crew).filter(([selector]) => selector === ".dark"),
    [
      [".dark", "--crew-2", brand.colors.crew.dark[1]],
      [".dark", "--crew-4", brand.colors.crew.dark[3]],
    ],
  );
});

test("the full-bleed fit scales the main cut's own ink box to 56 units tall and centers it", () => {
  const geometry = JSON.parse(
    fs.readFileSync(path.join(repoRoot, "packages/frontend/src/assets/octo-mark.geometry.json"), "utf8"),
  );
  // The nodes are the left, right and bottom extremes; the dome is the top.
  const box = octoInkBox(geometry);
  assert.deepEqual(
    [box.minX, box.maxX, box.minY, box.maxY].map((value) => Number(value.toFixed(2))),
    [8.75, 57.84, 8, 59.86],
  );
  // Curve bounds, not control points: a hump whose control points rise to
  // y = 0 only reaches y = 1.
  const hump = octoInkBox({ paths: ["M0 4 C0 0 4 0 4 4 Z"], circles: [] });
  assert.deepEqual([hump.minX, hump.maxX, hump.minY, hump.maxY], [0, 4, 1, 4]);
  assert.throws(() => octoInkBox({ paths: ["M0 0 Q1 1 2 2"], circles: [] }), /unsupported/);

  const fit = fullBleedFit(geometry);
  const top = fit.y + fit.scale * box.minY;
  const bottom = fit.y + fit.scale * box.maxY;
  const left = fit.x + fit.scale * box.minX;
  const right = fit.x + fit.scale * box.maxX;
  assert.ok(Math.abs(top - FULL_BLEED_MARGIN) < 1e-9 && Math.abs(64 - bottom - FULL_BLEED_MARGIN) < 1e-9);
  assert.ok(Math.abs(left - (64 - right)) < 1e-9, "centered horizontally");
  assert.ok(right - left < 56, "the height is the longer side");
  // The nodes keep their order and the same lean, just larger.
  const centers = octoNodeCenters(geometry, { fullBleed: true });
  assert.deepEqual(
    centers.map(({ x }) => Math.round(x)),
    [...geometry.circles].sort((a, b) => a.cx - b.cx).map(({ cx }) => Math.round(fit.x + fit.scale * cx)),
  );
  assert.ok(centers.every(({ r }) => Math.abs(r - 3.5 * fit.scale) < 1e-9));
});

test("the full-bleed reference raster fills the fitted shape and nothing else", () => {
  // A 10-unit square fits full-bleed as a 56-unit square at 4..60; at 64 px a
  // unit is a pixel, so the raster is exactly that square.
  const square = { paths: ["M0 0 L10 0 L10 10 L0 10 Z"], circles: [] };
  const coverage = rasterizeFullBleedCoverage(square, 64);
  assert.equal(Math.round(coverage.reduce((sum, value) => sum + value, 0)), 56 * 56);
  assert.equal(coverage[3 * 64 + 3], 0);
  assert.equal(coverage[4 * 64 + 4], 1);
  assert.equal(coverage[59 * 64 + 59], 1);
  assert.equal(coverage[60 * 64 + 60], 0);
  // A node is a disc: about pi r^2 of a 56-unit (diameter) circle.
  const disc = rasterizeFullBleedCoverage({ paths: [], circles: [{ cx: 0, cy: 0, r: 1 }] }, 64);
  const area = disc.reduce((sum, value) => sum + value, 0);
  assert.ok(Math.abs(area - Math.PI * 28 * 28) < 2, `disc area ${area}`);
});

/**
 * The retired small cut as origin/main (38dd2188) shipped it in icon.ico's 16
 * and 24 px entries: each pixel's coverage from brand ink to paper, 0-255, row
 * by row. It fills nearly the same ink box as the main cut full-bleed, so only
 * a per-pixel comparison tells them apart.
 */
const RETIRED_SMALL_CUT_ICO = {
  16: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAIa/09K8hAAAAAAAAAAAAE+b/////5hMAAAAAAAAAAID///////9+AAAAAAAAABTk////////3A8AAAAAAAC3///////////HCQAAAABD/7y8/5mZ/8SB/IgAAAAAouwSlf0dBtDHAGzqAAAAAOCBAMa8AABJ+gEH4QEAAAH9LgDragAABuECAAAAAAAB4QQC/ikAAAAAAAD//wAAAAAAAeEDAAAA//8A//8AAP//AAAAAAAAAP//AAAAAAD//wD//wAAAAAAAAAAAAAAAAAA//8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==",
  24: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB014eE0HAAAAAAAAAAAAAAAAAAAAAABL5v/////mSwAAAAAAAAAAAAAAAAAAAEv8/////////EsAAAAAAAAAAAAAAAAACeb//////////+YJAAAAAAAAAAAAAAAAVf////////////9VAAAAAAAAAAAAAAACwv////////////+wAAAAAAAAAAAAAACJ////////////////hAAAAAAAAAAAAD/+/////////////////3MAAAAAAAAAAMj//aj3//+SnP///YjY//suAAAAAAAANP//eQC//+wJA8L/8QQLt/+oAAAAAAAAhv/TAwDs/44AACD0/z8ADebvAAAAAAAAxP9aAB7//zAAAACG/3QAAI/+AgAAAAAA7fIJAEf/2QAAAAAp/4cAACFeAAAAAAAD/7QAAGj/jAAAAAAB3GAAAAAAAAAAAAAD/ocAAH7/SwAAAAAAAAAAACPb2yMAAAAAXiAAAIb/GgAAAAAAI3MjAHP//3MAAAAAAAAAAGDcAQAAAAAA2//bACPb2yMAACPb2yMAAAAAAAAAAAAA2//bAAAAAAAAAHP//3MAI3MjAAAAAAAAI3MjAAAAAAAAACPb2yMA2//bAAAAAAAAAAAAAAAAAAAAAAAAAAAA2//bAAAAAAAAAAAAAAAAAAAAAAAAAAAAI3MjAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
};

test("full-bleed rasters must be the main cut: the retired small cut and a shifted mark fail", () => {
  const geometry = JSON.parse(
    fs.readFileSync(path.join(repoRoot, "packages/frontend/src/assets/octo-mark.geometry.json"), "utf8"),
  );
  const { meanError, maxError } = FULL_BLEED_REFERENCE_TOLERANCE;
  const within = ({ meanError: mean, maxError: max }) => mean <= meanError && max <= maxError;
  const tile = (side, coverageAt) => {
    const tileImage = image(side, side, [...NAVY, 255]);
    for (let y = 0; y < side; y += 1) {
      for (let x = 0; x < side; x += 1) tileImage.set(x, y, [...blend(NAVY, WHITE, coverageAt(x, y)), 255]);
    }
    return tileImage;
  };
  const compare = (tileImage) =>
    compareToFullBleedReference(tileImage, {
      placement: { x: 0, y: 0, side: tileImage.width },
      geometry,
      ink: WHITE,
      background: NAVY,
    });

  for (const side of [16, 24]) {
    const reference = rasterizeFullBleedCoverage(geometry, side);
    const at = (x, y) => (x >= 0 && y >= 0 && x < side && y < side ? reference[y * side + x] : 0);
    assert.ok(within(compare(tile(side, at))), `${side}px reference`);
    // One pixel off center is not the same drawing.
    assert.ok(!within(compare(tile(side, (x, y) => at(x - 1, y)))), `${side}px shifted right`);
    assert.ok(!within(compare(tile(side, (x, y) => at(x, y - 1)))), `${side}px shifted down`);

    const retired = Buffer.from(RETIRED_SMALL_CUT_ICO[side], "base64");
    assert.equal(retired.length, side * side);
    const result = compare(tile(side, (x, y) => retired[y * side + x] / 255));
    assert.ok(result.meanError > meanError, `${side}px small cut mean ${result.meanError}`);
    assert.ok(result.maxError > maxError, `${side}px small cut max ${result.maxError}`);
  }

  // The shipped full-bleed entries pass.
  const shipped = [
    ...decodeIcoEntries(fs.readFileSync(path.join(repoRoot, "packages/desktop-app/assets/icon.ico"))),
    ...decodeIcoEntries(fs.readFileSync(path.join(repoRoot, "packages/frontend/public/favicon.ico"))),
  ].filter(({ size }) => size <= 24);
  assert.equal(shipped.length, 3);
  for (const { size, image: entry } of shipped) {
    assert.ok(within(compare(entry)), `shipped ${size}px entry`);
  }
});

test("the retired small cut stays deleted", () => {
  assert.ok(STALE_ASSET_PATHS.includes("packages/frontend/src/assets/octo-mark-small.geometry.json"));
  assert.ok(
    !fs.existsSync(path.join(repoRoot, "packages/frontend/src/assets/octo-mark-small.geometry.json")),
  );
});

test("every rel token 'icon' is a favicon candidate, in any attribute order", () => {
  const html = `
    <link rel="icon" type="image/svg+xml" href="/icon.svg?v=5" />
    <link type="image/png" rel="icon" href="/icon-192.png?v=5" />
    <link rel="shortcut icon" href='/legacy.ico'>
    <LINK REL="Alternate Icon" HREF=/alt.png>
    <link rel="apple-touch-icon" href="/apple-touch-icon.png?v=5" />
    <link rel="mask-icon" href="/mask.svg" />
    <link rel="manifest" href="/manifest.webmanifest?v=5" />`;
  assert.deepEqual(
    findIconLinks(html).map(({ href }) => href),
    ["/icon.svg", "/icon-192.png", "/legacy.ico", "/alt.png"],
  );
});

test("ICO entries decode as embedded PNG or bottom-up 32-bit DIB with straight alpha", () => {
  // A 2x2 DIB: bottom row first (pink, navy), then the top row (white, clear).
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(2, 4);
  header.writeInt32LE(4, 8);
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  const bgra = ([r, g, b], a) => [b, g, r, a];
  const xor = Buffer.from([
    ...bgra(PINK, 255),
    ...bgra(NAVY, 255),
    ...bgra(WHITE, 255),
    ...bgra([0, 0, 0], 0),
  ]);
  const and = Buffer.from([0, 0, 0, 0, 0x40, 0, 0, 0]);
  const dib = Buffer.concat([header, xor, and]);
  const directory = Buffer.alloc(22);
  directory.writeUInt16LE(1, 2);
  directory.writeUInt16LE(1, 4);
  directory.set([2, 2, 0, 0], 6);
  directory.writeUInt16LE(1, 10);
  directory.writeUInt16LE(32, 12);
  directory.writeUInt32LE(dib.length, 14);
  directory.writeUInt32LE(22, 18);
  const [entry] = decodeIcoEntries(Buffer.concat([directory, dib]));
  assert.equal(entry.format, "bmp");
  assert.equal(entry.size, 2);
  assert.deepEqual(pixelAt(entry.image, 0, 0), [...WHITE, 255]);
  assert.deepEqual(pixelAt(entry.image, 1, 0), [0, 0, 0, 0]);
  assert.deepEqual(pixelAt(entry.image, 0, 1), [...PINK, 255]);
  assert.deepEqual(pixelAt(entry.image, 1, 1), [...NAVY, 255]);
});

test("ICNS ARGB planes decode through literal and repeat runs", () => {
  // 16x16 = 256 bytes per plane: alpha all 255, red all 15, green all 23,
  // blue 42 except a literal 7 in the first pixel.
  const repeat = (value, count) => {
    const runs = [];
    for (let left = count; left > 0; ) {
      const run = Math.min(130, left);
      runs.push(0x80 + run - 3, value);
      left -= run;
    }
    return runs;
  };
  const compressed = Buffer.from([
    ...repeat(255, 256),
    ...repeat(15, 256),
    ...repeat(23, 256),
    0x00,
    7,
    ...repeat(42, 255),
  ]);
  const image = decodeIcnsArgb(compressed, 16);
  assert.deepEqual(pixelAt(image, 0, 0), [15, 23, 7, 255]);
  assert.deepEqual(pixelAt(image, 15, 15), [...NAVY, 255]);
  assert.throws(() => decodeIcnsArgb(compressed.subarray(0, 10), 16), /truncated/);

  const element = (type, data) => {
    const head = Buffer.alloc(8);
    head.write(type, 0, "ascii");
    head.writeUInt32BE(8 + data.length, 4);
    return Buffer.concat([head, data]);
  };
  const body = Buffer.concat([
    element("ic04", Buffer.concat([Buffer.from("ARGB"), compressed])),
    element("info", Buffer.from("bplist")),
  ]);
  const file = Buffer.concat([element("icns", Buffer.alloc(0)), body]);
  file.writeUInt32BE(file.length, 4);
  const entries = decodeIcnsEntries(file);
  assert.deepEqual(
    entries.map(({ type, image: decoded }) => [type, decoded.width]),
    [["ic04", 16]],
  );
  const stray = Buffer.concat([file, element("is32", Buffer.alloc(4))]);
  stray.writeUInt32BE(stray.length, 4);
  assert.throws(() => decodeIcnsEntries(stray), /unexpected ICNS element is32/);
});

test("ink radius counts any visible pixel, faint edges included", () => {
  const tile = image(10, 10, [...NAVY, 255])
    .set(5, 5, [...WHITE, 255])
    .set(9, 5, [...blend(NAVY, PINK, 0.2), 255])
    .set(0, 0, [...blend(NAVY, WHITE, 0.03), 255]);
  // The 20% pink edge at (9, 5) counts; the 3% white tint in the corner does not.
  assert.equal(measureInkRadius(tile, { background: NAVY }), Math.hypot(4.5, 0.5));
});

test("the maskable scale keeps every node inside the W3C safe circle", () => {
  const brand = JSON.parse(fs.readFileSync(path.join(repoRoot, "scripts/app-icon-brand.json"), "utf8"));
  const geometry = JSON.parse(
    fs.readFileSync(path.join(repoRoot, "packages/frontend/src/assets/octo-mark.geometry.json"), "utf8"),
  );
  // Nodes are the mark's outermost ink. Measured on the 64-unit canvas, whose
  // center is the tile's center, the safe circle's radius is 0.4 x 64 units.
  const reach = (scale) =>
    Math.max(
      ...octoNodeCenters(geometry, { distributionScale: scale }).map(
        ({ x, y, r }) => Math.hypot(x - 32, y - 32) + r,
      ),
    );
  assert.ok(reach(brand.distributionScale) > 0.4 * 64, "the 0.85 tile is expected to cross it");
  assert.ok(reach(brand.maskableScale) <= 0.39 * 64, "maskable nodes must clear the safe circle");
});

test("desktop representations take crew only from the crew threshold, full-bleed only at 32 px or less", () => {
  const brand = JSON.parse(fs.readFileSync(path.join(repoRoot, "scripts/app-icon-brand.json"), "utf8"));
  const fits = new Set(["full-bleed", "distribution"]);
  for (const { side, fit, crew, grid } of [...DESKTOP_ICNS_CONTRACTS, ...DESKTOP_ICO_CONTRACTS]) {
    assert.ok(fits.has(fit), `${side}px fit ${fit}`);
    // On the macOS grid the tile is the body, so the threshold applies to it.
    const tile = grid ? macGridBody(side).body : side;
    assert.equal(crew, fit === "distribution" && tile >= brand.crewTileMinPx, `${side}px ${fit}`);
    if (fit === "full-bleed") assert.ok(side <= 32, `${side}px full-bleed`);
  }
  // Every 16 px representation, desktop and favicon, draws the mark full-bleed.
  assert.ok(
    [...DESKTOP_ICNS_CONTRACTS, ...DESKTOP_ICO_CONTRACTS]
      .filter(({ side }) => side === 16)
      .every(({ fit }) => fit === "full-bleed"),
  );
  assert.equal(FAVICON_ENTRY_CONTRACTS.find(({ size }) => size === 16).fit, "full-bleed");
  for (const { size, fit } of FAVICON_ENTRY_CONTRACTS) {
    assert.ok(fits.has(fit), `${size}px favicon fit ${fit}`);
    if (fit === "full-bleed") assert.ok(size <= 32, `${size}px favicon full-bleed`);
  }
});

test("the macOS grid body matches Apple's own icons at every icns slot", () => {
  // Measured from Calculator.app and App Store.app on macOS 26 (opaque body
  // box per slot): Apple rounds the 100/1024 margin half away from zero.
  const apple = { 16: 12, 32: 26, 64: 52, 128: 102, 256: 206, 512: 412, 1024: 824 };
  for (const [side, body] of Object.entries(apple)) {
    assert.equal(macGridBody(Number(side)).body, body, `${side}px slot`);
    assert.equal(macGridBody(Number(side)).inset * 2 + body, Number(side));
  }
  // Every icns representation sits on the grid; Windows and Linux stay full-bleed.
  assert.ok(DESKTOP_ICNS_CONTRACTS.every(({ grid }) => grid === true));
  assert.ok(DESKTOP_ICO_CONTRACTS.every(({ grid }) => !grid));
});

test("night splash directories keep Android's qualifier order", () => {
  assert.equal(androidNightDirectory("drawable"), "drawable-night");
  // Orientation ranks above night mode, density below it.
  assert.equal(androidNightDirectory("drawable-land-hdpi"), "drawable-land-night-hdpi");
  assert.equal(androidNightDirectory("drawable-port-xxxhdpi"), "drawable-port-night-xxxhdpi");
  const night = PNG_ASSET_CONTRACTS.map(([relativePath]) => relativePath).filter((relativePath) =>
    relativePath.includes("-night"),
  );
  // One reverse splash for every positive splash (drawable plus five land and five port).
  assert.equal(night.length, 11);
  assert.ok(night.every((relativePath) => /\/drawable(-(land|port))?-night(-[a-z]+dpi)?\/splash\.png$/.test(relativePath)));
});

test("iOS catalogs register every appearance the generator writes", () => {
  const appearanceOf = ({ appearances }) => appearances?.[0]?.value ?? "any";
  for (const size of ["20x20", "1024x1024"]) {
    assert.deepEqual(
      IOS_APP_ICON_IMAGES.filter((image) => image.size === size).map(appearanceOf),
      ["any", "dark", "tinted"],
      size,
    );
  }
  for (const scale of ["1x", "2x", "3x"]) {
    assert.deepEqual(
      IOS_SPLASH_IMAGES.filter((image) => image.scale === scale).map(appearanceOf),
      ["any", "dark"],
      scale,
    );
  }
});

test("greyscale, transparent-ground and margin counts", () => {
  const grey = image(3, 1, [0, 0, 0, 255]).set(1, 0, [128, 128, 128, 255]);
  assert.equal(countNonGreyscalePixels(grey), 0);
  grey.set(2, 0, [...PINK, 255]);
  assert.equal(countNonGreyscalePixels(grey), 1);

  // A white body and a pink node on alpha, with a faint rounded edge pixel.
  const dark = image(4, 1, [0, 0, 0, 0])
    .set(0, 0, [...WHITE, 255])
    .set(1, 0, [...PINK, 200])
    .set(2, 0, [3, 9, 70, 10]);
  assert.equal(countOffInkVisiblePixels(dark, { inks: [WHITE, PINK] }), 0);
  // A painted ground (brand ink) is not part of the mark.
  dark.set(3, 0, [...NAVY, 255]);
  assert.equal(countOffInkVisiblePixels(dark, { inks: [WHITE, PINK] }), 1);

  const tile = image(4, 4, [0, 0, 0, 0]).set(1, 1, [...NAVY, 255]).set(2, 2, [...NAVY, 255]);
  assert.equal(countVisiblePixelsOutside(tile, { x0: 1, y0: 1, x1: 3, y1: 3 }), 0);
  tile.set(0, 3, [...NAVY, 1]);
  assert.equal(countVisiblePixelsOutside(tile, { x0: 1, y0: 1, x1: 3, y1: 3 }), 1);
});
