// The curious arm (an arm that curls toward a still pointer) and the flinch
// curl. Ported from the owner-approved prototype (not in this repo).

import {
  ARM_R0,
  CUR_J0,
  CUR_JQ,
  CUR_JQ1,
  CUR_LIFT,
  CUR_OPEN,
  CUR_QM,
  CUR_ROT,
  CUR_S,
  CUR_VM,
  K,
  SS,
} from "./cubConfig";
import { fixPt, stepFix, toAng } from "./cubArms";
import { clamp, lerp, smoother, sstep, wrapPi } from "./cubMath";
import { armTaper } from "./cubRig";
import type { ArmBuf, Cub, Geo } from "./cubState";

/** Bends the outer part of arm o toward (tx, ty) into out: rotated about the joint at CUR_S and lifted a little. */
export function curTarget(c: Cub, o: ArmBuf, tx: number, ty: number, u: number, out: ArmBuf): { th: number; rise: number; off: number } {
  const CUO = c.CUO;
  const j0 = CUR_J0;
  const px = o.X[j0];
  const py = o.Y[j0];
  {
    let a = Math.atan2(o.Y[j0] - o.Y[j0 - 1], o.X[j0] - o.X[j0 - 1]);
    let ap = a;
    let tu = 0;
    CUO.X[j0] = px;
    CUO.Y[j0] = py;
    let ta = 0;
    for (let j = j0 + 2; j < CUR_JQ1; j++) {
      const d = wrapPi(
        Math.atan2(o.Y[j] - o.Y[j - 1], o.X[j] - o.X[j - 1]) - Math.atan2(o.Y[j - 1] - o.Y[j - 2], o.X[j - 1] - o.X[j - 2]),
      );
      ta += Math.abs(d);
      if (j >= CUR_JQ) tu += d;
    }
    const sg = Math.abs(tu) > 0.2 ? Math.sign(tu) : tx > px ? -1 : 1;
    const qm = o.Z[K - 1] < -0.5 * u ? 0 : sg * Math.max(0, CUR_QM - ta);
    for (let j = j0 + 1; j < K; j++) {
      const aj = Math.atan2(o.Y[j] - o.Y[j - 1], o.X[j] - o.X[j - 1]);
      const l = Math.hypot(o.X[j] - o.X[j - 1], o.Y[j] - o.Y[j - 1]);
      a += wrapPi(aj - ap) * (1 - CUR_OPEN * smoother((SS[j] - CUR_S) / 0.2)) + (qm * (SS[j] - SS[j - 1]) * sstep(0.6, 0.78, SS[j])) / 0.31;
      ap = aj;
      CUO.X[j] = CUO.X[j - 1] + Math.cos(a) * l;
      CUO.Y[j] = CUO.Y[j - 1] + Math.sin(a) * l;
    }
  }
  const th0 = clamp(-CUR_ROT, wrapPi(Math.atan2(ty - py, tx - px) - Math.atan2(CUO.Y[K - 1] - py, CUO.X[K - 1] - px)), CUR_ROT);
  const lay = (th: number, lift: number): number => {
    let rise = -1e9;
    for (let j = 0; j < K; j++) {
      if (j <= j0) {
        out.X[j] = o.X[j];
        out.Y[j] = o.Y[j];
        out.Z[j] = o.Z[j];
        continue;
      }
      const a = th * smoother((SS[j] - CUR_S) / 0.15);
      const cs = Math.cos(a);
      const sn = Math.sin(a);
      const dx = CUO.X[j] - px;
      const dy = CUO.Y[j] - py;
      out.X[j] = px + dx * cs - dy * sn;
      out.Y[j] = py + dx * sn + dy * cs - lift * smoother((SS[j] - CUR_S) / 0.45);
      out.Z[j] = o.Z[j];
      rise = Math.max(rise, o.Y[j] - out.Y[j]);
    }
    return rise;
  };
  const up = o.Z[K - 1] < -0.5 * u ? 0 : clamp(0, (py - ty) / (1.5 * u), 1);
  const lo = lerp(CUR_LIFT[0], 0.4, up);
  const hi = lerp(CUR_LIFT[1], 0.55, up);
  const W = c.cam.W;
  const vClip = () => {
    let n = 0;
    for (let j = j0 + 1; j < K; j++) {
      const r = armTaper(SS[j], ARM_R0 * u);
      if (out.X[j] < CUR_VM + r || out.X[j] > W - CUR_VM - r) n++;
    }
    return n;
  };
  let th = th0;
  let r = lay(th, 0);
  for (let k = 0; k < 8 && (r > hi * u || vClip() > 2); k++) {
    th *= 0.8;
    r = lay(th, 0);
  }
  for (let k = 0, lift = 0; k < 5 && r < lo * u; k++) {
    lift += lo * u - r + 0.02 * u;
    r = lay(th, lift);
  }
  let j6 = j0;
  while (SS[j6] < 0.6) j6++;
  const off = Math.abs(
    wrapPi(Math.atan2(ty - out.Y[j6], tx - out.X[j6]) - Math.atan2(out.Y[K - 1] - out.Y[j6], out.X[K - 1] - out.X[j6])),
  );
  return { th, rise: r, off };
}

