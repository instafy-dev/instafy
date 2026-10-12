// Public contract of the Cub engine: the anchors the host measures, the theme,
// the turn clock, the options and the handle createCub() returns.

import type { CubTimeline, CubTurnSample } from "./cubTimeline";

/** A rect in CSS px relative to the host element's top-left corner. */
export interface CubRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Everything Cub needs to know about the page around it, in host-relative CSS
 * px. The host measures these (see cubDomAnchors.ts for DOM helpers) and hands
 * them over through options.anchors (a value or a resolver) or setAnchors().
 *
 * Mapping to the prototype's DOM: window = #win, panel = #win .main,
 * transcript = #tcol, floor = #mKim, titleRow = .ctitle, composer = #cbox,
 * coins = #roster .b (unscaled), textLines = per-line rects of #title and #sub,
 * cta = #cta, keepOut = [#cta2], chips = .chip.
 */
export interface CubAnchors {
  /** Host size; defaults to the host element's measured size. */
  width?: number;
  height?: number;
  /** The studio window frame. Its top edge is the ledge Cub sits on; its right end is the corner. */
  window: CubRect;
  /** The conversation panel: Cub's body is filled with theme.surface inside it and theme.paper outside. */
  panel: CubRect;
  /** The transcript column (front arms keep out of it below the floor). */
  transcript: CubRect;
  /** The first message: on desktop the floor front arms hang to (its top - 6 px), and a keep-out. */
  floor: CubRect;
  /** The conversation title row: a keep-out, the left bound of the header perch, and the phone floor. */
  titleRow: CubRect;
  /** The composer: how deep front arms may hang, and a gaze target. */
  composer: CubRect;
  /** Every roster coin in reading order, Octo's included, at their unscaled size. */
  coins: CubRect[];
  /** Index of Octo's coin in coins: the reach target. */
  octoCoin: number;
  /** Line rects of the headline and the sub copy (keep-outs; pointer over them suppresses attention). */
  textLines: CubRect[];
  /** The primary call to action: a keep-out and the glance target of notice("cta"). */
  cta?: CubRect | null;
  /** Other keep-out boxes: secondary CTAs, toolbars. They also keep Cub's body away (the perch moves). */
  keepOut?: CubRect[];
  /**
   * Small chrome on the window itself (the glyphs of tab-strip actions): arms
   * and ink keep out of them like they do of the coins, but Cub may perch
   * right above them.
   */
  chrome?: CubRect[];
  /** Scenario chips: keep-outs; their bounding box sizes the phone perch. */
  chips?: CubRect[];
  /**
   * The host shows its phone layout: Cub takes the phone perch. Defaults to a
   * host narrower than the tuning's mobileBreakpoint; a host that knows which
   * layout it rendered says so (its media queries see the viewport, scrollbar
   * included, while the host's width excludes a classic scrollbar).
   */
  mobile?: boolean;
  /**
   * The host left room for the corner perch (on a wide enough page its
   * window chrome stops short of the corner). Defaults to a host at least the
   * tuning's cornerMinWidth wide; a host whose media queries made the choice
   * says so, for the same reason as mobile. A corner that is not clear still
   * puts Cub along the header.
   */
  corner?: boolean;
  /** Things Cub glances at during the turn. Missing ones are skipped. */
  poi?: {
    /** Your message (the prompt). */
    own?: CubRect | null;
    /** Octo's answer while it works. */
    octoMessage?: CubRect | null;
    /** The file chip in Octo's answer. */
    file?: CubRect | null;
    /** The headline (a wander target). */
    title?: CubRect | null;
  };
}

/** Colours as #rrggbb. Cub's body is opaque: paper and surface must equal the real backgrounds behind it. */
export interface CubTheme {
  mode: "light" | "dark";
  /** Page canvas behind Cub's head (outside the panel). */
  paper: string;
  /** The conversation panel background. */
  surface: string;
  /** Cub's pen line. */
  pen: string;
  /** Crew ink, in logo order: pink, green, flame, violet (#rrggbb each). */
  crew: readonly [string, string, string, string];
}

