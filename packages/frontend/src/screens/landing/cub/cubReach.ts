// Lending Octo an arm: the route along the ledge and the hook down onto
// Octo's coin, the idle -> reach morph (tip last), and the tap flick.
// Ported from the owner-approved prototype (not in this repo).

import {
  ARM_R0,
  FLK_J,
  K,
  MORPH_J,
  MORPH_LEAD,
  MORPH_S,
  MORPH_W,
  REACH_MIN,
  REACH_PHI,
  REST_B,
  SS,
  TAP_LAND,
} from "./cubConfig";
import { fixPt, stepFix, toAng } from "./cubArms";
import { proj } from "./cubCamera";
import { clamp, lerp, madd, smoother, sstep, wrapPi } from "./cubMath";
import { armRoots, armTaper, pose, rolesFor } from "./cubRig";
import type { ArmBuf, Cub, Geo, KeepRect } from "./cubState";

export interface ReachRoute {
  pts: number[][];
  T: number;
  h: number;
  rho: number;
  xA: number;
  /** The hook's half-width. */
  rx: number;
}

/** A hook of half-width rx (and half-height ry) from xA clears every rect and stays between the walls. */
function hookClear(avoid: readonly KeepRect[], cx: number, yA: number, rx: number, ry: number, sd: number, r: number, x0: number, x1: number): boolean {
  const xA = cx + sd * rx * Math.sin(REACH_PHI);
  for (let i = 0; i <= 12; i++) {
    const ph = (REACH_PHI * i) / 12;
    const x = xA - sd * rx * Math.sin(ph);
    const y = yA + ry * (1 - Math.cos(ph));
    if (x < x0 + r || x > x1 - r) return false;
    for (const b of avoid) {
      const m = r + (b.m ?? 4);
      if (x > b.x - m && x < b.x + b.w + m && y > b.y - m && y < b.y + b.h + m) return false;
    }
  }
  return true;
}

/**
 * The hook's half-width: the prototype's unless it would swing into window
 * chrome beside a deep coin (avoid), then the nearest width that clears it,
 * narrower first (a straight drop between two glyphs), then wider (a loop
 * around a glyph right above the coin).
 */
function hookRx(avoid: readonly KeepRect[], S: Geo, cx: number, yA: number, rx0: number, ry: number, sd: number, r: number): number {
  const ok = (rx: number) => hookClear(avoid, cx, yA, rx, ry, sd, r, S.wx0 + 2, S.wx1 - 2);
  if (!avoid.length || ok(rx0)) return rx0;
  for (let k = 1; k <= 12; k++) {
    const rx = Math.max(0.5, rx0 * (1 - k / 12.5));
    if (ok(rx)) return rx;
  }
  for (let k = 1; k <= 20; k++) {
    const rx = rx0 * (1 + 0.1 * k);
    if (ok(rx)) return rx;
  }
  return rx0;
}

/**
 * Where on the coin's top the tip lands: its centre, unless window chrome
 * stands right above the coin, then nudged (within the coin's middle 60%)
 * toward the middle of the gap the arm drops through.
 */
export function landX(c: Cub, co: { x: number; w: number }, cx: number, ty: number, r: number): number {
  const L = c.L;
  const G = c.G;
  if (!L || !G || !L.chrome.length) return cx;
  let lo = -Infinity;
  let hi = Infinity;
  for (const b of L.chrome) {
    if (b.y > ty || b.y + b.h < G.edgeY) continue;
    const m = (b.m ?? 4) + r;
    if (b.x + b.w / 2 <= cx) lo = Math.max(lo, b.x + b.w + m);
    else hi = Math.min(hi, b.x - m);
  }
  if (!Number.isFinite(lo) && !Number.isFinite(hi)) return cx;
  const want = Number.isFinite(lo) && Number.isFinite(hi) ? (lo + hi) / 2 : Number.isFinite(lo) ? Math.max(cx, lo) : Math.min(cx, hi);
  return clamp(co.x + 0.2 * co.w, want, co.x + 0.8 * co.w);
}

/**
 * A route from the arm root along the ledge, arching (height h) toward the
 * coin, then a hook down onto its top. Window chrome near a deep coin
 * (avoid) reshapes the hook so it never swings into it (see hookRx); hookCx is
 * the steady landing point the hook's width is chosen for (cx may wobble), so
 * the width never flips from one frame to the next.
 */
