// Crew ink, part 2: the stains. Each landed drop is a lumpy core plus a crown
// of separate pieces (curved streaks with beaded chains, wedge spikes, nubs, a
// fringe of hairs and a mist of satellites), unioned into one flat outline.
// Ported from the owner-approved prototype (not in this repo): splat r2, the
// approved v3 look.

import { clamp, eo, lerp, smoother } from "./cubMath";
import {
  INK_HDMAX,
  INK_SFOOT,
  INK_TS,
  inkBall,
  inkBV,
  inkFast,
  inkRng,
  inkSH,
  inkSiphonS,
  inkSpotS,
  inkTog,
  inkWrap,
} from "./cubInkPlan";
import type { Cub, InkDrop, InkPiece, InkPlan, InkSet } from "./cubState";

/** Anything a polygon can be traced into (Path2D in the browser). */
export interface PathSink {
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  closePath(): void;
}

const INK_NL = 256;

/** The core's edge radius by absolute angle: elongated along the heading, mass pushed forward, lumpy. */
function inkCoreLUT(d: Pick<InkDrop, "R" | "el" | "hd" | "fk" | "hm">): Float32Array {
  const a = d.R * Math.sqrt(d.el);
  const b = d.R / Math.sqrt(d.el);
  const T = new Float32Array(INK_NL + 1);
  for (let k = 0; k <= INK_NL; k++) {
    const rel = (k / INK_NL) * 6.2831853 - Math.PI - d.hd;
    const cs = Math.cos(rel);
    const s = Math.sin(rel);
    let n = 1 + d.fk * cs;
    for (const h of d.hm) n += h.amp * Math.sin(h.k * rel + h.ph);
    T[k] = n / Math.sqrt((cs * cs) / (a * a) + (s * s) / (b * b));
  }
  return T;
}

export function inkRC(d: Pick<InkDrop, "lut">, th: number): number {
  let f = (th + Math.PI) / 6.2831853;
  f -= Math.floor(f);
  const p = f * INK_NL;
  const k = p | 0;
  return d.lut[k] + (d.lut[k + 1] - d.lut[k]) * (p - k);
}

/** Ease out with a ~7% overshoot. */
const inkBack = (x: number): number => {
  x = clamp(0, x, 1);
  const c1 = 1.3;
  const c3 = c1 + 1;
  const y = x - 1;
  return 1 + c3 * y * y * y + c1 * y * y;
};
/** The flying head flattens into the core. */
const inkCoreS = (al: number): number => (al < 0.035 ? lerp(0.4, 1.05, eo(al / 0.035)) : lerp(1.05, 1, smoother((al - 0.035) / 0.07)));

const INK_FS: Record<InkPiece["kind"], readonly number[]> = {
  L: [0, 0.05, 0.11, 0.18, 0.27, 0.37, 0.47, 0.57, 0.67, 0.77, 0.86, 0.94, 1],
  S: [0, 0.07, 0.16, 0.3, 0.46, 0.62, 0.78, 0.9, 1],
  F: [0, 0.3, 0.65, 1],
  N: [0, 0.35, 0.6, 0.8, 0.93, 1],
};

