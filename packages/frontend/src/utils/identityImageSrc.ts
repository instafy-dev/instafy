/** Encode image URLs at the rendering boundary, including local upload previews.
 * Keep existing percent escapes intact so signed URLs and escaped paths still work.
 */
export function normalizeIdentityImageSrc(value: string | null | undefined): string | null {
  const src = value?.trim();
  if (!src || !/^(?:https?:\/\/|blob:|data:image\/|\/)/i.test(src)) return null;
  try {
    return encodeURI(src).replace(/%25([\da-f]{2})/gi, "%$1");
  } catch {
    return null;
  }
}
