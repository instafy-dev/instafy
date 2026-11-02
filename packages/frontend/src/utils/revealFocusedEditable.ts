/** Reveal the existing editor inside its own scroll area without moving focus
 * or scrolling the surrounding page. Call on viewport/layout changes only, so
 * ordinary scrolling away from the focused field remains possible. */
export function revealFocusedEditable(scroller: HTMLElement | null, {
  inset = 4,
  context,
}: { inset?: number; context?: HTMLElement | null } = {}) {
  const field = document.activeElement;
  if (!(field instanceof HTMLElement) || !scroller?.contains(field) ||
    !field.matches("input, textarea, select, [contenteditable='true'], [contenteditable='']")) return;
  const visible = scroller.getBoundingClientRect();
  const focused = field.getBoundingClientRect();
  if (visible.height <= 0 || focused.height <= 0) return;
  const top = visible.top + inset;
  const bottom = visible.bottom - inset;
  // Prefer the whole editing task (for example, field and Send) when it fits;
  // very short screens still prioritize the field and allow ordinary scroll.
  const contextBounds = context?.contains(field) ? context.getBoundingClientRect() : null;
  const target = contextBounds && contextBounds.height > 0 && contextBounds.height <= bottom - top
    ? contextBounds : focused;
  if (target.top < top || target.height > bottom - top) {
    scroller.scrollTop += target.top - top;
  } else if (target.bottom > bottom) {
    scroller.scrollTop += target.bottom - bottom;
  }
}
