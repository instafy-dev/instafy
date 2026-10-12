// Per-frame interaction: the curious arm (choosing an arm that can curl toward
// a still pointer without crossing anything), head turns toward the pointer,
// the linger look at the camera, and the springs that smooth it all; plus the
// boop and the CTA glance. Ported from the owner-approved prototype (not in this repo).

import { ARM_R0, CUR_J0, CUR_J35, K, LOOK_PSI, SS } from "./cubConfig";
import { attNow, attPsiPt, attending, gazeWant, pulse } from "./cubAttention";
import { demoAt, fine, motionOK, noticeOK } from "./cubClock";
import { curCross, curTarget } from "./cubCurious";
import { eyeStep } from "./cubEyes";
import { inkBurst, inkStatic } from "./cubInkLayer";
import { clamp, spring } from "./cubMath";
import { reachArmOf } from "./cubReach";
import { armTaper } from "./cubRig";
import type { ArmBuf, Cub } from "./cubState";
import { busyAt } from "./cubTimeline";

/** Distance from (px, py) to Cub's nearest hit circle edge. */
export function nearDist(c: Cub, px: number, py: number): number {
  let m = 1e9;
  const H = c.HIT;
  for (let i = 0; i < c.NHIT; i++) {
    const d = Math.hypot(px - H[i * 3], py - H[i * 3 + 1]) - H[i * 3 + 2];
    if (d < m) m = d;
  }
  return m;
}

/** Whether (x, y) is on Cub (with pad px of slack). */
export function hitAt(c: Cub, x: number, y: number, pad: number): boolean {
  const H = c.HIT;
  for (let i = 0; i < c.NHIT; i++) if (Math.hypot(x - H[i * 3], y - H[i * 3 + 1]) < H[i * 3 + 2] + pad) return true;
  return false;
}

/** Whether (x, y) is over the headline or sub copy. */
export function textAt(c: Cub, x: number, y: number): boolean {
  for (const r of c.L?.text || []) if (x > r.x - 6 && x < r.x + r.w + 6 && y > r.y - 4 && y < r.y + r.h + 4) return true;
  return false;
}

/** Arms the turn has claimed (the reach arm while Octo works). */
export function busyArms(c: Cub): number[] {
  const d = demoAt(c);
  return d.live && busyAt(c.o.timeline, d.td) ? [reachArmOf(c)] : [];
}

const segNear = (ax: number, ay: number, bx: number, by: number, cx: number, cy: number, r: number, m: number): boolean => {
  const vx = bx - ax;
  const vy = by - ay;
  const l2 = vx * vx + vy * vy || 1;
  const k = clamp(0, ((cx - ax) * vx + (cy - ay) * vy) / l2, 1);
  const px = ax + vx * k;
  const py = ay + vy * k;
  return py < cy + 0.3 * r && Math.hypot(px - cx, py - cy) < 1.15 * r + m;
};
const segHits = (ax: number, ay: number, bx: number, by: number, cx: number, cy: number, r: number): boolean => {
  const vx = bx - ax;
  const vy = by - ay;
  const l2 = vx * vx + vy * vy || 1;
  const k = clamp(0, ((cx - ax) * vx + (cy - ay) * vy) / l2, 1);
  return Math.hypot(ax + vx * k - cx, ay + vy * k - cy) < r;
};

