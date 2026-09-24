/** Suppress identical JPEGs, retaining a periodic image for viewer liveness. */
export function localTabFrameFilter() {
  let previous: Uint8Array | undefined;
  let sentAt = -Infinity;
  return (bytes: Uint8Array, now = performance.now()): boolean => {
    if (
      now - sentAt < 2000 &&
      previous?.length === bytes.length &&
      bytes.every((byte, index) => previous![index] === byte)
    )
      return false;
    // Captures are bounded to one MiB. Retain a copy so callers cannot mutate
    // the comparison frame, and invoke only when the socket can accept a frame.
    previous = bytes.slice();
    sentAt = now;
    return true;
  };
}
