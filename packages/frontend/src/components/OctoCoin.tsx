import type { HTMLAttributes } from "react";

import { OctoMark, type OctoMarkMotion } from "./OctoMark";

/**
 * Octo's coin: the canonical Octo avatar, a circular coin holding the one-ink
 * mark (docs/Brand.md, "Octo agent avatar/chip"). Every themed surface that
 * shows Octo as a participant draws this component (chat avatars, typing rows,
 * speaker pills, agent chips and pickers, the landing's roster and
 * transcript), so the coin is styled here and nowhere else.
 *
 * - Light: a white coin edged only by the soft avatar coin shadow every
 *   avatar coin shares (`shadow-avatar-coin`), and the brand-ink mark.
 * - Dark: a neutral raised coin (`--color-octo-coin-dark`), a faint light ring
 *   (`--color-octo-coin-ring-dark`, an inset shadow on the coin itself) and
 *   the brand-paper mark.
 *
 * The mark fills 75% of the coin, so its arms stay clear of the edge from
 * 20px to 64px and through the thinking stroke. The coin is not positioned,
 * so in an overlapping avatar stack tree order still decides which face
 * covers which. There is no border; a caller that stacks coins adds its own
 * separator outside the coin. The mark is always the one-ink colorway, never
 * crew nodes.
 */
export const OCTO_COIN_CLASS = [
  "shrink-0 items-center justify-center overflow-hidden rounded-full",
  "bg-white dark:bg-octo-coin-dark",
  "shadow-avatar-coin",
  "dark:shadow-[inset_0_0_0_1px_var(--color-octo-coin-ring-dark)]",
].join(" ");

/** The mark inside the coin: 75% of the coin, positive ink on light, reverse on dark. */
export const OCTO_COIN_MARK_CLASS = "h-3/4 w-3/4 text-brand-ink dark:text-brand-paper";

type OctoCoinProps = {
  /** Size and placement only (h-8 w-8, self-center, ...); the coin's look is fixed. */
  className?: string;
  /** inline-flex for coins that sit in a line of text; flex (block-level) otherwise. */
  inline?: boolean;
  motion?: OctoMarkMotion;
  scrollReactive?: boolean;
  /** The mark's accessible name; the coin itself is decorative (aria-hidden). */
  title?: string;
  testId?: string;
} & Omit<HTMLAttributes<HTMLSpanElement>, "className" | "title" | "children">;

export function OctoCoin({
  className,
  inline = false,
  motion = "idle",
  scrollReactive = false,
  title = "Octo",
  testId,
  ...rest
}: OctoCoinProps) {
  return (
    <span
      aria-hidden="true"
      {...rest}
      data-testid={testId}
      data-octo-coin=""
      className={[inline ? "inline-flex" : "flex", OCTO_COIN_CLASS, className].filter(Boolean).join(" ")}
    >
      <OctoMark
        className={OCTO_COIN_MARK_CLASS}
        colorway="ink"
        motion={motion}
        scrollReactive={scrollReactive}
        title={title}
      />
    </span>
  );
}
