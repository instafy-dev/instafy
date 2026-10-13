import assert from "node:assert/strict";
import test from "node:test";

import {
  encodeOpaqueRgbPng,
  findSocialCardUrls,
  replaceSocialCardUrls,
  socialCardImageUrl,
} from "./og-image.mjs";
import { decodePng } from "./png-ink-bounds.mjs";

function gradient(width, height) {
  const pixels = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      pixels[offset] = (x * 37) & 0xff;
      pixels[offset + 1] = (y * 53) & 0xff;
      pixels[offset + 2] = (x * y) & 0xff;
      pixels[offset + 3] = 255;
    }
  }
  return { width, height, pixels };
}

test("encodeOpaqueRgbPng writes an RGB PNG that decodes to the same pixels", () => {
  const image = gradient(23, 11);
  const png = encodeOpaqueRgbPng(image);
  assert.equal(png[25], 2, "color type 2 (RGB, no alpha)");
  const decoded = decodePng(png);
  assert.equal(decoded.width, 23);
  assert.equal(decoded.height, 11);
  assert.deepEqual(decoded.pixels, image.pixels);
});

test("encodeOpaqueRgbPng is deterministic and carries no ancillary chunks", () => {
  const image = gradient(16, 16);
  const first = encodeOpaqueRgbPng(image);
  assert.deepEqual(encodeOpaqueRgbPng(image), first);
  const types = [];
  for (let offset = 8; offset < first.length; ) {
    const length = first.readUInt32BE(offset);
    types.push(first.subarray(offset + 4, offset + 8).toString("ascii"));
    offset += length + 12;
  }
  assert.deepEqual(types, ["IHDR", "IDAT", "IEND"]);
});

test("encodeOpaqueRgbPng refuses a transparent pixel", () => {
  const image = gradient(4, 4);
  image.pixels[(2 * 4 + 1) * 4 + 3] = 128;
  assert.throws(() => encodeOpaqueRgbPng(image), /pixel 1,2 is not opaque/);
});

test("socialCardImageUrl versions the card by its content", () => {
  const url = socialCardImageUrl(Buffer.from("card"));
  assert.match(url, /^\/og-image\.png\?sha=[0-9a-f]{12}$/);
  assert.equal(socialCardImageUrl(Buffer.from("card")), url);
  assert.notEqual(socialCardImageUrl(Buffer.from("other card")), url);
  // Never the brand ?v= revision, which pins icon files only.
  assert.doesNotMatch(url, /\?v=/);
});

test("findSocialCardUrls and replaceSocialCardUrls cover both quote styles and any query", () => {
  const html = `<meta property="og:image" content="/og-image.png" />\n<meta name="twitter:image" content="/og-image.png?sha=000000000000" />`;
  const ts = `export const SOCIAL_CARD_IMAGE = '/og-image.png?v=3';`;
  assert.deepEqual(findSocialCardUrls(html), ["/og-image.png", "/og-image.png?sha=000000000000"]);
  assert.deepEqual(findSocialCardUrls(ts), ["/og-image.png?v=3"]);
  const url = "/og-image.png?sha=abcdefabcdef";
  assert.deepEqual(findSocialCardUrls(replaceSocialCardUrls(html, url)), [url, url]);
  assert.equal(replaceSocialCardUrls(ts, url), `export const SOCIAL_CARD_IMAGE = '${url}';`);
  assert.deepEqual(findSocialCardUrls(`"/other/og-image.png" "/og-image.pngx"`), []);
});