/** A piece's half-width at fraction f of its length (with the small flare where it leaves the core). */
function inkPW(p: InkPiece, f: number): number {
  const fl = f < p.ff ? p.fl * (1 - f / p.ff) * (1 - f / p.ff) : 0;
  if (p.kind === "L") return p.wb * Math.pow(1 - f, 0.75) * (1 + (p.sw ?? 0) * Math.exp(-(((f - (p.sf ?? 0)) / 0.17) ** 2))) + fl;
  if (p.kind === "N") return p.wb * Math.sqrt(Math.max(0, 1 - f * f)) + fl;
  return p.wb * Math.pow(1 - f, p.pw ?? 1) + fl;
}
/** The piece's centreline at f (length L, leaving the core at radius rb), bending sideways toward the tip. */
function inkPC(d: InkDrop, p: InkPiece, f: number, L: number, rb: number): [number, number] {
  const cs = Math.cos(p.a);
  const s = Math.sin(p.a);
  const al = rb + f * L;
  const lt = p.bend * L * f * f;
  return [d.tx + cs * al - s * lt, d.ty + s * al + cs * lt];
}
function inkPT(p: InkPiece, f: number): [number, number] {
  const cs = Math.cos(p.a);
  const s = Math.sin(p.a);
  const k = 2 * p.bend * f;
  const x = cs - s * k;
  const y = s + cs * k;
  const m = Math.hypot(x, y);
  return [x / m, y / m];
}
function inkPiece(P: PathSink, d: InkDrop, p: InkPiece, cg: number, cs: number): void {
  const L = p.L * cs;
  const rb = p.rb * cg;
  if (L < 0.3) return;
  const F = INK_FS[p.kind];
  const n = F.length;
  const c = Math.cos(p.a);
  const s = Math.sin(p.a);
  const dep = Math.min(0.3 * d.R, 0.5 * rb);
  const w0 = inkPW(p, 0);
  const bx = d.tx + c * (rb - dep);
  const by = d.ty + s * (rb - dep);
  const xs = [bx - s * w0];
  const ys = [by + c * w0];
  const rx = [bx + s * w0];
  const ry = [by - c * w0];
  for (let j = 0; j < n - 1; j++) {
    const f = F[j];
    const q = inkPC(d, p, f, L, rb);
    const t = inkPT(p, f);
    const w = inkPW(p, f);
    xs.push(q[0] - t[1] * w);
    ys.push(q[1] + t[0] * w);
    rx.push(q[0] + t[1] * w);
    ry.push(q[1] - t[0] * w);
  }
  const tp = inkPC(d, p, 1, L, rb);
  xs.push(tp[0]);
  ys.push(tp[1]);
  for (let j = rx.length - 1; j >= 0; j--) {
    xs.push(rx[j]);
    ys.push(ry[j]);
  }
  inkPoly(P, xs, ys);
}
/** The bead k of a chain beyond a piece's tip. */
function inkBeadAt(d: InkDrop, p: InkPiece, b: { g: number }, L: number, rb: number, k = 1): [number, number, number] {
  const tp = inkPC(d, p, 1, L, rb);
  const t = inkPT(p, 1);
  return [tp[0] + t[0] * b.g * k, tp[1] + t[1] * b.g * k, Math.atan2(t[1], t[0])];
}

