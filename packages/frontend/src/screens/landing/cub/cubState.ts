// One Cub instance's state. The prototype kept all of this in module-level
// globals; here it lives in a single object created per createCub() call, so
// two engines (or a StrictMode double mount) never share anything. Field names
// follow the owner-approved prototype (L, G, OC, PT, CUR, ...; not in this
// repo) so the port stays reviewable line by line against it.

import { DEFAULT_CREW_LIGHT, EB_AMP, EYE_AZ, K, LW_DEFAULT, MAXR, type ArmRole } from "./cubConfig";
import type { V3 } from "./cubMath";
import type { CubTimeline, CubTurnSample } from "./cubTimeline";
import type {
  CubFallbackSource,
  CubLayoutTuning,
  CubPerchMode,
  CubRect,
  CubTurn,
} from "./cubTypes";

/** A keep-out rect. m: extra margin for arm collision (default 4). coin: an avatar coin (the ink treats coins differently). */
export interface KeepRect extends CubRect {
  m?: number;
  coin?: boolean;
  /** A glyph or the title on the phone bar right under the ledge (ink plans only its core clear of it). */
  bar?: boolean;
}

/** The measured page around Cub (the prototype's L). */
export interface Layout {
  W: number;
  H: number;
  mobile: boolean;
  /** The corner perch may be used (the host's word, else the width rule). */
  cornerOK: boolean;
  text: CubRect[];
  cta: CubRect | null;
  chipRects: CubRect[];
  /** Bounding box of the chips (a stand-in above the window when there are none). */
  chips: CubRect;
  win: CubRect;
  main: CubRect;
  tcol: CubRect;
  coins: KeepRect[];
  octoIdx: number;
  coinL: number;
  coinR: number;
  octoCoin: KeepRect;
  kim: CubRect;
  ctitleRow: CubRect;
  comp: CubRect;
  mOcto: CubRect | null;
  you: CubRect | null;
  fchip: CubRect | null;
  h1: CubRect | null;
  keep: CubRect[];
  /** Window chrome glyphs: arm and ink keep-outs that never block the perch. */
  chrome: KeepRect[];
  sig: string;
}

/** The collision scene arms are laid out against (the prototype's G / S). */
export interface Geo {
  edgeY: number;
  wx0: number;
  wx1: number;
  wy1: number;
  floorY: number;
  deep: number;
  col: CubRect;
  xMin: number;
  xMax: number;
  rects: KeepRect[];
}

export interface ArmBuf {
  X: Float64Array;
  Y: Float64Array;
  Z: Float64Array;
  F: Uint8Array;
}
export const armBuf = (): ArmBuf => ({
  X: new Float64Array(K),
  Y: new Float64Array(K),
  Z: new Float64Array(K),
  F: new Uint8Array(K),
});

/** The perch and everything derived from it at layout time (the prototype's OC). */
export interface Perch {
  u: number;
  bx: number;
  reachSh: number;
  eb: number;
  psiCam: number;
  azF: number;
  restOn: [number, number];
  mode: CubPerchMode;
  psi0: number;
  roles: ArmRole[] | null;
  armOf: Partial<Record<ArmRole, number>>;
  parm: ArmBuf[] | null;
  Scur: Geo | null;
  Sreach: Geo | null;
  prReach: KeepRect & { m: number };
  shMin: number;
  shMax: number;
}

export interface Cam {
  W: number;
  H: number;
  DPR: number;
  CD: number;
  WV: number;
  HV: number;
  VP: Float32Array;
  VPB: Float32Array;
}

export interface EyeGeom {
  x: number;
  y: number;
  z: number;
  R: number;
  vis: number;
  ax: number;
  ay: number;
  sq: number;
  roll: number;
  f: number;
  clr: number;
  on: number;
  sw: number;
}

export interface ThemeRGB {
  ink: V3;
  paper: V3;
  surf: V3;
  dark: number;
  crew: string[];
}

export interface Ball {
  sx: number;
  sy: number;
  T: number;
  vx: number;
  vy: number;
  g: number;
}

export interface InkPiece {
  kind: "L" | "S" | "F" | "N";
  a: number;
  L: number;
  wb: number;
  sw?: number;
  sf?: number;
  pw?: number;
  fl: number;
  ff: number;
  bend: number;
  chain: { g: number; r: number; e: number }[] | null;
  /** Together only: a spike splashed across a seam (crosses the separation rule). */
  x?: number;
  rb: number;
}

export interface InkSat {
  a: number;
  dist: number;
  rb: number;
  rs: number;
  tl: number;
  x: number;
  y: number;
}

