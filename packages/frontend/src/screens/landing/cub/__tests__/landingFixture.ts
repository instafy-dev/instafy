// The landing's own layout, captured from the page (measureLandingAnchors,
// light, deviceScaleFactor 2) at desktop, header and phone widths.
import raw from "./fixtures/landingLayout.json";
import { inkSize } from "../cubInkLayer";
import { applyLayout } from "../cubLayout";
import { createCubState, resolveOptions, type Cub } from "../cubState";
import type { CubAnchors, CubPerchMode } from "../cubTypes";
import { LANDING_CUB_LAYOUT } from "../landingCub";
import { LANDING_CUB_TIMELINE } from "../landingCubTimeline";

export const LANDING_LAYOUTS = raw as unknown as Record<
  string,
  { dpr: number; mode: CubPerchMode; anchors: CubAnchors & { width: number; height: number } }
>;

/** A CPU-only Cub laid out on the landing at size (for example "1440x900"), between turns. */
export function landingCubAt(size: string): Cub {
  const fx = LANDING_LAYOUTS[size];
  const c = createCubState(resolveOptions({ timeline: LANDING_CUB_TIMELINE, layout: LANDING_CUB_LAYOUT, still: { t: 30, td: null } }));
  applyLayout(c, fx.anchors, fx.anchors.width, fx.anchors.height, fx.dpr, true);
  c.built = true;
  inkSize(c);
  return c;
}
