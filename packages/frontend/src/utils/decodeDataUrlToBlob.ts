/** The bytes of a `data:` URL as a Blob of its media type, or null when it is not one or cannot be decoded. */
export function decodeDataUrlToBlob(dataUrl: string): Blob | null {
  if (!dataUrl.startsWith("data:")) {
    return null;
  }
  const commaIndex = dataUrl.indexOf(",");
  if (commaIndex < 0) {
    return null;
  }
  const metadata = dataUrl.slice("data:".length, commaIndex);
  const payload = dataUrl.slice(commaIndex + 1);
  const metadataParts = metadata
    .split(";")
    .map((value) => value.trim())
    .filter(Boolean);
  const mimeType = metadataParts[0] && metadataParts[0] !== "base64" ? metadataParts[0] : "";
  const isBase64 = metadataParts.includes("base64");

  try {
    const raw = isBase64 ? atob(payload) : decodeURIComponent(payload);
    const bytes = new Uint8Array(raw.length);
    for (let index = 0; index < raw.length; index += 1) {
      bytes[index] = raw.charCodeAt(index);
    }
    return new Blob([bytes], { type: mimeType || "application/octet-stream" });
  } catch {
    return null;
  }
}