export function reachRoute(
  c: Cub,
  S: Geo,
  x0: number,
  y0: number,
  cx: number,
  ty: number,
  u: number,
  rpx: (s: number) => number,
  Lidle: number,
  hMax: number,
  cw: number,
  avoid: readonly KeepRect[] = [],
  hookCx = cx,
): ReachRoute {
  const RP = c.RP;
  const ey = S.edgeY;
  const sd = Math.sign(x0 - cx) || 1;
  const yA = ey - rpx(0.8) - 0.5;
  const ry = Math.max(4, (ty - yA) / (1 - Math.cos(REACH_PHI)));
  const rx0 = Math.max(ry, Math.min(0.25 * u, 1.9 * ry, (cw || 0) / 2 + 0.1 * u - 3));
  const rx = avoid.length ? hookRx(avoid, S, hookCx, yA, rx0, ry, sd, rpx(0.8)) : rx0;
  const xA = cx + sd * rx * Math.sin(REACH_PHI);
  const run0 = sd * (x0 - xA);
  const build = (h: number): number => {
    RP.length = 0;
    RP.push([x0, y0, -1]);
    const n = Math.max(6, Math.ceil(run0 / 3));
    const yE = ey - rpx(0.7) - 0.5;
    const hb = run0 < 0.6 * u ? 0 : Math.max(0.04 * u, 2);
    for (let i = 1; i <= n; i++) {
      const k = i / n;
      const top =
        lerp(y0, yE, smoother(k / 0.85)) -
        h * smoother(k / 0.3) * (1 - smoother((k - 0.45) / 0.4)) -
        hb * (Math.sin(Math.PI * clamp(0, (k - 0.52) / 0.15, 1)) ** 2 + Math.sin(Math.PI * clamp(0, (k - 0.75) / 0.13, 1)) ** 2);
      RP.push([lerp(x0, xA, k), top, 0]);
    }
    for (let i = 1; i <= 10; i++) {
      const ph = (REACH_PHI * i) / 10;
      RP.push([xA - sd * rx * Math.sin(ph), yA + ry * (1 - Math.cos(ph)), -1 - i / 10]);
    }
    for (let pass = 0; pass < 2; pass++) {
      let cum = 0;
      let T = 0;
      for (let i = 1; i < RP.length; i++) T += Math.hypot(RP[i][0] - RP[i - 1][0], RP[i][1] - RP[i - 1][1]);
      let yl = yA;
      for (let i = 1; i < RP.length; i++) {
        cum += Math.hypot(RP[i][0] - RP[i - 1][0], RP[i][1] - RP[i - 1][1]);
        if (RP[i][2] >= 0) {
          if (!pass) RP[i][2] = RP[i][1];
          yl = RP[i][1] = Math.min(RP[i][2], ey - rpx(clamp(0, cum / T, 1)) - 0.5);
        } else if (RP[i][2] < -1) {
          const f = -1 - RP[i][2];
          const ph = REACH_PHI * f;
          RP[i][1] = yA + ry * (1 - Math.cos(ph)) + (yl - yA) * (1 - f);
        }
      }
    }
    let T = 0;
    for (let i = 1; i < RP.length; i++) T += Math.hypot(RP[i][0] - RP[i - 1][0], RP[i][1] - RP[i - 1][1]);
    return T;
  };
  hMax = Math.max(0, hMax - (ey - rpx(0.4) - 0.5 - lerp(y0, ey - rpx(0.7) - 0.5, smoother(0.38 / 0.85))));
  let T = build(0);
  let h = 0;
  const want = REACH_MIN * Lidle;
  if (T < want && hMax > 0.5 && run0 > 8) {
    let lo = 0;
    let hi = hMax;
    if (build(hi) <= want) lo = hi;
    else
      for (let it = 0; it < 9; it++) {
        const m = (lo + hi) / 2;
        if (build(m) < want) lo = m;
        else hi = m;
      }
    T = build((h = lo));
  }
  return { pts: RP.map((p) => [p[0], p[1]]), T, h, rho: ry, xA, rx };
}

