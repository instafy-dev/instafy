import { decodePng } from "./png-ink-bounds.mjs";

const PNG_SIGNATURE = "89504e470d0a1a0a";

/**
 * Read every image of an ICO file. Each entry is `{ size, format, image }`,
 * where `format` is "png" (an embedded PNG) or "bmp" (a 32-bit DIB with its
 * AND mask) and `image` is decoded to straight-alpha RGBA pixels.
 */
export function decodeIcoEntries(contents) {
  if (contents.length < 6 || contents.readUInt16LE(0) !== 0 || contents.readUInt16LE(2) !== 1) {
    throw new Error("not an ICO file");
  }
  const entries = [];
  for (let index = 0; index < contents.readUInt16LE(4); index += 1) {
    const entryOffset = 6 + index * 16;
    if (entryOffset + 16 > contents.length) throw new Error("truncated ICO directory");
    const size = contents[entryOffset] || 256;
    const payloadSize = contents.readUInt32LE(entryOffset + 8);
    const payloadOffset = contents.readUInt32LE(entryOffset + 12);
    if (payloadOffset + payloadSize > contents.length) {
      throw new Error(`ICO entry ${index + 1} runs past the end of the file`);
    }
    const payload = contents.subarray(payloadOffset, payloadOffset + payloadSize);
    const isPng = payload.subarray(0, 8).toString("hex") === PNG_SIGNATURE;
    entries.push({
      size,
      bitCount: contents.readUInt16LE(entryOffset + 6),
      format: isPng ? "png" : "bmp",
      image: isPng ? decodePng(payload) : decodeIcoDib(payload),
    });
  }
  return entries;
}

/** Decode a 32-bit BI_RGB DIB from an ICO entry (bottom-up BGRA rows). */
export function decodeIcoDib(payload) {
  if (payload.length < 40 || payload.readUInt32LE(0) !== 40) {
    throw new Error("ICO DIB entry must start with a 40-byte BITMAPINFOHEADER");
  }
  const width = payload.readInt32LE(4);
  const doubledHeight = payload.readInt32LE(8);
  const bitCount = payload.readUInt16LE(14);
  const compression = payload.readUInt32LE(16);
  if (bitCount !== 32 || compression !== 0) {
    throw new Error(`only 32-bit uncompressed ICO DIBs are supported (found ${bitCount}-bit)`);
  }
  if (width <= 0 || doubledHeight <= 0 || doubledHeight % 2 !== 0) {
    throw new Error("ICO DIB entry must be bottom-up with a doubled (XOR + AND) height");
  }
  const height = doubledHeight / 2;
  const maskStride = Math.ceil(width / 32) * 4;
  if (payload.length < 40 + width * height * 4 + maskStride * height) {
    throw new Error("ICO DIB entry is truncated");
  }
  const pixels = Buffer.alloc(width * height * 4);
  for (let row = 0; row < height; row += 1) {
    const y = height - 1 - row;
    for (let x = 0; x < width; x += 1) {
      const source = 40 + (row * width + x) * 4;
      const target = (y * width + x) * 4;
      pixels[target] = payload[source + 2];
      pixels[target + 1] = payload[source + 1];
      pixels[target + 2] = payload[source];
      pixels[target + 3] = payload[source + 3];
    }
  }
  return { width, height, pixels };
}

/**
 * The side in pixels of each ICNS image type this repository writes (what
 * iconutil emits for a full .iconset). ic04/ic05 hold RLE-compressed ARGB;
 * the rest hold PNG.
 */
export const ICNS_TYPE_SIDES = new Map([
  ["ic04", 16],
  ["ic05", 32],
  ["ic11", 32],
  ["ic12", 64],
  ["ic07", 128],
  ["ic13", 256],
  ["ic08", 256],
  ["ic14", 512],
  ["ic09", 512],
  ["ic10", 1024],
]);

/**
 * Read the image elements of an ICNS file as `{ type, image }`. Elements that
 * are not images (the `info` and table-of-contents chunks) are skipped; an
 * unknown image type is an error so a stray legacy representation is noticed.
 */
export function decodeIcnsEntries(contents) {
  if (contents.length < 8 || contents.toString("ascii", 0, 4) !== "icns") {
    throw new Error("not an ICNS file");
  }
  if (contents.readUInt32BE(4) !== contents.length) {
    throw new Error("ICNS header length does not match the file size");
  }
  const entries = [];
  let offset = 8;
  while (offset < contents.length) {
    if (offset + 8 > contents.length) throw new Error("truncated ICNS element header");
    const type = contents.toString("ascii", offset, offset + 4);
    const length = contents.readUInt32BE(offset + 4);
    if (length < 8 || offset + length > contents.length) {
      throw new Error(`ICNS element ${type} has an invalid length`);
    }
    const data = contents.subarray(offset + 8, offset + length);
    offset += length;
    if (type === "info" || type === "TOC ") continue;
    const side = ICNS_TYPE_SIDES.get(type);
    if (!side) throw new Error(`unexpected ICNS element ${type}`);
    let image;
    if (data.subarray(0, 8).toString("hex") === PNG_SIGNATURE) {
      image = decodePng(data);
    } else if (data.toString("ascii", 0, 4) === "ARGB") {
      image = decodeIcnsArgb(data.subarray(4), side);
    } else {
      throw new Error(`ICNS element ${type} is neither PNG nor ARGB`);
    }
    entries.push({ type, image });
  }
  return entries;
}

/**
 * Decode ICNS ARGB planes (A, R, G, B, each side x side bytes) packed with the
 * ICNS run-length scheme: a byte n < 0x80 copies the next n + 1 bytes, and a
 * byte n >= 0x80 repeats the next byte n - 0x80 + 3 times.
 */
export function decodeIcnsArgb(compressed, side) {
  const planeSize = side * side;
  const planes = Buffer.alloc(planeSize * 4);
  let read = 0;
  let written = 0;
  while (written < planes.length) {
    if (read >= compressed.length) throw new Error("truncated ICNS ARGB data");
    const control = compressed[read];
    read += 1;
    if (control < 0x80) {
      const count = control + 1;
      if (read + count > compressed.length || written + count > planes.length) {
        throw new Error("ICNS ARGB literal run overflows");
      }
      compressed.copy(planes, written, read, read + count);
      read += count;
      written += count;
    } else {
      const count = control - 0x80 + 3;
      if (read >= compressed.length || written + count > planes.length) {
        throw new Error("ICNS ARGB repeat run overflows");
      }
      planes.fill(compressed[read], written, written + count);
      read += 1;
      written += count;
    }
  }
  const pixels = Buffer.alloc(planeSize * 4);
  for (let index = 0; index < planeSize; index += 1) {
    pixels[index * 4] = planes[planeSize + index];
    pixels[index * 4 + 1] = planes[planeSize * 2 + index];
    pixels[index * 4 + 2] = planes[planeSize * 3 + index];
    pixels[index * 4 + 3] = planes[index];
  }
  return { width: side, height: side, pixels };
}
