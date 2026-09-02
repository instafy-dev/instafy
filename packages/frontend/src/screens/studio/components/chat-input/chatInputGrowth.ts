// The composer textarea grows with its content and then scrolls inside. The
// cap is a line count, not a pixel budget: with the keyboard up on a phone
// the vertical space is the scarce thing, so narrow viewports stop earlier.
export const CHAT_INPUT_LINE_HEIGHT_PX = 20;
export const CHAT_INPUT_MAX_LINES_COMPACT_VIEWPORT = 6;
export const CHAT_INPUT_MAX_LINES_WIDE_VIEWPORT = 10;

// The row's controls are IconButton size="md": 36px (h-9) on a fine pointer,
// 44px (pointer-coarse:min-h-11) on a coarse one. The editor pads each side
// by (control − line) / 2 so a single line's centre sits on the control
// centres — and, because the row is items-end and the editor grows upward,
// so does the LAST line's centre once the draft wraps. Both sides together
// are what box-sizing folds into the pixel cap.
export const CHAT_INPUT_CONTROL_HEIGHT_FINE_POINTER_PX = 36;
export const CHAT_INPUT_CONTROL_HEIGHT_COARSE_POINTER_PX = 44;
export const CHAT_INPUT_VERTICAL_PADDING_FINE_POINTER_PX =
  (CHAT_INPUT_CONTROL_HEIGHT_FINE_POINTER_PX - CHAT_INPUT_LINE_HEIGHT_PX) / 2;
export const CHAT_INPUT_VERTICAL_PADDING_COARSE_POINTER_PX =
  (CHAT_INPUT_CONTROL_HEIGHT_COARSE_POINTER_PX - CHAT_INPUT_LINE_HEIGHT_PX) / 2;

// The classes that put those numbers on the editor: the control height as a
// minimum (on the editor, and on its wrapper in the composer row), the
// padding on each side (py-2 = 8px, py-3 = 12px), and the same top offset
// for the overlays — placeholder, ghost remainder, recording indicator —
// that sit on the first line. `pointer-coarse:` is Tailwind's
// `@media (pointer: coarse)`; the JS cap reads the same query through
// useCoarsePointer so the padding and the cap flip together.
export const CHAT_INPUT_CONTROL_HEIGHT_CLASS = "min-h-9 pointer-coarse:min-h-11";
export const CHAT_INPUT_VERTICAL_PADDING_CLASS = "py-2 pointer-coarse:py-3";
export const CHAT_INPUT_OVERLAY_TOP_CLASS = "top-2 pointer-coarse:top-3";

export function resolveChatInputMaxLines({ compactViewport }: { compactViewport: boolean }): number {
  return compactViewport
    ? CHAT_INPUT_MAX_LINES_COMPACT_VIEWPORT
    : CHAT_INPUT_MAX_LINES_WIDE_VIEWPORT;
}

export function resolveChatInputVerticalPaddingPx({ coarsePointer }: { coarsePointer: boolean }): number {
  return coarsePointer
    ? CHAT_INPUT_VERTICAL_PADDING_COARSE_POINTER_PX
    : CHAT_INPUT_VERTICAL_PADDING_FINE_POINTER_PX;
}

export function resolveChatInputMaxHeightPx({
  compactViewport,
  coarsePointer,
}: {
  compactViewport: boolean;
  coarsePointer: boolean;
}): number {
  return (
    resolveChatInputMaxLines({ compactViewport }) * CHAT_INPUT_LINE_HEIGHT_PX +
    2 * resolveChatInputVerticalPaddingPx({ coarsePointer })
  );
}