/** Morphs the idle arm o toward the reach pose act by w (0..1): the root leads, the tip arrives last. */
export function morphArm(
  c: Cub,
  o: ArmBuf,
  act: ArmBuf,
  w: number,
  S: Geo,
  rpx: (s: number) => number,
  lx0: number,
  lx1: number,
  lift: number,
): number {
  const { AI, LI, AA, LA, MX, MY, MW, sf: SF } = c;
  const j0 = MORPH_J;
  toAng(o, AI, LI);
  toAng(act, AA, LA);
  for (let j = 0; j <= j0; j++) {
    const wj = (MW[j] = clamp(0, w * (1 + MORPH_LEAD) - MORPH_LEAD * SS[j], 1));
    MX[j] = lerp(o.X[j], act.X[j], wj);
    MY[j] = lerp(o.Y[j], act.Y[j], wj);
  }
  const ts = Math.sin(Math.PI * clamp(0, w, 1));
  let a = Math.atan2(MY[j0] - MY[j0 - 1], MX[j0] - MX[j0 - 1]);
  let cr = 0;
  for (let j = j0 + 1; j < K; j++) {
    const g = (SS[j] - MORPH_S) / (1 - MORPH_S);
    const lag = MORPH_W[0] + (1 - MORPH_W[0] - MORPH_W[1]) * g;
    const wj = (MW[j] = smoother((w - lag) / MORPH_W[1]));
    let tj = lerp(wrapPi(AI[j] - AI[j - 1]), wrapPi(AA[j] - AA[j - 1]), wj);
    const l = lerp(LI[j], LA[j], w);
    if (ts > 0.01) {
      const cap = l / (1.6 * rpx(SS[j]) + 2) / ts;
      tj += cr;
      const c2 = clamp(-cap, tj, cap);
      cr = tj - c2;
      tj = c2;
    }
    a += tj;
    MX[j] = MX[j - 1] + Math.cos(a) * l;
    MY[j] = MY[j - 1] + Math.sin(a) * l;
  }
  const lw = (lift || 0) * ts;
  for (let j = 0; j < K; j++) {
    o.X[j] = MX[j];
    o.Y[j] = MY[j] - lw * sstep(0.5, 0.8, SS[j]);
    o.Z[j] = lerp(o.Z[j], act.Z[j], MW[j]);
  }
  const u = c.OC.u;
  const ramp = 0.12 * u;
  const alw = (j: number) => 3 * u * smoother(Math.min(o.X[j] - lx0, lx1 - o.X[j]) / ramp);
  if (ts > 0.01) {
    let need = 0;
    for (let j = 1; j < K; j++) {
      const pr = sstep(0.45, 0.75, SS[j]);
      if (pr < 0.25 || o.X[j] <= S.wx0 || o.X[j] >= S.wx1) continue;
      need = Math.max(need, (o.Y[j] - (S.edgeY - rpx(SS[j]) + alw(j))) / pr);
    }
    if (need > 0) for (let j = 1; j < K; j++) o.Y[j] -= need * sstep(0.45, 0.75, SS[j]);
  }
  if (ts > 0.01) {
    let x = o.X[0];
    let y = o.Y[0];
    let px = x;
    let py = y;
    for (let j = 1; j < K; j++) {
      const l = Math.hypot(MX[j] - MX[j - 1], MY[j] - MY[j - 1]);
      const dx = o.X[j] - px;
      const dy = o.Y[j] - py;
      const d = Math.hypot(dx, dy) || 1;
      px = o.X[j];
      py = o.Y[j];
      o.X[j] = x + (dx / d) * l;
      o.Y[j] = y + (dy / d) * l;
      x = o.X[j];
      y = o.Y[j];
    }
  }
  for (let j = 1; j < K; j++) {
    if (o.X[j] <= S.wx0 || o.X[j] >= S.wx1) continue;
    const ly = S.edgeY - rpx(SS[j]);
    const al = alw(j);
    if (o.Y[j] > ly + al) o.Y[j] = ly + al;
    if (o.Y[j] > ly && o.Y[j] <= ly + 0.5) o.Y[j] = ly;
  }
  // Below the ledge over the window face the arm hangs in front of it. Past
  // either end of the window it hangs beside it (a corner drape on its way
  // in or out): front there would pull it back over the face in one straight
  // bar.
  let fr = 0;
  for (let j = 0; j < K; j++) {
    const over = o.X[j] > S.wx0 && o.X[j] < S.wx1;
    if (!over) fr = 0;
    else if (o.Y[j] > S.edgeY - rpx(SS[j]) + 0.5) fr = 1;
    o.F[j] = fr;
  }
  let x = o.X[0];
  let y = o.Y[0];
  let hits = 0;
  for (let j = 1; j < K; j++) {
    // Every segment keeps the morph's length: a joint the ledge clamp or a
    // keep-out moved never stretches its segment into a long straight run
    // (it reads as a stray stroke).
    const seg = Math.hypot(MX[j] - MX[j - 1], MY[j] - MY[j - 1]);
    hits += stepFix(S, x, y, o.X[j], o.Y[j], seg, rpx(SS[j]), o.F[j], SF);
    const dx = SF[0] - x;
    const dy = SF[1] - y;
    const dl = Math.hypot(dx, dy);
    if (dl > seg * 1.02 && dl > 0) {
      SF[0] = x + (dx / dl) * seg;
      SF[1] = y + (dy / dl) * seg;
    }
    o.X[j] = SF[0];
    o.Y[j] = SF[1];
    x = SF[0];
    y = SF[1];
  }
  for (let j = K - 8; j < K; j++) {
    const a1 = Math.atan2(o.Y[j - 1] - o.Y[j - 2], o.X[j - 1] - o.X[j - 2]);
    const a2 = Math.atan2(o.Y[j] - o.Y[j - 1], o.X[j] - o.X[j - 1]);
    const d = wrapPi(a2 - a1);
    if (Math.abs(d) < 0.7) continue;
    const l = Math.hypot(o.X[j] - o.X[j - 1], o.Y[j] - o.Y[j - 1]);
    const a3 = a1 + Math.sign(d) * 0.7;
    const nx = o.X[j - 1] + Math.cos(a3) * l;
    const ny = o.Y[j - 1] + Math.sin(a3) * l;
    if (!fixPt(S, nx, ny, rpx(SS[j]), o.F[j])) {
      const dx = nx - o.X[j];
      const dy = ny - o.Y[j];
      for (let k = j; k < K; k++) {
        o.X[k] += dx;
        o.Y[k] += dy;
      }
    }
  }
  return hits;
}