export interface InkDrop {
  i: number;
  ord: number;
  tx: number;
  ty: number;
  R: number;
  kf: number;
  r: number;
  H: number;
  sj: number;
  B0: Ball;
  hd: number;
  t0: number;
  B: Ball | null;
  wob: number;
  el: number;
  fk: number;
  hm: { k: number; amp: number; ph: number }[];
  sk: InkPiece[];
  sat: InkSat[];
  path: Path2D | null;
  built: boolean;
  bb: number[] | null;
  lut: Float32Array;
  rmax: number;
}

export interface InkSet {
  t: number;
  st: boolean;
  tog: boolean;
  sd: number;
  seed: number;
  near: boolean;
  lv: number;
  gk: number;
  dur: number;
  drops: InkDrop[];
  PCS: { x: number; y: number; r: number; i: number }[];
  nb: number;
  fadeT: number | null;
  fadeD?: number;
  glanced?: boolean;
}

export interface InkPlan {
  sd: number;
  r: number;
  rs?: number[];
  pts: number[][];
  near: boolean;
  lv: number;
  hk?: number;
}

export interface InkVary {
  rot: number;
  sp: number;
  dy: number[];
  gx: number;
  flip: boolean;
  sz?: number[];
  gj?: number[];
}

export interface InkState {
  /** The ink layer canvas (engine-owned) and its 2D context. */
  cv: HTMLCanvasElement | null;
  sets: InkSet[];
  x2d: CanvasRenderingContext2D | null;
  last: number;
  dirty: boolean;
  staticTO: number;
  staticRaf: number;
  n: number;
  staticN: number;
  pauseTO: number;
  /** The ink layer's rect in device px (relative to the host). */
  R: { x: number; y: number; w: number; h: number };
  /** Planning caches: the keep-out list and Cub's bounding box while a set is planned or built. */
  kc: KeepRect[] | null;
  hbb: number[] | null;
  pend: { t: number; quick: boolean; f: number } | null;
  queue: { at: number; quick: boolean }[];
  /** Boops whose ink could not be planned within the retry frames (dev builds count them). */
  dropped: number;
  warmH: number;
  warmIdle: boolean;
  layer: HTMLCanvasElement | null;
  layerX: CanvasRenderingContext2D | null;
  rgb: Map<string, number[]>;
}

export interface ResolvedOptions {
  timeline: CubTimeline;
  dprCap: { desktop: number; mobile: number };
  tuning: CubLayoutTuning;
  splash: "apart" | "together";
  eyes: boolean;
  clickInk: boolean;
  lw: number;
  zIndex: number;
  controlSelector: string;
  fallback: CubFallbackSource | null;
  still: { t: number; td: number | null } | null;
  debug: boolean;
  overlay: boolean;
  shaderView: number;
  fallbackPose: boolean;
  noGl: boolean;
}

export const DEFAULT_TUNING: CubLayoutTuning = {
  desktopU: { min: 48, k: 0.055, max: 84 },
  mobileU: { min: 20, aboveK: 4.2, belowK: 1.4, max: 33 },
  mobileBreakpoint: 720,
  cornerCoinDepth: null,
  cornerMinWidth: 0,
};

export interface Cub {
  o: ResolvedOptions;
  /** Theme as linear 0..1 RGB triples plus crew hex strings. */
  theme: ThemeRGB;
  rmOn: boolean;
  motionOn: boolean;
  noticeOn: boolean;
  turn: CubTurn;
  getTurnTime: (() => number | null) | null;
  /** Dev renderAt(): a fixed turn sample for the frames it renders. */
  turnOverride: CubTurnSample | null;
  /** Wakes the frame loop (set by the engine; a no-op until then). */
  kick: () => void;
  /** Whether the frame loop runs right now (set by the engine). */
  playing: () => boolean;
  fineQ: { matches: boolean } | null;

  glOK: boolean;
  glLost: boolean;
  visible: boolean;
  built: boolean;
  started: boolean;
  relayoutSoon: boolean;
  inLoop: boolean;
  destroyed: boolean;
  raf: number;
  idleTO: number;
  lastRender: number;
  simClock: number;
  /** Seconds added to the timeline's hello times (kept clear of the turn's reach, or the dev playground's replay). */
  helloShift: number;
  /** The hello was placed by hand (the dev playground's replay): it is not moved off the reach. */
  helloPinned: boolean;
  /** The bottom of the browser's viewport in host px (Infinity until the host is measured). */
  viewY1: number;
  hot: boolean;
  coinPressed: boolean;
  lastSig: string;

  cam: Cam;
  CVR: { x: number; y: number; w: number; h: number };
  L: Layout | null;
  G: Geo | null;
  Sidle: Geo | null;
  OC: Perch;

