/**
 * Dark-theme surface + border ladder for Studio.
 *
 * Rules, in order of how often they get broken:
 *
 * 1. Dark borders are NEUTRAL WHITE-ALPHA ONLY. Never `dark:border-slate-*`,
 *    `dark:border-zinc-*` or `dark:border-gray-*`. The dark surfaces are warm
 *    neutrals (canvas #141414 / rail #181818 / panel #1d1d1d) and the remapped
 *    slate ramp serves text and neutral accents. Hard-coded ramp borders can
 *    read stronger than the intended surface edge. White-alpha borders tint
 *    themselves from whatever surface is underneath and stay in family.
 *
 * 2. Border strength scales INVERSELY with elevation:
 *
 *      floating        5.5%   (--color-studio-dark-floating-border)
 *      divider         9.5%   (--color-studio-dark-divider)
 *      panel / active  10.5%  (--color-studio-dark-panel-border /
 *                              --color-studio-dark-active-border)
 *      raised control  13%    (--color-studio-dark-raised-control-border)
 *
 *    The higher something floats, the more it leans on its shadow instead of
 *    its edge — popovers and menus already read as detached, so a strong
 *    outline only adds noise.
 *
 * 3. `raised-control` is for SMALL controls (buttons, pills, chips, swatches).
 *    Large surfaces — panels, composers, cards, anything with a long
 *    horizontal edge — use the `panel` tier. The same alpha that looks crisp
 *    on a 32px pill reads as a hard rule across a full-width edge.
 *
 * 4. Always compose from the exported helper classes below. Do not re-derive
 *    colours inline (`dark:border-white/10`, hand-written `var(--…)` strings);
 *    if a combination is missing, add a helper here so the ladder stays the
 *    single source of truth.
 *
 * 5. Inside a floating surface (popover, menu), a nested element gets a border
 *    OR a background delta, never both. Content nested in a popover is flat
 *    (sections + dividers); promoted cards — sparingly, they are the popover's
 *    focal blocks — use `floating-raised` (lighter than the popover,
 *    borderless) so they read as sitting on top rather than as outlined
 *    holes. Semantic warning/danger tints are the exception — their border +
 *    fill pair is the meaning. Small controls keep their `raised-control`
 *    borders as usual.
 */

export const DARK_CANVAS_CLASS = "dark:bg-[var(--color-studio-dark-canvas)]";

export const DARK_DIVIDER_CLASS = "dark:bg-[var(--color-studio-dark-divider)]";
export const DARK_DIVIDER_BORDER_CLASS = "dark:border-[color:var(--color-studio-dark-divider)]";

export const DARK_RAIL_BG_CLASS = "dark:bg-[var(--color-studio-dark-rail)]";
export const DARK_RAIL_MUTED_BG_CLASS = "dark:bg-[var(--color-studio-dark-rail-muted)]";
export const DARK_RAIL_BLUR_BG_CLASS = "dark:bg-[var(--color-studio-dark-rail-blur)]";
export const DARK_RAIL_SURFACE_CLASS = `${DARK_RAIL_BG_CLASS} ${DARK_DIVIDER_BORDER_CLASS}`;

export const DARK_PANEL_BG_CLASS = "dark:bg-[var(--color-studio-dark-panel)]";
export const DARK_PANEL_STRONG_BG_CLASS = "dark:bg-[var(--color-studio-dark-panel-strong)]";
export const DARK_PANEL_SOFT_BG_CLASS = "dark:bg-[var(--color-studio-dark-panel-soft)]";
export const DARK_PANEL_BORDER_CLASS = "dark:border-[color:var(--color-studio-dark-panel-border)]";
export const DARK_PANEL_SURFACE_CLASS = `${DARK_PANEL_BG_CLASS} ${DARK_PANEL_BORDER_CLASS}`;

export const DARK_FLOATING_BG_CLASS = "dark:bg-[var(--color-studio-dark-floating)]";
export const DARK_FLOATING_SOLID_BG_CLASS = "dark:bg-[var(--color-studio-dark-floating-solid)]";
export const DARK_FLOATING_RAISED_BG_CLASS =
  "dark:bg-[var(--color-studio-dark-floating-raised)]";
export const DARK_FLOATING_SELECTION_CLASS =
  "dark:aria-[current=page]:bg-[var(--color-studio-dark-floating-raised)]";
export const DARK_FLOATING_BORDER_CLASS = "dark:border-[color:var(--color-studio-dark-floating-border)]";
export const DARK_FLOATING_SURFACE_CLASS = `${DARK_FLOATING_BG_CLASS} ${DARK_FLOATING_BORDER_CLASS}`;

export const DARK_RAISED_CONTROL_BG_CLASS = "dark:bg-[var(--color-studio-dark-raised-control)]";
export const DARK_RAISED_CONTROL_BORDER_CLASS =
  "dark:border-[color:var(--color-studio-dark-raised-control-border)]";
export const DARK_RAISED_CONTROL_CLASS =
  `${DARK_RAISED_CONTROL_BG_CLASS} ${DARK_RAISED_CONTROL_BORDER_CLASS}`;

export const DARK_ACTIVE_BG_CLASS = "dark:bg-[var(--color-studio-dark-active)]";
export const DARK_ACTIVE_BORDER_CLASS = "dark:border-[color:var(--color-studio-dark-active-border)]";
export const DARK_ACTIVE_RING_CLASS = "dark:ring-[color:var(--color-studio-dark-active-border)]";
export const DARK_ACTIVE_SURFACE_CLASS = `${DARK_ACTIVE_BG_CLASS} ${DARK_ACTIVE_BORDER_CLASS}`;

export const DARK_RAIL_HOVER_CLASS =
  "dark:hover:bg-[var(--color-studio-dark-rail-hover)] dark:data-[hovered]:bg-[var(--color-studio-dark-rail-hover)]";

export const DARK_CONTROL_HOVER_CLASS =
  "dark:hover:bg-[var(--color-studio-dark-control-hover)] dark:data-[hovered]:bg-[var(--color-studio-dark-control-hover)]";

export const DARK_PANEL_SHADOW_CLASS = "dark:[box-shadow:var(--shadow-studio-dark-panel)]";

export const DARK_FLOATING_SHADOW_CLASS = "dark:[box-shadow:var(--shadow-studio-dark-floating)]";

export const DARK_INSET_HIGHLIGHT_CLASS = "dark:[box-shadow:var(--shadow-studio-dark-inset)]";
