// Helpers shared by scripts/generate-og-image.mjs and scripts/check-app-icons.mjs
// for the social card (packages/frontend/public/og-image.png).

import { createHash } from "node:crypto";
import zlib from "node:zlib";

export const SOCIAL_CARD_PATH = "packages/frontend/public/og-image.png";
export const SOCIAL_CARD_WIDTH = 1200;
export const SOCIAL_CARD_HEIGHT = 630;
/** The files that reference the card's URL: the static head and the runtime SEO default. */
export const SOCIAL_CARD_REFERENCES = ["packages/frontend/index.html", "packages/frontend/src/utils/seo.ts"];

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * The card's public URL, versioned by its content. Link unfurlers (X, Slack,
 * LinkedIn, iMessage) cache an og:image by URL, so a new card needs a new URL.
 * The query is not the brand `?v=` revision: the card is not an icon and its
 * pixels change on their own schedule.
 */
export function socialCardImageUrl(contents) {
  const digest = createHash("sha256").update(contents).digest("hex").slice(0, 12);
  return `/og-image.png?sha=${digest}`;
}

/** Every og-image URL in `text` (quoted, any query). */
export function findSocialCardUrls(text) {
  return [...text.matchAll(/["'](\/og-image\.png(?:\?[^"']*)?)["']/g)].map((match) => match[1]);
}

/** Rewrites every og-image URL in `text` to `url`. */
export function replaceSocialCardUrls(text, url) {
  return text.replace(/(["'])\/og-image\.png(?:\?[^"']*)?\1/g, (_match, quote) => `${quote}${url}${quote}`);
}

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/**
 * Encodes opaque RGBA pixels as an 8-bit RGB PNG (color type 2), with no
 * ancillary chunks (no time, gamma or text), so equal pixels always give
 * equal bytes. Each row takes the filter with the smallest sum of absolute
 * residuals. Throws if any pixel is not fully opaque.
 */
export function encodeOpaqueRgbPng({ width, height, pixels }) {
  if (pixels.length !== width * height * 4) throw new Error("pixel buffer does not match the size");
  const stride = width * 3;
  const rgb = Buffer.alloc(stride * height);
  for (let source = 0, target = 0; source < pixels.length; source += 4, target += 3) {
    if (pixels[source + 3] !== 255) {
      const index = source / 4;
      throw new Error(`pixel ${index % width},${Math.floor(index / width)} is not opaque`);
    }
    rgb[target] = pixels[source];
    rgb[target + 1] = pixels[source + 1];
    rgb[target + 2] = pixels[source + 2];
  }
  const filtered = Buffer.alloc((stride + 1) * height);
  const candidate = Buffer.alloc(stride);
  for (let y = 0; y < height; y += 1) {
    const row = rgb.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? rgb.subarray((y - 1) * stride, y * stride) : null;
    let best = null;
    let bestScore = Infinity;
    for (let filter = 0; filter < 5; filter += 1) {
      let score = 0;
      for (let x = 0; x < stride; x += 1) {
        const a = x >= 3 ? row[x - 3] : 0;
        const b = prev ? prev[x] : 0;
        const c = prev && x >= 3 ? prev[x - 3] : 0;
        let value = row[x];
        if (filter === 1) value -= a;
        else if (filter === 2) value -= b;
        else if (filter === 3) value -= (a + b) >> 1;
        else if (filter === 4) value -= paeth(a, b, c);
        value &= 0xff;
        candidate[x] = value;
        score += value < 128 ? value : 256 - value;
      }
      if (score < bestScore) {
        bestScore = score;
        best = { filter, bytes: Buffer.from(candidate) };
      }
    }
    const offset = y * (stride + 1);
    filtered[offset] = best.filter;
    best.bytes.copy(filtered, offset + 1);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  header[10] = 0;
  header[11] = 0;
  header[12] = 0;
  const data = zlib.deflateSync(filtered, { level: 9, memLevel: 9, strategy: zlib.constants.Z_DEFAULT_STRATEGY });
  return Buffer.concat([PNG_SIGNATURE, chunk("IHDR", header), chunk("IDAT", data), chunk("IEND", Buffer.alloc(0))]);
}
