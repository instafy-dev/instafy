// Arm layout in host px: collision against the window and keep-outs, the
// per-role arm shapes (curvature programs), and the idle schedulers that let
// one or two arms wander. Ported from the owner-approved prototype (not in this repo).

import {
  DANGLE_L,
  DRAPE_IN,
  DRAPE_L,
  EXP_L,
  GN,
  GRIP_A0,
  GRIP_B,
  GRIP_L,
  K,
  PEEK_C,
  PEEK_L,
  PEEK_ON,
  PEEK_OUT,
  PEEK_ROOM,
  PEEK_RUN,
  PEEK_UP,
  REST_L,
  ROLE_N,
  SEAT_LOW,
  SS,
  type ArmRole,
} from "./cubConfig";
import { clamp, fbm, gb, hh, lerp, sstep } from "./cubMath";
import type { ArmBuf, Cub, Geo } from "./cubState";
import type { CubPerchMode } from "./cubTypes";

/** Pushes (x, y) with radius r out of the window (back arms) or below the hang line (front arms) and every keep-out. */
export function fixPt(S: Geo, x: number, y: number, r: number, front: boolean | number): [number, number] | null {
  let X = x;
  let Y = y;
  let mv = false;
  if (!front) {
    if (X > S.wx0 - r && X < S.wx1 + r && Y > S.edgeY - r && Y < S.wy1) {
      const dT = Y - (S.edgeY - r);
      const dL = X - (S.wx0 - r);
      const dR = S.wx1 + r - X;
      const m = Math.min(dT, dL, dR);
      if (m === dT) Y = S.edgeY - r;
      else if (m === dL) X = S.wx0 - r;
      else X = S.wx1 + r;
      mv = true;
    }
  } else {
    if (Y > S.deep - r) {
      Y = S.deep - r;
      mv = true;
    }
    if (X < S.wx0 + r + 2) {
      X = S.wx0 + r + 2;
      mv = true;
    } else if (X > S.wx1 - r - 2) {
      X = S.wx1 - r - 2;
      mv = true;
    }
  }
  for (const b of S.rects) {
    const m = r + (b.m != null ? b.m : 4);
    if (X > b.x - m && X < b.x + b.w + m && Y > b.y - m && Y < b.y + b.h + m) {
      const dT = Y - (b.y - m);
      const dB = b.y + b.h + m - Y;
      const dL = X - (b.x - m);
      const dR = b.x + b.w + m - X;
      const mn = Math.min(dT, dB, dL, dR);
      if (mn === dT) Y = b.y - m;
      else if (mn === dB) Y = b.y + b.h + m;
      else if (mn === dL) X = b.x - m;
      else X = b.x + b.w + m;
      mv = true;
    }
  }
  if (X > S.xMax - r) {
    X = S.xMax - r;
    mv = true;
  } else if (X < S.xMin + r) {
    X = S.xMin + r;
    mv = true;
  }
  return mv ? [X, Y] : null;
}

/** One collision-resolved step from (x, y) toward (nx, ny); the result is written to sf. Returns 1 on a hit. */
export function stepFix(
  S: Geo,
  x: number,
  y: number,
  nx: number,
  ny: number,
  seg: number,
  r: number,
  fr: boolean | number,
  sf: Float64Array,
): number {
  let hit = 0;
  const q = fixPt(S, nx, ny, r, fr);
  if (q) {
    hit = 1;
    const a = Math.atan2(q[1] - y, q[0] - x);
    nx = x + Math.cos(a) * seg;
    ny = y + Math.sin(a) * seg;
    const q2 = fixPt(S, nx, ny, r, fr);
    if (q2) {
      nx = q2[0];
      ny = q2[1];
    }
  }
  const mx = (x + nx) / 2;
  const my = (y + ny) / 2;
  const mq = fixPt(S, mx, my, r, fr);
  if (mq) {
    hit = 1;
    nx += mq[0] - mx;
    ny += mq[1] - my;
    const q3 = fixPt(S, nx, ny, r, fr);
    if (q3) {
      nx = q3[0];
      ny = q3[1];
    }
  }
  sf[0] = nx;
  sf[1] = ny;
  return hit;
}

