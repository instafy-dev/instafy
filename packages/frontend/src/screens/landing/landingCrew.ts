// The landing's crew palette: one colour per participant, in roster order,
// matching the logo's nodes left to right (docs/Brand.md). Coins, pills and
// cursors are inline styles, so these fill and label pairs are fixed: they keep
// the light set in both themes, and each label colour is the one that reads on
// its fill (ink on pink and flame, white on green and violet).
//
// Octo is never a crew colour. Octo stays ink: the brand-ink mark on a white
// coin, or brand-ink / brand-paper through the theme classes.
//
// The theme-aware --crew-N variables in src/styles/tailwind.css carry the same
// light values (plus the dark lift below) for the logo's crew nodes. The
// hero's ink reads this file, not the variables (cub/landingCub.ts
// LANDING_CUB_THEME: the light set, the dark lift in dark).
// landingCrew.test.ts keeps every copy equal: the variables and the engine's
// own defaults (cub/cubConfig.ts DEFAULT_CREW_LIGHT / DEFAULT_CREW_DARK).

export interface CrewColor {
  /** Fill of a coin, pill or cursor arrow. */
  fill: string;
  /** Text drawn on that fill. */
  on: string;
}

const INK = "#0F172A";
const WHITE = "#FFFFFF";

/** Crew slots 1-4, left to right: pink, green, flame, violet. */
export const CREW_SLOTS: readonly [CrewColor, CrewColor, CrewColor, CrewColor] = [
  { fill: "#FF3C9F", on: INK },
  { fill: "#1B864B", on: WHITE },
  { fill: "#FA5815", on: INK },
  { fill: "#814AD0", on: WHITE },
];

/**
 * The dark-theme values of --crew-1..4: green and violet lift so the logo's
 * nodes and the ink read on dark surfaces. Never used for coins or pills,
 * whose white or ink labels need the light set.
 */
export const CREW_DARK_LIFT: readonly [string, string, string, string] = ["#FF3C9F", "#3CA063", "#FA5815", "#A672FA"];

/** Who holds which slot on the landing (roster order, Octo skipped). */
export const LANDING_CREW = {
  ada: CREW_SLOTS[0],
  kim: CREW_SLOTS[1],
  // The scenario's own agent (Quill, Canary or Pixel).
  agent: CREW_SLOTS[2],
} as const;
