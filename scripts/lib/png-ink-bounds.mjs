import fs from "node:fs";
import zlib from "node:zlib";

const PNG_SIGNATURE = "89504e470d0a1a0a";

/**
 * Return the inclusive pixel bounds of artwork matching a color in an 8-bit,
 * non-interlaced PNG. Pixels are composited over the supplied background and
 * matched along the background-to-ink blend line, so antialiased opaque and
 * alpha edges produce the same optical bounds.
 */
export function readPngInkBounds(
  filePath,
  {
    ink = [15, 23, 42],
    background = [255, 255, 255],
    minimumCoverage = 0.5,
    maximumBlendError = 20,
  } = {},
) {
  const { width, height, pixels } = decodePng(fs.readFileSync(filePath));
  const direction = ink.map((channel, index) => channel - background[index]);
  const directionLengthSquared = direction.reduce((sum, channel) => sum + channel * channel, 0);
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      const alpha = pixels[offset + 3] / 255;
      const composited = [0, 1, 2].map(
        (channel) => pixels[offset + channel] * alpha + background[channel] * (1 - alpha),
      );
      const relative = composited.map((channel, index) => channel - background[index]);
      const coverage = relative.reduce(
        (sum, channel, index) => sum + channel * direction[index],
        0,
      ) / directionLengthSquared;
      if (coverage < minimumCoverage) continue;

      const clampedCoverage = Math.min(1, coverage);
      const blendError = Math.sqrt(
        composited.reduce((sum, channel, index) => {
          const expected = background[index] + direction[index] * clampedCoverage;
          return sum + (channel - expected) ** 2;
        }, 0),
      );
      if (blendError > maximumBlendError) continue;

      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }

  if (maxX < 0) return null;
  return {
    minX,
    minY,
    maxX,
    maxY,
    width: maxX - minX + 1,
    height: maxY - minY + 1,
    centerX: (minX + maxX + 1) / 2,
    centerY: (minY + maxY + 1) / 2,
    imageWidth: width,
    imageHeight: height,
  };
}

/** Return one decoded RGBA pixel from an 8-bit, non-interlaced PNG. */
export function readPngPixel(filePath, x, y) {
  const { width, height, pixels } = decodePng(fs.readFileSync(filePath));
  if (
    !Number.isInteger(x) ||
    !Number.isInteger(y) ||
    x < 0 ||
    y < 0 ||
    x >= width ||
    y >= height
  ) {
    throw new RangeError(`pixel ${x},${y} is outside ${width}x${height}`);
  }
  const offset = (y * width + x) * 4;
  return Array.from(pixels.subarray(offset, offset + 4));
}

function decodePng(contents) {
  if (contents.length < 33 || contents.subarray(0, 8).toString("hex") !== PNG_SIGNATURE) {
    throw new Error("not a PNG");
  }

  let offset = 8;
  let header;
  const compressedParts = [];
  while (offset + 12 <= contents.length) {
    const length = contents.readUInt32BE(offset);
    const type = contents.subarray(offset + 4, offset + 8).toString("ascii");
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > contents.length) throw new Error(`truncated ${type || "PNG"} chunk`);
    const data = contents.subarray(dataStart, dataEnd);
    if (type === "IHDR") {
      header = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        bitDepth: data[8],
        colorType: data[9],
        compression: data[10],
        filter: data[11],
        interlace: data[12],
      };
    } else if (type === "IDAT") {
      compressedParts.push(data);
    } else if (type === "IEND") {
      break;
    }
    offset = dataEnd + 4;
  }

  if (!header || compressedParts.length === 0) throw new Error("missing IHDR or IDAT chunk");
  if (
    header.bitDepth !== 8 ||
    header.compression !== 0 ||
    header.filter !== 0 ||
    header.interlace !== 0
  ) {
    throw new Error("only non-interlaced, 8-bit PNGs are supported");
  }

  const channelsByColorType = new Map([
    [0, 1],
    [2, 3],
    [4, 2],
    [6, 4],
  ]);
  const channels = channelsByColorType.get(header.colorType);
  if (!channels) throw new Error(`unsupported PNG color type ${header.colorType}`);

  const stride = header.width * channels;
  const inflated = zlib.inflateSync(Buffer.concat(compressedParts));
  const expectedLength = (stride + 1) * header.height;
  if (inflated.length !== expectedLength) {
    throw new Error(`unexpected decoded PNG size ${inflated.length}; expected ${expectedLength}`);
  }

  const scanlines = Buffer.alloc(stride * header.height);
  let sourceOffset = 0;
  for (let y = 0; y < header.height; y += 1) {
    const filterType = inflated[sourceOffset];
    sourceOffset += 1;
    const rowOffset = y * stride;
    const previousRowOffset = rowOffset - stride;
    for (let x = 0; x < stride; x += 1) {
      const raw = inflated[sourceOffset + x];
      const left = x >= channels ? scanlines[rowOffset + x - channels] : 0;
      const above = y > 0 ? scanlines[previousRowOffset + x] : 0;
      const upperLeft = y > 0 && x >= channels ? scanlines[previousRowOffset + x - channels] : 0;
      scanlines[rowOffset + x] = unfilterByte(filterType, raw, left, above, upperLeft);
    }
    sourceOffset += stride;
  }

  const pixels = Buffer.alloc(header.width * header.height * 4);
  for (let pixel = 0; pixel < header.width * header.height; pixel += 1) {
    const source = pixel * channels;
    const target = pixel * 4;
    if (header.colorType === 0 || header.colorType === 4) {
      pixels[target] = scanlines[source];
      pixels[target + 1] = scanlines[source];
      pixels[target + 2] = scanlines[source];
      pixels[target + 3] = header.colorType === 4 ? scanlines[source + 1] : 255;
    } else {
      pixels[target] = scanlines[source];
      pixels[target + 1] = scanlines[source + 1];
      pixels[target + 2] = scanlines[source + 2];
      pixels[target + 3] = header.colorType === 6 ? scanlines[source + 3] : 255;
    }
  }

  return { width: header.width, height: header.height, pixels };
}

function unfilterByte(filterType, raw, left, above, upperLeft) {
  switch (filterType) {
    case 0:
      return raw;
    case 1:
      return (raw + left) & 0xff;
    case 2:
      return (raw + above) & 0xff;
    case 3:
      return (raw + Math.floor((left + above) / 2)) & 0xff;
    case 4:
      return (raw + paeth(left, above, upperLeft)) & 0xff;
    default:
      throw new Error(`unsupported PNG filter type ${filterType}`);
  }
}

function paeth(left, above, upperLeft) {
  const prediction = left + above - upperLeft;
  const leftDistance = Math.abs(prediction - left);
  const aboveDistance = Math.abs(prediction - above);
  const upperLeftDistance = Math.abs(prediction - upperLeft);
  if (leftDistance <= aboveDistance && leftDistance <= upperLeftDistance) return left;
  if (aboveDistance <= upperLeftDistance) return above;
  return upperLeft;
}