/** Lays an arm out joint by joint from (x, y) at angle a with curvature kap, resolving collisions. */
export function layArm(
  c: Cub,
  S: Geo,
  x: number,
  y: number,
  a: number,
  Lpx: number,
  kap: (s: number) => number,
  rpx: (s: number) => number,
  front: (s: number) => boolean,
  o: ArmBuf,
  lie: ((s: number) => number) | undefined,
): number {
  const SF = c.sf;
  let hits = 0;
  if (!front(0) && x > S.wx0 && x < S.wx1) {
    const r0 = rpx(0);
    if (y > S.edgeY - r0) y = S.edgeY - r0;
  }
  for (let i = 0; i < K; i++) {
    const s = SS[i];
    o.X[i] = x;
    o.Y[i] = y;
    if (i === K - 1) break;
    const s1 = SS[i + 1];
    const ds = s1 - s;
    const seg = Lpx * ds;
    a += kap(s + ds * 0.5) * ds;
    const nx = x + Math.cos(a) * seg;
    const ny = y + Math.sin(a) * seg;
    if (stepFix(S, x, y, nx, ny, seg, rpx(s1), front(s1), SF)) {
      hits++;
      const ax = Math.atan2(SF[1] - y, SF[0] - x);
      if (Number.isFinite(ax)) a = ax;
    }
    {
      const dx = SF[0] - x;
      const dy = SF[1] - y;
      const dl = Math.hypot(dx, dy);
      if (dl > seg * 1.02) {
        SF[0] = x + (dx / dl) * seg;
        SF[1] = y + (dy / dl) * seg;
      }
    }
    if (lie && !front(s1)) {
      const lw = lie(s1);
      const yl = S.edgeY - rpx(s1);
      if (lw > 0 && SF[0] > S.wx0 && SF[0] < S.wx1 && SF[1] < yl) {
        const l0 = Math.hypot(SF[0] - x, SF[1] - y);
        SF[1] = lerp(SF[1], yl, lw);
        const dx = SF[0] - x;
        const dy = SF[1] - y;
        const dl = Math.hypot(dx, dy) || 1;
        SF[0] = x + (dx / dl) * l0;
        SF[1] = y + (dy / dl) * l0;
        a = Math.atan2(dy, dx);
      }
    }
    x = SF[0];
    y = SF[1];
  }
  return hits;
}

export const bend = (s: number, cc: number, w: number, A: number): number => (A * Math.exp(-(((s - cc) / w) ** 2))) / (w * GN);
export const win = (s: number, a: number, b: number): number => sstep(a - 0.03, a + 0.01, s) * (1 - sstep(b - 0.01, b + 0.03, s));

/** What an arm is doing this frame, beyond its role. */
export interface ArmCtx {
  mode: CubPerchMode;
  /** Distance from the arm root to the window's right end (the corner). */
  dC: number;
  /** Room right of the window's corner before the page margin (where a corner drape hangs). */
  gut: number;
  r: number;
  depth: number;
  tw: number;
  /** Duty: how lively this arm is right now. */
  qa: number;
  tap: number;
  tapW: number;
  wig: number;
  wt: number;
  wave: number;
  wv: number;
  /** The reach role preparation (only on the reach arm). */
  rch: number;
  /** On the reach arm: the x distance from its root to Octo's coin (where the reach drops). */
  dR?: number;
  rE: number;
  mk: number;
}

export interface ArmSpec {
  a0: number;
  L: number;
  front: (s: number) => boolean;
  z: (s: number, z0: number) => number;
  lie?: (s: number) => number;
  kap: (s: number) => number;
  sk0?: number;
}

