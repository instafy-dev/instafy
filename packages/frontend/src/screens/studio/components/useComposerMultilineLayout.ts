import { useLayoutEffect, useState, type RefObject } from "react";

/** Measure the existing editor without copying its contents or remounting it. */
export function useComposerMultilineLayout(
  rowRef: RefObject<HTMLDivElement | null>,
  enabled: boolean,
): boolean {
  const [multiline, setMultiline] = useState(false);

  useLayoutEffect(() => {
    const row = rowRef.current;
    const editor = row?.querySelector<HTMLElement>('[data-testid="chat-input"]');
    const leading = row?.querySelector<HTMLElement>('[data-testid="chat-composer-leading-controls"]');
    const trailing = row?.querySelector<HTMLElement>('[data-testid="chat-composer-trailing-controls"]');
    if (!enabled || !row || !editor || !leading || !trailing) {
      setMultiline(false);
      return;
    }

    let frame: number | null = null;
    const measure = () => {
      frame = null;
      const rowWidth = row.getBoundingClientRect().width;
      if (rowWidth <= 0) return;
      const style = window.getComputedStyle(editor);
      const lineHeight = Number.parseFloat(style.lineHeight);
      if (!Number.isFinite(lineHeight)) return;
      const paddingY = Number.parseFloat(style.paddingTop) + Number.parseFloat(style.paddingBottom);
      const hasMultipleLines = editor.childElementCount > 1 || editor.scrollHeight - paddingY > lineHeight + 1;
      if (hasMultipleLines) {
        setMultiline(true);
        return;
      }

      // Widening a wrapped draft can make it one line. Only collapse if that
      // line also fits beside the controls; current editor height alone would
      // alternate between the two layouts indefinitely near the wrap boundary.
      const gap = Number.parseFloat(window.getComputedStyle(row).columnGap) || 0;
      const inlineWidth = rowWidth - leading.getBoundingClientRect().width -
        trailing.getBoundingClientRect().width - 2 * gap -
        Number.parseFloat(style.paddingLeft) - Number.parseFloat(style.paddingRight);
      const range = document.createRange();
      range.selectNodeContents(editor.firstElementChild ?? editor);
      const textWidth = range.getBoundingClientRect().width;
      setMultiline((previous) => textWidth <= inlineWidth - 1 ? false : previous);
    };
    const schedule = () => {
      if (frame === null) frame = window.requestAnimationFrame(measure);
    };
    const resize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
    for (const node of [row, editor, leading, trailing]) resize?.observe(node);
    // Lexical applies restored drafts after the parent layout effect, and
    // shortening a single line need not resize the editor at all.
    const mutations = new MutationObserver(schedule);
    mutations.observe(editor, { childList: true, characterData: true, subtree: true });
    measure();
    return () => {
      resize?.disconnect();
      mutations.disconnect();
      if (frame !== null) window.cancelAnimationFrame(frame);
    };
  }, [enabled, rowRef]);

  return enabled && multiline;
}