  SPD: Float32Array;
  TUBE: Float32Array;
  TUBE2: Float32Array;
  INFO: Float32Array;
  ANC: Float32Array;
  ANCH: Float32Array;
  EA: Float32Array;
  EB: Float32Array;
  EC: Float32Array;
  UF: Float32Array;
  UM: Float32Array;
  UMB: Float32Array;
  SHD: Float32Array;
  SHDT: Float32Array;
  HIT: Float32Array;
  NHIT: number;
  NBODYH: number;
  BODYC: [number, number];
  HEADC: [number, number];
  CROWN: [number, number];
  BB: [number, number, number, number] | null;
  ROWS: number;
  LASTACT: { wR: number; curW: number; f: number; tw: number; psi: number; roll: number; lift: number; bx: number };
  LASTBEAT: Beats;
  ARMDBG: Record<string, unknown>[];
  REACHDBG: { pts: number[][]; T: number; h: number; rho: number; xA: number; rx: number } | null;
  PERF: { frames: number; js: number; rows: number; box: [number, number]; canvas: [number, number] };

  PT: {
    in: boolean;
    x: number;
    y: number;
    vx: number;
    vy: number;
    ts: number;
    moveT: number;
    ctl: boolean;
    text: boolean;
    inWin: boolean;
    ax: number;
    ay: number;
    stillT: number;
  };
  CUR: {
    arm: number;
    linger: boolean;
    w: number;
    x: number;
    y: number;
    vx: number;
    vy: number;
    near: boolean;
    engaged: boolean;
    shyT: number;
    roll: number;
    rollV: number;
    psi: number;
    psiV: number;
    switchT: number;
    blockT: number;
    engT: number;
  };
  CW: Float64Array;
  CWV: Float64Array;
  FL: { t0: number; amp: number };
  SHY: { t0: number; arm: number };
  SHIFT: { x: number; v: number; target: number; homeT: number };
  POKES: number[];
  GLANCE: { t0: number; x: number; y: number };
  INKG: { t0: number; x: number; y: number; d: number };
  ATT: { t0: number; kind: "cam" | "pt" | "fixed"; x: number; y: number; amp: number; nearT: number };
  ATTP: { e0: number; t1: number; cam: boolean; x: number; y: number; camE: number };
  ARMT: { lag: number };
  TAP: { t0: number; arm: number };
  TOUCHG: { t0: number; x: number; y: number };
  LINGER: { at: number; last: number };
  LOOK: { on: boolean; e: number; x: number; y: number; rel: number };
  BOOP: { t0: number };
  ctaT: number;
  taps: Map<number, { x: number; y: number; t: number; sy: number; sx: number }>;

  EYEG: [EyeGeom, EyeGeom];
  EQ: [EyeGeom, EyeGeom];
  EYE: {
    fx: number;
    fy: number;
    tx: number;
    ty: number;
    sacT: number;
    nextFix: number;
    cam: number;
    att: number;
    blinkT: number;
    squeezeT: number;
    sqHap: number;
    widenT: number;
    hardOff: number;
  };
  EYE_AMP: [number, number];
  EYE_V: [number, number];
  EYE_AZN: number;
  EYE_T: number;
  LIDNOW: number;
  BLK_NOW: { b: number; pop: number; hap: number };
  MOUTH: { x: number; y: number; s: number; ax: number; ay: number; sq: number; vis: number };
  /** Head hull planes (per ring pair) and their arc positions. */
  HPC: number[][][];
  HPS: number[];

  FEV: { t0: number; d: number; r: number; ph: number; per: number }[];
  fevI: number;
  DUTY: [{ t0: number; r: number }[], { t0: number; r: number }[]];
  DUI: [number, number];
  BLK: number[];
  blkI: number;

  /** Scratch, reused every frame. */
  sf: Float64Array;
  CUO: ArmBuf;
  CURT: ArmBuf;
  TMP: ArmBuf;
  CSEG: Float64Array;
  AI: Float64Array;
  LI: Float64Array;
  AA: Float64Array;
  LA: Float64Array;
  MX: Float64Array;
  MY: Float64Array;
  MW: Float64Array;
  FKA: Float64Array;
  FKL: Float64Array;
  RP: number[][];

  ink: InkState;
}

export interface Beats {
  jig: number;
  smile: number;
  wig: number;
  wave: number;
  wv: number;
}

const eyeGeom = (): EyeGeom => ({ x: 0, y: 0, z: 0, R: 0, vis: 0, ax: 0, ay: -1, sq: 1, roll: 0, f: 0, clr: 0, on: -1, sw: -99 });