/** The shape program of one arm: start angle, length (in u), curvature along s, depth, and where it lies on the ledge. */
export function armSpec(
  rl: ArmRole,
  t: number,
  ai: number,
  u: number,
  fe: number,
  fw: number,
  cx: ArmCtx,
): ArmSpec {
  const nz = (p: number, o: number) => clamp(0.5 + 0.62 * fbm(t / p + ai * 1.7 + o * 3.1, 300 + ai * 31 + o * 7), 0, 1);
  const zTo = (zt: number, s0: number, s1: number) => (s: number, z0: number) => lerp(z0, zt * u, sstep(s0, s1, s));
  const never = () => false;
  const fid =
    0.95 * cx.qa * fbm(t / (2.9 + 3.8 * hh(ai * 7 + 1)) + ai * 5.3, 700 + ai * 17) +
    cx.tw +
    cx.wig * Math.sin(6.283 * (1.9 * cx.wt + ai * 0.13));
  const wph = t * (0.21 + 0.08 * hh(ai * 3 + 2)) + ai * 2.1 + 1.5 * fbm(t / 11 + ai, 90 + ai);
  const wa =
    (1.3 + 0.5 * nz(13.7, 4)) *
    (0.15 + 0.85 * cx.qa) *
    (rl === "over" || rl === "rest" || rl === "curl" || rl === "explore" ? 0.6 : 1);
  const body = (s: number) =>
    fid * 7.5 * sstep(0.8, 0.97, s) + wa * Math.sin(6.283 * 1.15 * s + wph) * sstep(0.08, 0.25, s) * (1 - sstep(0.62, 0.8, s));
  const coil = (cc: number, s0: number, s1: number, s: number) => Math.min((1.7 * cc) / (1.22 - s), 12) * sstep(s0, s1, s);
  const hk = Math.max(1, 2 / (0.04 * u));
  switch (rl) {
    case "corner": {
      const dC = cx.dC;
      const rc = cx.rch;
      // Along the ledge, tip coiled; while lent to Octo (rch) shorter, the
      // coil drawn in, so the reach morph starts from the ledge.
      const ledge = (rp: number): ArmSpec => {
        const le = lerp(0.86, 0.46, rp);
        return {
          a0: 0.2,
          L: 1.45 * (1 - 0.2 * rp),
          front: never,
          z: zTo(-0.05, 0, 0.3),
          lie: (s) =>
            sstep(0.06, 0.12, s) *
            (1 - sstep(le - 0.1, le, s)) *
            (1 - fe) *
            (1 - 0.95 * Math.max(win(s, 0.09, 0.25), win(s, 0.25, 0.41), (1 - rp) * win(s, 0.52, 0.68))),
          kap: (s) =>
            -1.2 * (gb(s, 0.3, 0.07) - gb(s, 0.45, 0.07)) -
            2.2 * hk * (gb(s, 0.11, 0.04) - gb(s, 0.23, 0.04)) -
            2.2 * hk * (gb(s, 0.27, 0.04) - gb(s, 0.39, 0.04)) -
            (1 - rp) * 2.4 * hk * (gb(s, 0.54, 0.045) - gb(s, 0.66, 0.045)) -
            lerp(1.15 * coil(1.3 + 0.4 * nz(8.3, 1), 0.68, 0.92, s), coil((1.9 + 0.6 * nz(8.3, 1)) * (1 + 0.7 * rp), 0.5, 0.82, s), rp) *
              (1 - 0.5 * fe) -
            2.2 * fe * sstep(0.45, 0.65, s) +
            0.9 * fe * fw * sstep(0.75, 0.95, s) +
            body(s),
        };
      };
      if (cx.mode !== "corner" || dC <= 0.3 * u || dC >= 3.8 * u) return ledge(rc);
      const Lp = dC * 1.04 + 0.78 * u + 0.08 * u * nz(9.3, 0);
      const sc = clamp((dC * 1.04 + cx.r + 5) / Lp, 0.15, 0.85);
      const drape: ArmSpec = {
        a0: 0.12,
        L: Lp / u,
        front: never,
        z: zTo(-0.05, 0, 0.3),
        lie: (s) => (1 - sstep(sc - 0.12, sc - 0.05, s)) * sstep(0.04, 0.1, s) * (1 - fe) * (1 - 0.95 * win(s, sc * 0.38, sc * 0.72)),
        kap: (s) =>
          bend(s, sc, 0.1, 1.5) -
          (0.6 + 0.5 * sstep(1.5 * u, 3 * u, dC)) * (gb(s, sc * 0.4, 0.06) - gb(s, sc * 0.68, 0.06)) -
          coil((2.3 + 0.6 * nz(7.1, 1)) * (1 - 0.5 * fe), sc + 0.06, sc + 0.26, s) -
          2.4 * fe * sstep(sc + 0.1, sc + 0.25, s) +
          0.9 * fe * fw * sstep(0.8, 0.96, s) +
          fid * 7.5 * sstep(0.8, 0.97, s),
      };
      // Too little room right of the corner to hang a drape (a page margin
      // narrower than the approved hero's 40 px, which leaves 24 px past the
      // page's 16 px edge): the arm lies along the ledge to the corner and its
      // tip lifts there in an open hook instead of dropping down the window's
      // side in a stiff L. Open, not curled: a curl at the corner bunches
      // against the peeking arm's curl beside it into a knot.
      const tight = 1 - sstep(0.12 * u, 0.3 * u, cx.gut);
      const wReady = Math.max(rc, tight);
      if (wReady < 0.001) return drape;
      // Lent to Octo from the corner perch: before it reaches, the arm draws
      // back off the window's corner and lies along the ledge as far as the
      // coin, its tip curled up in the air (the explore arm's pose, mirrored),
      // and it drapes the corner again only once it is home. Morphing straight
      // from the drape folds the arm across its neighbours.
      // Resting in a tight corner (not lent to Octo), the tip's coil opens.
      const hookE = tight * (1 - rc);
      const home = dC - 0.15 * u;
      const run = clamp(0.35 * u, lerp(home, cx.dR ?? home, rc), dC);
      const Lr = run + 0.62 * u;
      const sr = run / Lr;
      const ready: ArmSpec = {
        a0: 0.06,
        L: Lr / u,
        front: never,
        z: drape.z,
        lie: (s) => sstep(0.04, 0.1, s) * (1 - sstep(sr - 0.08, sr, s)) * (1 - fe),
        kap: (s) =>
          -coil(lerp(1.3 + 0.4 * nz(7.1, 1), 0.6 + 0.15 * nz(7.1, 1), hookE) * (1 - 0.4 * fe), sr, Math.min(0.97, sr + 0.4), s) -
          1.2 * fe * sstep(sr + 0.1, sr + 0.3, s) +
          0.5 * body(s),
      };
      return {
        a0: lerp(drape.a0, ready.a0, wReady),
        L: lerp(drape.L, ready.L, wReady),
        front: never,
        z: drape.z,
        lie: (s) => lerp(drape.lie!(s), ready.lie!(s), wReady),
        kap: (s) => lerp(drape.kap(s), ready.kap(s), wReady),
      };
    }
    case "dangle": {
      const dy = clamp(0, (cx.qa - 0.27) / 0.73, 1);
      const Lp = clamp(0.55 * u, cx.depth * 0.6 + 0.2 * u, 0.85 * u);
      const ph = (2 * Math.PI * t) / 7.7 + ai + 0.6 * fbm(t / 9.1, 77);
      const A = (0.24 + 0.06 * nz(11.3, 0)) * (0.15 + 0.85 * dy);
      if (cx.mode !== "corner")
        return {
          a0: 1.05,
          L: Math.max(0.7 * u, Lp) / u,
          front: (s) => s > 0.1,
          z: zTo(0.35, 0, 0.15),
          kap: (s) =>
            bend(s, 0.1, 0.05, Math.PI / 2 + 0.25 * A * Math.sin(ph) - 1.05) -
            A * 2 * Math.cos(ph - 5 * s) * sstep(0.15, 0.3, s) +
            bend(s, 0.3, 0.08, cx.mode === "header" ? 0.5 : -0.7) +
            (cx.mode === "header" ? -1 : 1) *
              coil((cx.mode === "header" ? 1.6 + 0.3 * nz(8.9, 1) : 2.2 + 0.4 * nz(8.9, 1)) * (1 - 0.4 * fe), 0.5, 0.8, s) -
            1.2 * fe * sstep(0.5, 0.75, s) +
            1.1 * fe * fw * sstep(0.78, 0.95, s) +
            fid * 7.5 * sstep(0.8, 0.97, s),
        };
      const Ld = clamp(0.62 * u, cx.depth * 0.7 + 0.25 * u, DANGLE_L * u);
      return {
        a0: 1.3,
        L: Ld / u,
        front: (s) => s > 0.1,
        z: zTo(0.35, 0, 0.15),
        kap: (s) =>
          bend(s, 0.1, 0.05, Math.PI / 2 + 0.25 * A * Math.sin(ph) - 1.05) -
          A * 4 * Math.cos(ph - 5 * s) * sstep(0.15, 0.3, s) +
          bend(s, 0.34, 0.09, -0.35) +
          bend(s, 0.52, 0.09, 0.25) +
          0.62 * coil((1.3 + 0.5 * nz(8.9, 1)) * (1 - 0.4 * fe), 0.62, 0.92, s) -
          2.2 * fe * sstep(0.5, 0.75, s) +
          1.1 * fe * fw * sstep(0.78, 0.95, s) +
          fid * 7.5 * sstep(0.8, 0.97, s),
      };
    }
    case "grip": {
      const dy = clamp(0, (cx.qa - 0.27) / 0.73, 1);
      const Lp = clamp(0.55 * u, cx.depth * 1.1 + 0.22 * u, 0.8 * u);
      const ph = (2 * Math.PI * t) / 8.3 + ai + 0.6 * fbm(t / 8.7, 79);
      const Ag = 0.2 * dy;
      if (cx.mode !== "corner")
        return {
          a0: 1.62,
          L: Math.max(0.62 * u, Lp) / u,
          front: (s) => s > 0.1,
          z: zTo(0.35, 0, 0.15),
          kap: (s) =>
            bend(s, 0.25, 0.08, 0.7) -
            bend(s, 0.55, 0.08, 1) -
            Ag * 4 * Math.cos(ph - 4 * s) * sstep(0.1, 0.25, s) -
            coil((1.4 + 0.4 * nz(9.3, 0)) * (1 - 0.4 * fe), 0.62, 0.88, s) +
            1.4 * fe * fw * sstep(0.65, 0.95, s) +
            fid * 7.5 * sstep(0.8, 0.97, s),
        };
      const rE = cx.rE || 0;
      const Lg = clamp(0.6 * u, cx.depth * 1.1 + 0.25 * u, GRIP_L * u) * (1 - 0.2 * rE);
      return {
        a0: GRIP_A0 - 0.45 * rE,
        L: Lg / u,
        front: (s) => s > 0.1,
        z: zTo(0.35, 0, 0.15),
        kap: (s) =>
          -0.25 * gb(s, 0.15, 0.08) +
          bend(s, 0.32, 0.08, GRIP_B) -
          Ag * 4 * Math.cos(ph - 4 * s) * sstep(0.1, 0.25, s) -
          0.75 * coil((1.4 + 0.5 * nz(9.3, 0)) * (1 - 0.4 * fe), 0.5, 0.9, s) +
          1.4 * fe * fw * sstep(0.65, 0.95, s) +
          fid * 7.5 * sstep(0.8, 0.97, s),
      };
    }
    case "explore": {
      const ext = sstep(0.2, 0.8, nz(12.7, 0));
      const wv = cx.wave || 0;
      const wq = wv * (cx.wv || 0);
      return {
        a0: Math.PI - 0.08,
        L: Math.min(EXP_L + 0.2 * ext, 150 / u) * (1 - 0.08 * cx.rch),
        front: never,
        z: zTo(-0.15, 0, 0.3),
        lie: (s) => Math.max(gb(s, 0.16, 0.06), gb(s, 0.5, 0.06) * (1 - wv)) * (1 - fe) * (1 - cx.tapW * sstep(0.62, 0.75, s)),
        kap: (s) =>
          3.6 * (gb(s, 0.27, 0.05) - gb(s, 0.39, 0.05)) +
          coil((1.5 + 0.5 * nz(9.7, 2)) * (1 - 0.4 * fe) * (1 - 0.35 * cx.tapW) * (1 + 0.55 * cx.rch) * (1 - 0.5 * wv), 0.52, 0.8, s) +
          2.2 * fe * sstep(0.4, 0.6, s) -
          1.1 * fe * fw * sstep(0.8, 0.95, s) +
          body(s) +
          3.4 * cx.tap * sstep(0.72, 0.86, s) +
          bend(s, 0.5, 0.07, 0.75 * wv) +
          3.2 * wq * sstep(0.62, 0.8, s) * (1 - sstep(0.86, 0.97, s)),
      };
    }
    case "rest": {
      const mk = cx.mk || 0;
      return {
        a0: Math.PI - 0.04,
        L: REST_L * (1 - 0.85 * mk),
        front: never,
        z: zTo(-0.5, 0, 0.3),
        lie: (s) => sstep(0.05, 0.1, s) * (1 - (1 - mk) * sstep(0.78, 0.86, s)) * (1 - fe),
        kap: (s) => (1 - mk) * coil((1.1 + 0.4 * nz(10.1, 0)) * (1 - 0.5 * fe), 0.8, 0.96, s) + 0.4 * body(s),
      };
    }
    case "over": {
      return {
        a0: -Math.PI / 2 - 1.0 - 1.6 * SEAT_LOW,
        L: 0.72,
        front: never,
        z: zTo(-1.15, 0, 0.22),
        kap: (s) =>
          1.6 * sstep(0.1, 0.5, s) * (0.8 + 0.3 * nz(11.9, 0)) * (1 - sstep(0.5, 0.62, s)) -
          (cx.mode === "corner" ? 0.7 : 1.25) * coil((1.4 + 0.6 * nz(6.7, 1)) * (1 - 0.5 * fe), 0.6, 0.88, s) +
          0.9 * fe * fw * sstep(0.75, 0.95, s) +
          body(s),
      };
    }
    case "curl": {
      const co = Math.pow(nz(13.1, 0), 1.5);
      if (cx.mode === "corner" && PEEK_ON && cx.dC < 3.2 * u) {
        // A narrow page margin right of the corner leaves the peek's curl no
        // room past it: it peeks up that much further in, so the page edge
        // never squashes the curl into a knot.
        const run = cx.dC + PEEK_OUT * u - Math.max(0, PEEK_ROOM * u - cx.gut);
        const Lp = run + PEEK_L * u;
        const s1 = run / Lp;
        const k = 1 / (1 - s1);
        return {
          a0: 0.03,
          L: Lp / u,
          front: never,
          z: zTo(-0.65, 0, 0.2),
          lie: (s) => sstep(0.04, 0.1, s) * (1 - sstep(s1 - 0.1, s1 - 0.02, s)) * (1 - fe),
          kap: (s) =>
            -bend(s, s1, 0.05, PEEK_UP) +
            k * coil((PEEK_C + 0.4 * co) * (1 - 0.45 * fe), s1 + 0.35 * (1 - s1), 0.95, s) -
            1.2 * fe * sstep(s1 + 0.2, s1 + 0.5, s) +
            0.8 * fe * fw * sstep(0.8, 0.95, s) +
            0.6 * k * body(s),
        };
      }
      if (cx.mode !== "corner" && PEEK_ON) {
        const run = PEEK_RUN * u;
        const Lp = run + PEEK_L * 0.9 * u;
        const s1 = run / Lp;
        const k = 1 / (1 - s1);
        return {
          a0: 0.03,
          L: Lp / u,
          front: never,
          z: zTo(-0.65, 0, 0.2),
          lie: (s) => sstep(0.04, 0.1, s) * (1 - sstep(s1 - 0.1, s1 - 0.02, s)) * (1 - fe),
          kap: (s) =>
            -bend(s, s1, 0.05, PEEK_UP) +
            k * coil((PEEK_C + 0.4 * co) * (1 - 0.45 * fe), s1 + 0.35 * (1 - s1), 0.95, s) -
            1.2 * fe * sstep(s1 + 0.2, s1 + 0.5, s) +
            0.8 * fe * fw * sstep(0.8, 0.95, s) +
            0.6 * k * body(s),
        };
      }
      return {
        a0: -1.05 + 2.6 * SEAT_LOW,
        L: 1.0 * (1 - 1.6 * SEAT_LOW),
        front: never,
        z: zTo(-1, 0, 0.2),
        kap: (s) =>
          -coil((1.4 + 1.1 * co) * (1 - 0.55 * fe), 0.42, 0.76, s) -
          1.5 * fe * sstep(0.4, 0.62, s) +
          0.8 * fe * fw * sstep(0.7, 0.95, s) +
          body(s),
      };
    }
    default: {
      if (cx.mode === "corner") {
        const run = clamp(0.3 * u, cx.dC - DRAPE_IN * u, 1.25 * u);
        const Ld = DRAPE_L * u;
        const Lp = run + Ld;
        const s1 = run / Lp;
        const kr = Lp / (run + 0.8 * u);
        const dy = clamp(0, (cx.qa - 0.27) / 0.73, 1);
        const ph = (2 * Math.PI * t) / 8.9 + ai + 0.6 * fbm(t / 9.7, 81);
        const Ag = 0.16 * dy;
        return {
          a0: 0.06,
          L: Lp / u,
          sk0: s1 + 0.08,
          front: (s) => s > s1 - 0.01,
          z: (s, z0) => lerp(z0, -0.2 * u, sstep(0, 0.25, s * kr)),
          lie: (s) => sstep(0.04, 0.1, s * kr) * (1 - sstep(s1 - 0.08, s1 - 0.01, s)) * (1 - fe),
          kap: (s) =>
            bend(s, s1, 0.05, 1.42) -
            Ag * 3 * Math.cos(ph - 4 * s) * sstep(s1 + 0.05, s1 + 0.2, s) * (1 / (1 - s1)) +
            bend(s, s1 + 0.3 * (1 - s1), 0.06, 0.1) +
            coil((1.15 + 0.35 * nz(7.7, 1)) * (1 - 0.4 * fe), s1 + 0.55 * (1 - s1), 0.94, s) * (1 / (1 - s1)) +
            1.1 * fe * fw * sstep(0.8, 0.95, s) +
            fid * 7.5 * sstep(0.85, 0.97, s),
        };
      }
      return {
        a0: 0.26,
        L: 1.1,
        front: never,
        z: zTo(-0.4, 0, 0.3),
        lie: (s) => sstep(0.06, 0.12, s) * (1 - sstep(0.86, 0.92, s)) * (1 - fe) * (1 - 0.95 * Math.max(win(s, 0.18, 0.37), win(s, 0.5, 0.69))),
        kap: (s) =>
          -2.8 * hk * (gb(s, 0.21, 0.045) - gb(s, 0.33, 0.045)) -
          2.8 * hk * (gb(s, 0.53, 0.045) - gb(s, 0.65, 0.045)) -
          2.4 * coil((1.35 + 0.6 * nz(7.7, 1)) * (1 - 0.5 * fe), 0.85, 0.97, s) -
          1.8 * fe * sstep(0.45, 0.65, s) +
          0.8 * fe * fw * sstep(0.75, 0.95, s) +
          body(s),
      };
    }
  }
}