export function stepInteract(c: Cub, dt: number, t: number): void {
  const { PT, CUR, OC, CW, CWV, ATT, LOOK, LINGER, SHIFT, ARMT, HEADC, BODYC, HIT } = c;
  const ok = noticeOK(c) && fine(c);
  const dN = PT.in ? nearDist(c, PT.x, PT.y) : 1e9;
  const zone = ok && PT.in && !PT.ctl && !PT.text && !PT.inWin && dN > (CUR.engaged ? 6 : 14) && dN < (CUR.engaged ? 260 : 220);
  const shy = t - CUR.shyT < 1.1;
  const blocked = t - CUR.blockT < 1.4;
  const above = PT.in && PT.y < HEADC[1] - 0.55 * OC.u && PT.x > HEADC[0] - 0.5 * OC.u;
  if (!zone || shy || blocked) CUR.engaged = false;
  else if (!CUR.engaged && t - PT.stillT >= 1.5) {
    CUR.engaged = true;
    CUR.engT = t;
  }
  CUR.linger = zone && !shy && t - PT.stillT >= 1.5;
  CUR.near = zone;
  if (ok && PT.in && !PT.ctl && Math.hypot(PT.x - HEADC[0], PT.y - HEADC[1]) < 430) {
    if (t - ATT.nearT > 12 && t > 2.8 && !shy) pulse(c, "pt", PT.x, PT.y, 1);
    ATT.nearT = t;
  }
  const parm = OC.parm;
  if (CUR.engaged && parm) {
    const busy = busyArms(c);
    const u = OC.u;
    const CURT = c.CURT;
    const crosses = (o: ArmBuf) => {
      const j = CUR_J0;
      const dx = PT.x - o.X[j];
      const dy = PT.y - o.Y[j];
      const D = Math.hypot(dx, dy) || 1;
      const ax = o.X[j] + (dx / D) * 0.2 * u;
      const ay = o.Y[j] + (dy / D) * 0.2 * u;
      if (segHits(ax, ay, PT.x, PT.y, BODYC[0], BODYC[1], 0.72 * u) || segHits(ax, ay, PT.x, PT.y, HEADC[0], HEADC[1], 0.42 * u)) return true;
      curTarget(c, o, PT.x, PT.y, u, CURT);
      for (let k = CUR_J35; k < K - 1; k++) {
        const r = armTaper(SS[k], ARM_R0 * u);
        const fr = CURT.Z[k] >= 0;
        const m = k < CUR_J0 ? 0 : fr ? 0.05 * u : 0.25 * u;
        if (k < CUR_J0 && fr) continue;
        for (let b = 0; b < c.NBODYH; b++)
          if (segNear(CURT.X[k], CURT.Y[k], CURT.X[k + 1], CURT.Y[k + 1], HIT[b * 3], HIT[b * 3 + 1], HIT[b * 3 + 2] - 2, m + r)) return true;
      }
      return false;
    };
    const sc = (i: number) => {
      const o = parm[i];
      return Math.hypot(o.X[0] - PT.x, o.Y[0] - PT.y) + 0.35 * Math.hypot(o.X[K - 1] - PT.x, o.Y[K - 1] - PT.y);
    };
    let best = -1;
    let bd = 1e9;
    if (!above)
      for (let i = 0; i < 8; i++) {
        if (busy.includes(i) || crosses(parm[i]) || ((i !== CUR.arm || CW[i] < 0.05) && curCross(c, parm, i, PT.x, PT.y, u))) continue;
        const d = sc(i) + (curTarget(c, parm[i], PT.x, PT.y, u, CURT).off > 0.87 ? 1e4 : 0);
        if (d < bd) {
          bd = d;
          best = i;
        }
      }
    let total = 0;
    for (let i = 0; i < 8; i++) total += CW[i];
    if (best < 0) CUR.engaged = false;
    else if (CUR.arm < 0 || busy.includes(CUR.arm)) {
      if (total < 0.05) {
        const o = parm[best];
        CUR.x = o.X[K - 1];
        CUR.y = o.Y[K - 1];
        CUR.vx = CUR.vy = 0;
        CUR.engT = t;
      }
      CUR.arm = best;
      CUR.switchT = t;
    } else if (best !== CUR.arm && bd < 0.7 * sc(CUR.arm) && t - CUR.switchT > 1.2) {
      CUR.arm = best;
      CUR.switchT = t;
    }
  }
  const want = CUR.engaged;
  const g = gazeWant(c, t);
  const att = attending(c, t);
  const gx = g[2] ? HEADC[0] : g[0];
  const dx = gx - HEADC[0];
  const gain = att ? 1 : 0.5;
  let psiT = g[2] ? 0.05 : clamp(-1, dx / 480, 1) * 0.06 * gain;
  let rollT = shy ? clamp(-1, (PT.x - HEADC[0]) / 360, 1) * 0.08 : -clamp(-1, dx / 420, 1) * 0.025 * gain;
  const hd = Math.hypot(PT.x - HEADC[0], PT.y - HEADC[1]);
  if (ok && PT.in && !PT.ctl && !PT.text && !PT.inWin && !shy && t - PT.stillT >= 0.8 && hd < 400) {
    LOOK.on = true;
    LOOK.rel = t + 1;
    LOOK.x = PT.x;
    LOOK.y = PT.y;
  } else if (LOOK.on && (t > LOOK.rel || shy || !ok)) LOOK.on = false;
  LOOK.e += ((LOOK.on ? 1 : 0) - LOOK.e) * Math.min(1, dt / 0.3);
  if (LOOK.on) {
    const lx = LOOK.x - HEADC[0];
    const k = clamp(-1, (1.8 * lx) / Math.max(60, Math.hypot(lx, (above ? 0.5 : 1) * (LOOK.y - HEADC[1]))), 1);
    const pp = attPsiPt(c, t);
    psiT = LOOK_PSI * k - pp;
    rollT = -0.13 * k;
  }
  if (
    ok &&
    PT.in &&
    !PT.ctl &&
    !PT.text &&
    !shy &&
    t - PT.stillT >= 1.5 &&
    PT.stillT !== LINGER.at &&
    Math.abs(PT.x - HEADC[0]) < 120 &&
    PT.y < HEADC[1] &&
    hd < 400 &&
    t - LINGER.last > 20 &&
    t - 1.2 > 20
  ) {
    LINGER.at = PT.stillT;
    LINGER.last = t;
    pulse(c, "cam", 0, 0, 1);
  }
  const n = Math.max(1, Math.ceil(dt / (1 / 60)));
  const h = dt / n;
  for (let k = 0; k < n; k++) {
    for (let i = 0; i < 8; i++) {
      if (CW[i] === 0 && CWV[i] === 0 && !(want && i === CUR.arm)) continue;
      const o = { w: CW[i], v: CWV[i] };
      spring(o, "w", "v", want && i === CUR.arm ? 1 : 0, shy ? 0.34 : 1.9, 0.92, h);
      CW[i] = Math.abs(o.w) < 1e-4 && Math.abs(o.v) < 1e-4 ? 0 : o.w;
      CWV[i] = CW[i] === 0 ? 0 : o.v;
    }
    CUR.w = CUR.arm >= 0 ? CW[CUR.arm] : 0;
    if (want && CUR.arm >= 0) {
      spring(CUR, "x", "vx", PT.x, 1.25, 0.95, h);
      spring(CUR, "y", "vy", PT.y, 1.25, 0.95, h);
    }
    spring(CUR, "roll", "rollV", rollT, 2.4, 0.85, h);
    spring(CUR, "psi", "psiV", psiT, LOOK.on || LOOK.e > 0.05 ? 1.3 : 2.8, 0.85, h);
    spring(SHIFT, "x", "v", SHIFT.target, 1.7, 0.78, h);
  }
  if (SHIFT.homeT > 0 && t > SHIFT.homeT) {
    SHIFT.target = 0;
    SHIFT.homeT = -1;
  }
  ARMT.lag += dt * 0.9 * attNow(c, t).e;
  if (!want && CUR.arm >= 0) {
    let tot = 0;
    for (let i = 0; i < 8; i++) tot += Math.abs(CW[i]);
    if (tot < 0.01) CUR.arm = -1;
  }
  eyeStep(c, t, dt);
}

