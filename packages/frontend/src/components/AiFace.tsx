import { useState, type HTMLAttributes } from "react";

import { formatAiAccessibleName } from "./AiTag";
import { OCTO_COIN_CLASS, OCTO_COIN_MARK_CLASS, OctoCoin } from "./OctoCoin";
import { OctoHatchling } from "./OctoHatchling";
import type { OctoMarkMotion } from "./OctoMark";
import { resolveAiFace, type AiFaceIdentity, type ResolvedAiFace } from "../utils/aiFace";
import { normalizeIdentityImageSrc } from "../utils/identityImageSrc";

/** Who the face is for (resolved by resolveAiFace), or a face resolved already: a picker's choice, an upload preview. */
type AiFaceSource = { identity: AiFaceIdentity; face?: never } | { face: ResolvedAiFace; identity?: never };

type AiFaceProps = AiFaceSource & {
  /** Size and placement only (h-8 w-8, h-full w-full, ...); the tile's look is fixed. */
  className?: string;
  /** inline-flex for a face that sits in a line of text; flex (block-level) otherwise. */
  inline?: boolean;
  /** Octo's thinking and scroll motion. Only Octo moves; every other face ignores both. */
  motion?: OctoMarkMotion;
  scrollReactive?: boolean;
  /**
   * The AI's name, for a face that stands alone with no name printed beside
   * it: the face is then an image named "<label>, AI" (formatAiAccessibleName).
   * Without it the face is decorative, as beside a printed name.
   */
  label?: string | null;
  testId?: string;
} & Omit<HTMLAttributes<HTMLSpanElement>, "className" | "title" | "children">;

/**
 * Any AI's face (docs/Brand.md, "One rule for faces" and "Octo's
 * hatchlings"), always on the AI tile, so a stack's ring utilities on the
 * slot (*:ring-1) land on the tile itself:
 * - Octo is OctoCoin, and the only face that takes motion;
 * - a picture is clipped to the tile, and if it fails to load the face
 *   behind it (resolveAiFace's fallback) takes its place;
 * - every other AI wears one of Octo's hatchlings at 75% of the tile, as
 *   Octo's mark sits, and an AI known only from text the hollow one.
 * The tile is Octo's own (OCTO_COIN_CLASS): white with the shared coin shadow
 * and the inside hairline in light, the reverse tile in dark.
 */
export function AiFace({
  identity,
  face,
  className,
  inline = false,
  motion,
  scrollReactive,
  label,
  testId,
  ...rest
}: AiFaceProps) {
  const resolved = face ?? resolveAiFace(identity ?? {});
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const name = label?.trim();
  const accessibility = name
    ? { role: "img", "aria-label": formatAiAccessibleName(name), "aria-hidden": undefined }
    : { "aria-hidden": true };
  const tileClassName = [inline ? "inline-flex" : "flex", OCTO_COIN_CLASS, className].filter(Boolean).join(" ");

  if (resolved.kind === "picture") {
    const src = normalizeIdentityImageSrc(resolved.src);
    if (src && src !== failedSrc) {
      return (
        <span {...accessibility} {...rest} data-testid={testId} className={tileClassName}>
          <img
            src={src}
            alt=""
            className="h-full w-full object-cover"
            decoding="async"
            draggable={false}
            onError={() => setFailedSrc(src)}
          />
        </span>
      );
    }
  }

  const drawn = resolved.kind === "picture" ? resolved.fallback : resolved;
  if (drawn.kind === "octo") {
    return (
      <OctoCoin
        {...accessibility}
        {...rest}
        testId={testId}
        inline={inline}
        className={className}
        motion={motion}
        scrollReactive={scrollReactive}
      />
    );
  }
  return (
    <span {...accessibility} {...rest} data-testid={testId} className={tileClassName}>
      <OctoHatchling face={drawn.kind === "unknown" ? "unknown" : drawn.n} className={OCTO_COIN_MARK_CLASS} />
    </span>
  );
}