/** The host's turn clock. */
export type CubTurn =
  | { live: false }
  /** td advances with performance.now(): startedAt is performance.now() (ms) at td = 0. */
  | { live: true; startedAt: number }
  /** A fixed turn time in seconds (paused or scrubbed). */
  | { live: true; td: number };

export type CubPerchMode = "corner" | "header" | "mobile";
export type CubGlStatus = "wait" | "on" | "off";

/** Why the WebGL renderer is not drawing. */
export type CubFallbackReason = "no-webgl2" | "init-failed" | "gbuffer-incomplete" | "context-lost";

export interface CubFallbackSprite {
  ink: string;
  inkDark: string;
  cov: string;
  /** CSS px size of the sprite, the perch size it was captured at, the body x and the ledge y inside it. */
  w: number;
  h: number;
  u: number;
  bx: number;
  ey: number;
}
export type CubFallbackSprites = Partial<Record<CubPerchMode, CubFallbackSprite>> & { corner: CubFallbackSprite };
/** Sprites, or a loader the engine calls the first time it needs them (a no-WebGL visitor only). */
export type CubFallbackSource = CubFallbackSprites | (() => Promise<CubFallbackSprites>);

/** Overrides for the perch maths (defaults are the prototype's numbers). */
export interface CubLayoutTuning {
  /** Desktop perch size u = clamp(min, width * k, max). */
  desktopU: { min: number; k: number; max: number };
  /** Phone perch size from the room between the chips and the window: clamp(min, min(room / aboveK, below / belowK), max). */
  mobileU: { min: number; aboveK: number; belowK: number; max: number };
  /** Hosts narrower than this use the phone perch. */
  mobileBreakpoint: number;
  /**
   * The corner perch keeps Cub to the right of the roster coins when they sit
   * on the ledge (the prototype). Coins whose top lies more than this many u
   * below the ledge (a window with a tab strip above its roster) do not push
   * him off the corner; the arms still keep out of them. null: always push.
   */
  cornerCoinDepth: number | null;
  /** Hosts narrower than this (css px) never use the corner perch: Cub sits along the window's top instead (unless the anchors say otherwise: CubAnchors.corner). */
  cornerMinWidth: number;
}

export interface CubOptions {
  /** Anchors, or a resolver the engine calls whenever it lays out (resize, fonts, relayout()). */
  anchors: CubAnchors | (() => CubAnchors | null);
  theme: CubTheme;
  reducedMotion?: boolean;
  /** Motion off renders the calm frame, like reduced motion. Default true. */
  motion?: boolean;
  /** Pointer attention (gaze, curious arm, shy flinch). Default true. */
  notice?: boolean;
  /** Turn choreography (cubTimeline.ts has the approved prototype's, PROTOTYPE_TIMELINE). */
  timeline: CubTimeline;
  /** Initial turn state (see setTurn). */
  turn?: CubTurn;
  /** Alternative to setTurn: called whenever the engine needs the turn time; seconds, or null when no turn plays. */
  getTurnTime?: () => number | null;
  /** Device pixel ratio caps. Default { desktop: 2, mobile: 3 }. */
  dprCap?: { desktop: number; mobile: number };
  layout?: Partial<CubLayoutTuning>;
  /** Splash pattern of the crew ink. Default "apart". */
  splash?: "apart" | "together";
  /** Draw the eyes and the smile. Default true (false is a review option). */
  eyes?: boolean;
  /** A click squirts crew ink. Default true; false keeps the boop without ink (a review option). */
  clickInk?: boolean;
  /** Pen width (silhouette) in css px. Default 2.15. */
  lineWidth?: number;
  /** z-index of the engine's layers. Default 3 (the debug overlay gets +5). */
  zIndex?: number;
  /** Elements matching this never count as hitting Cub. Default "a,button,input,textarea,select,[role=button]". */
  controlSelector?: string;
  /** Still sprites shown when WebGL is unavailable. */
  fallback?: CubFallbackSource | null;
  /** Render one deterministic frame at sim time t (seconds) and never animate; td is the turn time (default t, null: no turn). */
  still?: { t: number; td?: number | null } | null;
  /** Called with the coin press state while Cub taps Octo's coin. */
  onCoinPress?: (pressed: boolean) => void;
  /** Called when the pointer starts or stops hovering Cub (also mirrored as data-cub-hot on the host). */
  onHotChange?: (hot: boolean) => void;
  /** Called when the renderer status changes; "off" carries the reason. */
  onStatus?: (status: CubGlStatus, reason?: CubFallbackReason) => void;
  /**
   * Called once, as soon as a turn starting now would leave Cub's hello (he
   * notices the visitor: a jig, a happy squint, a wave) untouched: the turn's
   * busy window (the lent arm) would begin only after the hello has ended. A
   * host can hold its first turn until then, so a first visit reads idle,
   * hello, then the turn.
   */
  onReadyForTurn?: () => void;
  /** Developer hooks (state, audit, perf, bench, fallback capture, overlay). Never on in production. */
  debug?: boolean | CubDebugOptions;
}