/** Idle "feel" events: one arm at a time stretches and feels around. Deterministic in t. */
function feelEv(c: Cub, k: number) {
  const FEV = c.FEV;
  while (FEV.length <= k) {
    const i = FEV.length;
    const p = i ? FEV[i - 1] : null;
    const t0 = p ? p.t0 + p.d + 3.4 + 5.2 * hh(i * 31 + 7) : 3.2 + 2.2 * hh(5);
    const d = 2.4 + 1.4 * hh(i * 17 + 3);
    let r = Math.floor(hh(i * 13 + 11) * 8) % 8;
    if (p && r === p.r) r = (r + 3) % 8;
    FEV.push({ t0, d, r, ph: hh(i * 7 + 1) * 6.283, per: 1.7 + 0.6 * hh(i * 5 + 2) });
  }
  return FEV[k];
}

export function feelAt(c: Cub, t: number): { role: ArmRole; e: number; w: number } | null {
  while (c.fevI > 0 && feelEv(c, c.fevI).t0 > t) c.fevI--;
  while (feelEv(c, c.fevI + 1).t0 <= t) c.fevI++;
  const e = feelEv(c, c.fevI);
  const x = t - e.t0;
  if (x < 0 || x > e.d) return null;
  return {
    role: ROLE_N[e.r],
    e: sstep(0, 0.9, x) * (1 - sstep(e.d - 1.1, e.d, x)),
    w: Math.sin((6.283 * x) / e.per + e.ph) * sstep(0.3, 1.2, x),
  };
}

