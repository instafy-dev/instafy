// Cub's face: eye placement on the head (with visibility hysteresis so an eye
// never pops at the silhouette), saccades, blinks and lids, the smile, and the
// shade ticks. Ported from the owner-approved prototype (not in this repo).

import {
  BLINK,
  BODY_L,
  CLR_OFF,
  CLR_ON,
  CLR_STILL,
  CUB_U0,
  EB_AMP,
  EB_S,
  EB_W,
  EYE_AZ,
  EYE_AZ_FRONT,
  EYE_DWELL,
  EYE_HW,
  EYE_PAD,
  EYE_R,
  HAPPY,
  HAZ,
  HCAP,
  HCS,
  HEAD_F,
  HSN,
  HSS,
  MAXR,
  REST_B,
  SHD_IN,
  SHD_S,
  SHD_SD,
  SHD_SP,
  SOFT,
  SQZ,
  headF,
} from "./cubConfig";
import { attNow, attending, gazeWant } from "./cubAttention";
import { proj } from "./cubCamera";
import { demoAt, isStill, motionOK } from "./cubClock";
import { add, clamp, dot, fbm, hh, lerp, madd, mul, norm, smoother, sstep, sub, wrapPi, type V3 } from "./cubMath";
import { buildBody, pose, spineAt } from "./cubRig";
import type { Cub, EyeGeom } from "./cubState";