/** Blends arm o toward the curious pose act by w, keeping its length and resolving collisions. */
export function curApply(c: Cub, o: ArmBuf, act: ArmBuf, w: number, S: Geo, rpx: (s: number) => number): number {
  const { CSEG, sf: SF } = c;
  const j0 = CUR_J0;
  let li = 0;
  let lb = 0;
  for (let j = j0 + 1; j < K; j++) li += CSEG[j] = Math.hypot(o.X[j] - o.X[j - 1], o.Y[j] - o.Y[j - 1]);
  for (let j = j0 + 1; j < K; j++) {
    o.X[j] = lerp(o.X[j], act.X[j], w);
    o.Y[j] = lerp(o.Y[j], act.Y[j], w);
    lb += Math.hypot(o.X[j] - o.X[j - 1], o.Y[j] - o.Y[j - 1]);
  }
  if (lb > li) {
    const k = li / lb;
    const x0 = o.X[j0];
    const y0 = o.Y[j0];
    for (let j = j0 + 1; j < K; j++) {
      o.X[j] = x0 + (o.X[j] - x0) * k;
      o.Y[j] = y0 + (o.Y[j] - y0) * k;
    }
  }
  let x = o.X[j0];
  let y = o.Y[j0];
  let hits = 0;
  for (let j = j0 + 1; j < K; j++) {
    const dist = Math.max(Math.hypot(o.X[j] - x, o.Y[j] - y), 1e-6);
    const seg = Math.min(Math.hypot(o.X[j] - x, o.Y[j] - y), CSEG[j]);
    hits += stepFix(S, x, y, x + ((o.X[j] - x) * seg) / dist, y + ((o.Y[j] - y) * seg) / dist, seg, rpx(SS[j]), o.F[j], SF);
    {
      const dx = SF[0] - x;
      const dy = SF[1] - y;
      const dl = Math.hypot(dx, dy);
      if (dl > seg * 1.02) {
        SF[0] = x + (dx / dl) * seg;
        SF[1] = y + (dy / dl) * seg;
      }
    }
    o.X[j] = SF[0];
    o.Y[j] = SF[1];
    x = SF[0];
    y = SF[1];
  }
  return hits;
}

function segX(a: number, b: number, cc: number, d: number, e: number, f: number, g: number, h: number): boolean {
  const o = (px: number, py: number, qx: number, qy: number, rx: number, ry: number) =>
    Math.sign((qx - px) * (ry - py) - (qy - py) * (rx - px));
  return o(a, b, cc, d, e, f) * o(a, b, cc, d, g, h) < 0 && o(e, f, g, h, a, b) * o(e, f, g, h, cc, d) < 0;
}

/** Whether curling arm i toward (tx, ty) would hit the scene or cross another arm. */
export function curCross(c: Cub, arms: ArmBuf[], i: number, tx: number, ty: number, u: number): boolean {
  const CURT = c.CURT;
  curTarget(c, arms[i], tx, ty, u, CURT);
  const Sidle = c.Sidle;
  if (Sidle) {
    let n = 0;
    for (let j = CUR_J0 + 1; j < K; j++)
      if (fixPt(Sidle, CURT.X[j], CURT.Y[j], armTaper(SS[j], ARM_R0 * u), arms[i].F[j]) && ++n > 3) return true;
  }
  for (let j = CUR_J0; j < K - 1; j++) {
    const ax = CURT.X[j];
    const ay = CURT.Y[j];
    const bx = CURT.X[j + 1];
    const by = CURT.Y[j + 1];
    for (let k = 0; k < arms.length; k++) {
      const q = arms[k];
      const n = k === i ? CUR_J0 - 1 : K - 1;
      for (let m = 0; m < n; m++) if (segX(ax, ay, bx, by, q.X[m], q.Y[m], q.X[m + 1], q.Y[m + 1])) return true;
    }
  }
  return false;
}

/** The flinch: curls the arm in on itself by fl (0..1) and shortens it, resolving collisions. */
export function flinchArm(c: Cub, o: ArmBuf, fl: number, S: Geo, rpx: (s: number) => number): number {
  const { AI, LI, sf: SF } = c;
  toAng(o, AI, LI);
  if (fl > 0) {
    let turn = 0;
    for (let j = 2; j < K; j++) turn += wrapPi(AI[j] - AI[j - 1]);
    const sg = turn >= 0 ? 1 : -1;
    for (let j = 1; j < K; j++) {
      AI[j] += sg * fl * 2.1 * Math.pow(SS[j], 1.5);
      LI[j] *= 1 - 0.3 * fl;
    }
  }
  let x = o.X[0];
  let y = o.Y[0];
  let hits = 0;
  for (let j = 1; j < K; j++) {
    hits += stepFix(S, x, y, x + Math.cos(AI[j]) * LI[j], y + Math.sin(AI[j]) * LI[j], LI[j], rpx(SS[j]), o.F[j], SF);
    {
      const dx = SF[0] - x;
      const dy = SF[1] - y;
      const dl = Math.hypot(dx, dy);
      if (dl > LI[j] * 1.02) {
        SF[0] = x + (dx / dl) * LI[j];
        SF[1] = y + (dy / dl) * LI[j];
      }
    }
    o.X[j] = SF[0];
    o.Y[j] = SF[1];
    x = SF[0];
    y = SF[1];
  }
  return hits;
}
