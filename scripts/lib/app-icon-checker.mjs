import fs from "node:fs";
import path from "node:path";

import { decodeIcoEntries } from "./icon-containers.mjs";
import {
  countOffPalettePixels,
  decodePng,
  measureInkBounds,
  measureInkRadius,
  pixelAt,
} from "./png-ink-bounds.mjs";

const CANVAS_UNITS = 64;

export function createAppIconChecker({ repoRoot, failures }) {
  const decodedImages = new Map();

  function resolve(relativePath) {
    return path.join(repoRoot, relativePath);
  }

  /** Decode a PNG once per run; the checker samples some files many times. */
  function readImage(relativePath) {
    if (!decodedImages.has(relativePath)) {
      decodedImages.set(relativePath, decodePng(fs.readFileSync(resolve(relativePath))));
    }
    return decodedImages.get(relativePath);
  }

  /**
   * Decode an icon container (ICO or ICNS) with `decode`, reporting an
   * unreadable or malformed file as a failure and returning no entries.
   */
  function readIconContainer(relativePath, decode) {
    try {
      return decode(fs.readFileSync(resolve(relativePath)));
    } catch (error) {
      failures.push(
        `Unable to decode ${relativePath}: ${error instanceof Error ? error.message : error}`,
      );
      return [];
    }
  }

  /** Decode every entry of an ICO file (embedded PNG or 32-bit DIB). */
  function readIcoEntries(relativePath) {
    return readIconContainer(relativePath, decodeIcoEntries);
  }

  function readPng(relativePath) {
    const absolutePath = resolve(relativePath);
    let contents;
    try {
      contents = fs.readFileSync(absolutePath);
    } catch (error) {
      failures.push(`Unable to read ${relativePath}: ${error instanceof Error ? error.message : error}`);
      return null;
    }

    const signature = "89504e470d0a1a0a";
    if (contents.length < 26 || contents.subarray(0, 8).toString("hex") !== signature) {
      failures.push(`${relativePath} is not a valid PNG.`);
      return null;
    }

    const width = contents.readUInt32BE(16);
    const height = contents.readUInt32BE(20);
    const bitDepth = contents[24];
    const colorType = contents[25];
    return { width, height, bitDepth, colorType, hasAlpha: colorType === 4 || colorType === 6 };
  }

  function checkFavicon(relativePath, expectedSizes) {
    let contents;
    try {
      contents = fs.readFileSync(resolve(relativePath));
    } catch (error) {
      failures.push(`Unable to read ${relativePath}: ${error instanceof Error ? error.message : error}`);
      return;
    }
    if (contents.length < 6 || contents.readUInt16LE(0) !== 0 || contents.readUInt16LE(2) !== 1) {
      failures.push(`${relativePath} is not a valid ICO file.`);
      return;
    }
    const count = contents.readUInt16LE(4);
    const sizes = [];
    for (let index = 0; index < count; index += 1) {
      const entryOffset = 6 + index * 16;
      if (entryOffset + 16 > contents.length) {
        failures.push(`${relativePath} has a truncated directory.`);
        return;
      }
      sizes.push(contents[entryOffset] || 256);
      if (contents.readUInt16LE(entryOffset + 6) !== 32) {
        failures.push(`${relativePath} entry ${index + 1} must declare 32 bits per pixel.`);
      }
      const payloadSize = contents.readUInt32LE(entryOffset + 8);
      const payloadOffset = contents.readUInt32LE(entryOffset + 12);
      if (
        payloadOffset + payloadSize > contents.length ||
        contents.subarray(payloadOffset, payloadOffset + 8).toString("hex") !== "89504e470d0a1a0a"
      ) {
        failures.push(`${relativePath} entry ${index + 1} must contain an embedded PNG.`);
      } else if (contents[payloadOffset + 24] !== 8 || contents[payloadOffset + 25] !== 6) {
        failures.push(`${relativePath} entry ${index + 1} must contain an 8-bit RGBA PNG.`);
      }
    }
    if (sizes.join(",") !== expectedSizes.join(",")) {
      failures.push(
        `${relativePath} must contain ${expectedSizes.join("/")}px entries; found ${sizes.join("/")}.`,
      );
    }
  }

  function readText(relativePath) {
    try {
      return fs.readFileSync(resolve(relativePath), "utf8");
    } catch (error) {
      failures.push(`Unable to read ${relativePath}: ${error instanceof Error ? error.message : error}`);
      return "";
    }
  }

  function expectContains(content, needle, message) {
    if (!content.includes(needle)) failures.push(message);
  }

  function expectNotContains(content, needle, message) {
    if (content.includes(needle)) failures.push(message);
  }

  function assertCanonicalGeometry(svg, geometry, relativePath) {
    for (const pathData of geometry.paths ?? []) {
      expectContains(svg, `d="${pathData}"`, `${relativePath} is missing a canonical Octo path.`);
    }
    for (const circle of geometry.circles ?? []) {
      expectContains(
        svg,
        `cx="${circle.cx}" cy="${circle.cy}" r="${circle.r}"`,
        `${relativePath} is missing a canonical detached node.`,
      );
    }
  }

  function readInkBounds(relativePath, options) {
    try {
      return measureInkBounds(readImage(relativePath), options);
    } catch (error) {
      failures.push(
        `Unable to inspect optical bounds for ${relativePath}: ${
          error instanceof Error ? error.message : error
        }`,
      );
      return null;
    }
  }

  function assertOpticalBounds({
    relativePath,
    viewport,
    expectedInk,
    safeInsetRatio = 0,
    artworkLabel = "reverse white Octo",
    bounds,
  }) {
    if (!bounds) {
      failures.push(`${relativePath} must contain detectable ${artworkLabel} artwork.`);
      return;
    }

    for (const dimension of ["width", "height"]) {
      const delta = Math.abs(bounds[dimension] - expectedInk[dimension]);
      if (delta > expectedInk.tolerance) {
        failures.push(
          `${relativePath} Octo ink must be approximately ${formatSvgNumber(
            expectedInk.width,
          )}x${formatSvgNumber(expectedInk.height)}px (±${expectedInk.tolerance}); found ${
            bounds.width
          }x${bounds.height}px.`,
        );
        break;
      }
    }

    const viewportMaxX = viewport.x + viewport.width - 1;
    const viewportMaxY = viewport.y + viewport.height - 1;
    if (
      bounds.minX < viewport.x ||
      bounds.minY < viewport.y ||
      bounds.maxX > viewportMaxX ||
      bounds.maxY > viewportMaxY
    ) {
      failures.push(`${relativePath} Octo ink must remain inside its visible icon viewport.`);
    }

    if (safeInsetRatio > 0) {
      const horizontalInset = viewport.width * safeInsetRatio;
      const verticalInset = viewport.height * safeInsetRatio;
      if (
        bounds.minX < viewport.x + horizontalInset ||
        bounds.minY < viewport.y + verticalInset ||
        bounds.maxX > viewportMaxX - horizontalInset ||
        bounds.maxY > viewportMaxY - verticalInset
      ) {
        failures.push(`${relativePath} Octo ink must remain inside its maskable safe zone.`);
      }
    }
  }

  function assertCenteredArtwork({ relativePath, viewport, bounds }) {
    if (!bounds) return;
    const tolerance = Math.max(2, Math.min(viewport.width, viewport.height) * 0.01);
    const expectedCenterX = viewport.x + viewport.width / 2;
    const expectedCenterY = viewport.y + viewport.height / 2;
    if (
      Math.abs(bounds.centerX - expectedCenterX) > tolerance ||
      Math.abs(bounds.centerY - expectedCenterY) > tolerance
    ) {
      failures.push(`${relativePath} Octo artwork must remain optically centered.`);
    }
  }

  function assertPixelColor(relativePath, x, y, expected) {
    let actual;
    try {
      actual = pixelAt(readImage(relativePath), x, y);
    } catch (error) {
      failures.push(
        `Unable to inspect ${relativePath} at ${x},${y}: ${
          error instanceof Error ? error.message : error
        }`,
      );
      return;
    }
    if (actual.some((channel, index) => channel !== expected[index])) {
      failures.push(
        `${relativePath} pixel ${x},${y} must be rgba(${expected.join(",")}); found rgba(${actual.join(",")}).`,
      );
    }
  }

  /**
   * Sample the center pixel of each of the four nodes, left to right, and
   * require the expected node color: the crew slot colors on a crew asset.
   * `placement` is the square the 64-unit drawing is rendered into. Pass
   * `image` for a decoded container entry; otherwise `relativePath` is read.
   */
  function assertNodeColors({
    relativePath,
    image: suppliedImage,
    placement,
    geometry,
    distributionScale,
    nodeColors,
    minimumSide,
    tolerance = 2,
  }) {
    if (minimumSide != null && placement.side < minimumSide) {
      failures.push(
        `${relativePath} draws crew nodes in a ${placement.side}px square; crew needs at least ${minimumSide} device px.`,
      );
    }
    let image;
    let centers;
    try {
      image = suppliedImage ?? readImage(relativePath);
      centers = octoNodeCenters(geometry, { distributionScale });
    } catch (error) {
      failures.push(
        `Unable to inspect ${relativePath} nodes: ${error instanceof Error ? error.message : error}`,
      );
      return;
    }
    centers.forEach((center, slot) => {
      const x = Math.floor(placement.x + (center.x / CANVAS_UNITS) * placement.side);
      const y = Math.floor(placement.y + (center.y / CANVAS_UNITS) * placement.side);
      if (x >= image.width || y >= image.height) {
        failures.push(
          `${relativePath} is ${image.width}x${image.height}; node ${slot + 1} should be at ${x},${y}.`,
        );
        return;
      }
      const actual = pixelAt(image, x, y);
      const expected = nodeColors[slot];
      if (
        actual[3] !== 255 ||
        expected.some((channel, index) => Math.abs(channel - actual[index]) > tolerance)
      ) {
        failures.push(
          `${relativePath} node ${slot + 1} (left to right) at ${x},${y} must be rgb(${expected.join(
            ",",
          )}); found rgba(${actual.join(",")}).`,
        );
      }
    });
  }

  /**
   * Require every pixel to be the background or a blend of it with one of
   * `inks`. With a single ink this proves a one-ink asset: no crew node and no
   * stray hue.
   */
  function assertPalette({ label, image, inks, background, reason }) {
    if (!image) return;
    const offPalette = countOffPalettePixels(image, { inks, background });
    if (offPalette > 0) {
      failures.push(`${label} must be ${reason}; found ${offPalette} off-palette pixels.`);
    }
  }

  /**
   * Require every visible pixel (anything distinguishable from the
   * background) to sit within `radius` of the image center: the W3C maskable
   * safe zone, or Android's adaptive-icon safe zone.
   */
  function assertInkInsideCircle({ label, image, background, radius, zone }) {
    if (!image) return;
    const inkRadius = measureInkRadius(image, { background });
    if (inkRadius > radius) {
      failures.push(
        `${label} ink reaches ${inkRadius.toFixed(1)}px from the center; ${zone} allows ${radius.toFixed(1)}px.`,
      );
    }
  }

  /**
   * At 16 px the small cut is pixel-fitted: each node is one 2 x 2 px grid
   * cell and must be solid ink, not an antialiased grey disc.
   */
  function assertPixelNodes({ label, image, geometry, ink }) {
    if (!image) return;
    const scale = image.width / CANVAS_UNITS;
    for (const [slot, { cx, cy, r }] of [...(geometry.circles ?? [])]
      .sort((a, b) => a.cx - b.cx)
      .entries()) {
      const left = (cx - r) * scale;
      const top = (cy - r) * scale;
      const side = 2 * r * scale;
      if (!Number.isInteger(left) || !Number.isInteger(top) || !Number.isInteger(side)) {
        failures.push(`${label} node ${slot + 1} is not aligned to the pixel grid.`);
        continue;
      }
      for (let y = top; y < top + side; y += 1) {
        for (let x = left; x < left + side; x += 1) {
          const actual = pixelAt(image, x, y);
          if (actual[3] !== 255 || ink.some((channel, index) => channel !== actual[index])) {
            failures.push(
              `${label} node ${slot + 1} must be a solid ${side}x${side}px cell of rgb(${ink.join(
                ",",
              )}); found rgba(${actual.join(",")}) at ${x},${y}.`,
            );
            return;
          }
        }
      }
    }
  }

  /** Require two same-sized PNGs to share their alpha mask (silhouette). */
  function assertMatchingAlpha(relativePath, referencePath, message) {
    let image;
    let reference;
    try {
      image = readImage(relativePath);
      reference = readImage(referencePath);
    } catch (error) {
      failures.push(`Unable to compare ${relativePath} with ${referencePath}: ${error}`);
      return;
    }
    if (image.width !== reference.width || image.height !== reference.height) {
      failures.push(message);
      return;
    }
    for (let offset = 3; offset < image.pixels.length; offset += 4) {
      if (Math.abs(image.pixels[offset] - reference.pixels[offset]) > 1) {
        failures.push(message);
        return;
      }
    }
  }

  function assertMatchingOpticalRatios(reference, target) {
    if (!reference.bounds || !target.bounds) return;
    const ratioTolerance = 0.01;
    const metrics = [
      [
        "width",
        reference.bounds.width / reference.viewport.width,
        target.bounds.width / target.viewport.width,
      ],
      [
        "height",
        reference.bounds.height / reference.viewport.height,
        target.bounds.height / target.viewport.height,
      ],
      [
        "horizontal center",
        (reference.bounds.centerX - reference.viewport.x) / reference.viewport.width,
        (target.bounds.centerX - target.viewport.x) / target.viewport.width,
      ],
      [
        "vertical center",
        (reference.bounds.centerY - reference.viewport.y) / reference.viewport.height,
        (target.bounds.centerY - target.viewport.y) / target.viewport.height,
      ],
    ];
    for (const [label, referenceRatio, targetRatio] of metrics) {
      if (Math.abs(referenceRatio - targetRatio) > ratioTolerance) {
        failures.push(
          `${target.relativePath} ${label} must optically align with ${reference.relativePath}.`,
        );
      }
    }
  }

  function assertAssetRevision(relativePath, content, assetPaths, expectedRevision) {
    for (const assetPath of assetPaths) {
      expectContains(
        content,
        `${assetPath}?v=${expectedRevision}`,
        `${relativePath} must reference ${assetPath} at brand revision v${expectedRevision}.`,
      );
    }
    for (const match of content.matchAll(/\?v=(\d+)/g)) {
      if (match[1] !== expectedRevision) {
        failures.push(
          `${relativePath} contains stale asset revision v${match[1]}; expected v${expectedRevision}.`,
        );
      }
    }
  }

  function parseHexColor(value, label) {
    if (typeof value !== "string" || !/^#[0-9a-f]{6}$/i.test(value)) {
      failures.push(`${label} must be a six-digit hex color.`);
      return [0, 0, 0];
    }
    return [1, 3, 5].map((offset) => Number.parseInt(value.slice(offset, offset + 2), 16));
  }

  return {
    assertAssetRevision,
    assertCanonicalGeometry,
    assertCenteredArtwork,
    assertInkInsideCircle,
    assertMatchingAlpha,
    assertMatchingOpticalRatios,
    assertNodeColors,
    assertOpticalBounds,
    assertPalette,
    assertPixelColor,
    assertPixelNodes,
    checkFavicon,
    expectContains,
    expectNotContains,
    parseHexColor,
    readIconContainer,
    readIcoEntries,
    readImage,
    readInkBounds,
    readPng,
    readText,
    resolve,
  };
}

