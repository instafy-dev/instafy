// Cub on the landing hero: the lazily loaded half of LandingCub.tsx.
//
// mountLandingCub() creates the engine in the hero's creature layer and
// adapts it to the real page:
// - anchors: the studio window, its panels, coins, messages and chrome, and
//   the hero's copy and controls, found by their data-cub-anchor attributes
//   and measured relative to the layer whenever the engine lays out;
// - paint: the exact backgrounds Cub's opaque body crosses (paper outside the
//   conversation panel, the panel inside it) per theme, the pen, and the crew
//   ink in logo order;
// - reactions: the coin press and pop, and the hover cursor, as data
//   attributes React does not own (data-cub-press, data-cub-pop on Octo's
//   roster coin, data-cub-hot on the hero); every one is removed on destroy;
// - notices: a fine-pointer hover or keyboard focus on the primary CTA.
// Nothing here runs before LandingCub.tsx imports it after first paint.

import { DEFAULT_THEME_DARK, DEFAULT_THEME_LIGHT } from "./cubConfig";
import { anchorsFromElements } from "./cubDomAnchors";
import { createCub } from "./cubEngine";
import type {
  CubAnchors,
  CubDebugOptions,
  CubGlStatus,
  CubHandle,
  CubLayoutTuning,
  CubTheme,
  CubTurn,
} from "./cubTypes";
import { CREW_DARK_LIFT, CREW_SLOTS } from "../landingCrew";
import { LANDING_CUB_TIMELINE } from "./landingCubTimeline";

export type LandingCubThemeMode = "light" | "dark";

/**
 * The perch rules against the landing's deck. The phone perch starts where
 * the page switches to its phone layout (Tailwind md, 768 px: chips in a
 * column beside Cub's cell, the phone bar on the window). From 1000 px Cub
 * perches on the window's corner, right of the roster, which lies in the
 * window's top bar just under the ledge and stops short of the corner to
 * leave him room (landingStudioChrome.ts TOP_BAR), as in the approved hero.
 * Both widths are only fallbacks: the page says which layout its media
 * queries chose (measureLandingAnchors: mobile and corner).
 */
export const LANDING_CUB_LAYOUT: Partial<CubLayoutTuning> = {
  mobileBreakpoint: 768,
  cornerCoinDepth: null,
  // Like the prototype, narrow desktop windows put Cub along the top of the
  // window (the header perch), clear of the tab strip's corner actions.
  cornerMinWidth: 1000,
};

/**
 * The colours behind and of Cub, per theme. paper is the marketing canvas
 * (--marketing-canvas), surface the conversation panel (bg-white, and the
 * studio's dark panel --color-studio-dark-panel), pen Cub's line, crew the ink
 * in logo order (the light set, and --crew-N's dark lift in dark).
 * landingCub.test.ts keeps paper and surface equal to tailwind.css.
 */
export const LANDING_CUB_THEME: Readonly<Record<LandingCubThemeMode, CubTheme>> = {
  light: {
    mode: "light",
    paper: "#F8F8F6",
    surface: "#FFFFFF",
    pen: DEFAULT_THEME_LIGHT.pen,
    crew: [CREW_SLOTS[0].fill, CREW_SLOTS[1].fill, CREW_SLOTS[2].fill, CREW_SLOTS[3].fill],
  },
  dark: {
    mode: "dark",
    paper: "#141414",
    surface: "#1D1D1D",
    pen: DEFAULT_THEME_DARK.pen,
    crew: CREW_DARK_LIFT,
  },
};

/**
 * How long the deck's first turn waits on Cub (ms): for his first frame once
 * the engine is mounted (and, in LandingCub.tsx, for the engine to mount), and
 * for his hello once he draws. He is normally ready for the turn about 2.9 s
 * after his first frame (the arm then sets out just after the hello's wave).
 */
export const LANDING_CUB_WAIT = { firstFrame: 3_000, hello: 5_000 } as const;

/** Switches the owner's local playground can flip (dev builds only). */
export interface LandingCubDevOptions {
  eyes?: boolean;
  clickInk?: boolean;
  splash?: "apart" | "together";
  /** Skip WebGL and show the fallback still. */
  noGl?: boolean;
  overlay?: boolean;
  /** One deterministic frame at sim time t and turn time td (seconds). */
  still?: { t: number; td: number | null } | null;
  /** The pose the fallback sprites are captured in (no front arms); see scripts/capture-cub-fallback.mjs. */
  fallbackPose?: boolean;
}

export interface LandingCubSettings {
  theme: LandingCubThemeMode;
  reducedMotion: boolean;
  /** performance.now() at beat 0 of the playing turn, or null while it does not play. */
  turnStartedAt: number | null;
  /** Octo's coin pops (LANDING_CUB_POP_BEATS of a playing turn); shown only while Cub is drawing. */
  coinPop: boolean;
}

