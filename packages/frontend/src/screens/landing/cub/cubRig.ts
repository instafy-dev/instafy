// Cub's rig: spine tubes written into the spine texture (SPD), the body
// profile, arm taper, webs, the body pose and arm roles.
// Ported from the owner-approved prototype (not in this repo).

import {
  BALL,
  BODY_L,
  EB_S,
  EB_W,
  GP,
  HEAD_F,
  K,
  MAXR,
  NA,
  REST_B,
  REST_H,
  ROLE_ANG,
  ROLE_N,
  SS,
  SUCK0,
  TILT,
  headF,
  sOf,
  type ArmRole,
  type BodyPose,
} from "./cubConfig";
import { proj, unproj } from "./cubCamera";
import {
  add,
  clamp,
  cross,
  dot,
  len,
  lerp,
  madd,
  mul,
  norm,
  rotAxis,
  smoother,
  sstep,
  sub,
  wrapPi,
  type V3,
} from "./cubMath";
import type { Cub, KeepRect } from "./cubState";

export type RadiusFn = (s: number) => number;

export function writeS(c: Cub, row: number, i: number, P: V3, r: number, Uv: V3, Vv: V3): void {
  const o = (row * K * 3 + i * 3) * 4;
  const SPD = c.SPD;
  SPD[o] = P[0];
  SPD[o + 1] = P[1];
  SPD[o + 2] = P[2];
  SPD[o + 3] = r;
  SPD[o + 4] = Uv[0];
  SPD[o + 5] = Uv[1];
  SPD[o + 6] = Uv[2];
  SPD[o + 8] = Vv[0];
  SPD[o + 9] = Vv[1];
  SPD[o + 10] = Vv[2];
}

/** Integrates a spine from P0 along T0 with curvature kF (parallel transport), writing K joints into row. */
export function chain(
  c: Cub,
  row: number,
  P0: V3,
  T0: V3,
  U0: V3,
  Lw: number,
  rF: RadiusFn,
  kF: (s: number) => number,
  pts: V3[] | null,
): void {
  let P: V3 = [P0[0], P0[1], P0[2]];
  let T = norm(T0);
  let Uv = norm(sub(U0, mul(T, dot(U0, T))));
  const Vv = cross(T, Uv);
  for (let i = 0; i < K; i++) {
    const s = sOf(i / (K - 1));
    writeS(c, row, i, P, rF(s), Uv, Vv);
    if (pts) pts.push(P);
    if (i === K - 1) break;
    const ds = sOf((i + 1) / (K - 1)) - s;
    const seg = Lw * ds;
    const k = kF(s + ds * 0.5);
    if (k) {
      const a = k * ds;
      const cs = Math.cos(a);
      const sn = Math.sin(a);
      const T2 = add(mul(T, cs), mul(Uv, sn));
      Uv = sub(mul(Uv, cs), mul(T, sn));
      T = T2;
    }
    P = madd(P, T, seg);
  }
}

/** The body's radius profile along its spine (a super-ellipse head over a narrow cap). */
export function octoR(s: number, m: number): number {
  const d = s * BODY_L;
  const tt = (d - BALL.dc) / BALL.ry;
  const n = tt < 0 ? BALL.nLo : BALL.nHi;
  const bl = BALL.rx * m * Math.pow(Math.max(0, 1 - Math.abs(tt) ** n), 1 / n);
  const cp =
    d < BALL.cap
      ? BALL.base * Math.sqrt(Math.max(0, 1 - ((BALL.cap - d) / BALL.cap) ** 2))
      : BALL.base * (1 - smoother((d - BALL.cap) / 0.25));
  return Math.max(bl, cp);
}

export const armTaper = (s: number, r0: number, fl = 0.45): number =>
  r0 * ((1 - 0.76 * Math.pow(s, 1.1)) * (1 + fl * (1 - sstep(0, 0.24, s))));

/** Rounds an arm's radius off into a cap over its last tip-radius of length. */
export function capR(rF: RadiusFn, Lpx: number): RadiusFn {
  const rt = rF(1);
  const sc = Math.max(0.5, 1 - (1.05 * rt) / Math.max(Lpx, 1));
  return (s) => (s <= sc ? rF(s) : rF(s) * Math.sqrt(Math.max(0, 1 - ((s - sc) / (1 - sc)) ** 2)));
}

export function setTube(c: Cub, row: number, kind: number, prog: number): void {
  const T = c.TUBE;
  T[row * 4] = 0;
  T[row * 4 + 1] = kind;
  T[row * 4 + 2] = 0;
  T[row * 4 + 3] = prog;
}

