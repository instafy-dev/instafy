export type AudioArtifact = {
  blob: Blob;
  mimeType: string;
  fileName: string;
};

const DEFAULT_AUDIO_BASE_NAME = "instafy-audio";
const DEFAULT_AUDIO_MIME_TYPE = "application/octet-stream";

function normalizeOptionalString(value: string | null | undefined) {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function guessAudioFileExtension(
  mimeType: string | null | undefined,
  fallback = ".bin",
) {
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

export function createAudioArtifactFromBlob(
  blob: Blob,
  options?: {
    fileName?: string | null;
    baseName?: string | null;
    mimeType?: string | null;
  },
): AudioArtifact {
  const mimeType =
    normalizeOptionalString(options?.mimeType) ??
    normalizeOptionalString(blob.type) ??
    DEFAULT_AUDIO_MIME_TYPE;
  const explicitFileName = normalizeOptionalString(options?.fileName);
  const baseName = normalizeOptionalString(options?.baseName) ?? DEFAULT_AUDIO_BASE_NAME;
  return {
    blob,
    mimeType,
    fileName: explicitFileName ?? `${baseName}${guessAudioFileExtension(mimeType, ".webm")}`,
  };
}

function convertBytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(index, Math.min(index + chunkSize, bytes.length));
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

export async function encodeAudioArtifactDataUrl(artifact: AudioArtifact): Promise<string> {
  const bytes = new Uint8Array(await artifact.blob.arrayBuffer());
  return `data:${artifact.mimeType};base64,${convertBytesToBase64(bytes)}`;
}