/** Lifts the arm tip by `lift` px with a flick of its last 15%; returns the rise achieved. */
export function flickTip(c: Cub, o: ArmBuf, lift: number): number {
  if (lift < 0.05) return 0;
  const { FKA, FKL } = c;
  const j0 = FLK_J;
  const y0 = o.Y[K - 1];
  for (let j = j0 + 1; j < K; j++) {
    FKA[j] = Math.atan2(o.Y[j] - o.Y[j - 1], o.X[j] - o.X[j - 1]);
    FKL[j] = Math.hypot(o.X[j] - o.X[j - 1], o.Y[j] - o.Y[j - 1]);
  }
  const lay = (th: number, put?: boolean): number => {
    let x = o.X[j0];
    let y = o.Y[j0];
    for (let j = j0 + 1; j < K; j++) {
      const a = FKA[j] + th * smoother((SS[j] - 0.85) / 0.15);
      x += Math.cos(a) * FKL[j];
      y += Math.sin(a) * FKL[j];
      if (put) {
        o.X[j] = x;
        o.Y[j] = y;
      }
    }
    return y0 - y;
  };
  const sg = lay(0.2) > lay(-0.2) ? 1 : -1;
  let a = 0;
  let ra = 0;
  let b = 0.4 * sg;
  let rb = lay(b);
  for (let k = 0; k < 6 && Math.abs(rb - lift) > 0.1; k++) {
    const d = rb - ra;
    if (Math.abs(d) < 1e-6) break;
    const cc = clamp(-1.4, b + ((lift - rb) * (b - a)) / d, 1.4);
    a = b;
    ra = rb;
    b = cc;
    rb = lay(b);
  }
  return lay(b, true);
}

/** The arm that reaches: the explore arm when the coin is left of the body, the corner arm when it is right. */
export function reachArmOf(c: Cub): number {
  const L = c.L!;
  const OC = c.OC;
  const toCoin = Math.sign(L.octoCoin.x + L.octoCoin.w / 2 - OC.bx) || 1;
  return (toCoin < 0 ? OC.armOf.explore : OC.armOf.corner) ?? -1;
}

/** The coin's top rises by this fraction of its height at full pop. */
export const popLift = (c: Cub): number => (c.o.timeline.coinPop ? c.o.timeline.coinPop.scale / 2 : 0);