function dutyEv(c: Cub, ch: number, k: number) {
  const A = c.DUTY[ch];
  while (A.length <= k) {
    const i = A.length;
    const p = i ? A[i - 1] : null;
    const t0 = p ? p.t0 + (ch ? 11 : 8) + (ch ? 6 : 7) * hh(i * 29 + ch * 101 + 5) : ch ? -7 : -3;
    let r = Math.floor(hh(i * 13 + ch * 57 + 3) * 8) % 8;
    if (p && r === p.r) r = (r + 5) % 8;
    A.push({ t0, r });
  }
  return A[k];
}

/** Duty cycles: which arms are lively right now (two overlapping channels). */
export function dutyOf(c: Cub, i: number, t: number): number {
  let w = 0;
  for (let ch = 0; ch < 2; ch++) {
    while (c.DUI[ch] > 0 && dutyEv(c, ch, c.DUI[ch]).t0 > t) c.DUI[ch]--;
    while (dutyEv(c, ch, c.DUI[ch] + 1).t0 <= t) c.DUI[ch]++;
    const e = dutyEv(c, ch, c.DUI[ch]);
    const p = c.DUI[ch] ? dutyEv(c, ch, c.DUI[ch] - 1) : null;
    const k = sstep(e.t0, e.t0 + 2.5, t);
    if (e.r === i) w = Math.max(w, k);
    if (p && p.r === i) w = Math.max(w, 1 - k);
  }
  return w;
}

