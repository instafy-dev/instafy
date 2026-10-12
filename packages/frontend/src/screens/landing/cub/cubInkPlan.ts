// Crew ink, part 1: where the four drops land. Keep-outs (copy, CTAs, chips,
// chat text, coins and Cub himself), the siphon behind the arm root, the
// ballistic squirt, and the planners: the splat planner (v3, the approved
// "four splats" look) and the plain logo-arc planner it falls back to.
// Ported from the owner-approved prototype (not in this repo). The dots / heart click modes
// of the prototype are not ported; their planner (inkPlan) is kept because the
// splat uses its geometry as the last resort.

import { INK_LOGO } from "./cubConfig";
import { hh, lerp } from "./cubMath";
import type { Ball, Cub, InkPlan, InkVary, KeepRect } from "./cubState";
import type { CubRect } from "./cubTypes";

/** At most this many sets on the wall; boops closer than INK_GAP queue up. */
export const INK_GAP = 0.15;
export const INK_CAP = 3;
const INK_LR = 3.5;
/** The drawn head is wider than its spine circles. */
export const INK_HEAD = 1.15;
/** Fade of a replaced set (seconds). */
export const INK_FADE = 0.28;
/** Splat timings: emit, stagger, hold on the wall, soak, crown burst, fade, quick fade, jet. */
export const INK_TS = { emit: 0.07, stag: 0.03, hold: 2.2, soak: 0.95, crown: 0.075, fade: 0.28, fq: 0.15, jet: 0.074 } as const;
/** Gravity (u/s^2), drag (1/s), footprint / core radius, steepest landing heading. */
const INK_G = 52;
const INK_DRAG = 2.2;
export const INK_SFOOT = 1.5;
export const INK_HDMAX = 0.52;
const INK_SK = 1.6;
const INK_PX = 0.8;
const INK_FAN = [1.42, 1.1, 0.82, 0.6];
const INK_NEAR = 2.2;
const INK_NEAR_COL = 0.6;

/** Every ink keep-out: the collision rects plus Octo's coin, the only rect treated as a coin (see note in inkClearS). */
export function inkKeep(c: Cub): KeepRect[] {
  return c.G!.rects.concat([{ ...c.L!.octoCoin, coin: true }]);
}

/** Caches the keep-out list and Cub's bounding box while a set is planned or built. */
export function inkFast(c: Cub, on: boolean): void {
  const I = c.ink;
  if (!on) {
    I.kc = I.hbb = null;
    return;
  }
  I.kc = inkKeep(c);
  let x0 = 1e9;
  let y0 = 1e9;
  let x1 = -1e9;
  let y1 = -1e9;
  const H = c.HIT;
  for (let i = 0; i < c.NHIT; i++) {
    const x = H[i * 3];
    const y = H[i * 3 + 1];
    const r = H[i * 3 + 2];
    x0 = Math.min(x0, x - r);
    x1 = Math.max(x1, x + r);
    y0 = Math.min(y0, y - r);
    y1 = Math.max(y1, y + r);
  }
  I.hbb = [x0, y0, x1, y1];
}

/** Desktop: the air above the avatar row is off limits, so four dots never read as a second row of badges. */
function inkCoinCol(c: Cub, hc = 2.4): CubRect | null {
  const L = c.L!;
  const u = c.OC.u;
  return L.mobile || !L.coins.length
    ? null
    : { x: L.coinL - 0.2 * u, y: L.coins[0].y - hc * u, w: L.coinR - L.coinL + 0.4 * u, h: hc * u + L.coins[0].h };
}

/** The siphon: at the arm roots just above the ledge, just inside the outline, on side sd. */
export function inkSiphon(c: Cub, sd: number): [number, number] {
  const u = c.OC.u;
  const y = c.G!.edgeY - 0.03 * u;
  let x: number | null = null;
  const H = c.HIT;
  for (let i = 0; i < c.NBODYH; i++) {
    const r = (H[i * 3 + 2] - 2) * INK_HEAD;
    const dy = y - H[i * 3 + 1];
    if (Math.abs(dy) >= r) continue;
    const ex = H[i * 3] + sd * Math.sqrt(r * r - dy * dy);
    if (x == null || sd * ex > sd * x) x = ex;
  }
  return [x == null ? c.HEADC[0] + sd * 0.7 * u : x - sd * 3, y];
}