/** Makes a set of four drops from a plan: ballistic squirts from the siphon, stains with their lumpy cores. */
export function inkMakeS(c: Cub, t: number, st: boolean, quick: boolean, pl: InkPlan, seed: number): InkSet {
  const u = c.OC.u;
  const rnd = inkRng(seed);
  const sp0 = inkSiphonS(c, pl.sd);
  const gk = quick ? 1.25 : 1;
  const mob = c.L!.mobile;
  const tog = inkTog(c);
  const Rs = pl.rs || pl.pts.map(() => pl.r);
  const drops: InkDrop[] = pl.pts.map((p, i) => {
    const ord = pl.sd < 0 ? i : 3 - i;
    const R = Rs[i];
    const H = inkSH(sp0[0], p[0], u, pl.sd, i) * (0.74 + 0.16 * rnd()) * (pl.hk || 1);
    const sj = (rnd() - 0.5) * 0.04 * u;
    const B = inkBall(sp0[0], sp0[1] + sj, p[0], p[1], H, u, gk);
    const v = inkBV(B, B.T);
    const lim = Math.tan(INK_HDMAX) * Math.abs(v[0]);
    const hd = Math.atan2(clamp(-lim, v[1], lim), v[0]) + (rnd() - 0.5) * 0.44;
    const mf = mob ? 1.15 : 1;
    const t0 = t + INK_TS.emit + ord * INK_TS.stag + 0.012 * rnd();
    const wob = rnd() * 6.283;
    const el = (mob ? 1.08 : 1.08) + (mob ? 0.1 : 0.14) * rnd();
    const fk = 0.04 + 0.05 * rnd();
    const hm = (
      [
        [2, 0.02 + 0.025 * rnd()],
        [3, 0.02 + 0.025 * rnd()],
        [4 + Math.floor(rnd() * 3), (0.03 + 0.03 * rnd()) * mf],
        [7 + Math.floor(rnd() * 4), (0.02 + 0.02 * rnd()) * mf],
        [13 + Math.floor(rnd() * 5), 0.006 + 0.006 * rnd()],
      ] as [number, number][]
    ).map(([k, amp]) => ({ k, amp, ph: rnd() * 6.283 }));
    const core = { R, el, hd, fk, hm };
    const lut = inkCoreLUT(core);
    return {
      i,
      ord,
      tx: p[0],
      ty: p[1],
      R,
      kf: clamp(0.7, R / pl.r, 1.35),
      r: R * INK_SFOOT,
      H,
      sj,
      B0: B,
      hd,
      t0,
      B: null,
      wob,
      el,
      fk,
      hm,
      sk: [],
      sat: [],
      path: null,
      built: false,
      bb: null,
      lut,
      rmax: Math.max(...lut),
    };
  });
  // Together: one burst, so the four land at the same instant (a hair apart, in logo order).
  if (tog && !st) {
    const tl = Math.max(...drops.map((d) => d.t0 + d.B0.T));
    for (const d of drops) d.t0 = tl - d.B0.T + 0.006 * d.i;
  }
  const b: InkSet = {
    t,
    st,
    tog,
    sd: pl.sd,
    seed,
    near: pl.near,
    lv: pl.lv || 0,
    gk,
    dur: INK_TS.hold + INK_TS.soak + 0.05,
    drops,
    PCS: [],
    nb: 0,
    fadeT: null,
  };
  // Reduced motion: the whole set at once (no flight to hide the work in).
  if (st) while (b.nb < 4) inkBuildS(c, b);
  return b;
}

/** Builds the next stain's crown and spray (in logo order, so separation sees every earlier piece). */
export function inkBuildS(c: Cub, b: InkSet): void {
  if (b.nb >= 4) return;
  const d = b.drops[b.nb++];
  if (d.built) return;
  d.built = true;
  inkFast(c, true);
  try {
    inkCrownS(c, b, d, b.lv ? 9 : 4);
  } finally {
    inkFast(c, false);
  }
}