export interface LandingCubController {
  readonly handle: CubHandle;
  destroy(): void;
  setTheme(mode: LandingCubThemeMode): void;
  setReducedMotion(on: boolean): void;
  setTurnStartedAt(startedAt: number | null): void;
  setCoinPop(on: boolean): void;
  /** Lay out again (a scenario or text change). */
  relayout(): void;
  /** A visitor picked a scenario: a glance at the opener. */
  noticeChip(): void;
}

const anchor = (name: string) => `[data-cub-anchor="${name}"]`;
const FINE_POINTER = "(hover: hover) and (pointer: fine)";

/** Rendered (not display: none, inside a rendered parent). */
const shown = (el: Element | null | undefined): el is HTMLElement => !!el && el.getClientRects().length > 0;

/**
 * Measures Cub's anchors on the landing, relative to the layer. Returns null
 * until the window and the active scenario are laid out.
 */
export function measureLandingAnchors(hero: HTMLElement, layer: HTMLElement): CubAnchors | null {
  const one = (name: string, root: ParentNode = hero) => root.querySelector<HTMLElement>(anchor(name));
  const all = (name: string, root: ParentNode = hero) => [...root.querySelectorAll<HTMLElement>(anchor(name))];
  const win = one("window");
  const panel = one("panel");
  const transcript = one("transcript");
  if (!shown(win) || !panel || !transcript) return null;
  // Scenario copy is stacked in one grid cell; only the active cell counts.
  const active = transcript.querySelector<HTMLElement>('[data-scenario-copy="active"]');
  const floor = active ? one("floor", active) : null;
  const titleRow = all("title", win).find(shown) ?? null;
  const composer = one("composer", win);
  const coins = all("coin", win);
  const octoCoin = win.querySelector<HTMLElement>('[data-roster-coin="octo"]');
  if (!active || !floor || !titleRow || !composer || !octoCoin || !coins.length) return null;
  const chipsGroup = one("chips");
  // The window's top bar says which layout the page rendered: the phone bar
  // below Tailwind md, the tab strip from md. md sees the whole viewport, the
  // layer does not (a classic scrollbar), so the page decides, not a width.
  const phoneBar = all("topbar", win).find((el) => el.dataset.cubLayout === "phone");
  const a = anchorsFromElements(layer, {
    window: win,
    panel,
    transcript,
    floor,
    titleRow,
    composer,
    coins,
    octoCoin,
    text: [one("headline"), one("sub")],
    cta: one("cta"),
    keepOut: [one("cta-secondary"), ...all("keep-out")],
    // The glyphs, not their 40-48 px buttons: arms and ink keep out of them.
    chrome: all("action", win)
      .filter(shown)
      .map((el) => el.querySelector("svg") ?? el),
    chips: chipsGroup ? [...chipsGroup.querySelectorAll<HTMLElement>("button")] : [],
    poi: {
      own: one("own", active),
      octoMessage: one("octo-message", active),
      file: one("file", active),
      title: one("headline"),
    },
  });
  a.mobile = shown(phoneBar);
  // Likewise the corner: the top bar's own media query left Cub room on the
  // window's corner or not (landingStudioChrome.ts TOP_BAR, --cub-perch).
  const tabStrip = all("topbar", win).find((el) => el.dataset.cubLayout !== "phone" && shown(el));
  const view = hero.ownerDocument.defaultView;
  const perch = tabStrip && view ? view.getComputedStyle(tabStrip).getPropertyValue("--cub-perch").trim() : "";
  if (perch === "corner" || perch === "header") a.corner = perch === "corner";
  // The top bar (tab strip or phone bar) takes the panel's surface in both
  // themes, so the whole workspace, bar included, is Cub's surface fill.
  return a;
}

function turnOf(startedAt: number | null): CubTurn {
  return startedAt == null ? { live: false } : { live: true, startedAt };
}