export interface ArmRoot {
  ph: number;
  R: V3;
}
export function armRoots(n: number, _A: V3, F: V3, Lt: V3): ArmRoot[] {
  const out: ArmRoot[] = [];
  for (let i = 0; i < n; i++) {
    const ph = ((i + 0.5) / n) * Math.PI * 2;
    out.push({ ph, R: norm(add(mul(F, Math.cos(ph)), mul(Lt, Math.sin(ph)))) });
  }
  return out;
}

export function webs(c: Cub, row0: number, n: number, frac: number, r0: number, L: number): number {
  for (let i = 0; i < n; i++) {
    const rw = row0 + n + i;
    setTube(c, rw, 3, frac);
    c.TUBE2.set([L, r0, row0 + i, row0 + ((i + 1) % n)], rw * 4);
  }
  return n;
}

export function buildBody(
  c: Cub,
  row: number,
  O: V3,
  A: V3,
  F: V3,
  tilt: number,
  m: number,
  lsc: number,
  u: number,
  pts: V3[] | null,
): void {
  const Lb = BODY_L * u * lsc;
  chain(
    c,
    row,
    madd(O, A, -0.18 * u),
    A,
    F,
    Lb,
    (s) => octoR(s, m) * u,
    (s) => (s > 0.3 && s < 0.7 ? -tilt / 0.4 : 0),
    pts,
  );
  setTube(c, row, 0, 0);
  c.TUBE2.set([Lb, u, 0, 0], row * 4);
}

export interface Pose {
  A: V3;
  Fp: V3;
  Lt: V3;
  O: V3;
}

export function pose(c: Cub, bx: number, B: BodyPose): Pose {
  const u = c.OC.u;
  const psi = c.OC.psi0 + (B.psi || 0);
  const F = norm([Math.sin(psi), 0, Math.cos(psi)]);
  let A = norm(add(add(mul(NA, 0.55), [0, 0.45, 0]), mul(F, 0.1)));
  if (B.roll) A = rotAxis(A, [0, 0, 1], B.roll);
  const Fp = norm(sub(F, mul(A, dot(F, A))));
  const O = unproj(c.cam, bx, c.G!.edgeY - REST_H * u - (B.lift || 0), -0.3 * u);
  return { A, Fp, Lt: cross(A, Fp), O };
}

/** Assigns the eight arms to roles by their root angle (cached per layout). */
export function rolesFor(c: Cub, P: Pose): ArmRole[] {
  const OC = c.OC;
  if (OC.roles) return OC.roles;
  const roots = armRoots(8, P.A, P.Fp, P.Lt);
  const out: ArmRole[] = [];
  const pairs: [number, number, ArmRole][] = [];
  roots.forEach((rt, i) => {
    let a = Math.atan2(rt.R[2], rt.R[0]);
    if (a < 0) a += 2 * Math.PI;
    ROLE_N.forEach((nm) => {
      let d = Math.abs(a - ROLE_ANG[nm]);
      d = Math.min(d, 2 * Math.PI - d);
      pairs.push([d, i, nm]);
    });
  });
  pairs.sort((x, y) => x[0] - y[0]);
  const ui = new Set<number>();
  const un = new Set<ArmRole>();
  for (const [, i, nm] of pairs) {
    if (ui.has(i) || un.has(nm)) continue;
    out[i] = nm;
    ui.add(i);
    un.add(nm);
  }
  OC.roles = out;
  OC.armOf = {};
  out.forEach((nm, i) => (OC.armOf[nm] = i));
  return out;
}

/** Writes a 2D-laid arm (host px + depth) into the spine texture; returns its 3D length. */
export function writeArm(
  c: Cub,
  row: number,
  X: Float64Array,
  Y: Float64Array,
  Z: Float64Array,
  rF: RadiusFn,
  pts: V3[] | null,
): number {
  const P: V3[] = new Array(K);
  for (let i = 0; i < K; i++) P[i] = unproj(c.cam, X[i], Y[i], Z[i]);
  let Uv = SUCK0;
  let Lw = 0;
  for (let i = 0; i < K; i++) {
    const T = norm(sub(P[Math.min(K - 1, i + 1)], P[Math.max(0, i - 1)]));
    let q = sub(Uv, mul(T, dot(Uv, T)));
    if (len(q) < 1e-4) q = sub([0, 0, 1], mul(T, T[2]));
    Uv = norm(q);
    writeS(c, row, i, P[i], rF(sOf(i / (K - 1))), Uv, cross(T, Uv));
    if (pts) pts.push(P[i]);
    if (i) Lw += len(sub(P[i], P[i - 1]));
  }
  return Lw;
}

export interface SpineSample {
  P: V3;
  r: number;
  U: V3;
  V: V3;
  T: V3;
}

