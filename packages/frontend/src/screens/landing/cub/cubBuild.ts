// One frame of Cub's body and arms: breathing, beats, the flinch, the turn's
// lean and nods, the eight arms (role shape, curious arm, the reach to Octo's
// coin with taps and pats, the flinch curl) and the webs between them.
// Ported from the owner-approved prototype (not in this repo).

import {
  ARM_R0,
  HOLD_GAP,
  K,
  PEEK_ON,
  REACH_ARCH,
  REACH_GAP,
  REST_B,
  ROOT_FL,
  SS,
  TAP_LAND,
  TILT,
  YAW_R,
} from "./cubConfig";
import { armLen, armSpec, dutyOf, feelAt, layArm, pathArm, type ArmCtx } from "./cubArms";
import { attNow, attTurn, beats } from "./cubAttention";
import { proj } from "./cubCamera";
import { demoAt, isStill, motionOK } from "./cubClock";
import { curApply, curTarget, flinchArm } from "./cubCurious";
import { eyeGeo, mouthPlace } from "./cubEyes";
import { bump, clamp, fbm, lerp, madd, smoother, sstep, type V3 } from "./cubMath";
import { coinDrawn, flickTip, landTip, landX, morphArm, reachArmOf, reachRoute, tipYOn } from "./cubReach";
import {
  armRoots,
  armTaper,
  bodyRoom,
  buildBody,
  capR,
  pose,
  rolesFor,
  setTube,
  webs,
  writeArm,
  type Pose,
} from "./cubRig";
import { armBuf, type Cub } from "./cubState";
import {
  coinDipW,
  fileNodW,
  holdW,
  leanW,
  nodAt,
  nodEnv,
  popW,
  prepareW,
  pressW,
  reachW,
  tapAt,
} from "./cubTimeline";

/** Flinch envelope: a quick rise, then an exponential release. */
export const flEnv = (x: number): number => (x < 0 ? 0 : x < 0.08 ? sstep(0, 0.08, x) : Math.exp(-(x - 0.08) / 0.32));

function pushHit(c: Cub, x: number, y: number, r: number): void {
  if (c.NHIT < 600) {
    const H = c.HIT;
    H[c.NHIT * 3] = x;
    H[c.NHIT * 3 + 1] = y;
    H[c.NHIT * 3 + 2] = r;
    c.NHIT++;
  }
}

/** How far front arms may hang below the ledge at x (to the floor inside the transcript column). */
function depthAt(c: Cub, x: number): number {
  const G = c.G!;
  const col = G.col;
  const inCol = x > col.x - 4 && x < col.x + col.w + 4;
  return (inCol ? G.floorY : G.deep) - G.edgeY;
}