/** Inside the ink layer (with margins). */
export function inkBounds(c: Cub, x: number, y: number, R: number): boolean {
  const C = c.ink.R;
  const { DPR, W } = c.cam;
  return (
    x - R >= Math.max(8, C.x / DPR + 2) &&
    x + R <= Math.min(W - 8, (C.x + C.w) / DPR - 2) &&
    y - R >= C.y / DPR + 4 &&
    y + R <= (C.y + C.h) / DPR - 2
  );
}

export const inkNear = (b: CubRect, x: number, y: number, R: number): boolean =>
  Math.hypot(Math.max(b.x - x, 0, x - (b.x + b.w)), Math.max(b.y - y, 0, y - (b.y + b.h))) < R;

function inkClear(c: Cub, x: number, y: number, R: number): boolean {
  for (const b of c.ink.kc || inkKeep(c)) if (inkNear(b, x, y, R)) return false;
  return true;
}

/** Whether (x, y) comes within m of Cub (his hit circles). */
export function inkHit(c: Cub, x: number, y: number, m: number): boolean {
  const B = c.ink.hbb;
  if (B && (x < B[0] - m || x > B[2] + m || y < B[1] - m || y > B[3] + m)) return false;
  const H = c.HIT;
  for (let i = 0; i < c.NHIT; i++) {
    const hx = H[i * 3];
    const hy = H[i * 3 + 1];
    const r = H[i * 3 + 2] + m;
    if (Math.hypot(x - hx, y - hy) < r) return true;
  }
  return false;
}

function inkFree(c: Cub, x: number, y: number, r: number, hc = 2.4): boolean {
  const L = c.L!;
  const u = c.OC.u;
  if (!inkBounds(c, x, y, r + 2) || !inkClear(c, x, y, r + 8) || inkHit(c, x, y, r + Math.max(6, 0.22 * u))) return false;
  const cc = inkCoinCol(c, hc);
  if (cc && inkNear(cc, x, y, r + Math.max(32, L.coins[0].h, 0.6 * u))) return false;
  for (const b of c.ink.sets) if (b.fadeT == null) for (const d of b.drops) if (Math.hypot(x - d.tx, y - d.ty) < d.r + r + 5) return false;
  return true;
}

/** A squirt, not a lob: it leaves nearly level, peaks late and drops in. */
const inkArcH = (sx: number, tx: number, u: number): number => 0.16 * u + 0.15 * Math.abs(tx - sx);
const inkAt = (sx: number, sy: number, tx: number, ty: number, h: number, s: number): [number, number] => {
  const q = Math.pow(s, INK_SK);
  return [lerp(sx, tx, s + INK_PX * s * (1 - s)), lerp(sy, ty, s) - 4 * h * q * (1 - q)];
};
/** A fan: the drop that flies farthest arcs highest. */
const inkFanOf = (sd: number, i: number): number => INK_FAN[sd < 0 ? i : 3 - i];

function inkPathOK(c: Cub, sp: number[], pts: number[][], r: number, u: number, sd: number): boolean {
  for (let i = 0; i < 4; i++) {
    const p = pts[i];
    const h = inkArcH(sp[0], p[0], u) * inkFanOf(sd, i) * 1.08;
    for (let s = 0.25; s < 1; s += 0.125) {
      const q = inkAt(sp[0], sp[1], p[0], p[1], h, s);
      if (!inkBounds(c, q[0], q[1], r) || !inkClear(c, q[0], q[1], r + 4)) return false;
    }
  }
  return true;
}

const inkRad = (c: Cub, sc: number): number => Math.max(c.L!.mobile ? 4.2 : 5.2, (c.L!.mobile ? 0.195 : 0.101) * c.OC.u * sc);