/** CPU evaluation of a spine row at arc s (the vertex shader's Catmull-Rom). */
export function spineAt(c: Cub, row: number, s: number): SpineSample {
  const SPD = c.SPD;
  const x = 1 - Math.pow(Math.max(1 - clamp(0, s, 1), 0), 1 / GP);
  const f = x * (K - 1);
  const i = Math.min(Math.floor(f), K - 2);
  const u = f - i;
  const tx = (k: number, ch: number): number[] => {
    const o = (row * K * 3 + k * 3 + ch) * 4;
    return [SPD[o], SPD[o + 1], SPD[o + 2], SPD[o + 3]];
  };
  const p1 = tx(i, 0);
  const p2 = tx(i + 1, 0);
  const p0 = i > 0 ? tx(i - 1, 0) : p1.map((v, j) => 2 * v - p2[j]);
  const p3 = i + 2 < K ? tx(i + 2, 0) : p2.map((v, j) => 2 * v - p1[j]);
  const X: number[] = [];
  const dX: number[] = [];
  for (let j = 0; j < 4; j++) {
    const b = p2[j] - p0[j];
    const cc = 2 * p0[j] - 5 * p1[j] + 4 * p2[j] - p3[j];
    const d = -p0[j] + 3 * p1[j] - 3 * p2[j] + p3[j];
    X.push(0.5 * (2 * p1[j] + b * u + cc * u * u + d * u * u * u));
    dX.push(0.5 * (b + 2 * cc * u + 3 * d * u * u));
  }
  const T = norm([dX[0] + 1e-6, dX[1] + 1e-6, dX[2] + 1e-6]);
  const u1 = tx(i, 1);
  const u2 = tx(i + 1, 1);
  let U = norm([lerp(u1[0], u2[0], u), lerp(u1[1], u2[1], u), lerp(u1[2], u2[2], u)]);
  U = norm(sub(U, mul(T, dot(U, T))));
  return { P: [X[0], X[1], X[2]], r: Math.max(X[3], 0), U, V: cross(T, U), T };
}

/** Whether the resting body at bx stays 0.45u clear of every rect in rs. */
export function bodyClear(c: Cub, bx: number, rs: readonly KeepRect[]): boolean {
  const u = c.OC.u;
  const P = pose(c, bx, REST_B);
  const pts: V3[] = [];
  buildBody(c, MAXR - 1, P.O, P.A, P.Fp, TILT, 1.03, 1.04, u, pts);
  for (let i = 0; i < K; i += 2) {
    const s = proj(c.cam, pts[i]);
    const r = c.SPD[((MAXR - 1) * K * 3 + i * 3) * 4 + 3] * s[2] + 0.45 * u;
    for (const b of rs) {
      const cx = clamp(b.x, s[0], b.x + b.w);
      const cy = clamp(b.y, s[1], b.y + b.h);
      if (Math.hypot(s[0] - cx, s[1] - cy) < r) return false;
    }
  }
  return true;
}

/** How much room the body pose B at bx leaves above the roster coins (the flinch is limited by it). */
export function bodyRoom(c: Cub, bx: number, B: BodyPose & { tilt: number; m: number; lsc: number }): number {
  const L = c.L;
  if (!L) return 1e9;
  const u = c.OC.u;
  const P = pose(c, bx, B);
  buildBody(c, MAXR - 1, P.O, P.A, P.Fp, B.tilt, B.m, B.lsc, u, null);
  const co = L.octoCoin;
  const rs: KeepRect[] = L.coins.concat([{ x: co.x - 0.08 * co.w, y: co.y - 0.08 * co.h, w: 1.16 * co.w, h: 1.16 * co.h }]);
  const az = c.EYE_AZN;
  const SPD = c.SPD;
  let m = 1e9;
  for (let i = 1; i < K; i++) {
    const o = ((MAXR - 1) * K * 3 + i * 3) * 4;
    const s = SS[i];
    const r = SPD[o + 3];
    if (r <= 0) continue;
    const hd = headF(s);
    const eb = c.OC.eb * Math.exp(-(((s - EB_S) / EB_W) ** 2));
    for (let j = 0; j < 48; j++) {
      const a = (j / 48) * 2 * Math.PI;
      const sn = Math.sin(a);
      const cs = Math.cos(a);
      const da = wrapPi(a - az);
      const db = wrapPi(a + az);
      const rr = r * (1 + HEAD_F * hd * sn * sn + eb * (Math.exp((-da * da) / 0.3) + Math.exp((-db * db) / 0.3)));
      const q = proj(c.cam, [
        SPD[o] + rr * (cs * SPD[o + 4] + sn * SPD[o + 8]),
        SPD[o + 1] + rr * (cs * SPD[o + 5] + sn * SPD[o + 9]),
        SPD[o + 2] + rr * (cs * SPD[o + 6] + sn * SPD[o + 10]),
      ]);
      for (const b of rs) if (q[0] >= b.x - 3 && q[0] <= b.x + b.w + 3) m = Math.min(m, b.y - 4 - q[1]);
    }
  }
  return m;
}