function inkCrownS(c: Cub, b: InkSet, d: InkDrop, cmBuild: number): void {
  const u = c.OC.u;
  const mob = c.L!.mobile;
  const tog = b.tog;
  const ey = c.G!.edgeY;
  const R = d.R;
  const kf = d.kf;
  const rnd = inkRng(b.seed * 3 + d.i * 1013 + 77);
  const sc = Math.max(mob ? 0.55 : 0.6, u / 79.2);
  const drops = b.drops;
  const PCS = b.PCS;
  const GAP = mob ? 6.5 : 5;
  const maxY = ey + 0.6 * R;
  const small = kf < 0.85;
  const least = drops.every((o) => o.R >= R - 0.01);
  const coreGap = (x: number, y: number, o: InkDrop) => {
    const dx = x - o.tx;
    const dy = y - o.ty;
    return Math.hypot(dx, dy) - inkRC(o, Math.atan2(dy, dx)) * 1.04;
  };
  // Apart: no piece of one colour within GAP px of another colour. Together: crowns cross, satellites stay off other cores.
  const sepOK = (x: number, y: number, r: number, sat: boolean, cross?: number) => {
    if (tog) {
      if (cross) return true;
      for (const o of drops) if (o.i !== d.i && coreGap(x, y, o) - r < (sat ? 1.5 : -0.15 * o.R)) return false;
      return true;
    }
    for (const o of drops) if (o.i !== d.i && coreGap(x, y, o) - r < GAP) return false;
    for (const q of PCS) if (q.i !== d.i && Math.hypot(x - q.x, y - q.y) - q.r - r < GAP) return false;
    return true;
  };
  const spot = (x: number, y: number, r: number, my: number, sat: boolean, cross?: number) =>
    inkSpotS(c, x, y, r, my, cmBuild, sat ? 8 : 0) && sepOK(x, y, r, sat, cross);
  const okP = (p: InkPiece, L: number) => {
    const rb = p.rb;
    for (const f of p.kind === "F" ? [1] : [0.35, 0.7, 1]) {
      const q = inkPC(d, p, f, L, rb);
      if (!spot(q[0], q[1], Math.max(0.6, inkPW(p, f)), maxY, false, p.x)) return false;
    }
    if (p.chain)
      for (const ch of p.chain) {
        const q = inkBeadAt(d, p, ch, L, rb);
        if (!spot(q[0], q[1], ch.r * ch.e, maxY, false)) return false;
      }
    return true;
  };
  const sk = d.sk;
  const add = (p: InkPiece, Lmin: number, gap?: number): InkPiece | null => {
    if (sk.some((o) => Math.abs(inkWrap(o.a - p.a)) < (p.kind === "L" && o.kind === "L" ? 0.3 : p.kind === "F" || o.kind === "F" ? 0.09 : gap || 0.14)))
      return null;
    p.rb = inkRC(d, p.a);
    let L = p.L;
    if (p.chain && !okP(p, L)) {
      if (p.kind === "L" && p.chain.length > 1) {
        p.chain = p.chain.slice(0, 1);
        if (!okP(p, L)) p.chain = null;
      } else p.chain = null;
    }
    while (L >= Lmin && !okP(p, L)) L -= (p.kind === "F" ? 0.03 : 0.06) * R;
    if (L < Lmin) return null;
    // A spike cut short at the window's edge would read as a stub (a foot).
    if (p.kind === "S" && L < 0.6 * p.L && Math.sin(p.a) > 0.3) return null;
    p.L = L;
    sk.push(p);
    for (const f of p.kind === "F" ? [1] : [0.35, 0.7, 1]) {
      const q = inkPC(d, p, f, L, p.rb);
      PCS.push({ x: q[0], y: q[1], r: Math.max(0.6, inkPW(p, f)), i: d.i });
    }
    if (p.chain)
      for (const ch of p.chain) {
        const q = inkBeadAt(d, p, ch, L, p.rb);
        PCS.push({ x: q[0], y: q[1], r: ch.r * ch.e, i: d.i });
      }
    return p;
  };
  // Direction rules: streaks never up the wall (above ~21 deg) nor steeply down (below ~46 deg).
  const clampL = (a: number) => {
    const s = Math.sin(a);
    const cx = Math.cos(a) < 0 ? -1 : 1;
    return s < -0.36 ? Math.atan2(-0.36, cx * 0.933) : s > 0.72 ? Math.atan2(0.72, cx * 0.694) : inkWrap(a);
  };
  const chainOf = (n: number, r0: number, gm: number) => {
    const C: { g: number; r: number; e: number }[] = [];
    let g = 0;
    let pr = 0;
    for (let k = 0; k < n; k++) {
      const r = r0 * Math.pow(0.7, k);
      g += pr + (gm + (mob ? 0.08 : 0.05) * rnd()) * R + r;
      pr = r;
      C.push({ g, r, e: k ? 1 + 0.15 * rnd() : 1.2 + 0.3 * rnd() });
    }
    return C;
  };
  const wL = () => (mob ? Math.max(0.5, 0.045 * R) : (0.04 + 0.016 * rnd()) * R);
  // 1. Streaks: stratified across the fan (never parallel), the primary nearest the heading.
  const nL = mob
    ? kf > 1.1 || rnd() < 0.4
      ? 2
      : 1
    : kf > 1.15
      ? 3 + (rnd() < 0.5 ? 1 : 0)
      : kf > 0.9
        ? 2 + (rnd() < 0.6 ? 1 : 0)
        : 2;
  const FAN = 0.96;
  const rels = [...Array(nL)].map((_, k) => -FAN + (2 * FAN * (k + 0.15 + 0.7 * rnd())) / nL);
  let pri = 0;
  for (let k = 1; k < nL; k++) if (Math.abs(rels[k]) + 0.25 * rnd() < Math.abs(rels[pri])) pri = k;
  const ord = [pri, ...rels.map((_, k) => k).filter((k) => k !== pri)];
  for (const k of ord) {
    const prim = k === pri;
    const a = clampL(d.hd + rels[k]);
    const L0 = prim
      ? (mob ? 1.2 + 0.22 * rnd() : small ? 0.84 + 0.2 * rnd() : 0.98 + 0.22 * rnd()) * R
      : (mob ? 0.55 + 0.3 * rnd() : 0.4 + 0.42 * rnd()) * R;
    const nc = prim
      ? mob
        ? 1 + (rnd() < 0.5 ? 1 : 0)
        : least
          ? 1
          : small
            ? 2
            : 2 + Math.floor(rnd() * 3)
      : rnd() < 0.35
        ? 1
        : 0;
    const r0 = Math.max(mob ? 0.75 : 1, (prim ? 0.065 + 0.025 * rnd() : 0.05 + 0.02 * rnd()) * R * (mob ? 1.15 : 1));
    const wb = wL();
    const sw = 0.35 + 0.45 * rnd();
    const sf = 0.5 + 0.2 * rnd();
    const fl = (mob ? 0.07 : 0.06) * R;
    const bend = (rnd() - 0.5) * 0.26;
    const chain = nc ? chainOf(nc, r0, 0.05) : null;
    const p = add({ kind: "L", a, L: L0, wb, sw, sf, fl, ff: 0.16, bend, chain, rb: 0 }, 0.3 * R);
    // A small stain's one long streak gets a short spike beside it (never a balloon on a string).
    if (p && prim && (small || mob)) {
      const s2 = rnd() < 0.5 ? 1 : -1;
      const a2 = inkWrap(p.a + s2 * (0.26 + 0.14 * rnd()));
      const L2 = (0.32 + 0.16 * rnd()) * R;
      const wb2 = mob ? 0.55 + 0.2 * rnd() : (0.05 + 0.03 * rnd()) * R;
      const pw = 1.3 + 0.4 * rnd();
      const bend2 = (rnd() - 0.5) * 0.16;
      add({ kind: "S", a: a2, L: L2, wb: wb2, pw, fl: 0.03 * R, ff: 0.14, bend: bend2, chain: null, rb: 0 }, 0.12 * R, 0.12);
    }
  }
  // Together: a smaller stain (drawn over its bigger neighbour) splashes a short spike across the seam.
  if (tog)
    for (const o of drops)
      if (Math.abs(o.i - d.i) === 1 && (o.R > R || (o.R === R && o.i < d.i))) {
        const tw = Math.atan2(o.ty - d.ty, o.tx - d.tx);
        const a = inkWrap(tw + (rnd() - 0.5) * 0.5);
        const L = (0.35 + 0.2 * rnd()) * R;
        const wb = mob ? 0.6 : (0.05 + 0.02 * rnd()) * R;
        const bend = (rnd() - 0.5) * 0.12;
        add({ kind: "S", a, L, wb, pw: 1.4, fl: 0.03 * R, ff: 0.14, bend, chain: null, x: 1, rb: 0 }, 0.15 * R, 0.1);
      }
  // 2. Wedge spikes all round, longest toward the heading.
  const nS = mob ? 5 + (rnd() < 0.6 ? 1 : 0) : Math.round((5 + 3 * rnd()) * (0.85 + 0.2 * kf));
  for (let k = 0, got = 0; k < nS * 3 && got < nS; k++) {
    let rel = (rnd() * 2 - 1) * Math.PI;
    if (rnd() < 0.5) rel *= 0.5;
    const a = inkWrap(d.hd + rel);
    const sy = Math.sin(a);
    const cf = Math.max(0, Math.cos(rel));
    if (sy > 0.87) continue;
    let L = (mob ? 0.32 + 0.45 * rnd() : 0.2 + 0.5 * rnd()) * R * (0.45 + 0.55 * cf);
    let wb = mob ? 0.5 + 0.25 * rnd() : (0.05 + 0.045 * rnd()) * R;
    if (sy > 0.55) {
      L = Math.min(L, 0.28 * R);
      wb = Math.min(wb, mob ? 0.55 : 0.05 * R);
    }
    if (sy < -0.6) L = Math.min(L, 0.32 * R);
    const pw = 1.2 + 0.7 * rnd();
    const fl = (mob ? 0.04 : 0.035) * R;
    const bend = (rnd() - 0.5) * 0.16;
    const chain = rnd() < 0.22 ? chainOf(1, Math.max(mob ? 0.7 : 0.85, (0.04 + 0.02 * rnd()) * R), 0.04) : null;
    if (add({ kind: "S", a, L, wb, pw, fl, ff: 0.14, bend, chain, rb: 0 }, 0.12 * R)) got++;
  }
  // A nub or two on the upper flanks (desktop).
  if (!mob)
    for (let k = 0, n = Math.floor(rnd() * 2.4), got = 0; k < 6 && got < n; k++) {
      const sg = rnd() < 0.5 ? 1 : -1;
      const a = inkWrap(d.hd + sg * (0.9 + 1.2 * rnd()));
      if (Math.sin(a) > 0.35) continue;
      const L = (0.06 + 0.08 * rnd()) * R;
      const wb = (0.07 + 0.04 * rnd()) * R;
      if (add({ kind: "N", a, L, wb, fl: 0.03 * R, ff: 0.3, bend: 0, chain: null, rb: 0 }, 0.04 * R)) got++;
    }
  // 3. The fringe: hairs walked round the rim at irregular 12-32 deg steps.
  {
    let th = d.hd + Math.PI + (rnd() - 0.5) * 0.5;
    const end = th + 6.2831853;
    let n = 0;
    while (n < 20) {
      th += 0.21 + 0.35 * rnd();
      if (th >= end) break;
      const a = inkWrap(th);
      const rel = inkWrap(a - d.hd);
      const fr = 0.5 + 0.5 * Math.cos(rel);
      const L = mob ? Math.max(1.5, (0.12 + 0.2 * rnd()) * R * (0.6 + 0.4 * fr)) : (0.05 + 0.15 * rnd()) * R * (0.55 + 0.45 * fr) + 0.6;
      const wb = mob ? 0.3 + 0.15 * rnd() : 0.3 + 0.3 * rnd();
      const fl = mob ? 0.35 : Math.max(0.35, 0.018 * R);
      const bend = (rnd() - 0.5) * 0.1;
      if (add({ kind: "F", a, L, wb, pw: 1.1, fl, ff: 0.3, bend, chain: null, rb: 0 }, mob ? 1 : 0.035 * R)) n++;
    }
  }
  // 4. The mist: satellites in the streak cones, smaller and sparser with distance; a few bigger ones close in.
  const ax: { a: number; reach: number; w: number }[] = [];
  for (const p of sk)
    if (p.kind === "L") {
      const q = p.chain ? inkBeadAt(d, p, p.chain[p.chain.length - 1], p.L, p.rb) : inkPC(d, p, 1, p.L, p.rb);
      const dx = q[0] - d.tx;
      const dy = q[1] - d.ty;
      ax.push({ a: Math.atan2(dy, dx), reach: Math.hypot(dx, dy) + (p.chain ? p.chain[p.chain.length - 1].r : 0), w: p.L });
    }
  ax.push({ a: d.hd, reach: inkRC(d, d.hd) + 0.25 * R, w: 0.45 * R });
  const Wt = ax.reduce((a, q) => a + q.w, 0);
  const pick = () => {
    let v = rnd() * Wt;
    for (const q of ax) if ((v -= q.w) <= 0) return q;
    return ax[ax.length - 1];
  };
  const sy0 = ey + 0.7 * R;
  const tryS = (a: number, dist: number, rs: number, tl: number) => {
    const x = d.tx + Math.cos(a) * dist;
    const y = d.ty + Math.sin(a) * dist;
    if (d.sat.some((o) => Math.hypot(o.x - x, o.y - y) < o.rs + rs + 1.5) || !spot(x, y, rs + 0.5, sy0, true)) return false;
    if (tl > rs) {
      const ex = x + Math.cos(a) * tl;
      const ey2 = y + Math.sin(a) * tl;
      if (!spot(ex, ey2, 0.6, sy0, true)) return false;
    }
    d.sat.push({ a, dist, rb: inkRC(d, a), rs, tl, x, y });
    PCS.push({ x, y, r: rs + (tl > rs ? tl * 0.5 : 0), i: d.i });
    return true;
  };
  const nBig = mob ? 1 : 2 + Math.floor(rnd() * 2.6);
  const nM = mob ? 5 + Math.floor(rnd() * 4) : Math.round((12 + 13 * rnd()) * clamp(0.8, kf, 1.15));
  for (let k = 0, got = 0; k < nBig * 5 && got < nBig; k++) {
    const q = pick();
    const rs = (mob ? 1.3 + 0.4 * rnd() : 2.5 + rnd()) * sc;
    const a = q.a + (rnd() - 0.5) * 0.6;
    const dist = q.reach + (0.12 + 0.45 * rnd()) * R + rs;
    const tl = rs * (1.2 + 0.8 * rnd());
    if (tryS(a, dist, rs, tl)) got++;
  }
  for (let k = 0, got = 0; k < nM * 3 && got < nM; k++) {
    const q = pick();
    const df = Math.pow(rnd(), 1.3);
    const rs = Math.max(0.5, (mob ? lerp(1.2, 0.6, df) : lerp(2, 0.5, df)) * (0.75 + 0.35 * rnd()) * sc);
    if (d.sat.length < 24) {
      const a = q.a + (rnd() + rnd() - 1) * 0.5;
      const dist = q.reach + (0.06 + 1.15 * df) * R * (mob ? 1.25 : 1) + rs;
      const tl = rs > 1.3 ? rs * (1.2 + rnd()) : 0;
      if (tryS(a, dist, rs, tl)) got++;
    }
  }
  // A crowded stain still gets its spray: search the whole front half.
  for (let k = 0, need = mob ? 5 : 8; k < 36 && d.sat.length < need; k++) {
    const a = d.hd + (rnd() - 0.5) * 3.4;
    const rs = Math.max(0.5, (mob ? 0.6 + 0.5 * rnd() : 0.6 + 1 * rnd()) * sc);
    tryS(a, inkRC(d, a) + (0.2 + 1.1 * rnd()) * R + rs, rs, 0);
  }
  for (let k = 0, got = 0, n = mob ? (rnd() < 0.4 ? 1 : 0) : 1 + (rnd() < 0.4 ? 1 : 0); k < 8 && got < n; k++) {
    const a = d.hd + Math.PI + (rnd() - 0.5) * 1.6;
    const rs = Math.max(0.5, (0.6 + 0.6 * rnd()) * sc);
    if (tryS(a, inkRC(d, a) + (0.25 + 0.5 * rnd()) * R + rs, rs, 0)) got++;
  }
  // The settled bounding box (css px, relative to the centre).
  let x0 = 0;
  let y0 = 0;
  let x1 = 0;
  let y1 = 0;
  const bx = (x: number, y: number, r: number) => {
    x0 = Math.min(x0, x - r);
    y0 = Math.min(y0, y - r);
    x1 = Math.max(x1, x + r);
    y1 = Math.max(y1, y + r);
  };
  bx(0, 0, d.rmax * 1.06 + 2);
  for (const p of sk) {
    const q = inkPC(d, p, 1, p.L * 1.08, p.rb);
    bx(q[0] - d.tx, q[1] - d.ty, 1);
    if (p.chain)
      for (const ch of p.chain) {
        const e = inkBeadAt(d, p, ch, p.L, p.rb);
        bx(e[0] - d.tx, e[1] - d.ty, ch.r * ch.e + 1);
      }
  }
  for (const o of d.sat) {
    bx(o.x - d.tx, o.y - d.ty, o.rs + 1);
    bx(o.x - d.tx + Math.cos(o.a) * o.tl, o.y - d.ty + Math.sin(o.a) * o.tl, 1);
  }
  d.bb = [x0 - 2, y0 - 2, x1 + 2, y1 + 2];
}

