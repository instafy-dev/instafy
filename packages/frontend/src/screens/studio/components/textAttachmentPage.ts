export const TEXT_ATTACHMENT_PAGE_BYTES = 100 * 1024;

/** Keep UTF-8 characters intact without decoding the whole attachment at once. */
export async function readTextAttachmentPage(blob: Blob, offset: number): Promise<{ content: string; nextOffset: number | null }> {
  const bytes = new Uint8Array(await blob.slice(offset, offset + TEXT_ATTACHMENT_PAGE_BYTES + 4).arrayBuffer());
  let end = Math.min(TEXT_ATTACHMENT_PAGE_BYTES, bytes.length);
  // If the next byte continues a character, leave that entire character for
  // the following page. At most three continuation bytes can follow a lead.
  const minimumEnd = Math.max(0, end - 3);
  while (end > minimumEnd && end < bytes.length && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return {
    content: new TextDecoder("utf-8", { ignoreBOM: offset > 0 }).decode(bytes.subarray(0, end)),
    nextOffset: offset + end < blob.size ? offset + end : null,
  };
}
