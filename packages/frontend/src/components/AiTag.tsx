/**
 * The studio's quiet tag: 10px medium text on a faint fill with a small
 * radius. The participants drawer marks a runtime's kind with it ("Shared",
 * "Native"), and the AI word below reuses it. The fill is translucent, so the
 * tag still reads on a hovered or highlighted row.
 */
export const QUIET_TAG_CLASS =
  "shrink-0 rounded bg-slate-200/70 px-1.5 py-px text-3xs font-medium text-slate-600 dark:bg-white/10 dark:text-slate-300";

/**
 * The word for an AI (docs/Brand.md, "One rule for faces"): a quiet tag after
 * an AI's name, only in lists that mix people and AI (the @-mention picker,
 * the participants drawer, profile cards). Never in thread rows or inside
 * sentences, where the AI's rounded-square face already says it.
 *
 * The ", " before the word is for screen readers only, so a row's accessible
 * name reads "Pia, AI" rather than "Pia AI".
 */
export function AiTag({ className }: { className?: string }) {
  return (
    <span data-testid="ai-tag" className={[QUIET_TAG_CLASS, className].filter(Boolean).join(" ")}>
      <span className="sr-only">, </span>
      AI
    </span>
  );
}

/** An AI face's or row's accessible name: "Pia, AI". */
export function formatAiAccessibleName(name: string): string {
  return `${name}, AI`;
}