/** Every piece is a closed polygon with the same (positive) winding, so a nonzero fill is their union. */
export function inkPoly(P: PathSink, xs: number[], ys: number[]): void {
  const n = xs.length;
  if (n < 3) return;
  let A = 0;
  for (let k = 0; k < n; k++) {
    const j = k + 1 === n ? 0 : k + 1;
    A += xs[k] * ys[j] - xs[j] * ys[k];
  }
  if (A >= 0) {
    P.moveTo(xs[0], ys[0]);
    for (let k = 1; k < n; k++) P.lineTo(xs[k], ys[k]);
  } else {
    P.moveTo(xs[n - 1], ys[n - 1]);
    for (let k = n - 2; k >= 0; k--) P.lineTo(xs[k], ys[k]);
  }
  P.closePath();
}

/** A teardrop: a round head of radius r (stretched e) at (cx, cy) with a pointed tail tl toward ang. */
export function inkTearPoly(P: PathSink, cx: number, cy: number, r: number, ang: number, tl: number, e = 1): void {
  const cs = Math.cos(ang);
  const s = Math.sin(ang);
  const xs: number[] = [];
  const ys: number[] = [];
  const put = (lx: number, ly: number) => {
    xs.push(cx + lx * cs - ly * s);
    ys.push(cy + lx * s + ly * cs);
  };
  if (tl <= r * e * 1.05) {
    for (let k = 0; k < 16; k++) {
      const a = (k / 16) * 6.2831853;
      put(Math.cos(a) * r * e, Math.sin(a) * r);
    }
  } else {
    const t0 = Math.acos(Math.min(0.999, (r * e) / tl));
    for (let k = 0; k <= 14; k++) {
      const a = t0 + ((6.2831853 - 2 * t0) * k) / 14;
      put(Math.cos(a) * r * e, Math.sin(a) * r);
    }
    put(tl, 0);
  }
  inkPoly(P, xs, ys);
}

