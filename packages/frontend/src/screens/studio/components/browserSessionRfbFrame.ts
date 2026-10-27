type RfbFrameTarget = {
  _framebufferUpdate?: () => boolean;
  _handleRect?: () => boolean;
  _FBU?: { encoding: number | null };
  _display?: { flush?: () => Promise<void> };
};

// noVNC 1.5's framebuffer decoders: Raw, CopyRect, RRE, Hextile, Tight,
// ZRLE, TightPNG and JPEG. Encoding signs do not distinguish pixels from
// pseudo-encodings: TightPNG is negative and VMwareCursor is positive.
const FRAMEBUFFER_ENCODINGS = new Set([0, 1, 2, 5, 7, 16, -260, 21]);

/**
 * noVNC's connect event precedes its first pixels. Observe completed pixel
 * updates instead, including asynchronously decoded JPEG/PNG rectangles.
 * Like the scaled-resize adapter, this is guarded against unsupported noVNC
 * internals. It never changes decoding, input authority or socket lifetime.
 */
export function observeBrowserRfbFrames(
  target: unknown,
  onPaint: () => void,
  frameScope: () => string,
): (() => void) | null {
  const rfb = target as RfbFrameTarget | null;
  const update = rfb?._framebufferUpdate;
  const handleRect = rfb?._handleRect;
  const display = rfb?._display;
  if (!rfb || !update || !handleRect || !display?.flush || !rfb._FBU) return null;

  let disposed = false;
  let decodedScope: string | null = null;
  const observedRect = function (this: RfbFrameTarget) {
    const encoding = this._FBU?.encoding;
    const complete = handleRect.call(this);
    if (complete && typeof encoding === "number" && FRAMEBUFFER_ENCODINGS.has(encoding)) decodedScope = frameScope();
    return complete;
  };
  const observedUpdate = function (this: RfbFrameTarget) {
    const complete = update.call(this);
    if (complete && decodedScope !== null) {
      const scope = decodedScope;
      decodedScope = null;
      if (frameScope() !== scope) return complete;
      void display.flush!().then(() => {
        if (!disposed && frameScope() === scope) onPaint();
      }).catch(() => undefined);
    }
    return complete;
  };
  rfb._handleRect = observedRect;
  rfb._framebufferUpdate = observedUpdate;
  return () => {
    disposed = true;
    if (rfb._handleRect === observedRect) rfb._handleRect = handleRect;
    if (rfb._framebufferUpdate === observedUpdate) rfb._framebufferUpdate = update;
  };
}