/**
 * Every `<link>` in `html` whose rel tokens include "icon" (rel="icon",
 * "shortcut icon", "alternate icon", in any attribute order), with its href
 * minus any query string. These are the files a browser may pick as the tab
 * icon; apple-touch-icon and mask-icon are other tokens and are not included.
 */
export function findIconLinks(html) {
  const links = [];
  for (const [tag] of html.matchAll(/<link\b[^>]*>/gi)) {
    const attributes = new Map();
    for (const match of tag.matchAll(/([^\s=/<>"']+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g)) {
      attributes.set(match[1].toLowerCase(), match[2] ?? match[3] ?? match[4]);
    }
    const rel = (attributes.get("rel") ?? "").toLowerCase().split(/\s+/);
    if (!rel.includes("icon")) continue;
    links.push({ tag, href: (attributes.get("href") ?? "").split(/[?#]/)[0] });
  }
  return links;
}

export function formatSvgNumber(value) {
  return value.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
}

/**
 * The centers of a cut's four nodes on the 64-unit canvas, in crew-slot order
 * (left to right by cx), after the geometry's own translate and, when given,
 * the distribution scale about the canvas center.
 */
export function octoNodeCenters(geometry, { distributionScale = 1 } = {}) {
  const transform = (geometry.transform ?? "").trim();
  let translateX = 0;
  let translateY = 0;
  if (transform) {
    const match = /^translate\((-?[\d.]+)[ ,]+(-?[\d.]+)\)$/.exec(transform);
    if (!match) throw new Error(`unsupported geometry transform "${transform}"`);
    translateX = Number(match[1]);
    translateY = Number(match[2]);
  }
  const offset = (CANVAS_UNITS * (1 - distributionScale)) / 2;
  return [...(geometry.circles ?? [])]
    .sort((a, b) => a.cx - b.cx)
    .map((circle) => ({
      x: offset + distributionScale * (circle.cx + translateX),
      y: offset + distributionScale * (circle.cy + translateY),
      r: distributionScale * circle.r,
    }));
}