export function hexRGB(v: string, fb: V3): V3 {
  const m = /^#([0-9a-f]{6})$/i.exec(v.trim());
  if (!m) return fb;
  const n = parseInt(m[1], 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

export function createCubState(o: ResolvedOptions): Cub {
  return {
    o,
    theme: {
      ink: [0.165, 0.18, 0.21],
      paper: [0.973, 0.973, 0.965],
      surf: [1, 1, 1],
      dark: 0,
      crew: [...DEFAULT_CREW_LIGHT],
    },
    rmOn: false,
    motionOn: true,
    noticeOn: true,
    turn: { live: false },
    getTurnTime: null,
    turnOverride: null,
    kick: () => undefined,
    playing: () => false,
    fineQ: null,
    glOK: false,
    glLost: false,
    visible: true,
    built: false,
    started: false,
    relayoutSoon: false,
    inLoop: false,
    destroyed: false,
    raf: 0,
    idleTO: 0,
    lastRender: 0,
    simClock: o.still ? o.still.t : 0,
    helloShift: 0,
    helloPinned: false,
    viewY1: Infinity,
    hot: false,
    coinPressed: false,
    lastSig: "",
    cam: { W: 0, H: 0, DPR: 1, CD: 1000, WV: 1, HV: 1, VP: new Float32Array(16), VPB: new Float32Array(16) },
    CVR: { x: 0, y: 0, w: 1, h: 1 },
    L: null,
    G: null,
    Sidle: null,
    OC: {
      u: 60,
      bx: 0,
      reachSh: 0,
      eb: EB_AMP,
      psiCam: -0.25,
      azF: 0.56,
      restOn: [1, 0],
      mode: "corner",
      psi0: -0.3,
      roles: null,
      armOf: {},
      parm: null,
      Scur: null,
      Sreach: null,
      prReach: { x: 0, y: 0, w: 0, h: 0, m: 1.5 },
      shMin: 0,
      shMax: 0,
    },
    SPD: new Float32Array(K * 3 * 4 * MAXR),
    TUBE: new Float32Array(MAXR * 4),
    TUBE2: new Float32Array(MAXR * 4),
    INFO: new Float32Array((MAXR + 1) * 4),
    ANC: new Float32Array(4),
    ANCH: new Float32Array(4),
    EA: new Float32Array(8),
    EB: new Float32Array(8),
    EC: new Float32Array(8),
    UF: new Float32Array(4),
    UM: new Float32Array(4),
    UMB: new Float32Array(4),
    SHD: new Float32Array(4),
    SHDT: new Float32Array(2),
    HIT: new Float32Array(3 * 600),
    NHIT: 0,
    NBODYH: 0,
    BODYC: [0, 0],
    HEADC: [0, 0],
    CROWN: [0, 0],
    BB: null,
    ROWS: 0,
    LASTACT: { wR: 0, curW: 0, f: 0, tw: 0, psi: 0, roll: 0, lift: 0, bx: 0 },
    LASTBEAT: { jig: 0, smile: 0, wig: 0, wave: 0, wv: 0 },
    ARMDBG: [],
    REACHDBG: null,
    PERF: { frames: 0, js: 0, rows: 0, box: [0, 0], canvas: [0, 0] },
    PT: { in: false, x: 0, y: 0, vx: 0, vy: 0, ts: 0, moveT: -99, ctl: false, text: false, inWin: false, ax: -1e4, ay: -1e4, stillT: 0 },
    CUR: {
      arm: -1,
      linger: false,
      w: 0,
      x: 0,
      y: 0,
      vx: 0,
      vy: 0,
      near: false,
      engaged: false,
      shyT: -99,
      roll: 0,
      rollV: 0,
      psi: 0,
      psiV: 0,
      switchT: -99,
      blockT: -99,
      engT: -99,
    },
    CW: new Float64Array(8),
    CWV: new Float64Array(8),
    FL: { t0: -99, amp: 0 },
    SHY: { t0: -99, arm: -1 },
    SHIFT: { x: 0, v: 0, target: 0, homeT: -1 },
    POKES: [],
    GLANCE: { t0: -99, x: 0, y: 0 },
    INKG: { t0: -99, x: 0, y: 0, d: 0.8 },
    ATT: { t0: -99, kind: "cam", x: 0, y: 0, amp: 1, nearT: -99 },
    ATTP: { e0: 0, t1: -99, cam: false, x: 0, y: 0, camE: 0 },
    ARMT: { lag: 0 },
    TAP: { t0: -99, arm: -1 },
    TOUCHG: { t0: -99, x: 0, y: 0 },
    LINGER: { at: -99, last: -99 },
    LOOK: { on: false, e: 0, x: 0, y: 0, rel: -99 },
    BOOP: { t0: -99 },
    ctaT: -99,
    taps: new Map(),
    EYEG: [eyeGeom(), eyeGeom()],
    EQ: [eyeGeom(), eyeGeom()],
    EYE: { fx: 0, fy: 0.1, tx: 0, ty: 0.1, sacT: -99, nextFix: 0, cam: 0, att: 0, blinkT: -99, squeezeT: -99, sqHap: 0, widenT: -99, hardOff: 0 },
    EYE_AMP: [EB_AMP, EB_AMP],
    EYE_V: [1, 1],
    EYE_AZN: EYE_AZ.desk,
    EYE_T: -1,
    LIDNOW: 0,
    BLK_NOW: { b: 0, pop: 0, hap: 0 },
    MOUTH: { x: 0, y: 0, s: 1, ax: 1, ay: 0, sq: 1, vis: 0 },
    HPC: [],
    HPS: [],
    FEV: [],
    fevI: 0,
    DUTY: [[], []],
    DUI: [0, 0],
    BLK: [o.timeline.hello.out + 2.1],
    blkI: 0,
    sf: new Float64Array(2),
    CUO: armBuf(),
    CURT: armBuf(),
    TMP: armBuf(),
    CSEG: new Float64Array(K),
    AI: new Float64Array(K),
    LI: new Float64Array(K),
    AA: new Float64Array(K),
    LA: new Float64Array(K),
    MX: new Float64Array(K),
    MY: new Float64Array(K),
    MW: new Float64Array(K),
    FKA: new Float64Array(K),
    FKL: new Float64Array(K),
    RP: [],
    ink: {
      cv: null,
      sets: [],
      x2d: null,
      last: -99,
      dirty: false,
      staticTO: 0,
      staticRaf: 0,
      n: 0,
      staticN: 0,
      pauseTO: 0,
      R: { x: 0, y: 0, w: 1, h: 1 },
      kc: null,
      hbb: null,
      pend: null,
      queue: [],
      dropped: 0,
      warmH: 0,
      warmIdle: false,
      layer: null,
      layerX: null,
      rgb: new Map(),
    },
  };
}

export function resolveOptions(input: {
  timeline: CubTimeline;
  dprCap?: { desktop: number; mobile: number };
  layout?: Partial<CubLayoutTuning>;
  splash?: "apart" | "together";
  eyes?: boolean;
  clickInk?: boolean;
  lineWidth?: number;
  zIndex?: number;
  controlSelector?: string;
  fallback?: CubFallbackSource | null;
  still?: { t: number; td?: number | null } | null;
  debug?: boolean | { overlay?: boolean; shaderView?: number; fallbackPose?: boolean; noGl?: boolean };
}): ResolvedOptions {
  const dbg = input.debug;
  const d = typeof dbg === "object" && dbg ? dbg : {};
  const lw = input.lineWidth;
  return {
    timeline: input.timeline,
    dprCap: input.dprCap ?? { desktop: 2, mobile: 3 },
    tuning: {
      desktopU: { ...DEFAULT_TUNING.desktopU, ...input.layout?.desktopU },
      mobileU: { ...DEFAULT_TUNING.mobileU, ...input.layout?.mobileU },
      mobileBreakpoint: input.layout?.mobileBreakpoint ?? DEFAULT_TUNING.mobileBreakpoint,
      cornerCoinDepth: input.layout?.cornerCoinDepth !== undefined ? input.layout.cornerCoinDepth : DEFAULT_TUNING.cornerCoinDepth,
      cornerMinWidth: input.layout?.cornerMinWidth ?? DEFAULT_TUNING.cornerMinWidth,
    },
    splash: input.splash === "together" ? "together" : "apart",
    eyes: input.eyes ?? true,
    clickInk: input.clickInk ?? true,
    lw: Math.max(0.5, Math.min(2.8, lw != null && Number.isFinite(lw) ? lw : LW_DEFAULT)),
    zIndex: input.zIndex ?? 3,
    controlSelector: input.controlSelector ?? "a,button,input,textarea,select,[role=button]",
    fallback: input.fallback ?? null,
    still: input.still ? { t: input.still.t, td: input.still.td === undefined ? input.still.t : input.still.td } : null,
    debug: !!dbg,
    overlay: !!d.overlay,
    shaderView: import.meta.env.DEV ? (d.shaderView ?? 0) : 0,
    fallbackPose: import.meta.env.DEV && !!d.fallbackPose,
    noGl: import.meta.env.DEV && !!d.noGl,
  };
}