/** One stain al seconds after impact (core, crown, beads, spray); the crown shoots out over ~75 ms. Cached once settled. */
export function inkShape(d: InkDrop, al: number): Path2D {
  if (d.path && al > INK_TS.crown + 0.03) return d.path;
  const cg = inkCoreS(al);
  const q = 1 - smoother(al / 0.11);
  const cs = inkBack(al / INK_TS.crown);
  const cd = eo((al - 0.015) / 0.08);
  const ss = eo(al / 0.09);
  const hx = Math.cos(d.hd);
  const hy = Math.sin(d.hd);
  const P = new Path2D();
  const xs: number[] = [];
  const ys: number[] = [];
  for (let k = 0; k < 144; k++) {
    const th = -Math.PI + (k / 144) * 6.2831853;
    const c = Math.cos(th);
    const sn = Math.sin(th);
    const cr = c * hx + sn * hy;
    const r = inkRC(d, th) * cg * (1 + 0.12 * q * (cr * cr - 0.5));
    xs.push(d.tx + c * r);
    ys.push(d.ty + sn * r);
  }
  inkPoly(P, xs, ys);
  if (cs > 0.01) for (const p of d.sk) inkPiece(P, d, p, cg, cs);
  if (cd > 0)
    for (const p of d.sk)
      if (p.chain)
        for (const ch of p.chain) {
          const e = inkBeadAt(d, p, ch, p.L * cs, p.rb * cg, cd);
          inkTearPoly(P, e[0], e[1], ch.r * (0.6 + 0.4 * cd), e[2], 0, ch.e);
        }
  if (ss > 0.05)
    for (const o of d.sat) {
      const rr = lerp(o.rb * cg * 0.8, o.dist, ss);
      inkTearPoly(P, d.tx + Math.cos(o.a) * rr, d.ty + Math.sin(o.a) * rr, o.rs, o.a, o.tl * ss, 1);
    }
  if (al > INK_TS.crown + 0.03) d.path = P;
  return P;
}
