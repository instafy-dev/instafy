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
          )}x${formatSvgNumber(expectedInk.height)}px (±${expectedInk.tolerance}); found ${+bounds.width.toFixed(1)}x${+bounds.height.toFixed(1)}px.`,
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
   * A full-bleed one-ink mark at 32 device px or less: every node must still
   * read as a dot, so the pixel under each node's center (`placement` is the
   * square the 64-unit drawing fills) must be opaque and at least
   * `minimumCoverage` of the way from the background to the ink, never an
   * antialiased speck.
   */
  function assertNodesInked({
    label,
    image,
    placement,
    geometry,
    ink,
    background,
    minimumCoverage = 0.5,
  }) {
    if (!image) return;
    if (image.width < placement.x + placement.side || image.height < placement.y + placement.side) {
      failures.push(
        `${label} is ${image.width}x${image.height}px, too small for its ${placement.side}px mark at ${placement.x},${placement.y}.`,
      );
      return;
    }
    let centers;
    try {
      centers = octoNodeCenters(geometry, { fullBleed: true });
    } catch (error) {
      failures.push(`Unable to inspect ${label} nodes: ${error instanceof Error ? error.message : error}`);
      return;
    }
    // Measure coverage on the channel where ink and background differ most.
    const channel = [0, 1, 2].reduce((best, index) =>
      Math.abs(ink[index] - background[index]) > Math.abs(ink[best] - background[best])
        ? index
        : best,
    );
    centers.forEach((center, slot) => {
      const x = Math.floor(placement.x + (center.x / CANVAS_UNITS) * placement.side);
      const y = Math.floor(placement.y + (center.y / CANVAS_UNITS) * placement.side);
      const actual = pixelAt(image, x, y);
      const coverage =
        (actual[channel] - background[channel]) / (ink[channel] - background[channel]);
      if (actual[3] !== 255 || coverage < minimumCoverage) {
        failures.push(
          `${label} node ${slot + 1} (left to right) must read as ink: its center pixel ${x},${y} is rgba(${actual.join(
            ",",
          )}), ${Math.round(coverage * 100)}% of the way to rgb(${ink.join(",")}); at least ${Math.round(
            minimumCoverage * 100,
          )}% is required.`,
        );
      }
    });
  }

  /**
   * A full-bleed one-ink raster must be the main cut itself: its coverage
   * matches the reference raster (rasterizeFullBleedCoverage) within
   * FULL_BLEED_REFERENCE_TOLERANCE. The ink box and node checks alone cannot
   * tell a redrawn mark of nearly the same box apart at 16 and 24 px.
   */
  function assertMatchesFullBleedReference({ label, image, placement, geometry, ink, background }) {
    if (!image) return;
    let result;
    try {
      result = compareToFullBleedReference(image, { placement, geometry, ink, background });
    } catch (error) {
      failures.push(`Unable to compare ${label}: ${error instanceof Error ? error.message : error}`);
      return;
    }
    const { meanError, maxError } = FULL_BLEED_REFERENCE_TOLERANCE;
    if (result.meanError > meanError || result.maxError > maxError) {
      failures.push(
        `${label} must draw the main cut full-bleed: its ink coverage differs from the reference raster by ${result.meanError.toFixed(
          3,
        )} on average (at most ${meanError}) and ${result.maxError.toFixed(2)} at ${result.worst.x},${
          result.worst.y
        } (at most ${maxError}).`,
      );
    }
  }

  /**
   * The adaptive favicon draws the main cut full-bleed in one group whose
   * transform is the full-bleed fit (translate then scale), matched to within
   * 0.001 unit of `fullBleedFit(geometry)`.
   */
  function assertFullBleedTransform(svg, geometry, relativePath) {
    const groups = [...svg.matchAll(/<g\b[^>]*>/g)].map(([tag]) => tag);
    const match = /^<g class="octo-ink" transform="translate\((-?[\d.]+) (-?[\d.]+)\) scale\(([\d.]+)\)">$/.exec(
      groups[0] ?? "",
    );
    const fit = fullBleedFit(geometry);
    if (
      groups.length !== 1 ||
      !match ||
      Math.abs(Number(match[1]) - fit.x) > 0.001 ||
      Math.abs(Number(match[2]) - fit.y) > 0.001 ||
      Math.abs(Number(match[3]) - fit.scale) > 0.001
    ) {
      failures.push(
        `${relativePath} must draw the main cut full-bleed in one one-ink group: transform="translate(${formatSvgNumber(
          fit.x,
        )} ${formatSvgNumber(fit.y)}) scale(${formatSvgNumber(fit.scale)})"; found ${
          groups.join(" ") || "no group"
        }.`,
      );
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
    assertNodesInked,
    assertMatchesFullBleedReference,
    assertFullBleedTransform,
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

/** The 64-unit canvas less this margin on each side holds a full-bleed mark. */
export const FULL_BLEED_MARGIN = 4;

/** The extremes of one cubic Bezier coordinate over t in [0, 1]. */
function cubicExtremes(p0, p1, p2, p3) {
  const at = (t) =>
    (1 - t) ** 3 * p0 + 3 * (1 - t) ** 2 * t * p1 + 3 * (1 - t) * t ** 2 * p2 + t ** 3 * p3;
  // The derivative's roots: a t^2 + b t + c = 0.
  const a = -p0 + 3 * p1 - 3 * p2 + p3;
  const b = 2 * (p0 - 2 * p1 + p2);
  const c = p1 - p0;
  const roots = [];
  if (Math.abs(a) < 1e-12) {
    if (Math.abs(b) > 1e-12) roots.push(-c / b);
  } else {
    const discriminant = b * b - 4 * a * c;
    if (discriminant >= 0) {
      const root = Math.sqrt(discriminant);
      roots.push((-b + root) / (2 * a), (-b - root) / (2 * a));
    }
  }
  const values = [p0, p3, ...roots.filter((t) => t > 0 && t < 1).map(at)];
  return [Math.min(...values), Math.max(...values)];
}

/**
 * One Octo path's contours, each a start point and its line and cubic
 * segments. The geometry uses absolute M, L, C and Z only.
 */
function parseOctoPath(pathData) {
  const tokens = pathData.match(/[A-Za-z]|-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g) ?? [];
  const contours = [];
  let index = 0;
  let command = "";
  let contour = null;
  const point = () => {
    const x = Number(tokens[index]);
    const y = Number(tokens[index + 1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      throw new Error(`malformed Octo path data "${pathData}"`);
    }
    index += 2;
    return [x, y];
  };
  while (index < tokens.length) {
    if (/^[A-Za-z]$/.test(tokens[index])) command = tokens[index++];
    if (command === "M") {
      contour = { start: point(), segments: [] };
      contours.push(contour);
      command = "L";
    } else if (command === "L" && contour) {
      contour.segments.push({ to: point() });
    } else if (command === "C" && contour) {
      const [c1, c2, to] = [point(), point(), point()];
      contour.segments.push({ c1, c2, to });
    } else if (command === "Z" || command === "z") {
      command = "";
    } else {
      throw new Error(`unsupported Octo path command "${command}"`);
    }
  }
  return contours;
}

/**
 * The mark's ink box in its own path coordinates (before the geometry's
 * transform): the tight bounds of the body paths' curves (not their control
 * points) and the four nodes. The paths use absolute M, L, C and Z only.
 */
export function octoInkBox(geometry) {
  const box = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  const include = (minX, minY, maxX, maxY) => {
    box.minX = Math.min(box.minX, minX);
    box.minY = Math.min(box.minY, minY);
    box.maxX = Math.max(box.maxX, maxX);
    box.maxY = Math.max(box.maxY, maxY);
  };
  for (const pathData of geometry.paths ?? []) {
    for (const { start, segments } of parseOctoPath(pathData)) {
      include(start[0], start[1], start[0], start[1]);
      let current = start;
      for (const { c1, c2, to } of segments) {
        if (c1) {
          const [minX, maxX] = cubicExtremes(current[0], c1[0], c2[0], to[0]);
          const [minY, maxY] = cubicExtremes(current[1], c1[1], c2[1], to[1]);
          include(minX, minY, maxX, maxY);
        } else {
          include(to[0], to[1], to[0], to[1]);
        }
        current = to;
      }
    }
  }
  for (const { cx, cy, r } of geometry.circles ?? []) include(cx - r, cy - r, cx + r, cy + r);
  return { ...box, width: box.maxX - box.minX, height: box.maxY - box.minY };
}

/**
 * The full-bleed fit (generate-app-icons.swift): the ink box scaled so its
 * longer side spans the canvas less FULL_BLEED_MARGIN on each side, and
 * centered. A path point p lands at scale * p + (x, y); centering absorbs the
 * geometry's own translate.
 */
export function fullBleedFit(geometry) {
  const box = octoInkBox(geometry);
  const scale = (CANVAS_UNITS - 2 * FULL_BLEED_MARGIN) / Math.max(box.width, box.height);
  return {
    scale,
    x: CANVAS_UNITS / 2 - scale * (box.minX + box.width / 2),
    y: CANVAS_UNITS / 2 - scale * (box.minY + box.height / 2),
  };
}

/**
 * The centers of the mark's four nodes on the 64-unit canvas, in crew-slot
 * order (left to right by cx): after the geometry's own translate and, when
 * given, the distribution scale about the canvas center; or, with
 * `fullBleed`, at the full-bleed fit.
 */
export function octoNodeCenters(geometry, { distributionScale = 1, fullBleed = false } = {}) {
  if (fullBleed) {
    const fit = fullBleedFit(geometry);
    return [...(geometry.circles ?? [])]
      .sort((a, b) => a.cx - b.cx)
      .map((circle) => ({
        x: fit.x + fit.scale * circle.cx,
        y: fit.y + fit.scale * circle.cy,
        r: fit.scale * circle.r,
      }));
  }
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

/**
 * The reference raster of the mark drawn full-bleed into a `side` px square:
 * each pixel's ink coverage in [0, 1], sampled on a `supersample` x
 * `supersample` grid per pixel (each path filled nonzero, paths and nodes
 * unioned), row by row.
 */
export function rasterizeFullBleedCoverage(geometry, side, { supersample = 8 } = {}) {
  const fit = fullBleedFit(geometry);
  const unit = side / CANVAS_UNITS;
  const place = ([x, y]) => [(fit.x + fit.scale * x) * unit, (fit.y + fit.scale * y) * unit];
  // Each path becomes closed polygons; every cubic is cut into 16 chords,
  // well under a hundredth of a pixel from the curve at these sizes.
  const shapes = (geometry.paths ?? []).map((pathData) =>
    parseOctoPath(pathData).map(({ start, segments }) => {
      const polygon = [place(start)];
      let current = start;
      for (const { c1, c2, to } of segments) {
        if (c1) {
          for (let step = 1; step <= 16; step += 1) {
            const t = step / 16;
            const u = 1 - t;
            const bezier = (axis) =>
              u ** 3 * current[axis] + 3 * u * u * t * c1[axis] + 3 * u * t * t * c2[axis] + t ** 3 * to[axis];
            polygon.push(place([bezier(0), bezier(1)]));
          }
        } else {
          polygon.push(place(to));
        }
        current = to;
      }
      return polygon;
    }),
  );
  const nodes = (geometry.circles ?? []).map(({ cx, cy, r }) => {
    const [x, y] = place([cx, cy]);
    return { x, y, r: fit.scale * r * unit };
  });
  const samples = side * supersample;
  const weight = 1 / (supersample * supersample);
  const coverage = new Float64Array(side * side);
  const covered = new Uint8Array(samples);
  // Mark the samples whose centers fall in [left, right).
  const fill = (left, right) => {
    const first = Math.max(0, Math.ceil(left * supersample - 0.5));
    const end = Math.min(samples, Math.ceil(right * supersample - 0.5));
    for (let sample = first; sample < end; sample += 1) covered[sample] = 1;
  };
  for (let row = 0; row < samples; row += 1) {
    const y = (row + 0.5) / supersample;
    covered.fill(0);
    for (const polygons of shapes) {
      const crossings = [];
      for (const polygon of polygons) {
        for (let index = 0; index < polygon.length; index += 1) {
          const [x0, y0] = polygon[index];
          const [x1, y1] = polygon[(index + 1) % polygon.length];
          if (y0 <= y !== y1 <= y) {
            crossings.push([x0 + ((y - y0) / (y1 - y0)) * (x1 - x0), y1 > y0 ? 1 : -1]);
          }
        }
      }
      crossings.sort((a, b) => a[0] - b[0]);
      let winding = 0;
      for (let index = 0; index < crossings.length; index += 1) {
        if (winding !== 0) fill(crossings[index - 1][0], crossings[index][0]);
        winding += crossings[index][1];
      }
    }
    for (const node of nodes) {
      const dy = y - node.y;
      if (Math.abs(dy) < node.r) {
        const half = Math.sqrt(node.r * node.r - dy * dy);
        fill(node.x - half, node.x + half);
      }
    }
    const pixelRow = Math.floor(row / supersample) * side;
    for (let sample = 0; sample < samples; sample += 1) {
      if (covered[sample]) coverage[pixelRow + Math.floor(sample / supersample)] += weight;
    }
  }
  return coverage;
}

/**
 * Compare a one-ink raster against the full-bleed reference over the square
 * `placement` (whole device px). Each pixel's coverage is read on the channel
 * where ink and background differ most, after compositing it over the
 * background (so a transparent tile corner reads as no ink). Returns the mean
 * and the largest per-pixel coverage difference and where the largest is.
 */
export function compareToFullBleedReference(image, { placement, geometry, ink, background }) {
  const { x: left, y: top, side } = placement;
  const reference = rasterizeFullBleedCoverage(geometry, side);
  const channel = [0, 1, 2].reduce((best, index) =>
    Math.abs(ink[index] - background[index]) > Math.abs(ink[best] - background[best]) ? index : best,
  );
  let total = 0;
  let maxError = 0;
  let worst = { x: left, y: top };
  for (let y = 0; y < side; y += 1) {
    for (let x = 0; x < side; x += 1) {
      const actual = pixelAt(image, left + x, top + y);
      const alpha = actual[3] / 255;
      const value = alpha * actual[channel] + (1 - alpha) * background[channel];
      const coverage = (value - background[channel]) / (ink[channel] - background[channel]);
      const error = Math.abs(coverage - reference[y * side + x]);
      total += error;
      if (error > maxError) {
        maxError = error;
        worst = { x: left + x, y: top + y };
      }
    }
  }
  return { meanError: total / (side * side), maxError, worst };
}

/**
 * How far a full-bleed raster may stray from the reference. Rasterizer
 * differences stay near 0.01 mean and 0.12 per pixel; the retired small cut
 * (a 56 x 56 redraw with spread legs and 2 x 2 px nodes) misses by 0.08 to
 * 0.10 mean and 0.58 to 1.0 per pixel, and so does a mark off by one pixel.
 */
export const FULL_BLEED_REFERENCE_TOLERANCE = { meanError: 0.03, maxError: 0.35 };
