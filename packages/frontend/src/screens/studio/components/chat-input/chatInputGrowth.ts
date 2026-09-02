// The composer textarea grows with its content and then scrolls inside. The
// cap is a line count, not a pixel budget: with the keyboard up on a phone
// the vertical space is the scarce thing, so narrow viewports stop earlier.
export const CHAT_INPUT_LINE_HEIGHT_PX = 20;
export const CHAT_INPUT_MAX_LINES_COMPACT_VIEWPORT = 6;
export const CHAT_INPUT_MAX_LINES_WIDE_VIEWPORT = 10;

// Mirrors the editor's `py-1 sm:py-0.5` padding so the pixel cap lands on a
// whole line count once box-sizing folds the padding in.
export const CHAT_INPUT_VERTICAL_PADDING_COMPACT_VIEWPORT_PX = 8;
export const CHAT_INPUT_VERTICAL_PADDING_WIDE_VIEWPORT_PX = 4;

export function resolveChatInputMaxLines({ compactViewport }: { compactViewport: boolean }): number {
  return compactViewport
    ? CHAT_INPUT_MAX_LINES_COMPACT_VIEWPORT
    : CHAT_INPUT_MAX_LINES_WIDE_VIEWPORT;
}

export function resolveChatInputMaxHeightPx({ compactViewport }: { compactViewport: boolean }): number {
  const padding = compactViewport
    ? CHAT_INPUT_VERTICAL_PADDING_COMPACT_VIEWPORT_PX
    : CHAT_INPUT_VERTICAL_PADDING_WIDE_VIEWPORT_PX;
  return resolveChatInputMaxLines({ compactViewport }) * CHAT_INPUT_LINE_HEIGHT_PX + padding;
}