/** Resamples a control polyline (Catmull-Rom) to the arm's joints; returns its length. */
export function pathArm(ctrl: number[][], o: ArmBuf): number {
  const dense: number[][] = [];
  for (let i = 0; i < ctrl.length - 1; i++) {
    const p0 = ctrl[Math.max(0, i - 1)];
    const p1 = ctrl[i];
    const p2 = ctrl[i + 1];
    const p3 = ctrl[Math.min(ctrl.length - 1, i + 2)];
    for (let j = 0; j < 12; j++) {
      const t = j / 12;
      const t2 = t * t;
      const t3 = t2 * t;
      dense.push([
        0.5 * (2 * p1[0] + (-p0[0] + p2[0]) * t + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 + (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3),
        0.5 * (2 * p1[1] + (-p0[1] + p2[1]) * t + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3),
      ]);
    }
  }
  dense.push(ctrl[ctrl.length - 1]);
  const cum = [0];
  for (let i = 1; i < dense.length; i++) cum.push(cum[i - 1] + Math.hypot(dense[i][0] - dense[i - 1][0], dense[i][1] - dense[i - 1][1]));
  const T = cum[cum.length - 1];
  let k = 0;
  for (let i = 0; i < K; i++) {
    const d = SS[i] * T;
    while (k < dense.length - 2 && cum[k + 1] < d) k++;
    const f = clamp(0, (d - cum[k]) / Math.max(1e-6, cum[k + 1] - cum[k]), 1);
    o.X[i] = lerp(dense[k][0], dense[k + 1][0], f);
    o.Y[i] = lerp(dense[k][1], dense[k + 1][1], f);
  }
  return T;
}

/** Segment angles and lengths of an arm (index 0 unused). */
export function toAng(o: ArmBuf, A: Float64Array, Ls: Float64Array): void {
  for (let j = 1; j < K; j++) {
    const dx = o.X[j] - o.X[j - 1];
    const dy = o.Y[j] - o.Y[j - 1];
    A[j] = Math.atan2(dy, dx);
    Ls[j] = Math.hypot(dx, dy);
  }
}

export function armLen(o: ArmBuf): number {
  let l = 0;
  for (let j = 1; j < K; j++) l += Math.hypot(o.X[j] - o.X[j - 1], o.Y[j] - o.Y[j - 1]);
  return l;
}