export interface CubDebugOptions {
  /** Draw the keep-out / hit-circle overlay canvas. */
  overlay?: boolean;
  /** Shader debug view (0 normal, 1 tone, 5 ink alpha, 6 coverage, 7-10 eyes and lines). */
  shaderView?: number;
  /** Capture pose for the fallback sprites: no front arms. */
  fallbackPose?: boolean;
  /** Skip WebGL entirely (test the fallback). */
  noGl?: boolean;
}

export interface CubPublicState {
  status: CubGlStatus;
  mode: CubPerchMode;
  u: number;
  bx: number;
  dpr: number;
  canvas: [number, number];
  playing: boolean;
  simClock: number;
  turn: CubTurnSample;
  reach: number;
  ink: number;
}

export interface CubDevHooks {
  /** Detailed internal state (arms, eyes, spines, ink). */
  state(): Record<string, unknown>;
  perf: { frames: number; js: number; rows: number; box: [number, number]; canvas: [number, number] };
  /** Renders T seconds and counts Cub's pixels over the keep-out rects; with td0 the turn plays from td0 alongside. */
  audit(
    T?: number,
    step?: number,
    td0?: number,
  ): { frames: number; hits: Record<string, { frames: number; maxpx: number; t: number[] }> };
  /** Mean ms per rendered frame over n frames. */
  bench(n: number, t?: number): number;
  /** The fallback sprite set for the current perch mode (alpha-only WebP data URLs). */
  fbCapture(t?: number): Promise<CubFallbackSprite & { mode: CubPerchMode }>;
  setOverlay(on: boolean): void;
  setShaderView(mode: number): void;
  /** Render one deterministic frame at sim time t and turn time td. */
  renderAt(t: number, td?: number | null): void;
  /** Body centre in viewport coordinates (for pointer tests). */
  bodyXY(): [number, number];
  /** Play the hello (jig, happy squint, wave) again, starting now. */
  replayHello(): void;
}

export interface CubHandle {
  destroy(): void;
  setTheme(theme: CubTheme): void;
  setReducedMotion(on: boolean): void;
  setMotion(on: boolean): void;
  setNoticeEnabled(on: boolean): void;
  /** Replace the anchors and lay out again. */
  setAnchors(anchors: CubAnchors): void;
  /** Lay out again from the anchors resolver (or the last anchors). Call after text or scenario changes. */
  relayout(): void;
  setTurn(turn: CubTurn): void;
  /** Cub glances: at the CTA (fine pointer hover or focus-visible), or at the opener after a manual chip pick. */
  notice(kind: "cta" | "chip"): void;
  /** The same as clicking Cub: a happy squint and a squirt of crew ink. */
  boop(): void;
  getState(): CubPublicState;
  /** Present only with options.debug. */
  dev?: CubDevHooks;
}
