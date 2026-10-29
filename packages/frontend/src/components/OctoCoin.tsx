import type { HTMLAttributes } from "react";

import { OctoMark, type OctoMarkMotion } from "./OctoMark";

/**
 * One rule for faces (docs/Brand.md, "One rule for faces"): every AI is a
 * rounded square and every person is a circle. Octo, its helpers and saved
 * agents all wear this shape; people (HumanAvatar) never do.
 *
 * The radius is 30% of the face at every size, the full slot with no inset.
 * Plain border-radius only: corner-shape squircles fall back to circles in
 * WebKit.
 */
export const AI_TILE_SHAPE_CLASS = "rounded-[30%]";

/**
 * The AI tile's edge: a 1px hairline drawn just inside the tile (an outline,
 * so it paints over an uploaded picture and never fights a stack's separator
 * ring), ink at 14% in light and the faint light ring in dark. It keeps a
 * white tile's corners visible on white, where the shared coin shadow alone
 * fades out at 20px.
 */
export const AI_TILE_EDGE_CLASS = "outline-1 -outline-offset-1 outline-ai-tile-edge dark:outline-octo-coin-ring-dark";

/** Shape and edge of every AI face; fills and contents are the caller's. */
export const AI_TILE_CLASS = `${AI_TILE_SHAPE_CLASS} ${AI_TILE_EDGE_CLASS}`;

/**
 * Octo's tile: the canonical Octo avatar, a white rounded square holding the
 * one-ink mark (docs/Brand.md, "Octo agent avatar/chip"). Every themed surface
 * that shows Octo as a participant draws this component (chat avatars, typing
 * rows, agent chips and pickers, the landing's roster and transcript), so the tile is styled here and nowhere else. (The component
 * keeps its historical name, OctoCoin, and its data-octo-coin hook.)
 *
 * - Light: a white tile edged by the soft avatar coin shadow every avatar
 *   shares (`shadow-avatar-coin`) and the AI tile's ink hairline, and the
 *   brand-ink mark.
 * - Dark: a neutral raised tile (`--color-octo-coin-dark`), the faint light
 *   ring (`--color-octo-coin-ring-dark`) as its hairline, and the brand-paper
 *   mark.
 *
 * The mark fills 75% of the tile, so its arms stay clear of the edge from
 * 20px to 64px and through the thinking stroke. The tile is not positioned,
 * so in an overlapping avatar stack tree order still decides which face
 * covers which. There is no border; a caller that stacks faces adds its own
 * separator ring on the face, which follows the tile's corners. The mark is
 * always the one-ink colorway, never crew nodes.
 */
export const OCTO_COIN_CLASS = [
  `shrink-0 items-center justify-center overflow-hidden ${AI_TILE_SHAPE_CLASS}`,
  "bg-white dark:bg-octo-coin-dark",
  "shadow-avatar-coin",
  AI_TILE_EDGE_CLASS,
].join(" ");

/** The mark inside the tile: 75% of the tile, positive ink on light, reverse on dark. */
export const OCTO_COIN_MARK_CLASS = "h-3/4 w-3/4 text-brand-ink dark:text-brand-paper";

type OctoCoinProps = {
  /** Size and placement only (h-8 w-8, self-center, ...); the tile's look is fixed. */
  className?: string;
  /** inline-flex for a tile that sits in a line of text; flex (block-level) otherwise. */
  inline?: boolean;
  motion?: OctoMarkMotion;
  scrollReactive?: boolean;
  /** The mark's accessible name; the tile itself is decorative (aria-hidden). */
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