export function mountLandingCub({
  layer,
  hero,
  settings,
  dev,
  onReady,
}: {
  /** The empty, absolutely positioned layer Cub draws in (position + overflow hidden, no z-index of its own). */
  layer: HTMLElement;
  /** The hero section: anchors are looked up inside it, the hover cursor is set on it. */
  hero: HTMLElement;
  settings: LandingCubSettings;
  dev?: LandingCubDevOptions | null;
  /**
   * Called once when the deck's first turn may start: Cub has said hello, or
   * he will not (no WebGL, a lost context), so the visitor never waits on him.
   */
  onReady?: () => void;
}): LandingCubController {
  let mode = settings.theme;
  let coinPop = settings.coinPop;
  let reduced = settings.reducedMotion;
  let status: CubGlStatus = "wait";
  const win = hero.ownerDocument.defaultView;
  const octoCoin = () => hero.querySelector<HTMLElement>('[data-roster-coin="octo"]');
  const setAttr = (el: Element | null, name: string, on: boolean) => {
    if (el && el.hasAttribute(name) !== on) el.toggleAttribute(name, on);
  };
  // The pop follows the deck's beats, but only while Cub is drawing and moving.
  const syncPop = () => setAttr(octoCoin(), "data-cub-pop", coinPop && status === "on" && !reduced);
  // Cub fades in over a few frames the first time he draws, rather than
  // snapping in over a settled page (not under reduced motion). The fade runs
  // on his own canvases, never on the layer: an animating opacity there would
  // isolate the ink's multiply from the page for its duration.
  let revealed = false;
  const reveal = () => {
    if (revealed) return;
    revealed = true;
    if (reduced) return;
    for (const el of Array.from(layer.children))
      if (el instanceof HTMLElement && typeof el.animate === "function")
        el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 180, easing: "ease-out" });
  };
  // The first turn waits for the hello, but never long on a Cub who is slow
  // to draw his first frame, or to get through his hello.
  let ready = false;
  let readyTimer: ReturnType<typeof setTimeout> | undefined;
  const markReady = () => {
    clearTimeout(readyTimer);
    if (ready) return;
    ready = true;
    onReady?.();
  };
  readyTimer = setTimeout(markReady, LANDING_CUB_WAIT.firstFrame);

  const debug: CubDebugOptions | false = import.meta.env.DEV
    ? { overlay: !!dev?.overlay, noGl: !!dev?.noGl, fallbackPose: !!dev?.fallbackPose }
    : false;

  const handle = createCub(layer, {
    anchors: () => measureLandingAnchors(hero, layer),
    theme: LANDING_CUB_THEME[mode],
    reducedMotion: reduced,
    turn: turnOf(settings.turnStartedAt),
    timeline: LANDING_CUB_TIMELINE,
    layout: LANDING_CUB_LAYOUT,
    // The no-WebGL stills load only when they are needed (generated by
    // scripts/capture-cub-fallback.mjs from this page).
    fallback: () => import("./landingCubFallback").then((m) => m.LANDING_CUB_FALLBACK),
    // The roster row sits at z-[4] above the layer, so the arm taps under the coin.
    zIndex: 3,
    eyes: dev?.eyes ?? true,
    clickInk: dev?.clickInk ?? true,
    splash: dev?.splash ?? "apart",
    still: import.meta.env.DEV ? (dev?.still ?? null) : null,
    debug,
    onCoinPress: (pressed) => setAttr(octoCoin(), "data-cub-press", pressed),
    onHotChange: (hot) => setAttr(hero, "data-cub-hot", hot),
    onStatus: (next) => {
      status = next;
      if (next !== "wait") reveal();
      if (next === "off") markReady();
      else if (next === "on" && !ready) {
        clearTimeout(readyTimer);
        readyTimer = setTimeout(markReady, LANDING_CUB_WAIT.hello);
      }
      syncPop();
    },
    onReadyForTurn: markReady,
  });

  // The primary CTA: Cub glances at it on a fine-pointer hover or a keyboard
  // focus (rate-limited inside the engine). Delegated, so a re-rendered link
  // keeps working.
  const ac = new AbortController();
  const fine = win && typeof win.matchMedia === "function" ? win.matchMedia(FINE_POINTER) : null;
  const ctaOf = (target: EventTarget | null) =>
    target instanceof Element ? target.closest<HTMLElement>(anchor("cta")) : null;
  hero.addEventListener(
    "pointerover",
    (event) => {
      const cta = ctaOf(event.target);
      if (!cta || event.pointerType !== "mouse" || !fine?.matches) return;
      if (event.relatedTarget instanceof Node && cta.contains(event.relatedTarget)) return;
      handle.notice("cta");
    },
    { signal: ac.signal },
  );
  hero.addEventListener(
    "focusin",
    (event) => {
      const cta = ctaOf(event.target);
      if (cta && cta === event.target && cta.matches(":focus-visible")) handle.notice("cta");
    },
    { signal: ac.signal },
  );

  return {
    handle,
    destroy() {
      ac.abort();
      clearTimeout(readyTimer);
      handle.destroy();
      setAttr(octoCoin(), "data-cub-press", false);
      setAttr(octoCoin(), "data-cub-pop", false);
      setAttr(hero, "data-cub-hot", false);
    },
    setTheme(next) {
      if (next === mode) return;
      mode = next;
      handle.setTheme(LANDING_CUB_THEME[next]);
    },
    setReducedMotion(on) {
      reduced = on;
      handle.setReducedMotion(on);
      syncPop();
    },
    setTurnStartedAt(startedAt) {
      handle.setTurn(turnOf(startedAt));
    },
    setCoinPop(on) {
      coinPop = on;
      syncPop();
    },
    relayout() {
      handle.relayout();
    },
    noticeChip() {
      handle.notice("chip");
    },
  };
}