/** A boop: flinch, happy squint, jig and a squirt of crew ink (static ink without motion). */
export function poke(c: Cub): void {
  const t = c.simClock;
  const tw = performance.now() / 1000;
  const P = c.POKES;
  P.push(tw);
  while (P.length && (tw - P[0] > 3 || P.length > 3)) P.shift();
  // The third boop within 3 s is still a happy boop with ink, a little bigger and faster.
  const rapid = P.length >= 3;
  if (!motionOK(c)) {
    if (c.o.clickInk) inkStatic(c);
    return;
  }
  c.FL.t0 = t;
  c.FL.amp = rapid ? 0.72 : 0.6;
  c.EYE.squeezeT = t;
  c.EYE.sqHap = 1;
  c.BOOP.t0 = t;
  if (c.o.clickInk) inkBurst(c, t, rapid, false);
  c.kick();
}

/** Glances at the CTA (rate-limited to once per 10 s) and taps the ledge toward it with the explore arm. */
export function ctaGlance(c: Cub): void {
  const L = c.L;
  if (!noticeOK(c) || !L || !L.cta || c.simClock - c.ctaT < 10) return;
  const t = (c.ctaT = c.simClock);
  const r = L.cta;
  const G = c.GLANCE;
  G.t0 = t;
  G.x = r.x + r.w * 0.5;
  G.y = r.y + r.h * 0.5;
  pulse(c, "fixed", G.x, G.y, 0.95);
  c.EYE.widenT = t + 0.08;
  const i = c.OC.armOf.explore;
  const side = G.x < c.OC.bx;
  c.TAP.arm = side && i != null && !busyArms(c).includes(i) ? i : -1;
  c.TAP.t0 = t + 0.15;
  c.kick();
}
