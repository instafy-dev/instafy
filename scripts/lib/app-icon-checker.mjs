import fs from "node:fs";
import path from "node:path";

import { readPngInkBounds, readPngPixel } from "./png-ink-bounds.mjs";

export function createAppIconChecker({ repoRoot, failures }) {
  function resolve(relativePath) {
    return path.join(repoRoot, relativePath);
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
      return readPngInkBounds(resolve(relativePath), options);
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
          `${relativePath} Octo ink must be approximately ${expectedInk.width}x${
            expectedInk.height
          }px; found ${bounds.width}x${bounds.height}px.`,
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
      actual = readPngPixel(resolve(relativePath), x, y);
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
    assertMatchingOpticalRatios,
    assertOpticalBounds,
    assertPixelColor,
    checkFavicon,
    expectContains,
    expectNotContains,
    parseHexColor,
    readInkBounds,
    readPng,
    readText,
    resolve,
  };
}

export function formatSvgNumber(value) {
  return value.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
}