export function build(c: Cub, t: number): { P: Pose; pts: V3[] } {
  const L = c.L!;
  const G = c.G!;
  const Sidle = c.Sidle!;
  const { OC, FL, CUR, ATTP, SHIFT, TAP, SHY, CW, ARMT, SPD, TUBE, TUBE2, EYEG, cam } = c;
  const tl = c.o.timeline;
  const still = isStill(c);
  const u = OC.u;
  const live = motionOK(c);
  const d = demoAt(c);
  const td = d.td;
  const wR = d.live ? reachW(tl, td) : 0;

  const ph = t / 4.6 + 0.45 * fbm(t * 0.037, 91);
  const fr = ph - Math.floor(ph);
  const bnc = (x: number) => Math.sin(Math.PI * clamp(0, (x - 0.5) / 0.5, 1)) ** 2;
  const br = fr < 0.55 ? smoother(fr / 0.55) + 0.09 * bnc(fr / 0.55) : 1 - smoother((fr - 0.55) / 0.45) - 0.32 * bnc((fr - 0.55) / 0.45);
  const BT = live || still ? beats(c, t) : { jig: 0, smile: 0, wig: 0, wave: 0, wv: 0 };
  c.LASTBEAT = BT;
  const sqz = (sg: number) => 1 + (sg > 0 ? 0.15 : -0.75) * sg;
  let f = live ? FL.amp * flEnv(t - FL.t0) : 0;
  const toCoin = Math.sign(L.octoCoin.x + L.octoCoin.w / 2 - OC.bx) || 1;

  const lean = d.live ? leanW(tl, td, wR) : 0;
  const nodE = d.live ? nodEnv(tl, td) : 0;
  const nod = d.live ? nodAt(tl, td) : 0;
  const coinDip = d.live ? coinDipW(tl, td) : 0;
  const fileE = d.live ? fileNodW(tl, td) : 0;
  const fdx = d.live && L.fchip ? clamp(-1, (L.fchip.x + L.fchip.w * 0.3 - c.HEADC[0]) / 380, 1) : 0;
  const at = live || still ? attNow(c, t) : { e: 0, cam: true, x: 0, y: 0 };
  const [aPsi, aRoll] = live || still ? attTurn(c, t) : [0, 0];
  const sgB = 0.05 * br;
  const sgJ = BT.jig;
  const c0 = OC.psiCam - OC.psi0;
  const yawS = (p: number) => c0 + YAW_R * Math.tanh((p - c0) / YAW_R);
  const mkB = (fl: number) => ({
    m: sqz(sgB) * (1 - 0.6 * sgJ) * (1 + 0.12 * fl),
    lsc: (1 + sgB) * (1 + sgJ) * (1 - 0.15 * fl),
    tilt: TILT + 0.04 * fbm(t * 0.05, 5) + 0.05 * lean,
    psi: yawS(
      0.04 * fbm(t * 0.04, 3) +
        (live ? CUR.psi * (1 - ATTP.camE) : 0) +
        at.e * aPsi +
        0.05 * toCoin * lean +
        0.03 * toCoin * coinDip +
        0.05 * fdx * fileE,
    ),
    roll:
      0.018 * fbm(t * 0.031, 8) -
      0.11 * toCoin * lean -
      0.04 * toCoin * coinDip -
      0.03 * fdx * fileE +
      (live ? CUR.roll * (1 - ATTP.camE) : 0) +
      at.e * aRoll,
    lift:
      0.012 * u * br -
      0.12 * u * fl +
      0.045 * u * at.e +
      0.35 * u * Math.max(0, sgJ) -
      0.06 * u * lean +
      0.03 * u * nod -
      0.019 * u * fileE,
  });
  const bx = OC.bx + (live ? SHIFT.x : 0) + OC.reachSh * wR;
  if (f > 0.002) {
    const r0 = bodyRoom(c, bx, mkB(0));
    const lim = Math.min(r0, 0);
    if (bodyRoom(c, bx, mkB(f)) < lim) {
      let lo = 0;
      let hi = f;
      for (let k = 0; k < 4; k++) {
        const m = (lo + hi) / 2;
        if (bodyRoom(c, bx, mkB(m)) < lim) hi = m;
        else lo = m;
      }
      f = lo;
    }
  }
  const B = mkB(f);
  const P = pose(c, bx, B);
  const pts: V3[] = [];
  c.NHIT = 0;
  buildBody(c, 0, P.O, P.A, P.Fp, B.tilt, B.m, B.lsc, u, pts);
  for (let i = 0; i < K; i += 2) {
    const s = proj(cam, pts[i]);
    const r = SPD[i * 3 * 4 + 3] * s[2];
    pushHit(c, s[0], s[1], r + 2);
  }
  c.NBODYH = c.NHIT;
  const bc = proj(cam, pts[Math.round(K * 0.55)]);
  c.BODYC = [bc[0], bc[1]];
  const hc = proj(cam, pts[4]);
  c.HEADC = [hc[0], hc[1]];
  eyeGeo(c, u, t, live, B.psi);
  mouthPlace(c, u);
  const roles = rolesFor(c, pose(c, OC.bx, REST_B));
  const roots = armRoots(8, P.A, P.Fp, P.Lt);
  const r0 = ARM_R0 * u;
  c.CROWN = [0, 0];
  for (const rt of roots) {
    const q = proj(cam, madd(madd(P.O, rt.R, 0.28 * u), P.A, -0.1 * u));
    c.CROWN[0] += q[0] / 8;
    c.CROWN[1] += q[1] / 8;
  }
  const rF0 = (s: number) => Math.max(armTaper(s, r0), 0.6);
  const rpx0 = (s: number) => armTaper(s, r0);
  if (!OC.parm) OC.parm = Array.from({ length: 8 }, armBuf);
  const ta = still ? t : t - ARMT.lag;
  const feel = live || still ? feelAt(c, ta) : null;
  const reachArm = reachArmOf(c);
  const rchE = d.live ? prepareW(tl, td) : 0;
  const tpx = t - TAP.t0;
  const tapW = live && tpx >= 0 ? smoother(tpx / 0.45) * (1 - smoother((tpx - 1.05) / 0.45)) : 0;
  const tapE = tapW * Math.max(bump(tpx, 0.55, 0.11), bump(tpx, 0.95, 0.11));
  let curW = 0;
  for (let i = 0; i < 8; i++) curW = Math.max(curW, CW[i]);
  curW = clamp(0, curW, 1);
  c.LASTACT = { wR, curW, f, tw: tapE, psi: B.psi, roll: B.roll, lift: B.lift, bx };
  const reachRole = reachArm >= 0 ? roles[reachArm] : undefined;
  const dbg = c.o.debug;
  if (dbg) c.ARMDBG.length = 0;
  for (let i = 0; i < 8; i++) {
    const rl = roles[i];
    const rt = roots[i];
    const rw = 1 + i;
    const fl0 = ROOT_FL[rl];
    const rF = fl0 ? (s: number) => Math.max(armTaper(s, r0, fl0), 0.6) : rF0;
    const rpx = rpx0;
    const P0 = madd(madd(P.O, rt.R, 0.28 * u), P.A, -0.1 * u);
    const q0 = proj(cam, P0);
    const o = OC.parm[i];
    const fe = feel && feel.role === rl ? feel.e : 0;
    const fw = fe ? feel!.w : 0;
    const cx: ArmCtx = {
      mode: OC.mode,
      dC: G.wx1 - q0[0],
      gut: Sidle.xMax - G.wx1,
      r: rpx(0.6),
      depth: depthAt(c, rl === "grip" ? q0[0] - 0.25 * u : q0[0] + 0.3 * u),
      tw: 0,
      qa: 0.27 + 0.73 * dutyOf(c, i, ta),
      tap: i === TAP.arm ? tapE : 0,
      tapW: i === TAP.arm ? tapW : 0,
      wig: Math.max(0.55 * nodE, BT.wig),
      wt: t,
      wave: (rl === "explore" && i !== reachArm) || (rl === "explore" && rchE < 0.01) ? BT.wave : 0,
      wv: BT.wv,
      rch: i === reachArm ? rchE : 0,
      dR: i === reachArm ? L.octoCoin.x + L.octoCoin.w / 2 - q0[0] : undefined,
      rE: rchE * (reachRole === "explore" ? 1 : 0),
      mk:
        rl === "rest"
          ? Math.max(reachRole === "explore" ? rchE : 0, OC.armOf.explore !== reachArm || rchE < 0.01 ? BT.wave : 0)
          : 0,
    };
    const sp = armSpec(rl, ta, i, u, fe, fw, cx);
    if (import.meta.env.DEV && c.o.fallbackPose) sp.front = () => false;
    layArm(c, Sidle, q0[0], q0[1], sp.a0, sp.L * u, sp.kap, rpx, sp.front, o, sp.lie);
    for (let j = 0; j < K; j++) {
      o.Z[j] = sp.z(SS[j], P0[2]);
      o.F[j] = sp.front(SS[j]) ? 1 : 0;
    }
    const lenIdle = Math.round(armLen(o));
    let busy = false;
    const cwi = clamp(0, CW[i], 1);
    const curE = cwi * cwi * (3 - 2 * cwi);
    if (live && curE > 0.001) {
      curTarget(c, o, CUR.x, CUR.y, u, c.TMP);
      const hits = curApply(c, o, c.TMP, curE, OC.Scur || Sidle, rpx);
      if (hits > 5 && i === CUR.arm && curE > 0.5) CUR.blockT = t;
    }
    if (i === reachArm && wR > 0.001) {
      const hold = holdW(tl, td);
      const pop = popW(tl, td);
      const tp = tapAt(tl, td);
      const stillW = 1 - sstep(0, 0.15, Math.max(tp.dip, tp.fl));
      const co = L.octoCoin;
      // The coin as drawn: popped while Octo works, pressed (smaller and a
      // pixel lower) under each tap, so a tap lands on the tile's edge it sees.
      const coin = coinDrawn(c, pop, hold * pressW(tl, td));
      const gap =
        lerp(REACH_GAP, HOLD_GAP, hold) - hold * tp.dip * (HOLD_GAP + TAP_LAND) + 0.25 * hold * stillW * Math.sin(t * 1.3);
      const rt = rpx(1);
      const wob = 0.5 * hold * stillW * Math.sin(t * 0.9);
      const cxLand = landX(c, co, co.x + co.w * 0.5, coin.cy - coin.r - gap - rt, rpx(0.8));
      const cxw = cxLand + wob;
      const ty = tipYOn(coin, cxw, rt, gap);
      {
        // The keep-out the morph sees: the drawn coin, its top where the tip
        // lands, pressable by the tap (a negative margin) and kept clear otherwise.
        const top = tipYOn(coin, cxw, 0, 0);
        Object.assign(OC.prReach, { x: coin.cx - coin.r, y: top, w: 2 * coin.r, h: coin.cy + coin.r - top, m: tp.dip > 0 ? -1 : 1.5 });
      }
      let hMax = REACH_ARCH * u;
      const xTop = lerp(o.X[0], cxw, 0.38);
      for (const e of EYEG)
        if (e.on > 0) {
          const wE = 1 - sstep(e.R + 0.15 * u, e.R + 0.45 * u, Math.abs(e.x - xTop));
          if (wE > 0) hMax = lerp(hMax, Math.min(hMax, Math.max(0, G.edgeY - e.y - e.R - 2 * rpx(0.35) - 7)), wE);
        }
      const rr = reachRoute(c, G, o.X[0], o.Y[0], cxw, ty, u, rpx, lenIdle, hMax, co.w, L.chrome, cxLand);
      if (dbg) c.REACHDBG = rr;
      const TMP = c.TMP;
      pathArm(rr.pts, TMP);
      for (let j = 0; j < K; j++) TMP.Z[j] = lerp(o.Z[j], 0.3 * u, sstep(0.7, 0.86, SS[j]));
      busy = true;
      // The tip lifts over the ledge on its way (the prototype's coin sat just
      // under the ledge); a coin deep in the window does not lift it higher.
      morphArm(c, o, TMP, wR, OC.Sreach || Sidle, rpx, co.x - 0.1 * u + 2, co.x + co.w + 0.1 * u - 2, Math.min(Math.max(0, ty - G.edgeY), 0.15 * u) + 0.12 * u);
      // The tip ends on its target once the arm has arrived (the route's end).
      landTip(o, cxw, ty, sstep(0.9, 1, wR), 0.3 * u);
      if (tp.fl > 0 && wR > 0.99) flickTip(c, o, hold * tp.fl * (clamp(6, 0.13 * u, 12) + tp.carry * (HOLD_GAP + TAP_LAND)));
    }
    const fl = live && !(busy && wR > 0.05) ? Math.max(f, i === SHY.arm ? 0.7 * flEnv(t - SHY.t0) : 0) : 0;
    if (fl > 0.002) flinchArm(c, o, fl, Sidle, rpx);
    const Lw = writeArm(c, rw, o.X, o.Y, o.Z, capR(rF, armLen(o)), pts);
    if (dbg)
      c.ARMDBG[i] = {
        rl,
        lenIdle,
        Lwant: Math.round(sp.L * u),
        len2d: Math.round(armLen(o)),
        root: [Math.round(o.X[0]), Math.round(o.Y[0])],
        tip: [Math.round(o.X[K - 1]), Math.round(o.Y[K - 1])],
        len: Math.round(Lw),
        reach: i === reachArm && wR > 0.001,
        cur: +curE.toFixed(2),
      };
    setTube(c, rw, 1, 0);
    TUBE2.set([Lw, r0, (i === reachArm && wR > 0.25) || (rl === "curl" && PEEK_ON) ? 1 : 0, sp.sk0 || 0], rw * 4);
    for (let j = 0; j < K; j += 2) pushHit(c, o.X[j], o.Y[j], rpx(SS[j]) + 3);
  }
  c.ROWS = 1 + 8 + webs(c, 1, 8, 0.2, r0, 2.4 * u);
  for (let i = 0; i < 8; i++) {
    const rw = 9 + i;
    const la = TUBE2[(1 + i) * 4];
    const lb = TUBE2[(1 + ((i + 1) % 8)) * 4];
    TUBE[rw * 4 + 3] = 0.2 * Math.min(1, (1.8 * u) / Math.max(la, lb));
  }
  return { P, pts };
}
