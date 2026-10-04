/**
 * Git blob id (SHA-1 of `"blob <byte length>\0"` followed by the bytes),
 * the value origins send as `X-Instafy-Blob` and `blobOid`. After a save the
 * client computes it from the saved bytes so the next save can send
 * `expected` without reading the file again.
 *
 * Resolves to null where WebCrypto is unavailable (an insecure context); a
 * caller then simply has no blob id, which only costs a refetch. Canonical
 * repositories use SHA-1 object ids.
 */
export async function gitBlobOid(content: Uint8Array | string): Promise<string | null> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    return null;
  }
  const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
  const header = new TextEncoder().encode(`blob ${bytes.byteLength}\0`);
  const data = new Uint8Array(header.byteLength + bytes.byteLength);
  data.set(header, 0);
  data.set(bytes, header.byteLength);
  try {
    const digest = await subtle.digest("SHA-1", data);
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  } catch (_error) {
    return null;
  }
}