/**
 * Octo's face is the AI tile (docs/Brand.md, "One rule for faces"): a square
 * whose corners round off at 30% of its size (AI_TILE_SHAPE_CLASS), so this
 * share of its half-size.
 */
export const COIN_CORNER = 0.6;

/**
 * Octo's coin as the host draws it right now: centre, half-size r and corner
 * radius rc, popped by pop (0..1) and pressed by pressed (0..1).
 */
export interface DrawnCoin {
  cx: number;
  cy: number;
  r: number;
  rc: number;
}

export function coinDrawn(c: Cub, pop: number, pressed: number): DrawnCoin {
  const co = c.L!.octoCoin;
  const cp = c.o.timeline.coinPop;
  const p = clamp(0, pressed, 1);
  const grow = cp ? lerp(cp.scale, cp.press ? cp.press.scale : cp.scale, p) * pop : 0;
  const dy = cp && cp.press ? cp.press.dy * p * pop : 0;
  const r = (Math.min(co.w, co.h) / 2) * (1 + grow);
  return { cx: co.x + co.w / 2, cy: co.y + co.h / 2 + dy, r, rc: COIN_CORNER * r };
}

/**
 * Where a tip of radius rt centred at x rests on the drawn coin with `gap` px
 * of air under it (negative: it presses into the edge): level on the tile's
 * flat top, lower round a corner (a tip there touches the corner's arc).
 */
export function tipYOn(k: DrawnCoin, x: number, rt: number, gap: number): number {
  const flat = k.r - k.rc;
  const R = k.rc + rt + gap;
  const dx = Math.max(0, Math.abs(x - k.cx) - flat);
  return k.cy - flat - Math.sqrt(Math.max(0, R * R - dx * dx));
}

/**
 * Ends the lent arm's tip on (tx, ty) by weight w: whatever the morph's ledge
 * and collision passes left between the tip and its target (at most maxD px)
 * is taken up smoothly over the last quarter of the arm, so a tap lands on the
 * coin instead of hovering just short of it. Returns the distance it closed.
 */
export function landTip(o: ArmBuf, tx: number, ty: number, w: number, maxD: number): number {
  const dx = tx - o.X[K - 1];
  const dy = ty - o.Y[K - 1];
  const d = Math.hypot(dx, dy);
  if (w <= 0 || d < 0.05) return 0;
  const k = Math.min(1, maxD / d) * clamp(0, w, 1);
  for (let j = 1; j < K; j++) {
    const f = smoother((SS[j] - 0.75) / 0.25);
    if (f <= 0) continue;
    o.X[j] += dx * k * f;
    o.Y[j] += dy * k * f;
  }
  return d * k;
}

/** Header and phone perches shift the body (up to 0.2u) when the reach would not fit. */
export function reachPlan(c: Cub): number {
  const L = c.L!;
  const G = c.G!;
  const OC = c.OC;
  const u = OC.u;
  const P = pose(c, OC.bx, REST_B);
  rolesFor(c, P);
  const roots = armRoots(8, P.A, P.Fp, P.Lt);
  const i = reachArmOf(c);
  if (i < 0) return 0;
  const rl = OC.roles![i];
  const q0 = proj(c.cam, madd(madd(P.O, roots[i].R, 0.28 * u), P.A, -0.1 * u));
  const co = L.octoCoin;
  const cc = co.x + co.w / 2;
  const sd = Math.sign(q0[0] - cc) || 1;
  const rpx = (s: number) => armTaper(s, ARM_R0 * u);
  const ty = co.y - popLift(c) * co.h + TAP_LAND - rpx(1);
  const Lest = (rl === "explore" ? Math.min(1.95, 150 / u) : 1.5) * u;
  const T0 = reachRoute(c, G, q0[0], q0[1], cc, ty, u, rpx, Lest, 0, co.w, L.chrome).T;
  const Lg = (rl === "explore" ? 0.75 : 0.8) * Lest;
  const fits = (T: number) => T <= 0.9 * Lest && T <= 1.3 * Lg;
  if (!fits(T0) && OC.mode !== "corner") {
    for (let k = 1; k <= 10; k++) {
      const sh = 0.02 * k * u;
      if (fits(reachRoute(c, G, q0[0] - sd * sh, q0[1], cc, ty, u, rpx, Lest, 0, co.w, L.chrome).T)) return -sd * sh;
    }
    return -0.2 * sd * u;
  }
  return 0;
}