/** The logo's four dot centres at drop size r, tilted and jittered by vr, the lowest drop at y 0 (plain arc if a jitter flattens it). */
export function inkArc(vr: Pick<InkVary, "rot" | "sp" | "dy">, r: number, plain?: boolean): number[][] {
  const k = (r / INK_LR) * vr.sp;
  const ca = Math.cos(vr.rot);
  const sa = Math.sin(vr.rot);
  const P0 = INK_LOGO.map((q, i) => {
    const a = (q[0] - INK_LOGO[1][0]) * k;
    const b = (q[1] - INK_LOGO[1][1]) * k + vr.dy[i] * r;
    return [a * ca - b * sa, a * sa + b * ca];
  });
  const lo = Math.max(...P0.map((q) => q[1]));
  const P = P0.map((q) => [q[0], q[1] - lo]);
  const y = (i: number) => P[i][1];
  const ok = y(1) === 0 && y(0) < -0.4 * r && y(2) < -0.6 * r && y(3) < y(2) - 0.4 * r && P[2][0] - P[1][0] > 1.2 * (P[1][0] - P[0][0]);
  return ok || plain ? P : inkArc({ rot: 0, sp: 1, dy: [0, 0, 0, 0] }, r, true);
}

/** The plain logo-arc planner (the splat's last resort): near spot on the ledge first, then further along or up the wall. */
export function inkPlan(c: Cub, pref: number, vr: InkVary): InkPlan | null {
  const L = c.L!;
  const G = c.G!;
  const u = c.OC.u;
  const BODYC = c.BODYC;
  if (!L.mobile)
    for (let lv = 0; lv < 1; lv++)
      for (const sc of [1, 0.8])
        for (const sd of [pref, -pref]) {
          const r = inkRad(c, sc);
          const sp = inkSiphon(c, sd);
          const near = sd < 0 ? 3 : 0;
          const gy = G.edgeY - r - 0.5 - lv * 0.6 * u;
          const P = inkArc(vr, r);
          for (let g = (0.25 + 0.3 * vr.gx) * u; g < 3 * u; g += 3) {
            const ox = sp[0] + sd * (g + r) - P[near][0];
            const pts = P.map((q) => [ox + q[0], gy + q[1]]);
            if (
              Math.hypot(pts.reduce((a, q) => a + q[0], 0) / 4 - BODYC[0], pts.reduce((a, q) => a + q[1], 0) / 4 - BODYC[1]) >
              INK_NEAR * u
            )
              break;
            if (pts.every((q) => inkFree(c, q[0], q[1], r, INK_NEAR_COL)) && inkPathOK(c, sp, pts, r, u, sd))
              return { sd, r, pts, near: true, lv: 0 };
          }
        }
  for (let lv = 0; lv < 4; lv++)
    for (const sc of [1, 0.8, 0.64])
      for (const sd of [pref, -pref]) {
        const r = inkRad(c, sc);
        const sp = inkSiphon(c, sd);
        const near = sd < 0 ? 3 : 0;
        const gy = G.edgeY - r - 0.5 - lv * 0.6 * u;
        const P = inkArc(vr, r);
        for (let g = (1.1 + vr.gx) * u; g < 5 * u; g += 4) {
          const ox = sp[0] + sd * (g + r) - P[near][0];
          const pts = P.map((q) => [ox + q[0], gy + q[1]]);
          if (pts.every((q) => inkFree(c, q[0], q[1], r)) && inkPathOK(c, sp, pts, r, u, sd)) return { sd, r, pts, near: false, lv: 0 };
        }
      }
  return null;
}

/** The first boop lands the logo's own arc; later ones vary tilt, spacing and side (capped so the set still reads as the logo). */
export function inkVary(n: number, seed: number, soft?: boolean): InkVary {
  const j = (i: number) => hh(seed + i * 37) - 0.5;
  if (n === 0)
    return soft
      ? { rot: 0.06 * j(1), sp: 1 + 0.05 * j(2), dy: [0, 1, 2, 3].map((i) => 0.16 * j(10 + i)), gx: 0, flip: false }
      : { rot: 0, sp: 1, dy: [0, 0, 0, 0], gx: 0, flip: false };
  return { rot: 0.16 * j(1), sp: 1 + 0.2 * j(2), dy: [0, 1, 2, 3].map((i) => 0.36 * j(10 + i)), gx: (0.5 + j(3)) * 0.7, flip: n % 2 === 1 };
}

/** The side the ink prefers: left from the corner perch, otherwise the side with more room. */
export function inkSide(c: Cub): number {
  const L = c.L!;
  if (c.OC.mode === "corner") return -1;
  const lb = L.mobile ? L.chips.x + L.chips.w : c.G!.wx0;
  return c.cam.W - 16 - c.HEADC[0] > c.HEADC[0] - lb ? 1 : -1;
}

