import path from "node:path";

export function normalizeOptionalString(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function guessAudioFileExtension(mimeType, fallback = ".bin") {
  const normalized = normalizeOptionalString(mimeType)?.toLowerCase() ?? "";
  if (normalized.includes("aiff")) {
    return ".aiff";
  }
  if (normalized.includes("wav")) {
    return ".wav";
  }
  if (normalized.includes("mpeg")) {
    return ".mp3";
  }
  if (normalized.includes("ogg")) {
    return ".ogg";
  }
  if (normalized.includes("mp4")) {
    return ".mp4";
  }
  if (normalized.includes("webm")) {
    return ".webm";
  }
  return fallback;
}

export function sanitizeAudioFileExtension(fileName, mimeType, fallback = ".webm") {
  const explicitExt = typeof fileName === "string" ? path.extname(fileName).trim() : "";
  if (explicitExt) {
    return explicitExt.toLowerCase();
  }
  return guessAudioFileExtension(mimeType, fallback);
}

export function parseAudioDataUrl(dataUrl) {
  const normalized = normalizeOptionalString(dataUrl);
  if (!normalized || !normalized.startsWith("data:")) {
    throw new Error("audioDataUrl must be a valid data URL.");
  }
  const separatorIndex = normalized.indexOf(",");
  if (separatorIndex <= 0) {
    throw new Error("audioDataUrl is missing a payload.");
  }
  const header = normalized.slice(5, separatorIndex);
  const payload = normalized.slice(separatorIndex + 1);
  const isBase64 = header.endsWith(";base64");
  const mimeType = (isBase64 ? header.slice(0, -7) : header).trim() || "application/octet-stream";
  const buffer = isBase64
    ? Buffer.from(payload, "base64")
    : Buffer.from(decodeURIComponent(payload), "utf8");
  return {
    mimeType,
    buffer,
  };
}

export function encodeAudioDataUrl(buffer, mimeType) {
  return `data:${mimeType};base64,${buffer.toString("base64")}`;
}