const hcr = (o: number[], a: number[], b: number[]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

/** Convex hull of 2D points as inward half-planes [nx, ny, d]. */
function hullPlanes(P: number[][]): number[][] {
  P.sort((p, q) => p[0] - q[0] || p[1] - q[1]);
  const lo: number[][] = [];
  const hi: number[][] = [];
  for (const p of P) {
    while (lo.length > 1 && hcr(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop();
    lo.push(p);
  }
  for (let i = P.length - 1; i >= 0; i--) {
    const p = P[i];
    while (hi.length > 1 && hcr(hi[hi.length - 2], hi[hi.length - 1], p) <= 0) hi.pop();
    hi.push(p);
  }
  const Hl = lo.slice(0, -1).concat(hi.slice(0, -1));
  let cx = 0;
  let cy = 0;
  Hl.forEach((p) => {
    cx += p[0];
    cy += p[1];
  });
  cx /= Hl.length;
  cy /= Hl.length;
  return Hl.map((a, i) => {
    const b = Hl[(i + 1) % Hl.length];
    let nx = a[1] - b[1];
    let ny = b[0] - a[0];
    const l = Math.hypot(nx, ny) || 1;
    nx /= l;
    ny /= l;
    if (nx * (cx - a[0]) + ny * (cy - a[1]) < 0) {
      nx = -nx;
      ny = -ny;
    }
    return [nx, ny, nx * a[0] + ny * a[1]];
  });
}

/** Projects head rings (with the eye bumps at az) and stores the hull of each ring pair. */
export function headRings(c: Cub, az: number, row = 0): void {
  const { HPC, HPS, cam } = c;
  HPC.length = 0;
  HPS.length = 0;
  let prev: number[][] | null = null;
  for (const s of HSS) {
    const q = spineAt(c, row, s);
    const head = headF(s);
    const eb = c.OC.eb * Math.exp(-(((s - EB_S) / EB_W) ** 2));
    const ring: number[][] = [];
    const P = q.P;
    const U = q.U;
    const V = q.V;
    for (let j = 0; j < HAZ; j++) {
      const sn = HSN[j];
      const cs = HCS[j];
      const a = (j / HAZ) * 2 * Math.PI;
      const da = wrapPi(a - az);
      const db = wrapPi(a + az);
      const r = q.r * (1 + HEAD_F * head * sn * sn + eb * (Math.exp((-da * da) / 0.3) + Math.exp((-db * db) / 0.3)));
      const x = P[0] + r * (cs * U[0] + sn * V[0]);
      const y = P[1] + r * (cs * U[1] + sn * V[1]);
      const z = P[2] + r * (cs * U[2] + sn * V[2]);
      const k = cam.CD / (cam.CD - z);
      ring.push([cam.W / 2 + x * k, cam.H / 2 - y * k]);
    }
    if (prev) {
      HPC.push(hullPlanes(prev.concat(ring)));
      HPS.push(s);
    }
    prev = ring;
  }
}

/** How far a ray from (x, y) along (dx, dy) runs inside the head silhouette; -1 if it starts outside. */
function headExit(c: Cub, x: number, y: number, dx: number, dy: number): number {
  const { HPC, HPS } = c;
  const iv: number[][] = [];
  for (let k = 0; k < HPC.length; k++) {
    let t0 = -1e9;
    let t1 = 1e9;
    for (const e of HPC[k]) {
      const d = e[0] * dx + e[1] * dy;
      const v = e[0] * x + e[1] * y - e[2];
      if (Math.abs(d) < 1e-9) {
        if (v < 0) {
          t0 = 1;
          t1 = 0;
          break;
        }
        continue;
      }
      const t = -v / d;
      if (d > 0) t0 = Math.max(t0, t);
      else t1 = Math.min(t1, t);
    }
    if (t0 < t1) iv.push([t0, t1, HPS[k]]);
  }
  iv.sort((p, q) => p[0] - q[0]);
  let end = -1;
  let es = 1;
  for (const [a, b, s] of iv) {
    if (end < 0) {
      if (a <= 0 && b > 0) {
        end = b;
        es = s;
      }
    } else if (a <= end && b > end) {
      end = b;
      es = s;
    }
  }
  if (end < 0) return -1;
  for (const [a, b, s] of iv)
    if (a <= end && b > end) {
      end = b;
      es = s;
    }
  return es < HCAP ? 1e9 : end;
}

/** Clearance (px) between an eye's outline and the head silhouette; -9 if it leaves the head. */
function eyeClear(c: Cub, g: EyeGeom): number {
  if (g.f <= 0.05) return -9;
  const px = -g.ay;
  const py = g.ax;
  let m = 1e9;
  for (let j = 0; j < 24; j++) {
    const a = (j / 24) * 2 * Math.PI;
    const cs = Math.cos(a);
    const s = Math.sin(a);
    let nx = px * cs + (g.ax * s) / g.sq;
    let ny = py * cs + (g.ay * s) / g.sq;
    const nl = Math.hypot(nx, ny) || 1;
    nx /= nl;
    ny /= nl;
    const ex = headExit(c, g.x + g.R * (px * cs + g.ax * g.sq * s), g.y + g.R * (py * cs + g.ay * g.sq * s), nx, ny);
    if (ex < 0) return -9;
    m = Math.min(m, ex);
  }
  return m - EYE_HW - EYE_PAD;
}

/** Places both eyes on the head of spine row at azimuth az (screen position, radius, foreshortening). */
export function eyePlace(c: Cub, row: number, u: number, az: number, out: [EyeGeom, EyeGeom]): void {
  const q = spineAt(c, row, EB_S);
  const Pc = q.P;
  const r = q.r;
  const Uv = q.U;
  const Vv = q.V;
  const T = q.T;
  const head = headF(EB_S);
  const sn2 = Math.sin(az) ** 2;
  const CD = c.cam.CD;
  for (let k = 0; k < 2; k++) {
    const sd = k ? -1 : 1;
    const dir = norm(add(mul(Vv, Math.sin(az) * sd), mul(Uv, Math.cos(az))));
    const pos = madd(Pc, dir, r * (1 + HEAD_F * head * sn2 + EB_AMP * 0.93));
    const e = proj(c.cam, pos);
    const n = proj(c.cam, madd(pos, dir, 0.3 * u));
    const tt = proj(c.cam, madd(pos, T, 0.3 * u));
    const view = norm(sub([0, 0, CD], pos));
    const f = dot(dir, view);
    let ax = n[0] - e[0];
    let ay = n[1] - e[1];
    const al = Math.hypot(ax, ay);
    if (al < 1e-3) {
      ax = 0;
      ay = -1;
    } else {
      ax /= al;
      ay /= al;
    }
    const g = out[k];
    g.x = e[0];
    g.y = e[1];
    g.z = pos[2];
    g.R = (c.L && c.L.mobile ? EYE_R.mobile : EYE_R.desk) * u * e[2];
    g.ax = ax;
    g.ay = ay;
    g.sq = clamp(0.3, f, 1);
    g.f = f;
    g.roll = clamp(-0.6, Math.atan2(-(tt[0] - e[0]), -(tt[1] - e[1])), 0.6);
  }
}

export const azFor = (c: Cub, psi: number): number =>
  c.L && c.L.mobile ? EYE_AZ.mobile : lerp(EYE_AZ.desk, c.OC.azF, 1 - sstep(0.3, 0.62, Math.abs(c.OC.psi0 + psi)));
const clrOf = (c: Cub, g: EyeGeom): number => (g.f > 0.92 ? 9 : g.f < 0.55 ? -9 : eyeClear(c, g));

/** Solves the camera-facing yaw and the eye azimuth so both eyes read when Cub looks at you; picks the resting eye. */
export function eyeSolve(c: Cub): void {
  const OC = c.OC;
  const EQ = c.EQ;
  const u = OC.u;
  const row = MAXR - 1;
  const at = (ps: number, lift: number, roll: number) => {
    const P = pose(c, OC.bx, { psi: ps - OC.psi0, roll, lift });
    buildBody(c, row, P.O, P.A, P.Fp, REST_B.tilt, 1, 1, u, null);
    const az = azFor(c, ps - OC.psi0);
    eyePlace(c, row, u, az, EQ);
    return az;
  };
  const g = (ps: number) => {
    at(ps, 0.057 * u, 0.07);
    return EQ[0].f - EQ[1].f;
  };
  OC.azF = EYE_AZ_FRONT;
  for (let pass = 0; pass < 7; pass++) {
    let p0 = OC.psi0 + 0.45;
    let p1 = OC.psi0 + 0.2;
    let f0 = g(p0);
    let f1 = g(p1);
    for (let i = 0; i < 8 && Math.abs(f1) >= 0.01; i++) {
      const d = f1 - f0;
      if (Math.abs(d) < 1e-7) break;
      const p2 = clamp(-1.4, p1 - (f1 * (p1 - p0)) / d, 1.4);
      p0 = p1;
      f0 = f1;
      p1 = p2;
      f1 = g(p1);
    }
    OC.psiCam = p1;
    if (c.L && c.L.mobile) break;
    headRings(c, at(p1, 0.057 * u, 0.07), row);
    if (Math.min(clrOf(c, EQ[0]), clrOf(c, EQ[1])) >= 1 || OC.azF <= 0.461) break;
    OC.azF = Math.max(0.46, OC.azF - 0.02);
  }
  headRings(c, at(OC.psi0, 0, 0), row);
  const cl = EQ.map((e) => clrOf(c, e));
  OC.restOn = [cl[0] >= CLR_ON ? 1 : 0, cl[1] >= CLR_ON ? 1 : 0];
  if (!OC.restOn[0] && !OC.restOn[1]) OC.restOn[cl[0] >= cl[1] ? 0 : 1] = 1;
}

/** Scripted blink windows (hello squint, done blink): no extra eye switches or blinks near them. */
function scriptRanges(c: Cub): [number, number, boolean][] {
  const tl = c.o.timeline;
  return [
    [tl.hello.in + c.helloShift, tl.hello.out + c.helloShift, true],
    [tl.done.blinkIn, tl.done.softBlink, false],
  ];
}
function scrX(c: Cub, sim: boolean, t: number, live: boolean, td: number): number | null {
  return sim ? (motionOK(c) || isStill(c) ? t : null) : live ? td : null;
}

export function scriptWin(c: Cub, t: number): "pre" | "in" | "out" | "post" | null {
  const d = demoAt(c);
  for (const [a, b, sim] of scriptRanges(c)) {
    const x = scrX(c, sim, t, d.live, d.td);
    if (x == null) continue;
    const ca = a + 0.08;
    const cb = b + 0.1;
    const e = b + 0.78;
    if (x >= ca - 1 && x < ca) return "pre";
    if (x >= ca && x < cb) return "in";
    if (x >= cb && x < e) return "out";
    if (x >= e && x < e + 1) return "post";
  }
  return null;
}

export function nearScripted(c: Cub, t: number): boolean {
  const d = demoAt(c);
  for (const [a, b, sim] of scriptRanges(c)) {
    const x = scrX(c, sim, t, d.live, d.td);
    if (x == null) continue;
    if ((x > a - 1 && x < a + 1.27) || (x > b - 1 && x < b + 1.78)) return true;
  }
  return false;
}

/** Places the eyes for this frame and decides which of them shows (with hysteresis, switching under a blink). */
export function eyeGeo(c: Cub, u: number, t: number, live: boolean, psi: number): void {
  const { EYEG, EYE, OC, EYE_V, EYE_AMP } = c;
  const az = (c.EYE_AZN = azFor(c, psi || 0));
  eyePlace(c, 0, u, az, EYEG);
  {
    const ps = 1 + 0.06 * ((live || isStill(c)) && c.motionOn && !c.rmOn ? blinkAt(c, t, live).pop : 0);
    for (const g of EYEG) g.R *= ps;
  }
  const dt = c.EYE_T < 0 || t < c.EYE_T ? 0 : Math.min(0.1, t - c.EYE_T);
  c.EYE_T = t;
  if (EYEG.some((g) => g.f >= 0.55 && g.f <= 0.92)) headRings(c, az);
  const lid = live ? lidAt(c, t, true) : c.LIDNOW;
  const sw = scriptWin(c, t);
  const ns = live && nearScripted(c, t);
  for (let k = 0; k < 2; k++) {
    const g = EYEG[k];
    const c0 = g.clr;
    const clr = (g.clr = clrOf(c, g));
    if (!live || g.on < 0 || t < g.sw) {
      g.on = sw === "in" ? (clr >= CLR_OFF ? 1 : 0) : sw ? OC.restOn[k] : clr >= CLR_STILL ? 1 : 0;
      g.sw = -99;
      continue;
    }
    if (g.on && clr < -EYE_PAD + 0.5) {
      g.on = 0;
      g.sw = t;
      EYE.hardOff++;
      continue;
    }
    if (sw === "in" || sw === "out") {
      if (lid < -0.15) {
        const w = sw === "in" ? clr >= CLR_OFF : !!OC.restOn[k];
        if (w !== !!g.on) {
          g.on = w ? 1 : 0;
          g.sw = t;
        }
      }
      continue;
    }
    const want = g.on ? clr >= CLR_OFF : clr >= CLR_ON;
    const pend = want !== !!g.on && t - g.sw >= (g.on && !want ? 0.3 : EYE_DWELL);
    const v = dt > 0 && c0 > -9 && clr > -9 ? (clr - c0) / dt : 0;
    const soon = g.on
      ? clr < CLR_OFF + 1.6 && clr + v * 0.12 < CLR_OFF
      : t - g.sw >= EYE_DWELL && v > 0 && clr >= CLR_ON - 2.6 && clr + v * 0.2 >= CLR_ON;
    if (pend && lid < -0.15) {
      g.on = want ? 1 : 0;
      g.sw = t;
    } else if ((pend || soon) && t - EYE.blinkT > 0.3 && !ns) EYE.blinkT = t;
  }
  if (!EYEG[0].on && !EYEG[1].on) {
    const k = EYEG[0].clr >= EYEG[1].clr ? 0 : 1;
    EYEG[k].on = 1;
    EYEG[k].sw = t;
  }
  for (let k = 0; k < 2; k++) {
    const g = EYEG[k];
    // Eyes off (a review option) hides them; the hull logic still runs.
    g.vis = c.o.eyes ? g.on : 0;
    EYE_V[k] = !live || !g.on ? g.on : Math.min(1, EYE_V[k] + dt / 0.12);
    EYE_AMP[k] = OC.eb * lerp(0.4, 1, Math.min(sstep(-0.3, 0.1, g.f), EYE_V[k]));
  }
}

const eyeRef = (c: Cub): EyeGeom => (c.EYEG[0].vis >= c.EYEG[1].vis ? c.EYEG[0] : c.EYEG[1]);

/** Pupil offset (in eye units) toward a gaze target. */
export function offFor(c: Cub, g: V3): [number, number] {
  if (g[2]) return [0, 0.03];
  const E = eyeRef(c);
  const dx = g[0] - E.x;
  const dy = g[1] - E.y;
  const D = Math.hypot(dx, dy) || 1;
  const m = 0.25 * sstep(0, 150, D);
  return [(dx / D) * m, clamp(-0.22, ((dy / D) * m * 0.85), 0.3)];
}

/** Saccades toward the gaze target, with an occasional blink on a big jump. */
export function eyeStep(c: Cub, t: number, dt: number): void {
  const EYE = c.EYE;
  const g = gazeWant(c, t);
  const w = offFor(c, g);
  const cur = eyeOff(c, t);
  const dd = Math.hypot(w[0] - EYE.tx, w[1] - EYE.ty);
  if (dd > 0.3 || (dd > 0.05 && t >= EYE.nextFix)) {
    const jump = Math.hypot(w[0] - cur[0], w[1] - cur[1]);
    EYE.fx = cur[0];
    EYE.fy = cur[1];
    EYE.tx = w[0];
    EYE.ty = w[1];
    EYE.sacT = t;
    EYE.nextFix = t + 0.28 + 0.45 * hh(Math.floor(t * 37) + 1);
    if (jump > 0.42 && hh(Math.floor(t * 53) + 3) < 0.3 && t - EYE.blinkT > 1.5 && !(motionOK(c) && nearScripted(c, t))) EYE.blinkT = t;
  }
  const k = Math.min(1, dt / 0.3);
  EYE.cam += ((g[2] ? 1 : 0) - EYE.cam) * k;
  EYE.att += ((g[2] || attending(c, t) ? 1 : 0) - EYE.att) * Math.min(1, dt / 0.45);
}

export function eyeOff(c: Cub, t: number): [number, number] {
  const EYE = c.EYE;
  const k = smoother((t - EYE.sacT) / 0.09);
  return [lerp(EYE.fx, EYE.tx, k) + 0.012 * fbm(t * 0.8, 91), lerp(EYE.fy, EYE.ty, k) + 0.01 * fbm(t * 0.7, 93)];
}

/** Replays the last 3.5 s of saccades so a still frame at t looks where a live Cub would. */
export function eyeSim(c: Cub, t: number): void {
  const t0 = Math.max(0, t - 3.5);
  const g = gazeWant(c, t0);
  const w = offFor(c, g);
  Object.assign(c.EYE, {
    fx: w[0],
    fy: w[1],
    tx: w[0],
    ty: w[1],
    sacT: -99,
    nextFix: t0,
    cam: g[2] ? 1 : 0,
    att: g[2] ? 1 : 0,
    blinkT: -99,
    squeezeT: -99,
    widenT: -99,
  });
  for (let x = t0; x < t; x += 1 / 30) eyeStep(c, x, 1 / 30);
}

function blinkEv(c: Cub, k: number): number {
  const BLK = c.BLK;
  while (BLK.length <= k) {
    const i = BLK.length;
    BLK.push(BLK[i - 1] + 6 + 6 * hh(i * 19 + 3));
  }
  return BLK[k];
}
function lastBlink(c: Cub, t: number): number {
  while (c.blkI > 0 && blinkEv(c, c.blkI) > t) c.blkI--;
  while (blinkEv(c, c.blkI + 1) <= t) c.blkI++;
  return blinkEv(c, c.blkI);
}
const BL = (x: number, S: readonly number[]): number =>
  x < 0 || x > S[0] + S[1] + S[2] ? 0 : x < S[0] ? smoother(x / S[0]) : x < S[0] + S[1] ? 1 : 1 - smoother((x - S[0] - S[1]) / S[2]);
const POP = (x: number, S: readonly number[]): number => {
  const y = x - S[0] - S[1] - 0.5 * S[2];
  return y < 0 || y > 0.4 ? 0 : y < 0.05 ? smoother(y / 0.05) : 1 - smoother((y - 0.05) / 0.35);
};
const widenEnv = (x: number): number =>
  x < 0 || x > 0.5 ? 0 : x < 0.08 ? smoother(x / 0.08) : x < 0.24 ? 1 : 1 - smoother((x - 0.24) / 0.26);

/** Blink (b), the pupil pop after it, and the happy squint (hap) at t. */
export function blinkAt(c: Cub, t: number, live: boolean): { b: number; pop: number; hap: number } {
  const tl = c.o.timeline;
  const EYE = c.EYE;
  const d = demoAt(c);
  const tb = lastBlink(c, t);
  const tdb = d.td - (t - tb);
  let b = 0;
  let pop = 0;
  let hap = 0;
  const on = (x: number, S: readonly number[], pk: number, hp: number) => {
    const v = BL(x, S);
    if (v > b) b = v;
    if (hp && v > 0) hap = Math.max(hap, hp);
    pop = Math.max(pop, pk * POP(x, S));
  };
  // No ambient blink within about a second of a scripted one (the done
  // blinks in turn time, the hello's squint in sim time).
  const nearDone = d.live && (Math.abs(tdb - tl.done.blinkIn) < 1.2 || Math.abs(tdb - tl.done.softBlink) < 1.2);
  const nearHello = tb > tl.hello.in + c.helloShift - 1 && tb < tl.hello.out + c.helloShift + 1;
  if (!nearDone && !nearHello) on(t - tb, BLINK, 0.45, 0);
  if (live) {
    on(t - EYE.blinkT, BLINK, 0.6, 0);
    on(t - EYE.squeezeT, SQZ, 1, EYE.sqHap);
    pop = Math.max(pop, 0.8 * widenEnv(t - EYE.widenT));
  }
  if (motionOK(c) || isStill(c)) {
    const hs = c.helloShift;
    on(t - tl.hello.in - hs, HAPPY, 1, 1);
    on(t - tl.hello.out - hs, BLINK, 0.4, 0);
    pop = Math.max(pop, widenEnv(t - tl.hello.t - hs + 0.02));
  }
  if (d.live) {
    on(d.td - tl.done.blinkIn, BLINK, 1, 0);
    on(d.td - tl.done.softBlink, SOFT, 0.6, 0.6);
  }
  const N = c.BLK_NOW;
  N.b = b;
  N.pop = pop;
  N.hap = hap;
  return N;
}

/** Lid opening: wider while attending, closed by a blink. */
export function lidAt(c: Cub, t: number, live: boolean): number {
  const base = lerp(0.72 + 0.1 * c.EYE.att, 0.98, sstep(0, 0.2, attNow(c, t).e));
  return lerp(base, -0.5, blinkAt(c, t, live).b);
}

export function mouthPlace(c: Cub, u: number): void {
  const q = spineAt(c, 0, EB_S - 0.22 / BODY_L);
  const Uv = q.U;
  const Vv = q.V;
  const T = q.T;
  const pos = madd(q.P, Uv, q.r * (1 + c.OC.eb * 0.2));
  const e = proj(c.cam, pos);
  const sd = proj(c.cam, madd(pos, Vv, 0.1 * u));
  const up = proj(c.cam, madd(pos, T, 0.1 * u));
  let rx = sd[0] - e[0];
  let ry = -(sd[1] - e[1]);
  const l = Math.hypot(rx, ry) || 1;
  rx /= l;
  ry /= l;
  if (-ry * (up[0] - e[0]) + rx * -(up[1] - e[1]) < 0) {
    rx = -rx;
    ry = -ry;
  }
  const f = dot(Uv, norm(sub([0, 0, c.cam.CD], pos)));
  Object.assign(c.MOUTH, {
    x: e[0],
    y: e[1],
    s: 0.075 * u * e[2],
    ax: rx,
    ay: ry,
    sq: clamp(0.35, l / (0.1 * u * e[2]), 1),
    vis: sstep(0.45, 0.6, f),
  });
}

/** Three short shade ticks on the body's shadow side (skipped on small perches). */
export function shadePlace(c: Cub, u: number, dark: number): void {
  const { SHD, SHDT, cam } = c;
  SHD.fill(0);
  if (u < CUB_U0) return;
  const s = dark ? SHD_SD : SHD_S;
  const q = spineAt(c, 0, s);
  const hd = headF(s);
  const sd = dark ? -1 : 1;
  let best: V3 | null = null;
  for (let j = 0; j < 48; j++) {
    const a = (j / 48) * 2 * Math.PI;
    const sn = Math.sin(a);
    const cs = Math.cos(a);
    const r = q.r * (1 + HEAD_F * hd * sn * sn);
    const sp = proj(cam, [
      q.P[0] + r * (cs * q.U[0] + sn * q.V[0]),
      q.P[1] + r * (cs * q.U[1] + sn * q.V[1]),
      q.P[2] + r * (cs * q.U[2] + sn * q.V[2]),
    ]);
    if (!best || sd * sp[0] > sd * best[0]) best = sp;
  }
  const b = best as V3;
  const cc = proj(cam, q.P);
  const dx = cc[0] - b[0];
  const dy = cc[1] - b[1];
  const dl = Math.hypot(dx, dy) || 1;
  const k = clamp(0.6, u / 80, 1.1);
  const x = b[0] + (dx / dl) * SHD_IN * u;
  const y = b[1] + (dy / dl) * SHD_IN * u;
  SHD.set([x * cam.DPR, cam.HV - y * cam.DPR, 13 * k, SHD_SP * k]);
  SHDT[0] = dy / dl;
  SHDT[1] = dx / dl;
}