export const inkTog = (c: Cub): boolean => c.o.splash === "together";
/** Apart: the logo arc's spacing at core radius R. */
const inkSSP = (c: Cub): number => (c.L!.mobile ? 1 : 0.95);
/** Core radius: about 0.85u across on desktop. */
const inkSRad = (c: Cub, sc: number): number => {
  const m = c.L!.mobile;
  const u = c.OC.u;
  return inkTog(c) ? Math.max(m ? 6.7 : 10, (m ? 0.38 : 0.37) * u * sc) : Math.max(m ? 7.2 : 11, (m ? 0.46 : 0.42) * u * sc);
};
export function inkRng(seed: number): () => number {
  let k = 0;
  return () => hh(seed * 7 + k++ * 7919 + 13);
}
export const inkWrap = (a: number): number => Math.atan2(Math.sin(a), Math.cos(a));

/** The set's size hierarchy: one dominant stain, one medium neighbour, two small; gj loosens the arc. */
export function inkSizes(c: Cub, seed: number, first: boolean): { sz: number[]; gj: number[] } {
  const r = inkRng(seed + 911);
  const dom = first ? 1 : r() < 0.6 ? 1 : 2;
  const med = dom + (r() < 0.5 ? -1 : 1);
  const m = c.L!.mobile;
  const f = [0, 1, 2, 3].map((i) => (i === dom ? (m ? 1.18 : 1.26) + 0.08 * r() : i === med ? 0.96 + 0.08 * r() : (m ? 0.8 : 0.72) + 0.08 * r()));
  return { sz: f, gj: [0, 1, 2].map(() => 1 + 0.26 * (r() - 0.5)) };
}

/** The splat siphon: behind the arm root, a little under the ledge line (the jet is hidden until it clears the face). */
export function inkSiphonS(c: Cub, sd: number): [number, number] {
  const s = inkSiphon(c, sd);
  const u = c.OC.u;
  return [s[0] - sd * 0.14 * u, s[1] + 0.07 * u];
}

/** A ballistic squirt with drag: apex H above the siphon, landing exactly on (tx, ty). */
export function inkBall(sx: number, sy: number, tx: number, ty: number, H: number, u: number, gk = 1): Ball {
  const g = INK_G * u * gk;
  const D = sy - ty;
  H = Math.max(H, D + 0.2 * u, 0.12 * u);
  const vy = -Math.sqrt(2 * g * H);
  const T = (Math.sqrt(2 * H) + Math.sqrt(2 * (H - D))) / Math.sqrt(g);
  const vx = ((tx - sx) * INK_DRAG) / (1 - Math.exp(-INK_DRAG * T));
  return { sx, sy, T, vx, vy, g };
}
export const inkBP = (B: Ball, t: number): [number, number] => [
  B.sx + (B.vx * (1 - Math.exp(-INK_DRAG * t))) / INK_DRAG,
  B.sy + B.vy * t + 0.5 * B.g * t * t,
];
export const inkBV = (B: Ball, t: number): [number, number] => [B.vx * Math.exp(-INK_DRAG * t), B.vy + B.g * t];
export const inkSH = (sx: number, tx: number, u: number, sd: number, i: number): number => inkArcH(sx, tx, u) * inkFanOf(sd, i);

/**
 * Splat keep-outs: copy, CTAs, chips and chat text keep the full footprint F plus margin; a coin only needs the
 * stain's own body R clear of it, and never blocks a drop in flight. Only Octo's coin counts as a coin here: in the
 * approved prototype the other roster coins were matched by object identity, which every relayout broke, so in
 * steady state they always behaved as ordinary keep-outs. That behaviour is kept on purpose.
 */
export function inkClearS(c: Cub, x: number, y: number, F: number, R: number, flight?: boolean): boolean {
  for (const b of c.ink.kc || inkKeep(c)) {
    const coin = !!b.coin;
    if (coin && flight) continue;
    // The phone bar right under the ledge: only the stain's body keeps clear of a glyph or the title.
    if (inkNear(b, x, y, coin ? R + 10 : b.bar ? Math.min(F, R + 3) : F)) return false;
  }
  return true;
}

function inkFreeS(c: Cub, x: number, y: number, F: number, R: number, cm: number): boolean {
  if (!inkBounds(c, x, y, F + 2) || !inkClearS(c, x, y, F + 8 + cm, R) || inkHit(c, x, y, F + Math.max(6, 0.22 * c.OC.u))) return false;
  for (const b of c.ink.sets) if (b.fadeT == null) for (const d of b.drops) if (Math.hypot(x - d.tx, y - d.ty) < d.r + F + 5) return false;
  return true;
}

function inkPathOKS(c: Cub, sp: number[], pts: number[][], Rs: number[], u: number, sd: number, hk = 1): boolean {
  for (let i = 0; i < 4; i++) {
    const p = pts[i];
    const R = Rs[i];
    const B = inkBall(sp[0], sp[1], p[0], p[1], inkSH(sp[0], p[0], u, sd, i) * 1.12 * hk, u);
    for (let s = 0.3; s < 0.95; s += 0.1) {
      const q = inkBP(B, s * B.T);
      if (!inkBounds(c, q[0], q[1], 0.75 * R) || !inkClearS(c, q[0], q[1], 0.75 * R + 4, R, true)) return false;
    }
  }
  return true;
}

/** Together: the four cores in logo order in a flattened copy of the logo's arc. */
function inkTogArc(vr: InkVary, R: number): number[][] {
  const X = [0, 1.5, 3, 4.5];
  const Y = [-0.28, 0, -0.34, -0.52];
  const k = vr.sp;
  const ca = Math.cos(0.5 * vr.rot);
  const sa = Math.sin(0.5 * vr.rot);
  const P0 = X.map((x, i) => {
    const a = (x - 1.5) * R * k;
    const b = (Y[i] + 0.3 * vr.dy[i]) * R;
    return [a * ca - b * sa, a * sa + b * ca];
  });
  const lo = P0[1][1];
  return P0.map((q) => [q[0], Math.min(0, q[1] - lo)]);
}

/** Apart on desktop: the logo arc with its wide middle gap closed up a little. */
function inkArcS(P: number[][], r: number): number[][] {
  const Q = P.map((q) => q.slice());
  const x0 = P[1][0];
  Q[0][0] = x0 - 2.95 * r;
  Q[2][0] = x0 + 3.7 * r;
  Q[3][0] = Q[2][0] + 3 * r;
  return Q;
}

/** The arc re-spaced for the stains' own sizes (f) and loosened by gj; green stays the anchor. */
function inkRespace(c: Cub, P: number[][], f: number[], gj: number[], tog: boolean, R: number): number[][] {
  const m = c.L!.mobile;
  const X = [P[0][0], P[1][0], P[2][0], P[3][0]];
  const gap = (i: number) => {
    const s = (f[i] + f[i + 1]) / 2;
    const g = (P[i + 1][0] - P[i][0]) * s * gj[i];
    return tog ? Math.max(g, 0.74 * (f[i] + f[i + 1]) * R) : Math.max(g, (f[i] + f[i + 1]) * R * (m ? 1.2 : 1.32) + (m ? 6.5 : 7));
  };
  X[0] = X[1] - gap(0);
  X[2] = X[1] + gap(1);
  X[3] = X[2] + gap(2);
  return P.map((q, i) => [X[i], q[1]]);
}

/**
 * Where the four splats land: the lowest (green) straddling the window's top edge, the whole set over the window.
 * Desktop first tries the near spot beside the arm, then further along the ledge; every ledge option, at full and
 * then smaller sizes, comes before the wall. Returns null when nothing fits.
 */
export function inkPlanS(c: Cub, pref: number, vr: InkVary): InkPlan | null {
  inkFast(c, true);
  try {
    return inkPlanS0(c, pref, vr);
  } finally {
    inkFast(c, false);
  }
}

function inkPlanS0(c: Cub, pref: number, vr: InkVary): InkPlan | null {
  const L = c.L!;
  const G = c.G!;
  const u = c.OC.u;
  const mob = L.mobile;
  const tog = inkTog(c);
  const gv = 0.5 * vr.gx * u;
  const eyeY = (c.EYEG[0].y + c.EYEG[1].y) / 2;
  const f = vr.sz || [1, 1, 1, 1];
  const gj = vr.gj || [1, 1, 1];
  const at = (sc: number, sd: number, lv: number, g0: number, g1: number, step: number, cap: number, ssp = inkSSP(c)): InkPlan | null => {
    const R = inkSRad(c, sc);
    const Ri = f.map((k) => k * R);
    const Fi = Ri.map((r) => r * INK_SFOOT);
    const sp = inkSiphonS(c, sd);
    const ni = sd < 0 ? 3 : 0;
    const fy = tog ? (mob ? 0.6 : 0.8) : mob ? 0.4 : 0.7;
    const base = tog ? inkTogArc(vr, R) : mob ? inkArc(vr, R * ssp) : inkArcS(inkArc(vr, R * ssp), R * ssp);
    const P = inkRespace(c, base, f, gj, tog, R).map((q, i) => [q[0], q[1] * fy - (mob ? 0.74 : 0.8) * Ri[i]]);
    const cm = lv ? 9 : 4;
    for (let g = g0; g < g1; g += step) {
      const ox = sp[0] + sd * (g + Fi[ni]) - P[ni][0];
      const pts = P.map((q) => [ox + q[0], G.edgeY - lv * 0.6 * u + q[1]]);
      if (
        cap &&
        Math.hypot(pts.reduce((a, q) => a + q[0], 0) / 4 - c.BODYC[0], pts.reduce((a, q) => a + q[1], 0) / 4 - c.BODYC[1]) > cap
      )
        break;
      if (pts.some((q, i) => q[0] - 1.3 * Ri[i] - (mob ? 14 : 4) < G.wx0 || q[0] + 1.3 * Ri[i] + (mob ? 14 : 4) > G.wx1)) break;
      if (pts.some((q) => Math.abs(q[0] - c.HEADC[0]) < (mob ? 2.35 : 2.2) * u && q[1] < eyeY)) continue;
      if (pts.every((q, i) => inkFreeS(c, q[0], q[1], Fi[i], Ri[i], cm))) {
        const hk = inkPathOKS(c, sp, pts, Ri, u, sd) ? 1 : inkPathOKS(c, sp, pts, Ri, u, sd, 0.66) ? 0.66 : 0;
        if (hk) return { sd, r: R, rs: Ri, pts, near: !!cap, lv, hk };
      }
    }
    return null;
  };
  const near = (sd: number, sc: number) => (mob ? null : at(sc, sd, 0, (0.2 + 0.25 * vr.gx) * u, 3.5 * u, 5, (INK_NEAR + (tog ? 1.6 : 2.8)) * u));
  const far = (sd: number, sc: number, lv: number, ssp?: number) =>
    at(sc, sd, lv, (lv ? 1.1 * u : 0.25 * u) + gv, (lv ? 5 : 8) * u, 6, 0, ssp);
  let p: InkPlan | null;
  for (const sc of [1, 0.88, 0.76, 0.7, 0.64]) {
    for (const sd of [pref, -pref]) if ((p = near(sd, sc)) || (p = far(sd, sc, 0))) return p;
    for (const sd of [pref, -pref]) if ((p = far(sd, sc, 0, 0.85 * inkSSP(c)))) return p;
  }
  for (let lv = 1; lv < 4; lv++) for (const sd of [pref, -pref]) for (const sc of [1, 0.85, 0.72]) if ((p = far(sd, sc, lv))) return p;
  for (let lv = 0; lv < 4; lv++) for (const sd of [pref, -pref]) if ((p = far(sd, 0.5, lv))) return p;
  return null;
}

/** A small piece of ink may land at (x, y): on the page, clear of keep-outs and Cub, over the window, no lower than maxY. */
export function inkSpotS(c: Cub, x: number, y: number, r: number, maxY: number, cmBuild: number, cm = 0): boolean {
  const G = c.G!;
  const e = c.L!.mobile ? 10 : 3;
  if (
    y > maxY ||
    x - r - e < G.wx0 ||
    x + r + e > G.wx1 ||
    !inkBounds(c, x, y, r + 1) ||
    !inkClearS(c, x, y, r + 4 + cmBuild, r + 2 + cm) ||
    inkHit(c, x, y, r + 4)
  )
    return false;
  return true;
}
